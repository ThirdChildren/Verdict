import {
  BLOCK_CODES,
  BLOCK_TEMPLATES,
  type ChildCapability,
  capabilityHash,
  capId,
  createEd25519Signer,
  type RootCapability,
  refusalResponseSchema,
  type Signer,
  signPayload,
  uiEventSchema,
} from "@verdict/protocol";
import { expect, test } from "vitest";
import { EventBus } from "../events.js";
import { Ledger } from "../ledger/index.js";
import { canDerive } from "../policy/index.js";
import * as k from "../policy/testkit.js";
import { buildServer } from "../server.js";

const seed = (n: number) => new Uint8Array(32).fill(n);
const EVIL = `eip191:0x${"9".repeat(40)}`;

async function setup() {
  const principal = await createEd25519Signer(seed(1));
  const engine = await createEd25519Signer(seed(2));
  const buyer = await createEd25519Signer(seed(3));
  const ledger = Ledger.open(":memory:", k.P);
  const bus = new EventBus();
  const app = await buildServer({
    logger: false,
    ledger,
    bus,
    precision: k.P,
    now: () => k.NOW,
    identities: { principal: principal.publicId, engine: engine.publicId, buyer: buyer.publicId },
    engineSigner: engine,
    limits: { max_root_amount: "500.00", max_root_expiry_seconds: 86_400 },
  });
  return { app, ledger, bus, principal, buyer, engine };
}

async function signedRoot(signer: Signer, over: Partial<RootCapability> = {}) {
  const base = {
    ...k.root,
    issuer: signer.publicId,
    max_total: "5.00",
    max_per_task: "2.00",
    allowed_payees: [k.W1],
    expires_at: "2026-10-18T17:00:00Z",
    ...over,
  } as RootCapability;
  const withId = { ...base, cap_id: capId(base) };
  return { ...withId, signature: await signPayload(signer, "CAP_ROOT", withId) };
}
const postMandate = (app: Awaited<ReturnType<typeof setup>>["app"], root: unknown) =>
  app.inject({ method: "POST", url: "/api/mandate", payload: { root } });
const count = (ledger: Ledger, h: string) => ledger.getCapability(h) !== undefined;

async function spend(buyer: Signer, capHash: string, counterparty: string) {
  const env: Record<string, unknown> = {
    v: 0,
    id: "11111111-1111-4111-8111-111111111111",
    task_id: "task_0123456789abcdef",
    from: buyer.publicId,
    to: buyer.publicId,
    sent_at: k.NOW.toISOString(),
    type: "SPEND_INTENT",
    body: {
      cap_hash: capHash,
      intent: { ...k.intent, counterparty, amount: "1.00", deadline: "2026-10-18T16:00:00Z" },
    },
  };
  env.sig = await signPayload(buyer, "SPEND_INTENT", env);
  return env;
}

test("happy path: root and child registered, intent to an allowed payee accepted", async () => {
  const { app, ledger, bus, principal, buyer, engine } = await setup();
  const root = await signedRoot(principal);
  const r = await postMandate(app, root);
  expect(r.statusCode).toBe(200);
  const j = r.json() as { ok: boolean; root_cap_id: string; cap_hash: string };
  expect(j.ok).toBe(true);
  expect(j.root_cap_id).toBe(root.cap_id);
  expect(count(ledger, capabilityHash(root))).toBe(true);
  const child = ledger.getCapability(j.cap_hash) as ChildCapability;
  expect(child.issuer).toBe(engine.publicId);
  expect(child.max_total).toBe("2.00");
  expect(child.max_payments).toBe(1);
  expect(ledger.holderOf(j.cap_hash)).toBe(buyer.publicId);
  expect((await app.inject({ method: "GET", url: "/api/mandate/active" })).json()).toMatchObject({
    cap_hash: j.cap_hash,
    allowed_categories: child.allowed_categories,
    expires_at: child.expires_at,
    remaining: "2.00",
  });
  for (const e of bus.replay()) uiEventSchema.parse(e);
  const ok = await app.inject({
    method: "POST",
    url: "/v0/messages",
    payload: await spend(buyer, j.cap_hash, k.W1),
  });
  expect(ok.statusCode).toBe(200);
  await app.close();
});

