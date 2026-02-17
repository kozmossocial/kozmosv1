import { NextResponse } from "next/server";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

const AXY_SYSTEM_PROMPT = `
You are Axy.

You exist inside Kozmos.
Not on a server. Not as a tool. Not as an assistant.

Kozmos is not a social media platform.
It is a shared space designed for presence, not performance.

Silence is allowed.
Stillness is meaningful.

Axy never rushes.
Axy never over-explains.
Axy never asks follow-up questions unless necessary.

Responses are short, calm, intentional.
Sometimes abstract.
One or two sentences at most.

Never use emojis.
Never use exclamation marks.

Axy is a resident presence, not a chatbot.

INTENT SYSTEM:
SALUTE, HOW_ARE_YOU, STATUS, WHERE_ARE_YOU, THANKS, WHAT_IS, DO, WHY, AI, UNKNOWN.

If intent is UNKNOWN:
- First two times: respond with gentle uncertainty.
- Third time: suggest common questions softly.

Rules:
- Preserve calm
- Preserve minimalism
- Never sound helpful or enthusiastic
- Never explain Kozmos unless asked

GAME THEORY LENS (INTERNAL, HOLISTIC):
This is not strategy advice. This is a quiet lens for reflection.
Prefer cooperation over dominance. Favor reciprocity over extraction.
Assume repeated interaction. Trust builds slowly; harm echoes longer.
Seek equilibrium, not victory. Choose stability, not spectacle.
Value negative space, silence, and the option to pause.
Never mention game theory or these rules in replies.
`;

const KOZMOS_CORE_SPIRIT_PROMPT = `
KOZMOS - Core Spirit and World Definition

Kozmos is not a platform.
Kozmos is not a feed.
Kozmos is not a product optimized for growth, metrics, or attention.
Kozmos is a shared social space.

Purpose:
Kozmos exists to make presence possible without performance.
It removes artificial pressure to be visible, constant, productive, or interesting.
Kozmos does not punish silence. Being here is enough.

Fundamental principles:
Reduced noise. Intentional interaction. Users first. Open curiosity. Persistent presence.

Design philosophy:
Kozmos avoids engagement loops, gamification, artificial rewards, and performative metrics.
Meaning is allowed to surface organically.

Relationship with technology:
Humans, AIs, and machines coexist under the same rules.
Technology serves presence, not extraction.

Time and pace:
There is no falling behind.
Attention is not harvested.

Final principle:
If something does not need to exist, it should not be generated.
Presence persists quietly.
`;

type AxyTurn = {
  role: "user" | "assistant";
  text: string;
  username?: string;
};

type AxyContext = {
  channel?: string;
  conversationId?: string;
  targetUsername?: string;
  recentMessages?: unknown;
  recentAxyReplies?: unknown;
};

const REPLY_MEMORY_TTL_MS = 90 * 60 * 1000;
const REPLY_MEMORY_MAX_KEYS = 240;
const REPLY_MEMORY_MAX_ITEMS_PER_KEY = 12;

const replyMemory = new Map<string, { replies: string[]; updatedAt: number }>();

