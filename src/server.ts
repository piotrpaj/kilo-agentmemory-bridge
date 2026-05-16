import type { Hooks, PluginInput, PluginModule, PluginOptions as RawPluginOptions } from "@opencode-ai/plugin";
import { AgentmemoryClient } from "./client.js";
import { redact, redactString, truncate } from "./privacy.js";
import { SessionStore } from "./state.js";
import type {
  AgentmemoryContextResponse,
  AgentmemoryEnrichResponse,
  AgentmemoryPluginOptions,
  AgentmemorySessionStartResponse,
  BridgeLogger,
  HookPayload,
  HookType,
  ResolvedConfig,
  ToolCallState,
} from "./types.js";

const PLUGIN_ID = "kilo-agentmemory-bridge";
const DEFAULT_URL = "http://localhost:3111";
const DEFAULT_TOKEN_BUDGET = 2000;
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_SHORT_TIMEOUT_MS = 800;
const DEFAULT_INJECT_TIMEOUT_MS = 1500;
const DEFAULT_SUMMARIZE_TIMEOUT_MS = 120_000;
const DEFAULT_SESSION_END_TIMEOUT_MS = 30_000;
const DEFAULT_CONSOLIDATION_TIMEOUT_MS = 120_000;
const IDLE_SUMMARY_THROTTLE_MS = 60_000;
const MAX_IMAGE_DATA_LENGTH = 1_000_000;
const OPTIONAL_ENDPOINT_STATUSES = [404, 503];
const ENRICHABLE_TOOLS = new Set(["bash", "edit", "glob", "grep", "read", "write"]);
const FILE_ARG_KEYS = new Set(["filePath", "file_path", "path", "file", "pattern", "paths", "files"]);
const TERM_ARG_KEYS = new Set(["pattern", "query", "command"]);

