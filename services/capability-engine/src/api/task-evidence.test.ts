import { capabilityHash, contractHash, createEd25519Signer } from "@verdict/protocol";
import { describe, expect, it } from "vitest";
import { bitcoindHeight, resolveBitcoindRpc } from "../chain.js";
import { EventBus } from "../events.js";
import { Ledger } from "../ledger/index.js";
import * as k from "../policy/testkit.js";
import { buildServer } from "../server.js";
import { chainFixtures } from "./task-evidence.fixtures.js";

const seed = (n: number) => new Uint8Array(32).fill(n);

async function setup(over: { height?: () => Promise<number> } = {}) {
  const [principal, engine, buyer] = await Promise.all(
    [1, 2, 3].map((n) => createEd25519Signer(seed(n))),
  );
  const ledger = Ledger.open(":memory:", k.P);
  const bus = new EventBus();
  const app = await buildServer({
    logger: false,
    ledger,
    bus,
    precision: k.P,
    now: () => k.NOW,
    identities: {
      principal: principal?.publicId ?? "",
      engine: engine?.publicId ?? "",
      buyer: buyer?.publicId ?? "",
    },
    ...(engine ? { engineSigner: engine } : {}),
    limits: { max_root_amount: "500.00", max_root_expiry_seconds: 86_400 },
    ...(over.height ? { chainHeight: over.height } : {}),
  });
  return { app, ledger, bus, principal: principal!, buyer: buyer! };
}

describe("GET /api/tasks/:id/evidence", () => {
  it("404 for an unknown task", async () => {
    const { app } = await setup();
    const r = await app.inject({ method: "GET", url: "/api/tasks/task_unknown/evidence" });
    expect(r.statusCode).toBe(404);
  });

  it("returns contract, hash and latest verdict, never a secret", async () => {
    const { app, ledger } = await setup();
    const f = chainFixtures();
    ledger.registerContract(f.verdict.payment_hash, f.verdict.task_id, f.contract, k.NOW);
    ledger.recordVerdict(f.verdict.payment_hash, 1, f.verdict, k.NOW);
    const r = await app.inject({ method: "GET", url: `/api/tasks/${f.verdict.task_id}/evidence` });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.contract_sha256).toBe(contractHash(f.contract as never));
    expect(j.verdict.delivery_sha256).toBe(f.verdict.delivery_sha256);
    expect(j.delivery).toBeNull();
    expect(r.body).not.toMatch(/preimage/i);
  });
});

describe("GET /api/tasks/:id/evidence intent", () => {
  it("returns the accepted intent and its hash, never the preimage", async () => {
    const { app, ledger } = await setup();
    const f = chainFixtures();
    const sha = "a".repeat(64);
    ledger.recordAcceptedIntent(sha, "c".repeat(64), k.intent, "eip191:0xabc", k.NOW);
    ledger.recordOffer(
      {
        intentSha256: sha,
        paymentHash: f.contract.payment.payment_hash,
        taskId: f.verdict.task_id,
        contract: f.contract,
        preimageHex: "b".repeat(64),
        sealedPreimage: "sealed",
      },
      k.NOW,
    );
    ledger.registerContract(f.verdict.payment_hash, f.verdict.task_id, f.contract, k.NOW);
    const r = await app.inject({ method: "GET", url: `/api/tasks/${f.verdict.task_id}/evidence` });
    const j = r.json();
    expect(j.intent).toEqual(JSON.parse(JSON.stringify(k.intent)));
    expect(j.intent_sha256).toBe(sha);
    expect(r.body).not.toMatch(/preimage/i);
    expect(r.body).not.toContain("b".repeat(64));
    expect(Object.keys(j)).not.toContain("preimage");
  });

  it("intent is null when the task has no accepted intent", async () => {
    const { app, ledger } = await setup();
    const f = chainFixtures();
    ledger.registerContract(f.verdict.payment_hash, f.verdict.task_id, f.contract, k.NOW);
    const j = (
      await app.inject({ method: "GET", url: `/api/tasks/${f.verdict.task_id}/evidence` })
    ).json();
    expect(j.intent).toBeNull();
    expect(j.intent_sha256).toBeNull();
  });
});

describe("GET /api/tasks", () => {
  it("is empty before any offer", async () => {
    const { app } = await setup();
    const r = await app.inject({ method: "GET", url: "/api/tasks" });
    expect(r.json()).toEqual({ tasks: [] });
  });

  it("lists each offered task with its description and amount, never a secret", async () => {
    const { app, ledger } = await setup();
    const f = chainFixtures();
    ledger.recordOffer(
      {
        intentSha256: "a".repeat(64),
        paymentHash: f.contract.payment.payment_hash,
        taskId: f.verdict.task_id,
        contract: f.contract,
        preimageHex: "b".repeat(64),
        sealedPreimage: "sealed",
      },
      k.NOW,
    );
    const r = await app.inject({ method: "GET", url: "/api/tasks" });
    expect(r.json()).toEqual({
      tasks: [
        {
          task_id: f.verdict.task_id,
          description: f.contract.task.spec,
          amount: f.contract.payment.amount,
        },
      ],
    });
    expect(r.body).not.toMatch(/preimage|sealed/i);
  });
});

describe("GET /api/chain", () => {
  it("503 without a height source", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "GET", url: "/api/chain" })).statusCode).toBe(503);
  });

  it("lists lock and expiry heights from the invoice's cltv blocks", async () => {
    const { app, ledger } = await setup({ height: async () => 250 });
    const f = chainFixtures();
    ledger.registerCapability(f.root, capabilityHash(f.root));
    ledger.registerCapability(f.child, capabilityHash(f.child), capabilityHash(f.root));
    ledger.reserve({
      capHash: capabilityHash(f.child),
      taskId: "task_a",
      paymentHash: "aa".repeat(32),
      amount: 100n,
      now: k.NOW,
    });
    ledger.recordLockBlocks("aa".repeat(32), 42);
    let j = (await app.inject({ method: "GET", url: "/api/chain" })).json();
    expect(j.height).toBe(250);
    expect(j.payments).toEqual([
      {
        task_id: "task_a",
        payment_hash: "aa".repeat(32),
        locked_at_height: null,
        expires_at_height: null,
      },
    ]);
    ledger.recordLockHeight("aa".repeat(32), 240);
    j = (await app.inject({ method: "GET", url: "/api/chain" })).json();
    expect(j.payments[0].locked_at_height).toBe(240);
    expect(j.payments[0].expires_at_height).toBe(282);
  });
});

it("bitcoindHeight reads getblockcount and fails closed on garbage", async () => {
  const ok = bitcoindHeight(
    resolveBitcoindRpc({}),
    (async () => new Response(JSON.stringify({ result: 7 }))) as never,
  );
  expect(await ok()).toBe(7);
  const bad = bitcoindHeight(
    resolveBitcoindRpc({}),
    (async () => new Response(JSON.stringify({ result: "x" }))) as never,
  );
  await expect(bad()).rejects.toThrow();
});

it("rpc settings: env overrides network.json, which overrides the defaults", () => {
  const facts = { bitcoind_rpc: { url: "http://10.0.0.5:18443", user: "u", password: "p" } };
  expect(resolveBitcoindRpc({}, facts)).toEqual(facts.bitcoind_rpc);
  expect(resolveBitcoindRpc({ BITCOIND_RPC_PASSWORD: "x" }, facts).password).toBe("x");
  expect(resolveBitcoindRpc({ BITCOIND_RPC_HOST: "h" }, facts).url).toBe("http://h:18443");
  expect(resolveBitcoindRpc({}).url).toBe("http://127.0.0.1:18443");
});
