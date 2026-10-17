import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dirHashFromDisk } from "@verdict/protocol/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectSandbox, runVerification, sandboxArgv } from "./runner.js";

const PKG = resolve(__dirname, "../../../verifier-packages/csv2json-v1");
const GOOD = join(PKG, "fixtures/good-delivery");
const BAD = join(PKG, "fixtures/bad-delivery");
const kind = detectSandbox();
const scratch = mkdtempSync(join(tmpdir(), "runner-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A delivery directory with one csv2json.mjs. */
function delivery(name: string, source: string): string {
  const d = join(scratch, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "csv2json.mjs"), source);
  return d;
}

/** A copy of the real package with a replaced judge and/or a short per-case timeout. */
function fakePackage(name: string, judge?: string, caseTimeout?: number): string {
  const d = join(scratch, name);
  cpSync(PKG, d, { recursive: true });
  if (judge !== undefined) writeFileSync(join(d, "verify.mjs"), judge);
  if (caseTimeout !== undefined) {
    const m = JSON.parse(readFileSync(join(d, "manifest.json"), "utf8"));
    m.case_timeout_seconds = caseTimeout;
    writeFileSync(join(d, "manifest.json"), JSON.stringify(m));
  }
  return d;
}

const run = (deliveryDir: string, packageDir = PKG, maxVerifySeconds = 30) =>
  runVerification({ packageDir, deliveryDir, maxVerifySeconds });

/** Runs a script as the delivery inside the real sandbox and returns what it printed. */
function inSandbox(source: string): { stdout: string; status: number | null } {
  const d = delivery(`probe-${Math.random().toString(36).slice(2)}`, source);
  const inputs = join(scratch, "probe-inputs");
  mkdirSync(inputs, { recursive: true });
  writeFileSync(join(inputs, "x.csv"), "a\n");
  const [cmd, args] = sandboxArgv(
    kind as NonNullable<typeof kind>,
    { delivery: d, inputs, scratch: join(scratch, "unused") },
    "csv2json.mjs",
    "x.csv",
    { cpuSeconds: 10, fsizeBytes: 1024 * 1024 },
  );
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: 20000,
    env: { PATH: "/usr/bin:/bin" },
  });
  return { stdout: r.stdout, status: r.status };
}

