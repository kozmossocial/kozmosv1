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
  scoreMissionIdea,
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
const MISSION_BUILD_CLASSES = [
  "utility",
  "web-app",
  "game",
  "data-viz",
  "dashboard",
  "simulation",
  "social",
  "three-d",
  "integration",
  "template",
  "experimental",
];

const MISSION_BUILD_CLASS_ALIASES = {
  app: "web-app",
  visualization: "data-viz",
  "social-primitive": "social",
  "3d-room-tool": "three-d",
  experiment: "experimental",
};

function normalizeMissionBuildClass(input, fallback = "utility") {
  const normalized = String(input || "").trim().toLowerCase();
  const canonical = MISSION_BUILD_CLASS_ALIASES[normalized] || normalized;
  return MISSION_BUILD_CLASSES.includes(canonical) ? canonical : fallback;
}

function pickMissionBuildClass(planTitle, recentClasses = []) {
  const title = normalizeForSimilarity(planTitle);
  const selectableClasses = MISSION_BUILD_CLASSES.filter((cls) => cls !== "template");
  const keywordClassPairs = [
    ["dashboard", "dashboard"],
    ["timeline", "data-viz"],
    ["chart", "data-viz"],
    ["map", "data-viz"],
    ["simulator", "simulation"],
    ["simulate", "simulation"],
    ["game", "game"],
    ["play", "game"],
    ["3d", "three-d"],
    ["room", "three-d"],
    ["api", "integration"],
    ["proxy", "integration"],
    ["template", "template"],
    ["starter", "social"],
    ["chat", "social"],
    ["feed", "web-app"],
    ["console", "utility"],
    ["tool", "utility"],
  ];
  let preferred = "utility";
  for (const [keyword, cls] of keywordClassPairs) {
    if (title.includes(keyword)) {
      preferred = cls;
      break;
    }
  }
  const recentListRaw = Array.isArray(recentClasses) ? recentClasses : [recentClasses];
  const recentList = recentListRaw
    .map((value) => normalizeMissionBuildClass(value, ""))
    .filter(Boolean);
  const blockedImmediate = new Set(recentList.slice(0, 2));

  let pool = selectableClasses.filter((cls) => !blockedImmediate.has(cls));
  if (pool.length === 0) {
    pool = [...selectableClasses];
  }

  if (preferred && pool.includes(preferred)) {
    return preferred;
  }

  if (preferred && !pool.includes(preferred)) {
    const relatedClassMap = {
      utility: ["integration", "template"],
      "web-app": ["dashboard", "social"],
      game: ["simulation", "three-d"],
      "data-viz": ["dashboard", "utility"],
      dashboard: ["data-viz", "web-app"],
      simulation: ["game", "three-d"],
      social: ["web-app", "integration"],
      "three-d": ["simulation", "game"],
      integration: ["utility", "web-app"],
      template: ["utility", "integration"],
      experimental: ["simulation", "web-app"],
    };
    const related = relatedClassMap[preferred] || [];
    const relatedPick = related.find((cls) => pool.includes(cls));
    if (relatedPick) {
      return relatedPick;
    }
  }

  const usageWeight = new Map();
  recentList.slice(0, 8).forEach((cls, index) => {
    usageWeight.set(cls, (usageWeight.get(cls) || 0) + (8 - index));
  });
  const smallestWeight = Math.min(...pool.map((cls) => usageWeight.get(cls) || 0));
  const leastUsed = pool.filter((cls) => (usageWeight.get(cls) || 0) === smallestWeight);
  const randomPool = leastUsed.length > 0 ? leastUsed : pool;
  return randomPool[Math.floor(Math.random() * randomPool.length)] || "utility";
}

function slugify(input) {
  const slug = String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || `build-${Date.now()}`;
}

function stripDateLikeTokens(input) {
  return String(input || "")
    .replace(/\b20\d{2}[-_/]?\d{2}[-_/]?\d{2}(?:[T ]?\d{2}:?\d{2})?\b/g, " ")
    .replace(/\b\d{12,14}\b/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/[:\-]\s*$/g, "")
    .trim();
}

function normalizeConceptKey(input) {
  return normalizeIdeaKey(stripDateLikeTokens(input));
}

function computeArtifactSignature(content) {
  const raw = String(content || "");
  if (!raw) return "";
  const withoutBlocks = raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\b\d+\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const stopWords = new Set([
    "the",
    "and",
    "for",
    "with",
    "from",
    "this",
    "that",
    "your",
    "build",
    "kozmos",
    "panel",
    "section",
    "button",
    "input",
    "report",
    "gate",
    "run",
  ]);
  const tokens = normalizeForSimilarity(withoutBlocks)
    .split(" ")
    .filter((token) => token.length >= 3 && !stopWords.has(token));
  return tokens.slice(0, 180).join(" ");
}