async function server(input: PluginInput, options?: RawPluginOptions): Promise<Hooks> {
  const config = resolveConfig(options);
  const project = input.directory;
  const cwd = input.directory;
  const sessions = new SessionStore();
  const log = createLogger(input.client);
  const memory = new AgentmemoryClient(config, log);

  await log("info", "agentmemory bridge loaded", {
    url: config.baseUrl,
    tokenBudget: config.tokenBudget,
    compactionBudget: config.compactionBudget,
    injectSessionContext: config.injectSessionContext,
    injectToolContext: config.injectToolContext,
    summarizeOnStop: config.summarizeOnStop,
    consolidationEnabled: config.consolidationEnabled,
    memoryBridgeSync: config.memoryBridgeSync,
    endSessionOnIdle: config.endSessionOnIdle,
  });

  return {
    event: async ({ event }) => {
      const eventName = getEventName(event);
      const sessionId = getEventSessionId(event);

      if (!eventName) return;

      if (eventName === "session.created") {
        if (!sessionId) {
          await log("debug", "session created event missing session id", { eventName });
          return;
        }
        await startSession(memory, sessions, sessionId, project, cwd, config);
        return;
      }

      if (eventName === "session.idle") {
        if (!sessionId) {
          await log("debug", "session idle event missing session id", { eventName });
          return;
        }
        await handleSessionIdle(memory, sessions, sessionId, project, cwd, config);
        return;
      }

      if (eventName === "session.deleted") {
        if (!sessionId) {
          await log("debug", "session deleted event missing session id", { eventName });
          return;
        }
        await endSessionOnce(memory, sessions, sessionId, config, true);
        sessions.delete(sessionId);
        return;
      }

      if (eventName === "session.error") {
        await log("warn", "session error event received", { sessionId, event });
        return;
      }

      if (!sessionId) return;

      if (eventName === "session.next.tool.called") {
        handleToolCalledEvent(sessions, sessionId, event);
        return;
      }

      if (eventName === "session.next.tool.success") {
        handleToolSuccessEvent(memory, sessions, sessionId, project, cwd, event, config);
        return;
      }

      if (eventName === "session.next.tool.failed") {
        await handleToolFailedEvent(memory, sessions, sessionId, project, cwd, event, config);
        return;
      }

      if (eventName === "permission.replied" || eventName === "permission.updated") {
        void observe(memory, project, cwd, "notification", sessionId, {
          notification_type: "permission_response",
          event_name: eventName,
          message: redact(getEventProperties(event)),
        }, config.shortTimeoutMs);
        return;
      }

      if (eventName === "session.next.agent.switched" || eventName === "session.next.step.started") {
        await handleSubagentStartEvent(memory, sessions, sessionId, project, cwd, event, config);
        return;
      }

      if (eventName === "session.next.step.ended") {
        await handleSubagentStopEvent(memory, sessions, sessionId, project, cwd, event, config);
        return;
      }

      if (eventName === "todo.updated") {
        await handleTodoUpdatedEvent(memory, sessions, sessionId, project, cwd, event, config);
      }
    },

    "chat.message": async (chatInput, output) => {
      const prompt = extractPrompt(output);
      if (!prompt) return;

      const state = sessions.getOrCreate(chatInput.sessionID);
      state.firstPromptCaptured = true;

      void observe(memory, project, cwd, "prompt_submit", chatInput.sessionID, {
        prompt: redactString(prompt),
        userPrompt: redactString(prompt),
      }, config.shortTimeoutMs);
    },

    "permission.ask": async (permissionInput) => {
      const sessionId = getPermissionSessionId(permissionInput);
      if (!sessionId) return;

      void observe(memory, project, cwd, "notification", sessionId, {
        notification_type: "permission_prompt",
        title: getStringAtPath(permissionInput, ["title"]) ?? "Permission requested",
        message: redact(permissionInput),
      }, config.shortTimeoutMs);
    },

    "tool.execute.before": async (toolInput, output) => {
      const args = redact(output.args);
      const call: ToolCallState = {
        callID: toolInput.callID,
        sessionID: toolInput.sessionID,
        toolName: toolInput.tool,
        args,
        startedAt: new Date().toISOString(),
      };
      sessions.recordToolCall(toolInput.sessionID, call);

      if (sessions.markObserved(toolInput.sessionID, toolInput.callID, "pre_tool_use")) {
        void observe(memory, project, cwd, "pre_tool_use", toolInput.sessionID, {
          tool_name: toolInput.tool,
          tool_input: args,
          call_id: toolInput.callID,
        }, config.shortTimeoutMs);
      }

      if (!config.injectToolContext || !isEnrichableTool(toolInput.tool)) return;

      const enrichRequest = buildEnrichRequest(toolInput.sessionID, toolInput.tool, output.args);
      if (!enrichRequest.files.length && !enrichRequest.terms.length) return;

      const enrich = await memory.post<AgentmemoryEnrichResponse>("/enrich", enrichRequest, config.injectTimeoutMs);
      const context = extractEnrichContext(enrich);
      if (context) sessions.addPendingToolContext(toolInput.sessionID, context);
    },

    "tool.execute.after": async (toolInput, output) => {
      const existing = sessions.getOrCreate(toolInput.sessionID).toolCalls.get(toolInput.callID);
      if (!existing) {
        sessions.recordToolCall(toolInput.sessionID, {
          callID: toolInput.callID,
          sessionID: toolInput.sessionID,
          toolName: toolInput.tool,
          args: redact(toolInput.args),
          startedAt: new Date().toISOString(),
        });
      }

      const failed = isFailedToolOutput(output);
      await observeToolResult(memory, sessions, project, cwd, failed ? "post_tool_failure" : "post_tool_use", toolInput.sessionID, toolInput.callID, {
        tool_name: toolInput.tool,
        tool_input: redact(toolInput.args),
        title: redactString(output.title),
        metadata: redact(output.metadata),
        ...formatCapturedOutput(output.output),
        call_id: toolInput.callID,
      }, config.shortTimeoutMs);
    },

    "experimental.chat.system.transform": async (systemInput, output) => {
      const sessionId = systemInput.sessionID;
      if (!sessionId) return;

      const pendingToolContexts = sessions.consumePendingToolContext(sessionId);
      if (pendingToolContexts.length) output.system.push(formatToolContextBlock(pendingToolContexts));

      const state = sessions.getOrCreate(sessionId);
      if (!config.injectSessionContext || state.contextInjected) return;

      const pendingContext = state.pendingContext?.trim();
      const context = pendingContext || (await fetchContext(memory, sessionId, project, config.tokenBudget, config.injectTimeoutMs));
      if (!context) return;

      output.system.push(formatContextBlock(context));
      state.contextInjected = true;
      delete state.pendingContext;
    },

    "experimental.session.compacting": async (compactInput, output) => {
      if (config.memoryBridgeSync) {
        void memory.postVoid("/claude-bridge/sync", {}, config.shortTimeoutMs, { optionalStatuses: OPTIONAL_ENDPOINT_STATUSES });
      }

      void observe(memory, project, cwd, "pre_compact", compactInput.sessionID, {
        budget: config.compactionBudget,
      }, config.shortTimeoutMs);

      const context = await fetchContext(memory, compactInput.sessionID, project, config.compactionBudget, config.injectTimeoutMs);
      if (context) output.context.push(formatContextBlock(context));
    },
  };
}

