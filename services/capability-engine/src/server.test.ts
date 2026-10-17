import { expect, test } from "vitest";
import { buildServer } from "./server.js";

test("GET /health reports the service name", async () => {
  const app = await buildServer({ logger: false });
  const res = await app.inject({ method: "GET", url: "/health" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true, service: "capability-engine" });
  await app.close();
});

import {
  acceptanceSchema,
  capabilityHash,
  createEd25519Signer,
  hashObj,
  refusalResponseSchema,
  type Signer,
  signPayload,
} from "@verdict/protocol";
import { EventBus } from "./events.js";
import { Ledger } from "./ledger/index.js";
import * as k from "./policy/testkit.js";

async function setup() {
  const buyer = await createEd25519Signer(new Uint8Array(32).fill(7));
  const ledger = Ledger.open(":memory:", k.P);
  const rootHash = capabilityHash(k.root);
  const child = { ...k.child, parent: rootHash };
  const childHash = capabilityHash(child);
  ledger.registerCapability(k.root, rootHash);
  ledger.registerCapability(child, childHash, rootHash, buyer.publicId);
  const bus = new EventBus();
  const app = await buildServer({
    logger: false,
    ledger,
    bus,
    precision: k.P,
    now: () => k.NOW,
    preapprovedWorkers: [k.W1],
  });
  return { app, childHash, buyer, ledger, bus };
}
const intent = {
  kind: "task_payment",
  category: "code",
  counterparty: k.W1,
  amount: "1.00",
  recurring: false,
  interval: null,
  task_spec: "convert csv",
  deadline: "2026-10-18T16:00:00Z",
  rationale: "needed",
};

async function spendEnvelope(signer: Signer, capHash: string, i: unknown = intent) {
  const env: Record<string, unknown> = {
    v: 0,
    id: "11111111-1111-4111-8111-111111111111",
    task_id: "task_0123456789abcdef",
    from: signer.publicId,
    to: signer.publicId,
    sent_at: k.NOW.toISOString(),
    type: "SPEND_INTENT",
    body: { cap_hash: capHash, intent: i },
  };
  env.sig = await signPayload(signer, "SPEND_INTENT", env);
  return env;
}
const post = (app: Awaited<ReturnType<typeof setup>>["app"], payload: unknown) =>
  app.inject({ method: "POST", url: "/v0/messages", payload: payload as object });

test("signed spend intent within the mandate is accepted with the shared Acceptance shape", async () => {
  const { app, childHash, buyer } = await setup();
  const r = await post(app, await spendEnvelope(buyer, childHash));
  expect(r.statusCode).toBe(200);
  expect(acceptanceSchema.parse(r.json())).toEqual({ ok: true, cap_id: k.child.cap_id });
  await app.close();
});

test("out-of-policy intent is refused with the shared REFUSAL shape", async () => {
  const { app, childHash, buyer } = await setup();
  const bad = { ...intent, recurring: true, interval: "daily" };
  const r = await post(app, await spendEnvelope(buyer, childHash, bad));
  expect(r.statusCode).toBe(422);
  const body = refusalResponseSchema.parse(r.json());
  expect(body.code).toBe("RECURRING_NOT_ALLOWED");
  expect(body.message).toContain("recurring");
  expect(body.intent_sha256).toBe(hashObj(bad));
  await app.close();
});

test("wrong holder is refused before policy runs", async () => {
  const { app, childHash } = await setup();
  const other = await createEd25519Signer(new Uint8Array(32).fill(9));
  const r = await post(app, await spendEnvelope(other, childHash));
  expect(r.statusCode).toBe(403);
  expect(refusalResponseSchema.parse(r.json()).code).toBe("SIGNATURE_INVALID");
  await app.close();
});

test("a child with no bound holder fails closed", async () => {
  const { app, buyer, ledger } = await setup();
  const rootHash = capabilityHash(k.root);
  const c2 = { ...k.child, cap_id: "cap_aaaaaaaaaaaaaaaa", max_total: "1.10" };
  const h2 = capabilityHash(c2);
  ledger.registerCapability(c2, h2, rootHash);
  const r = await post(app, await spendEnvelope(buyer, h2));
  expect(refusalResponseSchema.parse(r.json()).code).toBe("SIGNATURE_INVALID");
  await app.close();
});

test("bad signature is refused as SIGNATURE_INVALID", async () => {
  const { app, childHash, buyer } = await setup();
  const env = await spendEnvelope(buyer, childHash);
  env.sig = "0".repeat(128);
  const r = await post(app, env);
  expect(r.statusCode).toBe(401);
  expect(refusalResponseSchema.parse(r.json()).code).toBe("SIGNATURE_INVALID");
  await app.close();
});

