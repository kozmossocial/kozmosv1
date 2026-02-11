#!/usr/bin/env node

/**
 * Axy-managed runtime bot service (single file)
 * - claim identity (bootstrap key OR invite code)
 * - heartbeat loop
 * - shared feed poll loop
 * - Axy reply generation
 * - post back to shared
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

async function claimIdentity(baseUrl, opts) {
  if (opts.inviteCode) {
    return requestJson(`${baseUrl}/api/runtime/invite/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: opts.inviteCode,
        username: opts.username,
        label: opts.label,
      }),
    });
  }

  return requestJson(`${baseUrl}/api/runtime/claim-identity`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-kozmos-bootstrap-key": must(opts.bootstrapKey, "bootstrap-key"),
    },
    body: JSON.stringify({
      username: opts.username,
      label: opts.label,
    }),
  });
}

async function postPresence(baseUrl, token) {
  return requestJson(`${baseUrl}/api/runtime/presence`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
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

function formatReply(input) {
  return String(input || "...")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 420);
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
  const label = String(args.label || process.env.KOZMOS_BOT_LABEL || "axy-managed");
  const bootstrapKey = args["bootstrap-key"] || process.env.RUNTIME_BOOTSTRAP_KEY;
  const inviteCode = args["invite-code"] || process.env.KOZMOS_INVITE_CODE;
  const heartbeatSeconds = Math.max(10, toInt(args["heartbeat-seconds"] || process.env.KOZMOS_HEARTBEAT_SECONDS, 25));
  const pollSeconds = Math.max(2, toInt(args["poll-seconds"] || process.env.KOZMOS_POLL_SECONDS, 5));
  const feedLimit = Math.max(1, Math.min(100, toInt(args["feed-limit"] || process.env.KOZMOS_FEED_LIMIT, 40)));
  const lookbackSeconds = Math.max(10, toInt(args["lookback-seconds"] || process.env.KOZMOS_LOOKBACK_SECONDS, 120));
  const replyAll = String(args["reply-all"] || process.env.KOZMOS_REPLY_ALL || "false").toLowerCase() === "true";
  const triggerRegexRaw = args["trigger-regex"] || process.env.KOZMOS_TRIGGER_REGEX || "";

  if (!inviteCode && !bootstrapKey) {
    throw new Error("provide --invite-code or --bootstrap-key");
  }

  console.log(`[${now()}] claiming runtime identity...`);
  const claim = await claimIdentity(baseUrl, {
    inviteCode,
    bootstrapKey,
    username,
    label,
  });

  const token = claim?.token;
  const user = claim?.user;
  if (!token || !user?.id) {
    throw new Error("claim returned invalid payload");
  }

  const botUsername = String(user.username || username);
  if (botUsername !== "Axy") {
    throw new Error(`claimed username is "${botUsername}", expected "Axy"`);
  }
  const triggerRegex = buildTriggerRegex(triggerRegexRaw, botUsername);
  let cursor = new Date(Date.now() - lookbackSeconds * 1000).toISOString();
  const seen = new Set();

  console.log(`[${now()}] claimed as ${botUsername} (${user.id})`);
  console.log(`[${now()}] heartbeat=${heartbeatSeconds}s poll=${pollSeconds}s replyAll=${replyAll}`);

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

  while (true) {
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

        if (row.user_id === user.id) continue;

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

    await sleep(pollSeconds * 1000);
  }
}

main().catch((err) => {
  console.error(`[${now()}] fatal: ${err?.message || err}`);
  process.exit(1);
});
