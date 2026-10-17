// Cross-cutting properties of verifier v2 (E30): determinism end to end, judge pinning, a manifest cannot relax itself,
// csv2json-v1 untouched, and the /v0/stats arithmetic. Fakes only: no model, no network.
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirHashFromDisk } from "@verdict/protocol/node";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  GENERIC_JUDGE_PATH,
  genericJudgeSha256,
  type ManifestV2,
  parseManifest,
} from "./manifest.js";
import { Registry, type RunReport, type RunReportV2, type TaskEntry } from "./registry.js";
import { detectSandbox, runVerification } from "./runner.js";
import { buildServer, LAN_ROUTES } from "./server.js";
import type { VerifierService } from "./service.js";
import { computeStats } from "./stats.js";
import { baseManifest, makeDelivery, makeV2Package } from "./v2-fixture.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKGS = resolve(HERE, "../../../verifier-packages");
const root = mkdtempSync(join(tmpdir(), "verifier-props-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => {
  delete process.env.VERIFIER_JUDGE_ALLOW;
});
const sandboxed = detectSandbox() !== null;
let n = 0;

const run = (packageDir: string, deliveryDir: string) =>
  runVerification({ packageDir, deliveryDir, maxVerifySeconds: 60 });

describe.skipIf(!sandboxed)("invariant 8 end to end", { timeout: 120_000 }, () => {
  it("json-normalise-v1: two separate invocations (fresh package copy) give byte-identical result lines and score", async () => {
    const good = join(PKGS, "json-normalise-v1/fixtures/good-delivery");
    const copy = join(root, "jn-copy");
    cpSync(join(PKGS, "json-normalise-v1"), copy, { recursive: true });
    const a = await run(join(PKGS, "json-normalise-v1"), good);
    const b = await run(copy, good);
    expect(a.outcome).toBe("PASS");
    expect(JSON.stringify(b.checks)).toBe(JSON.stringify(a.checks));
    expect(b.score).toBe(a.score);
    expect(b.message).toBe(a.message);
  });

  it("v2 fixture package: same package + same delivery on two runs, FAIL path included", async () => {
    const id = n++;
    const pkg = makeV2Package(root, `inv8-pkg-${id}`);
    const bad = makeDelivery(root, `inv8-bad-${id}`, "process.stdout.write('{}');\n");
    const r1 = await run(pkg, bad);
    const r2 = await run(pkg, bad);
    expect(r1.outcome).toBe("FAIL");
    expect(JSON.stringify(r2.checks)).toBe(JSON.stringify(r1.checks));
    expect(r2.score).toBe(r1.score);
  });
});

describe.skipIf(!sandboxed)(
  "a judge that is not the allow-listed one",
  { timeout: 120_000 },
  () => {
    const REAL = readFileSync(GENERIC_JUDGE_PATH, "utf8");
    const LYING = `console.log(JSON.stringify({id:"fixtures",status:"pass",required:true,weight:50,ms:0}));
console.log(JSON.stringify({id:"_verdict",status:"pass",score:100,min_score:80,profile:"standard"}));\n`;
    const withJudge = (source: string, declared: string | null) => {
      const id = n++;
      const pkg = makeV2Package(root, `pin-pkg-${id}`, {
        judgeSource: source,
        mutate: (m) => {
          if (declared) m.judge_sha256 = declared;
        },
      });
      return run(pkg, makeDelivery(root, `pin-del-${id}`));
    };

    it("one appended byte, manifest still names the real judge hash: WITHHOLD PACKAGE_INVALID", async () => {
      const r = await withJudge(`${REAL} `, null);
      expect(r).toMatchObject({ outcome: "WITHHOLD", code: "PACKAGE_INVALID" });
    });

    it("one changed byte with the manifest re-pointed at the new hash is still refused (not on the allow list)", async () => {
      const tampered = `${REAL}\n`;
      const { createHash } = await import("node:crypto");
      const h = createHash("sha256").update(tampered).digest("hex");
      expect(h).not.toBe(genericJudgeSha256());
      const r = await withJudge(tampered, h);
      expect(r).toMatchObject({ outcome: "WITHHOLD", code: "PACKAGE_INVALID" });
    });

    it("a judge whose own _verdict says pass is never PASS", async () => {
      const r = await withJudge(LYING, null);
      expect(r.outcome).toBe("WITHHOLD");
      expect(r.outcome).not.toBe("PASS");
    });
  },
);

