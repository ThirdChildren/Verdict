import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEd25519Signer, offeredContractSchema, spendIntentSchema } from "@verdict/protocol";
import { dirHashFromDisk } from "@verdict/protocol/node";
import { expect, test } from "vitest";
import { Catalogue, intersectWithVerifier, loadCatalogue } from "./catalogue.js";
import { EventBus } from "./events.js";
import { Ledger } from "./ledger/index.js";
import { OfferService } from "./offer.js";
import * as k from "./policy/testkit.js";

function mkRoot() {
  const root = mkdtempSync(join(tmpdir(), "pkgs-"));
  const pkg = (name: string, manifest: object) => {
    mkdirSync(join(root, name));
    writeFileSync(join(root, name, "manifest.json"), JSON.stringify(manifest));
  };
  pkg("csv2json-v1", { description: "CSV to JSON" }); // format 1: no id
  pkg("json-normalise-v1", { format: 2, id: "json-normalise-v1", description: "Normalise JSON" });
  pkg("_judge", { format: 2, id: "judge" });
  pkg(".hidden", { id: "x" });
  return root;
}

test("lists every package except _judge with its dir hash", async () => {
  const root = mkRoot();
  const es = await loadCatalogue(root);
  expect(es.map((e) => [e.id, e.format])).toEqual([
    ["csv2json-v1", 1],
    ["json-normalise-v1", 2],
  ]);
  expect(es[0]?.hash).toBe(await dirHashFromDisk(join(root, "csv2json-v1")));
  expect(new Catalogue(es).view()[0]).toEqual({
    id: "csv2json-v1",
    description: "CSV to JSON",
    format: 1,
    package_sha256: es[0]?.hash,
  });
});

test("keeps only hashes the verifier has; keeps all when it does not answer", async () => {
  const es = await loadCatalogue(mkRoot());
  const only = (es[1] as { hash: string }).hash;
  const f = (async () => Response.json({ packages: [{ package_sha256: only }] })) as typeof fetch;
  const r = await intersectWithVerifier(es, "http://v.test", f);
  expect(r.filtered).toBe(true);
  expect(r.entries.map((e) => e.id)).toEqual(["json-normalise-v1"]);
  const down = (async () => {
    throw new Error("down");
  }) as typeof fetch;
  const r2 = await intersectWithVerifier(es, "http://v.test", down);
  expect(r2).toMatchObject({ filtered: false });
  expect(r2.entries).toHaveLength(2);
});

async function offerSetup(cat: Catalogue | undefined, dflt: string) {
  const ver = await createEd25519Signer(new Uint8Array(32).fill(5));
  const engine = await createEd25519Signer(new Uint8Array(32).fill(2));
  const ledger = Ledger.open(":memory:", k.P);
  const fetchImpl = (async (u: string) =>
    String(u).endsWith("/v0/info")
      ? Response.json({ public_id: k.W1, node_id: `02${"c2".repeat(32)}` })
      : Response.json({ ok: true })) as unknown as typeof fetch;
  const svc = new OfferService({
    ledger,
    bus: new EventBus(),
    engineSigner: engine,
    ...(cat ? { catalogue: cat } : {}),
    verifier: { publicId: ver.publicId, endpoint: "http://v.test", packageSha256: dflt },
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
  const accept = (sha: string, capHash: string) =>
    ledger.recordAcceptedIntent(
      sha,
      capHash,
      spendIntentSchema.parse({ ...k.intent, counterparty: k.W1 }),
      k.A,
      k.NOW,
    );
  return { svc, ledger, accept };
}
const contractOf = (ledger: Ledger, sha: string) =>
  offeredContractSchema.parse(ledger.getOfferByIntent(sha)?.contract);

test("contract carries the task's package hash", async () => {
  const es = await loadCatalogue(mkRoot());
  const [a, b] = es as [(typeof es)[0], (typeof es)[0]];
  const s = await offerSetup(new Catalogue(es), a.hash);
  s.accept("1".repeat(64), "a".repeat(64));
  s.accept("2".repeat(64), "b".repeat(64));
  s.ledger.bindPackage("a".repeat(64), a.id, a.hash);
  s.ledger.bindPackage("b".repeat(64), b.id, b.hash);
  expect(await s.svc.offerFor("1".repeat(64))).toMatchObject({ ok: true });
  expect(await s.svc.offerFor("2".repeat(64))).toMatchObject({ ok: true });
  expect(contractOf(s.ledger, "1".repeat(64)).verifier.package_sha256).toBe(a.hash);
  expect(contractOf(s.ledger, "2".repeat(64)).verifier.package_sha256).toBe(b.hash);
});

test("a hash outside the catalogue is BLOCKED and nothing is signed", async () => {
  const es = await loadCatalogue(mkRoot());
  const s = await offerSetup(new Catalogue(es), (es[0] as { hash: string }).hash);
  s.accept("1".repeat(64), "a".repeat(64));
  s.ledger.bindPackage("a".repeat(64), "ghost", "9".repeat(64));
  const r = await s.svc.offerFor("1".repeat(64));
  expect(r).toMatchObject({ ok: false, code: "MALFORMED_INTENT" });
  expect(s.ledger.getOfferByIntent("1".repeat(64))).toBeUndefined();
  // unbound with two types in the catalogue: also blocked
  s.accept("2".repeat(64), "c".repeat(64));
  expect(await s.svc.offerFor("2".repeat(64))).toMatchObject({ ok: false });
  expect(s.ledger.getOfferByIntent("2".repeat(64))).toBeUndefined();
});

test("single-entry catalogue: an unbound task uses the default hash", async () => {
  const es = (await loadCatalogue(mkRoot())).slice(0, 1);
  const s = await offerSetup(new Catalogue(es), (es[0] as { hash: string }).hash);
  s.accept("1".repeat(64), "a".repeat(64));
  expect(await s.svc.offerFor("1".repeat(64))).toMatchObject({ ok: true });
  expect(contractOf(s.ledger, "1".repeat(64)).verifier.package_sha256).toBe(es[0]?.hash);
});
