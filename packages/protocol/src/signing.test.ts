import { describe, expect, it } from "vitest";
import * as f from "./fixtures.js";
import {
  createEd25519Signer,
  openPreimage,
  registerSchemeVerifier,
  sealPreimage,
  signingString,
  signPayload,
  verifyPayload,
  verifySignature,
} from "./index.js";

const seed = new Uint8Array(32).fill(7);

describe("ed25519", () => {
  it("signs and verifies; fails closed on tamper, wrong key, wrong scheme, garbage", async () => {
    const s = await createEd25519Signer(seed);
    const other = await createEd25519Signer(new Uint8Array(32).fill(8));
    const sig = await s.sign("hello");
    expect(sig).toMatch(/^[0-9a-f]{128}$/);
    expect(await verifySignature("ed25519", s.publicId, "hello", sig)).toBe(true);
    expect(await verifySignature("ed25519", s.publicId, "hellO", sig)).toBe(false);
    expect(await verifySignature("ed25519", other.publicId, "hello", sig)).toBe(false);
    expect(await verifySignature("eip191", s.publicId, "hello", sig)).toBe(false);
    expect(await verifySignature("ed25519", s.publicId, "hello", "zz")).toBe(false);
    expect(await verifySignature("ed25519", "ed25519:abc", "hello", sig)).toBe(false);
  });
  it("golden: deterministic public id and signature for a fixed seed", async () => {
    const s = await createEd25519Signer(seed);
    expect(s.publicId).toMatch(/^ed25519:[0-9a-f]{64}$/);
    expect(await s.sign("verdict")).toBe(await s.sign("verdict"));
  });
  it("signPayload / verifyPayload bind type and content", async () => {
    const s = await createEd25519Signer(seed);
    const sig = await signPayload(s, "VERDICT", f.verdict);
    expect(await verifyPayload("VERDICT", f.verdict, s.publicId, sig)).toBe(true);
    expect(await verifyPayload("VERDICT", { ...f.verdict, attempt: 2 }, s.publicId, sig)).toBe(
      false,
    );
    expect(await verifyPayload("OTHER", f.verdict, s.publicId, sig)).toBe(false);
    expect(
      await verifyPayload("VERDICT", { ...f.verdict, verifier_sig: "x" }, s.publicId, sig),
    ).toBe(true);
    expect(await verifyPayload("VERDICT", f.verdict, "nonsense", sig)).toBe(false);
    expect(signingString("VERDICT", f.verdict)).toContain("verdict:v0:VERDICT:");
  });
});

describe("eip191", () => {
  it("fails closed until a verifier is registered", async () => {
    expect(await verifySignature("eip191", f.EVM_A, "m", f.SIG_EVM)).toBe(false);
    registerSchemeVerifier(
      "eip191",
      (id, m, sig) => id === f.EVM_A && m === "m" && sig === f.SIG_EVM,
    );
    expect(await verifySignature("eip191", f.EVM_A, "m", f.SIG_EVM)).toBe(true);
    expect(await verifySignature("eip191", f.EVM_B, "m", f.SIG_EVM)).toBe(false);
    registerSchemeVerifier("eip191", () => {
      throw new Error("boom");
    });
    expect(await verifySignature("eip191", f.EVM_A, "m", f.SIG_EVM)).toBe(false);
  });
});

describe("sealed preimage", () => {
  it("round-trips to the verifier key and has the expected length", async () => {
    const v = await createEd25519Signer(seed);
    const p = "ab".repeat(32);
    const sealed = await sealPreimage(p, v.publicId);
    expect(sealed).toHaveLength(108);
    expect(await openPreimage(sealed, seed)).toBe(p);
    await expect(openPreimage(sealed, new Uint8Array(32).fill(9))).rejects.toThrow();
    await expect(sealPreimage("00", v.publicId)).rejects.toThrow();
  });
});
