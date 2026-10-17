import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { localOnly, rateLimit } from "./index.js";

const UI = "http://localhost:5173";
async function app(extra: object = {}) {
  const a = Fastify();
  localOnly(a, { port: 7401, uiOrigins: [UI], ...extra });
  a.get("/api/x", async () => ({ ok: true }));
  a.post("/v0/messages", async () => ({ ok: true }));
  await a.ready();
  return a;
}
const get = (
  a: Awaited<ReturnType<typeof app>>,
  headers: Record<string, string>,
  remoteAddress = "127.0.0.1",
  url = "/api/x",
) => a.inject({ method: "GET", url, headers, remoteAddress });

describe("localOnly", () => {
  it("accepts loopback hosts and refuses others (DNS rebinding)", async () => {
    const a = await app();
    expect((await get(a, { host: "127.0.0.1:7401" })).statusCode).toBe(200);
    expect((await get(a, { host: "localhost:7401" })).statusCode).toBe(200);
    expect((await get(a, { host: "evil.example:7401" })).statusCode).toBe(403);
    expect((await get(a, { host: "127.0.0.1:9999" })).statusCode).toBe(403);
  });
  it("refuses a LAN peer that spoofs the Host header", async () => {
    const a = await app();
    expect((await get(a, { host: "127.0.0.1:7401" }, "192.168.1.9")).statusCode).toBe(403);
  });
  it("allows only the configured UI origin and adds CORS", async () => {
    const a = await app();
    const ok = await get(a, { host: "localhost:7401", origin: UI });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["access-control-allow-origin"]).toBe(UI);
    expect(
      (await get(a, { host: "localhost:7401", origin: "http://evil.example" })).statusCode,
    ).toBe(403);
    const pre = await a.inject({
      method: "OPTIONS",
      url: "/api/x",
      headers: { host: "localhost:7401", origin: UI },
    });
    expect(pre.statusCode).toBe(204);
  });
  it("opens only the listed routes to the LAN when lanBind is set", async () => {
    const a = await app({ lanBind: "192.168.1.5", lanRoutes: ["POST /v0/messages"] });
    const lanHeaders = { host: "192.168.1.5:7401" };
    const post = await a.inject({
      method: "POST",
      url: "/v0/messages",
      headers: lanHeaders,
      remoteAddress: "192.168.1.9",
      payload: {},
    });
    expect(post.statusCode).toBe(200);
    expect((await get(a, lanHeaders, "192.168.1.9")).statusCode).toBe(403);
    const withOrigin = await a.inject({
      method: "POST",
      url: "/v0/messages",
      headers: { ...lanHeaders, origin: UI },
      remoteAddress: "192.168.1.9",
      payload: {},
    });
    expect(withOrigin.statusCode).toBe(403);
  });
  it("without lanBind, no route is LAN-reachable", async () => {
    const a = await app({ lanRoutes: ["POST /v0/messages"] });
    const r = await a.inject({
      method: "POST",
      url: "/v0/messages",
      headers: { host: "192.168.1.5:7401" },
      remoteAddress: "192.168.1.9",
      payload: {},
    });
    expect(r.statusCode).toBe(403);
  });
});

describe("rateLimit", () => {
  it("blocks after max requests and recovers after the window", async () => {
    let t = 0;
    const a = Fastify();
    a.get("/r", { preHandler: rateLimit({ max: 2, windowMs: 1000, now: () => t }) }, async () => ({
      ok: true,
    }));
    const code = async () => (await a.inject({ url: "/r" })).statusCode;
    expect([await code(), await code(), await code()]).toEqual([200, 200, 429]);
    t = 1001;
    expect(await code()).toBe(200);
  });
});