const plugin: PluginModule = {
  id: PLUGIN_ID,
  server,
};

export default plugin;

function resolveConfig(options?: RawPluginOptions): ResolvedConfig {
  const pluginOptions = isRecord(options) ? (options as AgentmemoryPluginOptions) : {};
  const tokenBudget = positiveInteger(pluginOptions.tokenBudget ?? process.env.AGENTMEMORY_TOKEN_BUDGET, DEFAULT_TOKEN_BUDGET);
  const compactionBudget = positiveInteger(pluginOptions.compactionBudget, Math.floor(tokenBudget * 0.75));

  const secret = stringValue(pluginOptions.secret) ?? process.env.AGENTMEMORY_SECRET;
  const config: ResolvedConfig = {
    baseUrl: trimTrailingSlashes(stringValue(pluginOptions.url) ?? process.env.AGENTMEMORY_URL ?? DEFAULT_URL),
    tokenBudget,
    compactionBudget,
    timeoutMs: positiveInteger(pluginOptions.timeoutMs, DEFAULT_TIMEOUT_MS),
    shortTimeoutMs: positiveInteger(pluginOptions.shortTimeoutMs, DEFAULT_SHORT_TIMEOUT_MS),
    injectTimeoutMs: positiveInteger(pluginOptions.injectTimeoutMs, DEFAULT_INJECT_TIMEOUT_MS),
    summarizeTimeoutMs: positiveInteger(pluginOptions.summarizeTimeoutMs, DEFAULT_SUMMARIZE_TIMEOUT_MS),
    sessionEndTimeoutMs: positiveInteger(pluginOptions.sessionEndTimeoutMs, DEFAULT_SESSION_END_TIMEOUT_MS),
    consolidationTimeoutMs: positiveInteger(pluginOptions.consolidationTimeoutMs, DEFAULT_CONSOLIDATION_TIMEOUT_MS),
    injectSessionContext: booleanValue(pluginOptions.injectSessionContext) ?? booleanValue(process.env.AGENTMEMORY_INJECT_SESSION_CONTEXT) ?? true,
    injectToolContext: booleanValue(pluginOptions.injectToolContext) ?? booleanValue(process.env.AGENTMEMORY_INJECT_CONTEXT) ?? false,
    summarizeOnStop: booleanValue(pluginOptions.summarizeOnStop) ?? booleanValue(process.env.AGENTMEMORY_SUMMARIZE_ON_STOP) ?? true,
    consolidationEnabled: booleanValue(pluginOptions.consolidationEnabled) ?? booleanValue(process.env.CONSOLIDATION_ENABLED) ?? false,
    memoryBridgeSync: booleanValue(pluginOptions.memoryBridgeSync) ?? booleanValue(process.env.CLAUDE_MEMORY_BRIDGE) ?? false,
    endSessionOnIdle: booleanValue(pluginOptions.endSessionOnIdle) ?? false,
  };
  if (secret) config.secret = secret;
  return config;
}

