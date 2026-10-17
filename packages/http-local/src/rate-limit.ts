import type { FastifyReply, FastifyRequest } from "fastify";

/** Fixed-window limiter for a single-user local API. Returns a preHandler. */
export function rateLimit(opts: { max: number; windowMs: number; now?: () => number }) {
  const now = opts.now ?? Date.now;
  let windowStart = 0;
  let count = 0;
  return async (_req: FastifyRequest, reply: FastifyReply) => {
    const t = now();
    if (t - windowStart >= opts.windowMs) {
      windowStart = t;
      count = 0;
    }
    count += 1;
    if (count > opts.max) {
      const wait = Math.ceil((windowStart + opts.windowMs - t) / 1000);
      reply.header("retry-after", String(wait));
      return reply.code(429).send({
        ok: false,
        code: "RATE_LIMITED",
        message: `Too many attempts in a short time. Nothing was signed. Please wait ${wait} seconds and try again.`,
      });
    }
    return undefined;
  };
}
