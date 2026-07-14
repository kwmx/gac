// `gac telemetry [status|info|enable|disable]` command handler.
//
// Deliberately decoupled from terminal-kit: all output goes through the injected
// `write` function and confirmation through the injected async `confirm`, so the
// whole command is testable without a TTY. None of these paths makes a network
// request.

import { CONSENT_STATEMENT } from "./telemetry/consent.js";

export const TELEMETRY_SUBCOMMANDS = ["status", "info", "enable", "disable"];

function fmt(value) {
  return value === null || value === undefined ? "(none)" : String(value);
}

function printStatus(telemetry, write) {
  const s = telemetry.getStatus();
  const lines = [];
  lines.push("GAC telemetry status");
  lines.push(`  Saved state:         ${s.savedDecision}`);
  lines.push(`  Effective state:     ${s.effectiveState}`);
  lines.push(`  Consent version:     ${s.consentVersion}`);
  lines.push(`  Notice version:      ${s.noticeVersion}`);
  lines.push(`  Ingestion endpoint:  ${s.ingestEndpoint}`);
  lines.push(`  Contract endpoint:   ${s.contractEndpoint}`);
  lines.push(`  Local queue count:   ${s.queueCount}`);
  lines.push(`  Approx queue size:   ${s.queueBytes} bytes`);
  lines.push(`  Last success:        ${fmt(s.lastSuccessAt)}`);
  lines.push(`  Last failure:        ${fmt(s.lastFailureAt)}`);
  lines.push(`  Last failure kind:   ${fmt(s.lastFailureCategory)}`);
  lines.push(`  Next eligible retry: ${fmt(s.nextAttemptAt)}`);
  const active = s.suppression.reasons;
  const flag = (name) => (active.includes(name) ? "yes" : "no");
  lines.push("  Suppressed by:");
  lines.push(`    CI:                    ${flag("CI")}`);
  lines.push(`    DO_NOT_TRACK:          ${flag("DO_NOT_TRACK")}`);
  lines.push(`    DNT:                   ${flag("DNT")}`);
  lines.push(`    GAC_TELEMETRY_DISABLED: ${flag("GAC_TELEMETRY_DISABLED")}`);
  write(lines.join("\n") + "\n");
}

function hasYesFlag(args) {
  return args.some((a) => a === "--yes" || a === "-y");
}

async function runEnable(args, telemetry, deps) {
  const { write, confirm, interactive } = deps;
  const yes = hasYesFlag(args);

  if (!interactive && !yes) {
    write(
      "Refusing to enable telemetry without confirmation in a non-interactive shell.\n" +
        "Re-run with: gac telemetry enable --yes\n"
    );
    return 1;
  }

  // Always show the full statement before enabling.
  write(CONSENT_STATEMENT + "\n\n");

  if (!yes) {
    const ok = await confirm("Enable telemetry? [y/N] ");
    if (!ok) {
      write("Telemetry not enabled.\n");
      return 0;
    }
  }

  await telemetry.enable({ action: "manual_command" });
  write(
    "Telemetry enabled. Thank you — this helps prioritize features and improve reliability.\n" +
      "Disable any time with: gac telemetry disable\n"
  );
  return 0;
}

async function runDisable(telemetry, deps) {
  const { write } = deps;
  await telemetry.disable();
  write(
    "Telemetry disabled. Queued events and the local installation identifier were removed.\n" +
      "Already-accepted aggregate data cannot be retroactively removed.\n"
  );
  return 0;
}

// Returns a numeric exit code (0 success, nonzero failure). Never throws.
export async function runTelemetryCommand(args, telemetry, deps) {
  const write = deps.write;
  const sub = (args[0] || "status").toLowerCase();

  if (sub === "status") {
    printStatus(telemetry, write);
    return 0;
  }
  if (sub === "info") {
    write(telemetry.info() + "\n");
    return 0;
  }
  if (sub === "enable") {
    return runEnable(args.slice(1), telemetry, deps);
  }
  if (sub === "disable") {
    return runDisable(telemetry, deps);
  }

  write(
    `Unknown telemetry subcommand "${sub}". Usage: gac telemetry <status|info|enable|disable>\n`
  );
  return 1;
}
