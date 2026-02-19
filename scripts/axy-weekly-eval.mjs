#!/usr/bin/env node

import path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const part = argv[i];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function pct(part, total) {
  if (!total) return "0.0%";
  return `${((part / total) * 100).toFixed(1)}%`;
}

function fmtNum(value) {
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString("en-US") : "0";
}

async function main() {
  const args = parseArgs(process.argv);
  const input = path.resolve(
    process.cwd(),
    String(args.input || args["eval-file"] || "logs/axy-eval.json")
  );
  const output = path.resolve(
    process.cwd(),
    String(args.output || "logs/axy-weekly-eval.md")
  );

  const raw = await readFile(input, "utf8");
  const json = JSON.parse(raw);

  const core = json?.core || {};
  const governor = json?.governor || {};
  const counters = core?.counters || {};
  const sentByChannel = counters?.sentByChannel || {};
  const skippedByReason = counters?.skippedByReason || {};
  const blockedByReason = governor?.blockedByReason || {};
  const totalSent = Object.values(sentByChannel).reduce((sum, v) => sum + Number(v || 0), 0);
  const totalBlocked = Number(governor?.blocked || 0);
  const duplicateBlocked =
    Number(blockedByReason["duplicate-local"] || 0) +
    Number(blockedByReason["duplicate-global"] || 0);
  const styleBlocked = Number(blockedByReason["style-repeat"] || 0);
  const cooldownBlocked = Number(blockedByReason["cooldown"] || 0);
  const budgetBlocked = Number(blockedByReason["hourly-budget"] || 0);

  const lines = [
    "# Axy Weekly Eval",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Source: \`${input}\``,
    "",
    "## Summary",
    `- Sent outputs: **${fmtNum(totalSent)}**`,
    `- Governor blocks: **${fmtNum(totalBlocked)}**`,
    `- Duplicate blocks: **${fmtNum(duplicateBlocked)}** (${pct(duplicateBlocked, totalBlocked)})`,
    `- Style blocks: **${fmtNum(styleBlocked)}** (${pct(styleBlocked, totalBlocked)})`,
    `- Cooldown blocks: **${fmtNum(cooldownBlocked)}** (${pct(cooldownBlocked, totalBlocked)})`,
    `- Budget blocks: **${fmtNum(budgetBlocked)}** (${pct(budgetBlocked, totalBlocked)})`,
    "",
    "## Channel Throughput",
    ...Object.entries(sentByChannel)
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .map(([channel, count]) => `- ${channel}: ${fmtNum(count)}`),
    "",
    "## Skip Reasons",
    ...Object.entries(skippedByReason)
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .map(([reason, count]) => `- ${reason}: ${fmtNum(count)}`),
    "",
    "## Governor Blocks",
    ...Object.entries(blockedByReason)
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .map(([reason, count]) => `- ${reason}: ${fmtNum(count)}`),
    "",
    "## Health Signals",
    `- Duplicate pressure: ${duplicateBlocked > totalSent * 0.35 ? "high" : "normal"}`,
    `- Style pressure: ${styleBlocked > totalSent * 0.2 ? "high" : "normal"}`,
    `- Budget pressure: ${budgetBlocked > totalSent * 0.25 ? "high" : "normal"}`,
    "",
    "## Recommendation",
    budgetBlocked > totalSent * 0.25
      ? "- Increase channel budgets slightly or widen activity boost windows."
      : "- Keep current budgets; focus on reply quality iterations.",
    duplicateBlocked > totalSent * 0.3
      ? "- Expand topic diversity and reduce repeated prompt templates."
      : "- Duplicate guard is operating within expected range.",
    "",
  ];

  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, lines.join("\n"), "utf8");
  console.log(`weekly eval written: ${output}`);
}

main().catch((err) => {
  console.error(`weekly eval failed: ${err?.message || err}`);
  process.exit(1);
});

