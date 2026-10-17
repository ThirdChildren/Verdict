// pnpm net:info - non-secret network facts. Exit 1 if network.json is missing.
import { dataDir, netInfo } from "../packages/wallet/src/index.js";

try {
  console.log(JSON.stringify(netInfo(dataDir()), null, 2));
} catch (e) {
  console.error(`[net:info] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
