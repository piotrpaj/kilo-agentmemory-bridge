export type LogLevel = "debug" | "info" | "warn" | "error";

export type BridgeLogger = (
  level: LogLevel,
  message: string,
  extra?: unknown,
) => void | Promise<void>;

export interface AgentmemoryPluginOptions {
  url?: string;
  secret?: string;
  tokenBudget?: number | string;
  compactionBudget?: number | string;
  timeoutMs?: number | string;
  shortTimeoutMs?: number | string;
  injectTimeoutMs?: number | string;
  summarizeTimeoutMs?: number | string;
  sessionEndTimeoutMs?: number | string;
  consolidationTimeoutMs?: number | string;
  injectSessionContext?: boolean | string;
  injectToolContext?: boolean | string;
  summarizeOnStop?: boolean | string;
  consolidationEnabled?: boolean | string;
  memoryBridgeSync?: boolean | string;
  endSessionOnIdle?: boolean | string;
}

export interface ResolvedConfig {
  baseUrl: string;
  secret?: string;
  tokenBudget: number;
  compactionBudget: number;
  timeoutMs: number;
  shortTimeoutMs: number;
  injectTimeoutMs: number;
  summarizeTimeoutMs: number;
  sessionEndTimeoutMs: number;
  consolidationTimeoutMs: number;
  injectSessionContext: boolean;
  injectToolContext: boolean;
  summarizeOnStop: boolean;
  consolidationEnabled: boolean;
  memoryBridgeSync: boolean;
  endSessionOnIdle: boolean;
}

export interface ToolCallState {
  callID: string;
  sessionID: string;
  toolName: string;
  args?: unknown;
  startedAt: string;
  metadata?: unknown;
}

export interface SessionState {
  id: string;
  started: boolean;
  ended: boolean;
  contextInjected: boolean;
  firstPromptCaptured: boolean;
  pendingContext?: string;
  pendingToolContext: string[];
  toolCalls: Map<string, ToolCallState>;
  observedCallIds: Set<string>;
  completedTaskIds: Set<string>;
  lastIdleSummarizedAt?: number;
  activeAgent?: string;
}

export type HookType =
  | "session_start"
  | "prompt_submit"
  | "pre_tool_use"
  | "post_tool_use"
  | "post_tool_failure"
  | "pre_compact"
  | "subagent_start"
  | "subagent_stop"
  | "notification"
  | "task_completed"
  | "stop"
  | "session_end";

export interface HookPayload<TData = ObserveData> {
  hookType: HookType;
  sessionId: string;
  project: string;
  cwd: string;
  timestamp: string;
  data: TData;
}

export type ObserveData = Record<string, unknown>;

export interface AgentmemoryContextResponse {
  context?: string;
}

export interface AgentmemorySessionStartResponse extends AgentmemoryContextResponse {
  session?: unknown;
}

export interface AgentmemoryEnrichResponse extends AgentmemoryContextResponse {
  contexts?: string[];
  memories?: string[];
}
