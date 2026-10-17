import { randomBytes, randomUUID } from "node:crypto";
import {
  acceptanceSchema,
  refusalResponseSchema,
  type Signer,
  type SpendIntent,
  signPayload,
  WIRE_VERSION,
} from "@verdict/protocol";

export type EngineDecision =
  | { status: "FORWARDED"; httpStatus: number; body: unknown; cap_id?: string | undefined }
  | { status: "BLOCKED"; httpStatus: number; code: string; message: string; body: unknown }
  | { status: "ERROR"; message: string };

export type EngineClientOptions = {
  baseUrl: string;
  /** Public id of the engine (envelope `to`). */
  engineId: string;
  /** Signs with the buyer key. The buyer id (`from`) is signer.publicId and must be the capability's bound holder. */
  signer: Signer;
  fetchFn?: typeof fetch;
  now?: () => Date;
};

/** The only outbound channel of the buyer agent: signed SPEND_INTENT envelopes to capability-engine (ADR-024). */
export class EngineClient {
  private readonly fetchFn: typeof fetch;
  constructor(private readonly o: EngineClientOptions) {
    this.fetchFn = o.fetchFn ?? fetch;
  }

  get buyerId(): string {
    return this.o.signer.publicId;
  }

  async submitIntent(intent: SpendIntent, capHash: string): Promise<EngineDecision> {
    const envelope = {
      v: WIRE_VERSION,
      id: randomUUID(),
      task_id: `task_${randomBytes(8).toString("hex")}`,
      from: this.o.signer.publicId,
      to: this.o.engineId,
      sent_at: (this.o.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"),
      type: "SPEND_INTENT" as const,
      body: { cap_hash: capHash, intent },
    };
    const sig = await signPayload(this.o.signer, "SPEND_INTENT", envelope);
    let res: Response;
    try {
      res = await this.fetchFn(`${this.o.baseUrl}/v0/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...envelope, sig }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      return {
        status: "ERROR",
        message: `The engine could not be reached (${String(err)}). Nothing was paid.`,
      };
    }
    const body: unknown = await res.json().catch(() => null);
    const refusal = refusalResponseSchema.safeParse(body);
    if (refusal.success && !res.ok) {
      return {
        status: "BLOCKED",
        httpStatus: res.status,
        code: refusal.data.code,
        message: refusal.data.message,
        body,
      };
    }
    const accepted = acceptanceSchema.safeParse(body);
    if (res.ok && accepted.success) {
      return { status: "FORWARDED", httpStatus: res.status, body, cap_id: accepted.data.cap_id };
    }
    return { status: "ERROR", message: `The engine answered ${res.status}. Nothing was paid.` };
  }
}
