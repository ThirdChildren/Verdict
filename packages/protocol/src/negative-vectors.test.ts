import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as f from "./fixtures.js";
import {
  AmountError,
  amountString,
  createEd25519Signer,
  dirHash,
  envelopeSchema,
  hashObj,
  hashUnsigned,
  parseAmount,
  payeesAttenuate,
  paymentHash,
  positiveAmountString,
  publicId,
  signatureString,
  signingString,
  signPayload,
  stripSignatures,
  taskContractSchema,
  verifyPayload,
  verifySignature,
} from "./index.js";

const b = (s: string) => new Uint8Array(Buffer.from(s));
const buyer = await createEd25519Signer(new Uint8Array(32).fill(1));
const worker = await createEd25519Signer(new Uint8Array(32).fill(2));

type Env = Record<string, unknown> & { body: Record<string, unknown> };
const unsignedEnv = (): Env => ({
  v: 0,
  id: "123e4567-e89b-42d3-a456-426614174000",
  type: "CLAIMED",
  task_id: "task_0123456789abcdef",
  from: buyer.publicId,
  to: worker.publicId,
  sent_at: "2026-10-18T16:00:00Z",
  body: { payment_hash: f.HASH("f") },
});
const sign = async (e: Env) => ({ ...e, sig: await signPayload(buyer, e.type as string, e) });
const verify = (e: Env & { sig: string }) =>
  verifyPayload(e.type as string, e, e.from as string, e.sig);

describe("envelope signature binds every field", () => {
  it("verifies an untouched signed envelope", async () => {
    expect(await verify(await sign(unsignedEnv()))).toBe(true);
  });
  const mutations: Record<string, (e: Env) => Env> = {
    to: (e) => ({ ...e, to: buyer.publicId }),
    task_id: (e) => ({ ...e, task_id: "task_fedcba9876543210" }),
    type: (e) => ({ ...e, type: "APPROVE" }),
    sent_at: (e) => ({ ...e, sent_at: "2026-10-18T16:00:01Z" }),
    id: (e) => ({ ...e, id: "123e4567-e89b-42d3-a456-426614174001" }),
    from: (e) => ({ ...e, from: worker.publicId }),
    "nested body field": (e) => ({ ...e, body: { payment_hash: f.HASH("e") } }),
    "added body field": (e) => ({ ...e, body: { ...e.body, extra: 1 } }),
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    it(`fails verification when ${name} changes after signing`, async () => {
      const signed = await sign(unsignedEnv());
      expect(await verify(mutate(signed) as Env & { sig: string })).toBe(false);
    });
  }
  it("a type change alone breaks the signature even when the signing type is held fixed", async () => {
    const signed = await sign(unsignedEnv());
    expect(
      await verifyPayload("CLAIMED", { ...signed, type: "APPROVE" }, buyer.publicId, signed.sig),
    ).toBe(false);
  });
  it("any random single-field mutation of a signed envelope never verifies", async () => {
    const signed = await sign(unsignedEnv());
    const keys = ["id", "type", "task_id", "from", "to", "sent_at", "body"];
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...keys),
        fc.string({ minLength: 1, maxLength: 20 }),
        async (key, junk) => {
          const orig = JSON.stringify(signed[key as keyof typeof signed]);
          const value = key === "body" ? { payment_hash: junk } : `${junk}`;
          fc.pre(JSON.stringify(value) !== orig);
          const mutated = { ...signed, [key]: value } as Env & { sig: string };
          // "type" must stay a valid signing type or verifyPayload fails closed anyway (still false).
          expect(await verify(mutated)).toBe(false);
        },
      ),
      { numRuns: 60 },
    );
  });
  it("a signature from a different signer never verifies for the envelope sender", async () => {
    const e = unsignedEnv();
    const forged = { ...e, sig: await signPayload(worker, "CLAIMED", e) };
    expect(await verify(forged)).toBe(false);
  });
});