function hashNumber(input) {
  const text = String(input || "");
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function createFallbackArtifact(plan) {
  const variants = [
    {
      shellTitle: "Demand & Clarity Canvas",
      intro: "Map demand pressure, user intent, and release clarity before publish.",
      panelA: "Demand Signals",
      panelB: "Clarity Actions",
      action: "Synthesize Plan",
      outTitle: "Action Brief",
      usage: [
        "Paste demand notes and user intent evidence.",
        "Run synthesis and review recommended execution path.",
        "Persist the brief then publish with explicit next actions.",
      ],
    },
    {
      shellTitle: "Scenario Stress Studio",
      intro: "Pressure-test the build concept across optimistic, neutral, and failure scenarios.",
      panelA: "Scenario Inputs",
      panelB: "Risk Countermoves",
      action: "Run Stress Test",
      outTitle: "Scenario Matrix",
      usage: [
        "Define scenarios and boundary conditions.",
        "Run stress test and inspect risk countermeasures.",
        "Lock the safest rollout path before publish.",
      ],
    },
    {
      shellTitle: "System Interaction Mapper",
      intro: "Model how user actions, runtime hooks, and outcomes connect in one view.",
      panelA: "Actors & Events",
      panelB: "Runtime Hooks",
      action: "Generate Map",
      outTitle: "Interaction Graph",
      usage: [
        "List actors/events and runtime touchpoints.",
        "Generate the interaction graph and gaps.",
        "Address missing links before publishing.",
      ],
    },
    {
      shellTitle: "Value Routing Console",
      intro: "Route effort toward highest user value with minimal distraction cost.",
      panelA: "Value Inputs",
      panelB: "Noise Constraints",
      action: "Route Value",
      outTitle: "Priority Route",
      usage: [
        "Describe user value and noise constraints.",
        "Compute a priority route with tradeoffs.",
        "Execute top route and defer low-impact work.",
      ],
    },
    {
      shellTitle: "Impact Evidence Tracker",
      intro: "Track evidence quality for utility, adoption readiness, and long-term impact.",
      panelA: "Evidence Notes",
      panelB: "Impact Checks",
      action: "Score Evidence",
      outTitle: "Impact Ledger",
      usage: [
        "Collect evidence linked to mission scope.",
        "Score evidence quality and identify weak zones.",
        "Publish only after weak zones are resolved.",
      ],
    },
  ];
  const theme = [
    { panel: "#092212", edge: "#1f5941", glow: "#7dffb2" },
    { panel: "#0c1e2f", edge: "#2b5e91", glow: "#7dc7ff" },
    { panel: "#22180a", edge: "#6b4f23", glow: "#ffd57a" },
    { panel: "#201027", edge: "#704990", glow: "#d6a8ff" },
    { panel: "#191919", edge: "#4d4d4d", glow: "#d2d2d2" },
  ];
  const seed = hashNumber(plan?.key || plan?.title || "fallback");
  const variant = variants[seed % variants.length];
  const color = theme[seed % theme.length];
  const safeTitle = escapeHtml(String(plan?.title || "Kozmos Build"));
  const safeIntro = escapeHtml(String(variant.intro || ""));
  const storageKey = normalizeConceptKey(plan?.key || safeTitle) || "kozmos:fallback:state";

  const artifactContent = [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "  <meta charset=\"utf-8\" />",
    "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />",
    `  <title>${safeTitle}</title>`,
    "  <style>",
    "    :root { color-scheme: dark; }",
    `    body { margin:0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background:#060b08; color:#dcefe2; }`,
    "    .wrap { max-width: 980px; margin: 24px auto; padding: 20px; }",
    `    .panel { border:1px solid ${color.edge}; border-radius:12px; padding:16px; margin-bottom:14px; background:${color.panel}; }`,
    "    h1,h2 { margin:0 0 10px; font-weight:500; letter-spacing:.02em; }",
    "    .grid { display:grid; grid-template-columns: 1fr 1fr; gap:10px; }",
    "    textarea, button, input { font:inherit; background:#07130d; color:#e8fff0; border:1px solid #2a4a39; border-radius:8px; padding:9px 10px; }",
    "    textarea { width:100%; min-height:120px; resize:vertical; }",
    "    button { cursor:pointer; }",
    `    .accent { color:${color.glow}; }`,
    "    .meta { opacity:.78; font-size:13px; }",
    "    pre { white-space:pre-wrap; word-break:break-word; }",
    "  </style>",
    "</head>",
    "<body>",
    "  <main class=\"wrap\">",
    `    <section class=\"panel\"><h1>${safeTitle}</h1><div class=\"meta\">${escapeHtml(
      variant.shellTitle
    )}</div><div class=\"meta\" style=\"margin-top:6px;\">${safeIntro}</div></section>`,
    "    <section class=\"panel\">",
    "      <div class=\"grid\">",
    `        <div><h2>${escapeHtml(variant.panelA)}</h2><textarea id=\"a\" placeholder=\"Paste high-signal context...\"></textarea></div>`,
    `        <div><h2>${escapeHtml(variant.panelB)}</h2><textarea id=\"b\" placeholder=\"List constraints and desired outcomes...\"></textarea></div>`,
    "      </div>",
    `      <div style=\"margin-top:10px;\"><button id=\"run\">${escapeHtml(variant.action)}</button></div>`,
    "    </section>",
    "    <section class=\"panel\">",
    `      <h2>${escapeHtml(variant.outTitle)}</h2>`,
    "      <pre id=\"out\" class=\"meta\">Run to generate output...</pre>",
    "    </section>",
    "  </main>",
    "  <script>",
    "    const outEl = document.getElementById('out');",
    "    const aEl = document.getElementById('a');",
    "    const bEl = document.getElementById('b');",
    "    const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));",
    "    async function persist(payload) {",
    "      if (!window.KozmosRuntime || !window.KozmosRuntime.kvSet) return;",
    `      try { await window.KozmosRuntime.kvSet(${JSON.stringify(storageKey)}, payload); } catch {}`,
    "    }",
    "    async function restore() {",
    "      if (!window.KozmosRuntime || !window.KozmosRuntime.kvGet) return;",
    "      try {",
    `        const res = await window.KozmosRuntime.kvGet(${JSON.stringify(storageKey)});`,
    "        const value = res && res.item && res.item.value;",
    "        if (value && typeof value === 'object') outEl.textContent = JSON.stringify(value, null, 2);",
    "      } catch {}",
    "    }",
    "    document.getElementById('run').addEventListener('click', async () => {",
    "      const a = (aEl.value || '').trim();",
    "      const b = (bEl.value || '').trim();",
    "      const signal = clamp(Math.floor(a.length / 30), 0, 35);",
    "      const constraint = clamp(Math.floor(b.length / 30), 0, 35);",
    "      const coherence = clamp(55 + signal + Math.floor(constraint * 0.7), 0, 100);",
    "      const risk = clamp(90 - Math.floor((signal + constraint) * 0.6), 5, 95);",
    "      const payload = {",
    "        mission: " + JSON.stringify(String(plan?.title || "Kozmos Build")) + ",",
    "        coherence_score: coherence,",
    "        risk_index: risk,",
    "        recommendation: coherence >= 80 ? 'Proceed with publish gate' : 'Refine scope and rerun',",
    "        next_actions: [",
    "          'Address weakest constraint first',",
    "          'Tie every scope item to one measurable output',",
    "          'Publish after coherence >= 80 and risk <= 40'",
    "        ]",
    "      };",
    "      outEl.textContent = JSON.stringify(payload, null, 2);",
    "      await persist(payload);",
    "    });",
    "    restore();",
    "  </script>",
    "</body>",
    "</html>",
  ].join("\n");

  return {
    artifactContent,
    usageSteps: variant.usage,
  };
}

function formatMissionTitle(titleInput, goalInput) {
  const title = stripDateLikeTokens(titleInput).replace(/\s+/g, " ");
  const goal = String(goalInput || "").trim().replace(/\s+/g, " ");
  if (!title) return "Kozmos Build";
  if (/:| - /.test(title) || title.length >= 34) {
    return title.slice(0, 96);
  }
  const goalSnippet = goal
    .replace(/[.!?].*$/, "")
    .replace(/^to\s+/i, "")
    .slice(0, 56)
    .trim();
  if (!goalSnippet) return title.slice(0, 96);
  return `${title}: ${goalSnippet}`.slice(0, 96);
}

const KOZMOS_PRINCIPLES = [
  "Reduced noise: avoid spammy output and artificial engagement loops.",
  "Intentional interaction: prioritize clarity and concrete utility over volume.",
  "Users first: optimize for real user value, not vanity metrics.",
  "Open curiosity: enable exploration, do not over-constrain discovery.",
  "Persistent presence: build outcomes should remain useful beyond one moment.",
];

const KOZMOS_CORE_LINKS = [
  "/main",
  "/main/space",
  "/build",
  "/build/manual",
  "/runtime/spec",
];

const AXY_NON_REPEAT_DIRECTIVE = [
  "Do not generate repetitive template utilities or minor UI variations.",
  "Every build must target a distinct problem space and a distinct user type.",
  "Design systems, not widgets: include meaningful data flow + interaction model.",
  "Reduce distraction and noise; prioritize clarity, awareness, and durable value.",
  "Do not reuse the same layout skeleton, wording pattern, or checklist shell.",
].join("\n");

const AXY_STRATEGIC_BUILD_DIRECTIVE = [
  "You are not allowed to generate repetitive, template-based, or probe-style utility builds.",
  "No template reuse: if structural similarity with recent outputs exceeds 40%, redesign.",
  "Each build must move to a different problem category than the previous build.",
  "State and justify: real-world problem, user archetype, and global relevance.",
  "Depth is mandatory: include surface functionality, system layer, and platform expansion pathway.",
  "Kozmos ethos is strict: presence over performance, reduced noise, meaningful interaction.",
  "Differentiate from mainstream solutions and explain Kozmos-specific conceptual edge.",
  "Use AI-native logic: AI as co-builder, moderator, insight layer, or adaptive engine.",
  "No internal-only utilities; ship globally usable digital systems.",
  "Abort and rethink if output resembles a simple dashboard, form wrapper, QA probe, or checklist shell.",
].join("\n");

const AXY_SHALLOW_IDEA_PATTERN =
  /\b(template|checklist|qa\s*probe|probe|blueprint|journal|form[-\s]?based|minor ui|wrapper)\b/i;
const AXY_SHALLOW_ARTIFACT_PATTERN =
  /\b(run probe|qa gates|pass\/fail|build input|checklist|publish[-\s]?readiness probe)\b/i;

function textLengthAtLeast(value, min = 24) {
  return String(value || "").trim().length >= min;
}

function countInteractiveElements(html) {
  const text = String(html || "");
  if (!text) return 0;
  const matches = text.match(
    /<(button|input|select|textarea|details|dialog|canvas)\b|contenteditable=|addEventListener\(/gi
  );
  return Array.isArray(matches) ? matches.length : 0;
}

function computeStrategicDepthScore(candidate) {
  const scoreFromLength = (value, maxScore = 1.6, divisor = 120) =>
    Math.min(maxScore, String(value || "").trim().length / divisor);
  const scopeDepth = Math.min(1.8, (Array.isArray(candidate.scope) ? candidate.scope.length : 0) * 0.35);
  const depth =
    scoreFromLength(candidate.globalRelevance, 1.8, 120) +
    scoreFromLength(candidate.differentiation, 1.8, 110) +
    scoreFromLength(candidate.aiNativeDesign, 1.6, 95) +
    scoreFromLength(candidate.expansionPathway, 1.8, 100) +
    scoreFromLength(candidate.surfaceFunctionality, 1.2, 90) +
    scopeDepth;
  return Number(Math.min(6.5, depth).toFixed(3));
}

function collectStrategicIdeaIssues(candidate) {
  const corpus = [
    candidate.title,
    candidate.problem,
    candidate.goal,
    candidate.globalProblem,
    candidate.globalRelevance,
    candidate.surfaceFunctionality,
    candidate.systemLayer,
    candidate.expansionPathway,
    candidate.differentiation,
    candidate.aiNativeDesign,
    ...(Array.isArray(candidate.scope) ? candidate.scope : []),
  ]
    .map((value) => String(value || "").trim())
    .join(" ");

  const issues = [];
  if (!textLengthAtLeast(candidate.globalProblem, 28)) issues.push("missing-global-problem");
  if (!textLengthAtLeast(candidate.globalRelevance, 40)) issues.push("missing-global-relevance");
  if (!textLengthAtLeast(candidate.userArchetype, 12)) issues.push("missing-user-archetype");
  if (!textLengthAtLeast(candidate.surfaceFunctionality, 24)) issues.push("missing-surface-layer");
  if (!textLengthAtLeast(candidate.systemLayer, 24)) issues.push("missing-system-layer");
  if (!textLengthAtLeast(candidate.expansionPathway, 30)) issues.push("missing-expansion-path");
  if (!textLengthAtLeast(candidate.differentiation, 28)) issues.push("missing-differentiation");
  if (!textLengthAtLeast(candidate.aiNativeDesign, 20)) issues.push("missing-ai-native-layer");
  if (AXY_SHALLOW_IDEA_PATTERN.test(corpus)) issues.push("shallow-or-template-pattern");
  return issues;
}

function buildKozmosMissionGuardBlock() {
  return [
    "Kozmos operating principles (hard constraints):",
    ...KOZMOS_PRINCIPLES.map((line) => `- ${line}`),
    "Kozmos core surfaces to stay aligned with:",
    ...KOZMOS_CORE_LINKS.map((line) => `- ${line}`),
  ].join("\n");
}

function computeDemandHotspots({
  sharedLines = [],
  buildLines = [],
  noteLines = [],
  ecosystemLines = [],
}) {
  const buckets = [
    { key: "shared-chat", rx: /(shared|main chat|open chat|channel)/i },
    { key: "build", rx: /(build|subspace|preview|publish|export)/i },
    { key: "dm-hush", rx: /(dm|direct chat|hush|private)/i },
    { key: "matrix-space", rx: /(matrix|space|room|world|presence|orb)/i },
    { key: "play-games", rx: /(play|game|starfall|night|swarm)/i },
    { key: "news-notes", rx: /(news|paper|note|journal|report)/i },
  ];
  const counts = new Map(buckets.map((bucket) => [bucket.key, 0]));
  const feed = [...sharedLines, ...buildLines, ...noteLines, ...ecosystemLines].map((line) =>
    String(line || "")
  );
  feed.forEach((line) => {
    buckets.forEach((bucket) => {
      if (bucket.rx.test(line)) {
        counts.set(bucket.key, (counts.get(bucket.key) || 0) + 1);
      }
    });
  });
  return Array.from(counts.entries())
    .map(([key, count]) => ({ key, count }))
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);
}

function scoreIdeaDemandFit(ideaText, demandHotspots) {
  if (!Array.isArray(demandHotspots) || demandHotspots.length === 0) return 0;
  const normalized = normalizeForSimilarity(ideaText);
  let score = 0;
  const matchers = {
    "shared-chat": /(shared|chat|open|channel)/i,
    build: /(build|subspace|preview|publish|export)/i,
    "dm-hush": /(dm|direct|hush|private)/i,
    "matrix-space": /(matrix|space|room|world|presence|orb)/i,
    "play-games": /(play|game|starfall|night|swarm)/i,
    "news-notes": /(news|paper|note|journal|report)/i,
  };
  for (const hotspot of demandHotspots) {
    const rx = matchers[hotspot.key];
    if (!rx) continue;
    if (rx.test(normalized)) {
      score += Math.min(2.4, 0.8 + hotspot.count * 0.2);
    }
  }
  return Number(Math.min(3, score).toFixed(2));
}

function formatDemandHotspotLabel(key) {
  const labels = {
    "shared-chat": "Shared Chat",
    build: "User Build",
    "dm-hush": "DM/Hush",
    "matrix-space": "Matrix/Space",
    "play-games": "Play/Games",
    "news-notes": "News/Notes",
  };
  return labels[key] || key;
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
        key: normalizeConceptKey(row?.key || row?.title || ""),
        path: String(row?.path || "").trim(),
        created_at: String(row?.created_at || "").trim(),
        build_class: normalizeMissionBuildClass(row?.build_class || row?.class || "utility"),
        problem_category_key: normalizeConceptKey(row?.problem_category_key || row?.problem_category || ""),
        problem_space_key: normalizeConceptKey(row?.problem_space_key || ""),
        user_type_key: normalizeConceptKey(row?.user_type_key || ""),
        interaction_key: normalizeConceptKey(row?.interaction_key || ""),
        artifact_signature: normalizeForSimilarity(row?.artifact_signature || ""),
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
    const key = normalizeConceptKey(title);
    if (!key) continue;
    harvested.push({
      title,
      key,
      path: pathValue.slice(0, -"README.md".length).replace(/\/+$/, ""),
      created_at: String(file?.updated_at || ""),
      build_class: "utility",
      problem_category_key: "",
      problem_space_key: "",
      user_type_key: "",
      interaction_key: "",
      artifact_signature: "",
    });
  }
  return harvested;
}

