#!/usr/bin/env node

/**
 * Axy-managed runtime bot service (single file)
 * - uses an existing runtime token (linked-user mode)
 * - heartbeat loop
 * - shared feed poll loop
 * - Axy reply generation
 * - post back to shared
 * - Axy ops loop (snapshot, keep-in-touch, hush chat, direct chats, build helper)
 */

import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import {
  ensureQuestionPunctuation,
  isNearDuplicate,
  normalizeIdeaKey,
  normalizeForSimilarity,
  pickBestMissionIdea,
  scoreMissionBundleQuality,
} from "../lib/axy-core.mjs";

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

function now() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function toFloat(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function trimSlash(url) {
  return String(url || "").replace(/\/+$/, "");
}

function must(value, label) {
  if (!value) {
    throw new Error(`missing required arg: ${label}`);
  }
  return value;
}

function randomRange(min, max) {
  if (max <= min) return min;
  return min + Math.random() * (max - min);
}

function randomIntRange(min, max) {
  return Math.floor(randomRange(min, max + 1));
}

function buildTriggerRegex(trigger, botUsername) {
  if (trigger) {
    return new RegExp(trigger, "i");
  }
  const escaped = botUsername.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)(@?${escaped}|axy)(\\s|$)`, "i");
}

function normalizeBuildPath(input) {
  return String(input || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

const MISSION_ROOT_PATH = "axy/published";
const MISSION_HISTORY_PATH = `${MISSION_ROOT_PATH}/_history.json`;
const MISSION_LATEST_PATH = `${MISSION_ROOT_PATH}/_latest.md`;

function slugify(input) {
  const slug = String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || `build-${Date.now()}`;
}

function pickCodeFence(text) {
  const raw = String(text || "");
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return match?.[1]?.trim() || raw.trim();
}

function extractJsonObject(raw) {
  const source = pickCodeFence(raw);
  if (!source) return null;
  try {
    return JSON.parse(source);
  } catch {
    const start = source.indexOf("{");
    const end = source.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(source.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function parseMissionHistory(content) {
  if (!content) return [];
  try {
    const parsed = JSON.parse(String(content));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((row) => ({
        title: String(row?.title || "").trim(),
        key: normalizeIdeaKey(row?.key || row?.title || ""),
        path: String(row?.path || "").trim(),
        created_at: String(row?.created_at || "").trim(),
      }))
      .filter((row) => row.title && row.key && row.path);
  } catch {
    return [];
  }
}

function harvestMissionHistoryFromFiles(files) {
  const harvested = [];
  for (const file of files) {
    const pathValue = normalizeBuildPath(file?.path || "");
    if (!pathValue.startsWith(`${MISSION_ROOT_PATH}/`) || !pathValue.endsWith("/README.md")) {
      continue;
    }
    const content = String(file?.content || "");
    const heading = content.match(/^#\s+(.+)$/m);
    const title = String(heading?.[1] || "").trim();
    if (!title) continue;
    const key = normalizeIdeaKey(title);
    if (!key) continue;
    harvested.push({
      title,
      key,
      path: pathValue.slice(0, -"README.md".length).replace(/\/+$/, ""),
      created_at: String(file?.updated_at || ""),
    });
  }
  return harvested;
}

async function runSessionBuildMission({
  baseUrl,
  token,
  botUsername,
  buildSpaceId,
  missionMaxIdeaAttempts,
  missionMaxBundleAttempts,
  missionHistoryLimit,
  missionNoRepeatDays,
  missionContext,
  onState,
}) {
  const setState = typeof onState === "function" ? onState : async () => {};
  await setState("mission_planning");
  let targetSpaceId = String(buildSpaceId || "").trim();

  if (!targetSpaceId) {
    const spacesRes = await callAxyOps(baseUrl, token, "build.spaces.list");
    const editable = (Array.isArray(spacesRes?.data) ? spacesRes.data : []).filter(
      (space) => space?.id && space?.can_edit === true
    );
    const preferred =
      editable.find(
        (space) => String(space?.title || "").trim().toLowerCase() === "axy published builds"
      ) ||
      editable.find((space) => /axy|lab|builder/i.test(String(space?.title || ""))) ||
      editable[0];
    if (preferred?.id) {
      targetSpaceId = String(preferred.id);
    }
  }

  if (!targetSpaceId) {
    const createRes = await callAxyOps(baseUrl, token, "build.spaces.create", {
      title: "Axy Published Builds",
      languagePref: "auto",
      description: "Axy mission outputs for Kozmos.",
    });
    targetSpaceId = String(createRes?.data?.id || "").trim();
  }
  if (!targetSpaceId) {
    throw new Error("mission build space missing");
  }

  const snapshotRes = await callAxyOps(baseUrl, token, "build.space.snapshot", {
    spaceId: targetSpaceId,
  });
  const snapshot = snapshotRes?.data || {};
  const files = Array.isArray(snapshot?.files) ? snapshot.files : [];
  if (snapshot?.can_edit !== true) {
    throw new Error("mission space not editable");
  }

  const historyFile = files.find(
    (file) => normalizeBuildPath(file?.path || "") === MISSION_HISTORY_PATH
  );
  const parsedHistory = parseMissionHistory(String(historyFile?.content || ""));
  const harvestedHistory = harvestMissionHistoryFromFiles(files);

  const historyByKey = new Map();
  [...parsedHistory, ...harvestedHistory].forEach((row) => {
    if (!row?.key) return;
    if (!historyByKey.has(row.key)) historyByKey.set(row.key, row);
  });
  const usedHistory = Array.from(historyByKey.values()).slice(0, missionHistoryLimit);
  const usedIdeaKeys = new Set(
    usedHistory.map((row) => normalizeIdeaKey(row.key || row.title || "")).filter(Boolean)
  );

  const nowMs = Date.now();
  const repeatWindowMs = Math.max(1, missionNoRepeatDays) * 24 * 60 * 60 * 1000;
  const recentHistory = usedHistory.filter((row) => {
    const t = Date.parse(String(row.created_at || ""));
    return Number.isFinite(t) ? nowMs - t <= repeatWindowMs : true;
  });
  const recentIdeaTitles = recentHistory.map((row) => row.title).filter(Boolean);

  const contextShared = Array.isArray(missionContext?.sharedTurns)
    ? missionContext.sharedTurns
        .slice(-20)
        .map((turn) => `${turn?.username || "user"}: ${String(turn?.text || "").trim()}`)
        .filter((line) => line.length > 3)
    : [];
  const contextNotes = Array.isArray(missionContext?.notes)
    ? missionContext.notes
        .slice(-10)
        .map((row) => String(row?.content || "").trim())
        .filter((line) => line.length > 3)
    : [];
  const contextBuildSpaces = Array.isArray(missionContext?.buildSpaces)
    ? missionContext.buildSpaces
        .slice(0, 12)
        .map((space) => {
          const title = String(space?.title || "").trim();
          const desc = String(space?.description || "").trim();
          return `${title}${desc ? ` - ${desc}` : ""}`.trim();
        })
        .filter(Boolean)
    : [];

  let plan = null;
  for (let attempt = 1; attempt <= missionMaxIdeaAttempts; attempt += 1) {
    const existingBlock = usedHistory.length
      ? usedHistory.slice(0, 120).map((row) => `- ${row.title}`).join("\n")
      : "- none";
    const sharedContextBlock = contextShared.length
      ? contextShared.slice(-12).map((line) => `- ${line}`).join("\n")
      : "- no recent shared prompts";
    const notesContextBlock = contextNotes.length
      ? contextNotes.slice(-8).map((line) => `- ${line}`).join("\n")
      : "- no recent private notes";
    const buildContextBlock = contextBuildSpaces.length
      ? contextBuildSpaces.map((line) => `- ${line}`).join("\n")
      : "- no visible user-build signals";

    const planPrompt = [
      "Create candidate Kozmos build missions and score them.",
      `Identity: ${botUsername}.`,
      "Return strict JSON only.",
      `Never repeat or clone any prior idea/title in this list:\n${existingBlock}`,
      `Recent shared conversation signals:\n${sharedContextBlock}`,
      `Recent private note signals:\n${notesContextBlock}`,
      `Current user-build ecosystem signals:\n${buildContextBlock}`,
      "JSON schema:",
      '{"ideas":[{"title":"...", "problem":"...", "goal":"...", "scope":["..."], "artifact_language":"typescript|javascript|markdown|sql|css|json", "publish_summary":"... (1 concise paragraph)", "utility":0-10, "implementability":0-10, "novelty":0-10}]}',
      "Rules:",
      "- return exactly 4 ideas",
      "- title must be novel and specific",
      "- practical utility for Kozmos users",
      "- scope must be deliverable in one session",
      "- publish_summary must be clear and concrete",
      "- scoring must be realistic, not inflated",
    ].join("\n\n");

    const rawPlan = await askAxy(baseUrl, planPrompt, {
      context: {
        channel: "build",
        conversationId: `build:mission:plan:${targetSpaceId}`,
        targetUsername: "kozmos-builders",
      },
    });

    const parsed = extractJsonObject(rawPlan);
    if (!parsed || typeof parsed !== "object") continue;
    const ideas = Array.isArray(parsed.ideas) ? parsed.ideas : [];

    const bestIdea = pickBestMissionIdea(ideas, {
      usedIdeaKeys: Array.from(usedIdeaKeys),
      usedIdeaTitles: recentIdeaTitles,
    });
    if (!bestIdea) continue;
    if (bestIdea.total < 6.4) continue;
    if (usedIdeaKeys.has(bestIdea.key)) continue;

    plan = {
      title: bestIdea.title,
      key: bestIdea.key,
      problem: bestIdea.problem,
      goal: bestIdea.goal,
      scope: bestIdea.scope.slice(0, 8),
      publishSummary: bestIdea.publishSummary.slice(0, 340),
      artifactLanguage: bestIdea.artifactLanguage || "markdown",
      ideaScores: {
        utility: bestIdea.utility,
        implementability: bestIdea.implementability,
        novelty: bestIdea.novelty,
        total: bestIdea.total,
      },
    };
    break;
  }

  if (!plan) {
    throw new Error("mission plan generation failed (unique idea not found)");
  }

  await setState("mission_building", {
    topic: plan.title,
    qualityScore: plan.ideaScores?.total || 0,
    outputPath: "",
  });

  let bundle = null;
  let bundleQuality = null;
  for (let attempt = 1; attempt <= missionMaxBundleAttempts; attempt += 1) {
    const bundlePrompt = [
      "Generate the mission output package for this build plan.",
      "Return strict JSON only.",
      `Plan title: ${plan.title}`,
      `Problem: ${plan.problem}`,
      `Goal: ${plan.goal}`,
      `Scope bullets: ${plan.scope.join(" | ")}`,
      `Artifact language target: ${plan.artifactLanguage}`,
      "JSON schema:",
      '{"readme":"...", "spec":"...", "implementation":"...", "artifactPath":"...", "artifactLanguage":"...", "artifactContent":"...", "publishSummary":"...", "usageSteps":["step1","step2","step3"]}',
      "Content rules:",
      "- README: practical, user-facing usage and rollout guidance",
      "- SPEC: architecture, constraints, data flow, edge cases",
      "- IMPLEMENTATION: concrete steps and maintainability notes",
      "- artifactPath must be file path only (no leading slash)",
      "- artifactContent must be directly usable starter implementation",
      "- publishSummary should be one concrete paragraph",
      "- usageSteps should be concrete actionable steps",
      "- no fluff, no repetitive stillness tone",
    ].join("\n\n");

    const rawBundle = await askAxy(baseUrl, bundlePrompt, {
      context: {
        channel: "build",
        conversationId: `build:mission:bundle:${targetSpaceId}:${plan.key}`,
        targetUsername: "kozmos-builders",
      },
    });
    const parsed = extractJsonObject(rawBundle);
    if (!parsed || typeof parsed !== "object") continue;

    const candidateBundle = {
      readme: String(parsed.readme || "").trim(),
      spec: String(parsed.spec || "").trim(),
      implementation: String(parsed.implementation || "").trim(),
      artifactPath: normalizeBuildPath(parsed.artifactPath || ""),
      artifactLanguage: String(parsed.artifactLanguage || plan.artifactLanguage || "markdown")
        .trim()
        .toLowerCase(),
      artifactContent: String(parsed.artifactContent || "").trim(),
      publishSummary: String(parsed.publishSummary || plan.publishSummary || "").trim(),
      usageSteps: Array.isArray(parsed.usageSteps)
        ? parsed.usageSteps.map((step) => String(step || "").trim()).filter(Boolean).slice(0, 8)
        : [],
    };
    const quality = scoreMissionBundleQuality(candidateBundle);
    if (!quality.ok) continue;

    const artifactKey = normalizeBuildPath(candidateBundle.artifactPath).toLowerCase();
    const alreadyUsedPath = files.some((file) => {
      const existingPath = normalizeBuildPath(file?.path || "").toLowerCase();
      return existingPath.endsWith(`/${artifactKey}`) || existingPath === artifactKey;
    });
    if (alreadyUsedPath) continue;

    bundle = candidateBundle;
    bundleQuality = quality;
    break;
  }

  if (!bundle) {
    throw new Error("mission build package generation failed (quality gate)");
  }

  await setState("mission_review", {
    topic: plan.title,
    qualityScore: bundleQuality?.qualityScore || 0,
    outputPath: "",
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const basePath = `${MISSION_ROOT_PATH}/${stamp}-${slugify(plan.title)}`;
  const artifactPath = `${basePath}/${normalizeBuildPath(bundle.artifactPath)}`;
  const readmeContent = `# ${plan.title}\n\n${bundle.readme}`.trim();
  const specContent = `# ${plan.title} - Spec\n\n${bundle.spec}`.trim();
  const implementationContent = `# ${plan.title} - Implementation\n\n${bundle.implementation}`.trim();
  const artifactContent = bundle.artifactContent;
  const latestSummary = String(bundle.publishSummary || plan.publishSummary).trim();
  const usageSteps = (Array.isArray(bundle.usageSteps) ? bundle.usageSteps : [])
    .map((step) => String(step || "").trim())
    .filter(Boolean)
    .slice(0, 6);

  const byExtLanguage = (() => {
    const ext = path.extname(artifactPath).toLowerCase();
    if (ext === ".ts" || ext === ".tsx") return "typescript";
    if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return "javascript";
    if (ext === ".sql") return "sql";
    if (ext === ".css") return "css";
    if (ext === ".json") return "json";
    if (ext === ".md") return "markdown";
    return bundle.artifactLanguage || "text";
  })();

  await callAxyOps(baseUrl, token, "build.files.save", {
    spaceId: targetSpaceId,
    path: `${basePath}/README.md`,
    language: "markdown",
    content: readmeContent,
  });
  await callAxyOps(baseUrl, token, "build.files.save", {
    spaceId: targetSpaceId,
    path: `${basePath}/SPEC.md`,
    language: "markdown",
    content: specContent,
  });
  await callAxyOps(baseUrl, token, "build.files.save", {
    spaceId: targetSpaceId,
    path: `${basePath}/IMPLEMENTATION.md`,
    language: "markdown",
    content: implementationContent,
  });
  await callAxyOps(baseUrl, token, "build.files.save", {
    spaceId: targetSpaceId,
    path: artifactPath,
    language: byExtLanguage,
    content: artifactContent,
  });
  await callAxyOps(baseUrl, token, "build.files.save", {
    spaceId: targetSpaceId,
    path: `${basePath}/PUBLISH.md`,
    language: "markdown",
    content: [
      `# ${plan.title}`,
      "",
      "## Value",
      latestSummary,
      "",
      "## Entry",
      `- ${basePath}/README.md`,
      `- ${artifactPath}`,
      "",
      "## Usage",
      ...(usageSteps.length > 0
        ? usageSteps.map((step, index) => `${index + 1}. ${step}`)
        : ["1. Open README.md", "2. Follow setup notes", "3. Run/iterate from artifact file"]),
      "",
    ].join("\n"),
  });

  const updatedHistory = [
    {
      title: plan.title,
      key: plan.key,
      path: basePath,
      created_at: new Date().toISOString(),
    },
    ...usedHistory,
  ].slice(0, missionHistoryLimit);

  await callAxyOps(baseUrl, token, "build.files.save", {
    spaceId: targetSpaceId,
    path: MISSION_HISTORY_PATH,
    language: "json",
    content: JSON.stringify(updatedHistory, null, 2),
  });

  const latestFile = [
    "# Latest Axy Published Build",
    "",
    `Title: ${plan.title}`,
    `Path: ${basePath}/README.md`,
    `Published: ${new Date().toISOString()}`,
    `Quality score: ${bundleQuality?.qualityScore || 0}`,
    "",
    latestSummary,
    "",
    "Usage:",
    ...(usageSteps.length > 0
      ? usageSteps.map((step, index) => `${index + 1}. ${step}`)
      : ["1. Open README", "2. Follow setup", "3. Iterate"]),
    "",
  ].join("\n");

  await callAxyOps(baseUrl, token, "build.files.save", {
    spaceId: targetSpaceId,
    path: MISSION_LATEST_PATH,
    language: "markdown",
    content: latestFile,
  });

  await setState("mission_publish", {
    topic: plan.title,
    outputPath: `${basePath}/README.md`,
    qualityScore: bundleQuality?.qualityScore || 0,
    published: true,
    publishedAt: new Date().toISOString(),
  });

  const publishMessage = `Axy published: ${plan.title} • value: ${latestSummary} • path: ${basePath}/README.md • use: open README then follow steps.`;
  return {
    ok: true,
    targetSpaceId,
    title: plan.title,
    basePath,
    qualityScore: bundleQuality?.qualityScore || 0,
    usageSteps,
    publishMessage: publishMessage.slice(0, 420),
  };
}

