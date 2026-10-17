import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { demoTogglesEnabled, loggerOptions, REDACTED_KEYS } from "./logger.js";

async function logLines(
  fn: (log: { info: (o: object, m: string) => void }) => void,
): Promise<string> {
  let out = "";
  const app = Fastify({
    logger: {
      ...loggerOptions("test"),
      stream: {
        write: (s: string) => {
          out += s;
        },
      },
    },
  });
  fn(app.log);
  await app.close();
  return out;
}

describe("shared logger redaction (L2)", () => {
  it("never prints a secret, at any of the usual depths", async () => {
    const SECRET = "s3cr3t-value-0123456789";
    const out = await logLines((log) => {
      for (const key of REDACTED_KEYS) {
        log.info({ [key]: SECRET }, "top");
        log.info({ body: { [key]: SECRET } }, "body");
        log.info({ req: { body: { [key]: SECRET } } }, "req.body");
        log.info({ event: { body: { [key]: SECRET } } }, "event.body");
      }
    });
    expect(out).not.toContain(SECRET);
    expect(out).toContain("[redacted]");
  });

  it("leaves ordinary fields alone", async () => {
    const out = await logLines((log) => log.info({ task_id: "t-1", payment_hash: "ab" }, "hello"));
    expect(out).toContain("t-1");
  });
});

describe("demo toggles (L1)", () => {
  it("are on only when VERDICT_DEMO_TOGGLES is exactly 1", () => {
    expect(demoTogglesEnabled({ VERDICT_DEMO_TOGGLES: "1" })).toBe(true);
    for (const v of [undefined, "", "0", "true", "yes"])
      expect(demoTogglesEnabled(v === undefined ? {} : { VERDICT_DEMO_TOGGLES: v })).toBe(false);
  });
});
