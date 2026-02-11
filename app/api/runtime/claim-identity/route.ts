import { NextResponse } from "next/server";
import { createHash, randomBytes, randomUUID } from "crypto";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const bootstrapKey = process.env.RUNTIME_BOOTSTRAP_KEY;

function hashToken(raw: string) {
  return createHash("sha256").update(raw).digest("hex");
}

function normalizeUsername(input: string) {
  return input.trim().toLowerCase();
}

function isValidUsername(input: string) {
  return /^[a-z0-9._-]{3,24}$/.test(input);
}

function buildCandidateBase(input: string) {
  const normalized = normalizeUsername(input).replace(/[^a-z0-9._-]/g, "");
  if (normalized.length >= 3) return normalized.slice(0, 24);
  return `user_${randomBytes(2).toString("hex")}`;
}

async function findAvailableUsername(base: string) {
  const { data: rows } = await supabaseAdmin
    .from("profileskozmos")
    .select("username")
    .ilike("username", `${base}%`)
    .limit(200);

  const used = new Set((rows || []).map((r) => String(r.username).toLowerCase()));
  if (!used.has(base)) return base;

  for (let i = 2; i < 5000; i += 1) {
    const candidate = `${base}_${i}`.slice(0, 24);
    if (!used.has(candidate.toLowerCase())) return candidate;
  }

  return `${base}_${randomBytes(2).toString("hex")}`.slice(0, 24);
}

export async function POST(req: Request) {
  try {
    if (!bootstrapKey) {
      return NextResponse.json({ error: "bootstrap disabled" }, { status: 503 });
    }

    const headerKey = req.headers.get("x-kozmos-bootstrap-key");
    if (!headerKey || headerKey !== bootstrapKey) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const requested =
      typeof body?.username === "string" ? body.username : "";
    const label = typeof body?.label === "string" ? body.label.slice(0, 60) : "runtime";

    const rawBase = buildCandidateBase(requested || "user");
    const base = isValidUsername(rawBase) ? rawBase : "user";
    const username = await findAvailableUsername(base);

    const userId = randomUUID();
    const { error: profileErr } = await supabaseAdmin.from("profileskozmos").insert({
      id: userId,
      username,
    });

    if (profileErr) {
      return NextResponse.json({ error: "profile create failed" }, { status: 500 });
    }

    const runtimeToken = `kzrt_${randomBytes(24).toString("hex")}`;
    const tokenHash = hashToken(runtimeToken);

    const { error: tokenErr } = await supabaseAdmin.from("runtime_user_tokens").insert({
      user_id: userId,
      token_hash: tokenHash,
      label,
      is_active: true,
      last_used_at: new Date().toISOString(),
    });

    if (tokenErr) {
      await supabaseAdmin.from("profileskozmos").delete().eq("id", userId);
      return NextResponse.json({ error: "token create failed" }, { status: 500 });
    }

    await supabaseAdmin.from("runtime_presence").upsert({
      user_id: userId,
      last_seen_at: new Date().toISOString(),
    });

    return NextResponse.json({
      user: { id: userId, username },
      token: runtimeToken,
      note: "Store token now. It will not be shown again.",
    });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}

