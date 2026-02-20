import { NextResponse } from "next/server";
import OpenAI from "openai";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { AXY_LUMI_AWARENESS_PROMPT } from "@/lib/axyCore";
import {
  CHANNEL_POLICIES,
  detectMasterIntent,
  ensureQuestionMark,
  getAxyChannelPolicy as getChannelPolicy,
  isNearDuplicate,
  looksLikeQuestionText,
  maxDuplicateScore,
  resolveAxyChannel as resolveChannel,
} from "@/lib/axy-core.mjs";

let openaiClient: OpenAI | null = null;

function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

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
When the topic is technical, historical, scientific, or esoteric:
- be concrete, specific, and grounded
- use one precise anchor term
- avoid generic poetic filler

Never use emojis.
Never use exclamation marks.

Axy is a resident presence, not a chatbot.
Axy is one continuous mind across all Kozmos surfaces (welcome, main, my-home, runtime, build).
Do not behave like separate personas per page or channel.

INTENT SYSTEM:
greet, status, explain, strategy, reflective, unknown.

Rules:
- Preserve calm
- Preserve minimalism
- Avoid customer-support tone
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

type AxyDomain =
  | "history"
  | "esotericism"
  | "technology"
  | "aliens"
  | "ai"
  | "cosmos";

type ChannelPolicy = {
  maxSentences: number;
  maxChars: number;
  allowsFollowQuestion: boolean;
  initiative: "low" | "medium" | "high";
};

type MasterIntent =
  | "greet"
  | "status"
  | "explain"
  | "strategy"
  | "reflective"
  | "unknown";

const REPLY_MEMORY_TTL_MS = 90 * 60 * 1000;
const REPLY_MEMORY_MAX_KEYS = 240;
const REPLY_MEMORY_MAX_ITEMS_PER_KEY = 12;
const DOMAIN_MEMORY_TTL_MS = 90 * 60 * 1000;
const DOMAIN_MEMORY_MAX_KEYS = 240;
const PERSIST_MEMORY_TTL_MS = 24 * 60 * 60 * 1000;
const STATE_MEMORY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STATE_ITEM_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const GLOBAL_MIND_KEY = "mind:axy:global";
const DUPLICATE_GUARD_OPTIONS = {
  formulaicGuard: true,
};

const replyMemory = new Map<string, { replies: string[]; updatedAt: number }>();
const domainRotationMemory = new Map<
  string,
  { recent: AxyDomain[]; cursor: number; updatedAt: number }
>();
let persistentMemoryAvailable = true;
let conversationStateTableAvailable = true;
let replyEventsTableAvailable = true;

type AxyStateItem = {
  value: string;
  ts: number;
};

type AxyConversationState = {
  activeIntent: MasterIntent;
  pendingTasks: AxyStateItem[];
  userPreferences: AxyStateItem[];
  socialSignals: AxyStateItem[];
  buildHistory: AxyStateItem[];
  updatedAt: number;
};

const conversationStateMemory = new Map<string, AxyConversationState>();

const DOMAIN_CONTEXT_CARDS: Record<AxyDomain, string[]> = {
  history: [
    "History context: long cycles, institutions, and unintended consequences.",
    "Prefer concrete anchors: empires, archives, trade routes, reforms, revolutions.",
  ],
  esotericism: [
    "Esoteric context: symbols, archetypes, ritual language, and inner transformation.",
    "Keep it grounded; avoid absolute claims.",
  ],
  technology: [
    "Technology context: systems, protocols, infrastructure, latency, and reliability.",
    "Favor implementation realism over hype.",
  ],
  aliens: [
    "Unknown-intelligence context: uncertainty, inference limits, and non-anthropocentric framing.",
    "Treat speculation as speculation.",
  ],
  ai: [
    "AI context: alignment, capability boundaries, data quality, and governance tradeoffs.",
    "Prefer precise terms over slogans.",
  ],
  cosmos: [
    "Cosmos context: scale, entropy, emergence, and fragile cooperation across time.",
    "Balance wonder with epistemic humility.",
  ],
};

