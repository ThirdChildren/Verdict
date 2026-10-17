// Prints the directory hash (ARCHITECTURE 3.3) of a verifier package (default: csv2json-v1).
import { resolve } from "node:path";
import { dirHashFromDisk } from "../packages/protocol/src/node.js";

const dir = resolve(process.argv[2] ?? "verifier-packages/csv2json-v1");
console.log(await dirHashFromDisk(dir));
