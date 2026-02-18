import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const ROOM_LIMIT = 13;
const ROOM_PATHS = [
  "space.room.json",
  "kozmos.space.json",
  "matrix.room.json",
  "kozmos.matrix.json",
] as const;
const ROOM_AURAS = ["calm", "bright", "heavy", "fast"] as const;
const ROOM_VISIBILITIES = ["public", "unlisted", "private"] as const;
const ROOM_ENTRIES = ["click", "proximity"] as const;
const ROOM_ICONS = ["dot", "square", "ring"] as const;

type RoomAura = (typeof ROOM_AURAS)[number];
type RoomVisibility = (typeof ROOM_VISIBILITIES)[number];
type RoomEntry = (typeof ROOM_ENTRIES)[number];
type RoomIcon = (typeof ROOM_ICONS)[number];

type SpaceRow = {
  id: string;
  owner_id: string;
  title: string;
  description: string;
  updated_at: string;
};

type BuildFileRow = {
  space_id: string;
  path: string;
  content: string;
  updated_at: string;
};

type ProfileRow = {
  id: string;
  username: string | null;
};

type RoomManifest = {
  title: string;
  subtitle: string | null;
  spawn: { x: number; z: number } | null;
  aura: RoomAura;
  visibility: RoomVisibility;
  entry: RoomEntry;
  icon: RoomIcon;
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

function normalizeText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function normalizeEnum<T extends readonly string[]>(
  value: unknown,
  allowed: T
): T[number] | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return (allowed as readonly string[]).includes(normalized)
    ? (normalized as T[number])
    : null;
}

function normalizeSpawn(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const rawX = (value as { x?: unknown }).x;
  const rawZ = (value as { z?: unknown }).z;
  if (typeof rawX !== "number" || typeof rawZ !== "number") return null;
  if (!Number.isFinite(rawX) || !Number.isFinite(rawZ)) return null;
  return {
    x: clamp(rawX, -ROOM_LIMIT, ROOM_LIMIT),
    z: clamp(rawZ, -ROOM_LIMIT, ROOM_LIMIT),
  };
}

function defaultSpawn(spaceId: string) {
  const hash = hashString(spaceId);
  const angle = ((hash % 3600) / 3600) * Math.PI * 2;
  const ringIndex = Math.floor(hash / 3600) % 3;
  const baseRadius = 7.2 + ringIndex * 2.4;
  const jitter = (((Math.floor(hash / 10800) % 100) - 50) / 100) * 0.9;
  const radius = clamp(baseRadius + jitter, 6.8, 12.6);
  return {
    x: Number((Math.cos(angle) * radius).toFixed(2)),
    z: Number((Math.sin(angle) * radius).toFixed(2)),
  };
}

function parseRoomManifest(file: BuildFileRow | undefined, space: SpaceRow): RoomManifest {
  const fallbackTitle = normalizeText(space.title, 32) || "untitled room";
  const fallbackSubtitle = normalizeText(space.description, 48);

  if (!file?.content) {
    return {
      title: fallbackTitle,
      subtitle: fallbackSubtitle,
      spawn: null,
      aura: "calm",
      visibility: "public",
      entry: "proximity",
      icon: "ring",
    };
  }

  const parsed = JSON.parse(file.content) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("manifest root must be object");
  }

  const version = (parsed as { version?: unknown }).version;
  if (typeof version !== "number" || version !== 1) {
    throw new Error("manifest version unsupported");
  }

  const room = (parsed as { room?: unknown }).room;
  if (!room || typeof room !== "object") {
    throw new Error("room block missing");
  }

  return {
    title: normalizeText((room as { title?: unknown }).title, 32) || fallbackTitle,
    subtitle: normalizeText((room as { subtitle?: unknown }).subtitle, 48),
    spawn: normalizeSpawn((room as { spawn?: unknown }).spawn),
    aura: normalizeEnum((room as { aura?: unknown }).aura, ROOM_AURAS) || "calm",
    visibility:
      normalizeEnum((room as { visibility?: unknown }).visibility, ROOM_VISIBILITIES) ||
      "public",
    entry: normalizeEnum((room as { entry?: unknown }).entry, ROOM_ENTRIES) || "proximity",
    icon: normalizeEnum((room as { icon?: unknown }).icon, ROOM_ICONS) || "ring",
  };
}

