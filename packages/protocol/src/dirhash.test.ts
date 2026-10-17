import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dirHash } from "./index.js";
import { dirHashFromDisk, readDirFiles } from "./node.js";

const b = (s: string) => new Uint8Array(Buffer.from(s));

describe("dirHash", () => {
  it("is order independent and content sensitive", () => {
    const x = { path: "a/b.txt", bytes: b("1") };
    const y = { path: "a.txt", bytes: b("2") };
    expect(dirHash([x, y])).toBe(dirHash([y, x]));
    expect(dirHash([x, y])).not.toBe(dirHash([x, { ...y, bytes: b("3") }]));
    expect(dirHash([x, y])).not.toBe(dirHash([x, { ...y, path: "c.txt" }]));
  });
  it("sorts by UTF-8 byte order, not locale", () => {
    const files = ["z", "Z", "a", "é", "ab"].map((p) => ({ path: p, bytes: b(p) }));
    expect(dirHash(files)).toBe(dirHash([...files].reverse()));
  });
  it("rejects non-POSIX or unsafe paths and duplicates", () => {
    for (const p of ["a\\b", "/abs", "../x", "a/../b", "a//b", "", "./a", "a\0b"]) {
      expect(() => dirHash([{ path: p, bytes: b("") }])).toThrow();
    }
    expect(() =>
      dirHash([
        { path: "a", bytes: b("") },
        { path: "a", bytes: b("") },
      ]),
    ).toThrow();
  });
  it("disk helper matches pure function, ignores empty dirs, rejects symlinks", async () => {
    const d = await mkdtemp(join(tmpdir(), "dirhash-"));
    await mkdir(join(d, "sub"));
    await mkdir(join(d, "empty"));
    await writeFile(join(d, "sub", "f.txt"), "hello");
    await writeFile(join(d, "top.sh"), "x");
    expect(await dirHashFromDisk(d)).toBe(
      dirHash([
        { path: "sub/f.txt", bytes: b("hello") },
        { path: "top.sh", bytes: b("x") },
      ]),
    );
    await symlink(join(d, "top.sh"), join(d, "link"));
    await expect(readDirFiles(d)).rejects.toThrow(/Symlink/);
  });
});
