// Node-only helper (filesystem). Import from "@verdict/protocol/node".
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { dirHash, type HashFile } from "./dirhash.js";

/** Reads all regular files recursively. Rejects symlinks and other special files; empty dirs are ignored. */
export async function readDirFiles(root: string): Promise<HashFile[]> {
  const out: HashFile[] = [];
  async function walk(abs: string, rel: string): Promise<void> {
    for (const name of await readdir(abs)) {
      const a = join(abs, name);
      const r = rel === "" ? name : `${rel}/${name}`;
      const st = await lstat(a);
      if (st.isSymbolicLink()) throw new Error(`Symlink not allowed: ${r}`);
      if (st.isDirectory()) await walk(a, r);
      else if (st.isFile()) out.push({ path: r, bytes: new Uint8Array(await readFile(a)) });
      else throw new Error(`Unsupported file type: ${r}`);
    }
  }
  await walk(root, "");
  return out;
}

export async function dirHashFromDisk(root: string): Promise<string> {
  return dirHash(await readDirFiles(root));
}