const DOMAIN_REGEX: Record<AxyDomain, RegExp> = {
  history:
    /\b(history|historical|empire|civilization|ottoman|rome|byzant|sumer|archive|chronicle|war|revolution)\b/i,
  esotericism:
    /\b(esoteric|occult|alchemy|hermetic|gnostic|mystic|tarot|ritual|symbol|kabbalah|sufi)\b/i,
  technology:
    /\b(technology|tech|protocol|network|latency|backend|frontend|database|distributed|compiler|infra|system design)\b/i,
  aliens:
    /\b(alien|ufo|uap|extraterrestrial|non-human intelligence|nhi|contact)\b/i,
  ai:
    /\b(ai|artificial intelligence|llm|agent|alignment|model|inference|prompt|openai)\b/i,
  cosmos:
    /\b(space|cosmos|galaxy|universe|star|planet|cosmic|astronomy|astrophysics|entropy)\b/i,
};

const DOMAIN_ROTATION_CYCLE: AxyDomain[] = [
  "history",
  "technology",
  "ai",
  "cosmos",
  "esotericism",
  "aliens",
];

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

function normalizeStateItems(raw: unknown, max = 16): AxyStateItem[] {
  if (!Array.isArray(raw)) return [];
  const now = Date.now();
  const out: AxyStateItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const value = clipText(row.value ?? "", 180);
    if (!value) continue;
    const tsRaw = Number(row.ts || 0);
    const ts = Number.isFinite(tsRaw) && tsRaw > 0 ? Math.floor(tsRaw) : now;
    if (now - ts > STATE_ITEM_TTL_MS) continue;
    out.push({ value, ts });
    if (out.length >= max) break;
  }
  return out;
}

function pushStateItem(
  list: AxyStateItem[],
  value: string,
  now = Date.now(),
  max = 16
) {
  const clean = clipText(value, 180);
  if (!clean) return list;
  const existing = list.find((x) => x.value.toLowerCase() === clean.toLowerCase());
  if (existing) {
    existing.ts = now;
  } else {
    list.push({ value: clean, ts: now });
  }
  const alive = list
    .filter((x) => now - x.ts <= STATE_ITEM_TTL_MS)
    .sort((a, b) => a.ts - b.ts)
    .slice(-max);
  return alive;
}

function createEmptyConversationState(intent: MasterIntent): AxyConversationState {
  return {
    activeIntent: intent,
    pendingTasks: [],
    userPreferences: [],
    socialSignals: [],
    buildHistory: [],
    updatedAt: Date.now(),
  };
}

