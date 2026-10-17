import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirHash } from "@verdict/protocol";
import { expect, test, vi } from "vitest";
import { buildServer } from "./server.js";

test("GET /health reports the service name", async () => {
  const app = buildServer({ logger: false });
  const res = await app.inject({ method: "GET", url: "/health" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true, service: "worker" });
  await app.close();
});

test("demo switches answer only when VERDICT_DEMO_TOGGLES=1, otherwise 404", async () => {
  let on = false;
  const app = buildServer({
    logger: false,
    sabotage: {
      get: () => on,
      set: (v) => {
        on = v;
      },
    },
  });
  vi.stubEnv("VERDICT_DEMO_TOGGLES", "");
  expect((await app.inject({ method: "GET", url: "/v0/config" })).statusCode).toBe(404);
  const off = await app.inject({ method: "POST", url: "/v0/config", payload: { sabotaged: true } });
  expect(off.statusCode).toBe(404);
  expect(on).toBe(false);
  vi.stubEnv("VERDICT_DEMO_TOGGLES", "1");
  const r = await app.inject({ method: "POST", url: "/v0/config", payload: { sabotaged: true } });
  expect(r.statusCode).toBe(200);
  expect(on).toBe(true);
  vi.unstubAllEnvs();
  await app.close();
});

function deliveryApp(files: string[], dir: string, dh: string) {
  const task = { taskId: "task_0123456789abcdef", delivery: { dir, dirHash: dh, files } };
  const node = {
    get: (id: string) => (id === task.taskId ? task : undefined),
    list: () => [task],
    handleMessage: async () => ({ ok: true }),
  };
  return buildServer({
    logger: false,
    node: node as never,
    info: async () => ({ public_id: "w", node_id: "n" }),
  });
}

test("GET /v0/tasks/:id/delivery serves files that hash to the announced dirHash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deliv-"));
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "out.json"), '[{"a":"1"}]');
  writeFileSync(join(dir, "sub", "x.txt"), "hello");
  const enc = new TextEncoder();
  const announced = dirHash([
    { path: "out.json", bytes: enc.encode('[{"a":"1"}]') },
    { path: "sub/x.txt", bytes: enc.encode("hello") },
  ]);
  const app = deliveryApp(["out.json", "sub/x.txt"], dir, announced);
  const res = await app.inject({ method: "GET", url: "/v0/tasks/task_0123456789abcdef/delivery" });
  expect(res.statusCode).toBe(200);
  const files = res.json().files as { path: string; content: string }[];
  expect(dirHash(files.map((f) => ({ path: f.path, bytes: enc.encode(f.content) })))).toBe(
    announced,
  );
  await app.close();
});

test("delivery of an unknown task is 404", async () => {
  const app = deliveryApp([], tmpdir(), "0".repeat(64));
  const res = await app.inject({ method: "GET", url: "/v0/tasks/task_ffffffffffffffff/delivery" });
  expect(res.statusCode).toBe(404);
  await app.close();
});

test("a delivery path that leaves its directory is refused and nothing is read", async () => {
  const base = mkdtempSync(join(tmpdir(), "deliv-"));
  const dir = join(base, "attempt-1");
  mkdirSync(dir);
  writeFileSync(join(base, "secret.txt"), "TOPSECRET");
  const app = deliveryApp(["../secret.txt"], dir, "0".repeat(64));
  const res = await app.inject({ method: "GET", url: "/v0/tasks/task_0123456789abcdef/delivery" });
  expect(res.statusCode).toBe(422);
  expect(res.body).not.toContain("TOPSECRET");
  await app.close();
});