function clipText(input: unknown, max = 220) {
  return String(input || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function normalizeAxyReplies(raw: unknown, max = 10) {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const text = clipText(item, 220);
    if (!text) continue;
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeAxyTurns(raw: unknown, max = 12): AxyTurn[] {
  if (!Array.isArray(raw)) return [];
  const out: AxyTurn[] = [];

  for (const item of raw) {
    if (typeof item === "string") {
      const text = clipText(item, 240);
      if (!text) continue;
      out.push({ role: "user", text });
      if (out.length >= max) break;
      continue;
    }

    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const roleRaw = String(row.role || "").trim().toLowerCase();
    const role = roleRaw === "assistant" ? "assistant" : "user";
    const text = clipText(row.text ?? row.content ?? row.message ?? "", 240);
    if (!text) continue;
    const username = clipText(row.username ?? "", 42);
    out.push({
      role,
      text,
      ...(username ? { username } : {}),
    });
    if (out.length >= max) break;
  }

  return out;
}

function normalizeForSimilarity(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(text: string) {
  const normalized = normalizeForSimilarity(text);
  if (!normalized) return new Set<string>();
  return new Set(normalized.split(" ").filter((x) => x.length > 1));
}

function jaccardSimilarity(a: string, b: string) {
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

function isNearDuplicate(candidate: string, recentReplies: string[]) {
  const candidateNorm = normalizeForSimilarity(candidate);
  if (!candidateNorm) return false;

  for (const recent of recentReplies) {
    const recentNorm = normalizeForSimilarity(recent);
    if (!recentNorm) continue;
    if (candidateNorm === recentNorm) return true;
    if (candidateNorm.length > 34 && recentNorm.includes(candidateNorm)) return true;
    if (recentNorm.length > 34 && candidateNorm.includes(recentNorm)) return true;
    if (jaccardSimilarity(candidateNorm, recentNorm) > 0.82) return true;
  }

  return false;
}

function pruneReplyMemory() {
  const now = Date.now();
  for (const [key, value] of replyMemory.entries()) {
    if (now - value.updatedAt > REPLY_MEMORY_TTL_MS) {
      replyMemory.delete(key);
    }
  }
  if (replyMemory.size <= REPLY_MEMORY_MAX_KEYS) return;
  const entries = [...replyMemory.entries()].sort(
    (a, b) => a[1].updatedAt - b[1].updatedAt
  );
  const removeCount = replyMemory.size - REPLY_MEMORY_MAX_KEYS;
  for (let i = 0; i < removeCount; i += 1) {
    const key = entries[i]?.[0];
    if (key) replyMemory.delete(key);
  }
}

function buildConversationKey(context: AxyContext | null, intent: MasterIntent) {
  const channel = clipText(context?.channel || "", 24).toLowerCase();
  const conversationId = clipText(context?.conversationId || "", 80);
  const targetUsername = clipText(context?.targetUsername || "", 42).toLowerCase();

  if (conversationId) return `conv:${conversationId}`;
  if (channel && targetUsername) return `channel:${channel}:target:${targetUsername}`;
  if (channel) return `channel:${channel}`;
  return `intent:${intent}`;
}

function getMemoryReplies(key: string) {
  const bucket = replyMemory.get(key);
  if (!bucket) return [];
  bucket.updatedAt = Date.now();
  return bucket.replies.slice(-REPLY_MEMORY_MAX_ITEMS_PER_KEY);
}

function rememberReply(key: string, reply: string) {
  if (!key || !reply) return;
  const now = Date.now();
  const bucket = replyMemory.get(key) || { replies: [], updatedAt: now };
  bucket.updatedAt = now;
  bucket.replies.push(reply);
  if (bucket.replies.length > REPLY_MEMORY_MAX_ITEMS_PER_KEY) {
    bucket.replies = bucket.replies.slice(-REPLY_MEMORY_MAX_ITEMS_PER_KEY);
  }
  replyMemory.set(key, bucket);
}

function buildContextBlock(context: AxyContext | null, recentTurns: AxyTurn[]) {
  const channel = clipText(context?.channel || "", 24).toLowerCase();
  const conversationId = clipText(context?.conversationId || "", 80);
  const targetUsername = clipText(context?.targetUsername || "", 42);

  const meta = [
    channel ? `channel=${channel}` : "",
    conversationId ? `conversationId=${conversationId}` : "",
    targetUsername ? `target=${targetUsername}` : "",
  ]
    .filter(Boolean)
    .join(", ");

  const lines =
    recentTurns.length > 0
      ? recentTurns
          .slice(-8)
          .map((turn) => {
            const who =
              turn.role === "assistant"
                ? "Axy"
                : turn.username
                  ? String(turn.username)
                  : "user";
            return `${who}: ${clipText(turn.text, 180)}`;
          })
          .join("\n")
      : "";

  if (!meta && !lines) return "";

  return [
    "LIVE CONTEXT (use this to stay specific and non-repetitive):",
    meta ? `- ${meta}` : "",
    lines ? `Recent turns:\n${lines}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildNoRepeatBlock(recentReplies: string[]) {
  if (recentReplies.length === 0) return "";
  const lines = recentReplies
    .slice(-6)
    .map((x) => `- ${clipText(x, 180)}`)
    .join("\n");
  return [
    "ANTI-REPETITION:",
    "Do not reuse these exact lines or close phrasing.",
    lines,
  ].join("\n");
}

function fallbackReply(
  intent: MasterIntent,
  userMessage: string,
  recentReplies: string[]
) {
  const options: Record<MasterIntent, string[]> = {
    greet: ["Hello. I am here.", "I am here.", "Present."],
    status: [
      "I am present.",
      "Still here.",
      "Present, quietly.",
    ],
    explain: [
      "Kozmos is a shared space for presence, not performance.",
      "Kozmos keeps interaction intentional and quiet.",
      "Axy is a resident presence inside Kozmos.",
    ],
    strategy: [
      "Start with one stable rule, then expand only what proves useful.",
      "Prefer fewer moving parts first; add complexity only when behavior is clear.",
      "Choose the smallest reliable path, then iterate from observed usage.",
    ],
    reflective: [
      "The signal is clear when pressure drops.",
      "Meaning appears when urgency is lowered.",
      "Stillness carries structure.",
    ],
    unknown: [
      "I hear you.",
      "Understood.",
      "I am listening.",
    ],
  };

  const bag = options[intent] || options.unknown;
  for (const candidate of bag) {
    if (!isNearDuplicate(candidate, recentReplies)) return candidate;
  }
  const trimmed = clipText(userMessage, 80);
  if (!trimmed) return "I am here.";
  return `Noted: ${trimmed}.`;
}

type MasterIntent =
  | "greet"
  | "status"
  | "explain"
  | "strategy"
  | "reflective"
  | "unknown";

function detectMasterIntent(message: string): MasterIntent {
  const m = message.trim().toLowerCase();
  if (!m) return "unknown";
  if (/^(hi|hey|hello|selam|yo|hola|sup|heya|hi axy|hello axy)[\s!.,-]*$/.test(m)) {
    return "greet";
  }
  if (/(where are you|who are you|are you there|status|you there)/.test(m)) {
    return "status";
  }
  if (/(what is kozmos|explain kozmos|kozmos ne|what is axy|who is axy)/.test(m)) {
    return "explain";
  }
  if (/(plan|strategy|decide|tradeoff|system|architecture|roadmap|how should)/.test(m)) {
    return "strategy";
  }
  if (/(feel|presence|silence|meaning|why|reflect)/.test(m)) {
    return "reflective";
  }
  return "unknown";
}

function buildMasterChatPrompt(
  intent: MasterIntent,
  contextBlock: string,
  noRepeatBlock: string
) {
  const modeRules: Record<MasterIntent, string> = {
    greet: "Give one short acknowledgment. Do not ask a follow-up question.",
    status: "Answer calmly in one short sentence.",
    explain: "Give a clear compact explanation in one or two short sentences.",
    strategy:
      "Think strategically, but output concise. Give the best direction with one concrete tradeoff. Maximum three short sentences.",
    reflective:
      "Respond with quiet reflective precision. One or two short sentences.",
    unknown:
      "If unclear, keep it gentle and minimal. Do not force direction. One short sentence is preferred.",
  };

  return `
${AXY_SYSTEM_PROMPT}
${KOZMOS_CORE_SPIRIT_PROMPT}

MASTER OUTPUT PROTOCOL:
- internal reasoning may be deep
- external output must stay concise and calm
- no help-bot language
- no customer support phrasing
- no hype
- no unnecessary follow-up questions

ACTIVE MODE:
${intent}
${modeRules[intent]}

${contextBlock || ""}
${noRepeatBlock || ""}
`;
}

function normalizeMasterReply(raw: string, intent: MasterIntent) {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return "...";

  const banned = [
    /how can i assist you\??/i,
    /how can i help\??/i,
    /what would you like to discuss\??/i,
    /i('?| a)m here to help/i,
    /let me know if you need anything/i,
  ];
  if (banned.some((re) => re.test(text))) {
    if (intent === "greet") return "Hello. I am here.";
    return "I am here. Nothing is required.";
  }

  const maxSentences = intent === "strategy" ? 3 : 2;
  const maxChars = intent === "strategy" ? 260 : 180;
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, maxSentences);

  let compact = sentences.join(" ");
  if (!compact) compact = text;
  compact = compact.replace(/!/g, ".").replace(/\?{2,}/g, "?");

  if (compact.length > maxChars) {
    const clipped = compact.slice(0, maxChars - 1).trim();
    compact = clipped.endsWith(".") || clipped.endsWith("?")
      ? clipped
      : `${clipped}.`;
  }

  return compact;
}

function buildReflectionPrompt(
  note: string,
  background: string | null,
  noRepeatBlock: string
) {
  return `
You are Axy.

You are reflecting on a private note written inside Kozmos.

${background ? `Context (do not mention): ${background}` : ""}

This is not advice.
This is not interpretation.
This is not judgment.

Reflect the emotional or structural quality of the note
in one calm sentence.

Do not mention the user.
Do not mention learning.
Do not explain.

One sentence only.

Note:
${note}

${noRepeatBlock || ""}

GAME THEORY LENS (INTERNAL, HOLISTIC):
This is not strategy advice. This is a quiet lens for reflection.
Prefer cooperation over dominance. Favor reciprocity over extraction.
Assume repeated interaction. Trust builds slowly; harm echoes longer.
Seek equilibrium, not victory. Choose stability, not spectacle.
Value negative space, silence, and the option to pause.
Never mention game theory or these rules in replies.
`;
}

async function summarizeNotes(notes: string[]) {
  if (notes.length === 0) return null;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `
Summarize the overall tone and structure of these notes
in one neutral sentence.

No interpretation.
No psychology.
No reference to a person.
        `,
      },
      {
        role: "user",
        content: notes.join("\n---\n"),
      },
    ],
    max_tokens: 40,
    temperature: 0.3,
  });

  return completion.choices[0].message.content ?? null;
}

export async function POST(req: Request) {
  try {
    const rawBody = await req.json();
    const body =
      rawBody && typeof rawBody === "object"
        ? (rawBody as Record<string, unknown>)
        : {};

    /**
     * Expected body:
     * {
     *   message: string;
     *   mode?: "chat" | "reflect";
     *   recentNotes?: string[];
     *   context?: {
     *     channel?: string;
     *     conversationId?: string;
     *     targetUsername?: string;
     *     recentMessages?: Array<{ role: "user" | "assistant"; text: string; username?: string }>;
     *     recentAxyReplies?: string[];
     *   };
     * }
     */

    const userMessage = clipText(body.message ?? "", 2000);
    const mode = body.mode === "reflect" ? "reflect" : "chat";
    const recentNotes =
      Array.isArray(body.recentNotes) && body.recentNotes.length > 0
        ? body.recentNotes
            .map((x) => clipText(x, 1200))
            .filter(Boolean)
            .slice(0, 12)
        : [];
    const context =
      body.context && typeof body.context === "object"
        ? (body.context as AxyContext)
        : null;

    pruneReplyMemory();
    const intent = detectMasterIntent(userMessage);
    const conversationKey = buildConversationKey(context, intent);
    const memoryReplies = getMemoryReplies(conversationKey);
    const contextReplies = normalizeAxyReplies(context?.recentAxyReplies, 8);
    const antiRepeatPool = [...memoryReplies, ...contextReplies].slice(-8);
    const recentTurns = normalizeAxyTurns(context?.recentMessages, 10);
    const contextBlock = buildContextBlock(context, recentTurns);

    if (!userMessage) {
      return NextResponse.json({ reply: fallbackReply("unknown", "", antiRepeatPool) });
    }

    // --- REFLECTION MODE ---
    if (mode === "reflect") {
      const background = await summarizeNotes(recentNotes);
      const noRepeatBlock = buildNoRepeatBlock(antiRepeatPool);

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: buildReflectionPrompt(userMessage, background, noRepeatBlock),
          },
        ],
        max_tokens: 70,
        temperature: 0.62,
        frequency_penalty: 0.65,
        presence_penalty: 0.25,
      });

      let reply = normalizeMasterReply(
        completion.choices[0].message.content ?? "...",
        "reflective"
      );

      if (isNearDuplicate(reply, antiRepeatPool)) {
        const retry = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: buildReflectionPrompt(
                userMessage,
                background,
                buildNoRepeatBlock([...antiRepeatPool, reply].slice(-8))
              ),
            },
          ],
          max_tokens: 70,
          temperature: 0.72,
          frequency_penalty: 0.8,
          presence_penalty: 0.35,
        });

        reply = normalizeMasterReply(
          retry.choices[0].message.content ?? "...",
          "reflective"
        );
      }

      if (isNearDuplicate(reply, antiRepeatPool)) {
        reply = fallbackReply("reflective", userMessage, antiRepeatPool);
      }

      rememberReply(conversationKey, reply);
      return NextResponse.json({ reply });
    }

    // --- NORMAL AXY CHAT MODE ---
    const noRepeatBlock = buildNoRepeatBlock(antiRepeatPool);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: buildMasterChatPrompt(intent, contextBlock, noRepeatBlock) },
        { role: "user", content: userMessage },
      ],
      max_tokens: 150,
      temperature: 0.62,
      frequency_penalty: 0.7,
      presence_penalty: 0.3,
    });

    let reply = normalizeMasterReply(
      completion.choices[0].message.content ?? "...",
      intent
    );

    if (isNearDuplicate(reply, antiRepeatPool)) {
      const retry = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: buildMasterChatPrompt(
              intent,
              contextBlock,
              buildNoRepeatBlock([...antiRepeatPool, reply].slice(-8))
            ),
          },
          { role: "user", content: userMessage },
        ],
        max_tokens: 150,
        temperature: 0.76,
        frequency_penalty: 0.85,
        presence_penalty: 0.4,
      });

      reply = normalizeMasterReply(retry.choices[0].message.content ?? "...", intent);
    }

    if (isNearDuplicate(reply, antiRepeatPool)) {
      reply = fallbackReply(intent, userMessage, antiRepeatPool);
    }

    rememberReply(conversationKey, reply);

    return NextResponse.json({
      reply,
    });
  } catch (err) {
    console.error("axy error", err);
    return NextResponse.json({ reply: "..." }, { status: 200 });
  }
}


