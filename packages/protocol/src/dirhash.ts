import { compareBytes, utf8ToBytes } from "./bytes.js";
import { sha256Hex } from "./canonical.js";

export interface HashFile {
  /** Relative POSIX path, UTF-8. */
  path: string;
  bytes: Uint8Array;
}

function checkPath(p: string): void {
  if (
    p.length === 0 ||
    p.includes("\\") ||
    p.includes("\0") ||
    p.startsWith("/") ||
    p.split("/").some((seg) => seg === "" || seg === "." || seg === "..")
  ) {
    throw new Error(`Invalid file path "${p}": must be a relative POSIX path`);
  }
}

/** Directory hash (ARCHITECTURE 3.3). Order-independent in input. */
export function dirHash(files: readonly HashFile[]): string {
  const seen = new Set<string>();
  const entries = files.map((f) => {
    checkPath(f.path);
    if (seen.has(f.path)) throw new Error(`Duplicate path "${f.path}"`);
    seen.add(f.path);
    return { pathBytes: utf8ToBytes(f.path), line: `${f.path}\0${sha256Hex(f.bytes)}\n` };
  });
  entries.sort((a, b) => compareBytes(a.pathBytes, b.pathBytes));
  return sha256Hex(entries.map((e) => e.line).join(""));
}
