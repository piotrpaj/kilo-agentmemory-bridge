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
  injectToolContext?: boolean | string;
}

export interface ResolvedConfig {
  baseUrl: string;
  secret?: string;
  tokenBudget: number;
  compactionBudget: number;
  timeoutMs: number;
  injectToolContext: boolean;
}

export interface SessionState {
  id: string;
  started: boolean;
  ended: boolean;
  contextInjected: boolean;
  firstPromptCaptured: boolean;
  pendingContext?: string;
}

export type HookType =
  | "prompt_submit"
  | "post_tool_use"
  | "post_tool_failure"
  | "pre_compact"
  | "session_start"
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
