import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capId,
  createEd25519Signer,
  offeredContractSchema,
  type RootCapability,
  signPayload,
  spendIntentSchema,
} from "@verdict/protocol";
import { expect, test } from "vitest";
import { Catalogue, loadCatalogue } from "./catalogue.js";
import { EventBus } from "./events.js";
import { Ledger } from "./ledger/index.js";
import { OfferService } from "./offer.js";
import * as k from "./policy/testkit.js";
import { buildServer } from "./server.js";

const seed = (n: number) => new Uint8Array(32).fill(n);

test("two tasks of two types get two hashes; untyped and unknown tasks are refused with no row written", async () => {
  const dir = mkdtempSync(join(tmpdir(), "e2e-types-"));
  for (const [n, m] of [
    ["csv2json-v1", { description: "CSV to JSON" }],
    ["json-normalise-v1", { format: 2, id: "json-normalise-v1", description: "Normalise JSON" }],
  ] as const) {
    mkdirSync(join(dir, n));
    writeFileSync(join(dir, n, "manifest.json"), JSON.stringify(m));
    writeFileSync(join(dir, n, `${n}.txt`), n); // distinct content, distinct dir hash
  }
  const catalogue = new Catalogue(await loadCatalogue(dir));
  const principal = await createEd25519Signer(seed(1));
  const engine = await createEd25519Signer(seed(2));
  const buyer = await createEd25519Signer(seed(3));
  const ver = await createEd25519Signer(seed(5));
  const ledger = Ledger.open(":memory:", k.P);
  const bus = new EventBus();
  const app = await buildServer({
    logger: false,
    ledger,
    bus,
    catalogue,
    precision: k.P,
    now: () => k.NOW,
    identities: { principal: principal.publicId, engine: engine.publicId, buyer: buyer.publicId },
    engineSigner: engine,
    limits: { max_root_amount: "500.00", max_root_expiry_seconds: 86_400 },
  });
  const base = {
    ...k.root,
    issuer: principal.publicId,
    max_total: "5.00",
    max_per_task: "2.00",
    allowed_payees: [k.W1],
    expires_at: "2026-10-18T17:00:00Z",
  } as RootCapability;
  const withId = { ...base, cap_id: capId(base) };
  const root = { ...withId, signature: await signPayload(principal, "CAP_ROOT", withId) };
  expect(
    (await app.inject({ method: "POST", url: "/api/mandate", payload: { root } })).statusCode,
  ).toBe(200);

  const task = (payload: object) =>
    app.inject({ method: "POST", url: "/api/mandate/task", payload });
  const a = (await task({ package_id: "csv2json-v1", amount: "1.00" })).json() as {
    cap_hash: string;
    package_sha256: string;
  };
  const b = (await task({ package_id: "json-normalise-v1", amount: "1.00" })).json() as {
    cap_hash: string;
    package_sha256: string;
  };
  expect(a.package_sha256).not.toBe(b.package_sha256);

  const rows = () => {
    const db = (ledger as unknown as { db: { prepare(s: string): { get(): { n: number } } } }).db;
    return ["capabilities", "task_packages"].map(
      (t) => db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n,
    );
  };
  const before = rows();
  const seen: string[] = [];
  bus.subscribe((e) => seen.push(e.type));
  for (const payload of [{ amount: "1.00" }, { package_id: "no-such-pkg", amount: "1.00" }]) {
    const r = await task(payload);
    expect(r.statusCode).toBe(422);
    expect(r.json()).toMatchObject({ ok: false, code: "TASK_NOT_VERIFIABLE" });
  }
  expect(rows()).toEqual(before);
  expect(seen).not.toContain("CAP_CHILD");

  const fetchImpl = (async (u: string) =>
    String(u).endsWith("/v0/info")
      ? Response.json({ public_id: k.W1, node_id: `02${"c2".repeat(32)}` })
      : Response.json({ ok: true })) as unknown as typeof fetch;
  const svc = new OfferService({
    ledger,
    bus,
    engineSigner: engine,
    catalogue,
    verifier: {
      publicId: ver.publicId,
      endpoint: "http://v.test",
      packageSha256: a.package_sha256,
    },
    workerUrl: "http://w.test",
    assetId: k.ASSET,
    maxLockSeconds: 28_800,
    safetyMarginSeconds: 600,
    maxVerifySeconds: 60,
    expirySeconds: 3600,
    expiryBlocks: 42,
    now: () => k.NOW,
    fetchImpl,
  });
  for (const [sha, cap] of [
    ["1".repeat(64), a.cap_hash],
    ["2".repeat(64), b.cap_hash],
  ] as const)
    ledger.recordAcceptedIntent(
      sha,
      cap,
      spendIntentSchema.parse({ ...k.intent, counterparty: k.W1 }),
      k.A,
      k.NOW,
    );
  expect(await svc.offerFor("1".repeat(64))).toMatchObject({ ok: true });
  expect(await svc.offerFor("2".repeat(64))).toMatchObject({ ok: true });
  const hashOf = (sha: string) =>
    offeredContractSchema.parse(ledger.getOfferByIntent(sha)?.contract).verifier.package_sha256;
  expect(hashOf("1".repeat(64))).toBe(a.package_sha256);
  expect(hashOf("2".repeat(64))).toBe(b.package_sha256);
  expect(hashOf("1".repeat(64))).not.toBe(hashOf("2".repeat(64)));
});
