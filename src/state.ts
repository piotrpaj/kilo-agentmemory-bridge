import type { SessionState, ToolCallState } from "./types.js";

export class SessionStore {
  private readonly sessions = new Map<string, SessionState>();

  get(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  getOrCreate(sessionId: string): SessionState {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const state: SessionState = {
      id: sessionId,
      started: false,
      ended: false,
      contextInjected: false,
      firstPromptCaptured: false,
      pendingToolContext: [],
      toolCalls: new Map<string, ToolCallState>(),
      observedCallIds: new Set<string>(),
      completedTaskIds: new Set<string>(),
    };
    this.sessions.set(sessionId, state);
    return state;
  }

  markStarted(sessionId: string, pendingContext?: string): SessionState {
    const state = this.getOrCreate(sessionId);
    state.started = true;
    state.ended = false;
    if (pendingContext) state.pendingContext = pendingContext;
    return state;
  }

  markEnded(sessionId: string): SessionState {
    const state = this.getOrCreate(sessionId);
    state.ended = true;
    return state;
  }

  recordToolCall(sessionId: string, call: ToolCallState): SessionState {
    const state = this.getOrCreate(sessionId);
    state.toolCalls.set(call.callID, call);
    return state;
  }

  markObserved(sessionId: string, callID: string, hookType: string): boolean {
    const state = this.getOrCreate(sessionId);
    const key = `${callID}:${hookType}`;
    if (state.observedCallIds.has(key)) return false;
    state.observedCallIds.add(key);
    return true;
  }

  hasObserved(sessionId: string, callID: string, hookType: string): boolean {
    return this.getOrCreate(sessionId).observedCallIds.has(`${callID}:${hookType}`);
  }

  addPendingToolContext(sessionId: string, context: string): void {
    const trimmed = context.trim();
    if (!trimmed) return;
    this.getOrCreate(sessionId).pendingToolContext.push(trimmed);
  }

  consumePendingToolContext(sessionId: string): string[] {
    const state = this.getOrCreate(sessionId);
    const pending = state.pendingToolContext.splice(0);
    return pending;
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
