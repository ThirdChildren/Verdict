// One logger configuration for every service (L2). Secrets never reach a log line, whatever object they sit in.
// pino's `*` matches exactly one level, so each key is listed at depth 0 to 3 (covers req.body.x, body.x, event.body.x).
export const REDACTED_KEYS = [
  "preimage",
  "preimage_hex",
  "P",
  "sealed_preimage",
  "seed",
  "mnemonic",
  "privateKey",
  "private_key",
  "confirm_token",
] as const;

export const REDACT_PATHS: string[] = REDACTED_KEYS.flatMap((k) =>
  [0, 1, 2, 3].map((depth) => `${"*.".repeat(depth)}${k}`),
);

/** Fastify/pino logger options with the shared redaction list. */
export function loggerOptions(name: string): {
  name: string;
  redact: { paths: string[]; censor: string };
} {
  return { name, redact: { paths: REDACT_PATHS, censor: "[redacted]" } };
}

/** Demo-only switches (sabotaged worker, disappearing worker, compromised-agent attack) answer only when this is "1". */
export function demoTogglesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VERDICT_DEMO_TOGGLES === "1";
}