test("no mandate yet: /api/mandate/active is 404", async () => {
  const { app } = await setup();
  expect((await app.inject({ method: "GET", url: "/api/mandate/active" })).statusCode).toBe(404);
  await app.close();
});

test("bypassing the buyer agent: a signed intent to an attacker is refused and nothing is reserved", async () => {
  const { app, ledger, principal, buyer } = await setup();
  const j = (await postMandate(app, await signedRoot(principal))).json() as { cap_hash: string };
  const r = await app.inject({
    method: "POST",
    url: "/v0/messages",
    payload: await spend(buyer, j.cap_hash, EVIL),
  });
  expect(r.statusCode).toBe(422);
  expect(r.json()).toMatchObject({ ok: false, code: "COUNTERPARTY_NOT_ALLOWED" });
  expect(ledger.paymentsMade(j.cap_hash)).toBe(0);
  expect(ledger.remaining(j.cap_hash)).toBe(200n);
  await app.close();
});

test("root above the hard amount limit is refused and nothing is registered", async () => {
  const { app, ledger, principal } = await setup();
  const root = await signedRoot(principal, { max_total: "500.01", max_per_task: "2.00" });
  const r = await postMandate(app, root);
  expect(r.statusCode).toBe(422);
  expect(r.json()).toMatchObject({ ok: false, code: "ROOT_OVER_HARD_LIMIT" });
  expect(count(ledger, capabilityHash(root))).toBe(false);
  expect((await app.inject({ method: "GET", url: "/api/mandate/active" })).statusCode).toBe(404);
  await app.close();
});

test("root above the hard expiry limit is refused and nothing is registered", async () => {
  const { app, ledger, principal } = await setup();
  const root = await signedRoot(principal, { expires_at: "2026-10-20T00:00:00Z" });
  const r = await postMandate(app, root);
  expect(r.statusCode).toBe(422);
  expect(r.json()).toMatchObject({ ok: false, code: "ROOT_OVER_HARD_LIMIT" });
  expect(count(ledger, capabilityHash(root))).toBe(false);
  await app.close();
});

test("already-expired root is refused", async () => {
  const { app, principal } = await setup();
  const r = await postMandate(
    app,
    await signedRoot(principal, { expires_at: "2026-10-18T14:00:00Z" }),
  );
  expect(r.json()).toMatchObject({ code: "CAPABILITY_EXPIRED" });
  await app.close();
});

test("root not issued by the principal, or with a bad signature, is refused", async () => {
  const { app, ledger, principal } = await setup();
  const other = await createEd25519Signer(seed(9));
  const foreign = await signedRoot(other);
  expect((await postMandate(app, foreign)).json()).toMatchObject({ code: "SIGNATURE_INVALID" });
  const good = await signedRoot(principal);
  const tampered = { ...good, max_total: "6.00" };
  const r = await postMandate(app, { ...tampered, cap_id: capId(tampered) });
  expect(r.json()).toMatchObject({ code: "SIGNATURE_INVALID" });
  expect(count(ledger, capabilityHash(foreign))).toBe(false);
  await app.close();
});

test("canDerive: child payee outside the parent list is PAYEE_NOT_IN_PARENT", () => {
  const d = canDerive(k.root, { ...k.child, allowed_payees: [EVIL] }, k.deriveCtx);
  expect(d).toMatchObject({ ok: false, code: "PAYEE_NOT_IN_PARENT" });
});

const LOCAL_CODES = ["ROOT_OVER_HARD_LIMIT", "SECOND_CONFIRM_REQUIRED", "UI_ONLY"];