function createLogger(client: PluginInput["client"]): BridgeLogger {
  return async (level, message, extra) => {
    try {
      await (client as any).app?.log?.({
        body: {
          service: "agentmemory-bridge",
          level,
          message,
          extra: redact(extra),
        },
      });
    } catch {
      // Logging must remain best-effort.
    }
  };
}

async function startSession(
  memory: AgentmemoryClient,
  sessions: SessionStore,
  sessionId: string,
  project: string,
  cwd: string,
  config: ResolvedConfig,
): Promise<void> {
  const response = await memory.post<AgentmemorySessionStartResponse>("/session/start", {
    sessionId,
    project,
    cwd,
  }, config.injectSessionContext ? config.injectTimeoutMs : config.shortTimeoutMs);
  sessions.markStarted(sessionId, config.injectSessionContext ? response?.context?.trim() : undefined);
}

async function handleSessionIdle(
  memory: AgentmemoryClient,
  sessions: SessionStore,
  sessionId: string,
  project: string,
  cwd: string,
  config: ResolvedConfig,
): Promise<void> {
  const state = sessions.getOrCreate(sessionId);
  const now = Date.now();
  const shouldCaptureStop = !state.lastIdleSummarizedAt || now - state.lastIdleSummarizedAt >= IDLE_SUMMARY_THROTTLE_MS;

  if (shouldCaptureStop) {
    state.lastIdleSummarizedAt = now;
    void observe(memory, project, cwd, "stop", sessionId, {
      event_name: "session.idle",
      summarized: config.summarizeOnStop,
    }, config.shortTimeoutMs);
    if (config.summarizeOnStop) void memory.postVoid("/summarize", { sessionId }, config.summarizeTimeoutMs);
  }

  if (config.endSessionOnIdle) await endSessionOnce(memory, sessions, sessionId, config, false);
}

async function endSessionOnce(
  memory: AgentmemoryClient,
  sessions: SessionStore,
  sessionId: string,
  config: ResolvedConfig,
  terminal: boolean,
): Promise<void> {
  const state = sessions.getOrCreate(sessionId);
  if (state.ended) return;

  await memory.postVoid("/session/end", { sessionId }, config.sessionEndTimeoutMs);
  sessions.markEnded(sessionId);

  if (!terminal) return;

  if (config.consolidationEnabled) {
    await memory.postVoid("/crystals/auto", { olderThanDays: 0 }, config.consolidationTimeoutMs, { optionalStatuses: OPTIONAL_ENDPOINT_STATUSES });
    await memory.postVoid("/consolidate-pipeline", { tier: "all", force: true }, config.consolidationTimeoutMs, {
      optionalStatuses: OPTIONAL_ENDPOINT_STATUSES,
    });
  }

  if (config.memoryBridgeSync) {
    await memory.postVoid("/claude-bridge/sync", {}, config.sessionEndTimeoutMs, { optionalStatuses: OPTIONAL_ENDPOINT_STATUSES });
  }
}

async function observeToolResult(
  memory: AgentmemoryClient,
  sessions: SessionStore,
  project: string,
  cwd: string,
  hookType: "post_tool_use" | "post_tool_failure",
  sessionId: string,
  callId: string,
  data: Record<string, unknown>,
  timeoutMs: number,
): Promise<void> {
  if (!sessions.markObserved(sessionId, callId, hookType)) return;
  await observe(memory, project, cwd, hookType, sessionId, data, timeoutMs);
}

async function observe(
  memory: AgentmemoryClient,
  project: string,
  cwd: string,
  hookType: HookType,
  sessionId: string,
  data: Record<string, unknown>,
  timeoutMs?: number,
): Promise<void> {
  const payload: HookPayload = {
    hookType,
    sessionId,
    project,
    cwd,
    timestamp: new Date().toISOString(),
    data: redact(data),
  };
  await memory.postVoid("/observe", payload, timeoutMs);
}

