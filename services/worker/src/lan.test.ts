import { expect, test } from "vitest";
import type { WorkerNode } from "./node/node.js";
import { buildServer, LAN_ROUTES } from "./server.js";

const LAN = "192.168.50.1";
const PORT = 7405;

test("the worker accepts the verifier's signed messages on the LAN, nothing else", async () => {
  const node = { handleMessage: async () => ({ ok: true }) } as unknown as WorkerNode;
  const app = buildServer({
    logger: false,
    node,
    info: async () => ({ public_id: "x", node_id: "y" }),
    localOnly: { port: PORT, uiOrigins: [], lanBind: LAN, lanRoutes: LAN_ROUTES },
  });
  const common = { remoteAddress: "192.168.50.2", headers: { host: `${LAN}:${PORT}` } };
  const post = await app.inject({ method: "POST", url: "/v0/messages", payload: {}, ...common });
  expect(post.statusCode).toBe(400); // reached the handler
  const info = await app.inject({ method: "GET", url: "/v0/info", ...common });
  expect(info.statusCode).toBe(403);
  const big = await app.inject({
    method: "POST",
    url: "/v0/messages",
    ...common,
    headers: { ...common.headers, "content-type": "application/json" },
    payload: JSON.stringify({ x: "A".repeat(400 * 1024) }),
  });
  expect(big.statusCode).toBe(413);
  await app.close();
});