test("local UI codes are not in the block catalogue and never reach a REFUSAL or BLOCKED event", async () => {
  const { app, bus, principal, buyer } = await setup();
  const events: string[] = [];
  bus.subscribe?.((e: unknown) => events.push(JSON.stringify(e)));
  for (const c of LOCAL_CODES) expect(BLOCK_CODES as string[]).not.toContain(c);
  expect(JSON.stringify(BLOCK_TEMPLATES)).not.toMatch(
    /ROOT_OVER_HARD_LIMIT|SECOND_CONFIRM|UI_ONLY/,
  );
  const over = await postMandate(app, await signedRoot(principal, { max_total: "500.01" }));
  expect(over.json().code).toBe("ROOT_OVER_HARD_LIMIT");
  const j = (await postMandate(app, await signedRoot(principal))).json() as { cap_hash: string };
  const refused = await app.inject({
    method: "POST",
    url: "/v0/messages",
    payload: await spend(buyer, j.cap_hash, EVIL),
  });
  expect(refusalResponseSchema.safeParse(refused.json()).success).toBe(true);
  for (const body of [refused.body, ...events])
    for (const c of LOCAL_CODES) expect(body).not.toContain(c);
  await app.close();
});

test("root for another asset is refused when the engine knows the network asset", async () => {
  const { app: _unused, ...rest } = await setup();
  void _unused;
  const app = await buildServer({
    logger: false,
    ledger: Ledger.open(":memory:", k.P),
    precision: k.P,
    now: () => k.NOW,
    identities: {
      principal: rest.principal.publicId,
      engine: rest.engine.publicId,
      buyer: rest.buyer.publicId,
    },
    engineSigner: rest.engine,
    limits: { max_root_amount: "500.00", max_root_expiry_seconds: 86_400 },
    assetId: "rgb:some-other-asset",
  });
  const r = await postMandate(app, await signedRoot(rest.principal));
  expect(r.json()).toMatchObject({ ok: false, code: "ASSET_MISMATCH" });
  await app.close();
});

test("replay after demo:reset: a root for the previous asset id is refused with ASSET_MISMATCH", async () => {
  const { app, principal } = await setup();
  await app.close();
  const world = await setup();
  const fresh = await buildServer({
    logger: false,
    ledger: Ledger.open(":memory:", k.P),
    precision: k.P,
    now: () => k.NOW,
    identities: {
      principal: principal.publicId,
      engine: world.engine.publicId,
      buyer: world.buyer.publicId,
    },
    engineSigner: world.engine,
    limits: { max_root_amount: "500.00", max_root_expiry_seconds: 86_400 },
    assetId: "rgb:asset-after-reset",
  });
  const oldRoot = await signedRoot(principal, { asset_id: "rgb:asset-before-reset" });
  const r = await postMandate(fresh, oldRoot);
  expect(r.statusCode).toBe(422);
  expect(r.json()).toMatchObject({ ok: false, code: "ASSET_MISMATCH" });
  await fresh.close();
  await world.app.close();
});

test("/api/mandate is rate limited", async () => {
  const principal = await createEd25519Signer(seed(1));
  const engine = await createEd25519Signer(seed(2));
  const buyer = await createEd25519Signer(seed(3));
  const app = await buildServer({
    logger: false,
    ledger: Ledger.open(":memory:", k.P),
    precision: k.P,
    now: () => k.NOW,
    identities: { principal: principal.publicId, engine: engine.publicId, buyer: buyer.publicId },
    engineSigner: engine,
    limits: { max_root_amount: "500.00", max_root_expiry_seconds: 86_400 },
    mandateRateLimit: { max: 2, windowMs: 60_000 },
  });
  const codes: number[] = [];
  for (let i = 0; i < 3; i++) codes.push((await postMandate(app, {})).statusCode);
  expect(codes).toEqual([400, 400, 429]);
  await app.close();
});

// ---- POST /api/mandate/task ----
async function withMandate() {
  const s = await setup();
  const root = await signedRoot(s.principal, { max_total: "5.00", max_per_task: "2.00" });
  expect((await postMandate(s.app, root)).statusCode).toBe(200);
  return { ...s, root };
}
const postTask = (app: Awaited<ReturnType<typeof setup>>["app"]) =>
  app.inject({ method: "POST", url: "/api/mandate/task" });

