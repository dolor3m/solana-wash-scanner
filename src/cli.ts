import { runScan } from "./lib/wash/scan.ts";

const query = process.argv[2];
if (!query) {
  console.error("Usage: node --experimental-strip-types src/cli.ts <mint-or-ticker>");
  process.exit(1);
}

try {
  const report = await runScan(query);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : "Scan failed.";
  console.error(message);
  process.exit(1);
}
