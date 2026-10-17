import websocket from "@fastify/websocket";
import { type LocalOnlyOptions, localOnly, loggerOptions } from "@verdict/http-local";
import { type PaymentStatusEvent, WALLET_API, WalletError, type WalletPort } from "@verdict/wallet";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";

export const SERVICE = "wallet-daemon";

/** Setup-only hooks that are not part of WalletPort. */
export interface AdminHooks {
  listChannels(): Promise<unknown>;
}

export interface ServerOptions {
  wallet: WalletPort;
  role: "buyer" | "worker";
  admin?: AdminHooks;
  logger?: boolean;
  /** Host/peer guard (no browser origin is ever allowed). main.ts always passes it. */
  localOnly?: LocalOnlyOptions;
}

const hex32 = z.string().regex(/^[0-9a-f]{64}$/);
const dec = z.string().regex(/^\d{1,30}$/);
const bodies = {
  hodl: z.object({
    paymentHash: hex32,
    assetId: z.string().min(1).max(200),
    assetAmount: dec,
    amtMsat: dec,
    expirySec: z.number().int().positive(),
    minFinalCltvExpiryDelta: z.number().int().positive().optional(),
  }),
  bolt11: z.object({ bolt11: z.string().min(10).max(4000) }),
  claim: z.object({ paymentHash: hex32, preimage: hex32 }),
  hash: z.object({ paymentHash: hex32 }),
  sign: z.object({ message: z.string().min(1).max(10_000) }),
  channel: z.object({
    peer: z.string().min(10).max(300),
    assetId: z.string().min(1).max(200),
    assetAmount: dec,
    capacitySat: z.number().int().positive(),
  }),
};

const HTTP: Record<WalletError["code"], number> = {
  WALLET_INVALID_INPUT: 400,
  WALLET_AMOUNT_TOO_SMALL: 400,
  WALLET_TIMEOUT: 504,
  WALLET_NODE_ERROR: 502,
  WALLET_UNSUPPORTED: 501,
  WALLET_FAKE_IN_DEMO: 500,
};

export async function buildWalletServer(opts: ServerOptions): Promise<FastifyInstance> {
  const { wallet } = opts;
  const app = Fastify({
    logger: opts.logger ? loggerOptions(SERVICE) : false,
  });
  if (opts.localOnly) localOnly(app, opts.localOnly);
  await app.register(websocket);

  // Last status per role and hash, fed by the wallet's own events (the daemon is the only subscriber that persists them).
  const last = new Map<string, PaymentStatusEvent>();
  const sockets = new Set<{ send(data: string): void }>();
  wallet.onPaymentStatus((e) => {
    last.set(`${e.role}:${e.paymentHash}`, e);
    const frame = JSON.stringify(e);
    for (const s of sockets) {
      try {
        s.send(frame);
      } catch {
        sockets.delete(s);
      }
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof WalletError)
      return reply.code(HTTP[err.code]).send({ code: err.code, message: err.message });
    if (err instanceof z.ZodError)
      return reply.code(400).send({
        code: "WALLET_INVALID_INPUT",
        message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
    app.log.error({ err }, "unhandled");
    return reply
      .code(500)
      .send({ code: "WALLET_NODE_ERROR", message: "Wallet daemon internal error" });
  });

  const v = WALLET_API;
  app.get(`${v}/health`, async () => ({ ok: true, role: opts.role, service: SERVICE }));
  app.get(`${v}/node`, async () => ({ nodeId: await wallet.nodeId() }));
  app.post(`${v}/sign`, async (req) => ({
    signature: await wallet.signMessage(bodies.sign.parse(req.body).message),
  }));
  app.get(`${v}/balance/:assetId`, async (req) => {
    const { assetId } = z.object({ assetId: z.string().min(1) }).parse(req.params);
    const b = await wallet.assetBalance(assetId);
    return {
      settled: b.settled.toString(),
      future: b.future.toString(),
      spendable: b.spendable.toString(),
      offchainOutbound: b.offchainOutbound.toString(),
      offchainInbound: b.offchainInbound.toString(),
    };
  });
  app.post(`${v}/invoices/hodl`, async (req) => {
    const b = bodies.hodl.parse(req.body);
    return wallet.createHodlInvoice({
      paymentHash: b.paymentHash,
      assetId: b.assetId,
      assetAmount: BigInt(b.assetAmount),
      amtMsat: BigInt(b.amtMsat),
      expirySec: b.expirySec,
      ...(b.minFinalCltvExpiryDelta !== undefined
        ? { minFinalCltvExpiryDelta: b.minFinalCltvExpiryDelta }
        : {}),
    });
  });
  app.post(`${v}/invoices/decode`, async (req) => {
    const d = await wallet.decodeInvoice(bodies.bolt11.parse(req.body).bolt11);
    return {
      ...d,
      assetAmount: d.assetAmount === null ? null : d.assetAmount.toString(),
      amtMsat: d.amtMsat.toString(),
    };
  });
  app.post(`${v}/payments`, async (req) => {
    const r = await wallet.pay(bodies.bolt11.parse(req.body).bolt11);
    // A Pending payment emits no event until it changes, so record it now: a caller that lost the answer can ask.
    const key = `payer:${r.paymentHash}`;
    if (!last.has(key))
      last.set(key, { paymentHash: r.paymentHash, status: r.status, role: "payer" });
    return r;
  });
  app.post(`${v}/invoices/claim`, async (req) => {
    const b = bodies.claim.parse(req.body);
    return wallet.claimHodlInvoice(b.paymentHash, b.preimage);
  });
  app.post(`${v}/invoices/cancel`, async (req) => {
    await wallet.cancelHodlInvoice(bodies.hash.parse(req.body).paymentHash);
    return { ok: true };
  });
  app.get(`${v}/payments/:hash`, async (req, reply) => {
    const { hash } = z.object({ hash: hex32 }).parse(req.params);
    let statuses = [...last.values()].filter((e) => e.paymentHash === hash);
    if (statuses.length === 0) {
      // After a daemon restart `last` is empty but the wallet can still ask its node. Only "never seen" is a 404.
      try {
        statuses = await wallet.paymentStatus(hash);
      } catch (e) {
        if (!(e instanceof WalletError && e.code === "WALLET_INVALID_INPUT")) throw e;
      }
    }
    if (statuses.length === 0)
      return reply.code(404).send({
        code: "WALLET_INVALID_INPUT",
        message: "This daemon has seen no payment or invoice with that hash",
      });
    return { statuses };
  });
  app.get(`${v}/events`, { websocket: true }, (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
  });

  // Setup only. The channel must be opened by the process that keeps the signer for the channel's whole life.
  app.post(`${v}/admin/open-channel`, async (req) => {
    if (opts.role !== "buyer")
      throw new WalletError("WALLET_UNSUPPORTED", "Only the buyer daemon opens the channel");
    const b = bodies.channel.parse(req.body);
    return wallet.openRgbChannel({
      peer: b.peer,
      assetId: b.assetId,
      assetAmount: BigInt(b.assetAmount),
      capacitySat: b.capacitySat,
    });
  });
  app.get(`${v}/admin/channels`, async () => {
    if (!opts.admin) throw new WalletError("WALLET_UNSUPPORTED", "No admin hooks");
    return { channels: await opts.admin.listChannels() };
  });

  app.addHook("onClose", async () => {
    sockets.clear();
  });
  return app;
}
