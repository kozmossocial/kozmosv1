import { NextResponse } from "next/server";
import { createClient, type User } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

type SpiceEvent = "game_play" | "news_click";

const SPICE_EVENT_CONFIG: Record<SpiceEvent, { amount: number; eventType: string }> = {
  game_play: { amount: 5, eventType: "game_play" },
  news_click: { amount: 1, eventType: "news_link_click" },
};

function extractBearerToken(req: Request) {
  const header =
    req.headers.get("authorization") || req.headers.get("Authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

async function authenticateUser(req: Request): Promise<User | null> {
  const token = extractBearerToken(req);
  if (!token) return null;

  const authClient = createClient(supabaseUrl, supabaseAnonKey);
  const {
    data: { user },
    error,
  } = await authClient.auth.getUser(token);

  if (error || !user) return null;
  return user;
}

function sanitizeMetadata(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {} as Record<string, unknown>;
  }

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const safeKey = key.trim().slice(0, 40);
    if (!safeKey) continue;

    if (typeof raw === "string") {
      out[safeKey] = raw.slice(0, 240);
      continue;
    }

    if (typeof raw === "number" || typeof raw === "boolean") {
      out[safeKey] = raw;
    }
  }

  return out;
}

function resolveRefKey(
  event: SpiceEvent,
  body: Record<string, unknown>,
  metadata: Record<string, unknown>
) {
  const refKeyRaw =
    typeof body?.refKey === "string" ? body.refKey.trim() : "";
  if (refKeyRaw) {
    return refKeyRaw.slice(0, 180);
  }

  if (event === "news_click") {
    const newsItemId = metadata.newsItemId;
    if (typeof newsItemId === "number" || typeof newsItemId === "string") {
      return `news_click:${String(newsItemId).slice(0, 80)}`;
    }
  }

  if (event === "game_play") {
    const game =
      typeof metadata.game === "string" && metadata.game.trim()
        ? metadata.game.trim().slice(0, 80)
        : "unknown";
    const minuteBucket = Math.floor(Date.now() / 60_000);
    return `game_play:${game}:${minuteBucket}`;
  }

  return null;
}

export async function POST(req: Request) {
  try {
    const user = await authenticateUser(req);
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const event = String(body?.event || "").trim().toLowerCase() as SpiceEvent;
    const config = SPICE_EVENT_CONFIG[event];

    if (!config) {
      return NextResponse.json({ error: "invalid event" }, { status: 400 });
    }

    const metadata = sanitizeMetadata(body?.metadata);
    const refKey = resolveRefKey(event, body, metadata);

    const { data, error } = await supabaseAdmin.rpc("spice_credit", {
      p_user_id: user.id,
      p_amount: config.amount,
      p_event_type: config.eventType,
      p_ref_key: refKey,
      p_metadata: {
        ...metadata,
        source: "api.spice.event",
      },
    });

    if (error) {
      return NextResponse.json(
        { error: `spice event failed: ${error.message}` },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      awarded: Boolean(data),
      amount: config.amount,
      event,
    });
  } catch {
    return NextResponse.json({ error: "spice event failed" }, { status: 500 });
  }
}