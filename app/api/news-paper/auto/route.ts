import { NextResponse } from "next/server";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

let openaiClient: OpenAI | null = null;

type NewsPaperTopic =
  | "science"
  | "space"
  | "technology"
  | "cinema_movies"
  | "music"
  | "gaming"
  | "global_wars";

type TopicFeedConfig = {
  topic: NewsPaperTopic;
  queries: string[];
};
type NewsInsertCandidate = {
  topic: NewsPaperTopic;
  title: string;
  summary: string;
  sourceName: string;
  sourceUrl: string;
  publishedAt: string | null;
};

const TOPIC_FEEDS: TopicFeedConfig[] = [
  {
    topic: "science",
    queries: [
      "science news",
      "research breakthrough news",
      "peer reviewed study news",
      "biology physics chemistry discovery",
    ],
  },
  {
    topic: "space",
    queries: [
      "space exploration news",
      "astronomy mission news",
      "nasa esa mission update",
      "satellite deep space probe update",
    ],
  },
  {
    topic: "technology",
    queries: [
      "technology news",
      "ai hardware software news",
      "semiconductor cloud cybersecurity",
      "open source software platform release",
    ],
  },
  {
    topic: "cinema_movies",
    queries: [
      "cinema movies news",
      "film industry news",
      "box office production update",
      "movie festival release update",
    ],
  },
  {
    topic: "music",
    queries: [
      "music industry news",
      "music release tour news",
      "record label streaming update",
      "album chart and concert news",
    ],
  },
  {
    topic: "gaming",
    queries: [
      "gaming news",
      "video game industry news",
      "game studio release update",
      "esports platform publisher news",
    ],
  },
  {
    topic: "global_wars",
    queries: [
      "global wars conflict news",
      "international conflict updates",
      "geopolitical military frontline update",
      "ceasefire sanctions battlefield report",
    ],
  },
];
const NEWS_AUTO_INTERVAL_MS = 6 * 60 * 60 * 1000;
const NEWS_AUTO_BATCH_SIZE = 2;
const NEWS_DUPLICATE_SCAN_LIMIT = 400;
const RSS_ITEMS_PER_QUERY = 14;
const HEADLINE_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "into",
  "over",
  "after",
  "about",
  "amid",
  "near",
  "new",
  "more",
  "says",
  "say",
  "will",
  "are",
  "was",
  "were",
  "has",
  "have",
  "had",
  "its",
  "their",
  "than",
  "while",
  "what",
  "when",
  "where",
  "which",
  "how",
]);

function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

function extractBearerToken(req: Request) {
  const header =
    req.headers.get("authorization") || req.headers.get("Authorization");
  if (!header) return "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? String(match[1] || "").trim() : "";
}

async function authenticateUser(req: Request) {
  const token = extractBearerToken(req);
  if (!token) return null;

  const authClient = createClient(supabaseUrl, supabaseAnonKey);
  const {
    data: { user },
  } = await authClient.auth.getUser(token);

  return user ?? null;
}

function decodeXmlEntities(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function stripHtml(value: string) {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function extractTag(block: string, tag: string) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = block.match(re);
  if (!match) return "";
  const raw = String(match[1] || "")
    .replace(/^<!\[CDATA\[/, "")
    .replace(/\]\]>$/, "")
    .trim();
  return decodeXmlEntities(raw);
}

function parseRssItems(xml: string, maxItems = RSS_ITEMS_PER_QUERY) {
  const blocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
  const parsed: Array<{
    title: string;
    sourceName: string;
    sourceUrl: string;
    description: string;
    publishedAt: string | null;
  }> = [];
  for (const match of blocks) {
    const block = String(match[1] || "");
    const titleRaw = extractTag(block, "title");
    const link = extractTag(block, "link").trim();
    if (!titleRaw || !link) continue;
    const descriptionRaw = stripHtml(extractTag(block, "description"));
    const pubDate = extractTag(block, "pubDate");
    const splitIndex = titleRaw.lastIndexOf(" - ");
    const title =
      splitIndex > 0 ? titleRaw.slice(0, splitIndex).trim() : titleRaw.trim();
    const sourceName =
      splitIndex > 0 ? titleRaw.slice(splitIndex + 3).trim() : "source";
    parsed.push({
      title,
      sourceName,
      sourceUrl: link,
      description: descriptionRaw.trim(),
      publishedAt: pubDate ? new Date(pubDate).toISOString() : null,
    });
    if (parsed.length >= maxItems) break;
  }
  return parsed;
}

function normalizeSummary(value: string) {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 260);
}