async function fetchContext(
  memory: AgentmemoryClient,
  sessionId: string,
  project: string,
  budget: number,
  timeoutMs: number,
): Promise<string | undefined> {
  const response = await memory.post<AgentmemoryContextResponse>("/context", {
    sessionId,
    project,
    budget,
  }, timeoutMs);
  return response?.context?.trim() || undefined;
}

function handleToolCalledEvent(sessions: SessionStore, sessionId: string, event: unknown): void {
  const callId = getEventCallId(event);
  const toolName = getEventToolName(event);
  if (!callId || !toolName) return;

  const args = redact(getFirstDefinedAtPaths(event, [
    ["properties", "input"],
    ["properties", "args"],
    ["properties", "tool", "input"],
    ["data", "input"],
    ["data", "args"],
  ]));
  const metadata = redact(getFirstDefinedAtPaths(event, [["properties", "metadata"], ["properties", "provider"], ["data", "metadata"]]));
  const call: ToolCallState = {
    callID: callId,
    sessionID: sessionId,
    toolName,
    args,
    metadata,
    startedAt: new Date().toISOString(),
  };
  sessions.recordToolCall(sessionId, call);
}

function handleToolSuccessEvent(
  memory: AgentmemoryClient,
  sessions: SessionStore,
  sessionId: string,
  project: string,
  cwd: string,
  event: unknown,
  config: ResolvedConfig,
): void {
  const callId = getEventCallId(event);
  if (!callId) return;
  const state = sessions.getOrCreate(sessionId);
  const call = state.toolCalls.get(callId);
  const toolOutput = getFirstDefinedAtPaths(event, [["properties", "output"], ["properties", "result"], ["data", "output"], ["data", "result"]]);

  const timer = setTimeout(() => {
    if (sessions.hasObserved(sessionId, callId, "post_tool_use")) return;
    void observeToolResult(memory, sessions, project, cwd, "post_tool_use", sessionId, callId, {
      tool_name: call?.toolName ?? getEventToolName(event) ?? "unknown",
      tool_input: call?.args,
      metadata: redact(stripLargeEventPayload(getEventProperties(event))),
      ...formatCapturedOutput(toolOutput),
      call_id: callId,
    }, config.shortTimeoutMs);
  }, 1000);
  timer.unref?.();
}

async function handleToolFailedEvent(
  memory: AgentmemoryClient,
  sessions: SessionStore,
  sessionId: string,
  project: string,
  cwd: string,
  event: unknown,
  config: ResolvedConfig,
): Promise<void> {
  const callId = getEventCallId(event);
  if (!callId) return;
  const state = sessions.getOrCreate(sessionId);
  const call = state.toolCalls.get(callId);
  const error = extractEventError(event);
  if (isAbortLikeError(error)) return;

  await observeToolResult(memory, sessions, project, cwd, "post_tool_failure", sessionId, callId, {
    tool_name: call?.toolName ?? getEventToolName(event) ?? "unknown",
    tool_input: call?.args,
    error: truncate(redactString(error || "Tool failed"), 4000),
    metadata: redact(getEventProperties(event)),
    call_id: callId,
  }, config.shortTimeoutMs);
}

async function handleSubagentStartEvent(
  memory: AgentmemoryClient,
  sessions: SessionStore,
  sessionId: string,
  project: string,
  cwd: string,
  event: unknown,
  config: ResolvedConfig,
): Promise<void> {
  const agent = extractAgentName(event);
  if (!agent) return;

  const state = sessions.getOrCreate(sessionId);
  if (state.activeAgent === agent) return;
  state.activeAgent = agent;

  void observe(memory, project, cwd, "subagent_start", sessionId, {
    agent_type: agent,
    metadata: redact(getEventProperties(event)),
  }, config.shortTimeoutMs);
}

