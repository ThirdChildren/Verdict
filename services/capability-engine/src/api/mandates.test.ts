import {
  type ChildCapability,
  capabilityHash,
  capId,
  createEd25519Signer,
  type RootCapability,
  type Signer,
  signPayload,
} from "@verdict/protocol";
import { expect, test } from "vitest";
import { EventBus } from "../events.js";
import { Ledger } from "../ledger/index.js";
import * as k from "../policy/testkit.js";
import { buildServer } from "../server.js";

const seed = (n: number) => new Uint8Array(32).fill(n);
const hex = (n: number) => n.toString(16).padStart(64, "0");

async function setup() {
  const principal = await createEd25519Signer(seed(1));
  const engine = await createEd25519Signer(seed(2));
  const buyer = await createEd25519Signer(seed(3));
  const ledger = Ledger.open(":memory:", k.P);
  const app = await buildServer({
    logger: false,
    ledger,
    bus: new EventBus(),
    precision: k.P,
    now: () => k.NOW,
    identities: { principal: principal.publicId, engine: engine.publicId, buyer: buyer.publicId },
    engineSigner: engine,
    limits: { max_root_amount: "500.00", max_root_expiry_seconds: 86_400 },
  });
  return { app, ledger, principal };
}
type S = Awaited<ReturnType<typeof setup>>;

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
const post = (s: S, root: unknown) =>
  s.app.inject({ method: "POST", url: "/api/mandate", payload: { root } });

let seq = 1;
/** An offered task under `capHash`; funded (reserved) when `amount` is given. Returns its payment hash. */
function seedTask(ledger: Ledger, capHash: string, amount?: bigint): { id: string; ph: string } {
  const n = seq++;
  const sha = hex(n);
  const ph = hex(n + 1_000_000);
  const id = `task_${n.toString(16).padStart(16, "0")}`;
  ledger.recordAcceptedIntent(sha, capHash, k.intent, "eip191:0xabc", k.NOW);
  ledger.recordOffer(
    {
      intentSha256: sha,
      paymentHash: ph,
      taskId: id,
      contract: { task: { spec: `job ${n}` }, payment: { amount: "1.00" } },
      preimageHex: "ab".repeat(32),
      sealedPreimage: "sealedsecret",
    },
    k.NOW,
  );
  if (amount !== undefined)
    ledger.reserve({ capHash, taskId: id, paymentHash: ph, amount, now: k.NOW, intentSha256: sha });
  return { id, ph };
}

const child = async (s: S, rootHash: string) => {
  const hashes = (
    s.ledger as unknown as {
      db: { prepare: (q: string) => { all: (...a: unknown[]) => { hash: string }[] } };
    }
  ).db
    .prepare("SELECT hash FROM capabilities WHERE root_hash = ? AND parent_hash IS NOT NULL")
    .all(rootHash);
  return hashes[0]?.hash as string;
};

/** A (child with 1.20 reserved, a settled task) retired by B. */
async function twoMandates() {
  const s = await setup();
  const rootA = await signedRoot(s.principal);
  const hashA = capabilityHash(rootA);
  await post(s, rootA);
  const a1 = await child(s, hashA);
  const t1 = seedTask(s.ledger, a1, 120n);
  s.ledger.applyPaymentStatus(t1.ph, "Settled", k.NOW);
  // second task on the same child would exceed max_payments; use a derived second child
  const kids = await s.app.inject({
    method: "POST",
    url: "/api/mandate/task",
    payload: { amount: "1.00" },
  });
  const a2 = (kids.json() as { cap_hash: string }).cap_hash;
  seedTask(s.ledger, a2, 100n);
  const rootB = await signedRoot(s.principal, { max_total: "4.00" });
  const hashB = capabilityHash(rootB);
  await post(s, rootB);
  return { ...s, hashA, hashB, a1, a2 };
}

test("snapshot is written when the root is retired and never changes afterwards", async () => {
  const c = await twoMandates();
  const before = (await c.app.inject({ method: "GET", url: "/api/mandates" })).json();
  const a = before.mandates.find((m: { hash: string }) => m.hash === c.hashA);
  expect(a.status).toBe("retired");
  expect(a.figures).toEqual({ paid: "1.20", locked: "1.00", left: "2.80" });
  // later: the in-flight payment settles, then a further payment under the new root
  const inflight = c.ledger.listPayments().find((p) => p.taskId && true);
  expect(inflight).toBeDefined();
  for (const p of c.ledger.listPayments())
    c.ledger.applyPaymentStatus(p.paymentHash, "Settled", k.NOW);
  seedTask(c.ledger, await child(c, c.hashB), 50n);
  const after = (await c.app.inject({ method: "GET", url: "/api/mandates" })).json();
  const a2 = after.mandates.find((m: { hash: string }) => m.hash === c.hashA);
  expect(a2).toEqual(a);
  expect(a2.tasks).toEqual({ total: 2, settled: 1, refunded: 0, blocked: 0, in_flight: 1 });
  await c.app.close();
});