async function summarizeWithAxy(
  openai: OpenAI | null,
  payload: {
    topic: NewsPaperTopic;
    title: string;
    description: string;
  }
) {
  const fallback = normalizeSummary(payload.description || payload.title);
  if (!openai) return fallback;
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are Axy. Summarize the news in English only, 1-2 short calm sentences, neutral and factual. No hype.",
        },
        {
          role: "user",
          content: `Topic: ${payload.topic}\nTitle: ${payload.title}\nDescription: ${payload.description}`,
        },
      ],
      max_tokens: 120,
      temperature: 0.25,
    });
    const text = String(completion.choices[0]?.message?.content || "").trim();
    return normalizeSummary(text || fallback);
  } catch {
    return fallback;
  }
}

function normalizeHeadline(value: string) {
  return value
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSourceUrl(value: string) {
  const raw = value.trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const pathname = url.pathname.replace(/\/+$/, "");

    if (host === "news.google.com") {
      const wrapped = url.searchParams.get("url");
      if (wrapped) {
        return normalizeSourceUrl(wrapped);
      }
    }

    return `${host}${pathname}`.toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

function headlineFingerprint(title: string) {
  const tokens = tokenizeHeadline(title)
    .filter((token) => token.length >= 4)
    .slice(0, 12)
    .sort();
  return tokens.join("|");
}

function tokenizeHeadline(value: string) {
  return normalizeHeadline(value)
    .split(" ")
    .map((token) => token.trim())
    .filter(
      (token) =>
        token.length >= 3 &&
        !HEADLINE_STOPWORDS.has(token) &&
        !/^\d+$/.test(token)
    );
}

function titlesLookDuplicate(a: string, b: string) {
  const normA = normalizeHeadline(a);
  const normB = normalizeHeadline(b);
  if (!normA || !normB) return false;
  if (normA === normB) return true;
  const minLen = Math.min(normA.length, normB.length);
  if (minLen >= 28 && (normA.includes(normB) || normB.includes(normA))) {
    return true;
  }
  const tokensA = tokenizeHeadline(normA);
  const tokensB = tokenizeHeadline(normB);
  if (tokensA.length < 4 || tokensB.length < 4) return false;
  const setB = new Set(tokensB);
  let overlap = 0;
  for (const token of tokensA) {
    if (setB.has(token)) overlap += 1;
  }
  const ratio = overlap / Math.max(tokensA.length, tokensB.length);
  if (overlap >= 4 && ratio >= 0.62) return true;
  return overlap >= 3 && ratio >= 0.8;
}

function buildGoogleRssUrl(query: string, edition: "US" | "WORLD") {
  if (edition === "US") {
    return `https://news.google.com/rss/search?q=${encodeURIComponent(
      query
    )}&hl=en-US&gl=US&ceid=US:en`;
  }
  return `https://news.google.com/rss/search?q=${encodeURIComponent(
    query
  )}&hl=en-GB&gl=GB&ceid=GB:en`;
}

function buildBingRssUrl(query: string) {
  return `https://www.bing.com/news/search?q=${encodeURIComponent(
    query
  )}&format=rss`;
}

async function fetchTopicHeadlines(topicConfig: TopicFeedConfig) {
  const allItems: Array<{
    title: string;
    sourceName: string;
    sourceUrl: string;
    description: string;
    publishedAt: string | null;
  }> = [];
  const seenUrls = new Set<string>();

  for (const query of topicConfig.queries) {
    const feedUrls = [
      buildGoogleRssUrl(query, "US"),
      buildGoogleRssUrl(query, "WORLD"),
      buildBingRssUrl(query),
    ];
    for (const url of feedUrls) {
      try {
        const res = await fetch(url, {
          cache: "no-store",
          headers: {
            "user-agent": "kozmos-news-paper/1.0",
          },
        });
        if (!res.ok) continue;
        const xml = await res.text();
        const items = parseRssItems(xml, RSS_ITEMS_PER_QUERY);
        for (const item of items) {
          if (!item.title || !item.sourceUrl) continue;
          const normalizedUrl = normalizeSourceUrl(item.sourceUrl);
          if (!normalizedUrl) continue;
          if (seenUrls.has(normalizedUrl)) continue;
          seenUrls.add(normalizedUrl);
          allItems.push({
            ...item,
            sourceUrl: item.sourceUrl.trim(),
          });
        }
      } catch {
        continue;
      }
    }
  }

  return allItems;
}

async function trimNewsPaperToTen() {
  const { data: overflowRows, error: overflowErr } = await supabaseAdmin
    .from("news_paper_items")
    .select("id")
    .order("created_at", { ascending: false })
    .range(10, 200);
  if (overflowErr || !overflowRows || overflowRows.length === 0) return;
  const ids = overflowRows
    .map((row) => Number((row as { id?: number | null }).id || 0))
    .filter((id) => Number.isFinite(id) && id > 0);
  if (ids.length === 0) return;
  await supabaseAdmin.from("news_paper_items").delete().in("id", ids);
}

async function runDailyAutoInsert() {
  const { data: latestRows } = await supabaseAdmin
    .from("news_paper_items")
    .select("id, created_at")
    .order("created_at", { ascending: false })
    .limit(10);

  const currentCount = Array.isArray(latestRows) ? latestRows.length : 0;
  const latestCreatedAt = String(
    (latestRows?.[0] as { created_at?: string | null } | undefined)?.created_at ||
      ""
  );
  const latestMs = Date.parse(latestCreatedAt);
  if (currentCount >= 10) {
    if (Number.isFinite(latestMs)) {
      const elapsedMs = Date.now() - latestMs;
      if (elapsedMs < NEWS_AUTO_INTERVAL_MS) {
        return {
          ok: true,
          skipped: "waiting_6h_at_capacity" as const,
          nextAutoAt: new Date(latestMs + NEWS_AUTO_INTERVAL_MS).toISOString(),
        };
      }
    }
  }

  const slotIndex = Math.floor(Date.now() / NEWS_AUTO_INTERVAL_MS);
  const openai = getOpenAIClient();
  const targetInsertCount =
    currentCount >= 10 ? NEWS_AUTO_BATCH_SIZE : Math.min(NEWS_AUTO_BATCH_SIZE, 10 - currentCount);
  const candidates: NewsInsertCandidate[] = [];
  const usedTopics = new Set<NewsPaperTopic>();
  const { data: existingRows } = await supabaseAdmin
    .from("news_paper_items")
    .select("title, source_url")
    .order("created_at", { ascending: false })
    .limit(NEWS_DUPLICATE_SCAN_LIMIT);
  const existingUrls = new Set(
    (existingRows || [])
      .map((row) =>
        normalizeSourceUrl(
          String((row as { source_url?: string | null }).source_url || "").trim()
        )
      )
      .filter(Boolean)
  );
  const existingTitles = (existingRows || [])
    .map((row) => String((row as { title?: string | null }).title || "").trim())
    .filter(Boolean);
  const existingFingerprints = new Set(
    existingTitles.map((title) => headlineFingerprint(title)).filter(Boolean)
  );

  for (let offset = 0; offset < TOPIC_FEEDS.length * 2; offset += 1) {
    const topicConfig = TOPIC_FEEDS[(slotIndex + offset) % TOPIC_FEEDS.length];
    if (usedTopics.has(topicConfig.topic)) {
      continue;
    }
    try {
      const headlines = await fetchTopicHeadlines(topicConfig);
      for (const headline of headlines) {
        const normalizedCandidateUrl = normalizeSourceUrl(headline.sourceUrl);
        if (!normalizedCandidateUrl) continue;
        if (existingUrls.has(normalizedCandidateUrl)) continue;
        const fingerprint = headlineFingerprint(headline.title);
        if (fingerprint && existingFingerprints.has(fingerprint)) continue;
        const duplicateWithExisting = existingTitles.some((title) =>
          titlesLookDuplicate(title, headline.title)
        );
        if (duplicateWithExisting) continue;
        const duplicateWithQueued = candidates.some((item) =>
          titlesLookDuplicate(item.title, headline.title)
        );
        if (duplicateWithQueued) continue;

        const summary = await summarizeWithAxy(openai, {
          topic: topicConfig.topic,
          title: headline.title,
          description: headline.description,
        });

        usedTopics.add(topicConfig.topic);
        candidates.push({
          topic: topicConfig.topic,
          title: headline.title,
          summary: summary || headline.title,
          sourceName: headline.sourceName || "source",
          sourceUrl: headline.sourceUrl,
          publishedAt: headline.publishedAt,
        });
        existingUrls.add(normalizedCandidateUrl);
        existingTitles.push(headline.title);
        if (fingerprint) existingFingerprints.add(fingerprint);
        break;
      }
      if (candidates.length >= targetInsertCount) {
        break;
      }
    } catch {
      continue;
    }
  }

  if (candidates.length === 0) {
    return { ok: false, error: "all topic fetches failed" as const };
  }

  const atCapacity = currentCount >= 10;
  if (atCapacity && candidates.length < NEWS_AUTO_BATCH_SIZE) {
    return {
      ok: true,
      skipped: "insufficient_candidates_for_capacity_swap" as const,
      insertedCount: 0,
      nextAutoAt: new Date(Date.now() + NEWS_AUTO_INTERVAL_MS).toISOString(),
      partial: true,
    };
  }

  if (atCapacity) {
    const { data: oldestRows, error: oldestErr } = await supabaseAdmin
      .from("news_paper_items")
      .select("id")
      .order("created_at", { ascending: true })
      .limit(NEWS_AUTO_BATCH_SIZE);
    if (oldestErr) {
      return { ok: false, error: "failed_to_prepare_capacity_swap" as const };
    }
    const oldestIds = (oldestRows || [])
      .map((row) => Number((row as { id?: number | null }).id || 0))
      .filter((id) => Number.isFinite(id) && id > 0);
    if (oldestIds.length === NEWS_AUTO_BATCH_SIZE) {
      const { error: deleteErr } = await supabaseAdmin
        .from("news_paper_items")
        .delete()
        .in("id", oldestIds);
      if (deleteErr) {
        return { ok: false, error: "failed_to_delete_oldest_items" as const };
      }
    }
  }

  const rowsToInsert = candidates.slice(0, targetInsertCount).map((item) => ({
    topic: item.topic,
    title: item.title,
    summary: item.summary,
    source_name: item.sourceName,
    source_url: item.sourceUrl,
    published_at: item.publishedAt,
    created_by: "axy-auto",
  }));
  const { error: batchInsertErr } = await supabaseAdmin
    .from("news_paper_items")
    .insert(rowsToInsert);
  if (batchInsertErr) {
    return { ok: false, error: "failed_to_insert_batch" as const };
  }

  if (!atCapacity) {
    await trimNewsPaperToTen();
  }

  const inserted = rowsToInsert.map((row) => ({
    topic: row.topic,
    title: row.title,
  }));
  return {
    ok: true,
    inserted,
    insertedCount: inserted.length,
    nextAutoAt: new Date(Date.now() + NEWS_AUTO_INTERVAL_MS).toISOString(),
    partial: inserted.length < targetInsertCount,
  };
}

export async function POST(req: Request) {
  try {
    const cronSecret = String(
      process.env.NEWS_PAPER_CRON_SECRET || process.env.CRON_SECRET || ""
    ).trim();
    const bearer = extractBearerToken(req);
    const customSecret = String(req.headers.get("x-cron-secret") || "").trim();
    const isCronAuthorized =
      cronSecret.length > 0 &&
      (bearer === cronSecret || customSecret === cronSecret);

    if (!isCronAuthorized) {
      const user = await authenticateUser(req);
      if (!user) {
        return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      }
    }

    const result = await runDailyAutoInsert();
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 502 });
    }
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}

export async function GET(req: Request) {
  return POST(req);
}