async function handleSubagentStopEvent(
  memory: AgentmemoryClient,
  sessions: SessionStore,
  sessionId: string,
  project: string,
  cwd: string,
  event: unknown,
  config: ResolvedConfig,
): Promise<void> {
  const state = sessions.getOrCreate(sessionId);
  if (!state.activeAgent) return;

  const agent = state.activeAgent;
  delete state.activeAgent;
  void observe(memory, project, cwd, "subagent_stop", sessionId, {
    agent_type: agent,
    metadata: redact(getEventProperties(event)),
  }, config.shortTimeoutMs);
}

async function handleTodoUpdatedEvent(
  memory: AgentmemoryClient,
  sessions: SessionStore,
  sessionId: string,
  project: string,
  cwd: string,
  event: unknown,
  config: ResolvedConfig,
): Promise<void> {
  const state = sessions.getOrCreate(sessionId);
  for (const task of extractCompletedTodos(event)) {
    const taskId = task.id || task.content;
    if (!taskId || state.completedTaskIds.has(taskId)) continue;
    state.completedTaskIds.add(taskId);
    void observe(memory, project, cwd, "task_completed", sessionId, {
      task_id: task.id,
      task: truncate(redactString(task.content), 4000),
      metadata: redact(task.metadata),
    }, config.shortTimeoutMs);
  }
}

function formatContextBlock(context: string): string {
  return `## Prior session context\n\n${context}`;
}

function formatToolContextBlock(contexts: string[]): string {
  return `## Relevant tool context\n\n${contexts.join("\n\n")}`;
}

function getEventName(event: unknown): string | undefined {
  const candidates = [
    getStringAtPath(event, ["type"]),
    getStringAtPath(event, ["name"]),
    getStringAtPath(event, ["event"]),
  ];
  return candidates.find(Boolean);
}

function getEventSessionId(event: unknown): string | undefined {
  const candidates = [
    getStringAtPath(event, ["sessionID"]),
    getStringAtPath(event, ["sessionId"]),
    getStringAtPath(event, ["session", "id"]),
    getStringAtPath(event, ["properties", "sessionID"]),
    getStringAtPath(event, ["properties", "sessionId"]),
    getStringAtPath(event, ["properties", "session", "id"]),
    getStringAtPath(event, ["properties", "info", "id"]),
    getStringAtPath(event, ["data", "sessionID"]),
    getStringAtPath(event, ["data", "sessionId"]),
    getStringAtPath(event, ["data", "session", "id"]),
    getStringAtPath(event, ["data", "info", "id"]),
  ];
  return candidates.find(Boolean);
}

function getEventCallId(event: unknown): string | undefined {
  const candidates = [
    getStringAtPath(event, ["callID"]),
    getStringAtPath(event, ["callId"]),
    getStringAtPath(event, ["toolCallID"]),
    getStringAtPath(event, ["properties", "callID"]),
    getStringAtPath(event, ["properties", "callId"]),
    getStringAtPath(event, ["properties", "toolCallID"]),
    getStringAtPath(event, ["data", "callID"]),
    getStringAtPath(event, ["data", "callId"]),
  ];
  return candidates.find(Boolean);
}

function getEventToolName(event: unknown): string | undefined {
  const candidates = [
    getStringAtPath(event, ["tool"]),
    getStringAtPath(event, ["toolName"]),
    getStringAtPath(event, ["properties", "tool"]),
    getStringAtPath(event, ["properties", "toolName"]),
    getStringAtPath(event, ["properties", "tool", "name"]),
    getStringAtPath(event, ["data", "tool"]),
    getStringAtPath(event, ["data", "toolName"]),
  ];
  return candidates.find(Boolean);
}

function getEventProperties(event: unknown): unknown {
  return getFirstDefinedAtPaths(event, [["properties"], ["data"]]) ?? event;
}

function stripLargeEventPayload(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (["args", "input", "output", "result"].includes(key)) continue;
    output[key] = item;
  }
  return output;
}

