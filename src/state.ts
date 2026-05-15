import type { SessionState } from "./types.js";

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

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
