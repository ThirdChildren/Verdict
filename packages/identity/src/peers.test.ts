import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PEERS, loadPeers } from "./peers.js";

function dirWith(content?: string): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "peers-"));
  mkdirSync(dir, { recursive: true });
  if (content !== undefined) writeFileSync(join(dir, "peers.json"), content);
  return { VERDICT_DATA_DIR: dir };
}

describe("loadPeers", () => {
  it("falls back to loopback", () => {
    expect(loadPeers(dirWith())).toEqual(DEFAULT_PEERS);
  });
  it("reads peers.json and normalizes", () => {
    const p = loadPeers(dirWith('{"verifier":"http://192.168.50.2:7404/"}'));
    expect(p.verifier).toBe("http://192.168.50.2:7404");
    expect(p.engine).toBe(DEFAULT_PEERS.engine);
  });
  it("env wins over the file", () => {
    const env = {
      ...dirWith('{"verifier":"http://10.0.0.1:7404"}'),
      VERIFIER_URL: "http://10.0.0.2:7404",
    };
    expect(loadPeers(env).verifier).toBe("http://10.0.0.2:7404");
  });
  it.each([
    '{"verifier":"ftp://x:1"}',
    '{"verifier":"http://u:p@x:1"}',
    '{"verifier":"http://x:1/path"}',
    '{"verifier":5}',
    '{"mac":"http://x:1"}',
    "[1]",
    "not json",
  ])("refuses %s with a plain message", (c) => {
    expect(() => loadPeers(dirWith(c))).toThrow();
  });
});