describe("contract signatures", () => {
  const unsigned = (() => {
    const { signatures: _s, ...rest } = f.contract;
    return rest;
  })();
  it("buyer and worker sign the same signing string", async () => {
    expect(signingString("TASK_CONTRACT", unsigned)).toBe(
      signingString("TASK_CONTRACT", { ...unsigned, signatures: { buyer: "x", worker: "y" } }),
    );
  });
  it("a buyer-key signature does not verify as the worker's and vice versa", async () => {
    const c = { ...unsigned, buyer: buyer.publicId, worker: worker.publicId };
    const sb = await signPayload(buyer, "TASK_CONTRACT", c);
    const sw = await signPayload(worker, "TASK_CONTRACT", c);
    expect(await verifyPayload("TASK_CONTRACT", c, c.buyer, sb)).toBe(true);
    expect(await verifyPayload("TASK_CONTRACT", c, c.worker, sw)).toBe(true);
    expect(await verifyPayload("TASK_CONTRACT", c, c.worker, sb)).toBe(false);
    expect(await verifyPayload("TASK_CONTRACT", c, c.buyer, sw)).toBe(false);
  });
  it("a contract with signatures stripped hashes the same as before signing", () => {
    expect(hashUnsigned(f.contract)).toBe(hashUnsigned(unsigned));
    expect(hashUnsigned({ ...f.contract, signatures: { buyer: f.SIG_ED } })).toBe(
      hashUnsigned(unsigned),
    );
  });
  it("stripSignatures removes only top-level signature fields", () => {
    const o = { signature: "a", signatures: {}, sig: "b", verifier_sig: "c", keep: 1 };
    expect(stripSignatures(o)).toEqual({ keep: 1 });
  });
  it("a nested object keyed sig / signature / verifier_sig stays covered by the hash (intended: only top level is stripped)", () => {
    for (const k of ["sig", "signature", "signatures", "verifier_sig"]) {
      const a = { ...unsigned, task: { ...unsigned.task, [k]: "one" } };
      const c = { ...unsigned, task: { ...unsigned.task, [k]: "two" } };
      expect(stripSignatures(a)).toHaveProperty("task");
      expect(hashUnsigned(a)).not.toBe(hashUnsigned(c));
      expect(hashUnsigned(a)).not.toBe(hashUnsigned(unsigned));
    }
  });
  it("a top-level signature key cannot be used to smuggle unsigned data into the hash", () => {
    expect(hashUnsigned({ ...unsigned, sig: "anything", verifier_sig: "z" })).toBe(
      hashUnsigned(unsigned),
    );
  });
});

describe("hex and signature encoding", () => {
  it("rejects uppercase hex in a public id, a signature and a payment hash", () => {
    expect(publicId.safeParse(`ed25519:${"C".repeat(64)}`).success).toBe(false);
    expect(publicId.safeParse(`eip191:0x${"A".repeat(40)}`).success).toBe(false);
    expect(signatureString.safeParse("A".repeat(128)).success).toBe(false);
    expect(signatureString.safeParse(`0x${"A".repeat(130)}`).success).toBe(false);
    expect(paymentHash.safeParse("F".repeat(64)).success).toBe(false);
    expect(
      taskContractSchema.safeParse({ ...f.contract, buyer: `eip191:0x${"A".repeat(40)}` }).success,
    ).toBe(false);
    expect(
      envelopeSchema.safeParse({
        ...unsignedEnv(),
        sig: "A".repeat(128),
        body: { payment_hash: f.HASH("f") },
      }).success,
    ).toBe(false);
  });
  it("returns false, never throws, for ed25519 signatures of wrong length or with trailing bytes", async () => {
    const sig = await buyer.sign("m");
    const bad = [
      sig.slice(0, 126),
      `${sig}00`,
      `${sig}0`,
      "",
      sig.toUpperCase(),
      `0x${sig}`,
      ` ${sig}`,
      `${sig}\n`,
      "g".repeat(128),
    ];
    for (const s of bad) {
      expect(await verifySignature("ed25519", buyer.publicId, "m", s)).toBe(false);
    }
  });
  it("returns false for an ed25519 signature with a non-canonical S (S + L) that libsodium rejects", async () => {
    const sig = await buyer.sign("m");
    // Add the group order L to S (little-endian bytes 32..63): classic malleability vector.
    const L = (1n << 252n) + 27742317777372353535851937790883648493n;
    const sBytes = sig.slice(64).match(/../g) as string[];
    const s = BigInt(`0x${[...sBytes].reverse().join("")}`);
    const mall = s + L;
    const hex = mall.toString(16).padStart(64, "0").match(/../g) as string[];
    const forged = sig.slice(0, 64) + [...hex].reverse().join("");
    expect(forged).toHaveLength(128);
    expect(await verifySignature("ed25519", buyer.publicId, "m", forged)).toBe(false);
  });
  it("returns false for an ed25519 public id that is truncated, uppercase or has a trailing byte", async () => {
    const sig = await buyer.sign("m");
    const raw = buyer.publicId;
    for (const id of [raw.slice(0, -2), `${raw}00`, `ed25519:${raw.slice(8).toUpperCase()}`]) {
      expect(await verifySignature("ed25519", id, "m", sig)).toBe(false);
    }
  });
});

