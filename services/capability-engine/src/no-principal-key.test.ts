import { mkdtempSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initIdentities, loadIdentities, loadSecretSeed } from "@verdict/wallet";
import { expect, test } from "vitest";

test("the engine boots from public ids and its own seed; the principal seed file is never needed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "verdict-engine-"));
  await initIdentities(dir);
  unlinkSync(join(dir, "keys", "principal.key")); // the engine host has no principal secret at all
  expect(loadIdentities(dir).principal).toMatch(/^eip191:0x/);
  expect(loadSecretSeed("engine", dir)).toHaveLength(32);
  expect(() => loadSecretSeed("principal", dir)).toThrow();
});

test("no engine source file reads the principal secret", () => {
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
    );
  for (const f of walk(import.meta.dirname).filter(
    (p) => p.endsWith(".ts") && !p.endsWith(".test.ts"),
  ))
    expect(readFileSync(f, "utf8"), f).not.toMatch(/loadSecretSeed\(\s*["']principal["']/);
});
