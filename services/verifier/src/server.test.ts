import { expect, test } from "vitest";
import { buildServer } from "./server.js";

test("GET /health reports the service name", async () => {
  const app = buildServer({ logger: false });
  const res = await app.inject({ method: "GET", url: "/health" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true, service: "verifier" });
  await app.close();
});