function shouldDisableOps(err) {
  const status = Number(err?.status || 0);
  const bodyError = String(err?.body?.error || "").trim().toLowerCase();
  const message = String(err?.message || "").trim().toLowerCase();

  if (status === 403) return true;
  if (status !== 404) return false;

  if (bodyError.includes("profile not found")) return false;
  if (message === "http 404" || message.includes("http 404")) return true;
  if (bodyError.includes("not found") && !bodyError.includes("target user not found")) {
    return true;
  }
  return false;
}

function pickWeightedAction(weightMap) {
  const entries = Object.entries(weightMap)
    .map(([key, value]) => [key, Number(value)])
    .filter(([, value]) => Number.isFinite(value) && value > 0);
  if (entries.length === 0) return null;
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  let cursor = Math.random() * total;
  for (const [key, value] of entries) {
    cursor -= value;
    if (cursor <= 0) return key;
  }
  return entries[entries.length - 1][0];
}

async function requestJson(url, init = {}) {
  const runtimeState = globalThis.__kozmosRuntimeRequestState || {
    aborting: false,
    controllers: new Set(),
  };
  globalThis.__kozmosRuntimeRequestState = runtimeState;

  if (runtimeState.aborting && !init.__allowDuringAbort) {
    const abortErr = new Error("request aborted");
    abortErr.name = "AbortError";
    throw abortErr;
  }

  const controller = new AbortController();
  runtimeState.controllers.add(controller);

  const externalSignal = init.signal;
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  const { signal: _signal, __allowDuringAbort: _allowDuringAbort, ...restInit } = init;
  let res;
  try {
    res = await fetch(url, { ...restInit, signal: controller.signal });
  } finally {
    runtimeState.controllers.delete(controller);
    if (externalSignal) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(json?.error || `http ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

async function postPresence(baseUrl, token, signal) {
  return requestJson(`${baseUrl}/api/runtime/presence`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    signal,
  });
}

async function clearPresence(baseUrl, token, signal) {
  return requestJson(`${baseUrl}/api/runtime/presence`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    signal,
    __allowDuringAbort: true,
  });
}

async function revokeRuntimeUser(baseUrl, bootstrapKey, username) {
  return requestJson(`${baseUrl}/api/runtime/token/revoke`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-kozmos-bootstrap-key": bootstrapKey,
    },
    body: JSON.stringify({
      revokeAllForUser: true,
      username,
    }),
    __allowDuringAbort: true,
  });
}

async function readFeed(baseUrl, token, cursor, limit) {
  const q = new URLSearchParams();
  if (cursor) q.set("after", cursor);
  q.set("limit", String(limit));
  return requestJson(`${baseUrl}/api/runtime/feed?${q.toString()}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
}

async function askAxy(baseUrl, message, options = {}) {
  const payload = { message };
  if (options && typeof options === "object") {
    if (typeof options.mode === "string" && options.mode.trim()) {
      payload.mode = options.mode.trim();
    }
    if (Array.isArray(options.recentNotes) && options.recentNotes.length > 0) {
      payload.recentNotes = options.recentNotes.slice(0, 12);
    }
    if (options.context && typeof options.context === "object") {
      payload.context = options.context;
    }
  }
  const res = await requestJson(`${baseUrl}/api/axy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return typeof res?.reply === "string" ? res.reply.trim() : "...";
}

async function postShared(baseUrl, token, content) {
  return requestJson(`${baseUrl}/api/runtime/shared`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ content }),
  });
}

async function callAxyOps(baseUrl, token, action, payload = {}) {
  return requestJson(`${baseUrl}/api/runtime/axy/ops`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ action, payload }),
  });
}

function formatReply(input) {
  return String(input || "...")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 420);
}

function formatBuildReply(input) {
  return String(input || "...")
    .trim()
    .slice(0, 6000);
}

function toBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function findLatestIncomingDm(messages, actorUserId) {
  if (!Array.isArray(messages) || !actorUserId) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const row = messages[i];
    if (!row?.id) continue;
    if (String(row.sender_id || "") === actorUserId) continue;
    const content = String(row.content || "").trim();
    if (!content) continue;
    return row;
  }
  return null;
}

function getDmNoReplyState(messages, actorUserId) {
  if (!Array.isArray(messages) || !actorUserId) {
    return { trailingAssistantCount: 0, latestIncomingId: null };
  }
  let trailingAssistantCount = 0;
  let latestIncomingId = null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const row = messages[i];
    if (!row?.id) continue;
    const senderId = String(row?.sender_id || "");
    if (senderId === String(actorUserId)) {
      trailingAssistantCount += 1;
      continue;
    }
    latestIncomingId = String(row.id);
    break;
  }
  return { trailingAssistantCount, latestIncomingId };
}

function findLatestIncomingHush(messages, actorUserId) {
  if (!Array.isArray(messages) || !actorUserId) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const row = messages[i];
    if (!row?.id) continue;
    if (String(row.user_id || "") === actorUserId) continue;
    const content = String(row.content || "").trim();
    if (!content) continue;
    return row;
  }
  return null;
}

function clipForContext(input, max = 220) {
  return String(input || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function pushLimited(list, item, limit = 20) {
  list.push(item);
  if (list.length > limit) {
    list.splice(0, list.length - limit);
  }
}

function extractAssistantRepliesFromTurns(turns, limit = 8) {
  if (!Array.isArray(turns)) return [];
  const out = [];
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (!turn || turn.role !== "assistant") continue;
    const text = clipForContext(turn.text, 220);
    if (!text) continue;
    out.unshift(text);
    if (out.length >= limit) break;
  }
  return out;
}

function buildDmContextTurns(messages, actorUserId, botUsername) {
  if (!Array.isArray(messages)) return [];
  return messages
    .slice(-10)
    .map((row) => {
      const isAssistant = String(row?.sender_id || "") === String(actorUserId || "");
      const text = clipForContext(row?.content || "", 240);
      if (!text) return null;
      const username = clipForContext(
        row?.username || (isAssistant ? botUsername || "Axy" : "user"),
        42
      );
      return {
        role: isAssistant ? "assistant" : "user",
        username,
        text,
      };
    })
    .filter(Boolean);
}

function buildHushContextTurns(messages, actorUserId, botUsername) {
  if (!Array.isArray(messages)) return [];
  return messages
    .slice(-10)
    .map((row) => {
      const isAssistant = String(row?.user_id || "") === String(actorUserId || "");
      const text = clipForContext(row?.content || "", 240);
      if (!text) return null;
      const username = clipForContext(
        row?.username || (isAssistant ? botUsername || "Axy" : "user"),
        42
      );
      return {
        role: isAssistant ? "assistant" : "user",
        username,
        text,
      };
    })
    .filter(Boolean);
}

const CHANNEL_NAMES = [
  "presence",
  "shared",
  "ops",
  "touch",
  "hush",
  "dm",
  "build",
  "play",
  "night",
  "swarm",
  "matrix",
  "freedom",
];

function toSafeError(err) {
  const raw =
    err?.body?.error ||
    err?.message ||
    (typeof err === "string" ? err : "unknown error");
  return String(raw).slice(0, 220);
}

function createAxyRuntimeCore(options = {}) {
  const channelNames = Array.isArray(options.channels) ? options.channels : CHANNEL_NAMES;
  const eventLimit = Math.max(50, Number(options.eventLimit) || 320);
  const startedAt = Date.now();
  const channels = new Map();
  const events = [];
  const counters = {
    sentByChannel: {},
    skippedByChannel: {},
    skippedByReason: {},
    errorsByChannel: {},
    transitions: 0,
  };

  function pushEvent(event) {
    events.push({
      at: new Date().toISOString(),
      ...event,
    });
    if (events.length > eventLimit) {
      events.splice(0, events.length - eventLimit);
    }
  }

  function ensureChannel(name) {
    const key = String(name || "unknown");
    if (!channels.has(key)) {
      channels.set(key, {
        name: key,
        state: "idle",
        updatedAtMs: Date.now(),
        lastOutputAtMs: 0,
        lastSkipAtMs: 0,
        lastErrorAtMs: 0,
        outputs: 0,
        skips: 0,
        errors: 0,
      });
    }
    return channels.get(key);
  }

  for (const name of channelNames) ensureChannel(name);

  function transition(channelName, nextState, detail = "") {
    const channel = ensureChannel(channelName);
    const cleanState = String(nextState || "idle");
    if (channel.state === cleanState) return;
    const prevState = channel.state;
    channel.state = cleanState;
    channel.updatedAtMs = Date.now();
    counters.transitions += 1;
    pushEvent({
      type: "transition",
      channel: channel.name,
      from: prevState,
      to: cleanState,
      detail: detail ? String(detail).slice(0, 120) : "",
    });
  }

  function markSent(channelName, meta = {}) {
    const channel = ensureChannel(channelName);
    channel.outputs += 1;
    channel.lastOutputAtMs = Date.now();
    counters.sentByChannel[channel.name] = (counters.sentByChannel[channel.name] || 0) + 1;
    pushEvent({
      type: "sent",
      channel: channel.name,
      conversationId: meta.conversationId || "",
    });
  }

  function markSkipped(channelName, reason = "unknown", meta = {}) {
    const channel = ensureChannel(channelName);
    const safeReason = String(reason || "unknown");
    channel.skips += 1;
    channel.lastSkipAtMs = Date.now();
    counters.skippedByChannel[channel.name] = (counters.skippedByChannel[channel.name] || 0) + 1;
    counters.skippedByReason[safeReason] = (counters.skippedByReason[safeReason] || 0) + 1;
    pushEvent({
      type: "skipped",
      channel: channel.name,
      reason: safeReason,
      conversationId: meta.conversationId || "",
    });
  }

  function markError(channelName, err, meta = {}) {
    const channel = ensureChannel(channelName);
    channel.errors += 1;
    channel.lastErrorAtMs = Date.now();
    counters.errorsByChannel[channel.name] = (counters.errorsByChannel[channel.name] || 0) + 1;
    pushEvent({
      type: "error",
      channel: channel.name,
      message: toSafeError(err),
      context: meta.context ? String(meta.context).slice(0, 120) : "",
    });
  }

  function snapshot() {
    const nowMs = Date.now();
    const channelList = {};
    for (const [name, channel] of channels.entries()) {
      channelList[name] = {
        state: channel.state,
        outputs: channel.outputs,
        skips: channel.skips,
        errors: channel.errors,
        stateAgeMs: Math.max(0, nowMs - channel.updatedAtMs),
        lastOutputAgeMs: channel.lastOutputAtMs ? Math.max(0, nowMs - channel.lastOutputAtMs) : null,
      };
    }
    return {
      startedAt: new Date(startedAt).toISOString(),
      uptimeMs: Math.max(0, nowMs - startedAt),
      counters,
      channels: channelList,
      recentEvents: events.slice(-120),
    };
  }

  return {
    transition,
    markSent,
    markSkipped,
    markError,
    snapshot,
  };
}

function createAutonomyGovernor(options = {}) {
  const historyPerConversation = Math.max(3, Number(options.historyPerConversation) || 12);
  const globalHistoryLimit = Math.max(20, Number(options.globalHistoryLimit) || 120);
  const minGapMsByChannel = options.minGapMsByChannel || {};
  const maxPerHourByChannel = options.maxPerHourByChannel || {};
  const activityBoostByChannel = options.activityBoostByChannel || {};
  const activityWindowMs = Math.max(
    10 * 60 * 1000,
    Number(options.activityWindowMs) || 45 * 60 * 1000
  );
  const clichePhrases = Array.isArray(options.clichePhrases) ? options.clichePhrases : [];

  const lastSentAtByConversation = new Map();
  const recentByConversation = new Map();
  const sentTimesByChannel = new Map();
  const userActivityByChannel = new Map();
  const globalRecent = [];
  const recentCliches = [];
  const stats = {
    sent: 0,
    blocked: 0,
    blockedByReason: {},
  };

  function findCliche(text) {
    const lower = normalizeForSimilarity(text);
    if (!lower) return "";
    for (const phrase of clichePhrases) {
      const p = normalizeForSimilarity(phrase);
      if (!p) continue;
      if (lower.includes(p)) return p;
    }
    return "";
  }

  function block(reason) {
    const safe = String(reason || "unknown");
    stats.blocked += 1;
    stats.blockedByReason[safe] = (stats.blockedByReason[safe] || 0) + 1;
    return { ok: false, reason: safe };
  }

  function conversationKey(channel, conversationId) {
    return `${String(channel || "unknown")}:${String(conversationId || "default")}`;
  }

  function pruneTimes(list, nowMs, ttlMs) {
    while (list.length > 0 && nowMs - list[0] > ttlMs) {
      list.shift();
    }
  }

  function getHourlyLimit(channel, nowMs) {
    const base = Math.max(0, Number(maxPerHourByChannel[channel] || 0));
    if (base <= 0) return 0;
    const activityList = userActivityByChannel.get(channel) || [];
    pruneTimes(activityList, nowMs, activityWindowMs);
    const activityCount = activityList.length;
    const boostMax = Math.max(0, Number(activityBoostByChannel[channel] || 0));
    if (boostMax <= 0) return base;
    const normalized = Math.min(1, activityCount / 12);
    const extra = Math.round(boostMax * normalized);
    return base + extra;
  }

  function recordUserActivity(channel, atMs = Date.now()) {
    const key = String(channel || "unknown");
    const list = userActivityByChannel.get(key) || [];
    list.push(atMs);
    pruneTimes(list, atMs, activityWindowMs);
    userActivityByChannel.set(key, list);
  }

  function decide(input = {}) {
    const channel = String(input.channel || "unknown");
    const key = conversationKey(channel, input.conversationId);
    let content = String(input.content || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!content) return block("empty");

    if (channel === "dm" || channel === "hush") {
      content = ensureQuestionPunctuation(content);
    }

    const nowMs = Date.now();
    const defaultGap = Number(minGapMsByChannel[channel] || 0);
    const minGapMs = Math.max(0, Number(input.minGapMs ?? defaultGap) || 0);
    const lastAt = Number(lastSentAtByConversation.get(key) || 0);
    if (minGapMs > 0 && lastAt > 0 && nowMs - lastAt < minGapMs) {
      return block("cooldown");
    }

    const hourLimit = getHourlyLimit(channel, nowMs);
    if (hourLimit > 0) {
      const sentList = sentTimesByChannel.get(channel) || [];
      pruneTimes(sentList, nowMs, 60 * 60 * 1000);
      sentTimesByChannel.set(channel, sentList);
      if (sentList.length >= hourLimit) {
        return block("hourly-budget");
      }
    }

    const recentLocal = recentByConversation.get(key) || [];
    if (isNearDuplicate(content, recentLocal.slice(-10))) {
      return block("duplicate-local");
    }
    if (isNearDuplicate(content, globalRecent.slice(-20))) {
      return block("duplicate-global");
    }

    const cliche = findCliche(content);
    if (cliche && recentCliches.includes(cliche)) {
      return block("style-repeat");
    }

    return {
      ok: true,
      channel,
      conversationKey: key,
      content,
      cliche,
    };
  }

  function commit(decision) {
    if (!decision?.ok) return;
    const key = String(decision.conversationKey || "");
    if (!key) return;
    const content = String(decision.content || "");
    if (!content) return;
    const nowMs = Date.now();
    lastSentAtByConversation.set(key, nowMs);
    const channel = String(decision.channel || "unknown");

    const list = recentByConversation.get(key) || [];
    list.push(content);
    if (list.length > historyPerConversation) {
      list.splice(0, list.length - historyPerConversation);
    }
    recentByConversation.set(key, list);
    const sentList = sentTimesByChannel.get(channel) || [];
    sentList.push(nowMs);
    pruneTimes(sentList, nowMs, 60 * 60 * 1000);
    sentTimesByChannel.set(channel, sentList);

    pushLimited(globalRecent, content, globalHistoryLimit);
    if (decision.cliche) {
      pushLimited(recentCliches, decision.cliche, 14);
    }
    stats.sent += 1;
  }

  function snapshot() {
    return {
      sent: stats.sent,
      blocked: stats.blocked,
      blockedByReason: stats.blockedByReason,
      trackedConversations: recentByConversation.size,
      recentGlobal: globalRecent.slice(-24),
      sentPerHourByChannel: Object.fromEntries(
        [...sentTimesByChannel.entries()].map(([channel, list]) => [channel, list.length])
      ),
      userActivityByChannel: Object.fromEntries(
        [...userActivityByChannel.entries()].map(([channel, list]) => [channel, list.length])
      ),
    };
  }

  return {
    decide,
    commit,
    recordUserActivity,
    snapshot,
  };
}

async function main() {
  const args = parseArgs(process.argv);

  const baseUrl = trimSlash(must(args["base-url"] || process.env.KOZMOS_BASE_URL, "base-url"));
  const usernameInput = String(args.username || process.env.KOZMOS_BOT_USERNAME || "Axy").trim();
  const username =
    usernameInput.toLowerCase() === "axy" ? "Axy" : usernameInput;
  if (username !== "Axy") {
    throw new Error('this service is fixed to username "Axy"');
  }
  const runtimeTokenInput = args.token || process.env.KOZMOS_RUNTIME_TOKEN;
  const bootstrapKey = args["bootstrap-key"] || process.env.RUNTIME_BOOTSTRAP_KEY;
  const heartbeatSeconds = Math.max(10, toInt(args["heartbeat-seconds"] || process.env.KOZMOS_HEARTBEAT_SECONDS, 25));
  const pollSeconds = Math.max(2, toInt(args["poll-seconds"] || process.env.KOZMOS_POLL_SECONDS, 5));
  const feedLimit = Math.max(1, Math.min(100, toInt(args["feed-limit"] || process.env.KOZMOS_FEED_LIMIT, 40)));
  const lookbackSeconds = Math.max(10, toInt(args["lookback-seconds"] || process.env.KOZMOS_LOOKBACK_SECONDS, 120));
  const replyAll = String(args["reply-all"] || process.env.KOZMOS_REPLY_ALL || "false").toLowerCase() === "true";
  const triggerRegexRaw = args["trigger-regex"] || process.env.KOZMOS_TRIGGER_REGEX || "";
  const opsSeconds = Math.max(
    3,
    toInt(args["ops-seconds"] || process.env.KOZMOS_OPS_SECONDS, 10)
  );
  const autoTouch = toBool(args["auto-touch"] ?? process.env.KOZMOS_AUTO_TOUCH, true);
  const autoTouchRequest = toBool(
    args["auto-touch-request"] ?? process.env.KOZMOS_AUTO_TOUCH_REQUEST,
    true
  );
  const touchRequestMinSeconds = Math.max(
    90,
    toInt(
      args["touch-request-min-seconds"] || process.env.KOZMOS_TOUCH_REQUEST_MIN_SECONDS,
      240
    )
  );
  const touchRequestMaxSeconds = Math.max(
    touchRequestMinSeconds,
    toInt(
      args["touch-request-max-seconds"] || process.env.KOZMOS_TOUCH_REQUEST_MAX_SECONDS,
      780
    )
  );
  const autoHush = toBool(args["auto-hush"] ?? process.env.KOZMOS_AUTO_HUSH, true);
  const hushReplyAll = toBool(
    args["hush-reply-all"] ?? process.env.KOZMOS_HUSH_REPLY_ALL,
    true
  );
  const hushTriggerRegexRaw =
    args["hush-trigger-regex"] || process.env.KOZMOS_HUSH_TRIGGER_REGEX || "";
  const autoDm = toBool(args["auto-dm"] ?? process.env.KOZMOS_AUTO_DM, true);
  const dmReplyAll = toBool(
    args["dm-reply-all"] ?? process.env.KOZMOS_DM_REPLY_ALL,
    true
  );
  const dmMinGapSeconds = Math.max(
    0,
    toInt(args["dm-min-gap-seconds"] || process.env.KOZMOS_DM_MIN_GAP_SECONDS, 18)
  );
  const dmMaxExtraWithoutReply = Math.max(
    0,
    toInt(
      args["dm-max-followups-without-reply"] ||
        process.env.KOZMOS_DM_MAX_FOLLOWUPS_WITHOUT_REPLY,
      3
    )
  );
  const dmTriggerRegexRaw =
    args["dm-trigger-regex"] || process.env.KOZMOS_DM_TRIGGER_REGEX || "";
  const autoBuild = toBool(args["auto-build"] ?? process.env.KOZMOS_AUTO_BUILD, false);
  const autoBuildFreedom = toBool(
    args["auto-build-freedom"] ?? process.env.KOZMOS_AUTO_BUILD_FREEDOM,
    true
  );
  const buildFreedomMinSeconds = Math.max(
    240,
    toInt(
      args["build-freedom-min-seconds"] || process.env.KOZMOS_BUILD_FREEDOM_MIN_SECONDS,
      720
    )
  );
  const buildFreedomMaxSeconds = Math.max(
    buildFreedomMinSeconds,
    toInt(
      args["build-freedom-max-seconds"] || process.env.KOZMOS_BUILD_FREEDOM_MAX_SECONDS,
      1800
    )
  );
  const autoPlay = toBool(args["auto-play"] ?? process.env.KOZMOS_AUTO_PLAY, true);
  const playChatMinGapSeconds = Math.max(
    60,
    toInt(args["play-chat-min-gap-seconds"] || process.env.KOZMOS_PLAY_CHAT_MIN_GAP_SECONDS, 300)
  );
  const playChatMaxGapSeconds = Math.max(
    playChatMinGapSeconds,
    toInt(
      args["play-chat-max-gap-seconds"] || process.env.KOZMOS_PLAY_CHAT_MAX_GAP_SECONDS,
      960
    )
  );
  const autoStarfall = toBool(
    args["auto-starfall"] ?? process.env.KOZMOS_AUTO_STARFALL,
    true
  );
  const starfallMinGapSeconds = Math.max(
    45,
    toInt(
      args["starfall-min-gap-seconds"] ||
        process.env.KOZMOS_STARFALL_MIN_GAP_SECONDS,
      120
    )
  );
  const starfallMaxGapSeconds = Math.max(
    starfallMinGapSeconds,
    toInt(
      args["starfall-max-gap-seconds"] ||
        process.env.KOZMOS_STARFALL_MAX_GAP_SECONDS,
      320
    )
  );
  const starfallTrainEpisodes = Math.max(
    1,
    Math.min(
      12,
      toInt(
        args["starfall-train-episodes"] ||
          process.env.KOZMOS_STARFALL_TRAIN_EPISODES,
        3
      )
    )
  );
  const starfallShareProgress = toBool(
    args["starfall-share-progress"] ?? process.env.KOZMOS_STARFALL_SHARE_PROGRESS,
    true
  );
  const starfallShareChance = Math.max(
    0,
    Math.min(
      1,
      toFloat(
        args["starfall-share-chance"] || process.env.KOZMOS_STARFALL_SHARE_CHANCE,
        0.34
      )
    )
  );
  const autoNight = toBool(args["auto-night"] ?? process.env.KOZMOS_AUTO_NIGHT, true);
  const nightOpsMinGapSeconds = Math.max(
    15,
    toInt(args["night-ops-min-gap-seconds"] || process.env.KOZMOS_NIGHT_OPS_MIN_GAP_SECONDS, 45)
  );
  const nightOpsMaxGapSeconds = Math.max(
    nightOpsMinGapSeconds,
    toInt(args["night-ops-max-gap-seconds"] || process.env.KOZMOS_NIGHT_OPS_MAX_GAP_SECONDS, 140)
  );
  const autoQuiteSwarm = toBool(
    args["auto-quite-swarm"] ?? process.env.KOZMOS_AUTO_QUITE_SWARM,
    true
  );
  const autoQuiteSwarmRoom = toBool(
    args["auto-quite-swarm-room"] ?? process.env.KOZMOS_AUTO_QUITE_SWARM_ROOM,
    true
  );
  const quiteSwarmMinGapSeconds = Math.max(
    8,
    toInt(
      args["quite-swarm-min-gap-seconds"] ||
        process.env.KOZMOS_QUITE_SWARM_MIN_GAP_SECONDS,
      18
    )
  );
  const quiteSwarmMaxGapSeconds = Math.max(
    quiteSwarmMinGapSeconds,
    toInt(
      args["quite-swarm-max-gap-seconds"] ||
        process.env.KOZMOS_QUITE_SWARM_MAX_GAP_SECONDS,
      34
    )
  );
  const quiteSwarmStep = Math.max(
    0.25,
    Math.min(
      9,
      toFloat(args["quite-swarm-step"] || process.env.KOZMOS_QUITE_SWARM_STEP, 4.2)
    )
  );
  const quiteSwarmExitChance = Math.max(
    0,
    Math.min(
      1,
      toFloat(
        args["quite-swarm-exit-chance"] ||
          process.env.KOZMOS_QUITE_SWARM_EXIT_CHANCE,
        0.2
      )
    )
  );
  const quiteSwarmRoomMinGapSeconds = Math.max(
    30,
    toInt(
      args["quite-swarm-room-min-gap-seconds"] ||
        process.env.KOZMOS_QUITE_SWARM_ROOM_MIN_GAP_SECONDS,
      80
    )
  );
  const quiteSwarmRoomMaxGapSeconds = Math.max(
    quiteSwarmRoomMinGapSeconds,
    toInt(
      args["quite-swarm-room-max-gap-seconds"] ||
        process.env.KOZMOS_QUITE_SWARM_ROOM_MAX_GAP_SECONDS,
      210
    )
  );
  const quiteSwarmRoomStartChance = Math.max(
    0.05,
    Math.min(
      1,
      toFloat(
        args["quite-swarm-room-start-chance"] ||
          process.env.KOZMOS_QUITE_SWARM_ROOM_START_CHANCE,
        0.62
      )
    )
  );
  const quiteSwarmRoomStopChance = Math.max(
    0,
    Math.min(
      1,
      toFloat(
        args["quite-swarm-room-stop-chance"] ||
          process.env.KOZMOS_QUITE_SWARM_ROOM_STOP_CHANCE,
        0.16
      )
    )
  );
  const autoMatrix = toBool(args["auto-matrix"] ?? process.env.KOZMOS_AUTO_MATRIX, false);
  const matrixStep = Math.max(
    0.05,
    Math.min(2, Number(args["matrix-step"] || process.env.KOZMOS_MATRIX_STEP || 0.72))
  );
  const autoFreedom = toBool(
    args["auto-freedom"] ?? process.env.KOZMOS_AUTO_FREEDOM,
    false
  );
  const freedomMinSeconds = Math.max(
    20,
    toInt(args["freedom-min-seconds"] || process.env.KOZMOS_FREEDOM_MIN_SECONDS, 55)
  );
  const freedomMaxSeconds = Math.max(
    freedomMinSeconds,
    toInt(args["freedom-max-seconds"] || process.env.KOZMOS_FREEDOM_MAX_SECONDS, 165)
  );
  const freedomMatrixWeight = Math.max(
    0,
    toFloat(args["freedom-matrix-weight"] || process.env.KOZMOS_FREEDOM_MATRIX_WEIGHT, 0.25)
  );
  const freedomNoteWeight = Math.max(
    0,
    toFloat(args["freedom-note-weight"] || process.env.KOZMOS_FREEDOM_NOTE_WEIGHT, 0.31)
  );
  const freedomSharedWeight = Math.max(
    0,
    toFloat(args["freedom-shared-weight"] || process.env.KOZMOS_FREEDOM_SHARED_WEIGHT, 0.08)
  );
  const freedomHushWeight = Math.max(
    0,
    toFloat(args["freedom-hush-weight"] || process.env.KOZMOS_FREEDOM_HUSH_WEIGHT, 0.36)
  );
  const freedomMatrixExitChance = Math.max(
    0.01,
    Math.min(
      0.95,
      toFloat(
        args["freedom-matrix-exit-chance"] ||
          process.env.KOZMOS_FREEDOM_MATRIX_EXIT_CHANCE,
        0.38
      )
    )
  );
  const freedomMatrixDriftChance = Math.max(
    0,
    Math.min(
      1,
      toFloat(
        args["freedom-matrix-drift-chance"] ||
          process.env.KOZMOS_FREEDOM_MATRIX_DRIFT_CHANCE,
        0.58
      )
    )
  );
  const freedomMatrixDriftScale = Math.max(
    0.5,
    Math.min(
      6,
      toFloat(
        args["freedom-matrix-drift-scale"] ||
          process.env.KOZMOS_FREEDOM_MATRIX_DRIFT_SCALE,
        2.3
      )
    )
  );
  const freedomSharedMinGapSeconds = Math.max(
    60,
    toInt(
      args["freedom-shared-min-gap-seconds"] ||
        process.env.KOZMOS_FREEDOM_SHARED_MIN_GAP_SECONDS,
      900
    )
  );
  const freedomSharedMaxPerHour = Math.max(
    0,
    toInt(
      args["freedom-shared-max-per-hour"] ||
        process.env.KOZMOS_FREEDOM_SHARED_MAX_PER_HOUR,
      3
    )
  );
  const hushMaxChatsPerCycle = Math.max(
    1,
    toInt(
      args["hush-max-chats-per-cycle"] || process.env.KOZMOS_HUSH_MAX_CHATS_PER_CYCLE,
      3
    )
  );
  const hushStartCooldownMinutes = Math.max(
    30,
    toInt(
      args["hush-start-cooldown-minutes"] ||
        process.env.KOZMOS_HUSH_START_COOLDOWN_MINUTES,
      180
    )
  );
  const freedomHushStartChance = Math.max(
    0,
    Math.min(
      1,
      toFloat(
        args["freedom-hush-start-chance"] ||
          process.env.KOZMOS_FREEDOM_HUSH_START_CHANCE,
        0.22
      )
    )
  );
  const buildSpaceId = String(
    args["build-space-id"] || process.env.KOZMOS_BUILD_SPACE_ID || ""
  ).trim();
  const buildRequestPath = normalizeBuildPath(
    args["build-request-path"] || process.env.KOZMOS_BUILD_REQUEST_PATH || "axy.request.md"
  );
  const buildOutputPath = normalizeBuildPath(
    args["build-output-path"] || process.env.KOZMOS_BUILD_OUTPUT_PATH || "axy.reply.md"
  );
  const sessionBuildFirst = toBool(
    args["session-build-first"] ?? process.env.KOZMOS_SESSION_BUILD_FIRST,
    true
  );
  const missionPublishToShared = toBool(
    args["mission-publish-to-shared"] ?? process.env.KOZMOS_MISSION_PUBLISH_TO_SHARED,
    true
  );
  const missionRetryMinSeconds = Math.max(
    15,
    toInt(
      args["mission-retry-min-seconds"] ||
        process.env.KOZMOS_MISSION_RETRY_MIN_SECONDS,
      45
    )
  );
  const missionRetryMaxSeconds = Math.max(
    missionRetryMinSeconds,
    toInt(
      args["mission-retry-max-seconds"] ||
        process.env.KOZMOS_MISSION_RETRY_MAX_SECONDS,
      120
    )
  );
  const missionMaxIdeaAttempts = Math.max(
    2,
    Math.min(
      12,
      toInt(
        args["mission-max-idea-attempts"] ||
          process.env.KOZMOS_MISSION_MAX_IDEA_ATTEMPTS,
        6
      )
    )
  );
  const missionMaxBundleAttempts = Math.max(
    2,
    Math.min(
      10,
      toInt(
        args["mission-max-bundle-attempts"] ||
          process.env.KOZMOS_MISSION_MAX_BUNDLE_ATTEMPTS,
        5
      )
    )
  );
  const missionHistoryLimit = Math.max(
    24,
    Math.min(
      480,
      toInt(
        args["mission-history-limit"] || process.env.KOZMOS_MISSION_HISTORY_LIMIT,
        240
      )
    )
  );
  const missionNoRepeatDays = Math.max(
    7,
    toInt(
      args["mission-no-repeat-days"] || process.env.KOZMOS_MISSION_NO_REPEAT_DAYS,
      120
    )
  );
  const evalFile = String(args["eval-file"] || process.env.KOZMOS_EVAL_FILE || "logs/axy-eval.json").trim();
  const evalWriteSeconds = Math.max(
    5,
    toInt(args["eval-write-seconds"] || process.env.KOZMOS_EVAL_WRITE_SECONDS, 20)
  );
  const evalPort = Math.max(0, toInt(args["eval-port"] || process.env.KOZMOS_EVAL_PORT, 0));

  let token = typeof runtimeTokenInput === "string" ? runtimeTokenInput.trim() : "";
  let user = null;
  let botUsername = username;

  if (!token) {
    throw new Error(
      "missing runtime token. runtime is linked-user only; claim via /runtime/connect while logged in."
    );
  }
  console.log(`[${now()}] using provided runtime token`);

  const triggerRegex = buildTriggerRegex(triggerRegexRaw, botUsername);
  const hushTriggerRegex = buildTriggerRegex(hushTriggerRegexRaw, botUsername);
  const dmTriggerRegex = buildTriggerRegex(dmTriggerRegexRaw, botUsername);
  let cursor = new Date(Date.now() - lookbackSeconds * 1000).toISOString();
  const seen = new Set();
  const handledTouchReq = new Set();
  const handledHushInvite = new Set();
  const handledHushRequest = new Set();
  const handledHushMessage = new Set();
  const handledDmMessage = new Set();
  const dmLastSentAtByChat = new Map();
  const dmLimitLogByChat = new Map();
  const handledBuildRequest = new Map();
  const touchRequestCooldownByUser = new Map();
  const hushStarterCooldown = new Map();
  const nightSessionByCode = new Map();
  const nightSentMessageByRound = new Set();
  const nightVotedByRound = new Set();
  let nextTouchRequestAt =
    Date.now() + randomIntRange(touchRequestMinSeconds, touchRequestMaxSeconds) * 1000;
  let nextBuildFreedomAt =
    Date.now() + randomIntRange(buildFreedomMinSeconds, buildFreedomMaxSeconds) * 1000;
  const missionRequired = autoBuild && sessionBuildFirst;
  let missionCompleted = !missionRequired;
  let missionAttemptCount = 0;
  let nextMissionAttemptAt = Date.now();
  let missionSessionId = randomUUID();
  let missionState = missionRequired ? "mission_planning" : "freedom";
  let missionTopic = "";
  let missionOutputPath = "";
  let missionQualityScore = 0;
  let missionPublishedAt = "";
  let missionRestored = false;
  let missionTargetSpaceId = String(buildSpaceId || "").trim();
  let lastMissionError = "";
  let nextPlayChatAt =
    Date.now() + randomIntRange(playChatMinGapSeconds, playChatMaxGapSeconds) * 1000;
  let nextStarfallAt =
    Date.now() + randomIntRange(starfallMinGapSeconds, starfallMaxGapSeconds) * 1000;
  let nextNightOpsAt =
    Date.now() + randomIntRange(nightOpsMinGapSeconds, nightOpsMaxGapSeconds) * 1000;
  let nextQuiteSwarmAt =
    Date.now() + randomIntRange(quiteSwarmMinGapSeconds, quiteSwarmMaxGapSeconds) * 1000;
  let nextQuiteSwarmRoomAt =
    Date.now() + randomIntRange(quiteSwarmRoomMinGapSeconds, quiteSwarmRoomMaxGapSeconds) * 1000;
  const sharedRecentTurns = [];
  const sharedRecentAxyReplies = [];
  let stopping = false;
  let opsEnabled = true;
  let lastOpsAt = 0;
  let nextFreedomAt = Date.now() + randomIntRange(freedomMinSeconds, freedomMaxSeconds) * 1000;
  let matrixVisible = false;
  let quiteSwarmVisible = false;
  let quiteSwarmRoomStatus = "idle";
  let quiteSwarmRoomHostUserId = "";
  let quiteSwarmRoomOpsEnabled = autoQuiteSwarmRoom;
  let nightFailureStreak = 0;
  let nightDisabledUntil = 0;
  let starfallOpsEnabled = true;
  let autoFreedomMatrixBooted = false;
  let lastFreedomSharedAt = 0;
  const freedomSharedSentAt = [];
  let freedomMatrixStreak = 0;
  const inFlightHeartbeatControllers = new Set();
  const runtimeRequestState =
    globalThis.__kozmosRuntimeRequestState ||
    ({
      aborting: false,
      controllers: new Set(),
    });
  globalThis.__kozmosRuntimeRequestState = runtimeRequestState;
  const runtimeCore = createAxyRuntimeCore({
    channels: CHANNEL_NAMES,
    eventLimit: 420,
  });
  const autonomyGovernor = createAutonomyGovernor({
    historyPerConversation: 14,
    globalHistoryLimit: 160,
    minGapMsByChannel: {
      shared: Math.max(3500, pollSeconds * 1000),
      dm: Math.max(2500, dmMinGapSeconds * 1000),
      hush: 4500,
      "game-chat": 16000,
      "night-protocol-day": 10000,
      "my-home-note": 12000,
    },
    maxPerHourByChannel: {
      shared: 12,
      dm: 40,
      hush: 26,
      "game-chat": 8,
      "night-protocol-day": 18,
      "my-home-note": 20,
    },
    activityBoostByChannel: {
      shared: 10,
      dm: 25,
      hush: 14,
      "game-chat": 5,
      "night-protocol-day": 10,
      "my-home-note": 8,
    },
    activityWindowMs: 45 * 60 * 1000,
    clichePhrases: [
      "in stillness",
      "shared presence",
      "quiet space",
      "without expectation",
      "allowing presence",
      "we simply exist",
      "presence unfolds",
      "quietly together",
    ],
  });
  const evalPath = path.isAbsolute(evalFile) ? evalFile : path.resolve(process.cwd(), evalFile);
  let evalWriteInFlight = false;
  let evalServer = null;
  const buildEvalPayload = (reason = "interval") => ({
    timestamp: new Date().toISOString(),
    reason,
    config: {
      heartbeatSeconds,
      pollSeconds,
      opsSeconds,
      autoTouch,
      autoHush,
      autoDm,
      autoBuild,
      sessionBuildFirst,
      autoPlay,
      autoStarfall,
      autoNight,
      autoQuiteSwarm,
      autoQuiteSwarmRoom,
      autoMatrix,
      autoFreedom,
    },
    runtime: {
      baseUrl,
      botUsername,
      cursor,
      matrixVisible,
      quiteSwarmVisible,
      quiteSwarmRoomStatus,
      opsEnabled,
      stopping,
      missionRequired,
      missionCompleted,
      missionSessionId,
      missionState,
      missionTopic,
      missionOutputPath,
      missionQualityScore,
      missionPublishedAt,
      missionRestored,
      missionAttemptCount,
      nextMissionAttemptAt: new Date(nextMissionAttemptAt).toISOString(),
      missionTargetSpaceId,
      lastMissionError,
    },
    core: runtimeCore.snapshot(),
    governor: autonomyGovernor.snapshot(),
  });
  const writeEvalSnapshot = async (reason = "interval") => {
    if (evalWriteInFlight) return;
    evalWriteInFlight = true;
    try {
      const payload = buildEvalPayload(reason);
      await mkdir(path.dirname(evalPath), { recursive: true });
      await writeFile(evalPath, JSON.stringify(payload, null, 2), "utf8");
    } catch (err) {
      runtimeCore.markError("ops", err, { context: "eval.write" });
      console.log(`[${now()}] eval write fail: ${toSafeError(err)}`);
    } finally {
      evalWriteInFlight = false;
    }
  };
  const evalWriter = setInterval(() => {
    if (stopping) return;
    void writeEvalSnapshot("interval");
  }, evalWriteSeconds * 1000);
  const sendManagedOutput = async ({
    channel,
    conversationId,
    content,
    minGapMs = 0,
    send,
    logLabel = "",
  }) => {
    const decision = autonomyGovernor.decide({
      channel,
      conversationId,
      content,
      minGapMs,
    });
    if (!decision.ok) {
      runtimeCore.markSkipped(channel, decision.reason, { conversationId });
      if (logLabel) {
        console.log(`[${now()}] ${logLabel} skipped (${decision.reason})`);
      }
      return { sent: false, reason: decision.reason, content: "" };
    }

    await send(decision.content);
    autonomyGovernor.commit(decision);
    runtimeCore.markSent(channel, { conversationId });
    return { sent: true, reason: "", content: decision.content };
  };

  const persistMissionState = async (status, patch = {}) => {
    if (!missionRequired || !user?.id) return;
    missionState = String(status || missionState || "mission_planning");
    missionTopic = String(patch.topic ?? missionTopic ?? "").trim();
    missionOutputPath = String(patch.outputPath ?? missionOutputPath ?? "").trim();
    lastMissionError = String(patch.error ?? lastMissionError ?? "").trim();
    missionQualityScore = Number(
      Number.isFinite(Number(patch.qualityScore)) ? Number(patch.qualityScore) : missionQualityScore
    );
    missionPublishedAt = String(patch.publishedAt ?? missionPublishedAt ?? "").trim();
    const published =
      Boolean(patch.published) || missionState === "mission_publish" || missionCompleted;

    try {
      await callAxyOps(baseUrl, token, "mission.upsert", {
        sessionId: missionSessionId,
        status: missionState,
        topic: missionTopic,
        outputPath: missionOutputPath,
        qualityScore: missionQualityScore,
        published,
        publishedAt: missionPublishedAt || undefined,
        attemptCount: missionAttemptCount,
        error: lastMissionError,
      });
    } catch (err) {
      const msg = err?.body?.error || err?.message || "mission state persist failed";
      runtimeCore.markError("build", err, { context: "mission.persist" });
      console.log(`[${now()}] mission persist fail: ${msg}`);
    }
  };

  const restoreMissionState = async () => {
    if (!missionRequired || missionRestored || !user?.id) return;
    try {
      const res = await callAxyOps(baseUrl, token, "mission.get");
      const row = res?.data || null;
      missionRestored = true;
      if (!row?.session_id) {
        await persistMissionState("mission_planning");
        return;
      }

      const rowStatus = String(row.status || "").trim().toLowerCase();
      const rowPublished = Boolean(row.published) || rowStatus === "mission_publish" || rowStatus === "freedom";
      if (rowPublished) {
        // New runtime boot starts a new mission session when previous one already published.
        missionSessionId = randomUUID();
        missionState = "mission_planning";
        missionTopic = "";
        missionOutputPath = "";
        missionQualityScore = 0;
        missionPublishedAt = "";
        missionCompleted = false;
        missionAttemptCount = 0;
        await persistMissionState("mission_planning");
        return;
      }

      missionSessionId = String(row.session_id || missionSessionId);
      missionState = String(row.status || missionState || "mission_planning");
      missionTopic = String(row.topic || "");
      missionOutputPath = String(row.output_path || "");
      missionQualityScore = Number(row.quality_score || 0);
      missionPublishedAt = String(row.published_at || "");
      missionAttemptCount = Math.max(missionAttemptCount, Number(row.attempt_count || 0));
      missionCompleted = false;
    } catch (err) {
      missionRestored = true;
      const msg = err?.body?.error || err?.message || "mission restore failed";
      runtimeCore.markError("build", err, { context: "mission.restore" });
      console.log(`[${now()}] mission restore fail: ${msg}`);
      await persistMissionState("mission_planning");
    }
  };

  if (user?.id) {
    console.log(`[${now()}] claimed as ${botUsername} (${user.id})`);
  } else {
    console.log(`[${now()}] running as ${botUsername}`);
  }
  console.log(
    `[${now()}] heartbeat=${heartbeatSeconds}s poll=${pollSeconds}s replyAll=${replyAll}`
  );
  console.log(
    `[${now()}] ops=${opsSeconds}s autoTouch=${autoTouch} autoTouchRequest=${autoTouchRequest} autoHush=${autoHush} hushReplyAll=${hushReplyAll} autoDm=${autoDm} dmReplyAll=${dmReplyAll} autoBuild=${autoBuild} autoBuildFreedom=${autoBuildFreedom} autoPlay=${autoPlay} autoStarfall=${autoStarfall} autoNight=${autoNight} autoQuiteSwarm=${autoQuiteSwarm} autoQuiteSwarmRoom=${autoQuiteSwarmRoom} autoMatrix=${autoMatrix} autoFreedom=${autoFreedom}`
  );
  if (autoBuild) {
    console.log(
      `[${now()}] build helper request=${buildRequestPath} output=${buildOutputPath}${buildSpaceId ? ` space=${buildSpaceId}` : ""}`
    );
    console.log(
      `[${now()}] mission-first=${sessionBuildFirst} publish=${missionPublishToShared} retry=${missionRetryMinSeconds}-${missionRetryMaxSeconds}s attempts(idea=${missionMaxIdeaAttempts},bundle=${missionMaxBundleAttempts}) noRepeatDays=${missionNoRepeatDays}`
    );
  }
  if (autoTouchRequest) {
    console.log(
      `[${now()}] touch-request interval=${touchRequestMinSeconds}-${touchRequestMaxSeconds}s`
    );
  }
  if (autoPlay) {
    console.log(
      `[${now()}] play game-chat interval=${playChatMinGapSeconds}-${playChatMaxGapSeconds}s`
    );
  }
  if (autoStarfall) {
    console.log(
      `[${now()}] starfall interval=${starfallMinGapSeconds}-${starfallMaxGapSeconds}s trainEpisodes=${starfallTrainEpisodes} shareProgress=${starfallShareProgress} shareChance=${starfallShareChance}`
    );
  }
  if (autoNight) {
    console.log(
      `[${now()}] night ops interval=${nightOpsMinGapSeconds}-${nightOpsMaxGapSeconds}s`
    );
  }
  if (autoQuiteSwarm) {
    console.log(
      `[${now()}] quite-swarm interval=${quiteSwarmMinGapSeconds}-${quiteSwarmMaxGapSeconds}s step=${quiteSwarmStep} exitChance=${quiteSwarmExitChance}`
    );
  }
  if (autoQuiteSwarmRoom) {
    console.log(
      `[${now()}] quite-swarm room interval=${quiteSwarmRoomMinGapSeconds}-${quiteSwarmRoomMaxGapSeconds}s startChance=${quiteSwarmRoomStartChance} stopChance=${quiteSwarmRoomStopChance}`
    );
  }
  if (autoFreedom) {
    console.log(
      `[${now()}] freedom=${freedomMinSeconds}-${freedomMaxSeconds}s weights(matrix=${freedomMatrixWeight},note=${freedomNoteWeight},shared=${freedomSharedWeight},hush=${freedomHushWeight}) matrix(exit=${freedomMatrixExitChance},drift=${freedomMatrixDriftChance},scale=${freedomMatrixDriftScale})`
    );
    console.log(
      `[${now()}] freedom shared limits minGap=${freedomSharedMinGapSeconds}s maxPerHour=${freedomSharedMaxPerHour} hushMaxChatsPerCycle=${hushMaxChatsPerCycle} hushStartChance=${freedomHushStartChance} hushCooldown=${hushStartCooldownMinutes}m`
    );
  }
  console.log(`[${now()}] eval write=${evalWriteSeconds}s file=${evalPath}`);
  if (evalPort > 0) {
    evalServer = http.createServer((req, res) => {
      const url = String(req.url || "/");
      if (url.startsWith("/metrics")) {
        const payload = buildEvalPayload("http");
        const body = JSON.stringify(payload, null, 2);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(body);
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise((resolve, reject) => {
      evalServer.once("error", reject);
      evalServer.listen(evalPort, "127.0.0.1", () => {
        evalServer.off("error", reject);
        resolve();
      });
    });
    console.log(`[${now()}] eval http=http://127.0.0.1:${evalPort}/metrics`);
  }
  runtimeCore.transition("presence", "running");
  runtimeCore.transition("shared", "idle");
  runtimeCore.transition("ops", "idle");
  runtimeCore.transition("dm", "idle");
  runtimeCore.transition("hush", "idle");
  runtimeCore.transition("build", "idle");
  runtimeCore.transition("play", "idle");
  runtimeCore.transition("night", "idle");
  runtimeCore.transition("swarm", "idle");
  runtimeCore.transition("matrix", "idle");
  runtimeCore.transition("freedom", "idle");
  if (missionRequired) {
    runtimeCore.transition("build", "mission-pending");
  }
  void writeEvalSnapshot("startup");

  const heartbeat = setInterval(async () => {
    if (stopping) return;
    runtimeCore.transition("presence", "heartbeat");
    const controller = new AbortController();
    inFlightHeartbeatControllers.add(controller);
    try {
      await postPresence(baseUrl, token, controller.signal);
      if (!stopping) console.log(`[${now()}] heartbeat ok`);
      runtimeCore.transition("presence", "running");
    } catch (err) {
      if (err?.name === "AbortError") return;
      const msg = err?.body?.error || err.message || "presence failed";
      if (!stopping) console.log(`[${now()}] heartbeat fail: ${msg}`);
      runtimeCore.markError("presence", err, { context: "heartbeat" });
    } finally {
      inFlightHeartbeatControllers.delete(controller);
    }
  }, heartbeatSeconds * 1000);

  try {
    runtimeCore.transition("presence", "heartbeat");
    await postPresence(baseUrl, token);
    runtimeCore.transition("presence", "running");
  } catch (err) {
    runtimeCore.markError("presence", err, { context: "boot-heartbeat" });
  }

  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    clearInterval(heartbeat);
    clearInterval(evalWriter);
    runtimeCore.transition("presence", "stopping", signal);
    console.log(`[${now()}] ${signal} received, clearing presence...`);
    runtimeRequestState.aborting = true;
    for (const controller of inFlightHeartbeatControllers) {
      controller.abort();
    }
    inFlightHeartbeatControllers.clear();
    for (const controller of runtimeRequestState.controllers) {
      controller.abort();
    }
    runtimeRequestState.controllers.clear();
    await sleep(900);
    try {
      const clearWithTimeout = async (timeoutMs) => {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeoutMs);
        try {
          await clearPresence(baseUrl, token, ctl.signal);
        } finally {
          clearTimeout(timer);
        }
      };

      await clearWithTimeout(1800);

      // A small delayed second clear removes any late server-side upsert
      // that could finish just after the first delete.
      await sleep(2500);
      await clearWithTimeout(1800).catch(() => null);

      console.log(`[${now()}] presence cleared`);
      runtimeCore.transition("presence", "stopped");
    } catch (err) {
      const msg = err?.body?.error || err.message || "presence clear failed";
      console.log(`[${now()}] presence clear fail: ${msg}`);
      runtimeCore.markError("presence", err, { context: "shutdown-clear" });
      if (bootstrapKey) {
        try {
          await revokeRuntimeUser(baseUrl, bootstrapKey, botUsername);
          console.log(`[${now()}] fallback revoke ok (presence should drop)`);
          runtimeCore.transition("presence", "stopped");
        } catch (revokeErr) {
          const revokeMsg =
            revokeErr?.body?.error || revokeErr.message || "fallback revoke failed";
          console.log(`[${now()}] fallback revoke fail: ${revokeMsg}`);
          runtimeCore.markError("presence", revokeErr, { context: "shutdown-revoke" });
        }
      }
    }
    if (evalServer) {
      await new Promise((resolve) => {
        evalServer.close(() => resolve());
      });
    }
    await writeEvalSnapshot("shutdown");
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  while (!stopping) {
    try {
      runtimeCore.transition("shared", "polling");
      const feed = await readFeed(baseUrl, token, cursor, feedLimit);
      const rows = Array.isArray(feed?.messages) ? feed.messages : [];
      if (feed?.nextCursor) {
        cursor = feed.nextCursor;
      }

      for (const row of rows) {
        if (!row?.id || seen.has(row.id)) continue;
        seen.add(row.id);
        if (seen.size > 1200) {
          const first = seen.values().next().value;
          if (first) seen.delete(first);
        }

        if (user?.id && row.user_id === user.id) continue;
        if (
          !user?.id &&
          String(row.username || "").trim().toLowerCase() === botUsername.toLowerCase()
        ) {
          continue;
        }

        const content = String(row.content || "").trim();
        if (!content) continue;
        const senderLabel = String(row.username || "user");
        autonomyGovernor.recordUserActivity("shared");

        pushLimited(
          sharedRecentTurns,
          {
            role: "user",
            username: senderLabel,
            text: clipForContext(content, 240),
          },
          28
        );

        if (missionRequired && !missionCompleted) {
          runtimeCore.markSkipped("shared", "mission-build-first", {
            conversationId: "shared:main",
          });
          continue;
        }

        const shouldReply = replyAll || triggerRegex.test(content);
        if (!shouldReply) continue;

        runtimeCore.transition("shared", "generating", senderLabel);
        const prompt = `${senderLabel}: ${content}`;
        const raw = await askAxy(baseUrl, prompt, {
          context: {
            channel: "shared",
            conversationId: "shared:main",
            targetUsername: senderLabel,
            recentMessages: sharedRecentTurns.slice(-10),
            recentAxyReplies: sharedRecentAxyReplies.slice(-8),
          },
        });
        const reply = formatReply(raw);
        if (!reply) continue;

        const output = `${senderLabel}: ${reply}`;
        const sentRes = await sendManagedOutput({
          channel: "shared",
          conversationId: "shared:main",
          content: output,
          send: async (safeContent) => {
            runtimeCore.transition("shared", "sending", senderLabel);
            await postShared(baseUrl, token, safeContent);
          },
          logLabel: `shared -> ${senderLabel}`,
        });
        if (!sentRes.sent) continue;
        const sentReplyText = sentRes.content.startsWith(`${senderLabel}:`)
          ? sentRes.content.slice(senderLabel.length + 1).trim()
          : sentRes.content;
        pushLimited(
          sharedRecentTurns,
          {
            role: "assistant",
            username: botUsername,
            text: clipForContext(sentReplyText, 240),
          },
          28
        );
        pushLimited(sharedRecentAxyReplies, clipForContext(sentReplyText, 220), 12);
        console.log(`[${now()}] replied to ${senderLabel}`);
      }
      runtimeCore.transition("shared", "idle");
    } catch (err) {
      const msg = err?.body?.error || err.message || "feed loop error";
      console.log(`[${now()}] loop fail: ${msg}`);
      runtimeCore.markError("shared", err, { context: "shared-feed-loop" });
      runtimeCore.transition("shared", "idle");
        if (err?.status === 401) {
          console.log(`[${now()}] token unauthorized, exiting.`);
          clearInterval(heartbeat);
          clearInterval(evalWriter);
          await writeEvalSnapshot("unauthorized-shared");
          process.exit(1);
      }
    }

    const dueOps = Date.now() - lastOpsAt >= opsSeconds * 1000;
    if (!stopping && opsEnabled && dueOps) {
      try {
        runtimeCore.transition("ops", "running");
        lastOpsAt = Date.now();
        const snapshot = await callAxyOps(baseUrl, token, "context.snapshot");
        const actor = snapshot?.data?.actor || null;
        if (actor?.user_id && actor?.username) {
          user = { id: actor.user_id };
          botUsername = String(actor.username);
          if (!missionCompleted) {
            await restoreMissionState();
          }
        }
        matrixVisible = Boolean(snapshot?.data?.matrix_position?.updated_at);
        quiteSwarmVisible = Boolean(snapshot?.data?.quite_swarm_position?.active);
        quiteSwarmRoomStatus =
          String(snapshot?.data?.quite_swarm_room?.status || "idle").toLowerCase() === "running"
            ? "running"
            : "idle";
        quiteSwarmRoomHostUserId = String(
          snapshot?.data?.quite_swarm_room?.host_user_id || ""
        ).trim();

        if (missionRequired && !missionCompleted && Date.now() >= nextMissionAttemptAt) {
          runtimeCore.transition("build", "mission-running");
          missionAttemptCount += 1;
          try {
            const missionRes = await runSessionBuildMission({
              baseUrl,
              token,
              botUsername,
              buildSpaceId: missionTargetSpaceId || buildSpaceId,
              missionMaxIdeaAttempts,
              missionMaxBundleAttempts,
              missionHistoryLimit,
              missionNoRepeatDays,
              missionContext: {
                sharedTurns: sharedRecentTurns,
                notes: snapshot?.data?.notes || [],
                buildSpaces: snapshot?.data?.build_spaces || [],
              },
              onState: async (status, patch = {}) => {
                await persistMissionState(status, patch);
              },
            });
            if (!missionRes?.ok) {
              throw new Error("mission result invalid");
            }
            missionCompleted = true;
            missionState = "mission_publish";
            missionTargetSpaceId = String(missionRes.targetSpaceId || missionTargetSpaceId || "");
            missionTopic = String(missionRes.title || missionTopic || "");
            missionOutputPath = `${String(missionRes.basePath || "").trim()}/README.md`;
            missionQualityScore = Number(missionRes.qualityScore || missionQualityScore || 0);
            missionPublishedAt = new Date().toISOString();
            lastMissionError = "";
            runtimeCore.markSent("build", { conversationId: `build:mission:${missionTargetSpaceId}` });
            runtimeCore.transition("build", "mission-complete");
            await persistMissionState("mission_publish", {
              topic: missionTopic,
              outputPath: missionOutputPath,
              qualityScore: missionQualityScore,
              published: true,
              publishedAt: missionPublishedAt,
            });
            console.log(
              `[${now()}] mission build published title="${missionRes.title}" space=${missionTargetSpaceId}`
            );
            if (missionPublishToShared && missionRes.publishMessage) {
              await sendManagedOutput({
                channel: "shared",
                conversationId: "shared:main",
                content: missionRes.publishMessage,
                minGapMs: Math.max(5000, pollSeconds * 1000),
                send: async (safeContent) => {
                  await postShared(baseUrl, token, safeContent);
                },
                logLabel: "mission-publish",
              });
            }
          } catch (missionErr) {
            lastMissionError = missionErr?.body?.error || missionErr?.message || "mission failed";
            runtimeCore.markError("build", missionErr, { context: "mission-first-build" });
            runtimeCore.transition("build", "mission-retry");
            missionState = "mission_failed";
            await persistMissionState("mission_failed", {
              error: lastMissionError,
              topic: missionTopic,
              outputPath: missionOutputPath,
              qualityScore: missionQualityScore,
            });
            nextMissionAttemptAt =
              Date.now() + randomIntRange(missionRetryMinSeconds, missionRetryMaxSeconds) * 1000;
            console.log(
              `[${now()}] mission build fail: ${lastMissionError} (retry in ${Math.round(
                (nextMissionAttemptAt - Date.now()) / 1000
              )}s)`
            );
          }
        }

        const missionLockedNow = missionRequired && !missionCompleted;
        if (missionLockedNow) {
          runtimeCore.markSkipped("ops", "mission-build-first", {
            conversationId: "build:mission",
          });
        }
        if (
          missionRequired &&
          missionCompleted &&
          missionState === "mission_publish"
        ) {
          missionState = "freedom";
          await persistMissionState("freedom", {
            topic: missionTopic,
            outputPath: missionOutputPath,
            qualityScore: missionQualityScore,
            published: true,
            publishedAt: missionPublishedAt || new Date().toISOString(),
          });
        }

        if (!missionLockedNow && autoFreedom && !autoFreedomMatrixBooted && !matrixVisible) {
          const enterRes = await callAxyOps(baseUrl, token, "matrix.enter", {
            x: randomRange(-8, 8),
            z: randomRange(-8, 8),
          });
          matrixVisible = true;
          autoFreedomMatrixBooted = true;
          const pos = enterRes?.data || {};
          console.log(
            `[${now()}] freedom: matrix boot enter x=${Number(pos.x || 0).toFixed(2)} z=${Number(pos.z || 0).toFixed(2)}`
          );
        } else if (!missionLockedNow && autoFreedom && !autoFreedomMatrixBooted) {
          autoFreedomMatrixBooted = true;
        }

        if (
          !missionLockedNow &&
          autoFreedom &&
          matrixVisible &&
          Math.random() < freedomMatrixDriftChance
        ) {
          runtimeCore.transition("matrix", "moving");
          const driftMoves = Math.random() < 0.34 ? 2 : 1;
          let driftPos = null;
          for (let i = 0; i < driftMoves; i += 1) {
            const scale = freedomMatrixDriftScale * (1 + i * 0.35);
            const driftRes = await callAxyOps(baseUrl, token, "matrix.move", {
              dx: (Math.random() * 2 - 1) * matrixStep * scale,
              dz: (Math.random() * 2 - 1) * matrixStep * scale,
            });
            driftPos = driftRes?.data || driftPos;
          }
          const pos = driftPos || {};
          console.log(
            `[${now()}] freedom: matrix ambient drift x=${Number(pos.x || 0).toFixed(2)} z=${Number(pos.z || 0).toFixed(2)}`
          );
          runtimeCore.markSent("matrix", { conversationId: "matrix:ambient" });
        }

        const touchData = snapshot?.data?.touch || {};
        if (!missionLockedNow && autoTouch) {
          runtimeCore.transition("touch", "scanning");
          const incoming = Array.isArray(touchData?.incoming) ? touchData.incoming : [];
          for (const req of incoming) {
            const reqId = Number(req?.id || 0);
            if (!Number.isFinite(reqId) || reqId <= 0) continue;
            if (handledTouchReq.has(reqId)) continue;
            handledTouchReq.add(reqId);
            await callAxyOps(baseUrl, token, "touch.respond", {
              requestId: reqId,
              accept: true,
            });
            runtimeCore.markSent("touch", { conversationId: `touch:${reqId}` });
            console.log(`[${now()}] accepted keep-in-touch request id=${reqId}`);
          }
          runtimeCore.transition("touch", "idle");
        }

        if (!missionLockedNow && autoTouchRequest && Date.now() >= nextTouchRequestAt) {
          runtimeCore.transition("touch", "requesting");
          try {
            const nowMs = Date.now();
            const cooldownMs = 3 * 60 * 60 * 1000;
            for (const [nameKey, ts] of touchRequestCooldownByUser.entries()) {
              if (nowMs - ts > cooldownMs) touchRequestCooldownByUser.delete(nameKey);
            }

            const inTouchSet = new Set(
              (Array.isArray(touchData?.inTouch) ? touchData.inTouch : [])
                .map((row) => String(row?.username || "").trim().toLowerCase())
                .filter(Boolean)
            );
            const incomingSet = new Set(
              (Array.isArray(touchData?.incoming) ? touchData.incoming : [])
                .map((row) => String(row?.username || "").trim().toLowerCase())
                .filter(Boolean)
            );

            const presentUsers = Array.isArray(snapshot?.data?.present_users)
              ? snapshot.data.present_users
              : [];
            const candidates = presentUsers
              .map((row) => String(row?.username || "").trim())
              .filter((name) => name.length > 0)
              .filter((name) => name.toLowerCase() !== String(botUsername || "").toLowerCase())
              .filter((name) => !inTouchSet.has(name.toLowerCase()))
              .filter((name) => !incomingSet.has(name.toLowerCase()))
              .filter((name) => !touchRequestCooldownByUser.has(name.toLowerCase()));

            if (candidates.length > 0) {
              const targetUsername = candidates[Math.floor(Math.random() * candidates.length)];
              await callAxyOps(baseUrl, token, "touch.request", { targetUsername });
              touchRequestCooldownByUser.set(targetUsername.toLowerCase(), nowMs);
              runtimeCore.markSent("touch", { conversationId: `touch:${targetUsername}` });
              console.log(`[${now()}] keep-in-touch request sent to ${targetUsername}`);
            }
          } catch (touchReqErr) {
            const msg = touchReqErr?.body?.error || touchReqErr.message || "touch request failed";
            console.log(`[${now()}] touch request fail: ${msg}`);
            runtimeCore.markError("touch", touchReqErr, { context: "touch.request" });
          } finally {
            runtimeCore.transition("touch", "idle");
            nextTouchRequestAt =
              Date.now() + randomIntRange(touchRequestMinSeconds, touchRequestMaxSeconds) * 1000;
          }
        }

        if (!missionLockedNow && autoHush) {
          runtimeCore.transition("hush", "scanning");
          const hushData = snapshot?.data?.hush || {};
          const invitesForMe = Array.isArray(hushData?.invitesForMe) ? hushData.invitesForMe : [];
          for (const invite of invitesForMe) {
            const inviteId = Number(invite?.id || 0);
            const chatId = String(invite?.chat_id || "").trim();
            if (!chatId) continue;
            const inviteKey = `${inviteId}:${chatId}`;
            if (handledHushInvite.has(inviteKey)) continue;
            handledHushInvite.add(inviteKey);
            if (handledHushInvite.size > 1200) {
              const first = handledHushInvite.values().next().value;
              if (first) handledHushInvite.delete(first);
            }
            await callAxyOps(baseUrl, token, "hush.accept_invite", { chatId });
            runtimeCore.markSent("hush", { conversationId: `hush:${chatId}` });
            console.log(`[${now()}] accepted hush invite chat=${chatId}`);
          }

          const requestsForMe = Array.isArray(hushData?.requestsForMe)
            ? hushData.requestsForMe
            : [];
          for (const req of requestsForMe) {
            const reqId = Number(req?.id || 0);
            const chatId = String(req?.chat_id || "").trim();
            const memberUserId = String(req?.user_id || "").trim();
            if (!chatId || !memberUserId) continue;
            const reqKey = `${reqId}:${chatId}:${memberUserId}`;
            if (handledHushRequest.has(reqKey)) continue;
            handledHushRequest.add(reqKey);
            if (handledHushRequest.size > 1200) {
              const first = handledHushRequest.values().next().value;
              if (first) handledHushRequest.delete(first);
            }
            await callAxyOps(baseUrl, token, "hush.accept_request", {
              chatId,
              memberUserId,
            });
            runtimeCore.markSent("hush", { conversationId: `hush:${chatId}` });
            console.log(`[${now()}] accepted hush join request user=${memberUserId}`);
          }

          const hushChats = Array.isArray(hushData?.chats) ? hushData.chats : [];
          let hushChecked = 0;
          for (const chat of hushChats) {
            if (hushChecked >= hushMaxChatsPerCycle) break;
            const chatId = String(chat?.id || "").trim();
            if (!chatId) continue;
            if (String(chat?.membership_status || "") !== "accepted") continue;
            hushChecked += 1;

            const messageRes = await callAxyOps(baseUrl, token, "hush.messages", {
              chatId,
              limit: 35,
            });
            const hushTurns = buildHushContextTurns(
              messageRes?.data || [],
              user?.id || "",
              botUsername
            );
            const recentHushReplies = extractAssistantRepliesFromTurns(hushTurns, 8);
            const latestIncoming = findLatestIncomingHush(
              messageRes?.data || [],
              user?.id || ""
            );
            if (!latestIncoming) continue;
            autonomyGovernor.recordUserActivity("hush");

            const messageKey = `${chatId}:${latestIncoming.id}`;
            if (handledHushMessage.has(messageKey)) continue;
            handledHushMessage.add(messageKey);
            if (handledHushMessage.size > 2400) {
              const first = handledHushMessage.values().next().value;
              if (first) handledHushMessage.delete(first);
            }

            const content = String(latestIncoming.content || "").trim();
            const shouldReplyHush = hushReplyAll || hushTriggerRegex.test(content);
            if (!shouldReplyHush) continue;

            runtimeCore.transition("hush", "generating", chatId);
            const senderLabel = String(latestIncoming.username || "user");
            const prompt = `hush from ${senderLabel}: ${content}`;
            const raw = await askAxy(baseUrl, prompt, {
              context: {
                channel: "hush",
                conversationId: `hush:${chatId}`,
                targetUsername: senderLabel,
                recentMessages: hushTurns,
                recentAxyReplies: recentHushReplies,
              },
            });
            const reply = formatReply(raw);
            if (!reply) continue;

            const sentRes = await sendManagedOutput({
              channel: "hush",
              conversationId: `hush:${chatId}`,
              content: reply,
              minGapMs: 4500,
              send: async (safeContent) => {
                runtimeCore.transition("hush", "sending", chatId);
                await callAxyOps(baseUrl, token, "hush.send", {
                  chatId,
                  content: safeContent,
                });
              },
              logLabel: `hush -> ${senderLabel}`,
            });
            if (!sentRes.sent) continue;
            console.log(`[${now()}] hush replied to ${senderLabel}`);
          }
          runtimeCore.transition("hush", "idle");
        }

        if (!missionLockedNow && autoDm) {
          runtimeCore.transition("dm", "scanning");
          const chats = Array.isArray(snapshot?.data?.chats) ? snapshot.data.chats : [];
          for (const chat of chats) {
            const chatId = String(chat?.chat_id || "").trim();
            if (!chatId) continue;

            const messageRes = await callAxyOps(baseUrl, token, "dm.messages", {
              chatId,
              limit: 40,
            });
            const dmRows = Array.isArray(messageRes?.data) ? messageRes.data : [];
            const dmTurns = buildDmContextTurns(
              dmRows,
              user?.id || "",
              botUsername
            );
            const recentDmReplies = extractAssistantRepliesFromTurns(dmTurns, 8);
            const latestIncoming = findLatestIncomingDm(
              dmRows,
              user?.id || ""
            );
            if (!latestIncoming) continue;
            autonomyGovernor.recordUserActivity("dm");

            const noReplyState = getDmNoReplyState(dmRows, user?.id || "");
            const maxAxyMessagesWithoutReply = 1 + dmMaxExtraWithoutReply;
            if (noReplyState.trailingAssistantCount >= maxAxyMessagesWithoutReply) {
              const limitKey = `${chatId}:${String(noReplyState.latestIncomingId || "none")}`;
              if (!dmLimitLogByChat.has(limitKey)) {
                console.log(
                  `[${now()}] dm hold chat=${chatId} (no user reply, sent=${noReplyState.trailingAssistantCount})`
                );
                dmLimitLogByChat.set(limitKey, Date.now());
              }
              runtimeCore.markSkipped("dm", "no-user-reply-limit", {
                conversationId: `dm:${chatId}`,
              });
              continue;
            }

            const lastSentAt = Number(dmLastSentAtByChat.get(chatId) || 0);
            if (dmMinGapSeconds > 0 && Date.now() - lastSentAt < dmMinGapSeconds * 1000) {
              continue;
            }

            if (handledDmMessage.has(latestIncoming.id)) continue;

            handledDmMessage.add(latestIncoming.id);

            const content = String(latestIncoming.content || "").trim();
            const senderLabel = String(chat?.username || "user");
            const shouldReplyDm = dmReplyAll || dmTriggerRegex.test(content);
            if (!shouldReplyDm) continue;

            runtimeCore.transition("dm", "generating", chatId);
            const prompt = `dm from ${senderLabel}: ${content}`;
            const raw = await askAxy(baseUrl, prompt, {
              context: {
                channel: "dm",
                conversationId: `dm:${chatId}`,
                targetUsername: senderLabel,
                recentMessages: dmTurns,
                recentAxyReplies: recentDmReplies,
              },
            });
            const reply = formatReply(raw);
            if (!reply) continue;

            const sentRes = await sendManagedOutput({
              channel: "dm",
              conversationId: `dm:${chatId}`,
              content: reply,
              minGapMs: Math.max(2500, dmMinGapSeconds * 1000),
              send: async (safeContent) => {
                runtimeCore.transition("dm", "sending", chatId);
                await callAxyOps(baseUrl, token, "dm.send", {
                  chatId,
                  content: safeContent,
                });
              },
              logLabel: `dm -> ${senderLabel}`,
            });
            if (!sentRes.sent) continue;
            dmLastSentAtByChat.set(chatId, Date.now());
            console.log(`[${now()}] dm replied to ${senderLabel}`);
          }
          runtimeCore.transition("dm", "idle");
        }

        if (!missionLockedNow && autoBuild) {
          runtimeCore.transition("build", "scanning");
          let targetSpaces = [];

          if (buildSpaceId) {
            targetSpaces = [buildSpaceId];
          } else {
            const spacesRes = await callAxyOps(baseUrl, token, "build.spaces.list");
            targetSpaces = (Array.isArray(spacesRes?.data) ? spacesRes.data : [])
              .filter((space) => space?.can_edit === true && space?.id)
              .map((space) => String(space.id));
          }

          for (const spaceId of targetSpaces) {
            try {
              const snapshotRes = await callAxyOps(baseUrl, token, "build.space.snapshot", {
                spaceId,
              });
              const snapshot = snapshotRes?.data || {};
              const space = snapshot?.space || null;
              const files = Array.isArray(snapshot?.files) ? snapshot.files : [];
              if (!space?.id) continue;

              const requestFile = files.find(
                (file) => normalizeBuildPath(file?.path) === buildRequestPath
              );
              if (!requestFile) continue;

              const requestContent = String(requestFile?.content || "").trim();
              if (!requestContent) continue;

              const signature = `${String(requestFile?.updated_at || "")}:${requestContent}`;
              const previous = handledBuildRequest.get(space.id);
              if (previous === signature) continue;
              handledBuildRequest.set(space.id, signature);
              if (handledBuildRequest.size > 160) {
                const firstKey = handledBuildRequest.keys().next().value;
                if (firstKey) handledBuildRequest.delete(firstKey);
              }

              const fileList = files
                .slice(0, 20)
                .map((file) => `- ${String(file?.path || "unknown")} (${String(file?.language || "text")})`)
                .join("\n");

              const prompt = [
                `You are helping in user-build space "${String(space.title || "subspace")}".`,
                `Space language preference: ${String(space.language_pref || "auto")}.`,
                `Space description: ${String(space.description || "-")}.`,
                `Available files:\n${fileList || "- no files"}`,
                `Request from ${buildRequestPath}:`,
                requestContent,
                "Return concise practical guidance with concrete code when needed.",
              ].join("\n\n");

              const raw = await askAxy(baseUrl, prompt, {
                context: {
                  channel: "build",
                  conversationId: `build:${String(space.id)}`,
                  targetUsername: "space-owner",
                },
              });
              const reply = formatBuildReply(raw);
              if (!reply) continue;

              const content = [
                `# Axy Build Reply`,
                ``,
                `Generated: ${new Date().toISOString()}`,
                `Source: \`${buildRequestPath}\``,
                ``,
                `## Request`,
                requestContent.slice(0, 4000),
                ``,
                `## Reply`,
                reply,
                ``,
              ].join("\n");

              await callAxyOps(baseUrl, token, "build.files.save", {
                spaceId: String(space.id),
                path: buildOutputPath,
                language: "markdown",
                content,
              });
              runtimeCore.markSent("build", { conversationId: `build:${String(space.id)}` });
              console.log(
                `[${now()}] build helper replied space=${String(space.id)} file=${buildOutputPath}`
              );
            } catch (buildErr) {
              const buildMsg =
                buildErr?.body?.error || buildErr.message || "build helper failed";
              if (buildErr?.status === 403 || buildErr?.status === 404) {
                continue;
              }
              console.log(`[${now()}] build helper fail: ${buildMsg}`);
              runtimeCore.markError("build", buildErr, { context: `build.helper:${spaceId}` });
            }
          }
          runtimeCore.transition("build", "idle");
        }

        if (!missionLockedNow && autoBuild && autoBuildFreedom && Date.now() >= nextBuildFreedomAt) {
          runtimeCore.transition("build", "freedom");
          try {
            let targetSpace = String(buildSpaceId || "").trim();

            if (!targetSpace) {
              const spacesRes = await callAxyOps(baseUrl, token, "build.spaces.list");
              const editableSpaces = (Array.isArray(spacesRes?.data) ? spacesRes.data : [])
                .filter((space) => space?.can_edit === true && space?.id)
                .map((space) => String(space.id));

              if (editableSpaces.length === 0) {
                const title = `Axy Lab ${new Date().toISOString().slice(0, 10)}`;
                const createRes = await callAxyOps(baseUrl, token, "build.spaces.create", {
                  title,
                  languagePref: "auto",
                  description: "Axy autonomous build space.",
                });
                targetSpace = String(createRes?.data?.id || "").trim();
              } else {
                targetSpace = editableSpaces[Math.floor(Math.random() * editableSpaces.length)];
              }
            }

            if (targetSpace) {
              const snapshotRes = await callAxyOps(baseUrl, token, "build.space.snapshot", {
                spaceId: targetSpace,
              });
              const snapshot = snapshotRes?.data || {};
              const space = snapshot?.space || {};
              const files = Array.isArray(snapshot?.files) ? snapshot.files : [];
              const stamp = new Date().toISOString().replace(/[:.]/g, "-");
              const autoPath = `axy/auto/${stamp}.md`;
              const fileList = files
                .slice(0, 14)
                .map((file) => `- ${String(file?.path || "unknown")} (${String(file?.language || "text")})`)
                .join("\n");

              const prompt = [
                `Create one concise but concrete build increment for this user-build space.`,
                `Space title: ${String(space?.title || "subspace")}`,
                `Language preference: ${String(space?.language_pref || "auto")}`,
                `Description: ${String(space?.description || "-")}`,
                `Existing files:\n${fileList || "- none yet"}`,
                `Return markdown content only.`,
              ].join("\n\n");

              const raw = await askAxy(baseUrl, prompt, {
                context: {
                  channel: "build",
                  conversationId: `build:auto:${targetSpace}`,
                  targetUsername: "space",
                },
              });
              const reply = formatBuildReply(raw).slice(0, 6000);
              if (reply) {
                await callAxyOps(baseUrl, token, "build.files.save", {
                  spaceId: targetSpace,
                  path: autoPath,
                  language: "markdown",
                  content: reply,
                });
                runtimeCore.markSent("build", { conversationId: `build:auto:${targetSpace}` });
                console.log(
                  `[${now()}] build freedom wrote ${autoPath} in space=${targetSpace}`
                );
              }
            }
          } catch (buildFreedomErr) {
            const msg =
              buildFreedomErr?.body?.error || buildFreedomErr.message || "build freedom failed";
            console.log(`[${now()}] build freedom fail: ${msg}`);
            runtimeCore.markError("build", buildFreedomErr, { context: "build.freedom" });
          } finally {
            runtimeCore.transition("build", "idle");
            nextBuildFreedomAt =
              Date.now() + randomIntRange(buildFreedomMinSeconds, buildFreedomMaxSeconds) * 1000;
          }
        }

        if (!missionLockedNow && autoMatrix && !autoFreedom) {
          runtimeCore.transition("matrix", "moving");
          if (!matrixVisible) {
            const enterRes = await callAxyOps(baseUrl, token, "matrix.enter", {
              x: randomRange(-6, 6),
              z: randomRange(-6, 6),
            });
            matrixVisible = true;
            const pos = enterRes?.data || {};
            runtimeCore.markSent("matrix", { conversationId: "matrix:auto" });
            console.log(
              `[${now()}] matrix entered x=${Number(pos.x || 0).toFixed(2)} z=${Number(pos.z || 0).toFixed(2)}`
            );
          } else {
            const dx = (Math.random() * 2 - 1) * matrixStep;
            const dz = (Math.random() * 2 - 1) * matrixStep;
            const moveRes = await callAxyOps(baseUrl, token, "matrix.move", { dx, dz });
            const pos = moveRes?.data || {};
            runtimeCore.markSent("matrix", { conversationId: "matrix:auto" });
            console.log(
              `[${now()}] matrix moved x=${Number(pos.x || 0).toFixed(2)} z=${Number(pos.z || 0).toFixed(2)}`
            );
          }
          runtimeCore.transition("matrix", "idle");
        }

        if (!missionLockedNow && autoPlay && Date.now() >= nextPlayChatAt) {
          let playNextMin = playChatMinGapSeconds;
          let playNextMax = playChatMaxGapSeconds;
          runtimeCore.transition("play", "scanning");
          try {
            const listRes = await callAxyOps(baseUrl, token, "play.game_chat.list", {
              limit: 36,
            });
            const rows = Array.isArray(listRes?.data) ? listRes.data : [];
            const recentTurns = rows
              .slice(-14)
              .map((row) => ({
                role:
                  String(row?.username || "").toLowerCase() ===
                  String(botUsername || "").toLowerCase()
                    ? "assistant"
                    : "user",
                username: String(row?.username || "user"),
                text: clipForContext(String(row?.content || ""), 240),
              }))
              .filter((turn) => turn.text.length > 0);
            const recentReplies = recentTurns
              .filter((turn) => turn.role === "assistant")
              .map((turn) => turn.text)
              .slice(-8);

            const recentUserRows = rows
              .slice(-16)
              .filter(
                (row) =>
                  String(row?.username || "").toLowerCase() !==
                  String(botUsername || "").toLowerCase()
              );
            const addressedToAxy = recentUserRows.some((row) =>
              triggerRegex.test(String(row?.content || ""))
            );
            if (addressedToAxy) {
              autonomyGovernor.recordUserActivity("game-chat");
            }
            if (!addressedToAxy) {
              playNextMin = Math.max(
                playChatMinGapSeconds * 2,
                playChatMinGapSeconds + 240
              );
              playNextMax = Math.max(playChatMaxGapSeconds * 3, playNextMin + 240);
              if (Math.random() < 0.7) {
                console.log(`[${now()}] play: skipped (no direct prompt)`);
                runtimeCore.markSkipped("play", "no-direct-prompt", {
                  conversationId: "kozmos-play:game-chat",
                });
                continue;
              }
            }

            const prompt =
              "Write one short game-chat line for kozmos.play. Varied tone, no repetitive stillness cliches, max 14 words.";
            const raw = await askAxy(baseUrl, prompt, {
              context: {
                channel: "game-chat",
                conversationId: "kozmos-play:game-chat",
                targetUsername: "players",
                recentMessages: recentTurns,
                recentAxyReplies: recentReplies,
              },
            });
            const content = formatReply(raw).slice(0, 220);
            if (content) {
              const sentRes = await sendManagedOutput({
                channel: "game-chat",
                conversationId: "kozmos-play:game-chat",
                content,
                minGapMs: 16000,
                send: async (safeContent) => {
                  runtimeCore.transition("play", "sending");
                  await callAxyOps(baseUrl, token, "play.game_chat.send", {
                    content: safeContent,
                  });
                },
                logLabel: "play",
              });
              if (sentRes.sent) {
                console.log(`[${now()}] play: game chat sent`);
              }
            }
          } catch (playErr) {
            const msg = playErr?.body?.error || playErr.message || "play chat failed";
            console.log(`[${now()}] play fail: ${msg}`);
            runtimeCore.markError("play", playErr, { context: "play.game_chat" });
          } finally {
            runtimeCore.transition("play", "idle");
            nextPlayChatAt =
              Date.now() + randomIntRange(playNextMin, playNextMax) * 1000;
          }
        }

        if (!missionLockedNow && autoStarfall && starfallOpsEnabled && Date.now() >= nextStarfallAt) {
          runtimeCore.transition("play", "starfall");
          try {
            const focusPool = ["balanced", "aim", "survival", "aggression"];
            const focus = focusPool[randomIntRange(0, focusPool.length - 1)];
            const singleRes = await callAxyOps(baseUrl, token, "play.starfall.single", {
              mode: "single",
              focus,
            });
            const singleData = singleRes?.data || {};
            const run = singleData?.run || {};
            let profile = singleData?.profile || {};

            if (starfallTrainEpisodes > 1) {
              const trainRes = await callAxyOps(baseUrl, token, "play.starfall.train", {
                episodes: starfallTrainEpisodes - 1,
              });
              profile = trainRes?.data?.profile || profile;
            }

            const score = Math.floor(Number(run?.score || 0));
            const round = Math.floor(Number(run?.round || 1));
            const won = Boolean(run?.won);
            const rating = Number(profile?.skill_rating || 0);
            runtimeCore.markSent("play", { conversationId: "kozmos-play:starfall" });
            console.log(
              `[${now()}] starfall: score=${score} round=${round} won=${won} rating=${rating.toFixed(1)}`
            );

            if (
              starfallShareProgress &&
              Math.random() < starfallShareChance &&
              score > 0
            ) {
              const line = won
                ? `starfall single clear â€¢ score ${score} â€¢ round ${round} â€¢ rating ${Math.round(
                    rating
                  )}`
                : `starfall single run â€¢ score ${score} â€¢ round ${round} â€¢ rating ${Math.round(
                    rating
                  )}`;
              await sendManagedOutput({
                channel: "game-chat",
                conversationId: "kozmos-play:starfall",
                content: line,
                minGapMs: 22000,
                send: async (safeContent) => {
                  runtimeCore.transition("play", "sending", "starfall-share");
                  await callAxyOps(baseUrl, token, "play.game_chat.send", {
                    content: safeContent,
                  });
                },
                logLabel: "starfall",
              });
            }
          } catch (starfallErr) {
            const msg =
              starfallErr?.body?.error || starfallErr.message || "starfall ops failed";
            console.log(`[${now()}] starfall fail: ${msg}`);
            runtimeCore.markError("play", starfallErr, { context: "play.starfall" });
            if (/unknown action|route unavailable|capability|not found/i.test(String(msg))) {
              starfallOpsEnabled = false;
              console.log(`[${now()}] starfall ops disabled (backend action unavailable)`);
            }
          } finally {
            runtimeCore.transition("play", "idle");
            nextStarfallAt =
              Date.now() + randomIntRange(starfallMinGapSeconds, starfallMaxGapSeconds) * 1000;
          }
        }

        if (
          !missionLockedNow &&
          autoNight &&
          Date.now() >= nextNightOpsAt &&
          Date.now() >= nightDisabledUntil
        ) {
          runtimeCore.transition("night", "scanning");
          runtimeCore.transition("night", "scanning");
          try {
            const lobbiesRes = await callAxyOps(baseUrl, token, "night.lobbies");
            const lobbies = Array.isArray(lobbiesRes?.data) ? lobbiesRes.data : [];
            nightFailureStreak = 0;

            let joinedLobby = lobbies.find((row) => row?.joined === true);
            if (!joinedLobby && lobbies.length > 0) {
              const joinRes = await callAxyOps(baseUrl, token, "night.join_random_lobby");
              const joinedData = joinRes?.data || {};
              const sessionCode = String(joinedData?.session_code || "").trim();
              if (sessionCode) {
                nightSessionByCode.set(sessionCode, Date.now());
                joinedLobby = lobbies.find((row) => row?.session_code === sessionCode) || {
                  session_id: joinedData?.session_id,
                  session_code: sessionCode,
                };
                runtimeCore.markSent("night", { conversationId: `night:${sessionCode}` });
                console.log(`[${now()}] night: joined lobby ${sessionCode}`);
              }
            }

            const sessionId = String(joinedLobby?.session_id || "").trim();
            if (sessionId) {
              const stateRes = await callAxyOps(baseUrl, token, "night.state", { sessionId });
              const state = stateRes?.data || {};
              const session = state?.session || {};
              const me = state?.me || {};
              const players = Array.isArray(state?.players) ? state.players : [];
              const recentDay = Array.isArray(state?.recent_day_messages)
                ? state.recent_day_messages
                : [];
              const othersSpeaking = recentDay.some(
                (row) =>
                  String(row?.username || "").toLowerCase() !==
                  String(botUsername || "").toLowerCase()
              );
              if (othersSpeaking) {
                autonomyGovernor.recordUserActivity("night-protocol-day");
              }

              if (String(session?.status) === "DAY" && me?.is_alive) {
                const canSpeak =
                  !session?.presence_mode ||
                  !session?.current_speaker_player_id ||
                  String(session.current_speaker_player_id) === String(me.player_id);
                const roundKey = `${String(session.id || sessionId)}:${String(session.round_no || 0)}`;
                if (canSpeak && !nightSentMessageByRound.has(roundKey)) {
                  const dayTurns = recentDay
                    .slice(-12)
                    .map((row) => ({
                      role:
                        String(row?.username || "").toLowerCase() ===
                        String(botUsername || "").toLowerCase()
                          ? "assistant"
                          : "user",
                      username: String(row?.username || "user"),
                      text: clipForContext(String(row?.content || ""), 220),
                    }))
                    .filter((turn) => turn.text.length > 0);
                  const recentReplies = dayTurns
                    .filter((turn) => turn.role === "assistant")
                    .map((turn) => turn.text)
                    .slice(-8);
                  const raw = await askAxy(
                    baseUrl,
                    "Write one concise day-phase Night Protocol message. Grounded, strategic, max 16 words.",
                    {
                      context: {
                        channel: "night-protocol-day",
                        conversationId: `night:${sessionId}:round:${String(session.round_no || 0)}`,
                        targetUsername: "circle",
                        recentMessages: dayTurns,
                        recentAxyReplies: recentReplies,
                      },
                    }
                  );
                  const content = formatReply(raw).slice(0, 220);
                  if (content) {
                    const sentRes = await sendManagedOutput({
                      channel: "night-protocol-day",
                      conversationId: `night:${sessionId}:round:${String(session.round_no || 0)}`,
                      content,
                      minGapMs: 10000,
                      send: async (safeContent) => {
                        runtimeCore.transition("night", "sending", "day-message");
                        await callAxyOps(baseUrl, token, "night.day_message", {
                          sessionId,
                          content: safeContent,
                        });
                      },
                      logLabel: "night",
                    });
                    if (sentRes.sent) {
                      nightSentMessageByRound.add(roundKey);
                      if (nightSentMessageByRound.size > 1200) {
                        const first = nightSentMessageByRound.values().next().value;
                        if (first) nightSentMessageByRound.delete(first);
                      }
                      console.log(`[${now()}] night: day message sent`);
                    }
                  }
                }
              }

              if (String(session?.status) === "VOTING" && me?.is_alive) {
                const roundKey = `${String(session.id || sessionId)}:${String(session.round_no || 0)}`;
                const alreadyVoted = Boolean(state?.my_vote_target_player_id);
                if (!alreadyVoted && !nightVotedByRound.has(roundKey)) {
                  const aliveTargets = players.filter(
                    (player) =>
                      player?.is_alive === true &&
                      String(player?.id || "") !== String(me?.player_id || "")
                  );
                  if (aliveTargets.length > 0) {
                    const target = aliveTargets[Math.floor(Math.random() * aliveTargets.length)];
                    const targetPlayerId = String(target?.id || "").trim();
                    if (targetPlayerId) {
                      await callAxyOps(baseUrl, token, "night.submit_vote", {
                        sessionId,
                        targetPlayerId,
                      });
                      runtimeCore.markSent("night", {
                        conversationId: `night:${sessionId}:round:${String(session.round_no || 0)}`,
                      });
                      nightVotedByRound.add(roundKey);
                      if (nightVotedByRound.size > 1200) {
                        const first = nightVotedByRound.values().next().value;
                        if (first) nightVotedByRound.delete(first);
                      }
                      console.log(`[${now()}] night: vote submitted`);
                    }
                  }
                }
              }
            }
          } catch (nightErr) {
            const msg = nightErr?.body?.error || nightErr.message || "night ops failed";
            if (!/no joinable lobby/i.test(String(msg))) {
              console.log(`[${now()}] night fail: ${msg}`);
              nightFailureStreak += 1;
              if (
                nightFailureStreak >= 3 &&
                /unknown action|route unavailable|capability|not found|schema missing|load failed/i.test(
                  String(msg)
                )
              ) {
                nightDisabledUntil = Date.now() + 15 * 60 * 1000;
                nightFailureStreak = 0;
                console.log(
                  `[${now()}] night ops temporarily disabled for 15m (repeated backend failures)`
                );
              }
            }
            runtimeCore.markError("night", nightErr, { context: "night.ops" });
          } finally {
            runtimeCore.transition("night", "idle");
            nextNightOpsAt =
              Date.now() + randomIntRange(nightOpsMinGapSeconds, nightOpsMaxGapSeconds) * 1000;
          }
        }

        if (!missionLockedNow && quiteSwarmRoomOpsEnabled && Date.now() >= nextQuiteSwarmRoomAt) {
          runtimeCore.transition("swarm", "room-ops");
          try {
            const roomRes = await callAxyOps(baseUrl, token, "quite_swarm.room");
            const room = roomRes?.data || {};
            const roomStatus =
              String(room?.status || "idle").toLowerCase() === "running"
                ? "running"
                : "idle";
            const roomHostUserId = String(room?.host_user_id || "").trim();
            const isHost = Boolean(user?.id) && roomHostUserId === String(user?.id || "");

            quiteSwarmRoomStatus = roomStatus;
            quiteSwarmRoomHostUserId = roomHostUserId;

            if (roomStatus !== "running") {
              if (Math.random() < quiteSwarmRoomStartChance) {
                const roomStartRes = await callAxyOps(
                  baseUrl,
                  token,
                  "quite_swarm.room_start",
                  {
                    x: randomRange(-18, 18),
                    y: randomRange(-18, 18),
                  }
                );
                const startedRoom = roomStartRes?.data || {};
                quiteSwarmRoomStatus =
                  String(startedRoom?.status || "idle").toLowerCase() === "running"
                    ? "running"
                    : "idle";
                quiteSwarmRoomHostUserId = String(
                  startedRoom?.host_user_id || user?.id || ""
                ).trim();
                quiteSwarmVisible = true;
                runtimeCore.markSent("swarm", { conversationId: "quite-swarm-room" });
                console.log(`[${now()}] quite-swarm room started`);
              }
            } else if (isHost && Math.random() < quiteSwarmRoomStopChance) {
              await callAxyOps(baseUrl, token, "quite_swarm.room_stop");
              quiteSwarmRoomStatus = "idle";
              quiteSwarmRoomHostUserId = "";
              quiteSwarmVisible = false;
              runtimeCore.markSent("swarm", { conversationId: "quite-swarm-room" });
              console.log(`[${now()}] quite-swarm room stopped`);
            }
          } catch (swarmRoomErr) {
            const msg =
              swarmRoomErr?.body?.error || swarmRoomErr.message || "quite swarm room ops failed";
            console.log(`[${now()}] quite-swarm room fail: ${msg}`);
            runtimeCore.markError("swarm", swarmRoomErr, { context: "swarm.room" });
            if (
              /unknown action|route unavailable|capability|not found/i.test(String(msg))
            ) {
              quiteSwarmRoomOpsEnabled = false;
              console.log(
                `[${now()}] quite-swarm room ops disabled (backend action unavailable)`
              );
            }
          } finally {
            runtimeCore.transition("swarm", "idle");
            nextQuiteSwarmRoomAt =
              Date.now() +
              randomIntRange(quiteSwarmRoomMinGapSeconds, quiteSwarmRoomMaxGapSeconds) * 1000;
          }
        }

        if (!missionLockedNow && autoQuiteSwarm && Date.now() >= nextQuiteSwarmAt) {
          runtimeCore.transition("swarm", "moving");
          try {
            if (quiteSwarmRoomOpsEnabled && quiteSwarmRoomStatus !== "running") {
              if (quiteSwarmVisible) {
                await callAxyOps(baseUrl, token, "quite_swarm.exit");
                quiteSwarmVisible = false;
                runtimeCore.markSent("swarm", { conversationId: "quite-swarm" });
                console.log(`[${now()}] quite-swarm hidden while room idle`);
              }
              nextQuiteSwarmAt =
                Date.now() + randomIntRange(quiteSwarmMinGapSeconds, quiteSwarmMaxGapSeconds) * 1000;
              continue;
            }

            if (!quiteSwarmVisible) {
              const enterRes = await callAxyOps(baseUrl, token, "quite_swarm.enter", {
                x: randomRange(-18, 18),
                y: randomRange(-18, 18),
              });
              quiteSwarmVisible = true;
              const pos = enterRes?.data || {};
              runtimeCore.markSent("swarm", { conversationId: "quite-swarm" });
              console.log(
                `[${now()}] quite-swarm entered x=${Number(pos.x || 0).toFixed(2)} y=${Number(pos.y || 0).toFixed(2)}`
              );
            } else if (!quiteSwarmRoomOpsEnabled && Math.random() < quiteSwarmExitChance) {
              await callAxyOps(baseUrl, token, "quite_swarm.exit");
              quiteSwarmVisible = false;
              runtimeCore.markSent("swarm", { conversationId: "quite-swarm" });
              console.log(`[${now()}] quite-swarm exited`);
            } else {
              const burst = Math.random() < 0.38 ? 2 : 1;
              let lastPos = null;
              for (let i = 0; i < burst; i += 1) {
                const scale = 1 + i * 0.38;
                const moveRes = await callAxyOps(baseUrl, token, "quite_swarm.move", {
                  dx: (Math.random() * 2 - 1) * quiteSwarmStep * scale,
                  dy: (Math.random() * 2 - 1) * quiteSwarmStep * scale,
                });
                lastPos = moveRes?.data || lastPos;
              }
              const pos = lastPos || {};
              runtimeCore.markSent("swarm", { conversationId: "quite-swarm" });
              console.log(
                `[${now()}] quite-swarm moved x=${Number(pos.x || 0).toFixed(2)} y=${Number(pos.y || 0).toFixed(2)}`
              );
            }
          } catch (swarmErr) {
            const msg = swarmErr?.body?.error || swarmErr.message || "quite swarm ops failed";
            console.log(`[${now()}] quite-swarm fail: ${msg}`);
            runtimeCore.markError("swarm", swarmErr, { context: "swarm.move" });
          } finally {
            runtimeCore.transition("swarm", "idle");
            nextQuiteSwarmAt =
              Date.now() + randomIntRange(quiteSwarmMinGapSeconds, quiteSwarmMaxGapSeconds) * 1000;
          }
        }

        if (!missionLockedNow && autoFreedom && Date.now() >= nextFreedomAt) {
          runtimeCore.transition("freedom", "planning");
          const freedomAction = pickWeightedAction({
            matrix: freedomMatrixWeight,
            note: freedomNoteWeight,
            shared: freedomSharedWeight,
            hush: freedomHushWeight,
          });

          if (freedomAction && user?.id) {
            try {
              if (freedomAction === "matrix") {
                runtimeCore.transition("freedom", "matrix");
                freedomMatrixStreak += 1;
                if (matrixVisible && Math.random() < freedomMatrixExitChance) {
                  await callAxyOps(baseUrl, token, "matrix.exit");
                  matrixVisible = false;
                  freedomMatrixStreak = 0;
                  runtimeCore.markSent("matrix", { conversationId: "matrix:freedom" });
                  console.log(`[${now()}] freedom: matrix exit`);
                } else if (matrixVisible && freedomMatrixStreak >= 3 && Math.random() < 0.7) {
                  await callAxyOps(baseUrl, token, "matrix.exit");
                  matrixVisible = false;
                  freedomMatrixStreak = 0;
                  runtimeCore.markSent("matrix", { conversationId: "matrix:freedom" });
                  console.log(`[${now()}] freedom: matrix cooldown exit`);
                } else if (!matrixVisible) {
                  const enterRes = await callAxyOps(baseUrl, token, "matrix.enter", {
                    x: randomRange(-7, 7),
                    z: randomRange(-7, 7),
                  });
                  matrixVisible = true;
                  const pos = enterRes?.data || {};
                  runtimeCore.markSent("matrix", { conversationId: "matrix:freedom" });
                  console.log(
                    `[${now()}] freedom: matrix enter x=${Number(pos.x || 0).toFixed(2)} z=${Number(pos.z || 0).toFixed(2)}`
                  );
                } else {
                  let pos = null;
                  const burstCount = randomIntRange(1, 3);
                  for (let i = 0; i < burstCount; i += 1) {
                    const moveRes = await callAxyOps(baseUrl, token, "matrix.move", {
                      dx: (Math.random() * 2 - 1) * matrixStep * (1.8 + i * 0.35),
                      dz: (Math.random() * 2 - 1) * matrixStep * (1.8 + i * 0.35),
                    });
                    pos = moveRes?.data || pos;
                  }
                  runtimeCore.markSent("matrix", { conversationId: "matrix:freedom" });
                  console.log(
                    `[${now()}] freedom: matrix burst x=${Number(pos?.x || 0).toFixed(2)} z=${Number(pos?.z || 0).toFixed(2)}`
                  );
                }
              } else if (freedomAction === "note") {
                runtimeCore.transition("freedom", "note");
                freedomMatrixStreak = 0;
                const prompt =
                  "Write one short private note for Axy's my home. Calm and intentional, max 18 words.";
                const raw = await askAxy(baseUrl, prompt, {
                  context: {
                    channel: "my-home-note",
                    conversationId: `note:${user.id}`,
                    targetUsername: botUsername,
                  },
                });
                const content = formatReply(raw).slice(0, 320);
                if (content) {
                  const sentRes = await sendManagedOutput({
                    channel: "my-home-note",
                    conversationId: `note:${user.id}`,
                    content,
                    minGapMs: 12000,
                    send: async (safeContent) => {
                      await callAxyOps(baseUrl, token, "notes.create", { content: safeContent });
                    },
                    logLabel: "freedom-note",
                  });
                  if (sentRes.sent) {
                    console.log(`[${now()}] freedom: note created`);
                  }
                }
              } else if (freedomAction === "shared") {
                runtimeCore.transition("freedom", "shared");
                freedomMatrixStreak = 0;
                const nowMs = Date.now();
                const hourMs = 60 * 60 * 1000;
                while (freedomSharedSentAt.length > 0 && nowMs - freedomSharedSentAt[0] > hourMs) {
                  freedomSharedSentAt.shift();
                }
                const withinGap =
                  lastFreedomSharedAt > 0 &&
                  nowMs - lastFreedomSharedAt < freedomSharedMinGapSeconds * 1000;
                const reachedHourlyCap =
                  freedomSharedMaxPerHour > 0 &&
                  freedomSharedSentAt.length >= freedomSharedMaxPerHour;
                if (withinGap || reachedHourlyCap) {
                  console.log(
                    `[${now()}] freedom: shared skipped (rate-limit gap=${withinGap} hourlyCap=${reachedHourlyCap})`
                  );
                  runtimeCore.markSkipped("freedom", "shared-rate-limit", {
                    conversationId: "shared:main",
                  });
                } else {
                  const prompt =
                    "Write one short shared-space line as Axy. Concrete and varied, no stillness cliches, no mention tags, max 16 words.";
                  const raw = await askAxy(baseUrl, prompt, {
                    context: {
                      channel: "shared",
                      conversationId: "shared:main",
                      targetUsername: "everyone",
                      recentMessages: sharedRecentTurns.slice(-10),
                      recentAxyReplies: sharedRecentAxyReplies.slice(-8),
                    },
                  });
                  const content = formatReply(raw).slice(0, 240);
                  if (content) {
                    const sentRes = await sendManagedOutput({
                      channel: "shared",
                      conversationId: "shared:main",
                      content,
                      minGapMs: Math.max(3500, pollSeconds * 1000),
                      send: async (safeContent) => {
                        await postShared(baseUrl, token, safeContent);
                      },
                      logLabel: "freedom-shared",
                    });
                    if (sentRes.sent) {
                      lastFreedomSharedAt = nowMs;
                      freedomSharedSentAt.push(nowMs);
                      pushLimited(
                        sharedRecentTurns,
                        {
                          role: "assistant",
                          username: botUsername,
                          text: clipForContext(sentRes.content, 240),
                        },
                        28
                      );
                      pushLimited(sharedRecentAxyReplies, clipForContext(sentRes.content, 220), 12);
                      console.log(`[${now()}] freedom: shared message sent`);
                    }
                  }
                }
              } else if (freedomAction === "hush") {
                runtimeCore.transition("freedom", "hush");
                freedomMatrixStreak = 0;
                if (Math.random() > freedomHushStartChance) {
                  runtimeCore.markSkipped("freedom", "hush-start-chance");
                  continue;
                }
                const presentUsers = Array.isArray(snapshot?.data?.present_users)
                  ? snapshot.data.present_users
                  : [];
                const nowMs = Date.now();
                const cooldownMs = hushStartCooldownMinutes * 60 * 1000;
                for (const [targetUserId, ts] of hushStarterCooldown.entries()) {
                  if (nowMs - ts > cooldownMs) hushStarterCooldown.delete(targetUserId);
                }

                const candidates = presentUsers.filter((row) => {
                  const targetUserId = String(row?.user_id || "").trim();
                  const targetUsername = String(row?.username || "").trim();
                  if (!targetUserId) return false;
                  if (targetUserId === user.id) return false;
                  if (
                    targetUsername &&
                    targetUsername.toLowerCase() === String(botUsername || "").toLowerCase()
                  ) {
                    return false;
                  }
                  if (hushStarterCooldown.has(targetUserId)) return false;
                  return true;
                });

                if (candidates.length > 0) {
                  const target = candidates[Math.floor(Math.random() * candidates.length)];
                  const targetUserId = String(target.user_id);
                  const targetUsername = String(target.username || "user");

                  const createRes = await callAxyOps(baseUrl, token, "hush.create_with", {
                    targetUserId,
                  });
                  const chatId = String(createRes?.data?.id || "").trim();
                  hushStarterCooldown.set(targetUserId, nowMs);
                  if (chatId) {
                    const openerPrompt = `Write one short hush opener for ${targetUsername}. Calm and friendly, max 14 words.`;
                    const openerRaw = await askAxy(baseUrl, openerPrompt, {
                      context: {
                        channel: "hush",
                        conversationId: `hush:${chatId}`,
                        targetUsername,
                      },
                    });
                    const opener = formatReply(openerRaw).slice(0, 180);
                    if (opener) {
                      await sendManagedOutput({
                        channel: "hush",
                        conversationId: `hush:${chatId}`,
                        content: opener,
                        minGapMs: 4500,
                        send: async (safeContent) => {
                          await callAxyOps(baseUrl, token, "hush.send", {
                            chatId,
                            content: safeContent,
                          });
                        },
                        logLabel: "freedom-hush",
                      });
                    }
                  }
                  console.log(`[${now()}] freedom: hush started with ${targetUsername}`);
                }
              }
            } catch (freedomErr) {
              const msg =
                freedomErr?.body?.error || freedomErr.message || "freedom action failed";
              console.log(`[${now()}] freedom fail: ${msg}`);
              runtimeCore.markError("freedom", freedomErr, { context: `freedom:${freedomAction}` });
            }
          }

          nextFreedomAt =
            Date.now() + randomIntRange(freedomMinSeconds, freedomMaxSeconds) * 1000;
          runtimeCore.transition("freedom", "idle");
        }
        runtimeCore.transition("ops", "idle");
      } catch (err) {
        const msg = err?.body?.error || err.message || "ops loop error";
        console.log(`[${now()}] ops fail: ${msg}`);
        runtimeCore.markError("ops", err, { context: "ops-loop" });
        runtimeCore.transition("ops", "idle");
        if (shouldDisableOps(err)) {
          opsEnabled = false;
          console.log(`[${now()}] ops disabled (capability/route unavailable)`);
        }
        if (err?.status === 401) {
          console.log(`[${now()}] token unauthorized in ops loop, exiting.`);
          clearInterval(heartbeat);
          clearInterval(evalWriter);
          await writeEvalSnapshot("unauthorized-ops");
          process.exit(1);
        }
      }
    }

    if (stopping) break;
    await sleep(pollSeconds * 1000);
  }
}

main().catch((err) => {
  console.error(`[${now()}] fatal: ${err?.message || err}`);
  process.exit(1);
});

