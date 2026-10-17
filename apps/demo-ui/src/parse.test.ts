import { describe, expect, it } from "vitest";
import { parseUiEvent } from "./lib/parse.js";
import { MOCK_EVENTS } from "./mock/events.js";

describe("parseUiEvent", () => {
  it("accepts a valid frame", () => {
    expect(parseUiEvent(JSON.stringify(MOCK_EVENTS[0])).ok).toBe(true);
  });
  it("rejects non-JSON and unknown event types", () => {
    expect(parseUiEvent("{nope").ok).toBe(false);
    expect(parseUiEvent({ seq: 1, at: "2026-10-18T16:00:00Z", type: "WHAT", data: {} }).ok).toBe(
      false,
    );
  });
});
