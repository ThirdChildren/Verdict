import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import websocket from "@fastify/websocket";
import type { LocalOnlyOptions } from "@verdict/http-local";
import {
  demoTogglesEnabled,
  lanServerOptions,
  localOnly,
  loggerOptions,
} from "@verdict/http-local";
import { envelopeSchema } from "@verdict/protocol";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { WorkerNode } from "./node/node.js";
import type { StreamHub } from "./stream.js";

export const SERVICE = "worker";

export interface WorkerServerOptions {
  logger?: boolean;
  node?: WorkerNode;
  /** Worker public id and Lightning node id, served on /v0/info so the engine can name the payee in an offer. */
  info?: () => Promise<{ public_id: string; node_id: string }>;
  localOnly?: LocalOnlyOptions;
  /** Demo switch "Sabotaged worker". Absent: the endpoints are not served. */
  /** Live model output; served as a WebSocket of WORKER_STREAM events on /v0/events. */
  stream?: StreamHub;
  sabotage?: { get: () => boolean; set: (on: boolean) => void };
  /** Demo switch "worker disappears" (neither claims nor cancels). */
  disappear?: { get: () => boolean; set: (on: boolean) => void };
}

/** The verifier (Mac) posts P_CONFIRM, VERDICT and PREIMAGE here over the LAN; everything else stays on loopback. */
export const LAN_ROUTES = ["POST /v0/messages"] as const;

export function buildServer(opts: WorkerServerOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: opts.logger === false ? false : loggerOptions(SERVICE),
    ...lanServerOptions(256 * 1024),
  });
  if (opts.localOnly) localOnly(app, opts.localOnly);
  const { stream } = opts;
  if (stream) {
    void app.register(websocket);
    void app.register(async (inst) => {
      inst.get("/v0/events", { websocket: true }, (socket) => {
        const send = (e: unknown) => socket.send(JSON.stringify(e));
        for (const e of stream.replay()) send(e);
        const off = stream.subscribe(send);
        socket.on("close", off);
      });
    });
  }
  app.get("/health", async () => ({ ok: true, service: SERVICE }));
  const { sabotage, disappear } = opts;
  if (sabotage) {
    const view = () => ({
      sabotaged: sabotage.get(),
      ...(disappear ? { disappears: disappear.get() } : {}),
    });
    // Demo switches answer only when VERDICT_DEMO_TOGGLES=1 (set by dev:stack); otherwise they do not exist (L1).
    app.get("/v0/config", async (_req, reply) => {
      if (!demoTogglesEnabled()) return reply.callNotFound();
      return view();
    });
    app.post("/v0/config", async (req, reply) => {
      if (!demoTogglesEnabled()) return reply.callNotFound();
      const body = z
        .object({ sabotaged: z.boolean().optional(), disappears: z.boolean().optional() })
        .strict()
        .safeParse(req.body);
      if (
        !body.success ||
        (body.data.sabotaged === undefined && body.data.disappears === undefined)
      ) {
        reply.code(400);
        return { ok: false, reason: "expected {sabotaged?: boolean, disappears?: boolean}" };
      }
      if (body.data.sabotaged !== undefined) sabotage.set(body.data.sabotaged);
      if (body.data.disappears !== undefined) disappear?.set(body.data.disappears);
      return view();
    });
  }
  const { node, info } = opts;
  if (node && info) {
    app.get("/v0/info", async () => info());
    app.post("/v0/messages", async (req, reply) => {
      const env = envelopeSchema.safeParse(req.body);
      if (!env.success) {
        reply.code(400);
        return { ok: false, reason: "the message does not follow the protocol format" };
      }
      const r = await node.handleMessage(env.data);
      if (!r.ok) reply.code(422);
      return r;
    });
    app.get("/v0/tasks", async () => ({ tasks: node.list() }));
    // The delivery files exactly as hashed, so the UI can recompute the directory hash in the browser.
    app.get<{ Params: { id: string } }>("/v0/tasks/:id/delivery", async (req, reply) => {
      const d = node.get(req.params.id)?.delivery;
      if (!d) return reply.code(404).send({ ok: false });
      const root = resolve(d.dir);
      const abs = d.files.map((path) => ({ path, abs: resolve(root, path) }));
      // Fail closed: a path that leaves the delivery directory is never read.
      if (abs.some((f) => !f.abs.startsWith(root + sep)))
        return reply.code(422).send({ ok: false, reason: "a delivery path leaves its directory" });
      const files = abs.map((f) => ({ path: f.path, content: readFileSync(f.abs, "utf8") }));
      return { files };
    });
    app.get<{ Params: { id: string } }>("/v0/tasks/:id", async (req, reply) => {
      const t = node.get(req.params.id);
      if (!t) return reply.code(404).send({ ok: false });
      return t;
    });
  }
  return app;
}
