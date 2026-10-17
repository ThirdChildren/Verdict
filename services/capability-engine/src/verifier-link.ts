import { randomUUID } from "node:crypto";
import { type Signer, signPayload, type TaskContract } from "@verdict/protocol";

const isoSec = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/** The engine's one message to the verifier: P_DEPOSIT, the contract plus the preimage sealed to the verifier's key. */
export class VerifierLink {
  constructor(
    private readonly c: {
      signer: Signer;
      now: () => Date;
      fetchImpl?: typeof fetch;
    },
  ) {}

  async deposit(
    taskId: string,
    contract: TaskContract,
    sealedPreimage: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const env: Record<string, unknown> = {
      v: 0,
      id: randomUUID(),
      task_id: taskId,
      from: this.c.signer.publicId,
      to: contract.verifier.public_id,
      sent_at: isoSec(this.c.now()),
      type: "P_DEPOSIT",
      body: { contract, sealed_preimage: sealedPreimage },
    };
    env.sig = await signPayload(this.c.signer, "P_DEPOSIT", env);
    try {
      const r = await (this.c.fetchImpl ?? fetch)(`${contract.verifier.endpoint}/v0/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(env),
        signal: AbortSignal.timeout(15_000),
      });
      if (r.ok) return { ok: true };
      const j = (await r.json().catch(() => ({}))) as { message?: string };
      return { ok: false, reason: j.message ?? `the verifier answered HTTP ${r.status}` };
    } catch (e) {
      return {
        ok: false,
        reason: e instanceof Error ? e.message : "the verifier is not reachable",
      };
    }
  }
}
