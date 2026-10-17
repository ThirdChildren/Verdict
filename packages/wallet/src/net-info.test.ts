import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { netInfo } from "./net-info.js";

test("prints only allowlisted facts and nothing secret", () => {
  const dir = mkdtempSync(join(tmpdir(), "netinfo-"));
  mkdirSync(join(dir, "keys"));
  writeFileSync(join(dir, "keys", "principal.key"), "SECRETKEYSECRET");
  writeFileSync(
    join(dir, "network.json"),
    JSON.stringify({
      network: "regtest",
      tusd_asset_id: "rgb:abc",
      tusd_precision: 2,
      written_at: "x",
      seed: "SEEDSEEDSEED",
      mnemonic: "MNEMONICWORDS",
    }),
  );
  const out = JSON.stringify(netInfo(dir, {}));
  expect(out).toContain("rgb:abc");
  expect(out).toContain("7401");
  for (const s of ["SEEDSEEDSEED", "MNEMONICWORDS", "SECRETKEYSECRET", "seed", "mnemonic"])
    expect(out).not.toContain(s);
});

test("missing network.json throws", () => {
  expect(() => netInfo(mkdtempSync(join(tmpdir(), "netinfo-")), {})).toThrow(/regtest:setup/);
});

test("shows the bitcoind url but never its user or password", () => {
  const dir = mkdtempSync(join(tmpdir(), "netinfo-"));
  writeFileSync(
    join(dir, "network.json"),
    JSON.stringify({
      network: "regtest",
      tusd_asset_id: "rgb:abc",
      tusd_precision: 2,
      written_at: "x",
      bitcoind_rpc: {
        url: "http://rpcuser:RPCPASS@127.0.0.1:18443",
        user: "rpcuser",
        password: "RPCPASS",
      },
    }),
  );
  const out = JSON.stringify(netInfo(dir, {}));
  expect(out).toContain("http://127.0.0.1:18443");
  expect(out).not.toContain("RPCPASS");
  expect(out).not.toContain("rpcuser");
});
