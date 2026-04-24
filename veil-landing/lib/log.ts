/**
 * Server-side log helpers with redaction for sensitive fields.
 * Use these in API routes instead of console.log directly when handling
 * request payloads that may contain signatures, nonces, or session tokens.
 */

const REDACT_KEYS = new Set([
  "signature", "sig", "nonce", "secret", "secret_key", "secretKey",
  "private_key", "privateKey", "password", "DATABASE_URL",
]);

export function redact<T>(obj: T): T {
  if (obj == null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(redact) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (REDACT_KEYS.has(k)) {
      out[k] = "[REDACTED]";
    } else if (v != null && typeof v === "object") {
      out[k] = redact(v);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

export function logSafe(level: "info" | "warn" | "error", tag: string, payload?: unknown) {
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  if (payload === undefined) {
    fn(`[${tag}]`);
  } else {
    fn(`[${tag}]`, redact(payload));
  }
}
