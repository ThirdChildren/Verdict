import { expect, it } from "vitest";
import { mineUntilFailed } from "./demo-expire.js";

const status = (s: string) => [{ paymentHash: "a", role: "payer" as const, status: s }];

it("mines one block at a time until the payer reports Failed", async () => {
  let mined = 0;
  const wallet = {
    paymentStatus: async () => status(mined >= 3 ? "Failed" : "Pending"),
  } as never;
  const r = await mineUntilFailed(wallet, "a", { mine: () => mined++, pauseMs: 0 });
  expect(r).toMatchObject({ failed: true, blocks: 3 });
  expect(mined).toBe(3);
});

it("gives up at the cap", async () => {
  let mined = 0;
  const wallet = { paymentStatus: async () => status("Pending") } as never;
  const r = await mineUntilFailed(wallet, "a", { mine: () => mined++, cap: 5, pauseMs: 0 });
  expect(r).toMatchObject({ failed: false, blocks: 5 });
  expect(mined).toBe(5);
});

it("a wallet that has not seen the payment yet is not a failure", async () => {
  let mined = 0;
  const wallet = {
    paymentStatus: async () => {
      throw new Error("never seen");
    },
  } as never;
  const r = await mineUntilFailed(wallet, "a", { mine: () => mined++, cap: 2, pauseMs: 0 });
  expect(r.failed).toBe(false);
});