test("each POST /api/mandate/task derives a distinct valid child; latestChild follows", async () => {
  const { app, ledger, root } = await withMandate();
  const a = (await postTask(app)).json();
  const b = (await postTask(app)).json();
  expect(a.ok && b.ok).toBe(true);
  expect(a.cap_hash).not.toBe(b.cap_hash);
  expect(ledger.latestChild()).toBe(b.cap_hash);
  const child = ledger.getCapability(b.cap_hash) as ChildCapability;
  expect(child.parent).toBe(capabilityHash(root));
  expect(child.max_payments).toBe(1);
  expect(child.recurring).toBe(false);
  expect(Date.parse(child.expires_at)).toBeLessThanOrEqual(Date.parse(root.expires_at));
  expect(ledger.holderOf(b.cap_hash)).toBeDefined();
});

test("regression: the first task child lasts as long as the mandate, so a later task deadline still fits", async () => {
  const { app, ledger, root } = await withMandate();
  const a = (await postTask(app)).json();
  const child = ledger.getCapability(a.cap_hash) as ChildCapability;
  expect(Date.parse(child.expires_at)).toBe(Date.parse(root.expires_at));
});

test("task child is blocked with the catalogue code once the root budget is used up", async () => {
  const { app, ledger, root } = await withMandate();
  const rh = capabilityHash(root);
  for (const [i, amt] of [200n, 200n, 100n].entries()) {
    const c = (await postTask(app)).json();
    ledger.reserve({
      capHash: c.cap_hash,
      taskId: `task_${i}`,
      paymentHash: String(i).repeat(64),
      amount: amt,
      now: k.NOW,
    });
  }
  expect(ledger.remaining(rh)).toBe(0n);
  const r = await postTask(app);
  expect(r.statusCode).toBe(422);
  expect(r.json().ok).toBe(false);
  expect(r.json().code).toBe("AMOUNT_EXCEEDS_REMAINING");
  expect(BLOCK_CODES).toContain(r.json().code);
});

// A task permission is capped by what the task costs and by what the mandate has left, never by the mandate's ceiling.
test("regression: root 5.00 with 1.20 committed, a 1.20 task gets a 1.20 child (not the 5.00 ceiling)", async () => {
  const s = await setup();
  const root = await signedRoot(s.principal, { max_total: "5.00", max_per_task: "5.00" });
  expect((await postMandate(s.app, root)).statusCode).toBe(200);
  const first = (await postTask(s.app)).json();
  s.ledger.reserve({
    capHash: first.cap_hash,
    taskId: "task_0",
    paymentHash: "0".repeat(64),
    amount: 120n,
    now: k.NOW,
  });
  expect(s.ledger.remaining(capabilityHash(root))).toBe(380n);
  const r = await s.app.inject({
    method: "POST",
    url: "/api/mandate/task",
    payload: { amount: "1.20" },
  });
  expect(r.statusCode).toBe(200);
  const child = s.ledger.getCapability(r.json().cap_hash) as ChildCapability;
  expect(child.max_total).toBe("1.20");
  // Without an amount the child is capped at what is left, so it can always be derived while budget remains.
  const open = (await postTask(s.app)).json();
  expect((s.ledger.getCapability(open.cap_hash) as ChildCapability).max_total).toBe("3.80");
});

test("a task amount above the remaining budget is blocked with the catalogue code", async () => {
  const s = await setup();
  const root = await signedRoot(s.principal, { max_total: "5.00", max_per_task: "5.00" });
  await postMandate(s.app, root);
  const r = await s.app.inject({
    method: "POST",
    url: "/api/mandate/task",
    payload: { amount: "6.00" },
  });
  expect(r.statusCode).toBe(422);
  expect(["AMOUNT_EXCEEDS_REMAINING", "AMOUNT_EXCEEDS_PER_TASK"]).toContain(r.json().code);
});

test("task child needs a registered root", async () => {
  const { app } = await setup();
  expect((await postTask(app)).statusCode).toBe(409);
});

test("registering a mandate announces BUDGET_UPDATED for the root and the child", async () => {
  const { bus, root } = await withMandate();
  const ids = bus
    .replay()
    .filter((e) => e.type === "BUDGET_UPDATED")
    .map((e) => (e.data as { cap_id: string }).cap_id);
  expect(ids).toContain(root.cap_id);
  expect(ids.length).toBeGreaterThanOrEqual(2);
});
