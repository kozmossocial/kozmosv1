export const MASTER_INTENTS = [
  "greet",
  "status",
  "explain",
  "strategy",
  "reflective",
  "unknown",
];

export const AXY_CHANNELS = [
  "shared",
  "dm",
  "hush",
  "build",
  "game-chat",
  "night-protocol-day",
  "my-home-note",
  "unknown",
];

export const CHANNEL_POLICIES = Object.freeze({
  shared: {
    maxSentences: 2,
    maxChars: 180,
    allowsFollowQuestion: false,
    initiative: "low",
  },
  dm: {
    maxSentences: 2,
    maxChars: 190,
    allowsFollowQuestion: true,
    initiative: "medium",
  },
  hush: {
    maxSentences: 2,
    maxChars: 180,
    allowsFollowQuestion: true,
    initiative: "medium",
  },
  build: {
    maxSentences: 3,
    maxChars: 320,
    allowsFollowQuestion: true,
    initiative: "high",
  },
  "game-chat": {
    maxSentences: 1,
    maxChars: 140,
    allowsFollowQuestion: false,
    initiative: "low",
  },
  "night-protocol-day": {
    maxSentences: 2,
    maxChars: 170,
    allowsFollowQuestion: false,
    initiative: "low",
  },
  "my-home-note": {
    maxSentences: 1,
    maxChars: 180,
    allowsFollowQuestion: false,
    initiative: "low",
  },
  unknown: {
    maxSentences: 2,
    maxChars: 180,
    allowsFollowQuestion: false,
    initiative: "low",
  },
});

const QUESTION_START_RE =
  /^(who|what|when|where|why|how|which|can|could|would|should|do|does|did|is|are|am|will|may|shall)\b/i;
const QUESTION_START_TR_RE = /^(kim|ne|neden|nasil|nerede|ne zaman|hangi)\b/i;
const QUESTION_MID_RE =
  /\b(can you|could you|would you|should we|do you|are you|what if|why not)\b/i;
const QUESTION_END_TR_RE = /\b(mi|mi\?|mi\.|m[iu]|m[iu]\?|m[iu]\.)$/i;

const DEFAULT_FORMULAIC_PHRASES = [
  "in stillness",
  "presence unfolds",
  "without the need",
  "quiet together",
  "presence speaks",
];

export function detectMasterIntent(message) {
  const m = String(message || "").trim().toLowerCase();
  if (!m) return "unknown";
  if (/^(hi|hey|hello|selam|yo|hola|sup|heya|hi axy|hello axy)[\s!.,-]*$/.test(m)) {
    return "greet";
  }
  if (/(where are you|who are you|are you there|status|you there|how are you)/.test(m)) {
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

export function resolveAxyChannel(input) {
  const channel = String(input || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (AXY_CHANNELS.includes(channel)) {
    return channel;
  }
  return "unknown";
}

export function getAxyChannelPolicy(channel) {
  return CHANNEL_POLICIES[resolveAxyChannel(channel)] || CHANNEL_POLICIES.unknown;
}

export function normalizeForSimilarity(text) {
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

export function jaccardSimilarity(a, b) {
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

function hasFormulaicPhrase(text, customPhrases = []) {
  const normalized = normalizeForSimilarity(text);
  if (!normalized) return false;
  const phrases = [...DEFAULT_FORMULAIC_PHRASES, ...customPhrases]
    .map((x) => normalizeForSimilarity(x))
    .filter(Boolean);
  return phrases.some((phrase) => normalized.includes(phrase));
}

export function isNearDuplicate(candidate, recentReplies = [], options = {}) {
  const candidateNorm = normalizeForSimilarity(candidate);
  if (!candidateNorm) return false;

  const threshold = Number.isFinite(options.threshold) ? Number(options.threshold) : 0.82;
  const formulaicGuard = Boolean(options.formulaicGuard);
  const formulaicPhrases = Array.isArray(options.formulaicPhrases)
    ? options.formulaicPhrases
    : [];
  const candidateFormulaic =
    formulaicGuard && hasFormulaicPhrase(candidateNorm, formulaicPhrases);

  for (const recent of recentReplies || []) {
    const recentNorm = normalizeForSimilarity(recent);
    if (!recentNorm) continue;
    if (candidateNorm === recentNorm) return true;
    if (candidateNorm.length > 34 && recentNorm.includes(candidateNorm)) return true;
    if (recentNorm.length > 34 && candidateNorm.includes(recentNorm)) return true;
    if (jaccardSimilarity(candidateNorm, recentNorm) > threshold) return true;
    if (
      candidateFormulaic &&
      hasFormulaicPhrase(recentNorm, formulaicPhrases)
    ) {
      return true;
    }
  }

  return false;
}

export function maxDuplicateScore(candidate, recentReplies = []) {
  const candidateNorm = normalizeForSimilarity(candidate);
  if (!candidateNorm || !Array.isArray(recentReplies) || recentReplies.length === 0) {
    return 0;
  }
  let maxScore = 0;
  for (const recent of recentReplies) {
    const score = jaccardSimilarity(candidateNorm, normalizeForSimilarity(recent));
    if (score > maxScore) maxScore = score;
  }
  return Number(maxScore.toFixed(3));
}

export function looksLikeQuestionText(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return false;
  if (t.includes("?")) return true;
  if (QUESTION_START_RE.test(t)) return true;
  if (QUESTION_START_TR_RE.test(t)) return true;
  if (QUESTION_MID_RE.test(t)) return true;
  if (/\b(right|correct)$/.test(t)) return true;
  if (QUESTION_END_TR_RE.test(t)) return true;
  return false;
}

export function ensureQuestionMark(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return trimmed;
  if (trimmed.includes("?")) return trimmed;
  return `${trimmed.replace(/[.!]+$/, "")}?`;
}

export function ensureQuestionPunctuation(input) {
  let text = String(input || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return text;
  if (!looksLikeQuestionText(text)) return text;
  if (/[?]$/.test(text)) return text;
  text = text.replace(/[.!]+$/, "").trim();
  return `${text}?`;
}
