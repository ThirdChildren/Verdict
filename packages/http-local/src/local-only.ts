import type { FastifyInstance, FastifyRequest } from "fastify";

export interface LocalOnlyOptions {
  /** Port this service listens on; the Host header must name it. */
  readonly port: number;
  /** Browser origins allowed to call this service (the demo-ui). */
  readonly uiOrigins: readonly string[];
  /** VERDICT_LAN_BIND: the LAN address the verifier may reach. Unset means loopback only. */
  readonly lanBind?: string;
  /** Routes ("POST /v0/messages") reachable from the LAN. Ignored unless lanBind is set. */
  readonly lanRoutes?: readonly string[];
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const DEFAULT_UI_PORT = 5173;

export function defaultUiOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.VERDICT_UI_ORIGIN;
  if (raw)
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return [`http://localhost:${DEFAULT_UI_PORT}`, `http://127.0.0.1:${DEFAULT_UI_PORT}`];
}

/** Options for a service's main.ts, read from the environment. */
export function localOnlyFromEnv(
  port: number,
  lanRoutes: readonly string[] = [],
): LocalOnlyOptions {
  const lanBind = process.env.VERDICT_LAN_BIND;
  return {
    port,
    uiOrigins: defaultUiOrigins(),
    ...(lanBind ? { lanBind, lanRoutes } : {}),
  };
}

/** Address to listen on: loopback, or all interfaces only when a LAN bind is configured (checks below still apply). */
export function listenHost(o: LocalOnlyOptions): string {
  return o.lanBind ? "0.0.0.0" : "127.0.0.1";
}

function refuse(
  reply: { code(n: number): { send(body: unknown): unknown } },
  code: string,
  message: string,
) {
  return reply.code(403).send({ ok: false as const, code, message });
}

/**
 * Registers hooks that keep a service reachable only from this machine (DNS rebinding and browser
 * cross-origin attacks included): Host allowlist, loopback peer, Origin allowlist with CORS.
 * Routes in `lanRoutes` may also be reached from the LAN when `lanBind` is set.
 */
export function localOnly(app: FastifyInstance, o: LocalOnlyOptions): void {
  const localHosts = new Set([`127.0.0.1:${o.port}`, `localhost:${o.port}`, `[::1]:${o.port}`]);
  const lanHosts = new Set(o.lanBind ? [...localHosts, `${o.lanBind}:${o.port}`] : []);
  const lanRoutes = new Set(o.lanBind ? (o.lanRoutes ?? []) : []);
  const origins = new Set(o.uiOrigins);

  const isLan = (req: FastifyRequest): boolean =>
    lanRoutes.has(`${req.method} ${req.routeOptions.url ?? req.url.split("?")[0]}`);

  app.addHook("onRequest", async (req, reply) => {
    const lan = isLan(req);
    const host = req.headers.host ?? "";
    if (!(lan ? lanHosts : localHosts).has(host))
      return refuse(
        reply,
        "HOST_NOT_ALLOWED",
        "This service only answers requests addressed to this machine.",
      );
    if (!lan && !LOOPBACK.has(req.socket.remoteAddress ?? ""))
      return refuse(
        reply,
        "PEER_NOT_ALLOWED",
        "This service only answers requests from this machine.",
      );
    const origin = req.headers.origin;
    if (origin !== undefined) {
      if (lan || !origins.has(origin))
        return refuse(
          reply,
          "ORIGIN_NOT_ALLOWED",
          "This page is not allowed to talk to this service.",
        );
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-allow-headers", "content-type, x-verdict-ui");
      reply.header("access-control-allow-methods", "GET, POST, OPTIONS");
      reply.header("vary", "origin");
      if (req.method === "OPTIONS") return reply.code(204).send();
    }
    return undefined;
  });
}

/**
 * Fastify options for services that accept signed messages from the LAN: a slow or oversized request
 * is cut off instead of holding the process. `bodyLimit` is in bytes; messages are small, only the
 * verifier's DELIVER carries a bundle (1 MB compressed, about 1.4 MB as base64).
 */
export function lanServerOptions(bodyLimit: number): {
  bodyLimit: number;
  requestTimeout: number;
  keepAliveTimeout: number;
} {
  return { bodyLimit, requestTimeout: 30_000, keepAliveTimeout: 5_000 };
}
