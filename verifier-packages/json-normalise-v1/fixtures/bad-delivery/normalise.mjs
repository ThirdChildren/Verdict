// Flawed delivery: sorts only the top-level keys, nested objects keep their input order (fails the fixtures check only).
import { readFileSync } from "node:fs";

function number(n) {
  if (!Number.isFinite(n)) throw new Error("non-finite number");
  if (n === 0) return "0";
  const s = String(n);
  const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (!m) return s;
  const digits = m[2] + (m[3] ?? "");
  const point = m[2].length + Number(m[4]);
  let body;
  if (point <= 0) body = `0.${"0".repeat(-point)}${digits}`;
  else if (point >= digits.length) body = digits + "0".repeat(point - digits.length);
  else body = `${digits.slice(0, point)}.${digits.slice(point)}`;
  return m[1] + body;
}

function print(v, pad, top = false) {
  if (v === null) return "null";
  if (typeof v === "number") return number(v);
  if (typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
  const inner = `${pad}  `;
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    return `[\n${v.map((x) => inner + print(x, inner)).join(",\n")}\n${pad}]`;
  }
  const keys = top ? Object.keys(v).sort() : Object.keys(v);
  if (keys.length === 0) return "{}";
  return `{\n${keys.map((k) => `${inner}${JSON.stringify(k)}: ${print(v[k], inner)}`).join(",\n")}\n${pad}}`;
}

process.stdout.write(`${print(JSON.parse(readFileSync(process.argv[2], "utf8")), "", true)}\n`);