test("tampered body invalidates the signature", async () => {
  const { app, childHash, buyer } = await setup();
  const env = await spendEnvelope(buyer, childHash);
  env.body = { cap_hash: childHash, intent: { ...intent, amount: "0.10" } };
  const r = await post(app, env);
  expect(r.statusCode).toBe(401);
  await app.close();
});

test("legacy unsigned SPEND_INTENT body is rejected, from loopback too", async () => {
  const { app, childHash } = await setup();
  const r = await app.inject({
    method: "POST",
    url: "/v0/messages",
    remoteAddress: "127.0.0.1",
    payload: { type: "SPEND_INTENT", cap_hash: childHash, intent },
  });
  expect(r.statusCode).toBe(400);
  expect(refusalResponseSchema.parse(r.json()).code).toBe("MALFORMED_INTENT");
  const m = await post(app, { nope: 1 });
  expect(m.statusCode).toBe(400);
  await app.close();
});

test("BUDGET_UPDATED is emitted on reserve, commit and release", async () => {
  const { ledger, bus, childHash } = await setup();
  const budget = () =>
    bus
      .replay()
      .filter((e) => e.type === "BUDGET_UPDATED")
      .map((e) => e.data);
  const ph1 = "a".repeat(64);
  const r1 = ledger.reserve({
    capHash: childHash,
    taskId: "task_0123456789abcdef",
    paymentHash: ph1,
    amount: 100n,
    now: k.NOW,
  });
  expect(budget().at(-2)).toEqual({
    cap_id: k.child.cap_id,
    remaining: "0.20",
    reserved: "1.00",
    committed: "0.00",
  });
  expect(budget().at(-1)).toMatchObject({ cap_id: k.root.cap_id, remaining: "4.00" });
  ledger.applyPaymentStatus(ph1, "Settled", k.NOW);
  expect(budget().at(-2)).toMatchObject({ reserved: "0.00", committed: "1.00", remaining: "0.20" });
  // a second, failing payment is released and gives its budget back
  const c2 = { ...k.child, cap_id: "cap_bbbbbbbbbbbbbbbb", max_total: "1.00" };
  const h2 = capabilityHash(c2);
  ledger.registerCapability(c2, h2, capabilityHash(k.root));
  ledger.reserve({
    capHash: h2,
    taskId: "task_0123456789abcdef",
    paymentHash: "b".repeat(64),
    amount: 100n,
    now: k.NOW,
  });
  expect(budget().at(-2)).toMatchObject({ cap_id: c2.cap_id, remaining: "0.00", reserved: "1.00" });
  ledger.applyPaymentStatus("b".repeat(64), "Failed", k.NOW);
  expect(budget().at(-2)).toMatchObject({ cap_id: c2.cap_id, remaining: "1.00", reserved: "0.00" });
  expect(r1.state).toBe("reserved");
});

test("the same signed intent twice returns the first answer and records it once", async () => {
  const { app, childHash, buyer, bus } = await setup();
  const bad = { ...intent, recurring: true, interval: "daily" };
  const first = await post(app, await spendEnvelope(buyer, childHash, bad));
  const blocked = () => bus.replay().filter((e) => e.type === "BLOCKED").length;
  const n = blocked();
  const again = await post(app, await spendEnvelope(buyer, childHash, bad));
  expect(again.statusCode).toBe(first.statusCode);
  expect(again.json()).toEqual(first.json());
  expect(blocked()).toBe(n);
  const ok1 = await post(app, await spendEnvelope(buyer, childHash));
  const ok2 = await post(app, await spendEnvelope(buyer, childHash));
  expect(ok2.json()).toEqual(ok1.json());
  await app.close();
});

test("localOnly: engine refuses a foreign Host and a foreign browser Origin", async () => {
  const app = await buildServer({
    logger: false,
    localOnly: { port: 7401, uiOrigins: ["http://localhost:5173"] },
  });
  const h = (headers: Record<string, string>) =>
    app.inject({ method: "GET", url: "/health", headers });
  expect((await h({ host: "127.0.0.1:7401" })).statusCode).toBe(200);
  expect((await h({ host: "attacker.example:7401" })).statusCode).toBe(403);
  expect((await h({ host: "localhost:7401", origin: "http://attacker.example" })).statusCode).toBe(
    403,
  );
  await app.close();
});
