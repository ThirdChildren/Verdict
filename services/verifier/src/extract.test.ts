import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { extractTarball } from "./extract.js";

const scratch = mkdtempSync(join(tmpdir(), "extract-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let n = 0;
const dest = (): string => {
  const d = join(scratch, `d${n++}`);
  mkdirSync(d);
  return d;
};

/** Minimal ustar writer so hostile entries (absolute names, hardlinks, huge sizes) can be built without tar. */
function tar(
  entries: { name: string; type?: string; size?: number; data?: Buffer; link?: string }[],
): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const h = Buffer.alloc(512);
    h.write(e.name, 0);
    h.write("0000644\0", 100);
    h.write(`${(e.size ?? e.data?.length ?? 0).toString(8).padStart(11, "0")}\0`, 124);
    h.write(e.type ?? "0", 156);
    if (e.link) h.write(e.link, 157);
    h.write("ustar\0", 257);
    parts.push(h);
    if (e.data) parts.push(e.data, Buffer.alloc((512 - (e.data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
const write = (name: string, buf: Buffer): string => {
  const p = join(scratch, name);
  writeFileSync(p, buf);
  return p;
};

describe("extractTarball limits (M2)", () => {
  it("extracts a normal bundle made by tar -czf . (as the worker does)", () => {
    const src = join(scratch, "src");
    mkdirSync(join(src, "sub"), { recursive: true });
    writeFileSync(join(src, "csv2json.mjs"), "x");
    writeFileSync(join(src, "sub", "a.txt"), "y");
    const tgz = join(scratch, "ok.tgz");
    spawnSync("tar", ["-czf", tgz, "-C", src, "."]);
    const d = dest();
    extractTarball(tgz, d);
    expect(existsSync(join(d, "csv2json.mjs"))).toBe(true);
    expect(existsSync(join(d, "sub", "a.txt"))).toBe(true);
  });

  it("a gzip bomb is stopped and nothing is written", () => {
    const bomb = write(
      "bomb.tgz",
      gzipSync(tar([{ name: "big", data: Buffer.alloc(300 * 1024 * 1024) }])),
    );
    const d = dest();
    const t0 = Date.now();
    expect(() => extractTarball(bomb, d)).toThrow();
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(readdirSync(d)).toEqual([]);
  });

  it("a header that claims a huge size, too many files, or a compressed bundle over 1 MB is refused", () => {
    const d = dest();
    expect(() =>
      extractTarball(
        write("claim.tgz", gzipSync(tar([{ name: "a", size: 2_000_000, data: Buffer.alloc(10) }]))),
        d,
      ),
    ).toThrow();
    const many = Array.from({ length: 70 }, (_, i) => ({ name: `f${i}`, data: Buffer.from("x") }));
    expect(() => extractTarball(write("many.tgz", gzipSync(tar(many))), d)).toThrow(/Too many/);
    const rnd = Buffer.alloc(1_200_000);
    for (let i = 0; i < rnd.length; i++) rnd[i] = (i * 2654435761) >>> 24;
    expect(() => extractTarball(write("large.tgz", gzipSync(rnd, { level: 0 })), d)).toThrow(
      /compressed/,
    );
    expect(readdirSync(d)).toEqual([]);
  });

  it("symlinks, hardlinks, devices, absolute and .. paths are refused", () => {
    for (const [label, entries] of [
      ["symlink", [{ name: "l", type: "2", link: "/etc/passwd" }]],
      ["hardlink", [{ name: "h", type: "1", link: "/etc/passwd" }]],
      ["device", [{ name: "dev", type: "3" }]],
      ["absolute", [{ name: "/abs", data: Buffer.from("x") }]],
      ["dotdot", [{ name: "../up", data: Buffer.from("x") }]],
      ["nested dotdot", [{ name: "a/../../up", data: Buffer.from("x") }]],
      ["pax header", [{ name: "pax", type: "x", data: Buffer.from("x") }]],
      [
        "duplicate",
        [
          { name: "a", data: Buffer.from("1") },
          { name: "a", data: Buffer.from("2") },
        ],
      ],
    ] as const) {
      const d = dest();
      expect(
        () => extractTarball(write(`${label}.tgz`, gzipSync(tar([...entries]))), d),
        label,
      ).toThrow();
      expect(readdirSync(d), label).toEqual([]);
    }
  });

  it("system tar archives with a symlink or a rewritten .. path are refused", () => {
    const src = join(scratch, "tsrc");
    mkdirSync(src);
    writeFileSync(join(src, "a"), "x");
    symlinkSync("a", join(src, "l"));
    const tgz = join(scratch, "sym.tgz");
    spawnSync("tar", ["-czf", tgz, "-C", src, "a", "l"]);
    expect(() => extractTarball(tgz, dest())).toThrow();
    const tgz2 = join(scratch, "dd.tgz");
    spawnSync("tar", ["-czf", tgz2, "-C", src, "--transform", "s#^a#../a#", "a"]);
    expect(() => extractTarball(tgz2, dest())).toThrow();
  });
});
