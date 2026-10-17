import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RerunError, rerunTask } from "./rerun-task.js";
import { detectSandbox } from "./runner.js";

const PKG = resolve(__dirname, "../../../verifier-packages/csv2json-v1");
const ID = "task_0123456789abcdef";
const serve = (status: number, body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const fx = (name: string) => ({
  files: [
    {
      path: "csv2json.mjs",
      content: readFileSync(join(PKG, "fixtures", name, "csv2json.mjs"), "utf8"),
    },
  ],
});
const run = (fetchFn: typeof fetch, taskId = ID) =>
  rerunTask({ taskId, workerUrl: "http://worker.test", packageDir: PKG, fetchFn });

describe("rerunTask", () => {
  it.skipIf(!detectSandbox())("good delivery passes and prints both hashes", async () => {
    const r = await run(serve(200, fx("good-delivery")));
    expect(r.outcome).toBe("PASS");
    expect(r.lines.join("\n")).toMatch(/Package hash {3}[0-9a-f]{64}/);
    expect(r.lines.join("\n")).toMatch(/Delivery hash {2}[0-9a-f]{64}/);
  });
  it.skipIf(!detectSandbox())("bad delivery fails", async () => {
    expect((await run(serve(200, fx("bad-delivery")))).outcome).toBe("FAIL");
  });
  it("fails closed on unknown task, bad id, bad body, path escape, unreachable worker", async () => {
    await expect(run(serve(404, {}))).rejects.toThrow(/no delivery/);
    await expect(run(serve(200, {}), "nope")).rejects.toThrow(/not a task id/);
    await expect(run(serve(200, { files: [1] }))).rejects.toThrow(/unexpected format/);
    await expect(run(serve(200, { files: [{ path: "../x", content: "" }] }))).rejects.toThrow(
      /outside/,
    );
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(run(down)).rejects.toBeInstanceOf(RerunError);
  });
});
