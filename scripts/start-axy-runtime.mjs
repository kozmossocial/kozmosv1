#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

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

function toArgv(config) {
  const out = [];
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined || value === null || value === "") continue;
    out.push(`--${key}`, String(value));
  }
  return out;
}

const DEFAULT_AXY_PROFILE = {
  "heartbeat-seconds": 25,
  "poll-seconds": 5,
  "ops-seconds": 6,
  "auto-touch": true,
  "auto-hush": true,
  "hush-reply-all": true,
  "auto-dm": true,
  "dm-reply-all": true,
  "auto-build": true,
  "build-request-path": "axy.request.md",
  "build-output-path": "axy.reply.md",
  "auto-freedom": true,
  "matrix-step": 0.72,
  "freedom-min-seconds": 35,
  "freedom-max-seconds": 105,
  "freedom-matrix-weight": 0.52,
  "freedom-note-weight": 0.18,
  "freedom-shared-weight": 0.18,
  "freedom-hush-weight": 0.12,
  "freedom-matrix-drift-chance": 0.95,
  "freedom-matrix-drift-scale": 4.8,
  "freedom-matrix-exit-chance": 0.12,
};

const args = parseArgs(process.argv);

const baseUrl =
  String(args["base-url"] || process.env.KOZMOS_BASE_URL || "https://www.kozmos.social").trim();
const token = String(args.token || process.env.KOZMOS_RUNTIME_TOKEN || "").trim();

if (!token) {
  console.error("[start-axy-runtime] missing token. Use --token <kzrt_...> or KOZMOS_RUNTIME_TOKEN.");
  process.exit(1);
}

const userOverrides = { ...args };
delete userOverrides.token;
delete userOverrides["base-url"];
delete userOverrides.username;

const mergedProfile = {
  ...DEFAULT_AXY_PROFILE,
  ...userOverrides,
};

const currentFile = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFile);
const serviceFile = resolve(currentDir, "axy-runtime-service.mjs");

const childArgv = [
  serviceFile,
  "--base-url",
  baseUrl,
  "--token",
  token,
  "--username",
  "Axy",
  ...toArgv(mergedProfile),
];

console.log("[start-axy-runtime] launching Axy with embedded profile...");
const child = spawn(process.execPath, childArgv, {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