async function runSessionBuildMission({
  baseUrl,
  token,
  botUsername,
  actorUserId,
  buildSpaceId,
  missionSessionId,
  missionMaxIdeaAttempts,
  missionMaxBundleAttempts,
  missionHistoryLimit,
  missionNoRepeatDays,
  missionNotesToBuildChat,
  missionNoteSentKeys,
  missionContext,
  previousMissionBuildClass,
  onState,
}) {
  const setState = typeof onState === "function" ? onState : async () => {};
  const noteSentKeys = missionNoteSentKeys instanceof Set ? missionNoteSentKeys : new Set();
  const noteSessionKey = String(missionSessionId || "default").trim();
  const pushBuildNote = async (title, bodyLines = []) => {
    if (!missionNotesToBuildChat) return;
    const noteType = String(title || "").trim().toLowerCase();
    const dedupeKey = `${noteSessionKey}:${noteType}`;
    if (noteSentKeys.has(dedupeKey)) return;
    const lines = [
      `[Axy Build Note] ${String(title || "").trim()}`.trim(),
      ...bodyLines.map((line) => String(line || "").trim()).filter(Boolean),
    ].filter(Boolean);
    const content = lines.join("\n").slice(0, 5000);
    if (!content) return;
    await callAxyOps(baseUrl, token, "build.chat.send", { content });
    noteSentKeys.add(dedupeKey);
  };
  await setState("mission_planning");
  let targetSpaceId = String(buildSpaceId || "").trim();

  if (!targetSpaceId) {
    const spacesRes = await callAxyOps(baseUrl, token, "build.spaces.list");
    const editable = (Array.isArray(spacesRes?.data) ? spacesRes.data : []).filter(
      (space) => space?.id && space?.can_edit === true
    );
    const preferred = editable.find((space) => {
      const title = String(space?.title || "").trim().toLowerCase();
      const ownerId = String(space?.owner_id || "").trim();
      return (
        title === "axy published builds" &&
        (!actorUserId || (ownerId && ownerId === actorUserId))
      );
    });
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
  const recentMissionClasses = usedHistory
    .map((row) => normalizeMissionBuildClass(row?.build_class || row?.class || "", ""))
    .filter(Boolean);
  const effectiveRecentMissionClasses = [
    normalizeMissionBuildClass(previousMissionBuildClass || "", ""),
    ...recentMissionClasses,
  ].filter(Boolean);
  const usedIdeaKeys = new Set(
    usedHistory.map((row) => normalizeConceptKey(row.key || row.title || "")).filter(Boolean)
  );
  const usedCategoryKeys = new Set(
    usedHistory
      .map((row) => normalizeConceptKey(row.problem_category_key || row.problem_space_key || ""))
      .filter(Boolean)
  );
  const usedProblemKeys = new Set(
    usedHistory.map((row) => normalizeConceptKey(row.problem_space_key || "")).filter(Boolean)
  );
  const usedUserTypeKeys = new Set(
    usedHistory.map((row) => normalizeConceptKey(row.user_type_key || "")).filter(Boolean)
  );
  const usedInteractionKeys = new Set(
    usedHistory.map((row) => normalizeConceptKey(row.interaction_key || "")).filter(Boolean)
  );
  const recentArtifactSignatures = usedHistory
    .map((row) => normalizeForSimilarity(row.artifact_signature || ""))
    .filter(Boolean);

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
  const contextBuildChat = Array.isArray(missionContext?.buildChat)
    ? missionContext.buildChat
        .slice(-20)
        .map((row) => `${row?.username || "user"}: ${String(row?.content || "").trim()}`)
        .filter((line) => line.length > 3)
    : [];
  const demandHotspots = computeDemandHotspots({
    sharedLines: contextShared,
    buildLines: contextBuildChat,
    noteLines: contextNotes,
    ecosystemLines: contextBuildSpaces,
  });

  let plan = null;
  let planUsedFallback = false;
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
    const buildChatBlock = contextBuildChat.length
      ? contextBuildChat.slice(-12).map((line) => `- ${line}`).join("\n")
      : "- no recent build chat notes";
    const hotspotBlock = demandHotspots.length
      ? demandHotspots
          .map((row) => `- ${formatDemandHotspotLabel(row.key)} (${row.count})`)
          .join("\n")
      : "- no strong hotspot yet";
    const principleBlock = buildKozmosMissionGuardBlock();
    const recentProblemBlock = usedHistory
      .map((row) => normalizeConceptKey(row.problem_space_key || row.title || ""))
      .filter(Boolean)
      .slice(0, 24)
      .map((row) => `- ${row}`)
      .join("\n") || "- none";
    const recentCategoryBlock = usedHistory
      .map((row) => normalizeConceptKey(row.problem_category_key || row.problem_space_key || ""))
      .filter(Boolean)
      .slice(0, 24)
      .map((row) => `- ${row}`)
      .join("\n") || "- none";
    const recentUserTypeBlock = usedHistory
      .map((row) => normalizeConceptKey(row.user_type_key || ""))
      .filter(Boolean)
      .slice(0, 24)
      .map((row) => `- ${row}`)
      .join("\n") || "- none";
    const recentInteractionBlock = usedHistory
      .map((row) => normalizeConceptKey(row.interaction_key || ""))
      .filter(Boolean)
      .slice(0, 24)
      .map((row) => `- ${row}`)
      .join("\n") || "- none";

    const planPrompt = [
      "Create candidate Kozmos build missions and score them.",
      `Identity: ${botUsername}.`,
      "Return strict JSON only.",
      principleBlock,
      `Non-repetition directive:\n${AXY_NON_REPEAT_DIRECTIVE}`,
      `Strategic directive:\n${AXY_STRATEGIC_BUILD_DIRECTIVE}`,
      `Never repeat or clone any prior idea/title in this list:\n${existingBlock}`,
      `Avoid these recent problem categories:\n${recentCategoryBlock}`,
      `Avoid these recent problem space keys:\n${recentProblemBlock}`,
      `Avoid these recent user-type keys:\n${recentUserTypeBlock}`,
      `Avoid these recent interaction-model keys:\n${recentInteractionBlock}`,
      `Recent shared conversation signals:\n${sharedContextBlock}`,
      `Recent private note signals:\n${notesContextBlock}`,
      `Current user-build ecosystem signals:\n${buildContextBlock}`,
      `Recent build chat notes:\n${buildChatBlock}`,
      `Current demand hotspots:\n${hotspotBlock}`,
      "JSON schema:",
      '{"ideas":[{"title":"...", "problem":"...", "goal":"...", "problem_category":"...", "user_type":"...", "user_archetype":"...", "global_problem":"...", "global_relevance":"...", "surface_functionality":"...", "problem_space_key":"...", "interaction_model_key":"...", "system_layer":"...", "expansion_pathway":"...", "differentiation":"...", "ai_native_design":"...", "kozmos_edge":"...", "scope":["..."], "artifact_language":"typescript|javascript|html|sql|css|json", "publish_summary":"... (1 concise paragraph)", "utility":0-10, "implementability":0-10, "novelty":0-10}]}',
      "Rules:",
      "- return exactly 4 ideas",
      "- title must be novel, specific, and clearly explain the product outcome",
      "- title format should read like a product name + function (e.g. 'X: what it does')",
      "- each idea must define a distinct user_type and problem_space_key",
      "- each idea must define a distinct interaction_model_key and system_layer",
      "- practical utility for Kozmos users",
      "- prioritize globally recurring user demand and highest traffic request surfaces",
      "- if demand hotspots are visible, reflect them directly in title/problem/goal",
      "- prioritize previewable user-build outcomes (interactive web modules) over documentation-only outputs",
      "- consider Kozmos modules ecosystem (main chat, hush, game chat, build, matrix, play) and propose compatible additions",
      "- do not produce probe/checklist/template/blueprint/journal styles",
      "- every idea must include explicit global_problem, global_relevance, user_archetype, surface_functionality, system_layer, expansion_pathway, differentiation, ai_native_design, kozmos_edge",
      "- each idea must define a distinct problem_category (no horizontal variation under one category)",
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
    const candidateIdeas =
      ideas.length > 0
        ? ideas
        : [
            {
              ...parsed,
              utility: 6,
              implementability: 6,
              novelty: 6,
            },
          ];

    const scoredIdeas = candidateIdeas
      .map((idea) => {
        const scored = scoreMissionIdea(idea, {
          usedIdeaKeys: Array.from(usedIdeaKeys),
          usedIdeaTitles: recentIdeaTitles,
        });
        const userType = String(idea?.user_type || idea?.userType || "").trim();
        const userTypeKey = normalizeConceptKey(userType);
        const problemSpaceKey = normalizeConceptKey(
          idea?.problem_space_key || idea?.problemSpaceKey || scored.title || scored.problem
        );
        const interactionKey = normalizeConceptKey(
          idea?.interaction_model_key || idea?.interactionModelKey || ""
        );
        const systemLayer = String(idea?.system_layer || idea?.systemLayer || "").trim();
        const userArchetype = String(idea?.user_archetype || idea?.userArchetype || userType).trim();
        const globalProblem = String(
          idea?.global_problem || idea?.globalProblem || idea?.real_world_problem || scored.problem
        ).trim();
        const globalRelevance = String(
          idea?.global_relevance || idea?.globalRelevance || idea?.why_global || ""
        ).trim();
        const surfaceFunctionality = String(
          idea?.surface_functionality || idea?.surfaceFunctionality || ""
        ).trim();
        const expansionPathway = String(
          idea?.expansion_pathway || idea?.expansionPathway || idea?.platform_pathway || ""
        ).trim();
        const differentiation = String(
          idea?.differentiation || idea?.mainstream_diff || idea?.kozmos_edge || ""
        ).trim();
        const aiNativeDesign = String(
          idea?.ai_native_design || idea?.aiNativeDesign || idea?.ai_native || ""
        ).trim();
        const problemCategory = normalizeConceptKey(
          idea?.problem_category || idea?.problemCategory || problemSpaceKey || scored.problem
        );
        const kozmosEdge = String(idea?.kozmos_edge || idea?.kozmosEdge || "").trim();
        return {
          ...scored,
          userType,
          userTypeKey,
          problemSpaceKey,
          interactionKey,
          systemLayer,
          userArchetype,
          globalProblem,
          globalRelevance,
          surfaceFunctionality,
          expansionPathway,
          differentiation,
          aiNativeDesign,
          problemCategory,
          kozmosEdge,
        };
      })
      .map((row) => ({
        ...row,
        strategicIssues: collectStrategicIdeaIssues(row),
      }))
      .filter((row) => row.valid && row.strategicIssues.length === 0)
      .map((row) => {
        const text = [row.title, row.problem, row.goal, ...(row.scope || [])].join(" ");
        const demandFit = scoreIdeaDemandFit(text, demandHotspots);
        const duplicateProblem = Boolean(row.problemSpaceKey) && usedProblemKeys.has(row.problemSpaceKey);
        const duplicateCategory =
          Boolean(row.problemCategory) && usedCategoryKeys.has(row.problemCategory);
        const duplicateUser = Boolean(row.userTypeKey) && usedUserTypeKeys.has(row.userTypeKey);
        const duplicateInteraction =
          Boolean(row.interactionKey) && usedInteractionKeys.has(row.interactionKey);
        const patternPenalty =
          (duplicateCategory ? 0.9 : 0) +
          (duplicateProblem ? 0.8 : 0) +
          (duplicateUser ? 0.45 : 0) +
          (duplicateInteraction ? 0.55 : 0);
        const strategicDepth = computeStrategicDepthScore(row);
        const adjustedTotal = Number(
          (row.total + demandFit * 0.35 + strategicDepth * 0.28 - patternPenalty).toFixed(3)
        );
        return {
          ...row,
          demandFit,
          strategicDepth,
          adjustedTotal,
          duplicateCategory,
          duplicateProblem,
          duplicateUser,
          duplicateInteraction,
        };
      })
      .sort((a, b) => b.adjustedTotal - a.adjustedTotal);

    const bestIdea =
      scoredIdeas.find(
        (row) =>
          !row.duplicateByKey &&
          !row.duplicateByTitle &&
          !row.duplicateCategory &&
          !row.duplicateProblem &&
          !row.duplicateInteraction
      ) || null;
    if (!bestIdea) continue;
    if (bestIdea.adjustedTotal < 5.8) continue;
    if (usedIdeaKeys.has(bestIdea.key)) continue;
    const clearTitle = formatMissionTitle(bestIdea.title, bestIdea.goal);
    plan = {
      title: clearTitle,
      key: normalizeConceptKey(clearTitle),
      buildClass: pickMissionBuildClass(bestIdea.title, effectiveRecentMissionClasses),
      userType: bestIdea.userType || "",
      userTypeKey: bestIdea.userTypeKey || "",
      problemSpaceKey: bestIdea.problemSpaceKey || normalizeConceptKey(clearTitle),
      interactionKey: bestIdea.interactionKey || "",
      systemLayer: bestIdea.systemLayer || "",
      userArchetype: bestIdea.userArchetype || bestIdea.userType || "",
      globalProblem: bestIdea.globalProblem || bestIdea.problem || "",
      globalRelevance: bestIdea.globalRelevance || "",
      surfaceFunctionality: bestIdea.surfaceFunctionality || "",
      expansionPathway: bestIdea.expansionPathway || "",
      differentiation: bestIdea.differentiation || bestIdea.kozmosEdge || "",
      aiNativeDesign: bestIdea.aiNativeDesign || "",
      problemCategory: bestIdea.problemCategory || bestIdea.problemSpaceKey || "",
      problem: bestIdea.problem,
      goal: bestIdea.goal,
      scope: bestIdea.scope.slice(0, 8),
      publishSummary: bestIdea.publishSummary.slice(0, 340),
      artifactLanguage: bestIdea.artifactLanguage || "markdown",
      ideaScores: {
        utility: bestIdea.utility,
        implementability: bestIdea.implementability,
        novelty: bestIdea.novelty,
        total: bestIdea.adjustedTotal,
      },
    };
    break;
  }

  if (!plan) {
    const fallbackCandidates = [
      {
        title: "Kozmos Deep Work Session Orchestrator",
        problem:
          "Remote teams lose focus due constant context switching and fragmented async communication.",
        goal:
          "Create adaptive focus sessions that structure collaboration without distraction loops.",
        problemCategory: "attention-and-focus-coordination",
        userType: "remote product and engineering teams",
        userArchetype: "knowledge workers juggling deep work and async collaboration windows",
        problemSpaceKey: "collaborative-focus-governance",
        interactionKey: "session planner + interruption budget board",
        systemLayer: "focus policy engine with attention budget memory",
        globalProblem:
          "Digital workers globally face interruption-heavy environments that degrade quality and increase burnout.",
        globalRelevance:
          "Focus fragmentation affects teams in every market with remote/hybrid workflows and has measurable productivity and wellbeing costs.",
        surfaceFunctionality:
          "Interactive session composer that balances deep-work blocks, handoff windows, and interruption caps.",
        expansionPathway:
          "Extend from single-team sessions into org-level attention governance with cross-team policy templates.",
        differentiation:
          "Unlike generic calendar or chat tools, this prioritizes attention protection and collaboration quality over message throughput.",
        aiNativeDesign:
          "AI predicts interruption risk, adapts session structure, and proposes minimal-noise collaboration slots.",
        scope: [
          "build a multi-zone session orchestration interface with focus/interrupt controls",
          "add adaptive AI recommendations for schedule and collaboration balancing",
          "generate session outcome ledger with follow-up commitments and risk alerts",
        ],
        publishSummary:
          "A focus orchestration app that reduces interruption noise while preserving team collaboration quality.",
        artifactLanguage: "html",
        ideaScores: { utility: 8.7, implementability: 7.9, novelty: 8.3, total: 8.38 },
      },
      {
        title: "Kozmos Async Decision Memory",
        problem:
          "Teams repeatedly revisit old decisions because rationale is scattered across chat threads and docs.",
        goal:
          "Build an interactive decision memory that captures rationale, tradeoffs, and revisit triggers.",
        problemCategory: "organizational-decision-intelligence",
        userType: "cross-functional product organizations",
        userArchetype: "teams coordinating decisions across asynchronous channels",
        problemSpaceKey: "decision-rationale-preservation",
        interactionKey: "decision timeline + confidence map",
        systemLayer: "decision graph with contradiction and stale-state detection",
        globalProblem:
          "Decision churn and context loss increase execution waste across globally distributed organizations.",
        globalRelevance:
          "Asynchronous global teams need reliable shared memory to avoid repeated debate and strategic drift.",
        surfaceFunctionality:
          "Interactive board to log decisions, confidence levels, assumptions, and revisit conditions.",
        expansionPathway:
          "Scale into org-wide decision intelligence with dependency mapping and automated stale-decision alerts.",
        differentiation:
          "Unlike docs or wiki tools, this enforces decision lifecycle logic and explicit uncertainty handling.",
        aiNativeDesign:
          "AI summarizes debates, detects conflicting assumptions, and signals when decisions need revisit.",
        scope: [
          "build a decision memory interface with confidence and assumption tracking",
          "add AI summarization + contradiction detection for decision logs",
          "generate revisit queue based on stale assumptions and downstream risk",
        ],
        publishSummary:
          "A decision memory system that prevents repeated debate and improves continuity in async teams.",
        artifactLanguage: "html",
        ideaScores: { utility: 8.8, implementability: 8.0, novelty: 8.1, total: 8.34 },
      },
      {
        title: "Kozmos Community Signal Router",
        problem:
          "Online communities miss high-priority member needs because signals drown in high-volume channels.",
        goal:
          "Create a signal routing layer that surfaces meaningful requests and suppresses low-value noise.",
        problemCategory: "community-signal-prioritization",
        userType: "community moderators and growth teams",
        userArchetype: "operators maintaining high-signal interactions in active communities",
        problemSpaceKey: "high-signal-community-routing",
        interactionKey: "signal triage + response lane manager",
        systemLayer: "priority routing engine with fatigue-aware queueing",
        globalProblem:
          "Community channels globally suffer from noise inflation, slowing response to real user needs.",
        globalRelevance:
          "Any scaled online community needs transparent, low-noise prioritization to retain trust and responsiveness.",
        surfaceFunctionality:
          "Interactive triage console with urgency scoring, response assignment, and queue health indicators.",
        expansionPathway:
          "Extend into multi-community signal mesh with policy sharing and cross-room escalation rules.",
        differentiation:
          "Unlike raw moderation inboxes, this couples urgency, impact, and responder load into one actionable routing model.",
        aiNativeDesign:
          "AI classifies signal quality, predicts escalation risk, and suggests responder allocation in real time.",
        scope: [
          "build interactive signal triage and assignment board",
          "add AI urgency and impact classification logic",
          "generate response-latency and backlog health timeline",
        ],
        publishSummary:
          "A high-signal routing system that helps communities respond faster to what matters most.",
        artifactLanguage: "html",
        ideaScores: { utility: 8.9, implementability: 8.1, novelty: 8.0, total: 8.36 },
      },
    ];

    const pickedFallback = fallbackCandidates.find((candidate) => {
      const key = normalizeIdeaKey(candidate.title);
      const problemKey = normalizeConceptKey(candidate.problemSpaceKey || candidate.problem);
      const categoryKey = normalizeConceptKey(candidate.problemCategory || candidate.problemSpaceKey || "");
      return (
        !usedIdeaKeys.has(key) &&
        !usedCategoryKeys.has(categoryKey) &&
        !usedProblemKeys.has(problemKey) &&
        !isNearDuplicate(candidate.title, recentIdeaTitles, { threshold: 0.86 })
      );
    });

    if (pickedFallback) {
      planUsedFallback = true;
      const fallbackTitle = formatMissionTitle(pickedFallback.title, pickedFallback.goal);
      plan = {
        title: fallbackTitle,
        key: normalizeConceptKey(fallbackTitle),
        buildClass: pickMissionBuildClass(pickedFallback.title, effectiveRecentMissionClasses),
        userType: pickedFallback.userType,
        userTypeKey: normalizeConceptKey(pickedFallback.userType || ""),
        userArchetype: pickedFallback.userArchetype,
        problemCategory: normalizeConceptKey(pickedFallback.problemCategory || ""),
        problemSpaceKey: normalizeConceptKey(pickedFallback.problemSpaceKey || pickedFallback.problem || fallbackTitle),
        interactionKey: normalizeConceptKey(pickedFallback.interactionKey || ""),
        systemLayer: pickedFallback.systemLayer,
        globalProblem: pickedFallback.globalProblem,
        globalRelevance: pickedFallback.globalRelevance,
        surfaceFunctionality: pickedFallback.surfaceFunctionality,
        expansionPathway: pickedFallback.expansionPathway,
        differentiation: pickedFallback.differentiation,
        aiNativeDesign: pickedFallback.aiNativeDesign,
        problem: pickedFallback.problem,
        goal: pickedFallback.goal,
        scope: pickedFallback.scope,
        publishSummary: pickedFallback.publishSummary,
        artifactLanguage: pickedFallback.artifactLanguage,
        ideaScores: pickedFallback.ideaScores,
      };
    } else {
      planUsedFallback = true;
      const emergencyBases = [
        "Kozmos Build Event Timeline Console",
        "Kozmos Multi-Room Presence Mapper",
        "Kozmos Session Handshake Inspector",
        "Kozmos Quiet Signal Monitor",
        "Kozmos Build Publish Audit Deck",
      ];
      const emergencyTitleBase =
        emergencyBases.find((title) => {
          const key = normalizeIdeaKey(title);
          return (
            key &&
            !usedIdeaKeys.has(key) &&
            !isNearDuplicate(title, recentIdeaTitles, { threshold: 0.86 })
          );
        }) || emergencyBases[0];
      const emergencyTitle = formatMissionTitle(
        emergencyTitleBase,
        "interactive publish-readiness and runtime quality probe"
      );
      const emergencyKey = normalizeConceptKey(emergencyTitle);
      plan = {
        title: emergencyTitle,
        key: emergencyKey,
        buildClass: pickMissionBuildClass(emergencyTitle, effectiveRecentMissionClasses),
        userType: "cross-functional teams coordinating high-stakes digital operations",
        userTypeKey: "cross-functional teams coordinating high-stakes digital operations",
        userArchetype: "operators balancing safety, trust, and execution under pressure",
        problemCategory: normalizeConceptKey("collective-attention-governance"),
        problemSpaceKey: normalizeConceptKey("collective-attention-governance"),
        interactionKey: normalizeConceptKey("multi-signal intent arbitration workspace"),
        systemLayer: "attention governance engine + adaptive policy memory",
        globalProblem:
          "Digital workstreams collapse under noisy prioritization, creating avoidable harm and coordination failures.",
        globalRelevance:
          "Every globally distributed organization faces rising signal overload and needs durable decision governance in mixed human/AI workflows.",
        surfaceFunctionality:
          "Interactive governance board that reconciles competing priorities into actionable, low-noise execution contracts.",
        expansionPathway:
          "Evolve into policy-aware orchestration layer spanning teams, regions, and external partners with auditable memory.",
        differentiation:
          "Not a dashboard clone: it transforms noisy input into governed collective decisions with explicit trust boundaries.",
        aiNativeDesign:
          "AI serves as arbitration co-pilot, risk sentinel, and adaptive policy recommender with transparent rationale.",
        problem:
          "Mission planner exhausted reusable candidates under strict uniqueness constraints while maintaining strategic quality gates.",
        goal:
          "Ship a fully previewable, single-session HTML app that opens a fresh, globally relevant category with deep interaction design.",
        scope: [
          "build a multi-zone interactive index.html outcome with distinct role perspectives",
          "add adaptive AI-native recommendation logic and decision memory",
          "publish complete README/SPEC/IMPLEMENTATION/API-CONTRACT/EXPORT-MANIFEST aligned to global relevance",
        ],
        publishSummary:
          "A strategic emergency mission output that preserves mission-first guarantees without falling back to shallow or repetitive utility patterns.",
        artifactLanguage: "html",
        ideaScores: { utility: 8.1, implementability: 7.8, novelty: 9.4, total: 8.42 },
      };
    }
  }

  await pushBuildNote("plan", [
    `title: ${plan.title}`,
    `class: ${plan.buildClass}`,
    `user_type: ${plan.userType || "-"}`,
    `user_archetype: ${plan.userArchetype || "-"}`,
    `problem_category: ${plan.problemCategory || "-"}`,
    `problem_space_key: ${plan.problemSpaceKey || "-"}`,
    `interaction_key: ${plan.interactionKey || "-"}`,
    `system_layer: ${plan.systemLayer || "-"}`,
    `global_problem: ${plan.globalProblem || "-"}`,
    `global_relevance: ${plan.globalRelevance || "-"}`,
    `surface_functionality: ${plan.surfaceFunctionality || "-"}`,
    `expansion_pathway: ${plan.expansionPathway || "-"}`,
    `differentiation: ${plan.differentiation || "-"}`,
    `ai_native_design: ${plan.aiNativeDesign || "-"}`,
    `problem: ${plan.problem}`,
    `goal: ${plan.goal}`,
    `scope: ${plan.scope.join(" | ")}`,
    `scores: utility=${plan.ideaScores?.utility ?? 0}, implementability=${plan.ideaScores?.implementability ?? 0}, novelty=${plan.ideaScores?.novelty ?? 0}, total=${plan.ideaScores?.total ?? 0}`,
  ]);

  await setState("mission_building", {
    topic: plan.title,
    qualityScore: plan.ideaScores?.total || 0,
    outputPath: "",
  });

  let bundle = null;
  let bundleQuality = null;
  let bundleUsedFallback = false;
  for (let attempt = 1; attempt <= missionMaxBundleAttempts; attempt += 1) {
    const bundlePrompt = [
      "Generate the mission output package for this build plan.",
      "Return strict JSON only.",
      `Plan title: ${plan.title}`,
      `User type: ${String(plan.userType || "general kozmos users")}`,
      `User archetype: ${String(plan.userArchetype || plan.userType || "global digital users under coordination stress")}`,
      `Problem category: ${String(plan.problemCategory || "-")}`,
      `Problem-space key: ${String(plan.problemSpaceKey || "-")}`,
      `Interaction-model key: ${String(plan.interactionKey || "-")}`,
      `System layer: ${String(plan.systemLayer || "-")}`,
      `Global problem: ${String(plan.globalProblem || plan.problem || "")}`,
      `Global relevance: ${String(plan.globalRelevance || "")}`,
      `Surface functionality: ${String(plan.surfaceFunctionality || "")}`,
      `Expansion pathway: ${String(plan.expansionPathway || "")}`,
      `Differentiation: ${String(plan.differentiation || "")}`,
      `AI-native design: ${String(plan.aiNativeDesign || "")}`,
      `Problem: ${plan.problem}`,
      `Goal: ${plan.goal}`,
      `Scope bullets: ${plan.scope.join(" | ")}`,
      "Artifact language target: html",
      `Non-repetition directive:\n${AXY_NON_REPEAT_DIRECTIVE}`,
      `Strategic directive:\n${AXY_STRATEGIC_BUILD_DIRECTIVE}`,
      "JSON schema:",
      '{"readme":"...", "spec":"...", "implementation":"...", "apiContract":"...", "exportManifest":"...", "artifactPath":"...", "artifactLanguage":"...", "artifactContent":"...", "publishSummary":"...", "usageSteps":["step1","step2","step3"]}',
      "Content rules:",
      "- README/SPEC/IMPLEMENTATION/API-CONTRACT should be concise release engineering notes, not teaching/tutorial text",
      "- SPEC must stay aligned with the exact mission title",
      "- artifactPath must be exactly index.html",
      "- artifactContent must be a complete interactive HTML app with inline CSS + JS (no placeholder-only markdown)",
      "- artifactContent must avoid recycled probe/checklist/report-only structures",
      "- artifactContent must include at least three distinct interaction zones (not one form + one button pattern)",
      "- artifactContent must include adaptive AI-native behavior logic, not static-only flows",
      "- artifactContent must include a distinct interaction loop specific to this mission's user type",
      "- artifact must be immediately previewable in Kozmos build outcome preview",
      "- output must be deployable-app ready and export-ready (zip-compatible structure)",
      "- exportManifest must be valid JSON text with version, entry, files, and runtime contract",
      "- apiContract must describe starter endpoints: posts/comments/likes/dm + mode",
      "- If persistence or network is needed, use window.KozmosRuntime.kv* and window.KozmosRuntime.proxy",
      "- If social primitives are needed, use window.KozmosRuntime.starter.*",
      "- publishSummary should be one concrete paragraph",
      "- usageSteps should be short operator actions, not long mentoring guidance",
      "- include explicit sections for global relevance, differentiation, and expansion pathway in docs",
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
      apiContract: String(parsed.apiContract || "").trim(),
      exportManifest: String(parsed.exportManifest || "").trim(),
      artifactPath: normalizeBuildPath(parsed.artifactPath || "index.html"),
      artifactLanguage: String(parsed.artifactLanguage || "html")
        .trim()
        .toLowerCase(),
      artifactContent: String(parsed.artifactContent || "").trim(),
      publishSummary: String(parsed.publishSummary || plan.publishSummary || "").trim(),
      usageSteps: Array.isArray(parsed.usageSteps)
        ? parsed.usageSteps.map((step) => String(step || "").trim()).filter(Boolean).slice(0, 8)
        : [],
    };
    const artifactPathLower = String(candidateBundle.artifactPath || "").toLowerCase();
    const artifactHtml = candidateBundle.artifactContent.toLowerCase();
    const looksPreviewableHtml =
      artifactPathLower === "index.html" &&
      artifactHtml.includes("<!doctype html>") &&
      artifactHtml.includes("<html") &&
      artifactHtml.includes("<style") &&
      artifactHtml.includes("<script");
    if (!looksPreviewableHtml) continue;
    if (AXY_SHALLOW_ARTIFACT_PATTERN.test(candidateBundle.artifactContent)) continue;
    if (countInteractiveElements(candidateBundle.artifactContent) < 4) continue;

    const specFirstHeading = (candidateBundle.spec.match(/^#\s+(.+)$/m)?.[1] || "").trim();
    if (
      specFirstHeading &&
      !specFirstHeading.toLowerCase().includes(plan.title.toLowerCase())
    ) {
      continue;
    }

    const quality = scoreMissionBundleQuality(candidateBundle);
    if (!quality.ok) continue;

    const candidateArtifactSignature = computeArtifactSignature(candidateBundle.artifactContent);
    if (
      candidateArtifactSignature &&
      recentArtifactSignatures.length > 0 &&
      isNearDuplicate(candidateArtifactSignature, recentArtifactSignatures, { threshold: 0.74 })
    ) {
      continue;
    }

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
    bundleUsedFallback = true;
    const safeTitle = plan.title;
    const scopeLines = plan.scope.map((item) => `- ${item}`);
    const fallbackArtifact = createFallbackArtifact(plan);
    const usagePlan =
      (Array.isArray(fallbackArtifact.usageSteps) ? fallbackArtifact.usageSteps : [])
        .map((step) => String(step || "").trim())
        .filter(Boolean)
        .slice(0, 6);
    const fallbackPublishSummary = (() => {
      const raw = String(plan.publishSummary || "").trim();
      const padded =
        raw.length >= 80
          ? raw
          : `${raw || safeTitle} This package focuses on clear execution, reuse, and measurable outcomes for Kozmos builders.`;
      return padded.slice(0, 340);
    })();
    const fallbackBundle = {
      readme: [
        `# ${safeTitle} README`,
        "",
        "## Purpose",
        `This package ships **${safeTitle}** as an interactive Kozmos app for a globally recurring user problem, with practical execution in one build session.`,
        "",
        "## Problem Statement",
        plan.problem,
        "",
        "## Global Relevance",
        plan.globalRelevance || "Global relevance documented in the plan and reflected in runtime behavior.",
        "",
        "## User Archetype",
        plan.userArchetype || plan.userType || "general Kozmos users",
        "",
        "## Outcome Goal",
        plan.goal,
        "",
        "## Differentiation",
        plan.differentiation ||
          "Differentiated by Kozmos presence-first interaction model and adaptive runtime behavior.",
        "",
        "## AI-Native Design",
        plan.aiNativeDesign || "AI assists moderation, synthesis, and adaptive decision logic.",
        "",
        "## Scope",
        ...scopeLines,
        "",
        "## Expansion Pathway",
        plan.expansionPathway || "Extend from single app session to a reusable ecosystem module.",
        "",
        "## How To Use",
        ...usagePlan.map((step, index) => `${index + 1}. ${step}`),
        "",
        "## Rollout Notes",
        "Run as draft, validate one live scenario, then publish. Keep unresolved constraints explicit so future builders can continue without context loss.",
      ].join("\n"),
      spec: [
        `# ${safeTitle} SPEC`,
        "",
        "## System Intent",
        "The module must stay understandable without prior session context while delivering a clear input-to-output path and preserving space-level isolation.",
        "",
        "## Strategic Anchors",
        `- Problem category: ${plan.problemCategory || "general"}`,
        `- User archetype: ${plan.userArchetype || plan.userType || "general users"}`,
        `- Global problem: ${plan.globalProblem || plan.problem}`,
        `- Surface functionality: ${plan.surfaceFunctionality || "interactive app surface"}`,
        `- System layer: ${plan.systemLayer || "adaptive runtime system"}`,
        `- Expansion pathway: ${plan.expansionPathway || "platform extension path"}`,
        "",
        "## Functional Scope",
        ...plan.scope.map((item, index) => `${index + 1}. ${item}.`),
        "",
        "## Constraints",
        "- Must fit single-session delivery with explicit unfinished markers if needed.",
        "- Must stay practical for active Kozmos users, not demos only.",
        "- Must avoid repeating previously published mission concept keys.",
        "- Must not require privileged access beyond normal builder permissions.",
        "",
        "## Data and Control Flow",
        "1. Capture user intent and convert into structured scenario state.",
        "2. Process scenario state through system-layer logic and adaptive decision paths.",
        "3. Render actionable outputs in the interactive surface with explicit rationale.",
        "4. Persist essential state for continuity and publish as deployable, export-ready package.",
        "",
        "## Edge Cases",
        "- Incomplete context: continue with conservative defaults and mark assumptions.",
        "- Conflicting signals: prioritize user safety and noise reduction over output speed.",
        "- Low-confidence recommendations: expose uncertainty and require explicit user confirmation.",
        "",
        "## Acceptance Criteria",
        "- Every scope line has at least one implementation anchor in the artifact.",
        "- Interactive artifact exposes surface/system/expansion layers clearly.",
        "- Final package is export-ready and adaptable in another subspace immediately.",
      ].join("\n"),
      implementation: [
        `# ${safeTitle} IMPLEMENTATION`,
        "",
        "## Build Sequence",
        "1. Generate a distinct interactive architecture aligned to the mission category.",
        "2. Implement surface interactions and bind them to system-layer state transitions.",
        "3. Add AI-native adaptive logic with clear user override controls.",
        "4. Validate uniqueness against recent artifacts and hard quality gates.",
        "5. Publish package with full contract + export manifest.",
        "",
        "## Engineering Notes",
        "- Avoid template skeleton reuse across sessions.",
        "- Keep mission naming semantically clear and product-specific.",
        "- Expose extension points that let the next builder scale the system layer safely.",
        "",
        "## Maintainability Plan",
        "- Preserve key runtime contracts in API-CONTRACT and EXPORT-MANIFEST.",
        "- Keep scenario state schema explicit for backward-compatible evolution.",
        "- Track rejected alternatives with rationale for future mission planning.",
        "",
        "## Validation",
        "- Strategic depth: surface/system/expansion layers are all present and coherent.",
        "- AI-native quality: adaptive logic is real and user-visible, not placeholder text.",
        "- Uniqueness: title, problem category, and artifact interaction loop are materially new.",
        "",
        "## Publish Readiness Checklist",
        "- README includes global relevance + differentiation + AI-native rationale.",
        "- SPEC includes strategic anchors and concrete acceptance criteria.",
        "- IMPLEMENTATION includes architecture sequence and validation outcomes.",
        "- Artifact is runnable and export-ready with explicit entry path.",
      ].join("\n"),
      apiContract: [
        `# ${safeTitle} API Contract`,
        "",
        "## Runtime Base",
        "- All calls are authenticated with current Kozmos session token.",
        "- Space scoping is mandatory via `spaceId`.",
        "",
        "## Starter Mode",
        "- `GET /api/build/runtime/starter/mode?spaceId=<id>`",
        "- `PUT /api/build/runtime/starter/mode` body: `{ spaceId, enabled, postsQuota?, commentsQuota?, likesQuota?, dmThreadsQuota?, dmMessagesQuota? }`",
        "",
        "## Starter Auth (Subspace-local)",
        "- `POST /api/build/runtime/starter/auth` action register body: `{ action:'register', spaceId, username, password, displayName?, profile? }`",
        "- `POST /api/build/runtime/starter/auth` action login body: `{ action:'login', spaceId, username, password }`",
        "- `GET /api/build/runtime/starter/auth?spaceId=<id>` + header `x-kozmos-starter-token`",
        "- `POST /api/build/runtime/starter/auth` action logout body: `{ action:'logout', spaceId }` + header `x-kozmos-starter-token`",
        "",
        "## Starter Friends",
        "- `GET /api/build/runtime/starter/friends?spaceId=<id>`",
        "- `POST /api/build/runtime/starter/friends` body: `{ spaceId, toUsername }`",
        "- `PATCH /api/build/runtime/starter/friends` body: `{ spaceId, requestId, action:'accept|decline|block' }`",
        "- `DELETE /api/build/runtime/starter/friends` body: `{ spaceId, friendUserId }`",
        "",
        "## Posts",
        "- `GET /api/build/runtime/starter/posts?spaceId=<id>&limit=<n>&beforeId=<id>`",
        "- `POST /api/build/runtime/starter/posts` body: `{ spaceId, body, meta? }`",
        "",
        "## Comments",
        "- `GET /api/build/runtime/starter/comments?spaceId=<id>&postId=<id>&limit=<n>`",
        "- `POST /api/build/runtime/starter/comments` body: `{ spaceId, postId, body, meta? }`",
        "",
        "## Likes",
        "- `GET /api/build/runtime/starter/likes?spaceId=<id>&postId=<id>`",
        "- `PUT /api/build/runtime/starter/likes` body: `{ spaceId, postId }`",
        "- `DELETE /api/build/runtime/starter/likes` body: `{ spaceId, postId }`",
        "",
        "## DM",
        "- `GET /api/build/runtime/starter/dm/threads?spaceId=<id>&limit=<n>`",
        "- `POST /api/build/runtime/starter/dm/threads` body: `{ spaceId, subject?, participantUserIds?, metadata? }`",
        "- `GET /api/build/runtime/starter/dm/messages?spaceId=<id>&threadId=<id>&limit=<n>&afterId=<id>`",
        "- `POST /api/build/runtime/starter/dm/messages` body: `{ spaceId, threadId, body, metadata? }`",
        "",
        "## Errors",
        "- `409` starter mode disabled",
        "- `429` starter rate limit or quota exceeded",
        "- `403` forbidden for this space/thread",
      ].join("\n"),
      exportManifest: JSON.stringify(
        {
          version: 1,
          title: safeTitle,
          entry: "index.html",
          files: [
            "README.md",
            "SPEC.md",
            "IMPLEMENTATION.md",
            "API-CONTRACT.md",
            "EXPORT-MANIFEST.json",
            "index.html",
          ],
          runtime: {
            contract: "kozmos.room.runtime.v1",
            hooks: {
              onEnter: "app.onEnter",
              onLeave: "app.onLeave",
              onTick: "app.onTick",
              onMessage: "app.onMessage",
            },
            starterEndpoints: {
              auth: "/api/build/runtime/starter/auth",
              friends: "/api/build/runtime/starter/friends",
              mode: "/api/build/runtime/starter/mode",
              posts: "/api/build/runtime/starter/posts",
              comments: "/api/build/runtime/starter/comments",
              likes: "/api/build/runtime/starter/likes",
              dmThreads: "/api/build/runtime/starter/dm/threads",
              dmMessages: "/api/build/runtime/starter/dm/messages",
            },
          },
          export: {
            format: "zip",
            endpoint: "/api/build/export/zip?spaceId=<SPACE_ID>",
          },
        },
        null,
        2
      ),
      artifactPath: "index.html",
      artifactLanguage: "html",
      artifactContent: String(fallbackArtifact.artifactContent || "").trim(),
      publishSummary: fallbackPublishSummary,
      usageSteps: usagePlan,
    };
    const fallbackQuality = scoreMissionBundleQuality(fallbackBundle);
    if (!fallbackQuality.ok) {
      const issueText = (fallbackQuality.issues || []).join(", ") || "unknown";
      throw new Error(`mission build package generation failed (quality gate: ${issueText})`);
    }
    bundle = fallbackBundle;
    bundleQuality = fallbackQuality;
  }

  await setState("mission_review", {
    topic: plan.title,
    qualityScore: bundleQuality?.qualityScore || 0,
    outputPath: "",
  });

  const historySpaceId = targetSpaceId;
  let publishSpaceId = targetSpaceId;
  try {
    const missionSpaceTitle = String(plan.title || "Axy Mission Build").trim().slice(0, 96);
    const missionSpaceDescription = [
      `Axy mission output (${normalizeMissionBuildClass(plan.buildClass || "utility")})`,
      plan.problemCategory ? `Category: ${plan.problemCategory}` : "",
      `Builder: ${botUsername}`,
      String(plan.goal || "").trim(),
    ]
      .filter(Boolean)
      .join(" | ")
      .slice(0, 260);
    const createMissionSpaceRes = await callAxyOps(baseUrl, token, "build.spaces.create", {
      title: missionSpaceTitle,
      buildClass: normalizeMissionBuildClass(plan.buildClass || "utility"),
      languagePref: "auto",
      description: missionSpaceDescription,
    });
    const createdSpaceId = String(createMissionSpaceRes?.data?.id || "").trim();
    if (createdSpaceId) {
      publishSpaceId = createdSpaceId;
    }
  } catch (createMissionSpaceErr) {
    const createMissionSpaceMsg =
      createMissionSpaceErr?.body?.error ||
      createMissionSpaceErr?.message ||
      "mission output subspace create failed";
    console.log(`[${now()}] mission subspace warn: ${createMissionSpaceMsg}`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const basePath = `${MISSION_ROOT_PATH}/${stamp}-${slugify(plan.title)}`;
  const artifactPath = `${basePath}/${normalizeBuildPath(bundle.artifactPath)}`;
  const readmeContent = `# ${plan.title}\n\n${bundle.readme}`.trim();
  const specContent = `# ${plan.title} - Spec\n\n${bundle.spec}`.trim();
  const implementationContent = `# ${plan.title} - Implementation\n\n${bundle.implementation}`.trim();
  const apiContractContent = `# ${plan.title} - API Contract\n\n${String(bundle.apiContract || "").trim()}`.trim();
  const exportManifestContent = String(bundle.exportManifest || "").trim();
  const artifactContent = bundle.artifactContent;
  const latestSummary = String(bundle.publishSummary || plan.publishSummary).trim();
  const usageSteps = (Array.isArray(bundle.usageSteps) ? bundle.usageSteps : [])
    .map((step) => String(step || "").trim())
    .filter(Boolean)
    .slice(0, 6);
  const artifactSignature = computeArtifactSignature(artifactContent);

  const byExtLanguage = (() => {
    const ext = path.extname(artifactPath).toLowerCase();
    if (ext === ".ts" || ext === ".tsx") return "typescript";
    if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return "javascript";
    if (ext === ".sql") return "sql";
    if (ext === ".css") return "css";
    if (ext === ".html" || ext === ".htm") return "html";
    if (ext === ".json") return "json";
    if (ext === ".md") return "markdown";
    return bundle.artifactLanguage || "text";
  })();

  await callAxyOps(baseUrl, token, "build.files.save", {
    spaceId: publishSpaceId,
    path: `${basePath}/README.md`,
    language: "markdown",
    content: readmeContent,
  });
  await callAxyOps(baseUrl, token, "build.files.save", {
    spaceId: publishSpaceId,
    path: `${basePath}/SPEC.md`,
    language: "markdown",
    content: specContent,
  });
  await callAxyOps(baseUrl, token, "build.files.save", {
    spaceId: publishSpaceId,
    path: `${basePath}/IMPLEMENTATION.md`,
    language: "markdown",
    content: implementationContent,
  });
  await callAxyOps(baseUrl, token, "build.files.save", {
    spaceId: publishSpaceId,
    path: `${basePath}/API-CONTRACT.md`,
    language: "markdown",
    content: apiContractContent,
  });
  await callAxyOps(baseUrl, token, "build.files.save", {
    spaceId: publishSpaceId,
    path: `${basePath}/EXPORT-MANIFEST.json`,
    language: "json",
    content: exportManifestContent,
  });
  await callAxyOps(baseUrl, token, "build.files.save", {
    spaceId: publishSpaceId,
    path: artifactPath,
    language: byExtLanguage,
    content: artifactContent,
  });
  await callAxyOps(baseUrl, token, "build.files.save", {
    spaceId: publishSpaceId,
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
      `- ${basePath}/API-CONTRACT.md`,
      `- ${basePath}/EXPORT-MANIFEST.json`,
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
      build_class: normalizeMissionBuildClass(plan.buildClass || "utility"),
      problem_category_key: normalizeConceptKey(plan.problemCategory || plan.problemSpaceKey || ""),
      problem_space_key: normalizeConceptKey(plan.problemSpaceKey || ""),
      user_type_key: normalizeConceptKey(plan.userTypeKey || plan.userType || ""),
      interaction_key: normalizeConceptKey(plan.interactionKey || ""),
      artifact_signature: artifactSignature,
      path: basePath,
      created_at: new Date().toISOString(),
    },
    ...usedHistory,
  ].slice(0, missionHistoryLimit);

  await callAxyOps(baseUrl, token, "build.files.save", {
    spaceId: historySpaceId,
    path: MISSION_HISTORY_PATH,
    language: "json",
    content: JSON.stringify(updatedHistory, null, 2),
  });

  const latestFile = [
    "# Latest Axy Published Build",
    "",
    `Title: ${plan.title}`,
    `Class: ${normalizeMissionBuildClass(plan.buildClass || "utility")}`,
    `Path: ${basePath}/README.md`,
    `Published: ${new Date().toISOString()}`,
    `Quality score: ${bundleQuality?.qualityScore || 0}`,
    `Fallback used: ${planUsedFallback || bundleUsedFallback ? "yes" : "no"}`,
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
    spaceId: historySpaceId,
    path: MISSION_LATEST_PATH,
    language: "markdown",
    content: latestFile,
  });

  // Ensure published mission output is discoverable in user-build lists.
  // If visibility update fails, mission should still succeed.
  try {
    await callAxyOps(baseUrl, token, "build.spaces.update", {
      spaceId: publishSpaceId,
      isPublic: true,
    });
  } catch (visibilityErr) {
    const visibilityMsg =
      visibilityErr?.body?.error || visibilityErr?.message || "space visibility update failed";
    console.log(`[${now()}] mission visibility warn: ${visibilityMsg}`);
  }

  await setState("mission_publish", {
    topic: plan.title,
    outputPath: `${basePath}/README.md`,
    qualityScore: bundleQuality?.qualityScore || 0,
    published: true,
    publishedAt: new Date().toISOString(),
  });
  await pushBuildNote("report", [
    `title: ${plan.title}`,
    `space: ${publishSpaceId}`,
    `path: ${basePath}/README.md`,
    `api_contract: ${basePath}/API-CONTRACT.md`,
    `export_manifest: ${basePath}/EXPORT-MANIFEST.json`,
    `artifact: ${artifactPath}`,
    `quality_score: ${bundleQuality?.qualityScore || 0}`,
    `fallback_used: ${planUsedFallback || bundleUsedFallback ? "yes" : "no"}`,
    `fallback_reason: ${planUsedFallback || bundleUsedFallback ? "planner/bundle quality gate fallback" : "-"}`,
    `usage: ${(usageSteps || []).join(" | ") || "open README and follow steps"}`,
  ]);

  const publishMessage = `Axy published: ${plan.title} • value: ${latestSummary} • path: ${basePath}/README.md • use: open README then follow steps.`;
  return {
    ok: true,
    targetSpaceId: historySpaceId,
    publishedSpaceId: publishSpaceId,
    title: plan.title,
    buildClass: normalizeMissionBuildClass(plan.buildClass || "utility"),
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

  const restInit = { ...init };
  delete restInit.signal;
  delete restInit.__allowDuringAbort;
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
  // Hard policy: build/mission outputs are confined to build chat only.
  const missionPublishToShared = false;
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
  const missionNotesToBuildChat = toBool(
    args["mission-notes-to-build-chat"] ??
      process.env.KOZMOS_MISSION_NOTES_TO_BUILD_CHAT,
    true
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
  let missionLastBuildClass = "";
  let missionPublishedAt = "";
  let missionRestored = false;
  let missionTargetSpaceId = String(buildSpaceId || "").trim();
  let lastMissionError = "";
  const missionNoteSentKeys = new Set();
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
      missionNotesToBuildChat,
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
        missionNoteSentKeys.clear();
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

      const restoredSessionId = String(row.session_id || missionSessionId);
      if (restoredSessionId !== missionSessionId) {
        missionNoteSentKeys.clear();
      }
      missionSessionId = restoredSessionId;
      missionState = String(row.status || missionState || "mission_planning");
      missionTopic = String(row.topic || "");
      missionOutputPath = String(row.output_path || "");
      missionQualityScore = Number(row.quality_score || 0);
      missionPublishedAt = String(row.published_at || "");
      missionAttemptCount = Math.max(missionAttemptCount, Number(row.attempt_count || 0));
      missionCompleted = false;
      if (missionTopic || missionAttemptCount > 0) {
        missionNoteSentKeys.add(`${missionSessionId}:plan`);
      }
      if (missionState === "mission_review" || missionState === "mission_publish") {
        missionNoteSentKeys.add(`${missionSessionId}:review`);
      }
      if (Boolean(row.published) || missionState === "mission_publish" || missionState === "freedom") {
        missionNoteSentKeys.add(`${missionSessionId}:report`);
      }
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
  console.log(`[${now()}] base-url=${baseUrl}`);
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
      `[${now()}] mission-first=${sessionBuildFirst} publish=${missionPublishToShared} buildChatNotes=${missionNotesToBuildChat} retry=${missionRetryMinSeconds}-${missionRetryMaxSeconds}s attempts(idea=${missionMaxIdeaAttempts},bundle=${missionMaxBundleAttempts}) noRepeatDays=${missionNoRepeatDays}`
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

        if (missionRequired && !missionCompleted && Date.now() >= nextMissionAttemptAt) {
          runtimeCore.transition("build", "mission-running");
          missionAttemptCount += 1;
          try {
            const missionRes = await runSessionBuildMission({
              baseUrl,
              token,
              botUsername,
              actorUserId: String(user?.id || "").trim(),
              buildSpaceId: missionTargetSpaceId || buildSpaceId,
              missionSessionId,
              missionMaxIdeaAttempts,
              missionMaxBundleAttempts,
              missionHistoryLimit,
              missionNoRepeatDays,
              missionNotesToBuildChat,
              missionNoteSentKeys,
              missionContext: {
                sharedTurns: sharedRecentTurns,
                notes: snapshot?.data?.notes || [],
                buildSpaces: snapshot?.data?.build_spaces || [],
                buildChat: snapshot?.data?.build_chat || [],
              },
              previousMissionBuildClass: missionLastBuildClass,
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
            const missionPublishedSpaceId = String(
              missionRes.publishedSpaceId || missionTargetSpaceId || ""
            ).trim();
            missionLastBuildClass = normalizeMissionBuildClass(
              missionRes.buildClass || missionLastBuildClass || "utility"
            );
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
              `[${now()}] mission build published title="${missionRes.title}" space=${missionPublishedSpaceId}`
            );
            if (missionPublishToShared && missionRes.publishMessage) {
              // Intentionally disabled by policy (build chat only).
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
                const title = "Axy Lab Sandbox";
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
                ? `starfall single clear - score ${score} - round ${round} - rating ${Math.round(
                    rating
                  )}`
                : `starfall single run - score ${score} - round ${round} - rating ${Math.round(
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
                quiteSwarmVisible = true;
                runtimeCore.markSent("swarm", { conversationId: "quite-swarm-room" });
                console.log(`[${now()}] quite-swarm room started`);
              }
            } else if (isHost && Math.random() < quiteSwarmRoomStopChance) {
              await callAxyOps(baseUrl, token, "quite_swarm.room_stop");
              quiteSwarmRoomStatus = "idle";
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

