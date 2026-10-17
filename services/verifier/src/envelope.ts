import { randomUUID } from "node:crypto";
import {
  type Envelope,
  type EnvelopeType,
  isFresh,
  type MessageBody,
  type Signer,
  signPayload,
  verifyPayload,
} from "@verdict/protocol";

const isoSec = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/** Builds and signs an outgoing envelope. */
export async function buildEnvelope<T extends EnvelopeType>(
  signer: Signer,
  type: T,
  taskId: string,
  to: string,
  body: MessageBody<T>,
  now: Date,
): Promise<Record<string, unknown>> {
  const env: Record<string, unknown> = {
    v: 0,
    id: randomUUID(),
    task_id: taskId,
    from: signer.publicId,
    to,
    sent_at: isoSec(now),
    type,
    body,
  };
  env.sig = await signPayload(signer, type, env);
  return env;
}

/** Signature, freshness and addressee of an incoming envelope. Returns a plain-language problem or undefined. */
export async function checkEnvelope(
  env: Envelope,
  me: string,
  now: Date,
): Promise<string | undefined> {
  if (env.to !== me) return "the message is not addressed to this verifier";
  if (!isFresh(env.sent_at, now.getTime())) return "the message is too old or from the future";
  if (
    !(await verifyPayload(env.type, env as unknown as Record<string, unknown>, env.from, env.sig))
  )
    return `the ${env.type} signature is invalid`;
  return undefined;
}
