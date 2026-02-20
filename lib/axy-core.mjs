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

function clampScore(value, min = 0, max = 10) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

export function normalizeIdeaKey(input) {
  return normalizeForSimilarity(input).replace(/\s+/g, " ").trim();
}

export function scoreMissionIdea(idea, options = {}) {
  const usedIdeaKeys = new Set(
    Array.isArray(options.usedIdeaKeys) ? options.usedIdeaKeys.map((k) => normalizeIdeaKey(k)) : []
  );
  const usedIdeaTitles = Array.isArray(options.usedIdeaTitles) ? options.usedIdeaTitles : [];

  const title = String(idea?.title || "").trim();
  const key = normalizeIdeaKey(idea?.key || title);
  const problem = String(idea?.problem || "").trim();
  const goal = String(idea?.goal || "").trim();
  const scope = Array.isArray(idea?.scope)
    ? idea.scope.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const publishSummary = String(idea?.publish_summary || idea?.publishSummary || "").trim();
  const artifactLanguage = String(
    idea?.artifact_language || idea?.artifactLanguage || "markdown"
  )
    .trim()
    .toLowerCase();

  const utility = clampScore(idea?.utility);
  const implementability = clampScore(idea?.implementability);
  const noveltyBase = clampScore(idea?.novelty);

  const duplicateByKey = key && usedIdeaKeys.has(key);
  const duplicateByTitle = title && isNearDuplicate(title, usedIdeaTitles, { threshold: 0.86 });
  const noveltyPenalty = duplicateByKey || duplicateByTitle ? 8 : 0;
  const novelty = Math.max(0, noveltyBase - noveltyPenalty);
  const total = Number((utility * 0.42 + implementability * 0.33 + novelty * 0.25).toFixed(3));

  const valid =
    Boolean(title) &&
    key.length >= 8 &&
    Boolean(problem) &&
    Boolean(goal) &&
    scope.length >= 2 &&
    publishSummary.length >= 70;

  return {
    valid,
    title,
    key,
    problem,
    goal,
    scope,
    publishSummary,
    artifactLanguage,
    utility,
    implementability,
    novelty,
    total,
    duplicateByKey,
    duplicateByTitle,
  };
}

export function pickBestMissionIdea(ideas, options = {}) {
  const scored = (Array.isArray(ideas) ? ideas : [])
    .map((idea) => scoreMissionIdea(idea, options))
    .filter((row) => row.valid)
    .sort((a, b) => b.total - a.total);
  return scored[0] || null;
}

export function scoreMissionBundleQuality(bundle, options = {}) {
  const readme = String(bundle?.readme || "").trim();
  const spec = String(bundle?.spec || "").trim();
  const implementation = String(bundle?.implementation || "").trim();
  const artifactPath = String(bundle?.artifactPath || "").trim();
  const artifactContent = String(bundle?.artifactContent || "").trim();
  const publishSummary = String(bundle?.publishSummary || "").trim();
  const usageSteps = Array.isArray(bundle?.usageSteps)
    ? bundle.usageSteps.map((step) => String(step || "").trim()).filter(Boolean)
    : [];

  const minReadme = Number.isFinite(options.minReadme) ? Number(options.minReadme) : 520;
  const minSpec = Number.isFinite(options.minSpec) ? Number(options.minSpec) : 480;
  const minImplementation = Number.isFinite(options.minImplementation)
    ? Number(options.minImplementation)
    : 480;
  const minArtifact = Number.isFinite(options.minArtifact) ? Number(options.minArtifact) : 260;

  let score = 100;
  const issues = [];

  if (readme.length < minReadme) {
    score -= 18;
    issues.push("readme-too-short");
  }
  if (!/^#\s+/m.test(readme)) {
    score -= 8;
    issues.push("readme-heading-missing");
  }
  if (spec.length < minSpec) {
    score -= 16;
    issues.push("spec-too-short");
  }
  if (!/^#\s+/m.test(spec)) {
    score -= 8;
    issues.push("spec-heading-missing");
  }
  if (implementation.length < minImplementation) {
    score -= 16;
    issues.push("implementation-too-short");
  }
  if (!/^#\s+/m.test(implementation)) {
    score -= 8;
    issues.push("implementation-heading-missing");
  }
  if (!artifactPath || artifactPath.endsWith("/") || artifactPath.startsWith("/")) {
    score -= 12;
    issues.push("artifact-path-invalid");
  }
  if (artifactContent.length < minArtifact) {
    score -= 16;
    issues.push("artifact-too-short");
  }
  if (publishSummary.length < 80 || publishSummary.length > 340) {
    score -= 10;
    issues.push("publish-summary-size");
  }
  if (usageSteps.length < 2) {
    score -= 8;
    issues.push("usage-steps-missing");
  }

  const repeatedSection = isNearDuplicate(readme, [spec, implementation], { threshold: 0.9 });
  if (repeatedSection) {
    score -= 10;
    issues.push("sections-too-similar");
  }

  const qualityScore = Math.max(0, Math.min(100, Math.round(score)));
  const ok = qualityScore >= 80 && issues.length === 0;
  return {
    ok,
    qualityScore,
    issues,
  };
}
