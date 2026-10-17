import { type UiEvent, uiEventSchema } from "@verdict/protocol";

export type ParseResult = { ok: true; event: UiEvent } | { ok: false; reason: string };

/** Validates one raw WebSocket frame. Anything malformed is rejected, never guessed at. */
export function parseUiEvent(raw: unknown): ParseResult {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false, reason: "not JSON" };
    }
  }
  const r = uiEventSchema.safeParse(value);
  return r.success
    ? { ok: true, event: r.data }
    : { ok: false, reason: r.error.issues[0]?.message ?? "invalid event" };
}
