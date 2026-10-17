// Reference delivery: RFC 4180-style CSV to JSON array of objects. Zero dependencies.
import { readFileSync } from "node:fs";

export function parse(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 2;
        continue;
      }
      if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
    i++;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  const [header = [], ...body] = rows;
  return body
    .filter((r) => !(r.length === 1 && r[0] === ""))
    .map((r) => Object.fromEntries(header.map((h, k) => [h, r[k] ?? ""])));
}

const file = process.argv[2];
if (!file) {
  console.error("usage: node csv2json.mjs <input.csv>");
  process.exit(2);
}
process.stdout.write(`${JSON.stringify(parse(readFileSync(file, "utf8")))}\n`);