describe("dirhash edge cases (pinned until the next protocol bump)", () => {
  // Security review recommendation: reject lone surrogates (and ideally require NFC) in paths.
  // Current behaviour is pinned below; if dirHash starts rejecting them, update these tests with the protocol bump.
  it("accepts a lone surrogate in a path today; TextEncoder maps it to U+FFFD so it collides with a literal U+FFFD path", () => {
    const lone = "a\uD800.txt";
    const repl = "a�.txt";
    expect(() => dirHash([{ path: lone, bytes: b("x") }])).not.toThrow();
    // The sort key is U+FFFD bytes, but the hashed line uses the raw string, which is also encoded by sha256Hex.
    expect(dirHash([{ path: lone, bytes: b("x") }])).toBe(dirHash([{ path: repl, bytes: b("x") }]));
  });
  it("two distinct lone-surrogate paths collapse to the same bytes, so they are not reported as duplicates today", () => {
    const files = [
      { path: "a\uD800", bytes: b("1") },
      { path: "a\uDC00", bytes: b("1") },
    ];
    expect(() => dirHash(files)).not.toThrow();
  });
  it("NFC and NFD forms of the same filename hash differently and do not collide", () => {
    const nfc = "é.txt";
    const nfd = "é.txt";
    expect(nfc.normalize("NFD")).toBe(nfd);
    expect(() => dirHash([{ path: nfc, bytes: b("x") }])).not.toThrow();
    expect(dirHash([{ path: nfc, bytes: b("x") }])).not.toBe(
      dirHash([{ path: nfd, bytes: b("x") }]),
    );
    expect(() =>
      dirHash([
        { path: nfc, bytes: b("x") },
        { path: nfd, bytes: b("x") },
      ]),
    ).not.toThrow();
  });
  it("a case-only collision pair is accepted and is case sensitive (A.txt differs from a.txt)", () => {
    const upper = { path: "A.txt", bytes: b("x") };
    const lower = { path: "a.txt", bytes: b("x") };
    expect(dirHash([upper])).not.toBe(dirHash([lower]));
    expect(() => dirHash([upper, lower])).not.toThrow();
    expect(dirHash([upper, lower])).toBe(dirHash([lower, upper]));
  });
});