function getPermissionSessionId(permission: unknown): string | undefined {
  const candidates = [
    getStringAtPath(permission, ["sessionID"]),
    getStringAtPath(permission, ["sessionId"]),
    getStringAtPath(permission, ["session", "id"]),
    getStringAtPath(permission, ["metadata", "sessionID"]),
    getStringAtPath(permission, ["metadata", "sessionId"]),
    getStringAtPath(permission, ["request", "sessionID"]),
    getStringAtPath(permission, ["request", "sessionId"]),
  ];
  return candidates.find(Boolean);
}

function extractPrompt(output: { message: unknown; parts: unknown[] }): string | undefined {
  const direct = extractText(output.message);
  if (direct) return direct;

  const fromParts = output.parts.map(extractText).filter(Boolean).join("\n").trim();
  return fromParts || undefined;
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!isRecord(value)) return "";

  const text = getStringAtPath(value, ["text"]);
  if (text) return text.trim();

  const content = getStringAtPath(value, ["content"]);
  if (content) return content.trim();

  const parts = Array.isArray(value.parts) ? value.parts : Array.isArray(value.content) ? value.content : undefined;
  if (!parts) return "";

  return parts.map(extractText).filter(Boolean).join("\n").trim();
}

function isFailedToolOutput(output: { title: string; output: string; metadata: unknown }): boolean {
  if (isRecord(output.metadata)) {
    const status = getStringAtPath(output.metadata, ["status"])?.toLowerCase();
    if (status && ["error", "failed", "failure"].includes(status)) return true;
    if (output.metadata.error || output.metadata.failed === true || output.metadata.success === false) return true;
  }

  const title = output.title.toLowerCase();
  if (/\b(error|failed|failure)\b/.test(title)) return true;

  return /^\s*(error|failed|failure):/i.test(output.output);
}

function formatCapturedOutput(output: unknown): Record<string, unknown> {
  const captured = captureToolOutput(output);
  return {
    tool_output: captured.output,
    ...(captured.imageData ? { image_data: captured.imageData } : {}),
  };
}

function captureToolOutput(output: unknown): { output: unknown; imageData?: string } {
  if (typeof output === "string") {
    const redacted = redactString(output);
    const imageData = extractImageData(redacted);
    if (imageData) return formatImageCapture(imageData);
    return { output: truncate(redacted, 8000) };
  }

  const redacted = redact(output);
  const objectImage = extractSingleObjectImage(redacted);
  if (objectImage) {
    const imageCapture = formatImageCapture(objectImage.imageData);
    if (imageCapture.imageData && isRecord(redacted)) {
      return {
        output: { ...redacted, [objectImage.key]: "[image data extracted]" },
        imageData: imageCapture.imageData,
      };
    }
    return imageCapture;
  }

  return { output: redacted };
}

function formatImageCapture(imageData: string): { output: string; imageData?: string } {
  if (imageData.length > MAX_IMAGE_DATA_LENGTH) {
    return { output: `[image data omitted: ${imageData.length} chars]` };
  }

  return {
    output: "[image data extracted]",
    imageData,
  };
}

function extractSingleObjectImage(output: unknown): { key: string; imageData: string } | undefined {
  if (!isRecord(output)) return undefined;

  const matches = Object.entries(output)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(extractImageData(entry[1])))
    .map(([key, value]) => ({ key, imageData: extractImageData(value) as string }));
  return matches.length === 1 ? matches[0] : undefined;
}

function extractImageData(output: string): string | undefined {
  const dataUrl = output.match(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/);
  if (dataUrl?.[0]) return dataUrl[0];

  const compact = output.trim();
  if (/^[A-Za-z0-9+/=]{200,}$/.test(compact) && (compact.startsWith("iVBORw0KGgo") || compact.startsWith("/9j/"))) {
    return compact;
  }
  return undefined;
}

function isEnrichableTool(toolName: string): boolean {
  return ENRICHABLE_TOOLS.has(toolName.toLowerCase());
}

