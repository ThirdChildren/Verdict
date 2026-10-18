import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEd25519Signer } from "@verdict/protocol";
import { dirHashFromDisk } from "@verdict/protocol/node";
import { expect, test } from "vitest";
import { Catalogue, DEFAULT_PACKAGES_ROOT, loadCatalogue, scanCatalogue } from "../catalogue.js";
import { EventBus } from "../events.js";
import { Ledger } from "../ledger/index.js";
import * as k from "../policy/testkit.js";
import { buildServer } from "../server.js";

// Read-only use of the verifier's own validator; a variable path keeps it outside this project's tsc rootDir.
const VERIFIER_MANIFEST = "../../../verifier/src/manifest.js";
const { parseManifest, sha256OfFile, judgeAllowList, GENERIC_JUDGE_PATH } = (await import(
  /* @vite-ignore */ VERIFIER_MANIFEST
)) as {
  parseManifest: (raw: unknown) => {
    ok: boolean;
    format?: number;
    manifest?: { judge_sha256: string };
  };
  sha256OfFile: (p: string) => string;
  judgeAllowList: () => Set<string>;
  GENERIC_JUDGE_PATH: string;
};

const draft = (over: Record<string, unknown> = {}) => ({
  feasibility: "cli",
  reason: "A program can read two numbers and print their sum.",
  title: "Sum two numbers",
  description: "Read a text file with two integers on one line and print their sum.",
  entry: "sum-numbers.mjs",
  input_ext: ".txt",
  visible: [
    { input: "1 2\n", expected: "3\n" },
    { input: "10 5\n", expected: "15\n" },
    { input: "0 0\n", expected: "0\n" },
  ],
  hidden: [
    { input: "7 8\n", expected: "15\n" },
    { input: "-3 3\n", expected: "0\n" },
    { input: "100 250\n", expected: "350\n" },
    { input: "999 1\n", expected: "1000\n" },
    { input: "-5 -6\n", expected: "-11\n" },
  ],
  assertions: { max_output_bytes: 64 },
  ...over,
});

async function setup(opts: { list?: boolean; wait?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "custom-"));
  const engine = await createEd25519Signer(new Uint8Array(32).fill(2));
  const catalogue = new Catalogue(await loadCatalogue(root));
  const bus = new EventBus();
  const verifierFetch = (async () => {
    const hashes =
      opts.list === false ? [] : (await scanCatalogue(root, () => {})).entries.map((e) => e.hash);
    return new Response(JSON.stringify(hashes));
  }) as unknown as typeof fetch;
  const app = await buildServer({
    logger: false,
    ledger: Ledger.open(":memory:", k.P),
    bus,
    catalogue,
    packagesRoot: root,
    verifierUrl: "http://127.0.0.1:7402",
    verifierFetch,
    verifierWaitMs: opts.wait ?? 300,
    mandateRateLimit: { max: 1000, windowMs: 60_000 },
    identities: { principal: engine.publicId, engine: engine.publicId, buyer: engine.publicId },
    engineSigner: engine,
  });
  const post = (d: unknown) =>
    app.inject({ method: "POST", url: "/api/task-types", payload: { draft: d } });
  return { app, root, bus, post };
}

