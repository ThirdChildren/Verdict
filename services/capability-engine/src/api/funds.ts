import { formatAmount } from "@verdict/protocol";
import type { WalletPort } from "@verdict/wallet";
import type { FastifyInstance } from "fastify";
import type { Ledger } from "../ledger/index.js";

export interface FundsDeps {
  readonly ledger?: Ledger;
  /** The buyer's wallet daemon. Without it /api/funds answers 503. */
  readonly wallet?: WalletPort;
  /** tUSD asset id from network.json. */
  readonly assetId?: string;
  readonly precision: number;
  /** The principal's public id from identities.json. Without it /api/principal answers 503. */
  readonly principalId?: string;
  /** Base URL of the principal-signer, e.g. http://127.0.0.1:7403. */
  readonly signerUrl: string;
  readonly signerFetch?: typeof fetch;
}

const SIGNER_TIMEOUT_MS = 2_000;

/**
 * Read-only routes for the console's "Connect principal" and funds panel. Amounts are decimal strings computed here;
 * the browser never does money math on them. Nothing here signs or moves funds.
 */
export function registerFundsRoutes(app: FastifyInstance, d: FundsDeps): void {
  // spendable = what the buyer's channel can send (off-chain outbound); reserved = tasks whose payment is not committed yet;
  // available_to_delegate = spendable - reserved, floored at 0. A task already locked in the channel is counted in both,
  // so this errs on the side of delegating less.
  app.get("/api/funds", async (_req, reply) => {
    if (!d.wallet || !d.assetId || !d.ledger) {
      reply.code(503);
      return {
        ok: false,
        code: "FUNDS_UNAVAILABLE",
        message: "The engine is running without a wallet, so it cannot report funds.",
      };
    }
    try {
      const b = await d.wallet.assetBalance(d.assetId);
      const reserved = d.ledger.reservedTotal();
      const free = b.offchainOutbound - reserved;
      const f = (v: bigint) => formatAmount(v, d.precision);
      return {
        ok: true,
        spendable: f(b.offchainOutbound),
        reserved: f(reserved),
        available_to_delegate: f(free < 0n ? 0n : free),
      };
    } catch {
      reply.code(502);
      return {
        ok: false,
        code: "FUNDS_UNAVAILABLE",
        message: "The wallet did not answer, so the funds are unknown right now.",
      };
    }
  });

  app.get("/api/principal", async (_req, reply) => {
    const down = (code: string, message: string) => {
      reply.code(502);
      return { ok: false, code, message };
    };
    if (!d.principalId) {
      reply.code(503);
      return {
        ok: false,
        code: "PRINCIPAL_UNAVAILABLE",
        message: "The engine does not know the principal's identity.",
      };
    }
    try {
      const res = await (d.signerFetch ?? fetch)(`${d.signerUrl}/health`, {
        signal: AbortSignal.timeout(SIGNER_TIMEOUT_MS),
      });
      const j = (await res.json()) as { ok?: unknown; principal?: unknown };
      if (!res.ok || j.ok !== true)
        return down("PRINCIPAL_SIGNER_DOWN", "The principal signer is not answering.");
      if (j.principal !== d.principalId)
        return down(
          "PRINCIPAL_MISMATCH",
          "The principal signer holds a different key than the one this engine trusts.",
        );
      return { ok: true, id: d.principalId };
    } catch {
      return down(
        "PRINCIPAL_SIGNER_DOWN",
        "The principal signer is not running, so the principal cannot be connected.",
      );
    }
  });
}
