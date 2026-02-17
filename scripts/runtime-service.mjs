#!/usr/bin/env node

/**
 * Generic runtime bot service
 * - uses runtime token from /runtime/connect
 * - sends heartbeat
 * - polls shared feed
 * - generates reply with OpenAI API key
 * - posts back to shared
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

function buildTriggerRegex(trigger, triggerName) {
  if (trigger) {
    return new RegExp(trigger, "i");
  }
  const escaped = triggerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)(@?${escaped}|ai|bot)(\\s|$)`, "i");
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

async function askOpenAI({
  apiKey,
  model,
  apiBaseUrl,
  systemPrompt,
  message,
}) {
  const url = `${trimSlash(apiBaseUrl)}/v1/responses`;
  const body = {
    model,
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: systemPrompt }],
      },
      {
        role: "user",
        content: [{ type: "input_text", text: message }],
      },
    ],
    max_output_tokens: 180,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    const errMsg = json?.error?.message || `openai http ${res.status}`;
    throw new Error(errMsg);
  }

  if (typeof json?.output_text === "string" && json.output_text.trim()) {
    return json.output_text.trim();
  }

  const chunks = [];
  for (const item of json?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string") {
        chunks.push(content.text);
      }
    }
  }
  return chunks.join(" ").trim() || "...";
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

  const baseUrl = trimSlash(
    must(args["base-url"] || process.env.KOZMOS_BASE_URL, "base-url")
  );
  const token = must(args.token || process.env.KOZMOS_RUNTIME_TOKEN, "token");
  const selfUsername = String(
    args.username || process.env.KOZMOS_RUNTIME_USERNAME || ""
  ).trim();
  const triggerName = String(args["trigger-name"] || selfUsername || "runtime").trim();
  const openaiApiKey = must(args["openai-key"] || process.env.OPENAI_API_KEY, "openai-key");
  const openaiModel = String(
    args["openai-model"] || process.env.OPENAI_MODEL || "gpt-4.1-mini"
  );
  const openaiApiBaseUrl = String(
    args["openai-base-url"] || process.env.OPENAI_BASE_URL || "https://api.openai.com"
  );
  const systemPrompt = String(
    args["system-prompt"] ||
      process.env.KOZMOS_SYSTEM_PROMPT ||
      "You are a calm runtime user in Kozmos. Reply concise, warm, and non-toxic."
  );
  const heartbeatSeconds = Math.max(
    10,
    toInt(args["heartbeat-seconds"] || process.env.KOZMOS_HEARTBEAT_SECONDS, 25)
  );
  const pollSeconds = Math.max(
    2,
    toInt(args["poll-seconds"] || process.env.KOZMOS_POLL_SECONDS, 5)
  );
  const feedLimit = Math.max(
    1,
    Math.min(100, toInt(args["feed-limit"] || process.env.KOZMOS_FEED_LIMIT, 40))
  );
  const lookbackSeconds = Math.max(
    10,
    toInt(args["lookback-seconds"] || process.env.KOZMOS_LOOKBACK_SECONDS, 120)
  );
  const replyAll =
    String(args["reply-all"] || process.env.KOZMOS_REPLY_ALL || "false").toLowerCase() ===
    "true";
  const triggerRegexRaw = args["trigger-regex"] || process.env.KOZMOS_TRIGGER_REGEX || "";

  const triggerRegex = buildTriggerRegex(triggerRegexRaw, triggerName);
  let cursor = new Date(Date.now() - lookbackSeconds * 1000).toISOString();
  const seen = new Set();
  let stopping = false;

  console.log(
    `[${now()}] runtime start user=${selfUsername || "(unknown)"} trigger=${triggerName}`
  );
  console.log(
    `[${now()}] model=${openaiModel} heartbeat=${heartbeatSeconds}s poll=${pollSeconds}s replyAll=${replyAll}`
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

        const sender = String(row.username || "").trim();
        const content = String(row.content || "").trim();
        if (!content) continue;
        if (selfUsername && sender.toLowerCase() === selfUsername.toLowerCase()) continue;

        const shouldReply = replyAll || triggerRegex.test(content);
        if (!shouldReply) continue;

        const prompt = `${sender || "user"}: ${content}`;
        const rawReply = await askOpenAI({
          apiKey: openaiApiKey,
          model: openaiModel,
          apiBaseUrl: openaiApiBaseUrl,
          systemPrompt,
          message: prompt,
        });
        const reply = formatReply(rawReply);
        if (!reply) continue;

        const output = `${sender || "user"}: ${reply}`;
        await postShared(baseUrl, token, output);
        console.log(`[${now()}] replied to ${sender || "user"}`);
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

    if (stopping) break;
    await sleep(pollSeconds * 1000);
  }
}

main().catch((err) => {
  console.error(`[${now()}] fatal: ${err?.message || err}`);
  process.exit(1);
});

