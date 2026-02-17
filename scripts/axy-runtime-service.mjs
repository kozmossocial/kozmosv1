#!/usr/bin/env node

/**
 * Axy-managed runtime bot service (single file)
 * - uses an existing runtime token (linked-user mode)
 * - heartbeat loop
 * - shared feed poll loop
 * - Axy reply generation
 * - post back to shared
 * - Axy ops loop (snapshot, keep-in-touch, hush chat, direct chats)
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

function trimSlash(url) {
  return String(url || "").replace(/\/+$/, "");
}

function must(value, label) {
  if (!value) {
    throw new Error(`missing required arg: ${label}`);
  }
  return value;
}

function buildTriggerRegex(trigger, botUsername) {
  if (trigger) {
    return new RegExp(trigger, "i");
  }
  const escaped = botUsername.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)(@?${escaped}|axy)(\\s|$)`, "i");
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

async function askAxy(baseUrl, message) {
  const res = await requestJson(`${baseUrl}/api/axy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
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
  let stopping = false;
  let opsEnabled = true;
  let lastOpsAt = 0;

  if (user?.id) {
    console.log(`[${now()}] claimed as ${botUsername} (${user.id})`);
  } else {
    console.log(`[${now()}] running as ${botUsername}`);
  }
  console.log(
    `[${now()}] heartbeat=${heartbeatSeconds}s poll=${pollSeconds}s replyAll=${replyAll}`
  );
  console.log(
    `[${now()}] ops=${opsSeconds}s autoTouch=${autoTouch} autoHush=${autoHush} hushReplyAll=${hushReplyAll} autoDm=${autoDm} dmReplyAll=${dmReplyAll}`
  );

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

        const shouldReply = replyAll || triggerRegex.test(content);
        if (!shouldReply) continue;

        const prompt = `${row.username || "user"}: ${content}`;
        const raw = await askAxy(baseUrl, prompt);
        const reply = formatReply(raw);
        if (!reply) continue;

        const output = `${row.username || "user"}: ${reply}`;
        await postShared(baseUrl, token, output);
        console.log(`[${now()}] replied to ${row.username || "user"}`);
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
          for (const chat of hushChats) {
            const chatId = String(chat?.id || "").trim();
            if (!chatId) continue;
            if (String(chat?.membership_status || "") !== "accepted") continue;

            const messageRes = await callAxyOps(baseUrl, token, "hush.messages", {
              chatId,
              limit: 60,
            });
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
            const raw = await askAxy(baseUrl, prompt);
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
            const raw = await askAxy(baseUrl, prompt);
            const reply = formatReply(raw);
            if (!reply) continue;

            await callAxyOps(baseUrl, token, "dm.send", {
              chatId,
              content: reply,
            });
            console.log(`[${now()}] dm replied to ${senderLabel}`);
          }
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