describe("capability payee attenuation", () => {
  const parent = { allowed_payees: [f.EVM_A, f.EVM_B] };
  it("fails with the first offender when a child payee is outside the parent list", () => {
    const out = `ed25519:${"1".repeat(64)}`;
    expect(payeesAttenuate(parent, { allowed_payees: [f.EVM_A, out, "x"] })).toEqual({
      ok: false,
      payee: out,
    });
    expect(payeesAttenuate({ allowed_payees: [f.EVM_B] }, f.child)).toEqual({ ok: true });
    expect(payeesAttenuate({ allowed_payees: [f.EVM_A] }, f.child)).toEqual({
      ok: false,
      payee: f.EVM_B,
    });
  });
  it("passes when the child equals the parent or is a strict subset", () => {
    expect(payeesAttenuate(parent, parent)).toEqual({ ok: true });
    expect(payeesAttenuate(parent, { allowed_payees: [f.EVM_B] })).toEqual({ ok: true });
  });
  it("passes an empty child list in the helper (vacuously a subset); the child schema's min(1) is what rejects it", async () => {
    expect(payeesAttenuate(parent, { allowed_payees: [] })).toEqual({ ok: true });
    const { childCapabilitySchema } = await import("./index.js");
    expect(childCapabilitySchema.safeParse({ ...f.child, allowed_payees: [] }).success).toBe(false);
  });
  it("does not compare payees case-insensitively", () => {
    expect(
      payeesAttenuate({ allowed_payees: [f.EVM_A] }, { allowed_payees: [f.EVM_A.toUpperCase()] })
        .ok,
    ).toBe(false);
  });
  it("does not look at the legacy counterparties list (a diverging counterparties list is not checked here)", () => {
    const child = { allowed_payees: [f.EVM_A], counterparties: [`eip191:0x${"9".repeat(40)}`] };
    expect(payeesAttenuate({ allowed_payees: [f.EVM_A] }, child)).toEqual({ ok: true });
  });
});

describe("amount rejection vectors", () => {
  const badInputs = [
    "1e2",
    "0x10",
    "NaN",
    "+1.00",
    "-0",
    "-0.00",
    "1.000",
    " 1.00",
    "1.00 ",
    "1.0",
    "01.00",
    "1,00",
    "",
    ".50",
    "1.",
    "Infinity",
    "1.00\n",
  ];
  for (const s of badInputs) {
    it(`parseAmount at precision 2 rejects ${JSON.stringify(s)}`, () => {
      expect(() => parseAmount(s, 2)).toThrow(AmountError);
    });
  }
  it("the wire schema rejects exponent, hex, NaN, sign, whitespace and leading-zero forms", () => {
    for (const s of [
      "1e2",
      "0x10",
      "NaN",
      "+1.00",
      "-0",
      "-1.00",
      " 1.00",
      "1.00 ",
      "01.00",
      "1.",
      ".5",
      "1.1234567890123456789",
      "1",
    ]) {
      expect(amountString.safeParse(s).success).toBe(false);
    }
  });
  it("accepts zero and the maximum precision, and the positive schema refuses zero", () => {
    expect(parseAmount("0.00", 2)).toBe(0n);
    expect(parseAmount("0", 0)).toBe(0n);
    expect(parseAmount(`0.${"0".repeat(17)}1`, 18)).toBe(1n);
    expect(parseAmount(`123.${"9".repeat(18)}`, 18)).toBe(BigInt(`123${"9".repeat(18)}`));
    expect(amountString.safeParse("0.00").success).toBe(true);
    expect(amountString.safeParse(`1.${"0".repeat(18)}`).success).toBe(true);
    expect(positiveAmountString.safeParse("0.00").success).toBe(false);
  });
  it("precision above the protocol maximum is refused", () => {
    expect(() => parseAmount("1.0", 19)).toThrow(AmountError);
  });
  it("non-string inputs are rejected", () => {
    for (const v of [1, 1.5, null, undefined, 10n, {}]) {
      expect(() => parseAmount(v, 2)).toThrow(AmountError);
    }
  });
  it("any string that parses at precision 2 is canonical (round-trips through its own digits)", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        let v: bigint;
        try {
          v = parseAmount(s, 2);
        } catch {
          return true;
        }
        return /^(0|[1-9][0-9]*)\.[0-9]{2}$/.test(s) && v >= 0n;
      }),
      { numRuns: 500 },
    );
  });
});

describe("hashObj sanity for the vectors above", () => {
  it("hashObj is deterministic on key order", () => {
    expect(hashObj({ a: 1, b: 2 })).toBe(hashObj({ b: 2, a: 1 }));
  });
});