test("installs a custom package and lists it", async () => {
  const s = await setup();
  const events: unknown[] = [];
  s.bus.subscribe((e) => events.push(e));
  const r = await s.post(draft());
  expect(r.statusCode).toBe(200);
  const j = r.json() as { ok: boolean; id: string; package_sha256: string; title: string };
  expect(j).toMatchObject({ ok: true, title: "Sum two numbers" });
  expect(j.id).toMatch(/^custom-sum-two-numbers-[0-9a-f]{8}$/);
  expect(JSON.parse(readFileSync(join(s.root, j.id, "manifest.json"), "utf8")).id).toBe(j.id);
  const dir = join(s.root, j.id);
  expect(readdirSync(dir).sort()).toEqual(
    [
      "README.md",
      "cases",
      "execute.mjs",
      "manifest.json",
      "spec",
      "verify.mjs",
      "verify.sh",
      "visible",
    ].sort(),
  );
  expect(readdirSync(join(dir, "cases")).length).toBe(10);
  expect(readdirSync(join(dir, "visible")).length).toBe(6);
  expect(readFileSync(join(dir, "README.md"), "utf8").split("\n")[0]).toBe("# Sum two numbers");
  expect(readFileSync(join(dir, "verify.mjs"))).toEqual(readFileSync(GENERIC_JUDGE_PATH));
  expect(await dirHashFromDisk(dir)).toBe(j.package_sha256);
  expect(readdirSync(s.root).filter((n) => n.startsWith("."))).toEqual([]);

  const p = parseManifest(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")));
  expect(p.ok && p.format === 2).toBe(true);
  if (p.ok && p.format === 2 && p.manifest) {
    expect(judgeAllowList().has(p.manifest.judge_sha256)).toBe(true);
    expect(p.manifest.judge_sha256).toBe(sha256OfFile(GENERIC_JUDGE_PATH));
  }
  const list = (await s.app.inject({ method: "GET", url: "/api/task-types" })).json() as {
    types: { id: string; title: string }[];
  };
  expect(list.types).toContainEqual(
    expect.objectContaining({ id: j.id, title: "Sum two numbers" }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "TASK_TYPE_ADDED",
      data: { id: j.id, title: "Sum two numbers", package_sha256: j.package_sha256 },
    }),
  );
  // a rescan after restart gives the same id
  const again = (await scanCatalogue(s.root, () => {})).entries;
  expect(again.map((e) => e.id)).toEqual([j.id]);
});

test("the directory hash is stable: same draft, same day, same hash; installing again is a no-op", async () => {
  const a = await setup();
  const b = await setup();
  const ja = (await a.post(draft())).json() as { id: string };
  const jb = (await b.post(draft())).json() as { id: string };
  expect(ja.id).toBe(jb.id);
  const again = await a.post(draft());
  expect(again.statusCode).toBe(200);
  expect((again.json() as { id: string }).id).toBe(ja.id);
});

test("the installed package's judge equals the repository's allow-listed judge", () => {
  expect(existsSync(join(DEFAULT_PACKAGES_ROOT, "_judge", "verify.mjs"))).toBe(true);
});

const big = "x".repeat(2049);
const weak: [string, unknown][] = [
  [
    "duplicate inputs",
    draft({ hidden: [...draft().hidden.slice(0, 4), { input: "1 2\n", expected: "9\n" }] }),
  ],
  ["constant outputs", draft({ hidden: draft().hidden.map((p) => ({ ...p, expected: "0\n" })) })],
  ["four hidden cases", draft({ hidden: draft().hidden.slice(0, 4) })],
  ["unknown assertion key", draft({ assertions: { sneaky: true } })],
  ["extra field", draft({ files: { "evil.sh": "rm -rf" } })],
  ["bad entry name", draft({ entry: "../x.mjs" })],
  [
    "cat (output equals input)",
    draft({ hidden: draft().hidden.map((p, i) => ({ ...p, expected: i < 4 ? p.input : "9" })) }),
  ],
  [
    "inputs equal after trimming",
    draft({
      hidden: [{ input: "  7 8 \r\n", expected: "15\n" }, ...draft().hidden.slice(1)],
      visible: [{ input: "7 8", expected: "15" }, ...draft().visible.slice(1)],
    }),
  ],
  [
    "outputs equal after trimming",
    draft({ hidden: draft().hidden.map((p, i) => ({ ...p, expected: i % 2 ? " 0 \r\n" : "0" })) }),
  ],
  ["bad extension", draft({ input_ext: "txt" })],
  ["unlisted extension", draft({ input_ext: ".xml" })],
  ["schema field", draft({ schema: {} })],
  ["long title", draft({ title: "t".repeat(61) })],
  [
    "empty expected",
    draft({ visible: [{ input: "a", expected: "" }, ...draft().visible.slice(1)] }),
  ],
  ["feasibility none", draft({ feasibility: "none" })],
  [
    "oversize cell",
    draft({
      hidden: Array.from({ length: 8 }, (_, i) => ({
        input: `${i}${big}`,
        expected: `${i}${big}`,
      })),
      visible: Array.from({ length: 3 }, (_, i) => ({
        input: `v${i}${big}`,
        expected: `v${i}${big}`,
      })),
    }),
  ],
];
test("refuses a weak or malformed draft", async () => {
  const s = await setup();
  for (const [name, d] of weak) {
    const r = await s.post(d);
    expect(r.statusCode, name).toBe(422);
    const j = r.json() as { code: string; message: string };
    expect(j.code, name).toBe("DRAFT_REJECTED");
    expect(j.message.length, name).toBeGreaterThan(10);
  }
  expect(readdirSync(s.root)).toEqual([]);
  expect(
    (await s.app.inject({ method: "POST", url: "/api/task-types", payload: {} })).statusCode,
  ).toBe(422);
});

