// Runs every tests/*.test.ts except functional.test.ts (browser tests, see test:functional).
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const files = readdirSync("tests")
  .filter((f) => f.endsWith(".test.ts") && f !== "functional.test.ts")
  .sort()
  .map((f) => `tests/${f}`);

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
