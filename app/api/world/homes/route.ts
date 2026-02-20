import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const WORLD_LIMIT = 13;
const HOME_MIN_RADIUS = 9.8;
const HOME_RING_STEP = 2.0;
const HOME_SLOTS_PER_RING = 18;

type SpaceRow = {
  owner_id: string;
  is_public: boolean;
  updated_at: string;
};

type ProfileRow = {
  id: string;
  username: string | null;
};

type HomeStat = {
  ownerId: string;
  totalBuilds: number;
  publicBuilds: number;
  updatedAt: string | null;
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

function pickNewestTimestamp(primary: string | null, secondary: string | null) {
  if (!primary) return secondary;
  if (!secondary) return primary;
  const first = Date.parse(primary);
  const second = Date.parse(secondary);
  if (!Number.isFinite(second)) return primary;
  if (!Number.isFinite(first)) return secondary;
  return second > first ? secondary : primary;
}

function normalizeUsername(value: string | null | undefined) {
  const trimmed = String(value || "").trim();
  return trimmed ? trimmed.slice(0, 32) : "user";
}

function distance(a: { x: number; z: number }, b: { x: number; z: number }) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function placeHome(ownerId: string, index: number, used: Array<{ x: number; z: number }>) {
  const ring = Math.floor(index / HOME_SLOTS_PER_RING);
  const slot = index % HOME_SLOTS_PER_RING;
  const seed = hashString(ownerId);
  const phase = ((seed % 3600) / 3600) * Math.PI * 2;
  const jitter = (((Math.floor(seed / 3600) % 100) - 50) / 100) * 0.4;
  const radius = clamp(HOME_MIN_RADIUS + ring * HOME_RING_STEP + jitter, HOME_MIN_RADIUS, WORLD_LIMIT - 0.4);
  const slotAngleStep = (Math.PI * 2) / HOME_SLOTS_PER_RING;
  for (let attempt = 0; attempt < HOME_SLOTS_PER_RING; attempt += 1) {
    const angle = phase + (slot + attempt * 0.75) * slotAngleStep;
    const x = clamp(Number((Math.cos(angle) * radius).toFixed(2)), -WORLD_LIMIT, WORLD_LIMIT);
    const z = clamp(Number((Math.sin(angle) * radius).toFixed(2)), -WORLD_LIMIT, WORLD_LIMIT);
    const candidate = { x, z };
    const collides = used.some((other) => distance(candidate, other) < 2.2);
    if (!collides) {
      used.push(candidate);
      return candidate;
    }
  }
  const fallback = {
    x: clamp(Number((Math.cos(phase) * radius).toFixed(2)), -WORLD_LIMIT, WORLD_LIMIT),
    z: clamp(Number((Math.sin(phase) * radius).toFixed(2)), -WORLD_LIMIT, WORLD_LIMIT),
  };
  used.push(fallback);
  return fallback;
}

export async function GET(req: Request) {
  try {
    const user = await authenticateUser(req);
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const { data: spaces, error: spacesErr } = await supabaseAdmin
      .from("user_build_spaces")
      .select("owner_id, is_public, updated_at")
      .or(`is_public.eq.true,owner_id.eq.${user.id}`)
      .order("updated_at", { ascending: false })
      .limit(3000);

    if (spacesErr) {
      return NextResponse.json({ error: "homes load failed" }, { status: 500 });
    }

    const statsByOwner = new Map<string, HomeStat>();
    const ensureStat = (ownerId: string) => {
      const current = statsByOwner.get(ownerId);
      if (current) return current;
      const fresh: HomeStat = {
        ownerId,
        totalBuilds: 0,
        publicBuilds: 0,
        updatedAt: null,
      };
      statsByOwner.set(ownerId, fresh);
      return fresh;
    };

    ((spaces || []) as SpaceRow[]).forEach((row) => {
      const ownerId = String(row.owner_id || "").trim();
      if (!ownerId) return;
      const stat = ensureStat(ownerId);
      const isOwner = ownerId === user.id;
      const isPublic = row.is_public === true;
      if (isOwner || isPublic) stat.totalBuilds += 1;
      if (isPublic) stat.publicBuilds += 1;
      stat.updatedAt = pickNewestTimestamp(stat.updatedAt, String(row.updated_at || "").trim() || null);
    });

    const ownerIds = Array.from(statsByOwner.keys());
    const { data: profiles, error: profilesErr } = await supabaseAdmin
      .from("profileskozmos")
      .select("id, username")
      .in("id", ownerIds);

    if (profilesErr) {
      return NextResponse.json({ error: "home owner load failed" }, { status: 500 });
    }

    const usernameByOwner = new Map<string, string>();
    ((profiles || []) as ProfileRow[]).forEach((row) => {
      usernameByOwner.set(String(row.id), normalizeUsername(row.username));
    });

    const usedPositions: Array<{ x: number; z: number }> = [];
    const homes = Array.from(statsByOwner.values())
      .filter((stat) => stat.totalBuilds > 0)
      .sort((a, b) => {
        const aSelf = a.ownerId === user.id ? 1 : 0;
        const bSelf = b.ownerId === user.id ? 1 : 0;
        if (aSelf !== bSelf) return bSelf - aSelf;
        const aName = usernameByOwner.get(a.ownerId) || "user";
        const bName = usernameByOwner.get(b.ownerId) || "user";
        return aName.localeCompare(bName);
      })
      .map((stat, index) => {
        const pos = placeHome(stat.ownerId, index, usedPositions);
        return {
          ownerId: stat.ownerId,
          username: usernameByOwner.get(stat.ownerId) || "user",
          x: pos.x,
          z: pos.z,
          totalBuilds: stat.totalBuilds,
          publicBuilds: stat.publicBuilds,
          isSelf: stat.ownerId === user.id,
          updatedAt: stat.updatedAt,
        };
      });

    return NextResponse.json({ homes });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}