function buildEnrichRequest(sessionId: string, toolName: string, args: unknown): { sessionId: string; files: string[]; terms: string[]; toolName: string } {
  const files = new Set<string>();
  const terms = new Set<string>();
  collectEnrichInputs(args, files, terms);
  return { sessionId, files: [...files], terms: [...terms], toolName };
}

function collectEnrichInputs(value: unknown, files: Set<string>, terms: Set<string>): void {
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      if (FILE_ARG_KEYS.has(key)) files.add(item);
      if (TERM_ARG_KEYS.has(key)) terms.add(item);
      continue;
    }
    if (Array.isArray(item)) {
      for (const arrayItem of item) {
        if (typeof arrayItem === "string" && FILE_ARG_KEYS.has(key)) files.add(arrayItem);
      }
      continue;
    }
    collectEnrichInputs(item, files, terms);
  }
}

function extractEnrichContext(response: AgentmemoryEnrichResponse | null): string | undefined {
  if (!response) return undefined;
  const contexts = [response.context, ...(response.contexts ?? []), ...(response.memories ?? [])]
    .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .map((item) => item.trim());
  return contexts.length ? contexts.join("\n\n") : undefined;
}

function extractEventError(event: unknown): string {
  const errorValue = getFirstDefinedAtPaths(event, [
    ["properties", "error"],
    ["properties", "message"],
    ["properties", "reason"],
    ["data", "error"],
    ["data", "message"],
  ]);
  if (typeof errorValue === "string") return errorValue;
  if (isRecord(errorValue)) {
    return getStringAtPath(errorValue, ["message"]) ?? JSON.stringify(redact(errorValue));
  }
  return "";
}

function isAbortLikeError(error: string): boolean {
  return /\b(abort|aborted|cancelled|canceled|interrupt|interrupted)\b/i.test(error);
}

function extractAgentName(event: unknown): string | undefined {
  const candidates = [
    getStringAtPath(event, ["properties", "agent"]),
    getStringAtPath(event, ["properties", "agent", "name"]),
    getStringAtPath(event, ["properties", "agent", "type"]),
    getStringAtPath(event, ["properties", "part", "agent"]),
    getStringAtPath(event, ["properties", "step", "agent"]),
    getStringAtPath(event, ["data", "agent"]),
    getStringAtPath(event, ["data", "agent", "name"]),
  ];
  return candidates.find(Boolean);
}

function extractCompletedTodos(event: unknown): Array<{ id?: string; content: string; metadata?: unknown }> {
  const candidates = [
    getFirstDefinedAtPaths(event, [["properties", "todos"], ["properties", "todo"], ["data", "todos"], ["data", "todo"]]),
  ];
  const records = candidates.flatMap((candidate) => (Array.isArray(candidate) ? candidate : candidate ? [candidate] : []));
  const completed: Array<{ id?: string; content: string; metadata?: unknown }> = [];

  for (const record of records) {
    if (!isRecord(record)) continue;
    const status = (getStringAtPath(record, ["status"]) ?? getStringAtPath(record, ["state"]) ?? "").toLowerCase();
    if (!["complete", "completed", "done"].includes(status)) continue;
    const content = getStringAtPath(record, ["content"]) ?? getStringAtPath(record, ["title"]) ?? getStringAtPath(record, ["text"]);
    if (!content) continue;
    const id = getStringAtPath(record, ["id"]) ?? getStringAtPath(record, ["key"]);
    completed.push({ ...(id ? { id } : {}), content, metadata: record });
  }

  return completed;
}

function getFirstDefinedAtPaths(value: unknown, paths: string[][]): unknown {
  for (const path of paths) {
    const found = getAtPath(value, path);
    if (typeof found !== "undefined") return found;
  }
  return undefined;
}

function getAtPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function getStringAtPath(value: unknown, path: string[]): string | undefined {
  const current = getAtPath(value, path);
  return typeof current === "string" && current.trim() ? current : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;

  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  return undefined;
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}
