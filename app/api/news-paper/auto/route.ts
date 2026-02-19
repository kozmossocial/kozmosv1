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
  query: string;
};

const TOPIC_FEEDS: TopicFeedConfig[] = [
  { topic: "science", query: "science news" },
  { topic: "space", query: "space exploration news" },
  { topic: "technology", query: "technology news" },
  { topic: "cinema_movies", query: "cinema movies news" },
  { topic: "music", query: "music industry news" },
  { topic: "gaming", query: "gaming news" },
  { topic: "global_wars", query: "global wars conflict news" },
];

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

function parseFirstRssItem(xml: string) {
  const itemMatch = xml.match(/<item>([\s\S]*?)<\/item>/i);
  if (!itemMatch) {
    return null;
  }
  const block = String(itemMatch[1] || "");
  const titleRaw = extractTag(block, "title");
  const link = extractTag(block, "link");
  const descriptionRaw = stripHtml(extractTag(block, "description"));
  const pubDate = extractTag(block, "pubDate");
  const splitIndex = titleRaw.lastIndexOf(" - ");
  const title =
    splitIndex > 0 ? titleRaw.slice(0, splitIndex).trim() : titleRaw.trim();
  const sourceName =
    splitIndex > 0 ? titleRaw.slice(splitIndex + 3).trim() : "source";
  return {
    title,
    sourceName,
    sourceUrl: link.trim(),
    description: descriptionRaw.trim(),
    publishedAt: pubDate ? new Date(pubDate).toISOString() : null,
  };
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

async function fetchTopicHeadline(topicConfig: TopicFeedConfig) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(
    topicConfig.query
  )}&hl=en-US&gl=US&ceid=US:en`;
  const res = await fetch(url, {
    cache: "no-store",
    headers: {
      "user-agent": "kozmos-news-paper/1.0",
    },
  });
  if (!res.ok) {
    throw new Error("rss load failed");
  }
  const xml = await res.text();
  const item = parseFirstRssItem(xml);
  if (!item || !item.title || !item.sourceUrl) {
    throw new Error("rss parse failed");
  }
  return item;
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
  if (currentCount >= 10) {
    const latestCreatedAt = String(
      (latestRows?.[0] as { created_at?: string | null } | undefined)
        ?.created_at || ""
    );
    const latestMs = Date.parse(latestCreatedAt);
    if (Number.isFinite(latestMs)) {
      const elapsedMs = Date.now() - latestMs;
      if (elapsedMs < 24 * 60 * 60 * 1000) {
        return { ok: true, skipped: "waiting_24h_at_capacity" as const };
      }
    }
  }

  const dayIndex = Math.floor(Date.now() / 86_400_000);
  const openai = getOpenAIClient();

  for (let offset = 0; offset < TOPIC_FEEDS.length; offset += 1) {
    const topicConfig = TOPIC_FEEDS[(dayIndex + offset) % TOPIC_FEEDS.length];
    try {
      const headline = await fetchTopicHeadline(topicConfig);
      const summary = await summarizeWithAxy(openai, {
        topic: topicConfig.topic,
        title: headline.title,
        description: headline.description,
      });

      const { data: existingRow } = await supabaseAdmin
        .from("news_paper_items")
        .select("id")
        .eq("source_url", headline.sourceUrl)
        .maybeSingle();

      if (existingRow) {
        continue;
      }

      const { error: insertErr } = await supabaseAdmin
        .from("news_paper_items")
        .insert({
          topic: topicConfig.topic,
          title: headline.title,
          summary: summary || headline.title,
          source_name: headline.sourceName || "source",
          source_url: headline.sourceUrl,
          published_at: headline.publishedAt,
          created_by: "axy-auto",
        });

      if (insertErr) {
        continue;
      }

      await trimNewsPaperToTen();
      return {
        ok: true,
        topic: topicConfig.topic,
        title: headline.title,
      };
    } catch {
      continue;
    }
  }

  return { ok: false, error: "all topic fetches failed" as const };
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