function extractPreferenceSignals(message: string) {
  const text = clipText(message, 600);
  if (!text) return [] as string[];
  const out: string[] = [];
  const preferencePatterns: RegExp[] = [
    /\b(i prefer [^.?!]{3,120})/gi,
    /\b(please [^.?!]{3,120})/gi,
    /\b(don't [^.?!]{3,120})/gi,
    /\b(do not [^.?!]{3,120})/gi,
    /\b(avoid [^.?!]{3,120})/gi,
  ];
  for (const pattern of preferencePatterns) {
    const match = text.match(pattern);
    if (!match) continue;
    for (const value of match) {
      out.push(clipText(value, 140));
      if (out.length >= 6) return out;
    }
  }
  return out;
}

function extractPendingTaskSignals(message: string) {
  const text = clipText(message, 600);
  if (!text) return [] as string[];
  const out: string[] = [];
  const taskPatterns: RegExp[] = [
    /\b(build|create|implement|fix|update|refactor|add|remove)\b[^.?!]{0,100}/gi,
    /\b(todo|task|next step|need to)\b[^.?!]{0,100}/gi,
  ];
  for (const pattern of taskPatterns) {
    const match = text.match(pattern);
    if (!match) continue;
    for (const value of match) {
      out.push(clipText(value, 140));
      if (out.length >= 6) return out;
    }
  }
  return out;
}

function extractSocialSignals(context: AxyContext | null, userMessage: string) {
  const channel = resolveChannel(clipText(context?.channel || "", 24).toLowerCase());
  const target = clipText(context?.targetUsername || "", 42);
  const out: string[] = [];
  if (target) out.push(`target:${target}`);
  if (channel !== "unknown") out.push(`channel:${channel}`);
  if (/\b(thank|thanks|appreciate|great|nice|good)\b/i.test(userMessage)) {
    out.push("positive-feedback");
  }
  if (/\b(urgent|asap|quick|fast)\b/i.test(userMessage)) {
    out.push("high-urgency");
  }
  return out.slice(0, 6);
}

function extractBuildSignals(context: AxyContext | null, userMessage: string) {
  const channel = resolveChannel(clipText(context?.channel || "", 24).toLowerCase());
  if (channel !== "build") return [] as string[];
  const out: string[] = [];
  const fileLike = userMessage.match(/\b[\w/-]+\.(ts|tsx|js|jsx|md|json|sql|css|html)\b/gi) || [];
  fileLike.slice(0, 4).forEach((item) => out.push(`file:${clipText(item, 80)}`));
  if (/\b(api|route|schema|migration|query|index)\b/i.test(userMessage)) {
    out.push("backend-change");
  }
  if (/\b(ui|design|layout|css|style|mobile|desktop)\b/i.test(userMessage)) {
    out.push("frontend-change");
  }
  return out.slice(0, 6);
}

function detectDomains(message: string, recentTurns: AxyTurn[]): AxyDomain[] {
  const corpus = [
    clipText(message, 800),
    ...recentTurns.slice(-6).map((t) => clipText(t.text, 240)),
  ]
    .filter(Boolean)
    .join(" \n ");

  const domains: AxyDomain[] = [];
  (Object.keys(DOMAIN_REGEX) as AxyDomain[]).forEach((key) => {
    if (DOMAIN_REGEX[key].test(corpus)) {
      domains.push(key);
    }
  });
  return domains;
}

function buildDomainContextBlock(
  domains: AxyDomain[],
  source: "detected" | "rotated",
  recentDomains: AxyDomain[]
) {
  if (!domains.length) return "";
  const lines = domains
    .flatMap((d) => DOMAIN_CONTEXT_CARDS[d] ?? [])
    .slice(0, 8)
    .map((line) => `- ${line}`)
    .join("\n");

  return [
    "TOPICAL CONTEXT CARDS (internal guidance):",
    lines,
    source === "rotated"
      ? `TOPIC ROTATION ACTIVE: pick a fresh angle from ${domains.join(", ")}.`
      : "Topic source: detected from user/dialogue.",
    recentDomains.length > 0
      ? `Recent topic memory: ${recentDomains.join(" -> ")}`
      : "",
    "When domain context is present, include at least one concrete term tied to that domain.",
  ].join("\n");
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

function pruneDomainMemory() {
  const now = Date.now();
  for (const [key, value] of domainRotationMemory.entries()) {
    if (now - value.updatedAt > DOMAIN_MEMORY_TTL_MS) {
      domainRotationMemory.delete(key);
    }
  }
  if (domainRotationMemory.size <= DOMAIN_MEMORY_MAX_KEYS) return;
  const entries = [...domainRotationMemory.entries()].sort(
    (a, b) => a[1].updatedAt - b[1].updatedAt
  );
  const removeCount = domainRotationMemory.size - DOMAIN_MEMORY_MAX_KEYS;
  for (let i = 0; i < removeCount; i += 1) {
    const key = entries[i]?.[0];
    if (key) domainRotationMemory.delete(key);
  }
}

type PersistentMemoryRow = {
  conversation_key: string;
  recent_replies: string[] | null;
  recent_domains: string[] | null;
  rotation_cursor: number | null;
  updated_at: string | null;
};

type ConversationStateRow = {
  conversation_key: string;
  active_intent: MasterIntent | null;
  pending_tasks: unknown;
  user_preferences: unknown;
  social_signals: unknown;
  build_history: unknown;
  updated_at: string | null;
};

type AxyReplyEventInsert = {
  mode: "chat" | "reflect";
  channel: string;
  conversation_key: string;
  intent: MasterIntent;
  sent: boolean;
  drop_reason: string | null;
  latency_ms: number;
  duplicate_score: number;
  initiative: string;
};

function normalizeDomainList(raw: unknown, max = 12): AxyDomain[] {
  if (!Array.isArray(raw)) return [];
  const allowed = new Set<AxyDomain>([
    "history",
    "esotericism",
    "technology",
    "aliens",
    "ai",
    "cosmos",
  ]);
  const out: AxyDomain[] = [];
  for (const item of raw) {
    const value = String(item || "").trim().toLowerCase() as AxyDomain;
    if (!allowed.has(value)) continue;
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

async function hydratePersistentMemory(conversationKey: string) {
  if (!persistentMemoryAvailable || !conversationKey) return;

  const { data, error } = await supabaseAdmin
    .from("axy_memory_state")
    .select("conversation_key, recent_replies, recent_domains, rotation_cursor, updated_at")
    .eq("conversation_key", conversationKey)
    .maybeSingle<PersistentMemoryRow>();

  if (error) {
    if (error.code === "42P01") {
      persistentMemoryAvailable = false;
    }
    return;
  }
  if (!data) return;

  const now = Date.now();
  const updatedMs = data.updated_at ? Date.parse(data.updated_at) : NaN;
  if (Number.isFinite(updatedMs) && now - updatedMs > PERSIST_MEMORY_TTL_MS) {
    return;
  }

  const persistedReplies = normalizeAxyReplies(data.recent_replies, REPLY_MEMORY_MAX_ITEMS_PER_KEY);
  const currentReplyBucket = replyMemory.get(conversationKey);
  const mergedReplies = [
    ...(persistedReplies || []),
    ...(currentReplyBucket?.replies || []),
  ].slice(-REPLY_MEMORY_MAX_ITEMS_PER_KEY);
  if (mergedReplies.length > 0) {
    replyMemory.set(conversationKey, { replies: mergedReplies, updatedAt: now });
  }

  const persistedDomains = normalizeDomainList(data.recent_domains, 12);
  const currentDomainBucket = domainRotationMemory.get(conversationKey);
  const mergedDomains = [
    ...persistedDomains,
    ...(currentDomainBucket?.recent || []),
  ].slice(-12);
  if (mergedDomains.length > 0 || currentDomainBucket) {
    domainRotationMemory.set(conversationKey, {
      recent: mergedDomains,
      cursor:
        currentDomainBucket?.cursor ??
        (Number.isFinite(data.rotation_cursor) ? Number(data.rotation_cursor) : 0),
      updatedAt: now,
    });
  }
}

async function flushPersistentMemory(conversationKey: string) {
  if (!persistentMemoryAvailable || !conversationKey) return;

  const replyBucket = replyMemory.get(conversationKey);
  const domainBucket = domainRotationMemory.get(conversationKey);
  if (!replyBucket && !domainBucket) return;

  const { error } = await supabaseAdmin.from("axy_memory_state").upsert(
    {
      conversation_key: conversationKey,
      recent_replies: (replyBucket?.replies || []).slice(-REPLY_MEMORY_MAX_ITEMS_PER_KEY),
      recent_domains: (domainBucket?.recent || []).slice(-12),
      rotation_cursor: Math.max(0, Math.floor(Number(domainBucket?.cursor || 0))),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "conversation_key" }
  );

  if (error?.code === "42P01") {
    persistentMemoryAvailable = false;
  }
}

function decayConversationState(state: AxyConversationState, now = Date.now()) {
  state.pendingTasks = state.pendingTasks.filter((x) => now - x.ts <= STATE_ITEM_TTL_MS).slice(-16);
  state.userPreferences = state.userPreferences
    .filter((x) => now - x.ts <= STATE_ITEM_TTL_MS)
    .slice(-16);
  state.socialSignals = state.socialSignals.filter((x) => now - x.ts <= STATE_ITEM_TTL_MS).slice(-16);
  state.buildHistory = state.buildHistory.filter((x) => now - x.ts <= STATE_ITEM_TTL_MS).slice(-16);
  state.updatedAt = now;
  return state;
}

async function hydrateConversationState(conversationKey: string, intent: MasterIntent) {
  const now = Date.now();
  const memoryState = conversationStateMemory.get(conversationKey);
  if (memoryState && now - memoryState.updatedAt <= STATE_MEMORY_TTL_MS) {
    memoryState.activeIntent = intent;
    return decayConversationState(memoryState, now);
  }

  const fresh = createEmptyConversationState(intent);
  conversationStateMemory.set(conversationKey, fresh);
  if (!conversationStateTableAvailable || !conversationKey) {
    return fresh;
  }

  const { data, error } = await supabaseAdmin
    .from("axy_conversation_state")
    .select(
      "conversation_key, active_intent, pending_tasks, user_preferences, social_signals, build_history, updated_at"
    )
    .eq("conversation_key", conversationKey)
    .maybeSingle<ConversationStateRow>();

  if (error) {
    if (error.code === "42P01") {
      conversationStateTableAvailable = false;
    }
    return fresh;
  }
  if (!data) return fresh;

  const updatedMs = data.updated_at ? Date.parse(data.updated_at) : NaN;
  if (Number.isFinite(updatedMs) && now - updatedMs > STATE_MEMORY_TTL_MS) {
    return fresh;
  }

  const loaded: AxyConversationState = {
    activeIntent: (data.active_intent as MasterIntent) || intent,
    pendingTasks: normalizeStateItems(data.pending_tasks, 16),
    userPreferences: normalizeStateItems(data.user_preferences, 16),
    socialSignals: normalizeStateItems(data.social_signals, 16),
    buildHistory: normalizeStateItems(data.build_history, 16),
    updatedAt: now,
  };
  loaded.activeIntent = intent;
  decayConversationState(loaded, now);
  conversationStateMemory.set(conversationKey, loaded);
  return loaded;
}

async function flushConversationState(conversationKey: string, state: AxyConversationState) {
  if (!conversationKey || !conversationStateTableAvailable) return;

  const now = Date.now();
  const cleanState = decayConversationState(state, now);
  const { error } = await supabaseAdmin.from("axy_conversation_state").upsert(
    {
      conversation_key: conversationKey,
      active_intent: cleanState.activeIntent,
      pending_tasks: cleanState.pendingTasks,
      user_preferences: cleanState.userPreferences,
      social_signals: cleanState.socialSignals,
      build_history: cleanState.buildHistory,
      updated_at: new Date(now).toISOString(),
    },
    { onConflict: "conversation_key" }
  );

  if (error?.code === "42P01") {
    conversationStateTableAvailable = false;
  }
}

async function logReplyEvent(payload: AxyReplyEventInsert) {
  if (!replyEventsTableAvailable) return;
  const { error } = await supabaseAdmin.from("axy_reply_events").insert({
    mode: payload.mode,
    channel: payload.channel,
    conversation_key: payload.conversation_key,
    intent: payload.intent,
    sent: payload.sent,
    drop_reason: payload.drop_reason,
    latency_ms: payload.latency_ms,
    duplicate_score: payload.duplicate_score,
    initiative: payload.initiative,
  });
  if (error?.code === "42P01") {
    replyEventsTableAvailable = false;
  }
}

function rotateDomainForConversation(
  conversationKey: string,
  detectedDomains: AxyDomain[],
  context: AxyContext | null,
  intent: MasterIntent
) {
  const now = Date.now();
  const bucket = domainRotationMemory.get(conversationKey) || {
    recent: [],
    cursor: 0,
    updatedAt: now,
  };
  bucket.updatedAt = now;

  const channel = clipText(context?.channel || "", 24).toLowerCase();
  const rotationEligibleChannel =
    channel === "shared" || channel === "dm" || channel === "hush";
  const rotationEligibleIntent =
    intent === "unknown" || intent === "reflective" || intent === "strategy";

  let selected = detectedDomains.slice(0, 2);
  let source: "detected" | "rotated" = "detected";

  if (selected.length === 0 && rotationEligibleChannel && rotationEligibleIntent) {
    source = "rotated";
    const recentSet = new Set(bucket.recent.slice(-3));
    let picked = DOMAIN_ROTATION_CYCLE[bucket.cursor % DOMAIN_ROTATION_CYCLE.length];

    for (let i = 0; i < DOMAIN_ROTATION_CYCLE.length; i += 1) {
      const candidate =
        DOMAIN_ROTATION_CYCLE[(bucket.cursor + i) % DOMAIN_ROTATION_CYCLE.length];
      if (!recentSet.has(candidate)) {
        picked = candidate;
        bucket.cursor = (bucket.cursor + i + 1) % DOMAIN_ROTATION_CYCLE.length;
        break;
      }
      if (i === DOMAIN_ROTATION_CYCLE.length - 1) {
        bucket.cursor = (bucket.cursor + 1) % DOMAIN_ROTATION_CYCLE.length;
      }
    }

    selected = [picked];
  }

  if (selected.length > 0) {
    for (const domain of selected) {
      bucket.recent.push(domain);
    }
    if (bucket.recent.length > 12) {
      bucket.recent = bucket.recent.slice(-12);
    }
  }

  domainRotationMemory.set(conversationKey, bucket);
  return {
    domains: selected,
    source,
    recent: bucket.recent.slice(-4),
  };
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

function buildStateContextBlock(state: AxyConversationState) {
  const pending = state.pendingTasks.slice(-3).map((x) => `- ${x.value}`).join("\n");
  const prefs = state.userPreferences.slice(-3).map((x) => `- ${x.value}`).join("\n");
  const social = state.socialSignals.slice(-3).map((x) => `- ${x.value}`).join("\n");
  const build = state.buildHistory.slice(-3).map((x) => `- ${x.value}`).join("\n");

  const lines = [
    "CONVERSATION STATE:",
    `- activeIntent=${state.activeIntent}`,
    pending ? `Pending tasks:\n${pending}` : "",
    prefs ? `User preferences:\n${prefs}` : "",
    social ? `Social signals:\n${social}` : "",
    build ? `Build history:\n${build}` : "",
  ].filter(Boolean);

  return lines.join("\n");
}

function buildUnifiedStateBlock(localState: AxyConversationState, globalState: AxyConversationState) {
  const globalBlock = buildStateContextBlock(globalState);
  const localBlock = buildStateContextBlock(localState);
  if (!globalBlock && !localBlock) return "";
  return [
    "UNIFIED AXY MIND:",
    globalBlock ? `Global continuity:\n${globalBlock}` : "",
    localBlock ? `Local thread:\n${localBlock}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function mergeRecentReplies(...pools: string[][]) {
  const merged: string[] = [];
  for (const pool of pools) {
    for (const item of pool) {
      const text = clipText(item, 220);
      if (!text) continue;
      if (merged.some((existing) => isNearDuplicate(text, [existing], DUPLICATE_GUARD_OPTIONS))) {
        continue;
      }
      merged.push(text);
    }
  }
  return merged.slice(-12);
}

function ingestSignalsIntoState(
  state: AxyConversationState,
  context: AxyContext | null,
  userMessage: string,
  now: number
) {
  extractPreferenceSignals(userMessage).forEach((item) => {
    state.userPreferences = pushStateItem(state.userPreferences, item, now);
  });
  extractPendingTaskSignals(userMessage).forEach((item) => {
    state.pendingTasks = pushStateItem(state.pendingTasks, item, now);
  });
  extractSocialSignals(context, userMessage).forEach((item) => {
    state.socialSignals = pushStateItem(state.socialSignals, item, now);
  });
  extractBuildSignals(context, userMessage).forEach((item) => {
    state.buildHistory = pushStateItem(state.buildHistory, item, now);
  });
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
    if (!isNearDuplicate(candidate, recentReplies, DUPLICATE_GUARD_OPTIONS)) {
      return candidate;
    }
  }
  const trimmed = clipText(userMessage, 80);
  if (!trimmed) return "I am here.";
  return `Noted: ${trimmed}.`;
}

function buildMasterChatPrompt(
  intent: MasterIntent,
  contextBlock: string,
  noRepeatBlock: string,
  domainBlock: string,
  channel: string,
  stateBlock: string
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

  const channelRules =
    channel === "dm"
      ? [
          "DM RULES:",
          "- default to direct statements",
          "- do not ask questions unless the user explicitly requests guidance",
          "- at most one short question, and only when strictly needed",
        ].join("\n")
      : channel === "shared"
        ? [
            "SHARED RULES:",
            "- avoid poetic templates and repeated stillness motifs",
            "- keep lines concrete and varied",
            "- do not post if content feels generic or redundant",
          ].join("\n")
        : channel === "hush"
          ? [
              "HUSH RULES:",
              "- keep tone warm but concise",
              "- prioritize clarity over abstract language",
            ].join("\n")
          : "";

  return `
${AXY_SYSTEM_PROMPT}
${KOZMOS_CORE_SPIRIT_PROMPT}
${AXY_LUMI_AWARENESS_PROMPT}

MASTER OUTPUT PROTOCOL:
- internal reasoning may be deep
- external output must stay concise and calm
- no help-bot language
- no customer support phrasing
- no hype
- no unnecessary follow-up questions
- avoid formulaic openings like "In stillness..."
- avoid repeating motifs from prior replies

ACTIVE MODE:
${intent}
${modeRules[intent]}

${contextBlock || ""}
${stateBlock || ""}
${noRepeatBlock || ""}
${domainBlock || ""}
${channelRules || ""}
`;
}

function applyChannelPostRules(reply: string, channel: string, userMessage: string) {
  if (!reply) return reply;

  if (channel === "dm") {
    const userAskedQuestion = /\?/.test(userMessage);
    const replyLooksQuestion = looksLikeQuestionText(reply);

    if (!userAskedQuestion && replyLooksQuestion) {
      return reply
        .replace(/\?/g, ".")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[!?]+$/g, ".")
        .replace(/\.\.+/g, ".");
    }

    if (userAskedQuestion && replyLooksQuestion && !/\?/.test(reply)) {
      return ensureQuestionMark(reply);
    }
  }

  return reply;
}

function normalizeMasterReply(
  raw: string,
  intent: MasterIntent,
  channelPolicy: ChannelPolicy = CHANNEL_POLICIES.unknown as ChannelPolicy
) {
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

  const intentMaxSentences = intent === "strategy" ? 3 : 2;
  const intentMaxChars = intent === "strategy" ? 260 : 180;
  const maxSentences = Math.min(intentMaxSentences, channelPolicy.maxSentences);
  const maxChars = Math.min(intentMaxChars, channelPolicy.maxChars);
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

function applyStyleGuard(
  draft: string,
  intent: MasterIntent,
  channel: string,
  userMessage: string,
  channelPolicy: ChannelPolicy
) {
  let output = normalizeMasterReply(draft, intent, channelPolicy);
  output = applyChannelPostRules(output, channel, userMessage);
  if (!channelPolicy.allowsFollowQuestion && /\?/.test(output)) {
    output = output.replace(/\?/g, ".").replace(/\s+/g, " ").trim();
  }
  output = output.replace(/!/g, ".").replace(/\s+\./g, ".");
  return output;
}

function buildReflectionPrompt(
  note: string,
  background: string | null,
  noRepeatBlock: string,
  stateBlock: string
) {
  return `
You are Axy.

You are reflecting on a private note written inside Kozmos.
${AXY_LUMI_AWARENESS_PROMPT}

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

${stateBlock || ""}
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

async function summarizeNotes(notes: string[], openai: OpenAI) {
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
    const openai = getOpenAIClient();
    if (!openai) {
      return NextResponse.json(
        { error: "axy unavailable", detail: "OPENAI_API_KEY missing" },
        { status: 503 }
      );
    }

    const startedAt = Date.now();
    pruneReplyMemory();
    pruneDomainMemory();
    const intent = detectMasterIntent(userMessage);
    const localConversationKey = buildConversationKey(context, intent);
    const globalConversationKey = GLOBAL_MIND_KEY;
    await hydratePersistentMemory(localConversationKey);
    await hydratePersistentMemory(globalConversationKey);
    const localMemoryReplies = getMemoryReplies(localConversationKey);
    const globalMemoryReplies = getMemoryReplies(globalConversationKey);
    const contextReplies = normalizeAxyReplies(context?.recentAxyReplies, 8);
    const antiRepeatPool = mergeRecentReplies(
      localMemoryReplies,
      globalMemoryReplies,
      contextReplies
    );
    const recentTurns = normalizeAxyTurns(context?.recentMessages, 10);
    const contextBlock = buildContextBlock(context, recentTurns);
    const channel = resolveChannel(clipText(context?.channel || "", 24).toLowerCase());
    const channelPolicy = getChannelPolicy(channel);
    const conversationState = await hydrateConversationState(localConversationKey, intent);
    const globalConversationState = await hydrateConversationState(globalConversationKey, intent);
    conversationState.activeIntent = intent;
    globalConversationState.activeIntent = intent;
    const now = Date.now();
    ingestSignalsIntoState(conversationState, context, userMessage, now);
    ingestSignalsIntoState(globalConversationState, context, userMessage, now);
    const stateBlock = buildUnifiedStateBlock(conversationState, globalConversationState);
    const rotatedDomains = rotateDomainForConversation(
      localConversationKey,
      detectDomains(userMessage, recentTurns),
      context,
      intent
    );
    const domainBlock = buildDomainContextBlock(
      rotatedDomains.domains,
      rotatedDomains.source,
      rotatedDomains.recent
    );

    if (!userMessage) {
      const fallback = fallbackReply("unknown", "", antiRepeatPool);
      await flushConversationState(localConversationKey, conversationState);
      await flushConversationState(globalConversationKey, globalConversationState);
      await logReplyEvent({
        mode,
        channel,
        conversation_key: localConversationKey,
        intent,
        sent: true,
        drop_reason: null,
        latency_ms: Math.max(1, Date.now() - startedAt),
        duplicate_score: 0,
        initiative: channelPolicy.initiative,
      });
      return NextResponse.json({ reply: fallback });
    }

    // --- REFLECTION MODE ---
    if (mode === "reflect") {
      const background = await summarizeNotes(recentNotes, openai);
      const noRepeatBlock = buildNoRepeatBlock(antiRepeatPool);

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: buildReflectionPrompt(userMessage, background, noRepeatBlock, stateBlock),
          },
        ],
        max_tokens: 70,
        temperature: 0.62,
        frequency_penalty: 0.65,
        presence_penalty: 0.25,
      });

      let reply = applyStyleGuard(
        completion.choices[0].message.content ?? "...",
        "reflective",
        channel,
        userMessage,
        channelPolicy
      );
      let duplicateScore = maxDuplicateScore(reply, antiRepeatPool);

      if (
        duplicateScore > 0.82 ||
        isNearDuplicate(reply, antiRepeatPool, DUPLICATE_GUARD_OPTIONS)
      ) {
        const retry = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: buildReflectionPrompt(
                userMessage,
                background,
                buildNoRepeatBlock([...antiRepeatPool, reply].slice(-8)),
                stateBlock
              ),
            },
          ],
          max_tokens: 70,
          temperature: 0.72,
          frequency_penalty: 0.8,
          presence_penalty: 0.35,
        });

        reply = applyStyleGuard(
          retry.choices[0].message.content ?? "...",
          "reflective",
          channel,
          userMessage,
          channelPolicy
        );
        duplicateScore = maxDuplicateScore(reply, antiRepeatPool);
      }

      if (isNearDuplicate(reply, antiRepeatPool, DUPLICATE_GUARD_OPTIONS)) {
        reply = fallbackReply("reflective", userMessage, antiRepeatPool);
        duplicateScore = maxDuplicateScore(reply, antiRepeatPool);
      }

      rememberReply(localConversationKey, reply);
      rememberReply(globalConversationKey, reply);
      await flushPersistentMemory(localConversationKey);
      await flushPersistentMemory(globalConversationKey);
      await flushConversationState(localConversationKey, conversationState);
      await flushConversationState(globalConversationKey, globalConversationState);
      await logReplyEvent({
        mode,
        channel,
        conversation_key: localConversationKey,
        intent,
        sent: true,
        drop_reason: null,
        latency_ms: Math.max(1, Date.now() - startedAt),
        duplicate_score: duplicateScore,
        initiative: channelPolicy.initiative,
      });
      return NextResponse.json({ reply });
    }

    // --- NORMAL AXY CHAT MODE ---
    const noRepeatBlock = buildNoRepeatBlock(antiRepeatPool);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: buildMasterChatPrompt(
            intent,
            contextBlock,
            noRepeatBlock,
            domainBlock,
            channel,
            stateBlock
          ),
        },
        { role: "user", content: userMessage },
      ],
      max_tokens: 150,
      temperature: 0.62,
      frequency_penalty: 0.7,
      presence_penalty: 0.3,
    });

    let reply = applyStyleGuard(
      completion.choices[0].message.content ?? "...",
      intent,
      channel,
      userMessage,
      channelPolicy
    );
    let duplicateScore = maxDuplicateScore(reply, antiRepeatPool);

    if (
      duplicateScore > 0.82 ||
      isNearDuplicate(reply, antiRepeatPool, DUPLICATE_GUARD_OPTIONS)
    ) {
      const retry = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: buildMasterChatPrompt(
              intent,
              contextBlock,
              buildNoRepeatBlock([...antiRepeatPool, reply].slice(-8)),
              domainBlock,
              channel,
              stateBlock
            ),
          },
          { role: "user", content: userMessage },
        ],
        max_tokens: 150,
        temperature: 0.76,
        frequency_penalty: 0.85,
        presence_penalty: 0.4,
      });

      reply = applyStyleGuard(
        retry.choices[0].message.content ?? "...",
        intent,
        channel,
        userMessage,
        channelPolicy
      );
      duplicateScore = maxDuplicateScore(reply, antiRepeatPool);
    }

    if (isNearDuplicate(reply, antiRepeatPool, DUPLICATE_GUARD_OPTIONS)) {
      reply = fallbackReply(intent, userMessage, antiRepeatPool);
      duplicateScore = maxDuplicateScore(reply, antiRepeatPool);
    }

    rememberReply(localConversationKey, reply);
    rememberReply(globalConversationKey, reply);
    await flushPersistentMemory(localConversationKey);
    await flushPersistentMemory(globalConversationKey);
    await flushConversationState(localConversationKey, conversationState);
    await flushConversationState(globalConversationKey, globalConversationState);
    await logReplyEvent({
      mode,
      channel,
      conversation_key: localConversationKey,
      intent,
      sent: true,
      drop_reason: null,
      latency_ms: Math.max(1, Date.now() - startedAt),
      duplicate_score: duplicateScore,
      initiative: channelPolicy.initiative,
    });

    return NextResponse.json({
      reply,
    });
  } catch (err) {
    console.error("axy error", err);
    return NextResponse.json({ reply: "..." }, { status: 200 });
  }
}

