import { expect, test } from "vitest";
import { amountProblem, composeTaskGoal, defaultTaskAmount } from "./taskText.js";

test("default amount is 1.20, or what is left when that is less", () => {
  expect(defaultTaskAmount("3.80", 2)).toBe("1.20");
  expect(defaultTaskAmount("0.70", 2)).toBe("0.70");
  expect(defaultTaskAmount("0.00", 2)).toBe("0.00");
});

test("an amount above the remaining budget is refused with the remaining shown", () => {
  expect(amountProblem("5.00", "3.80", 2)).toContain("3.80");
  expect(amountProblem("3.80", "3.80", 2)).toBeNull();
  expect(amountProblem("0", "3.80", 2)).not.toBeNull();
  expect(amountProblem("abc", "3.80", 2)).not.toBeNull();
});

test("the composed text carries the exact task amount and none of the mandate wording", () => {
  const mandateText = "Paga fino a 5 tUSD in totale per lavori CSV";
  const t = composeTaskGoal("1.20", "worker", " convertire un file CSV in JSON ");
  expect(t).toBe("Paga 1.20 tUSD a worker per convertire un file CSV in JSON");
  expect(t).not.toContain("5");
  expect(t).not.toContain(mandateText);
});

import { workerNameFor } from "../components/NewTaskButton.js";

test("worker display name comes from the signed mandate, else 'worker'", () => {
  expect(workerNameFor(["0xabc"], { "0xabc": "worker-1" })).toBe("worker-1");
  expect(workerNameFor(["0xabc"], {})).toBe("worker");
  expect(workerNameFor([], {})).toBe("worker");
});
