import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEd25519Signer, offeredContractSchema, spendIntentSchema } from "@verdict/protocol";
import { dirHashFromDisk } from "@verdict/protocol/node";
import { describe, expect, test } from "vitest";
import {
  Catalogue,
  intersectWithVerifier,
  loadCatalogue,
  resolveTitle,
  scanCatalogue,
} from "./catalogue.js";
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
    title: "Convert a CSV file into a JSON array of objects",
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

test("skips with a warning: bad manifest and symlinked directory; counts scanned", async () => {
  const root = mkRoot();
  mkdirSync(join(root, "broken"));
  writeFileSync(join(root, "broken", "manifest.json"), "{nope");
  symlinkSync(join(root, "csv2json-v1"), join(root, "linked"));
  const warns: string[] = [];
  const r = await scanCatalogue(root, (m) => warns.push(m));
  expect(r.entries.map((e) => e.id)).toEqual(["csv2json-v1", "json-normalise-v1"]);
  expect(r.scanned).toBe(4);
  expect(warns.some((w) => w.includes("broken"))).toBe(true);
  expect(warns.some((w) => w.includes("linked"))).toBe(true);
});

test("single-entry default only when the root holds exactly one package directory", async () => {
  const one = mkdtempSync(join(tmpdir(), "pkgs-"));
  mkdirSync(join(one, "a"));
  writeFileSync(join(one, "a", "manifest.json"), "{}");
  const r1 = await scanCatalogue(one);
  expect(new Catalogue(r1.entries, r1.scanned).defaultEntry?.id).toBe("a");
  mkdirSync(join(one, "b"));
  writeFileSync(join(one, "b", "manifest.json"), "{bad");
  const r2 = await scanCatalogue(one, () => {});
  expect(r2.entries).toHaveLength(1);
  expect(new Catalogue(r2.entries, r2.scanned).defaultEntry).toBeUndefined();
});

test("duplicate ids are rejected at load", async () => {
  const root = mkdtempSync(join(tmpdir(), "pkgs-"));
  for (const n of ["x", "y"]) {
    mkdirSync(join(root, n));
    writeFileSync(join(root, n, "manifest.json"), JSON.stringify({ id: "same" }));
  }
  await expect(scanCatalogue(root)).rejects.toThrow(/same/);
});

test("a failed startup intersection is retried at the first offer", async () => {
  const es = await loadCatalogue(mkRoot());
  const only = es.slice(1);
  let calls = 0;
  const cat = new Catalogue(es, 2, async () => (++calls === 1 ? null : only));
  await cat.ensureVerified();
  expect(cat.entries).toHaveLength(2);
  await cat.ensureVerified();
  expect(cat.entries.map((e) => e.id)).toEqual(["json-normalise-v1"]);
  await cat.ensureVerified();
  expect(calls).toBe(2);
});

describe("catalogue root and verifier probe", () => {
  test("default root is the repository verifier-packages whatever the cwd", async () => {
    const { packagesRoot } = await import("./catalogue.js");
    const { mkdtempSync, realpathSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join, resolve } = await import("node:path");
    const before = process.cwd();
    const expected = resolve(before, "../..", "verifier-packages");
    const a = packagesRoot({});
    process.chdir(realpathSync(mkdtempSync(join(tmpdir(), "cwd-"))));
    try {
      expect(packagesRoot({})).toBe(a);
      expect(a.endsWith("/verifier-packages")).toBe(true);
      expect(a).toBe(resolve(a));
      if (before.endsWith("capability-engine")) expect(a).toBe(expected);
      expect(packagesRoot({ VERIFIER_PACKAGES_ROOT: "/x/y" })).toBe("/x/y");
    } finally {
      process.chdir(before);
    }
  });

  test("an empty or missing root logs an error and yields zero types", async () => {
    const { logCatalogue } = await import("./catalogue.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const empty = mkdtempSync(join(tmpdir(), "empty-"));
    const errs: string[] = [];
    const logs: string[] = [];
    logCatalogue(
      empty,
      await loadCatalogue(empty),
      (m) => logs.push(m),
      (m) => errs.push(m),
    );
    expect(logs[0]).toBe(`catalogue: ${empty}, 0 packages: `);
    expect(errs[0]).toMatch(/ERROR.*holds no packages/);
    expect(new Catalogue(await loadCatalogue(empty)).view()).toEqual([]);
    const missing = join(empty, "nope");
    logCatalogue(
      missing,
      [],
      () => {},
      (m) => errs.push(m),
    );
    expect(errs[1]).toMatch(/does not exist/);
  });

  test("probe: reachable, unreachable, cached for 10 s, host only", async () => {
    const { makeVerifierProbe, hostOnly } = await import("./catalogue.js");
    let calls = 0;
    let t = 0;
    const ok = (async () => {
      calls++;
      return new Response("[]");
    }) as unknown as typeof fetch;
    const p = makeVerifierProbe("http://v.test", ok, () => t);
    expect(await p()).toBe(true);
    expect(await p()).toBe(true);
    expect(calls).toBe(1);
    t = 10_001;
    await p();
    expect(calls).toBe(2);
    const down = (async () => {
      throw new Error("x");
    }) as unknown as typeof fetch;
    expect(await makeVerifierProbe("http://v.test", down)()).toBe(false);
    expect(await makeVerifierProbe(undefined)()).toBe(false);
    expect(hostOnly("http://user:pw@10.0.0.2:7402/v0?k=1")).toBe("10.0.0.2:7402");
  });
});

test("title sources: manifest, README first line, fallback map, id", () => {
  const root = mkdtempSync(join(tmpdir(), "titles-"));
  const mk = (name: string, readme?: string) => {
    mkdirSync(join(root, name));
    if (readme !== undefined) writeFileSync(join(root, name, "README.md"), readme);
    return join(root, name);
  };
  expect(resolveTitle("x", "From manifest", mk("a", "# Readme"))).toBe("From manifest");
  expect(resolveTitle("x", undefined, mk("b", "# Readme heading\n\nbody"))).toBe("Readme heading");
  expect(resolveTitle("x", undefined, mk("c", `# ${"y".repeat(90)}`))).toBe("x");
  expect(resolveTitle("csv2json-v1", undefined, mk("d", "# csv2json-v1\n"))).toBe(
    "Convert a CSV file into a JSON array of objects",
  );
  expect(resolveTitle("zzz", undefined, mk("e"))).toBe("zzz");
  expect(resolveTitle("x", "m".repeat(90), mk("f")).length).toBe(60);
});
