import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const WORLD_LIMIT = 13;
const ORB_MIN_RADIUS = 7.8;
const ORB_RING_STEP = 2.1;
const ORB_SLOTS_PER_RING = 12;
const ORB_MIN_DISTANCE = 2.8;

type SpaceRow = {
  id: string;
  owner_id: string;
  title: string;
  build_class: string;
  is_public: boolean;
  description: string;
  updated_at: string;
};

function extractBearerToken(req: Request) {
  const header =
    req.headers.get("authorization") || req.headers.get("Authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
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

function normalizeSpaceTitle(value: unknown) {
  const trimmed = String(value || "").trim();
  return trimmed ? trimmed.slice(0, 64) : "subspace";
}

function normalizeBuildClass(value: unknown) {
  const normalized = String(value || "").trim().toLowerCase();
  const allowed = new Set([
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
  ]);
  return allowed.has(normalized) ? normalized : "utility";
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function hashString(input: string) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function distance(a: { x: number; z: number }, b: { x: number; z: number }) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function placeSpaceOrb(
  ownerId: string,
  spaceId: string,
  index: number,
  used: Array<{ x: number; z: number }>
) {
  const ring = Math.floor(index / ORB_SLOTS_PER_RING);
  const slot = index % ORB_SLOTS_PER_RING;
  const seed = hashString(`${ownerId}:${spaceId}`);
  const phase = ((seed % 3600) / 3600) * Math.PI * 2;
  const jitter = (((Math.floor(seed / 3600) % 100) - 50) / 100) * 0.42;
  let bestCandidate: { x: number; z: number } | null = null;
  let bestSeparation = -1;

  for (let ringOffset = 0; ringOffset < 6; ringOffset += 1) {
    const radius = clamp(
      ORB_MIN_RADIUS + (ring + ringOffset) * ORB_RING_STEP + jitter,
      ORB_MIN_RADIUS,
      WORLD_LIMIT - 0.4
    );
    const slots = ORB_SLOTS_PER_RING + ringOffset * 2;
    const slotAngleStep = (Math.PI * 2) / slots;
    const start = (slot + ringOffset * 3) % slots;

    for (let attempt = 0; attempt < slots; attempt += 1) {
      const angle = phase + (start + attempt) * slotAngleStep;
      const x = clamp(Number((Math.cos(angle) * radius).toFixed(2)), -WORLD_LIMIT, WORLD_LIMIT);
      const z = clamp(Number((Math.sin(angle) * radius).toFixed(2)), -WORLD_LIMIT, WORLD_LIMIT);
      const candidate = { x, z };
      const minSeparation =
        used.length === 0
          ? Number.POSITIVE_INFINITY
          : used.reduce(
              (smallest, other) => Math.min(smallest, distance(candidate, other)),
              Number.POSITIVE_INFINITY
            );
      if (minSeparation > bestSeparation) {
        bestSeparation = minSeparation;
        bestCandidate = candidate;
      }
      if (minSeparation >= ORB_MIN_DISTANCE) {
        used.push(candidate);
        return candidate;
      }
    }
  }

  const fallback =
    bestCandidate ||
    ({
      x: clamp(Number((Math.cos(phase) * ORB_MIN_RADIUS).toFixed(2)), -WORLD_LIMIT, WORLD_LIMIT),
      z: clamp(Number((Math.sin(phase) * ORB_MIN_RADIUS).toFixed(2)), -WORLD_LIMIT, WORLD_LIMIT),
    } as { x: number; z: number });
  used.push(fallback);
  return fallback;
}

export async function GET(req: Request) {
  try {
    const user = await authenticateUser(req);
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const url = new URL(req.url);
    const ownerId = String(url.searchParams.get("ownerId") || "").trim();
    if (!ownerId) {
      return NextResponse.json({ error: "ownerId required" }, { status: 400 });
    }

    const isSelfHome = ownerId === user.id;

    let query = supabaseAdmin
      .from("user_build_spaces")
      .select("id, owner_id, title, build_class, is_public, description, updated_at")
      .eq("owner_id", ownerId)
      .order("updated_at", { ascending: false })
      .limit(500);

    if (!isSelfHome) {
      query = query.eq("is_public", true);
    }

    const { data: spaces, error: spacesErr } = await query;
    if (spacesErr) {
      return NextResponse.json({ error: "home spaces load failed" }, { status: 500 });
    }

    const { data: ownerProfile, error: ownerErr } = await supabaseAdmin
      .from("profileskozmos")
      .select("id, username")
      .eq("id", ownerId)
      .maybeSingle();

    if (ownerErr) {
      return NextResponse.json({ error: "home owner load failed" }, { status: 500 });
    }

    const ownerUsername = String(ownerProfile?.username || "user").trim() || "user";
    const usedPositions: Array<{ x: number; z: number }> = [];
    const rows = ((spaces || []) as SpaceRow[]).map((space, index) => {
      const position = placeSpaceOrb(ownerId, String(space.id || ""), index, usedPositions);
      return {
        id: space.id,
        ownerId: space.owner_id,
        title: normalizeSpaceTitle(space.title),
        buildClass: normalizeBuildClass(space.build_class),
        isPublic: space.is_public === true,
        description: String(space.description || "").trim().slice(0, 220),
        updatedAt: String(space.updated_at || ""),
        canEdit: isSelfHome,
        x: position.x,
        z: position.z,
      };
    });

    return NextResponse.json({
      owner: {
        id: ownerId,
        username: ownerUsername,
        isSelf: isSelfHome,
      },
      spaces: rows,
    });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}