test("removes the package the verifier cannot run", async () => {
  const s = await setup({ list: false, wait: 400 });
  const r = await s.post(draft());
  expect(r.statusCode).toBe(503);
  expect(r.json()).toMatchObject({ ok: false, code: "VERIFIER_PACKAGE_UNAVAILABLE" });
  expect(readdirSync(s.root)).toEqual([]);
  const list = (await s.app.inject({ method: "GET", url: "/api/task-types" })).json() as {
    types: unknown[];
  };
  expect(list.types).toEqual([]);
});

test("a .json input gives .out.json outputs; .csv gives .out.txt", async () => {
  const s = await setup();
  const r1 = await s.post(draft({ input_ext: ".json", entry: "json-sum.mjs" }));
  expect(r1.json()).toMatchObject({ ok: true });
  const j = r1.json() as { id: string };
  const m = JSON.parse(readFileSync(join(s.root, j.id, "manifest.json"), "utf8"));
  expect(m.output_ext).toBe(".out.json");
  const c = (await s.post(draft({ input_ext: ".csv", title: "Csv thing" }))).json() as {
    id: string;
  };
  expect(JSON.parse(readFileSync(join(s.root, c.id, "manifest.json"), "utf8")).output_ext).toBe(
    ".out.txt",
  );
});

test("two drafts with the same title get different ids and both install", async () => {
  const s = await setup();
  const a = (await s.post(draft())).json() as { id: string };
  const b = (
    await s.post(
      draft({ description: "Another way to say it, different cases.", entry: "other-sum.mjs" }),
    )
  ).json() as { id: string };
  expect(a.id).not.toBe(b.id);
  const ids = (await scanCatalogue(s.root, () => {})).entries.map((e) => e.id);
  expect(ids.sort()).toEqual([a.id, b.id].sort());
});

test("concurrent identical installs both succeed with one directory", async () => {
  const s = await setup();
  const [x, y] = await Promise.all([s.post(draft()), s.post(draft())]);
  expect(x.statusCode).toBe(200);
  expect(y.statusCode).toBe(200);
  expect(readdirSync(s.root).length).toBe(1);
});

test("a package the verifier lists as usable:false is not adopted", async () => {
  const s = await setup();
  const app = await buildServer({
    logger: false,
    catalogue: new Catalogue([]),
    packagesRoot: s.root,
    verifierUrl: "http://127.0.0.1:7402",
    verifierWaitMs: 300,
    verifierFetch: (async () => {
      const hs = (await scanCatalogue(s.root, () => {})).entries.map((e) => ({
        package_sha256: e.hash,
        usable: false,
      }));
      return new Response(JSON.stringify(hs));
    }) as unknown as typeof fetch,
  });
  const r = await app.inject({
    method: "POST",
    url: "/api/task-types",
    payload: { draft: draft() },
  });
  expect(r.statusCode).toBe(503);
  expect(readdirSync(s.root)).toEqual([]);
});
