import { describe, expect, it } from "vitest";
import * as f from "./fixtures.js";
import {
  canonical,
  capId,
  contractHash,
  dirHash,
  hashObj,
  hashUnsigned,
  signingString,
  taskId,
} from "./index.js";

describe("golden vectors", () => {
  it("canonical (JCS)", () => {
    const s = canonical({ b: 1, a: [true, null, "é"], "€": 2, c: { z: 1, y: 2 } });
    expect(s).toBe('{"a":[true,null,"é"],"b":1,"c":{"y":2,"z":1},"€":2}');
    // independently computed with `sha256sum`
    expect(hashObj(JSON.parse(s))).toBe(
      "b1aa6dc0b4e94c41ab6f33fc80b81ba92d4503aa2b45b5acc7e92388a928b3cf",
    );
  });
  it("capability hashes and ids", () => {
    expect(hashObj(f.root)).toBe(
      "9045ee898b91f97f2b7333bf9f47a538465a2df82cb7b39c498f65dd9516eb61",
    );
    expect(capId(f.root)).toBe("cap_5e63ec652c6a686d");
    expect(hashObj(f.child)).toBe(
      "6d5ea23838178f63b183510f68d213b921785ca39cb4212e5963a986301118ab",
    );
    expect(capId(f.child)).toBe("cap_d5dd67c1af86061d");
    expect(signingString("CAP_ROOT", f.root)).toBe(
      "verdict:v0:CAP_ROOT:c3ecd3e592f51a6983e938223cfc08f2806843d9d2aa1b753a9223168cc39069",
    );
  });
  it("contract hash, task id, signing string", () => {
    expect(hashObj(f.contract)).toBe(
      "5029bfec158d8ddbcab371d67723ad2863b8634548f794e1722fe5c6414370b5",
    );
    expect(taskId(f.contract)).toBe("task_250af88109941a74");
    expect(signingString("TASK_CONTRACT", f.contract)).toBe(
      "verdict:v0:TASK_CONTRACT:250af88109941a7446e478b114bc266c323d5e84dc22a8f699a40cbc734273b3",
    );
  });
  it("contract_sha256 ignores signatures: re-signing does not change it", () => {
    const h = contractHash(f.contract);
    expect(h).toBe("250af88109941a7446e478b114bc266c323d5e84dc22a8f699a40cbc734273b3");
    expect(h).toBe(hashUnsigned(f.contract));
    expect(h.slice(0, 16)).toBe(taskId(f.contract).slice("task_".length));
    const resigned = {
      ...f.contract,
      signatures: { buyer: `0x${"ab".repeat(65)}`, worker: `0x${"cd".repeat(65)}` },
    };
    expect(contractHash(resigned)).toBe(h);
    expect(contractHash({ ...f.contract, max_lock_seconds: 1 })).not.toBe(h);
    expect(contractHash({ ...f.contract, safety_margin_seconds: 1 })).not.toBe(h);
  });
  it("verdict signing string", () => {
    expect(signingString("VERDICT", f.verdict)).toBe(
      "verdict:v0:VERDICT:57b09184f2abc75906b86e7f10aa898f9e9ba3b355499e97179e28a66f0a81e5",
    );
  });
  it("dirHash", () => {
    const files = [
      { path: "verify.sh", bytes: Buffer.from("#!/bin/sh\nexit 0\n") },
      { path: "fixtures/a.csv", bytes: Buffer.from("a,b\n1,2\n") },
      { path: "B.txt", bytes: new Uint8Array() },
    ];
    const want = "bb61735c677f632f560e15fb8d0fc0c1b41524fab94e827596485c3771ee9ab4";
    expect(dirHash(files)).toBe(want);
    expect(dirHash([...files].reverse())).toBe(want);
  });
});

describe("signature coverage", () => {
  it("signatures never cover themselves", () => {
    expect(hashUnsigned(f.contract)).toBe(
      hashUnsigned({ ...f.contract, signatures: { buyer: "x" } }),
    );
    expect(hashUnsigned(f.verdict)).toBe(hashUnsigned({ ...f.verdict, verifier_sig: "y" }));
    expect(hashUnsigned(f.root)).toBe(hashUnsigned({ ...f.root, signature: "z" }));
    expect(hashUnsigned(f.root)).not.toBe(hashUnsigned({ ...f.root, max_total: "9.00" }));
  });
  it("capId ignores cap_id and signature", () => {
    expect(capId({ ...f.root, cap_id: "cap_0000000000000000", signature: "q" })).toBe(
      capId(f.root),
    );
  });
  it("signingString domain-separates types and validates type", () => {
    expect(signingString("A", f.root)).not.toBe(signingString("B", f.root));
    expect(() => signingString("bad:type", f.root)).toThrow();
  });
});
