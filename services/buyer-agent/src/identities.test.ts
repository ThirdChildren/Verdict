import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadBuyerSeed, loadIdentities } from "./identities.js";

const id = (c: string) => `eip191:0x${c.repeat(40)}`;

describe("loadIdentities", () => {
  test("reads a valid file", () => {
    const d = mkdtempSync(join(tmpdir(), "ident-"));
    writeFileSync(
      join(d, "identities.json"),
      JSON.stringify({
        principal: id("a"),
        engine: id("b"),
        buyer: `ed25519:${"e".repeat(64)}`,
        worker: id("c"),
        verifier: `ed25519:${"d".repeat(64)}`,
      }),
    );
    expect(loadIdentities(d).worker).toBe(id("c"));
  });
  test("rejects missing and malformed files", () => {
    const d = mkdtempSync(join(tmpdir(), "ident-"));
    expect(() => loadIdentities(d)).toThrow(/keys:init/);
    writeFileSync(join(d, "identities.json"), JSON.stringify({ worker: "nope" }));
    expect(() => loadIdentities(d)).toThrow(/Invalid/);
  });
  test("buyer seed comes only from keys/buyer.key, never the principal key", () => {
    const d = mkdtempSync(join(tmpdir(), "ident-"));
    mkdirSync(join(d, "keys"));
    writeFileSync(join(d, "keys", "principal.key"), "9".repeat(64));
    expect(() => loadBuyerSeed(d)).toThrow(/buyer\.key/);
    writeFileSync(join(d, "keys", "buyer.key"), "1".repeat(64));
    expect(loadBuyerSeed(d)).toHaveLength(32);
  });
});
