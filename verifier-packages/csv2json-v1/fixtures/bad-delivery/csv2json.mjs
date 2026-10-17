// Intentionally broken delivery: naive comma split (ignores quoting). Valid schema, no network, wrong output.
import { readFileSync } from "node:fs";

const file = process.argv[2];
const lines = readFileSync(file, "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "");
const [head = "", ...body] = lines;
const keys = head.split(",");
const out = body.map((l) => Object.fromEntries(keys.map((k, i) => [k, l.split(",")[i] ?? ""])));
process.stdout.write(`${JSON.stringify(out)}\n`);
