import { redact } from "./privacy.js";
import type { BridgeLogger, ResolvedConfig } from "./types.js";

export class AgentmemoryClient {
  constructor(
    private readonly config: ResolvedConfig,
    private readonly log: BridgeLogger,
  ) {}

  async post<T>(path: string, body: unknown, timeoutMs = this.config.timeoutMs): Promise<T | null> {
    const url = `${this.config.baseUrl}/agentmemory${path.startsWith("/") ? path : `/${path}`}`;

    if (typeof fetch !== "function") {
      await this.safeLog("warn", "global fetch is unavailable", { path });
      return null;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.secret) headers.Authorization = `Bearer ${this.config.secret}`;

    try {
      const signal = createTimeoutSignal(timeoutMs);
      const init: RequestInit = {
        method: "POST",
        headers,
        body: JSON.stringify(redact(body)),
      };
      if (signal) init.signal = signal;

      const response = await fetch(url, init);

      if (!response.ok) {
        await this.safeLog("warn", "agentmemory request failed", {
          path,
          status: response.status,
          statusText: response.statusText,
        });
        return null;
      }

      const text = await response.text();
      if (!text.trim()) return null;

      try {
        return JSON.parse(text) as T;
      } catch (error) {
        await this.safeLog("warn", "agentmemory returned invalid JSON", {
          path,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    } catch (error) {
      await this.safeLog("warn", "agentmemory request errored", {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async safeLog(level: "debug" | "info" | "warn" | "error", message: string, extra?: unknown): Promise<void> {
    try {
      await this.log(level, message, extra);
    } catch {
      // Logging failures must never affect hook execution.
    }
  }
}

function createTimeoutSignal(timeoutMs: number): AbortSignal | undefined {
  if (typeof AbortSignal === "undefined") return undefined;
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(timeoutMs);

  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs).unref?.();
  return controller.signal;
}
