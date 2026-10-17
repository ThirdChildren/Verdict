import { verifySignature } from "@verdict/protocol";
import { describe, expect, it, vi } from "vitest";
import { registerEip191Verifier } from "./eip191.js";

const ADDR = `0x${"ab".repeat(20)}`;
describe("eip191 verifier registration", () => {
  it("accepts when the recovered address matches and fails closed otherwise", async () => {
    registerEip191Verifier((m, s) =>
      s === "good" && m === "msg" ? ADDR.toUpperCase().replace("0X", "0x") : "0x0",
    );
    expect(await verifySignature("eip191", `eip191:${ADDR}`, "msg", "good")).toBe(true);
    expect(await verifySignature("eip191", `eip191:${ADDR}`, "msg", "bad")).toBe(false);
    expect(await verifySignature("eip191", `eip191:${ADDR}`, "other", "good")).toBe(false);
  });
});

describe("demo-mode startup guard", () => {
  it("refuses to start in demo mode without a registered eip191 verifier", async () => {
    vi.resetModules();
    const m = await import("./eip191.js");
    expect(() => m.assertEip191VerifierForMode({ VERDICT_MODE: "demo" })).toThrow(/eip191/);
    expect(() => m.assertEip191VerifierForMode({ VERDICT_MODE: "dev" })).not.toThrow();
    m.registerEip191Verifier(() => ADDR);
    expect(() => m.assertEip191VerifierForMode({ VERDICT_MODE: "demo" })).not.toThrow();
  });
});

describe("WDK-backed eip191 verifier (real signatures, no seed on the verify side)", () => {
  it("signs with a WDK account and verifies by address only", async () => {
    const { default: Manager } = await import("@tetherto/wdk-wallet-evm");
    const { verifyEip191WithWdk, eip191AddressFromSeed } = await import("./eip191-wdk.js");
    const seed = new Uint8Array(32).fill(7);
    const w = new Manager(seed, {});
    const sig = await (await w.getAccount(0)).sign("hello");
    w.dispose();
    const id = `eip191:${await eip191AddressFromSeed(seed)}`;
    expect(await verifyEip191WithWdk(id, "hello", sig)).toBe(true);
    expect(await verifyEip191WithWdk(id, "hellO", sig)).toBe(false);
    expect(await verifyEip191WithWdk(`eip191:0x${"00".repeat(20)}`, "hello", sig)).toBe(false);
    expect(await verifyEip191WithWdk(id, "hello", "0xnothex")).toBe(false);
  });
});