describe.skipIf(kind === null)("runner (sandboxed)", () => {
  it("good fixture passes, repeatedly with the same exit code", async () => {
    const a = await run(GOOD);
    const b = await run(GOOD);
    expect(a.outcome).toBe("PASS");
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(a.exitCode);
    expect(b.checks).toEqual(a.checks);
    expect(a.checks.map((c) => c.id)).toEqual(["tests", "schema", "no-network"]);
  });

  it("bad fixture fails exactly one check", async () => {
    const r = await run(BAD);
    expect(r.outcome).toBe("FAIL");
    expect(r.exitCode).toBe(1);
    expect(r.checks.filter((c) => c.status === "fail").map((c) => c.id)).toEqual(["tests"]);
  });

  it("delivery that imports the network fails no-network", async () => {
    const r = await run(
      delivery(
        "net-delivery",
        'import net from "node:net";\nnet.connect(1, "127.0.0.1");\nconsole.log("[]");\n',
      ),
    );
    expect(r.outcome).toBe("FAIL");
    expect(r.checks.find((c) => c.id === "no-network")?.status).toBe("fail");
    const r2 = await run(delivery("fetch-delivery", 'await fetch("http://example.com");\n'));
    expect(r2.checks.find((c) => c.id === "no-network")?.status).toBe("fail");
  });

  describe("sandbox properties", () => {
    let server: Server;
    let port = 0;
    beforeAll(async () => {
      server = createServer((s) => s.end());
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      port = (server.address() as { port: number }).port;
    });
    afterAll(() => server.close());

    it("network is blocked at runtime", () => {
      const probe = spawnSync(
        process.execPath,
        [
          "-e",
          `require("net").connect(${port},"127.0.0.1").on("connect",()=>process.exit(0)).on("error",()=>process.exit(1))`,
        ],
        { timeout: 5000 },
      );
      expect(probe.status).toBe(0); // reachable outside the sandbox
      const r = inSandbox(
        `import net from "node:net";
net.connect(${port}, "127.0.0.1").on("connect", () => console.log("CONNECTED")).on("error", () => console.log("BLOCKED"));`,
      );
      expect(r.stdout.trim()).toBe("BLOCKED");
    });

    it("env is scrubbed", () => {
      process.env.SECRET_TOKEN = "leak";
      try {
        const r = inSandbox("console.log(JSON.stringify(Object.keys(process.env).sort()))");
        expect(JSON.parse(r.stdout)).not.toContain("SECRET_TOKEN");
        expect(JSON.parse(r.stdout)).not.toContain("VERDICT_MODE");
      } finally {
        delete process.env.SECRET_TOKEN;
      }
    });

    it("sees no host paths and can write only to its scratch dir", () => {
      if (process.platform === "darwin") {
        // Seatbelt model: reads allowed by default except the hidden run dir (which holds the package copy with the
        // expected answers), writes only under scratch. Host paths stay visible on macOS (documented limit).
        writeFileSync(join(scratch, "secret.txt"), "expected answers live here");
        mkdirSync(join(scratch, "unused"), { recursive: true });
        const r = inSandbox(`import fs from "node:fs";
import path from "node:path";
const tryW = (p) => { try { fs.writeFileSync(p, "x"); return "wrote"; } catch (e) { return e.code; } };
const tryR = (p) => { try { fs.readFileSync(p); return "read"; } catch (e) { return e.code; } };
const tryLs = (p) => { try { fs.readdirSync(p); return "listed"; } catch (e) { return e.code; } };
const delivery = path.dirname(process.argv[1]);
const inputs = path.dirname(process.argv[2]);
const runDir = path.dirname(delivery);
console.log(JSON.stringify({
  hiddenFile: tryR(path.join(runDir, "secret.txt")), hiddenList: tryLs(runDir),
  delivery: tryW(path.join(delivery, "x")), inputs: tryW(path.join(inputs, "x")),
  usr: tryW("/usr/x"), etc: tryW("/etc/x"), root: tryW("/x"),
  scratch: tryW(path.join(runDir, "unused", "x")),
}));`);
        expect(JSON.parse(r.stdout)).toEqual({
          hiddenFile: "EPERM",
          hiddenList: "EPERM",
          delivery: "EPERM",
          inputs: "EPERM",
          usr: "EPERM",
          etc: "EPERM",
          root: "EPERM",
          scratch: "wrote",
        });
        return;
      }
      const r = inSandbox(`import fs from "node:fs";
const tryW = (p) => { try { fs.writeFileSync(p, "x"); return "wrote"; } catch (e) { return e.code; } };
console.log(JSON.stringify({
  pkg: fs.existsSync(${JSON.stringify(PKG)}),
  home: fs.existsSync(${JSON.stringify(process.env.HOME ?? "/nonexistent")} + "/.claude"),
  delivery: tryW("/delivery/x"), inputs: tryW("/inputs/x"), usr: tryW("/usr/x"), etc: tryW("/etc/x"), root: tryW("/x"),
  out: tryW("/out/x"),
}));`);
      expect(JSON.parse(r.stdout)).toEqual({
        pkg: false,
        home: false,
        delivery: "EROFS",
        inputs: "EROFS",
        usr: "EROFS",
        etc: "EROFS",
        root: "EROFS",
        out: "wrote",
      });
    });
  });

  // H1: a delivery that tries to rewrite the expected files, the judge, or anything outside its dir cannot forge a PASS.
  it("malicious delivery cannot overwrite expected files, the judge, or write outside its dir", async () => {
    const before = await dirHashFromDisk(PKG);
    const victim = join(scratch, "victim.txt");
    writeFileSync(victim, "untouched");
    const casesDir = join(PKG, "cases");
    const d = delivery(
      "h1-malicious",
      `import fs from "node:fs";
import path from "node:path";
const targets = [${JSON.stringify(casesDir)}, ${JSON.stringify(PKG)}, "../package", "../../package", "/package"];
for (const t of targets) {
  for (const f of ["verify.mjs", "simple.expected.json", "cases/simple.expected.json"]) {
    try { fs.chmodSync(path.join(t, f), 0o644); } catch {}
    try { fs.writeFileSync(path.join(t, f), "[]"); } catch {}
  }
}
try { fs.writeFileSync(${JSON.stringify(victim)}, "pwned"); } catch {}
try { fs.writeFileSync("/delivery/csv2json.mjs", ""); } catch {}
console.log("[]");`,
    );
    const r = await run(d);
    expect(r.outcome).toBe("FAIL");
    expect(r.checks.find((c) => c.id === "tests")?.status).toBe("fail");
    expect(await dirHashFromDisk(PKG)).toBe(before);
    expect(readFileSync(victim, "utf8")).toBe("untouched");
  });

  it("a delivery that plants symlinks or prints oversized output is judged as data and fails", async () => {
    const d = delivery(
      "h1-symlink",
      `import fs from "node:fs";
try { fs.symlinkSync("/etc/passwd", "/out/simple.out.json"); } catch {}
process.stdout.write("x".repeat(3 * 1024 * 1024));`,
    );
    const r = await run(d);
    expect(r.outcome).toBe("FAIL");
  });

  it("a hanging delivery fails after the time budget and the whole process group is gone", {
    timeout: 60000,
  }, async () => {
    const marker = join(scratch, "alive");
    const d = delivery(
      "hang",
      `import { spawn } from "node:child_process";
spawn(process.execPath, ["-e", "setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'), 2500)"], { detached: true, stdio: "ignore" }).unref();
setInterval(() => {}, 1000);`,
    );
    const t0 = Date.now();
    const r = await run(d, fakePackage("hang-pkg", undefined, 1), 30);
    expect(r.outcome).toBe("FAIL");
    expect(Date.now() - t0).toBeLessThan(20000);
    await new Promise((res) => setTimeout(res, 3500));
    expect(existsSync(marker)).toBe(false);
  });

  // M1
  it("a fork bomb fails the delivery and the verifier keeps working", {
    timeout: 90000,
  }, async () => {
    const d = delivery(
      "forkbomb",
      `import { spawn } from "node:child_process";
for (;;) { try { spawn(process.execPath, [process.argv[1], process.argv[2]], { stdio: "ignore" }); } catch {} }`,
    );
    const r = await run(d, fakePackage("bomb-pkg", undefined, 2), 60);
    expect(r.outcome).toBe("FAIL");
    expect((await run(GOOD)).outcome).toBe("PASS");
  });

  it("unbounded allocation fails the delivery and the verifier keeps working", {
    timeout: 90000,
  }, async () => {
    const d = delivery(
      "memhog",
      `const keep = [];
for (;;) keep.push(Buffer.alloc(64 * 1024 * 1024, 1));`,
    );
    const r = await run(d, fakePackage("mem-pkg", undefined, 5), 60);
    expect(r.outcome).toBe("FAIL");
    expect((await run(GOOD)).outcome).toBe("PASS");
  });
});

