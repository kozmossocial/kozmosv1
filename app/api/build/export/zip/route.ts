import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

type SpaceAccess = {
  space: {
    id: string;
    owner_id: string;
    is_public: boolean;
    title: string;
  } | null;
  canRead: boolean;
  canEdit: boolean;
  error: { code?: string; message?: string } | null;
};

type BuildFileRow = {
  path: string;
  content: string;
};

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i += 1) {
  let crc = i;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  CRC_TABLE[i] = crc >>> 0;
}

function computeCrc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    const index = (crc ^ bytes[i]) & 0xff;
    crc = (crc >>> 8) ^ CRC_TABLE[index];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function extractBearerToken(req: Request) {
  const header = req.headers.get("authorization") || req.headers.get("Authorization");
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

function mapError(error: { code?: string; message?: string } | null, fallback: string) {
  if (!error) return { error: fallback };
  const detail = [error.code, error.message].filter(Boolean).join(": ");
  return { error: detail || fallback };
}

async function getSpaceAccess(spaceId: string, userId: string): Promise<SpaceAccess> {
  const { data: space, error: spaceErr } = await supabaseAdmin
    .from("user_build_spaces")
    .select("id, owner_id, is_public, title")
    .eq("id", spaceId)
    .maybeSingle();
  if (spaceErr) return { space: null, canRead: false, canEdit: false, error: spaceErr };
  if (!space) return { space: null, canRead: false, canEdit: false, error: null };

  if (space.owner_id === userId) {
    return { space, canRead: true, canEdit: true, error: null };
  }

  const { data: accessRow, error: accessErr } = await supabaseAdmin
    .from("user_build_space_access")
    .select("can_edit")
    .eq("space_id", spaceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (accessErr) return { space, canRead: false, canEdit: false, error: accessErr };

  const hasSharedAccess = Boolean(accessRow);
  const canRead = space.is_public || hasSharedAccess;
  const canEdit = Boolean(accessRow?.can_edit);
  return { space, canRead, canEdit, error: null };
}

function toMsDosTime(date: Date) {
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);
  return ((hours & 0x1f) << 11) | ((minutes & 0x3f) << 5) | (seconds & 0x1f);
}

function toMsDosDate(date: Date) {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return (((year - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f);
}

function sanitizeZipPath(path: string, fallbackIndex: number) {
  const normalized = path.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  const safe = normalized
    .split("/")
    .map((part) => part.replace(/\.\.+/g, "").replace(/[^a-zA-Z0-9._ -]/g, "_").trim())
    .filter(Boolean)
    .join("/");
  if (safe) return safe;
  return `file-${fallbackIndex}.txt`;
}

function sanitizeFileName(value: string) {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._ -]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "");
  return normalized || "subspace";
}

function buildZip(files: BuildFileRow[]) {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  const now = new Date();
  const dosTime = toMsDosTime(now);
  const dosDate = toMsDosDate(now);

  files.forEach((file, index) => {
    const zipPath = sanitizeZipPath(file.path, index + 1);
    const fileNameBytes = encoder.encode(zipPath);
    const fileBytes = encoder.encode(file.content || "");
    const crc = computeCrc32(fileBytes);

    const localHeader = new Uint8Array(30 + fileNameBytes.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, dosTime, true);
    localView.setUint16(12, dosDate, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, fileBytes.length, true);
    localView.setUint32(22, fileBytes.length, true);
    localView.setUint16(26, fileNameBytes.length, true);
    localView.setUint16(28, 0, true);
    localHeader.set(fileNameBytes, 30);
    localParts.push(localHeader, fileBytes);

    const centralHeader = new Uint8Array(46 + fileNameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, dosTime, true);
    centralView.setUint16(14, dosDate, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, fileBytes.length, true);
    centralView.setUint32(24, fileBytes.length, true);
    centralView.setUint16(28, fileNameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    centralHeader.set(fileNameBytes, 46);
    centralParts.push(centralHeader);

    offset += localHeader.length + fileBytes.length;
  });

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const endRecord = new Uint8Array(22);
  const endView = new DataView(endRecord.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);

  const totalSize =
    localParts.reduce((sum, part) => sum + part.length, 0) +
    centralSize +
    endRecord.length;
  const out = new Uint8Array(totalSize);
  let cursor = 0;
  [...localParts, ...centralParts, endRecord].forEach((part) => {
    out.set(part, cursor);
    cursor += part.length;
  });
  return out;
}

export async function GET(req: Request) {
  try {
    const user = await authenticateUser(req);
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const url = new URL(req.url);
    const spaceId = String(url.searchParams.get("spaceId") || "").trim();
    if (!spaceId) {
      return NextResponse.json({ error: "spaceId required" }, { status: 400 });
    }

    const access = await getSpaceAccess(spaceId, user.id);
    if (access.error) {
      return NextResponse.json(mapError(access.error, "access check failed"), { status: 500 });
    }
    if (!access.space || !access.canRead) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (access.space.owner_id !== user.id) {
      return NextResponse.json({ error: "only subspace owner can export zip" }, { status: 403 });
    }

    const { data, error } = await supabaseAdmin
      .from("user_build_files")
      .select("path, content")
      .eq("space_id", spaceId)
      .order("path", { ascending: true });
    if (error) {
      return NextResponse.json(mapError(error, "load files failed"), { status: 500 });
    }

    const files = ((data || []) as BuildFileRow[]).map((row) => ({
      path: row.path || "",
      content: typeof row.content === "string" ? row.content : "",
    }));

    const zipBytes = buildZip(files);
    const baseName = sanitizeFileName(access.space.title || "subspace");
    const fileName = `${baseName}.zip`;

    return new NextResponse(zipBytes, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}
