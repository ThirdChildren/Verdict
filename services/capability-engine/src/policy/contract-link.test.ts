import { describe, expect, it } from "vitest";
import { checkContractLink } from "./checkContractLink.js";
import * as k from "./testkit.js";

const accepted = {
  intentSha256: k.contract.intent_sha256,
  capHash: k.contract.capability_hash,
  intent: k.intent,
  signedBy: "ed25519:holder",
};
const ctx = { precision: k.P, holder: "ed25519:holder", accepted };

describe("checkContractLink", () => {
  it("allows a contract that matches its intent", () => {
    expect(checkContractLink(k.contract, ctx).ok).toBe(true);
  });
  it("refuses an unknown intent", () => {
    expect(checkContractLink(k.contract, { ...ctx, accepted: undefined })).toMatchObject({
      ok: false,
      code: "MALFORMED_INTENT",
    });
  });
  it("refuses an intent not signed by the holder", () => {
    expect(checkContractLink(k.contract, { ...ctx, holder: "ed25519:someone-else" })).toMatchObject(
      { ok: false, code: "SIGNATURE_INVALID" },
    );
  });
  it("refuses a different capability, worker, amount, category or a later deadline", () => {
    const c = k.contract;
    expect(checkContractLink({ ...c, capability_hash: "d".repeat(64) }, ctx)).toMatchObject({
      code: "PARENT_MISMATCH",
    });
    expect(checkContractLink({ ...c, worker: "ed25519:other" }, ctx)).toMatchObject({
      code: "COUNTERPARTY_NOT_ALLOWED",
    });
    expect(
      checkContractLink({ ...c, payment: { ...c.payment, amount: "1.21" } }, ctx),
    ).toMatchObject({ code: "MALFORMED_INTENT" });
    expect(
      checkContractLink({ ...c, task: { ...c.task, deadline: "2026-10-18T16:16:00Z" } }, ctx),
    ).toMatchObject({ code: "MALFORMED_INTENT" });
  });
});
