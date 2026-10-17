import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { expectedVerdict, type ManifestV2, parseManifest } from "./manifest.js";
import {
  baseManifest,
  makeDelivery,
  makeOutputs,
  makeV2Package,
  pretty,
  sortJson,
  type V2Options,
} from "./v2-fixture.js";

const root = mkdtempSync(join(tmpdir(), "judge-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

interface Line {
  id: string;
  status: string;
  score?: number;
  required?: boolean;
  weight?: number;
}

function judge(
  opts: V2Options & { source?: string; render?: Parameters<typeof makeOutputs>[2] } = {},
) {
  const id = `t${n++}`;
  const pkg = makeV2Package(root, `pkg-${id}`, opts);
  const del = makeDelivery(root, `del-${id}`, opts.source);
  const out = makeOutputs(root, `out-${id}`, opts.render);
  const r = spawnSync(process.execPath, [join(pkg, "verify.mjs"), del, out], { encoding: "utf8" });
  const lines = r.stdout
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Line);
  const byId = Object.fromEntries(lines.map((l) => [l.id, l]));
  return {
    code: r.status,
    stdout: r.stdout,
    lines,
    byId,
    verdict: byId._verdict as Line,
    pkg,
    del,
    out,
  };
}

const useProfile = (name: string) => (m: ManifestV2) => {
  m.profile = name;
};
const status = (r: ReturnType<typeof judge>, id: string) => r.byId[id]?.status;

describe("generic judge", () => {
  it("passes a good delivery with score 100 and the documented line shapes", () => {
    const r = judge();
    expect(r.code).toBe(0);
    expect(r.verdict).toEqual({
      id: "_verdict",
      status: "pass",
      score: 100,
      min_score: 80,
      profile: "standard",
    });
    expect(r.byId.fixtures).toEqual({
      id: "fixtures",
      status: "pass",
      required: true,
      weight: 50,
      ms: 0,
    });
    expect(r.lines.map((l) => l.id)).toEqual([
      "fixtures",
      "visible",
      "schema",
      "idempotent",
      "no-network",
      "size",
      "request",
      "_verdict",
    ]);
  });

  it("is deterministic: the same inputs give byte-identical output twice", () => {
    const a = judge();
    const again = spawnSync(process.execPath, [join(a.pkg, "verify.mjs"), a.del, a.out], {
      encoding: "utf8",
    });
    expect(again.stdout).toBe(a.stdout);
  });

  describe("fixtures", () => {
    const shuffled = (_s: string, v: unknown) => JSON.stringify(v); // original key order, compact
    it("ignores key order and formatting when key_order is insensitive", () => {
      const r = judge({
        render: shuffled,
        mutate: (m) => {
          const c = m.checks[0];
          if (c) c.params = { key_order: "insensitive" };
        },
      });
      expect(status(r, "fixtures")).toBe("pass");
    });
    it("fails on key order when it is significant (compared as parsed JSON, order of keys)", () => {
      const r = judge({
        render: shuffled,
        mutate: (m) => {
          const c = m.checks[0];
          if (c) c.params = { key_order: "significant" };
        },
      });
      expect(status(r, "fixtures")).toBe("fail");
    });
    it("trim-lines and collapse normalise string values", () => {
      const spaced = (_s: string, v: unknown) => JSON.stringify(sortAndPad(sortJson(v)), null, 2);
      const run = (ws?: string) =>
        judge({
          render: spaced,
          mutate: (m) => {
            const c = m.checks[0];
            if (c) c.params = ws ? { whitespace: ws } : {};
          },
        });
      expect(status(run(), "fixtures")).toBe("fail");
      expect(status(run("trim-lines"), "fixtures")).toBe("pass");
      expect(status(run("collapse"), "fixtures")).toBe("pass");
    });
    it("numeric_tolerance rel and abs", () => {
      const off = (_s: string, v: unknown) => pretty(bump(v, 1e-12));
      const run = (tol: object) =>
        judge({
          render: off,
          mutate: (m) => {
            const c = m.checks[0];
            if (c) c.params = { numeric_tolerance: tol };
          },
        });
      expect(status(run({}), "fixtures")).toBe("fail");
      expect(status(run({ rel: 1e-9 }), "fixtures")).toBe("pass");
      expect(status(run({ abs: 1e-9 }), "fixtures")).toBe("pass");
      expect(status(run({ rel: 1e-15 }), "fixtures")).toBe("fail");
    });
    it("a missing output fails, and a visible-only mistake fails only the visible check", () => {
      expect(
        status(
          judge({ render: (s, v, vis) => (!vis && s === "b" ? null : pretty(v)) }),
          "fixtures",
        ),
      ).toBe("fail");
      const r = judge({ render: (_s, v, vis) => (vis ? "{}" : pretty(v)) });
      expect(status(r, "fixtures")).toBe("pass");
      expect(status(r, "visible")).toBe("fail");
    });
  });

  it("schema: validates every output against schema.json", () => {
    const r = judge({ render: (s, v) => (s === "b" ? "[1]" : pretty(v)) });
    expect(status(r, "schema")).toBe("fail");
    const ok = judge({ render: (_s, v) => pretty(v) });
    expect(status(ok, "schema")).toBe("pass");
  });

  it("property: same_output pairs must agree", () => {
    const r = judge({ render: (s, v) => (s === "a-shuffled" ? pretty({ a: 3 }) : pretty(v)) });
    expect(status(r, "idempotent")).toBe("fail");
    expect(status(r, "fixtures")).toBe("fail");
  });

  describe("static", () => {
    it("bans imports and tokens", () => {
      expect(status(judge({ source: 'import net from "node:net";\n' }), "no-network")).toBe("fail");
      expect(status(judge({ source: 'const x = await fetch("http://x");\n' }), "no-network")).toBe(
        "fail",
      );
      expect(status(judge({ source: 'const m = await import("fs");\n' }), "no-network")).toBe(
        "fail",
      );
      expect(
        status(judge({ source: 'import { readFileSync } from "node:fs";\n' }), "no-network"),
      ).toBe("pass");
    });
  });

  it("limits: max_lines and max_source_bytes", () => {
    const big = `${"// pad\n".repeat(400)}`;
    const r = judge({ source: big });
    expect(status(r, "size")).toBe("fail");
    expect(r.byId.size?.required).toBe(false);
  });

  describe("spec", () => {
    const withSpec = (
      assertions: Record<string, unknown>,
      render?: Parameters<typeof makeOutputs>[2],
    ) => status(judge({ assertions, ...(render ? { render } : {}) }), "request");
    it("output_keys_required", () => {
      expect(
        withSpec({ output_keys_required: ["a"] }, (_s, v) => pretty({ a: 1, ...(v as object) })),
      ).toBe("pass");
      expect(withSpec({ output_keys_required: ["a"] })).toBe("fail"); // case b has no key a
    });
    it("max_output_bytes", () => {
      expect(withSpec({ max_output_bytes: 100 })).toBe("pass");
      expect(withSpec({ max_output_bytes: 5 })).toBe("fail");
    });
    it("numbers_subset_of_input", () => {
      expect(withSpec({ numbers_subset_of_input: true })).toBe("pass");
      expect(
        withSpec({ numbers_subset_of_input: true }, (_s, v) =>
          pretty({ ...(v as object), inv: 99 }),
        ),
      ).toBe("fail");
    });
    it("required_tokens and forbidden_tokens", () => {
      expect(withSpec({ required_tokens: ['"b"'] }, (_s, v) => pretty(v))).toBe("fail"); // case b has no key b
      expect(withSpec({ required_tokens: ["{"] })).toBe("pass");
      expect(withSpec({ forbidden_tokens: ["TODO"] })).toBe("pass");
      expect(
        withSpec({ forbidden_tokens: ["TODO"] }, (_s, v) =>
          pretty({ ...(v as object), t: "TODO" }),
        ),
      ).toBe("fail");
    });
    it("an unknown or empty assertion fails the check", () => {
      expect(withSpec({ made_up: true })).toBe("fail");
      expect(withSpec({})).toBe("fail");
    });
  });

  describe("profiles", () => {
    const noZzz = { type: "object", required: ["zzz"] }; // every output fails this schema
    const breakVisible = (_s: string, v: unknown, vis: boolean) => (vis ? "{}" : pretty(v));
    it("a required failure fails even with a high score", () => {
      const r = judge({ schema: noZzz });
      expect(status(r, "schema")).toBe("fail");
      expect(r.verdict.score).toBe(85);
      expect(r.verdict.status).toBe("fail");
      expect(r.code).toBe(1);
    });
    it("a score below min_score fails with every required check passing", () => {
      const r = judge({
        render: breakVisible,
        mutate: (m) => {
          const v = m.checks.find((c) => c.id === "visible");
          if (v) v.weight = 30;
        },
      });
      expect(status(r, "visible")).toBe("fail");
      expect(r.byId.visible?.required).toBe(false);
      expect(r.verdict.score).toBe(75);
      expect(r.verdict.status).toBe("fail");
      expect(r.code).toBe(1);
    });
    it("lenient relaxes the schema requirement and min_score", () => {
      const r = judge({ schema: noZzz, mutate: useProfile("lenient") });
      expect(r.byId.schema).toMatchObject({ status: "fail", required: false });
      expect(r.verdict).toEqual({
        id: "_verdict",
        status: "pass",
        score: 85,
        min_score: 60,
        profile: "lenient",
      });
      expect(r.code).toBe(0);
    });
    it("strict promotes advisory checks to required and applies its tolerances", () => {
      const s = judge({ mutate: useProfile("strict") });
      expect(s.verdict).toMatchObject({ profile: "strict", min_score: 95, status: "pass" });
      expect(s.byId.visible?.required).toBe(true);
      expect(s.byId.idempotent?.required).toBe(true);
      // advisory in standard (score 90 >= 80), required in strict
      expect(judge({ render: breakVisible }).code).toBe(0);
      expect(judge({ render: breakVisible, mutate: useProfile("strict") }).code).toBe(1);
      // strict compares key order as significant: compact output in source key order no longer matches
      const compact = (_s: string, v: unknown) => JSON.stringify(v);
      expect(judge({ render: compact }).byId.fixtures?.status).toBe("pass");
      expect(judge({ render: compact, mutate: useProfile("strict") }).byId.fixtures?.status).toBe(
        "fail",
      );
    });
    it("the TypeScript recomputation agrees with the judge", () => {
      for (const profile of ["strict", "standard", "lenient"]) {
        for (const render of [
          (_s: string, v: unknown, _vis: boolean) => pretty(v),
          (_s: string, v: unknown, vis: boolean) => (vis ? "{}" : pretty(v)),
          (s: string, v: unknown, _vis: boolean) => (s === "b" ? "[]" : pretty(v)),
        ]) {
          const r = judge({ render, mutate: useProfile(profile) });
          const m = baseManifest();
          m.profile = profile;
          const e = expectedVerdict(
            m,
            r.lines
              .filter((l) => l.id !== "_verdict")
              .map((l) => ({ id: l.id, status: l.status as "pass" | "fail" })),
          );
          expect(e.score).toBe(r.verdict.score);
          expect(e.pass).toBe(r.verdict.status === "pass");
          expect(r.code).toBe(e.pass ? 0 : 1);
        }
      }
    });
  });
});

describe("manifest validator", () => {
  it("format absent is format 1", () => {
    expect(parseManifest({ entry: "x" })).toEqual({ ok: true, format: 1 });
  });
  it("accepts the base manifest", () => {
    const r = parseManifest(JSON.parse(JSON.stringify(baseManifest())));
    expect(r.ok && r.format === 2 && r.manifest.checks).toHaveLength(7);
  });
  it("reports typed, pathed errors", () => {
    const m = JSON.parse(JSON.stringify(baseManifest()));
    m.entry = "a/b";
    m.profile = "nope";
    m.checks[1].id = "fixtures";
    m.checks[0].kind = "magic";
    m.checks[2].params.file = "../x";
    m.judge_sha256 = "abc";
    const r = parseManifest(m);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const paths = r.issues.map((i) => i.path);
      expect(paths).toEqual(
        expect.arrayContaining([
          "entry",
          "profile",
          "checks[1].id",
          "checks[0].kind",
          "checks[2].params.file",
          "judge_sha256",
        ]),
      );
    }
  });
  it("enforces the floor no profile can relax", () => {
    const mk = (f: (m: ManifestV2) => void) => {
      const m = JSON.parse(JSON.stringify(baseManifest())) as ManifestV2;
      f(m);
      return parseManifest(m);
    };
    expect(
      mk((m) => {
        for (const c of m.checks) c.required = false;
        for (const p of Object.values(m.profiles)) p.required_overrides = {};
      }).ok,
    ).toBe(false);
    expect(
      mk((m) => {
        const p = m.profiles.lenient;
        if (p) p.required_overrides = { schema: false, fixtures: false, request: false };
      }).ok,
    ).toBe(false);
    expect(
      mk((m) => {
        const p = m.profiles.lenient;
        if (p) p.required_overrides = { "no-network": false };
      }).ok,
    ).toBe(false);
    expect(
      mk((m) => {
        const p = m.profiles.standard;
        if (p) p.min_score = 0;
      }).ok,
    ).toBe(false);
    expect(
      mk((m) => {
        const p = m.profiles.standard;
        if (p) p.min_score = 80.5;
      }).ok,
    ).toBe(false);
    expect(
      mk((m) => {
        const c = m.checks[0];
        if (c) c.weight = 1.5;
      }).ok,
    ).toBe(false);
    expect(
      mk((m) => {
        const p = m.profiles.standard;
        if (p) p.tolerances = { file: "../x" };
      }).ok,
    ).toBe(false);
    expect(mk(() => {}).ok).toBe(true);
  });
  it("the judge rejects the same manifests with a _verdict fail line", () => {
    const r = judge({
      mutate: (m) => {
        const p = m.profiles.standard;
        if (p) p.min_score = 0;
      },
    });
    expect(r.code).toBe(1);
    expect(r.verdict.status).toBe("fail");
  });
  it("rejects a wrong format value and non-objects", () => {
    expect(parseManifest({ format: 3 }).ok).toBe(false);
    expect(parseManifest([]).ok).toBe(false);
  });
});

function sortAndPad(v: unknown): unknown {
  if (typeof v === "string") return `  ${v}  `;
  if (Array.isArray(v)) return v.map(sortAndPad);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sortAndPad(x)]));
  return v;
}
function bump(v: unknown, eps: number): unknown {
  if (typeof v === "number") return v + eps * Math.abs(v);
  if (Array.isArray(v)) return v.map((x) => bump(x, eps));
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, bump(x, eps)]));
  return v;
}