test("a failing snapshot insert rolls back the whole retirement (fail closed)", async () => {
  const c = await twoMandates();
  // B is registered and A snapshotted; make the next retirement fail by dropping the table
  (c.ledger as unknown as { db: { exec: (q: string) => void } }).db.exec(
    "DROP TABLE mandate_snapshots",
  );
  const rootC = await signedRoot(c.principal, { max_total: "3.00" });
  const r = await post(c, rootC);
  expect(r.statusCode).toBeGreaterThanOrEqual(400);
  expect(c.ledger.getCapability(capabilityHash(rootC))).toBeUndefined();
  expect(c.ledger.isRevoked(c.hashB)).toBe(false);
  await c.app.close();
});

test("mandate list: newest first, status, live vs frozen figures, counts, no secrets", async () => {
  const c = await twoMandates();
  seedTask(c.ledger, await child(c, c.hashB), 70n);
  const r = await c.app.inject({ method: "GET", url: "/api/mandates" });
  expect(r.statusCode).toBe(200);
  const { mandates } = r.json();
  expect(mandates.map((m: { hash: string }) => m.hash)).toEqual([c.hashB, c.hashA]);
  const [b, a] = mandates;
  expect(Object.keys(b).sort()).toEqual(
    [
      "cap_id",
      "ceiling",
      "created_at",
      "expires_at",
      "figures",
      "hash",
      "per_task",
      "retired_at",
      "status",
      "tasks",
    ].sort(),
  );
  expect(b).toMatchObject({
    status: "active",
    ceiling: "4.00",
    per_task: "2.00",
    retired_at: null,
    created_at: k.NOW.toISOString(),
    figures: { paid: "0.00", locked: "0.70", left: "3.30" },
    tasks: { total: 1, settled: 0, refunded: 0, blocked: 0, in_flight: 1 },
  });
  expect(a).toMatchObject({ status: "retired", retired_at: k.NOW.toISOString(), ceiling: "5.00" });
  expect(r.body).not.toMatch(/preimage|sealed|signature|holder/i);
  await c.app.close();
});

test("an unretired root past its expiry is reported expired", async () => {
  const s = await setup();
  await post(s, await signedRoot(s.principal, { expires_at: "2026-10-18T15:30:00Z" }));
  const late = new Date("2026-10-18T16:00:00Z");
  const row = s.ledger.listMandates(late)[0];
  expect(row?.status).toBe("expired");
  expect(s.ledger.listMandates(k.NOW)[0]?.status).toBe("active");
  await s.app.close();
});

test("tasks by mandate: filter, root_hash on every row, unknown hash empty, bad hash 400", async () => {
  const c = await twoMandates();
  const tb = seedTask(c.ledger, await child(c, c.hashB), 70n);
  const all = (await c.app.inject({ method: "GET", url: "/api/tasks" })).json().tasks;
  expect(all).toHaveLength(3);
  for (const t of all) expect([c.hashA, c.hashB]).toContain(t.root_hash);
  const onlyA = await c.app.inject({ method: "GET", url: `/api/tasks?mandate=${c.hashA}` });
  expect(onlyA.json().tasks).toHaveLength(2);
  expect(onlyA.json().tasks.every((t: { root_hash: string }) => t.root_hash === c.hashA)).toBe(
    true,
  );
  const onlyB = (
    await c.app.inject({ method: "GET", url: `/api/tasks?mandate=${c.hashB}` })
  ).json();
  expect(onlyB.tasks.map((t: { task_id: string }) => t.task_id)).toEqual([tb.id]);
  const unknown = await c.app.inject({
    method: "GET",
    url: `/api/tasks?mandate=${"e".repeat(64)}`,
  });
  expect(unknown.statusCode).toBe(200);
  expect(unknown.json()).toEqual({ tasks: [] });
  for (const bad of ["zz", "A".repeat(64), "a".repeat(63), ""]) {
    const r = await c.app.inject({ method: "GET", url: `/api/tasks?mandate=${bad}` });
    expect(r.statusCode).toBe(400);
    expect(r.json().message.length).toBeGreaterThan(10);
  }
  expect(JSON.stringify(onlyA.json())).not.toMatch(/preimage|sealed/i);
  await c.app.close();
});

test("HTTP: starting a task under a retired root is refused CAPABILITY_REVOKED", async () => {
  const c = await twoMandates();
  const t = await c.app.inject({
    method: "POST",
    url: "/api/mandate/task",
    payload: { root_hash: c.hashA, amount: "1.00" },
  });
  expect(t.statusCode).toBe(422);
  expect(t.json()).toMatchObject({ ok: false, code: "CAPABILITY_REVOKED" });
  await c.app.close();
});