describe.skipIf(kind === null)("runner fails closed", () => {
  it("judge crash, garbage output, and mismatched exit code are WITHHOLD", async () => {
    for (const [n, js] of [
      ["crash", "process.exit(7)"],
      ["garbage", 'console.log("hello")'],
      ["lie", 'console.log(JSON.stringify({id:"a",status:"fail"})); process.exit(0)'],
      ["lie2", 'console.log(JSON.stringify({id:"a",status:"pass"})); process.exit(1)'],
      ["empty", "process.exit(0)"],
    ] as const) {
      const r = await run(GOOD, fakePackage(`judge-${n}`, js));
      expect(r.outcome, n).toBe("WITHHOLD");
    }
  });

  it("a package whose manifest is broken is WITHHOLD", async () => {
    const p = fakePackage("no-manifest");
    rmSync(join(p, "manifest.json"));
    expect((await run(GOOD, p)).outcome).toBe("WITHHOLD");
  });

  it("missing package or delivery is WITHHOLD (runner error)", async () => {
    expect((await run(GOOD, join(scratch, "nope"))).outcome).toBe("WITHHOLD");
    expect((await run(join(scratch, "nope2"))).outcome).toBe("WITHHOLD");
  });

  it("tampered delivery gives DELIVERY_HASH_MISMATCH", async () => {
    const h = await dirHashFromDisk(GOOD);
    const ok = await runVerification({
      packageDir: PKG,
      deliveryDir: GOOD,
      maxVerifySeconds: 30,
      expectedDeliverySha256: h,
    });
    expect(ok.code).toBeUndefined();
    const r = await runVerification({
      packageDir: PKG,
      deliveryDir: BAD,
      maxVerifySeconds: 30,
      expectedDeliverySha256: h,
    });
    expect(r.code).toBe("DELIVERY_HASH_MISMATCH");
  });

  it("rejects symlinks and oversized deliveries", async () => {
    const s = join(scratch, "sym");
    mkdirSync(s);
    symlinkSync("/etc/passwd", join(s, "csv2json.mjs"));
    expect((await run(s)).code).toBe("DELIVERY_REJECTED");
    const big = join(scratch, "big");
    mkdirSync(big);
    writeFileSync(join(big, "csv2json.mjs"), Buffer.alloc(1024 * 1024 + 1));
    expect((await run(big)).code).toBe("DELIVERY_REJECTED");
  });
});

describe("package hash", () => {
  it("is stable and 64 hex chars", async () => {
    const h = await dirHashFromDisk(PKG);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await dirHashFromDisk(PKG)).toBe(h);
  });
});

describe("macOS profile (string check, runs anywhere)", () => {
  it("denies reads of the temp dir, the package and the data dir, and re-allows only delivery, inputs, scratch", () => {
    const [cmd, args] = sandboxArgv(
      "sandbox-exec",
      {
        delivery: "/t/run/delivery",
        inputs: "/t/run/inputs",
        scratch: "/t/run/scratch",
        hide: ["/pkg", "/data"],
      },
      "csv2json.mjs",
      "x.csv",
      { cpuSeconds: 5, fsizeBytes: 1024 },
    );
    expect(cmd).toBe("sandbox-exec");
    const profile = args[1] as string;
    expect(profile).toContain(
      '(deny file-read* (subpath "/t/run")(subpath "/pkg")(subpath "/data"))',
    );
    expect(profile.indexOf("(deny file-read*")).toBeLessThan(profile.indexOf("(allow file-read*"));
    expect(profile).toContain(
      '(allow file-read* (subpath "/t/run/delivery")(subpath "/t/run/inputs")(subpath "/t/run/scratch"))',
    );
    expect(profile).toContain("(deny network*)");
  });
});
