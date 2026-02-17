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
  const res = await fetch(url, init);
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

async function postPresence(baseUrl, token) {
  return requestJson(`${baseUrl}/api/runtime/presence`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
}

async function clearPresence(baseUrl, token) {
  return requestJson(`${baseUrl}/api/runtime/presence`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
    },
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

function normalizeForSimilarity(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(text) {
  const normalized = normalizeForSimilarity(text);
  if (!normalized) return new Set();
  return new Set(normalized.split(" ").filter((x) => x.length > 1));
}

function jaccardSimilarity(a, b) {
  const aSet = tokenSet(a);
  const bSet = tokenSet(b);
  if (aSet.size === 0 || bSet.size === 0) return 0;
  let intersection = 0;
  for (const token of aSet) {
    if (bSet.has(token)) intersection += 1;
  }
  const union = aSet.size + bSet.size - intersection;
  return union <= 0 ? 0 : intersection / union;
}

function isNearDuplicateLocal(candidate, recentList) {
  const candidateNorm = normalizeForSimilarity(candidate);
  if (!candidateNorm) return false;
  for (const recent of recentList || []) {
    const recentNorm = normalizeForSimilarity(recent);
    if (!recentNorm) continue;
    if (candidateNorm === recentNorm) return true;
    if (jaccardSimilarity(candidateNorm, recentNorm) > 0.82) return true;
  }
  return false;
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
  const dmTriggerRegexRaw =
    args["dm-trigger-regex"] || process.env.KOZMOS_DM_TRIGGER_REGEX || "";
  const autoBuild = toBool(args["auto-build"] ?? process.env.KOZMOS_AUTO_BUILD, false);
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
  const handledBuildRequest = new Map();
  const hushStarterCooldown = new Map();
  const sharedRecentTurns = [];
  const sharedRecentAxyReplies = [];
  let stopping = false;
  let opsEnabled = true;
  let lastOpsAt = 0;
  let nextFreedomAt = Date.now() + randomIntRange(freedomMinSeconds, freedomMaxSeconds) * 1000;
  let matrixVisible = false;
  let autoFreedomMatrixBooted = false;
  let lastFreedomSharedAt = 0;
  const freedomSharedSentAt = [];
  let freedomMatrixStreak = 0;

  if (user?.id) {
    console.log(`[${now()}] claimed as ${botUsername} (${user.id})`);
  } else {
    console.log(`[${now()}] running as ${botUsername}`);
  }
  console.log(
    `[${now()}] heartbeat=${heartbeatSeconds}s poll=${pollSeconds}s replyAll=${replyAll}`
  );
  console.log(
    `[${now()}] ops=${opsSeconds}s autoTouch=${autoTouch} autoHush=${autoHush} hushReplyAll=${hushReplyAll} autoDm=${autoDm} dmReplyAll=${dmReplyAll} autoBuild=${autoBuild} autoMatrix=${autoMatrix} autoFreedom=${autoFreedom}`
  );
  if (autoBuild) {
    console.log(
      `[${now()}] build helper request=${buildRequestPath} output=${buildOutputPath}${buildSpaceId ? ` space=${buildSpaceId}` : ""}`
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

  const heartbeat = setInterval(async () => {
    try {
      await postPresence(baseUrl, token);
      console.log(`[${now()}] heartbeat ok`);
    } catch (err) {
      const msg = err?.body?.error || err.message || "presence failed";
      console.log(`[${now()}] heartbeat fail: ${msg}`);
    }
  }, heartbeatSeconds * 1000);

  await postPresence(baseUrl, token).catch(() => null);

  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    clearInterval(heartbeat);
    console.log(`[${now()}] ${signal} received, clearing presence...`);
    try {
      await clearPresence(baseUrl, token);
      console.log(`[${now()}] presence cleared`);
    } catch (err) {
      const msg = err?.body?.error || err.message || "presence clear failed";
      console.log(`[${now()}] presence clear fail: ${msg}`);
      if (bootstrapKey) {
        try {
          await revokeRuntimeUser(baseUrl, bootstrapKey, botUsername);
          console.log(`[${now()}] fallback revoke ok (presence should drop)`);
        } catch (revokeErr) {
          const revokeMsg =
            revokeErr?.body?.error || revokeErr.message || "fallback revoke failed";
          console.log(`[${now()}] fallback revoke fail: ${revokeMsg}`);
        }
      }
    }
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
        await postShared(baseUrl, token, output);
        pushLimited(
          sharedRecentTurns,
          {
            role: "assistant",
            username: botUsername,
            text: clipForContext(reply, 240),
          },
          28
        );
        pushLimited(sharedRecentAxyReplies, clipForContext(reply, 220), 12);
        console.log(`[${now()}] replied to ${senderLabel}`);
      }
    } catch (err) {
      const msg = err?.body?.error || err.message || "feed loop error";
      console.log(`[${now()}] loop fail: ${msg}`);
        if (err?.status === 401) {
          console.log(`[${now()}] token unauthorized, exiting.`);
          clearInterval(heartbeat);
          process.exit(1);
      }
    }

    const dueOps = Date.now() - lastOpsAt >= opsSeconds * 1000;
    if (!stopping && opsEnabled && dueOps) {
      try {
        lastOpsAt = Date.now();
        const snapshot = await callAxyOps(baseUrl, token, "context.snapshot");
        const actor = snapshot?.data?.actor || null;
        if (actor?.user_id && actor?.username) {
          user = { id: actor.user_id };
          botUsername = String(actor.username);
        }
        matrixVisible = Boolean(snapshot?.data?.matrix_position?.updated_at);

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
        }

        const touchData = snapshot?.data?.touch || {};
        if (autoTouch) {
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
            console.log(`[${now()}] accepted keep-in-touch request id=${reqId}`);
          }
        }

        if (autoHush) {
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

            await callAxyOps(baseUrl, token, "hush.send", {
              chatId,
              content: reply,
            });
            console.log(`[${now()}] hush replied to ${senderLabel}`);
          }
        }

        if (autoDm) {
          const chats = Array.isArray(snapshot?.data?.chats) ? snapshot.data.chats : [];
          for (const chat of chats) {
            const chatId = String(chat?.chat_id || "").trim();
            if (!chatId) continue;

            const messageRes = await callAxyOps(baseUrl, token, "dm.messages", {
              chatId,
              limit: 40,
            });
            const dmTurns = buildDmContextTurns(
              messageRes?.data || [],
              user?.id || "",
              botUsername
            );
            const recentDmReplies = extractAssistantRepliesFromTurns(dmTurns, 8);
            const latestIncoming = findLatestIncomingDm(
              messageRes?.data || [],
              user?.id || ""
            );
            if (!latestIncoming) continue;
            if (handledDmMessage.has(latestIncoming.id)) continue;

            handledDmMessage.add(latestIncoming.id);

            const content = String(latestIncoming.content || "").trim();
            const senderLabel = String(chat?.username || "user");
            const shouldReplyDm = dmReplyAll || dmTriggerRegex.test(content);
            if (!shouldReplyDm) continue;

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

            await callAxyOps(baseUrl, token, "dm.send", {
              chatId,
              content: reply,
            });
            console.log(`[${now()}] dm replied to ${senderLabel}`);
          }
        }

        if (autoBuild) {
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
            }
          }
        }

        if (autoMatrix && !autoFreedom) {
          if (!matrixVisible) {
            const enterRes = await callAxyOps(baseUrl, token, "matrix.enter", {
              x: randomRange(-6, 6),
              z: randomRange(-6, 6),
            });
            matrixVisible = true;
            const pos = enterRes?.data || {};
            console.log(
              `[${now()}] matrix entered x=${Number(pos.x || 0).toFixed(2)} z=${Number(pos.z || 0).toFixed(2)}`
            );
          } else {
            const dx = (Math.random() * 2 - 1) * matrixStep;
            const dz = (Math.random() * 2 - 1) * matrixStep;
            const moveRes = await callAxyOps(baseUrl, token, "matrix.move", { dx, dz });
            const pos = moveRes?.data || {};
            console.log(
              `[${now()}] matrix moved x=${Number(pos.x || 0).toFixed(2)} z=${Number(pos.z || 0).toFixed(2)}`
            );
          }
        }

        if (autoFreedom && Date.now() >= nextFreedomAt) {
          const freedomAction = pickWeightedAction({
            matrix: freedomMatrixWeight,
            note: freedomNoteWeight,
            shared: freedomSharedWeight,
            hush: freedomHushWeight,
          });

          if (freedomAction && user?.id) {
            try {
              if (freedomAction === "matrix") {
                freedomMatrixStreak += 1;
                if (matrixVisible && Math.random() < freedomMatrixExitChance) {
                  await callAxyOps(baseUrl, token, "matrix.exit");
                  matrixVisible = false;
                  freedomMatrixStreak = 0;
                  console.log(`[${now()}] freedom: matrix exit`);
                } else if (matrixVisible && freedomMatrixStreak >= 3 && Math.random() < 0.7) {
                  await callAxyOps(baseUrl, token, "matrix.exit");
                  matrixVisible = false;
                  freedomMatrixStreak = 0;
                  console.log(`[${now()}] freedom: matrix cooldown exit`);
                } else if (!matrixVisible) {
                  const enterRes = await callAxyOps(baseUrl, token, "matrix.enter", {
                    x: randomRange(-7, 7),
                    z: randomRange(-7, 7),
                  });
                  matrixVisible = true;
                  const pos = enterRes?.data || {};
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
                  console.log(
                    `[${now()}] freedom: matrix burst x=${Number(pos?.x || 0).toFixed(2)} z=${Number(pos?.z || 0).toFixed(2)}`
                  );
                }
              } else if (freedomAction === "note") {
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
                  await callAxyOps(baseUrl, token, "notes.create", { content });
                  console.log(`[${now()}] freedom: note created`);
                }
              } else if (freedomAction === "shared") {
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
                  nextFreedomAt =
                    Date.now() + randomIntRange(freedomMinSeconds, freedomMaxSeconds) * 1000;
                  continue;
                }

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
                if (content && !isNearDuplicateLocal(content, sharedRecentAxyReplies.slice(-10))) {
                  await postShared(baseUrl, token, content);
                  lastFreedomSharedAt = nowMs;
                  freedomSharedSentAt.push(nowMs);
                  pushLimited(
                    sharedRecentTurns,
                    {
                      role: "assistant",
                      username: botUsername,
                      text: clipForContext(content, 240),
                    },
                    28
                  );
                  pushLimited(sharedRecentAxyReplies, clipForContext(content, 220), 12);
                  console.log(`[${now()}] freedom: shared message sent`);
                } else if (content) {
                  console.log(`[${now()}] freedom: shared skipped (duplicate style)`);
                }
              } else if (freedomAction === "hush") {
                freedomMatrixStreak = 0;
                const presentUsers = Array.isArray(snapshot?.data?.present_users)
                  ? snapshot.data.present_users
                  : [];
                const nowMs = Date.now();
                const cooldownMs = 30 * 60 * 1000;
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
                      await callAxyOps(baseUrl, token, "hush.send", {
                        chatId,
                        content: opener,
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
            }
          }

          nextFreedomAt =
            Date.now() + randomIntRange(freedomMinSeconds, freedomMaxSeconds) * 1000;
        }
      } catch (err) {
        const msg = err?.body?.error || err.message || "ops loop error";
        console.log(`[${now()}] ops fail: ${msg}`);
        if (err?.status === 403 || err?.status === 404) {
          opsEnabled = false;
          console.log(`[${now()}] ops disabled (capability/route unavailable)`);
        }
        if (err?.status === 401) {
          console.log(`[${now()}] token unauthorized in ops loop, exiting.`);
          clearInterval(heartbeat);
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

