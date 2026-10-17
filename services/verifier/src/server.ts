import {
  type LocalOnlyOptions,
  lanServerOptions,
  localOnly,
  loggerOptions,
} from "@verdict/http-local";
import { envelopeSchema } from "@verdict/protocol";
import Fastify, { type FastifyInstance } from "fastify";
import type { VerifierService } from "./service.js";

export const SERVICE = "verifier";

export interface VerifierServerOptions {
  logger?: boolean;
  service?: VerifierService;
  info?: () => { public_id: string; package_sha256: string; sandbox: string };
  localOnly?: LocalOnlyOptions;
}

/** Routes the Mac verifier exposes to the Legion over the LAN (the rest stays on loopback). */
export const LAN_ROUTES = ["POST /v0/messages"] as const;

export function buildServer(opts: VerifierServerOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: opts.logger === false ? false : loggerOptions(SERVICE),
    ...lanServerOptions(2 * 1024 * 1024),
  });
  if (opts.localOnly) localOnly(app, opts.localOnly);
  app.get("/health", async () => ({ ok: true, service: SERVICE }));
  const { service, info } = opts;
  if (service) {
    app.post("/v0/messages", async (req, reply) => {
      const env = envelopeSchema.safeParse(req.body);
      if (!env.success) {
        reply.code(400);
        return {
          ok: false,
          code: "MALFORMED_INTENT",
          message: "the message does not follow the protocol format",
        };
      }
      const a = await service.handle(env.data);
      if (!a.ok) reply.code(422);
      return a;
    });
    app.get("/v0/verdicts", async () => ({ tasks: service.reports() }));
  }
  if (info) app.get("/v0/info", async () => info());
  return app;
}