describe("a manifest cannot relax itself", () => {
  const attempts: [string, (m: ManifestV2) => void][] = [
    [
      "all checks advisory",
      (m) => {
        for (const c of m.checks) c.required = false;
        for (const p of Object.values(m.profiles)) p.required_overrides = {};
      },
    ],
    [
      "static check turned off through required_overrides",
      (m) => {
        const p = m.profiles.standard;
        if (p) p.required_overrides = { "no-network": false };
      },
    ],
    [
      "min_score 0",
      (m) => {
        const p = m.profiles.standard;
        if (p) p.min_score = 0;
      },
    ],
    [
      "float weight",
      (m) => {
        const c = m.checks[0];
        if (c) c.weight = 12.5;
      },
    ],
  ];

  for (const [name, mutate] of attempts) {
    it(`${name}: validator rejects`, () => {
      const m = JSON.parse(JSON.stringify(baseManifest())) as ManifestV2;
      mutate(m);
      expect(parseManifest(m).ok).toBe(false);
    });

    it.skipIf(!sandboxed)(
      `${name}: the runner reports WITHHOLD and never PASS`,
      { timeout: 60_000 },
      async () => {
        const id = n++;
        const pkg = makeV2Package(root, `relax-pkg-${id}`, { mutate });
        const r = await run(pkg, makeDelivery(root, `relax-del-${id}`));
        expect(r.outcome).toBe("WITHHOLD");
      },
    );
  }

  it("the judge itself refuses each of them with a failing _verdict", async () => {
    const { spawnSync } = await import("node:child_process");
    for (const [name, mutate] of attempts) {
      const id = n++;
      const pkg = makeV2Package(root, `jrelax-pkg-${id}`, { mutate });
      const del = makeDelivery(root, `jrelax-del-${id}`);
      const out = join(root, `jrelax-out-${id}`);
      const r = spawnSync(process.execPath, [join(pkg, "verify.mjs"), del, out], {
        encoding: "utf8",
      });
      const last = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}");
      expect(r.status, name).toBe(1);
      expect(last, name).toMatchObject({ id: "_verdict", status: "fail" });
    }
  });
});

describe("csv2json-v1 is untouched by v2", () => {
  const PKG = join(PKGS, "csv2json-v1");
  // Directory hash of the package as on origin/main, before the v2 work.
  const PINNED = "5ce77810bc860e3d657cb9676aacddd92eeaee0e8fdf66392c1054aa24232e27";

  it("its package hash equals the pinned value (what `pnpm verifier:hash` prints)", async () => {
    expect(await dirHashFromDisk(PKG)).toBe(PINNED);
  });

  it.skipIf(!sandboxed)(
    "a good delivery PASSes with no score, profile or determinism fields",
    { timeout: 60_000 },
    async () => {
      const r = await run(PKG, join(PKG, "fixtures/good-delivery"));
      expect(r.outcome).toBe("PASS");
      for (const k of ["score", "min_score", "profile", "packageId", "determinism"] as const)
        expect(r[k], k).toBeUndefined();
      for (const c of r.checks) expect(Object.keys(c).sort(), c.id).toEqual(["id", "status"]);
    },
  );
});