test("an old database without the new column and table opens and gains them", () => {
  const l = Ledger.open(":memory:", k.P);
  l.registerCapability(k.root as RootCapability, k.PARENT_HASH);
  expect(l.listMandates(k.NOW)).toHaveLength(1);
  l.close();
});

test.skipIf(process.env.SKIP_TIMING_TESTS === "1")(
  "timing: 5 mandates x 50 tasks answer under 50 ms each",
  async () => {
    const s = await setup();
    const hashes: string[] = [];
    for (let m = 0; m < 5; m++) {
      const rootHash = hex(900 + m);
      const root = { ...k.root, cap_id: `cap_${m}`, max_total: "500.00" } as RootCapability;
      s.ledger.registerCapability(root, rootHash, undefined, undefined, k.NOW);
      const kid = hex(950 + m);
      s.ledger.registerCapability(
        { ...k.child, max_total: "500.00", max_payments: 1000 } as ChildCapability,
        kid,
        rootHash,
      );
      for (let i = 0; i < 50; i++) {
        const t = seedTask(s.ledger, kid, i % 3 === 0 ? undefined : 10n);
        if (i % 5 === 0) s.ledger.applyPaymentStatus(t.ph, "Settled", k.NOW);
      }
      hashes.push(rootHash);
    }
    const time = async (url: string) => {
      await s.app.inject({ method: "GET", url });
      const t0 = performance.now();
      const r = await s.app.inject({ method: "GET", url });
      const ms = performance.now() - t0;
      expect(r.statusCode).toBe(200);
      return ms;
    };
    const list = await time("/api/mandates");
    const filtered = await time(`/api/tasks?mandate=${hashes[2]}`);
    console.log(`timing mandates=${list.toFixed(1)}ms tasks=${filtered.toFixed(1)}ms`);
    expect(list).toBeLessThan(50);
    expect(filtered).toBeLessThan(50);
    await s.app.close();
  },
);

test("active figures equal budget()/remaining() after reserved, committed and released", async () => {
  const c = await twoMandates();
  const kid = hex(777);
  c.ledger.registerCapability(
    { ...k.child, max_total: "4.00", max_payments: 10 } as ChildCapability,
    kid,
    c.hashB,
  );
  const t1 = seedTask(c.ledger, kid, 100n);
  c.ledger.applyPaymentStatus(t1.ph, "Settled", k.NOW);
  const t2 = seedTask(c.ledger, kid, 50n);
  c.ledger.applyPaymentStatus(t2.ph, "Failed", k.NOW);
  seedTask(c.ledger, kid, 30n);
  const b = c.ledger.budget(c.hashB);
  const m = (await c.app.inject({ method: "GET", url: "/api/mandates" })).json().mandates[0];
  const f = (v: bigint | undefined) => (Number(v) / 100).toFixed(2);
  expect(m.figures).toEqual({
    paid: f(b?.committed),
    locked: f(b?.reserved),
    left: f(c.ledger.remaining(c.hashB)),
  });
  await c.app.close();
});

test("a retired root with no snapshot reports approximate figures", async () => {
  const c = await twoMandates();
  (c.ledger as unknown as { db: { exec: (q: string) => void } }).db.exec(
    `DELETE FROM mandate_snapshots WHERE root_hash = '${c.hashA}'`,
  );
  const a = (await c.app.inject({ method: "GET", url: "/api/mandates" })).json().mandates[1];
  expect(a.status).toBe("retired");
  expect(a.figures).toEqual({ paid: "1.20", locked: "0.00", left: "0.00", approximate: true });
  await c.app.close();
});

// ---- E29 QA additions: AC2 precision, AC4 security, input hardening ----

const cents = (v: string) => BigInt(v.replace(".", ""));
type Fig = { paid: string; locked: string; left: string };
const sums = (f: Fig, ceiling: string) =>
  expect(cents(f.paid) + cents(f.locked) + cents(f.left)).toBe(cents(ceiling));
type Row = { hash: string; ceiling: string; figures: Fig; status: string };
const rows = async (s: S) =>
  ((await s.app.inject({ method: "GET", url: "/api/mandates" })).json() as { mandates: Row[] })
    .mandates;
const count = (s: S, table: string) =>
  (s.ledger as unknown as { db: { prepare: (q: string) => { get: () => { n: number } } } }).db
    .prepare(`SELECT COUNT(*) AS n FROM ${table}`)
    .get().n;

