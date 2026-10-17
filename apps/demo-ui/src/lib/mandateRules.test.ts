import { expect, test } from "vitest";
import { mandateDuration } from "./mandateRules.js";

const now = new Date("2026-10-12T10:00:00Z");

test("a 12 h mandate is long enough, a 1 h one is not", () => {
  expect(mandateDuration("2026-10-12T22:00:00Z", now).ok).toBe(true);
  const short = mandateDuration("2026-10-12T11:00:00Z", now);
  expect(short.ok).toBe(false);
  expect(short.minutesLeft).toBe(60);
});

test("an unreadable or past expiry is refused", () => {
  expect(mandateDuration("nonsense", now).ok).toBe(false);
  expect(mandateDuration("2026-10-12T09:00:00Z", now).ok).toBe(false);
});
