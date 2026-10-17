import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditDataDir } from "./data-perms.js";

const made: string[] = [];
function fixture(): string {
  const d = mkdtempSync(join(tmpdir(), "perms-"));
  made.push(d);
  chmodSync(d, 0o700);
  mkdirSync(join(d, "keys"), { mode: 0o700 });
  writeFileSync(join(d, "keys", "engine.key"), "k", { mode: 0o600 });
  writeFileSync(join(d, "engine-ledger.sqlite"), "l", { mode: 0o600 });
  writeFileSync(join(d, "identities.json"), "{}", { mode: 0o644 });
  mkdirSync(join(d, "regtest"), { mode: 0o755 });
  return d;
}
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("auditDataDir (L3)", () => {
  it("accepts 0700 dirs, 0600 secret files, and public files readable by others", () => {
    expect(auditDataDir(fixture())).toEqual([]);
  });

  it("reports an open data dir, key file and ledger, and fixes them on request", () => {
    const d = fixture();
    chmodSync(d, 0o755);
    chmodSync(join(d, "keys", "engine.key"), 0o644);
    chmodSync(join(d, "engine-ledger.sqlite"), 0o664);
    const found = auditDataDir(d).map((p) => p.path);
    expect(found).toEqual(
      expect.arrayContaining([d, join(d, "keys", "engine.key"), join(d, "engine-ledger.sqlite")]),
    );
    expect(auditDataDir(d, { fix: true })).toHaveLength(3);
    expect(auditDataDir(d)).toEqual([]);
    expect(statSync(d).mode & 0o777).toBe(0o700);
  });

  it("refuses symlinks inside the data dir", () => {
    const d = fixture();
    symlinkSync("/etc/passwd", join(d, "link"));
    expect(auditDataDir(d).map((p) => p.mode)).toContain("link");
  });
});