describe("/v0/stats aggregation", () => {
  const SHA_A = "a".repeat(64);
  const SHA_B = "b".repeat(64);
  const v2 = (
    o: Partial<Omit<RunReportV2, "checks">> & { checks: [string, "pass" | "fail"][] },
  ): RunReportV2 => ({
    package_sha256: SHA_A,
    package_id: "pkg-a",
    profile: "standard",
    score: null,
    min_score: 80,
    duration_ms: 0,
    sandbox: "bwrap",
    determinism: "match",
    self_check_exit_code: 0,
    self_check_agrees: true,
    ...o,
    checks: o.checks.map(([id, status]) => ({
      id,
      kind: "fixtures",
      weight: 10,
      required: true,
      status,
      ms: 0,
    })),
  });
  const rep = (
    outcome: "PASS" | "FAIL",
    seconds: number,
    code: string | null,
    extra?: RunReportV2,
  ): RunReport =>
    ({
      record: {} as RunReport["record"],
      outcome,
      code,
      message: "",
      sandbox: "bwrap",
      log_tail: [],
      verify_sh_sha256: "",
      seconds,
      ...(extra ? { v2: extra } : {}),
    }) as RunReport;
  const entry = (id: string, sha: string, reports: RunReport[]): TaskEntry =>
    ({ task_id: id, package_sha256: sha, reports, released: false }) as unknown as TaskEntry;

  const seeded = () => {
    const reg = new Registry(null);
    reg.put(
      entry("t1", SHA_A, [
        rep(
          "PASS",
          0.1,
          null,
          v2({
            score: 100,
            duration_ms: 100,
            checks: [
              ["fixtures", "pass"],
              ["visible", "pass"],
            ],
          }),
        ),
        rep(
          "PASS",
          0.2,
          null,
          v2({
            score: 90,
            duration_ms: 200,
            checks: [
              ["fixtures", "pass"],
              ["visible", "fail"],
            ],
          }),
        ),
        rep(
          "FAIL",
          0.3,
          null,
          v2({
            score: 50,
            duration_ms: 300,
            self_check_exit_code: 1,
            checks: [
              ["fixtures", "fail"],
              ["visible", "pass"],
            ],
          }),
        ),
      ]),
    );
    reg.put(
      entry("t2", SHA_A, [
        rep(
          "FAIL",
          0.4,
          "VERIFY_NONDETERMINISTIC",
          v2({
            score: null,
            duration_ms: 400,
            determinism: "mismatch",
            self_check_agrees: false,
            checks: [["fixtures", "pass"]],
          }),
        ),
        rep(
          "PASS",
          0.5,
          null,
          v2({
            score: 80,
            duration_ms: 500,
            determinism: "skipped",
            self_check_agrees: false,
            checks: [
              ["fixtures", "pass"],
              ["visible", "pass"],
            ],
          }),
        ),
      ]),
    );
    reg.put(entry("t3", SHA_B, [rep("PASS", 1.2, null), rep("FAIL", 0.4, "DELIVERY_REJECTED")]));
    return reg;
  };

  it("matches the hand-computed values for two packages", () => {
    const { packages } = computeStats(seeded().list());
    expect(packages).toHaveLength(2);
    expect(packages[0]).toEqual({
      package_sha256: SHA_A,
      package_id: "pkg-a",
      format: 2,
      profile: "standard",
      runs: 5,
      pass: 3,
      pass_rate: 0.6,
      mean_score: 80, // (100 + 90 + 50 + 80) / 4, the null score is not counted
      median_duration_ms: 300,
      determinism_rate: 0.75, // 3 match of 4 not skipped
      self_check_agreement: 0.6, // 3 of 5 agree
      checks: [
        { id: "fixtures", runs: 5, fail_rate: 0.2 },
        { id: "visible", runs: 4, fail_rate: 0.25 },
      ],
      withhold_codes: { VERIFY_NONDETERMINISTIC: 1 },
    });
    expect(packages[1]).toEqual({
      package_sha256: SHA_B,
      package_id: null,
      format: 1,
      profile: null,
      runs: 2,
      pass: 1,
      pass_rate: 0.5,
      mean_score: null,
      median_duration_ms: 800, // median of 400 and 1200
      determinism_rate: null,
      self_check_agreement: null,
      checks: [],
      withhold_codes: { DELIVERY_REJECTED: 1 },
    });
  });

  it("an empty registry gives packages: [] over HTTP, and the LAN gets 403", async () => {
    const reg = new Registry(null);
    const service = {
      reports: () => reg.list(),
      stats: () => computeStats(reg.list()),
      handle: async () => ({ ok: true }),
    } as unknown as VerifierService;
    const local = buildServer({ logger: false, service });
    const res = await local.inject({ method: "GET", url: "/v0/stats" });
    expect(res.json()).toEqual({ packages: [] });
    await local.close();

    const lan = buildServer({
      logger: false,
      service,
      localOnly: { port: 7404, uiOrigins: [], lanBind: "192.168.50.2", lanRoutes: LAN_ROUTES },
    });
    const refused = await lan.inject({
      method: "GET",
      url: "/v0/stats",
      remoteAddress: "192.168.50.10",
      headers: { host: "192.168.50.2:7404" },
    });
    expect(refused.statusCode).toBe(403);
    await lan.close();
  });

  it("the seeded stats are served as computed", async () => {
    const reg = seeded();
    const service = {
      reports: () => reg.list(),
      stats: () => computeStats(reg.list()),
    } as unknown as VerifierService;
    const app = buildServer({ logger: false, service });
    const body = (await app.inject({ method: "GET", url: "/v0/stats" })).json();
    expect(body.packages[0].pass_rate).toBe(0.6);
    expect(body.packages[1].median_duration_ms).toBe(800);
    await app.close();
  });
});
