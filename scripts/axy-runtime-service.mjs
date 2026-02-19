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
import { mkdir, writeFile } from "node:fs/promises";
import {
  ensureQuestionPunctuation,
  isNearDuplicate,
  normalizeForSimilarity,
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
  const buildSpaceId = String(
    args["build-space-id"] || process.env.KOZMOS_BUILD_SPACE_ID || ""
  ).trim();
  const buildRequestPath = normalizeBuildPath(
    args["build-request-path"] || process.env.KOZMOS_BUILD_REQUEST_PATH || "axy.request.md"
  );
  const buildOutputPath = normalizeBuildPath(
    args["build-output-path"] || process.env.KOZMOS_BUILD_OUTPUT_PATH || "axy.reply.md"
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
  let nextPlayChatAt =
    Date.now() + randomIntRange(playChatMinGapSeconds, playChatMaxGapSeconds) * 1000;
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
      autoPlay,
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

  if (user?.id) {
    console.log(`[${now()}] claimed as ${botUsername} (${user.id})`);
  } else {
    console.log(`[${now()}] running as ${botUsername}`);
  }
  console.log(
    `[${now()}] heartbeat=${heartbeatSeconds}s poll=${pollSeconds}s replyAll=${replyAll}`
  );
  console.log(
    `[${now()}] ops=${opsSeconds}s autoTouch=${autoTouch} autoTouchRequest=${autoTouchRequest} autoHush=${autoHush} hushReplyAll=${hushReplyAll} autoDm=${autoDm} dmReplyAll=${dmReplyAll} autoBuild=${autoBuild} autoBuildFreedom=${autoBuildFreedom} autoPlay=${autoPlay} autoNight=${autoNight} autoQuiteSwarm=${autoQuiteSwarm} autoQuiteSwarmRoom=${autoQuiteSwarmRoom} autoMatrix=${autoMatrix} autoFreedom=${autoFreedom}`
  );
  if (autoBuild) {
    console.log(
      `[${now()}] build helper request=${buildRequestPath} output=${buildOutputPath}${buildSpaceId ? ` space=${buildSpaceId}` : ""}`
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
      `[${now()}] freedom shared limits minGap=${freedomSharedMinGapSeconds}s maxPerHour=${freedomSharedMaxPerHour} hushMaxChatsPerCycle=${hushMaxChatsPerCycle}`
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

        if (autoFreedom && !autoFreedomMatrixBooted && !matrixVisible) {
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
        } else if (autoFreedom && !autoFreedomMatrixBooted) {
          autoFreedomMatrixBooted = true;
        }

        if (autoFreedom && matrixVisible && Math.random() < freedomMatrixDriftChance) {
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
        if (autoTouch) {
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

        if (autoTouchRequest && Date.now() >= nextTouchRequestAt) {
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

        if (autoHush) {
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

        if (autoDm) {
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

        if (autoBuild) {
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

        if (autoBuild && autoBuildFreedom && Date.now() >= nextBuildFreedomAt) {
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

        if (autoMatrix && !autoFreedom) {
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

        if (autoPlay && Date.now() >= nextPlayChatAt) {
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

        if (autoNight && Date.now() >= nextNightOpsAt && Date.now() >= nightDisabledUntil) {
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

        if (quiteSwarmRoomOpsEnabled && Date.now() >= nextQuiteSwarmRoomAt) {
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

        if (autoQuiteSwarm && Date.now() >= nextQuiteSwarmAt) {
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

        if (autoFreedom && Date.now() >= nextFreedomAt) {
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
                const presentUsers = Array.isArray(snapshot?.data?.present_users)
                  ? snapshot.data.present_users
                  : [];
                const nowMs = Date.now();
                const cooldownMs = 90 * 60 * 1000;
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

