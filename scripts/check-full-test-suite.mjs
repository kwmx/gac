import { spawnSync } from "node:child_process";

const result = spawnSync("node", ["--test", "--test-reporter=spec"], {
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log("full test suite passed");
