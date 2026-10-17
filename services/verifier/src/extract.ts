// Bounded delivery extraction (M2). The compressed size, the expanded size, the file count and every entry are checked
// BEFORE or WHILE bytes are produced; nothing is written to disk until the whole archive has passed. Only ustar regular
// files and directories are accepted: symlinks, hardlinks, devices, pax/GNU extension headers, absolute paths and ".."
// are refused. Fail closed: any problem throws.
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

export const MAX_DELIVERY_BYTES = 1024 * 1024;
export const MAX_COMPRESSED_BYTES = 1024 * 1024;
export const MAX_FILES = 64;
export const MAX_PATH_BYTES = 200;
/** Expanded tar stream: payload cap plus a generous allowance for 512-byte headers and padding. */
export const MAX_EXPANDED_BYTES = MAX_DELIVERY_BYTES + (MAX_FILES * 2 + 8) * 512 * 2;

export interface TarEntry {
  path: string;
  kind: "file" | "dir";
  data: Buffer;
}

function field(b: Buffer, off: number, len: number): string {
  const z = b.indexOf(0, off);
  const end = z >= 0 && z < off + len ? z : off + len;
  return b.toString("utf8", off, end);
}

function octal(b: Buffer, off: number, len: number): number {
  const s = field(b, off, len).trim();
  if (!/^[0-7]*$/.test(s)) throw new Error("Malformed tar header");
  return s === "" ? 0 : Number.parseInt(s, 8);
}

function cleanName(raw: string): string {
  const name = raw.replace(/\/+$/, "").replace(/^(\.\/)+/, "");
  if (name === "" || name === ".") return "";
  if (
    raw.startsWith("/") ||
    name.includes("\0") ||
    name.includes("\\") ||
    Buffer.byteLength(name) > MAX_PATH_BYTES
  )
    throw new Error(`Illegal path: ${raw}`);
  for (const part of name.split("/")) {
    if (part === "" || part === "." || part === "..") throw new Error(`Illegal path: ${raw}`);
  }
  return name;
}

/** Parses an expanded tar stream with every limit enforced as the headers are read. */
export function parseTar(tar: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  let off = 0;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    off += 512;
    const type = String.fromCharCode(h[156] === 0 ? 48 : (h[156] as number));
    const prefix = field(h, 345, 155);
    const name = cleanName(prefix === "" ? field(h, 0, 100) : `${prefix}/${field(h, 0, 100)}`);
    const size = octal(h, 124, 12);
    if (type === "5") {
      if (name !== "") entries.push({ path: name, kind: "dir", data: Buffer.alloc(0) });
      continue;
    }
    if (type !== "0") throw new Error("Only regular files and directories are allowed");
    if (name === "") throw new Error("Illegal path: empty");
    total += size;
    if (total > MAX_DELIVERY_BYTES) throw new Error("Delivery larger than 1 MB");
    if (entries.length >= MAX_FILES) throw new Error("Too many files in the delivery");
    if (seen.has(name)) throw new Error(`Duplicate entry: ${name}`);
    seen.add(name);
    if (off + size > tar.length) throw new Error("Truncated tarball");
    entries.push({ path: name, kind: "file", data: Buffer.from(tar.subarray(off, off + size)) });
    off += Math.ceil(size / 512) * 512;
  }
  return entries;
}

/** Decompresses with a hard output cap, so a gzip bomb stops at MAX_EXPANDED_BYTES instead of filling memory or disk. */
export function gunzipBounded(gz: Buffer): Buffer {
  if (gz.length > MAX_COMPRESSED_BYTES) throw new Error("Bundle larger than 1 MB compressed");
  try {
    return gunzipSync(gz, { maxOutputLength: MAX_EXPANDED_BYTES });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ERR_BUFFER_TOO_LARGE") throw new Error("Bundle expands beyond the allowed size");
    throw new Error("Unreadable tarball");
  }
}

/** Extracts a .tar.gz delivery into the existing, empty destDir. Throws on anything suspicious, writing nothing first. */
export function extractTarball(tarball: string, destDir: string): void {
  const st = lstatSync(tarball);
  if (!st.isFile()) throw new Error("Unreadable tarball");
  if (st.size > MAX_COMPRESSED_BYTES) throw new Error("Bundle larger than 1 MB compressed");
  const entries = parseTar(gunzipBounded(readFileSync(tarball)));
  for (const e of entries) {
    const target = join(destDir, e.path);
    if (e.kind === "dir") mkdirSync(target, { recursive: true });
    else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, e.data, { flag: "wx", mode: 0o644 });
    }
  }
}
