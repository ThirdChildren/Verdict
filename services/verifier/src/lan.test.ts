import { describe, expect, test } from "vitest";
import { buildServer, LAN_ROUTES } from "./server.js";
import type { VerifierService } from "./service.js";

const LAN = "192.168.50.2";
const PORT = 7404;
const service = {
  handle: async () => ({ ok: true }),
  reports: () => [],
} as unknown as VerifierService;

function lanApp() {
  return buildServer({
    logger: false,
    service,
    localOnly: { port: PORT, uiOrigins: [], lanBind: LAN, lanRoutes: LAN_ROUTES },
  });
}
const peer = { remoteAddress: "192.168.50.10" };

describe("verifier over the LAN", () => {
  test("POST /v0/messages is reachable at the LAN address", async () => {
    const app = lanApp();
    const r = await app.inject({
      method: "POST",
      url: "/v0/messages",
      remoteAddress: peer.remoteAddress,
      headers: { host: `${LAN}:${PORT}` },
      payload: { not: "an envelope" },
    });
    expect(r.statusCode).toBe(400); // reached the handler, which refused the bad format
    await app.close();
  });

  test("everything else is refused from the LAN (health, verdicts, info)", async () => {
    const app = lanApp();
    for (const url of ["/health", "/v0/verdicts", "/v0/info"]) {
      const r = await app.inject({
        method: "GET",
        url,
        remoteAddress: peer.remoteAddress,
        headers: { host: `${LAN}:${PORT}` },
      });
      expect(r.statusCode).toBe(403);
    }
    await app.close();
  });

  test("a wrong Host header is refused even on the LAN route", async () => {
    const app = lanApp();
    const r = await app.inject({
      method: "POST",
      url: "/v0/messages",
      remoteAddress: peer.remoteAddress,
      headers: { host: `evil.example:${PORT}` },
      payload: {},
    });
    expect(r.statusCode).toBe(403);
    await app.close();
  });

  test("a bundle over the size limit is cut off with 413", async () => {
    const app = lanApp();
    const r = await app.inject({
      method: "POST",
      url: "/v0/messages",
      remoteAddress: peer.remoteAddress,
      headers: { host: `${LAN}:${PORT}`, "content-type": "application/json" },
      payload: JSON.stringify({ bundle_b64: "A".repeat(3 * 1024 * 1024) }),
    });
    expect(r.statusCode).toBe(413);
    await app.close();
  });

  test("without VERDICT_LAN_BIND nothing is reachable from the LAN", async () => {
    const app = buildServer({
      logger: false,
      service,
      localOnly: { port: PORT, uiOrigins: [] },
    });
    const r = await app.inject({
      method: "POST",
      url: "/v0/messages",
      remoteAddress: peer.remoteAddress,
      headers: { host: `${LAN}:${PORT}` },
      payload: {},
    });
    expect(r.statusCode).toBe(403);
    await app.close();
  });
});