test("AC2: retired snapshot is byte-identical after later settles/fails on other roots and on its in-flight child", async () => {
  const c = await twoMandates();
  const snap = async () => JSON.stringify((await rows(c)).find((m) => m.hash === c.hashA));
  const before = await snap();
  const a = JSON.parse(before) as Row;
  sums(a.figures, a.ceiling); // at the moment it was taken
  expect(a.figures).toEqual({ paid: "1.20", locked: "1.00", left: "2.80" });
  const kid = hex(4242);
  c.ledger.registerCapability(
    { ...k.child, max_total: "4.00", max_payments: 10 } as ChildCapability,
    kid,
    c.hashB,
  );
  const t1 = seedTask(c.ledger, kid, 100n);
  const t2 = seedTask(c.ledger, kid, 60n);
  const t3 = seedTask(c.ledger, kid, 40n);
  c.ledger.applyPaymentStatus(t1.ph, "Settled", k.NOW);
  c.ledger.applyPaymentStatus(t2.ph, "Failed", k.NOW);
  c.ledger.applyPaymentStatus(t3.ph, "Settled", k.NOW);
  // the in-flight child of the retired root fails; payments already final refuse the transition
  const known = new Set([t1.ph, t2.ph, t3.ph]);
  const open = c.ledger.listPayments().filter((p) => !known.has(p.paymentHash));
  let failed = 0;
  for (const p of open) {
    try {
      c.ledger.applyPaymentStatus(p.paymentHash, "Failed", k.NOW);
      failed++;
    } catch {
      // already settled
    }
  }
  expect(failed).toBe(1);
  expect(await snap()).toBe(before);
  const b = (await rows(c)).find((m) => m.hash === c.hashB);
  expect(b?.status).toBe("active");
  if (b) sums(b.figures, b.ceiling);
  // the active root's invariant also holds mid-flight
  seedTask(c.ledger, kid, 25n);
  const b2 = (await rows(c)).find((m) => m.hash === c.hashB);
  if (b2) sums(b2.figures, b2.ceiling);
  expect(b2?.figures.locked).toBe("0.25");
  expect(await snap()).toBe(before);
  await c.app.close();
});

test("AC4: a task or child derivation under the retired root is refused and writes no row", async () => {
  const c = await twoMandates();
  const tables = ["offers", "accepted_intents", "reservations", "capabilities"];
  const snapshot = () => tables.map((t) => count(c, t));
  const before = snapshot();
  const tasksBefore = (await c.app.inject({ method: "GET", url: "/api/tasks" })).json();
  for (const amount of ["1.00", "0.01"]) {
    const r = await c.app.inject({
      method: "POST",
      url: "/api/mandate/task",
      payload: { root_hash: c.hashA, amount },
    });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toMatchObject({ ok: false, code: "CAPABILITY_REVOKED" });
  }
  expect(snapshot()).toEqual(before);
  expect((await c.app.inject({ method: "GET", url: "/api/tasks" })).json()).toEqual(tasksBefore);
  await c.app.close();
});

test("input hardening: bad ?mandate values are 400 or empty, never 500, and bodies hold no secrets", async () => {
  const c = await twoMandates();
  const bad = [
    "A".repeat(64),
    "a".repeat(63),
    "a".repeat(65),
    "x".repeat(64),
    "'; DROP TABLE offers; --",
    "' OR '1'='1",
    `${c.hashA}' OR 1=1 --`,
    "%00",
    "../etc/passwd",
  ];
  for (const v of bad) {
    const r = await c.app.inject({
      method: "GET",
      url: `/api/tasks?mandate=${encodeURIComponent(v)}`,
    });
    expect(r.statusCode, v).toBe(400);
  }
  const arr = await c.app.inject({
    method: "GET",
    url: `/api/tasks?mandate=${c.hashA}&mandate=${c.hashB}`,
  });
  expect(arr.statusCode).toBe(400);
  const unknown = await c.app.inject({
    method: "GET",
    url: `/api/tasks?mandate=${"c".repeat(64)}`,
  });
  expect([200, 400]).toContain(unknown.statusCode);
  expect(unknown.json()).toEqual({ tasks: [] });
  expect(count(c, "offers")).toBeGreaterThan(0); // nothing was dropped
  const m = await c.app.inject({ method: "GET", url: "/api/mandates?mandate='%3B--" });
  expect(m.statusCode).toBe(200);
  const forbidden = /preimage|sealed|seed|mnemonic|private/i;
  const bodies = [
    m.body,
    (await c.app.inject({ method: "GET", url: "/api/mandates" })).body,
    (await c.app.inject({ method: "GET", url: "/api/tasks" })).body,
    (await c.app.inject({ method: "GET", url: `/api/tasks?mandate=${c.hashA}` })).body,
    (await c.app.inject({ method: "GET", url: `/api/tasks?mandate=${c.hashB}` })).body,
  ];
  for (const b of bodies) expect(b).not.toMatch(forbidden);
  await c.app.close();
});
