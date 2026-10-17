import { createEd25519Signer, rootCapabilitySchema, verifyPayload } from "@verdict/protocol";
import { expect, test } from "vitest";
import { buildSignerServer } from "./server.js";

const ASSET = "rgb:test-asset";
const W1 = `eip191:0x${"1".repeat(40)}`;
const NOW = new Date("2026-10-18T15:00:00Z");
const H = { "x-verdict-ui": "1" };

async function setup() {
  const principal = await createEd25519Signer(new Uint8Array(32).fill(1));
  const app = buildSignerServer({
    logger: false,
    signer: principal,
    principalId: principal.publicId,
    assetId: ASSET,
    now: () => NOW,
  });
  const goal = "Pay a worker up to 5.00 tUSD, at most 2.00 per task";
  const proposal = {
    max_total: "5.00",
    max_per_task: "2.00",
    expires_at: "2026-10-18T17:00:00Z",
    allowed_actions: ["task_payment"],
    allowed_categories: ["code"],
    allowed_payees: [{ name: "w1", id: W1 }],
  };
  return { app, principal, proposal, goal };
}
const post = (
  app: ReturnType<typeof buildSignerServer>,
  payload: Record<string, unknown>,
  headers: Record<string, string> = H,
) => app.inject({ method: "POST", url: "/sign-root", payload, headers });

test("signs a root built from a proposal; the signature verifies", async () => {
  const { app, proposal, principal, goal } = await setup();
  const r = await post(app, { proposal, goal });
  expect(r.statusCode).toBe(200);
  const root = rootCapabilitySchema.parse(r.json().root);
  expect(root.issuer).toBe(principal.publicId);
  expect(root.asset_id).toBe(ASSET);
  expect(root.allowed_payees).toEqual([W1]);
  expect(await verifyPayload("CAP_ROOT", root, principal.publicId, root.signature)).toBe(true);
});

test("a ready-made root is signed too, but only for this issuer and asset", async () => {
  const { app, proposal, principal, goal } = await setup();
  const root = (await post(app, { proposal, goal })).json().root as Record<string, unknown>;
  const { cap_id: _c, signature: _s, ...body } = root;
  expect((await post(app, { root: body, goal })).statusCode).toBe(200);
  const foreign = await post(app, {
    root: { ...body, issuer: `eip191:0x${"9".repeat(40)}` },
    goal,
  });
  expect(foreign.statusCode).toBe(422);
  const asset = await post(app, { root: { ...body, asset_id: "rgb:other" }, goal });
  expect(asset.statusCode).toBe(422);
  expect(principal.publicId).toBe(body.issuer);
});

test("missing UI header is refused", async () => {
  const { app, proposal, goal } = await setup();
  const r = await post(app, { proposal, goal }, {});
  expect(r.statusCode).toBe(403);
  expect(r.json().code).toBe("UI_ONLY");
});

test("a request without the goal text signs nothing", async () => {
  const { app, proposal } = await setup();
  expect((await post(app, { proposal })).statusCode).toBe(400);
});

test("mandate over the hard limits is refused", async () => {
  const { app, proposal, goal } = await setup();
  const big = { ...proposal, max_total: "900.00", max_per_task: "2.00" };
  const r = await post(app, { proposal: big, goal: `${goal} 900.00` });
  expect(r.statusCode).toBe(422);
  expect(r.json().code).toBe("ROOT_OVER_HARD_LIMIT");
});

test("an amount the goal never mentions is flagged by the signer itself, whatever the client says", async () => {
  const { app, proposal, goal } = await setup();
  const odd = { ...proposal, max_total: "50.00" };
  // The client claims "not flagged" and "already confirmed": both are ignored.
  const r = await post(app, { proposal: odd, goal, flagged: false, second_confirm: true });
  expect(r.statusCode).toBe(428);
  expect(r.json().code).toBe("SECOND_CONFIRM_REQUIRED");
  expect(r.json().root).toBeUndefined();
  expect(typeof r.json().confirm_token).toBe("string");
  const again = await post(app, { proposal: odd, goal, second_confirm: true, confirm_token: "x" });
  expect(again.statusCode).toBe(428);
});

test("second call with the token signs; the token is single use", async () => {
  const { app, proposal, goal } = await setup();
  const odd = { ...proposal, max_total: "50.00" };
  const token = (await post(app, { proposal: odd, goal })).json().confirm_token as string;
  const ok = await post(app, { proposal: odd, goal, confirm_token: token });
  expect(ok.statusCode).toBe(200);
  const reused = await post(app, { proposal: odd, goal, confirm_token: token });
  expect(reused.statusCode).toBe(428);
});

test("a token is bound to its root: another mandate cannot use it", async () => {
  const { app, proposal, goal } = await setup();
  const odd = { ...proposal, max_total: "50.00" };
  const other = { ...proposal, max_total: "60.00" };
  const token = (await post(app, { proposal: odd, goal })).json().confirm_token as string;
  const r = await post(app, { proposal: other, goal, confirm_token: token });
  expect(r.statusCode).toBe(428);
  // and the token was burnt by the failed attempt
  expect((await post(app, { proposal: odd, goal, confirm_token: token })).statusCode).toBe(428);
});

test("an expired token (120 s) is refused", async () => {
  let t = Date.parse("2026-10-18T15:00:00Z");
  const principal = await createEd25519Signer(new Uint8Array(32).fill(1));
  const app = buildSignerServer({
    logger: false,
    signer: principal,
    principalId: principal.publicId,
    assetId: ASSET,
    now: () => new Date(t),
  });
  const proposal = {
    max_total: "50.00",
    max_per_task: "2.00",
    expires_at: "2026-10-18T17:00:00Z",
    allowed_actions: ["task_payment"],
    allowed_categories: ["code"],
    allowed_payees: [{ name: "w1", id: W1 }],
  };
  const goal = "Spend 2.00 tUSD per task";
  const token = (await post(app, { proposal, goal })).json().confirm_token as string;
  t += 121_000;
  expect((await post(app, { proposal, goal, confirm_token: token })).statusCode).toBe(428);
});

test("nonsense and a key that does not match the trusted id sign nothing", async () => {
  const { app, principal, goal } = await setup();
  expect((await post(app, { proposal: { nonsense: 1 }, goal })).statusCode).toBe(400);
  const other = await createEd25519Signer(new Uint8Array(32).fill(7));
  const mismatched = buildSignerServer({
    logger: false,
    signer: other,
    principalId: principal.publicId,
    assetId: ASSET,
    now: () => NOW,
  });
  const { proposal } = await setup();
  expect((await post(mismatched, { proposal, goal })).statusCode).toBe(500);
});

test("localOnly: only the console origin gets CORS, foreign hosts and origins are refused", async () => {
  const principal = await createEd25519Signer(new Uint8Array(32).fill(1));
  const app = buildSignerServer({
    logger: false,
    signer: principal,
    principalId: principal.publicId,
    assetId: ASSET,
    localOnly: { port: 7403, uiOrigins: ["http://localhost:5173"] },
  });
  const pre = (headers: Record<string, string>) =>
    app.inject({ method: "OPTIONS", url: "/sign-root", headers });
  const ok = await pre({ host: "localhost:7403", origin: "http://localhost:5173" });
  expect(ok.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  expect((await pre({ host: "localhost:7403", origin: "https://evil.example" })).statusCode).toBe(
    403,
  );
  expect((await pre({ host: "evil.example:7403" })).statusCode).toBe(403);
});
