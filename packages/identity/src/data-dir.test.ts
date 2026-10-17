import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveDataDir } from "./data-dir.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

describe("resolveDataDir", () => {
  it("defaults to ~/.verdict-data and is always absolute", () => {
    expect(resolveDataDir({})).toBe(join(homedir(), ".verdict-data"));
    expect(resolveDataDir({ VERDICT_DATA_DIR: "" })).toBe(join(homedir(), ".verdict-data"));
    expect(isAbsolute(resolveDataDir({ VERDICT_DATA_DIR: "./data" }))).toBe(true);
    expect(resolveDataDir({ VERDICT_DATA_DIR: "~/x" })).toBe(join(homedir(), "x"));
    expect(resolveDataDir({ VERDICT_DATA_DIR: "/srv/v" })).toBe("/srv/v");
  });
});

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (["node_modules", "dist", ".git", "spikes"].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe("single data dir resolution", () => {
  const files = ["packages", "services", "apps", "scripts", "infra", "tests"]
    .flatMap((d) => sources(join(ROOT, d)))
    .filter((f) => !f.endsWith("data-dir.ts") && !f.endsWith("data-dir.test.ts"));

  it("no source builds a data path from a relative literal or re-implements the default", () => {
    const bad = [
      /["'`](\.\.?\/)?data\//, // "data/..." or "./data/..."
      /["'`]\.\/data["'`]/, // "./data"
      /\.verdict-data/, // the default lives in data-dir.ts only
      /VERDICT_DATA_DIR\s*\?\?/, // always go through resolveDataDir()
    ];
    const hits = files.flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .flatMap((line, i) =>
          // comments may mention the variable; code may not
          !line.trim().startsWith("//") &&
          !line.trim().startsWith("*") &&
          bad.some((r) => r.test(line))
            ? [`${relative(ROOT, f)}:${i + 1}: ${line.trim()}`]
            : [],
        ),
    );
    expect(hits).toEqual([]);
  });
});
