import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The core must run in browsers: no node:* imports and no Buffer outside src/node.ts (@verdict/protocol/node).
describe("isomorphic core", () => {
  const dir = new URL(".", import.meta.url);
  const files = readdirSync(dir).filter(
    (n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && n !== "node.ts",
  );
  it("scans the core files", () => expect(files.length).toBeGreaterThan(10));
  for (const n of files) {
    it(`${n} has no node:* import, require or Buffer`, () => {
      const src = readFileSync(new URL(n, dir), "utf8")
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      expect(src).not.toMatch(/from\s+["']node:/);
      expect(src).not.toMatch(/import\(\s*["']node:/);
      expect(src).not.toMatch(/\brequire\(/);
      expect(src).not.toMatch(/\bBuffer\b/);
      expect(src).not.toMatch(/\bprocess\./);
    });
  }
});
