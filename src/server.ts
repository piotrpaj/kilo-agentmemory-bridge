import type { Hooks, PluginInput, PluginModule, PluginOptions as RawPluginOptions } from "@opencode-ai/plugin";
import { AgentmemoryClient } from "./client.js";
import { redact, redactString, truncate } from "./privacy.js";
import { SessionStore } from "./state.js";
import type {
  AgentmemoryContextResponse,
  AgentmemoryPluginOptions,
  AgentmemorySessionStartResponse,
  BridgeLogger,
  HookPayload,
  HookType,
  ResolvedConfig,
} from "./types.js";

const PLUGIN_ID = "kilo-agentmemory-bridge";
const DEFAULT_URL = "http://localhost:3111";
const DEFAULT_TOKEN_BUDGET = 2000;
const DEFAULT_TIMEOUT_MS = 3000;
const MAX_IMAGE_DATA_LENGTH = 1_000_000;

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
    injectToolContext: config.injectToolContext,
  });

  return {
    event: async ({ event }) => {
      const eventName = getEventName(event);
      const sessionId = getEventSessionId(event);

      if (!eventName?.startsWith("session.")) return;
      if (!sessionId) {
        await log("debug", "session event missing session id", { eventName });
        return;
      }

      if (eventName === "session.created") {
        const response = await memory.post<AgentmemorySessionStartResponse>("/session/start", {
          sessionId,
          project,
          cwd,
        });
        sessions.markStarted(sessionId, response?.context?.trim());
        return;
      }

      if (eventName === "session.idle") {
        await endSessionOnce(memory, sessions, sessionId);
        return;
      }

      if (eventName === "session.deleted") {
        await endSessionOnce(memory, sessions, sessionId);
        sessions.delete(sessionId);
        return;
      }

      if (eventName === "session.error") {
        await log("warn", "session error event received", { sessionId, event });
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
      });
    },

    "tool.execute.after": async (toolInput, output) => {
      const failed = isFailedToolOutput(output);
      const toolOutput = captureToolOutput(output.output);
      void observe(memory, project, cwd, failed ? "post_tool_failure" : "post_tool_use", toolInput.sessionID, {
        tool_name: toolInput.tool,
        tool_input: redact(toolInput.args),
        tool_output: toolOutput.output,
        ...(toolOutput.imageData ? { image_data: toolOutput.imageData } : {}),
        title: redactString(output.title),
        metadata: redact(output.metadata),
        call_id: toolInput.callID,
      });
    },

    "experimental.chat.system.transform": async (systemInput, output) => {
      const sessionId = systemInput.sessionID;
      if (!sessionId) return;

      const state = sessions.getOrCreate(sessionId);
      if (state.contextInjected) return;

      const pendingContext = state.pendingContext?.trim();
      const context = pendingContext || (await fetchContext(memory, sessionId, project, config.tokenBudget));
      if (!context) return;

      output.system.push(formatContextBlock(context));
      state.contextInjected = true;
      delete state.pendingContext;
    },

    "experimental.session.compacting": async (compactInput, output) => {
      void observe(memory, project, cwd, "pre_compact", compactInput.sessionID, {
        budget: config.compactionBudget,
      });

      const context = await fetchContext(memory, compactInput.sessionID, project, config.compactionBudget);
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
    injectToolContext: booleanValue(pluginOptions.injectToolContext) ?? process.env.AGENTMEMORY_INJECT_CONTEXT === "true",
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

async function endSessionOnce(memory: AgentmemoryClient, sessions: SessionStore, sessionId: string): Promise<void> {
  const state = sessions.getOrCreate(sessionId);
  if (state.ended) return;

  await memory.post("/session/end", { sessionId });
  sessions.markEnded(sessionId);
}

async function observe(
  memory: AgentmemoryClient,
  project: string,
  cwd: string,
  hookType: HookType,
  sessionId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const payload: HookPayload = {
    hookType,
    sessionId,
    project,
    cwd,
    timestamp: new Date().toISOString(),
    data: redact(data),
  };
  await memory.post("/observe", payload);
}

async function fetchContext(
  memory: AgentmemoryClient,
  sessionId: string,
  project: string,
  budget: number,
): Promise<string | undefined> {
  const response = await memory.post<AgentmemoryContextResponse>("/context", {
    sessionId,
    project,
    budget,
  });
  return response?.context?.trim() || undefined;
}

function formatContextBlock(context: string): string {
  return `## Prior session context\n\n${context}`;
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

function captureToolOutput(output: string): { output: string; imageData?: string } {
  const redacted = redactString(output);
  const imageData = extractImageData(redacted);
  if (imageData) {
    if (imageData.length > MAX_IMAGE_DATA_LENGTH) {
      return { output: `[image data omitted: ${imageData.length} chars]` };
    }

    return {
      output: "[image data extracted]",
      imageData,
    };
  }
  return { output: truncate(redacted, 8000) };
}

function extractImageData(output: string): string | undefined {
  const dataUrl = output.match(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/);
  if (dataUrl?.[0]) return dataUrl[0];

  if (/^[A-Za-z0-9+/=]{200,}$/.test(output.trim()) && output.trim().startsWith("iVBOR")) {
    return output.trim();
  }
  return undefined;
}

function getStringAtPath(value: unknown, path: string[]): string | undefined {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
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
