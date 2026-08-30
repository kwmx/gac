import { spawnSync } from "node:child_process";

const result = spawnSync(
  "npm",
  ["test", "--", "test/tui.test.js", "test/configtui.test.js", "test/telemetrycli.test.js"],
  { stdio: "inherit" }
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log("focused ctrl-c regression tests passed");
