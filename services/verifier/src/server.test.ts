import { expect, test } from "vitest";
import { buildServer } from "./server.js";
import type { VerifierService } from "./service.js";

test("GET /health reports the service name", async () => {
  const app = buildServer({ logger: false });
  const res = await app.inject({ method: "GET", url: "/health" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true, service: "verifier" });
  await app.close();
});

test("GET /v0/stats answers from loopback and is empty on a fresh registry", async () => {
  const service = {
    reports: () => [],
    stats: () => ({ packages: [] }),
  } as unknown as VerifierService;
  const app = buildServer({ logger: false, service });
  const res = await app.inject({ method: "GET", url: "/v0/stats" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ packages: [] });
  await app.close();
});

test("GET /v0/verdicts/:task_id returns the entry with its RunReport.v2, 404 otherwise", async () => {
  const entry = { task_id: "t1", reports: [{ v2: { score: 90, profile: "standard" } }] };
  const service = {
    reports: () => [entry],
    stats: () => ({ packages: [] }),
  } as unknown as VerifierService;
  const app = buildServer({ logger: false, service });
  const ok = await app.inject({ method: "GET", url: "/v0/verdicts/t1" });
  expect(ok.statusCode).toBe(200);
  expect(ok.json().reports[0].v2).toEqual({ score: 90, profile: "standard" });
  expect((await app.inject({ method: "GET", url: "/v0/verdicts/nope" })).statusCode).toBe(404);
  await app.close();
});

test("GET /v0/packages lists the catalogue without directories", async () => {
  const pkgs = [{ id: "a", hash: "h".repeat(64), format: 1, profile: null, usable: true }];
  const service = { reports: () => [], packages: () => pkgs } as unknown as VerifierService;
  const app = buildServer({ logger: false, service });
  const res = await app.inject({ method: "GET", url: "/v0/packages" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ packages: pkgs });
  await app.close();
});
