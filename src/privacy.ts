const REDACTED = "[REDACTED]";
const MAX_REDACTION_DEPTH = 12;

const SECRET_KEY_PATTERN = /(?:key|secret|password|passwd|pwd|token|auth|credential)/i;

const STRING_REDACTIONS: Array<[RegExp, string]> = [
  [/<private>[\s\S]*?<\/private>/gi, `<private>${REDACTED}</private>`],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, REDACTED],
];

export function redactString(value: string): string {
  let output = value;
  for (const [pattern, replacement] of STRING_REDACTIONS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n[truncated ${value.length - maxLength} chars]`;
}

export function redact<T>(value: T): T {
  return redactValue(value, new WeakSet<object>(), 0) as T;
}

function redactValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return undefined;
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") return "[function]";

  if (depth >= MAX_REDACTION_DEPTH) return "[max depth reached]";
  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen, depth + 1));
  }

  if (value instanceof Date) return value.toISOString();

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SECRET_KEY_PATTERN.test(key)
      ? REDACTED
      : redactValue(item, seen, depth + 1);
  }
  return output;
}