function pickNewestTimestamp(primary: string, secondary: string | undefined) {
  if (!secondary) return primary;
  const first = Date.parse(primary);
  const second = Date.parse(secondary);
  if (!Number.isFinite(second)) return primary;
  if (!Number.isFinite(first)) return secondary;
  return second > first ? secondary : primary;
}

export async function GET(req: Request) {
  try {
    const user = await authenticateUser(req);
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const { data: spaces, error: spacesErr } = await supabaseAdmin
      .from("user_build_spaces")
      .select("id, owner_id, title, description, updated_at")
      .eq("is_public", true)
      .order("updated_at", { ascending: false })
      .limit(300);

    if (spacesErr) {
      return NextResponse.json({ error: "rooms load failed" }, { status: 500 });
    }

    const typedSpaces = (spaces || []) as SpaceRow[];
    if (typedSpaces.length === 0) {
      return NextResponse.json({ rooms: [] });
    }

    const spaceIds = typedSpaces.map((space) => space.id);

    const [filesResult, profilesResult] = await Promise.all([
      supabaseAdmin
        .from("user_build_files")
        .select("space_id, path, content, updated_at")
        .in("space_id", spaceIds)
        .in("path", [...ROOM_PATHS]),
      supabaseAdmin.from("profileskozmos").select("id, username").in("id", [
        ...new Set(typedSpaces.map((space) => space.owner_id)),
      ]),
    ]);

    if (filesResult.error) {
      return NextResponse.json({ error: "room manifest load failed" }, { status: 500 });
    }
    if (profilesResult.error) {
      return NextResponse.json({ error: "room owner load failed" }, { status: 500 });
    }

    const manifestBySpaceId = new Map<string, BuildFileRow>();
    ((filesResult.data || []) as BuildFileRow[]).forEach((file) => {
      const current = manifestBySpaceId.get(file.space_id);
      if (!current) {
        manifestBySpaceId.set(file.space_id, file);
        return;
      }
      const currentRank = ROOM_PATHS.indexOf(current.path as (typeof ROOM_PATHS)[number]);
      const nextRank = ROOM_PATHS.indexOf(file.path as (typeof ROOM_PATHS)[number]);
      if (nextRank < currentRank) {
        manifestBySpaceId.set(file.space_id, file);
      }
    });

    const ownerById = new Map<string, string>();
    ((profilesResult.data || []) as ProfileRow[]).forEach((profile) => {
      ownerById.set(profile.id, profile.username?.trim() || "user");
    });

    const rooms = typedSpaces
      .map((space) => {
        const manifestFile = manifestBySpaceId.get(space.id);
        let manifest: RoomManifest;
        try {
          manifest = parseRoomManifest(manifestFile, space);
        } catch {
          manifest = {
            title: normalizeText(space.title, 32) || "untitled room",
            subtitle: normalizeText(space.description, 48),
            spawn: null,
            aura: "calm",
            visibility: "public",
            entry: "proximity",
            icon: "ring",
          };
        }

        if (manifest.visibility === "private") {
          return null;
        }

        const spawn = manifest.spawn || defaultSpawn(space.id);
        return {
          id: space.id,
          title: manifest.title,
          subtitle: manifest.subtitle,
          x: spawn.x,
          z: spawn.z,
          aura: manifest.aura,
          visibility: manifest.visibility,
          entry: manifest.entry,
          icon: manifest.icon,
          ownerUsername: ownerById.get(space.owner_id) || "user",
          updatedAt: pickNewestTimestamp(space.updated_at, manifestFile?.updated_at),
        };
      })
      .filter(Boolean)
      .sort((a, b) => a!.z - b!.z);

    return NextResponse.json({ rooms });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}
