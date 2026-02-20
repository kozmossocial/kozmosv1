"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

type BuildSpace = {
  id: string;
  owner_id: string;
  title: string;
  is_public: boolean;
  can_edit?: boolean;
  language_pref: string;
  description: string;
  updated_at: string;
};

type BuildFile = {
  id: number;
  path: string;
  content: string;
  language: string;
  updated_at: string;
};

type InTouchUser = {
  id: string;
  username: string;
  avatar_url: string | null;
};

type SpaceAccessEntry = {
  userId: string;
  username: string;
  canEdit: boolean;
};

const LANGUAGE_OPTIONS = ["text", "ts", "tsx", "js", "json", "md", "sql", "py"];

type AxyTurn = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

const ROOM_MANIFEST_PATH = "space.room.json";
const LEGACY_ROOM_MANIFEST_PATHS = ["matrix.room.json", "kozmos.matrix.json"] as const;
const ROOM_COORD_LIMIT = 13;
const ROOM_AURAS = ["calm", "bright", "heavy", "fast"] as const;
const ROOM_VISIBILITIES = ["public", "unlisted", "private"] as const;
const ROOM_ENTRIES = ["click", "proximity"] as const;
const ROOM_ICONS = ["dot", "square", "ring"] as const;

type RoomAura = (typeof ROOM_AURAS)[number];
type RoomVisibility = (typeof ROOM_VISIBILITIES)[number];
type RoomEntry = (typeof ROOM_ENTRIES)[number];
type RoomIcon = (typeof ROOM_ICONS)[number];

type RoomManifest = {
  version: 1;
  room: {
    title: string;
    subtitle?: string;
    spawn?: { x: number; z: number };
    aura: RoomAura;
    visibility: RoomVisibility;
    entry: RoomEntry;
    icon: RoomIcon;
  };
};

function clipText(value: string | null | undefined, maxLength: number) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed.slice(0, maxLength) : "";
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
  const x = (value as { x?: unknown }).x;
  const z = (value as { z?: unknown }).z;
  if (typeof x !== "number" || typeof z !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  return {
    x: Math.max(-ROOM_COORD_LIMIT, Math.min(ROOM_COORD_LIMIT, x)),
    z: Math.max(-ROOM_COORD_LIMIT, Math.min(ROOM_COORD_LIMIT, z)),
  };
}

function parseExistingRoomManifest(content: string | undefined) {
  if (!content) return {};
  try {
    const parsed = JSON.parse(content) as { version?: unknown; room?: unknown };
    if (typeof parsed !== "object" || !parsed) return {};
    if (typeof parsed.version !== "number" || parsed.version !== 1) return {};
    if (!parsed.room || typeof parsed.room !== "object") return {};
    const room = parsed.room as {
      title?: unknown;
      subtitle?: unknown;
      spawn?: unknown;
      aura?: unknown;
      visibility?: unknown;
      entry?: unknown;
      icon?: unknown;
    };
    return {
      title: clipText(typeof room.title === "string" ? room.title : "", 32) || null,
      subtitle: clipText(typeof room.subtitle === "string" ? room.subtitle : "", 48) || null,
      spawn: normalizeSpawn(room.spawn),
      aura: normalizeEnum(room.aura, ROOM_AURAS),
      visibility: normalizeEnum(room.visibility, ROOM_VISIBILITIES),
      entry: normalizeEnum(room.entry, ROOM_ENTRIES),
      icon: normalizeEnum(room.icon, ROOM_ICONS),
    };
  } catch {
    return {};
  }
}

function isRoomManifestPath(path: string) {
  const normalizedPath = path.trim().toLowerCase();
  if (normalizedPath === ROOM_MANIFEST_PATH) return true;
  return LEGACY_ROOM_MANIFEST_PATHS.some((legacy) => legacy === normalizedPath);
}

function findRoomManifestFile(files: BuildFile[]) {
  return files.find((file) => isRoomManifestPath(file.path));
}

function injectPreviewRuntimeBridge(doc: string, spaceId: string, accessToken: string) {
  const safeSpaceId = JSON.stringify(spaceId);
  const safeToken = JSON.stringify(accessToken);
  const bridgeScript = [
    "<script>",
    "(function () {",
    `  const __SPACE_ID__ = ${safeSpaceId};`,
    `  const __TOKEN__ = ${safeToken};`,
    "  async function req(url, init) {",
    "    const headers = new Headers((init && init.headers) || {});",
    "    headers.set('Authorization', 'Bearer ' + __TOKEN__);",
    "    if (init && init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');",
    "    const res = await fetch(url, { ...(init || {}), headers });",
    "    const data = await res.json().catch(function () { return {}; });",
    "    if (!res.ok) throw new Error((data && data.error) || ('http ' + res.status));",
    "    return data;",
    "  }",
    "  window.KozmosRuntime = {",
    "    spaceId: __SPACE_ID__,",
    "    kvGet: async function (key) {",
    "      const q = new URLSearchParams({ spaceId: __SPACE_ID__, key: String(key || '') });",
    "      return req('/api/build/runtime/kv?' + q.toString(), { method: 'GET' });",
    "    },",
    "    kvList: async function (prefix, limit) {",
    "      const q = new URLSearchParams({ spaceId: __SPACE_ID__ });",
    "      if (prefix) q.set('prefix', String(prefix));",
    "      if (Number.isFinite(Number(limit))) q.set('limit', String(Math.round(Number(limit))));",
    "      return req('/api/build/runtime/kv?' + q.toString(), { method: 'GET' });",
    "    },",
    "    kvSet: async function (key, value) {",
    "      return req('/api/build/runtime/kv', { method: 'PUT', body: JSON.stringify({ spaceId: __SPACE_ID__, key: String(key || ''), value }) });",
    "    },",
    "    kvDelete: async function (key) {",
    "      return req('/api/build/runtime/kv', { method: 'DELETE', body: JSON.stringify({ spaceId: __SPACE_ID__, key: String(key || '') }) });",
    "    },",
    "    proxy: async function (input) {",
    "      const payload = (input && typeof input === 'object') ? input : {};",
    "      return req('/api/build/runtime/proxy', { method: 'POST', body: JSON.stringify({ ...payload, spaceId: __SPACE_ID__ }) });",
    "    }",
    "  };",
    "})();",
    "</script>",
  ].join("");

  if (/<\/head>/i.test(doc)) {
    return doc.replace(/<\/head>/i, `${bridgeScript}</head>`);
  }
  return `${bridgeScript}${doc}`;
}

export default function BuildPage() {
  const router = useRouter();

  const [bootLoading, setBootLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);
  const [sessionAccessToken, setSessionAccessToken] = useState<string>("");
  const [username, setUsername] = useState("user");
  const [isDesktop, setIsDesktop] = useState(true);

  const [spaces, setSpaces] = useState<BuildSpace[]>([]);
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null);
  const [files, setFiles] = useState<BuildFile[]>([]);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);

  const [newSpaceTitle, setNewSpaceTitle] = useState("");
  const [newFilePath, setNewFilePath] = useState("");
  const [editorLanguage, setEditorLanguage] = useState("text");
  const [editorContent, setEditorContent] = useState("");

  const [loadingSpaces, setLoadingSpaces] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [creatingSpace, setCreatingSpace] = useState(false);
  const [deletingSpace, setDeletingSpace] = useState(false);
  const [creatingFile, setCreatingFile] = useState(false);
  const [deletingFile, setDeletingFile] = useState(false);
  const [savingFile, setSavingFile] = useState(false);
  const [publishingRoom, setPublishingRoom] = useState(false);
  const [updatingSpaceVisibility, setUpdatingSpaceVisibility] = useState(false);
  const [loadingAccess, setLoadingAccess] = useState(false);
  const [inTouchUsers, setInTouchUsers] = useState<InTouchUser[]>([]);
  const [spaceAccessEntries, setSpaceAccessEntries] = useState<SpaceAccessEntry[]>([]);
  const [updatingAccessUsername, setUpdatingAccessUsername] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [infoText, setInfoText] = useState<string | null>(null);
  const [axyInput, setAxyInput] = useState("");
  const [axyTurns, setAxyTurns] = useState<AxyTurn[]>([]);
  const [axyLoading, setAxyLoading] = useState(false);
  const axyScrollRef = useRef<HTMLDivElement | null>(null);
  const [previewAutoRefresh, setPreviewAutoRefresh] = useState(true);
  const [previewReloadKey, setPreviewReloadKey] = useState(0);
  const [requestedSpaceId, setRequestedSpaceId] = useState<string | null>(null);

  const selectedSpace = useMemo(
    () => spaces.find((space) => space.id === selectedSpaceId) ?? null,
    [spaces, selectedSpaceId]
  );
  const selectedFile = useMemo(
    () => files.find((file) => file.path === selectedFilePath) ?? null,
    [files, selectedFilePath]
  );
  const canEditSelectedSpace = Boolean(
    selectedSpace &&
      userId &&
      (selectedSpace.owner_id === userId || selectedSpace.can_edit === true)
  );
  const isOwnerSelectedSpace = Boolean(
    selectedSpace && userId && selectedSpace.owner_id === userId
  );
  const editableAccessByUsername = useMemo(() => {
    const map = new Map<string, SpaceAccessEntry>();
    spaceAccessEntries.forEach((entry) => {
      map.set(entry.username.toLowerCase(), entry);
    });
    return map;
  }, [spaceAccessEntries]);
  const orphanEditableAccess = useMemo(() => {
    const touchSet = new Set(inTouchUsers.map((user) => user.username.toLowerCase()));
    return spaceAccessEntries.filter(
      (entry) => entry.canEdit && !touchSet.has(entry.username.toLowerCase())
    );
  }, [inTouchUsers, spaceAccessEntries]);
  const previewDoc = useMemo(() => {
    const workingFiles = previewAutoRefresh
      ? files.map((file) =>
          selectedFilePath && file.path === selectedFilePath
            ? {
                ...file,
                content: editorContent,
                language: editorLanguage || file.language,
              }
            : file
        )
      : files;
    const htmlFile =
      workingFiles.find((file) => /(^|\/)index\.html$/i.test(file.path)) ||
      workingFiles.find((file) => /\.html?$/i.test(file.path));
    const css = workingFiles
      .filter((file) => /\.css$/i.test(file.path))
      .map((file) => file.content || "")
      .join("\n\n");
    const js = workingFiles
      .filter((file) => /\.js$/i.test(file.path))
      .map((file) => file.content || "")
      .join("\n\n");

    let doc = "";
    if (!htmlFile) {
      doc = `<!doctype html><html><body style="margin:0;padding:18px;background:#0b0b0b;color:#eaeaea;font-family:system-ui,sans-serif;">
<h3 style="margin:0 0 8px;">No HTML entry found</h3>
<p style="opacity:.75;">Create <code>index.html</code> and save it to see live outcome here.</p>
</body></html>`;
      if (selectedSpaceId && sessionAccessToken) {
        return injectPreviewRuntimeBridge(doc, selectedSpaceId, sessionAccessToken);
      }
      return doc;
    }
    doc = htmlFile.content || "";
    const styleTag = css ? `\n<style>\n${css}\n</style>\n` : "";
    const scriptTag = js ? `\n<script>\n${js}\n</script>\n` : "";

    if (styleTag) {
      if (/<\/head>/i.test(doc)) doc = doc.replace(/<\/head>/i, `${styleTag}</head>`);
      else doc = `${styleTag}${doc}`;
    }
    if (scriptTag) {
      if (/<\/body>/i.test(doc)) doc = doc.replace(/<\/body>/i, `${scriptTag}</body>`);
      else doc = `${doc}${scriptTag}`;
    }
    if (selectedSpaceId && sessionAccessToken) {
      return injectPreviewRuntimeBridge(doc, selectedSpaceId, sessionAccessToken);
    }
    return doc;
  }, [
    editorContent,
    editorLanguage,
    files,
    previewAutoRefresh,
    selectedFilePath,
    selectedSpaceId,
    sessionAccessToken,
  ]);

  async function fetchAuthedJson(url: string, init?: RequestInit) {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    const headers = new Headers(init?.headers ?? {});
    if (session?.access_token) {
      headers.set("Authorization", `Bearer ${session.access_token}`);
    }
    if (init?.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const res = await fetch(url, { ...init, headers });
    const data = await res.json().catch(() => ({}));
    return { res, data } as const;
  }

  async function loadSpaces(preferredSpaceId?: string | null) {
    setLoadingSpaces(true);
    const { res, data } = await fetchAuthedJson("/api/build/spaces");
    setLoadingSpaces(false);

    if (!res.ok) {
      if (res.status === 401) {
        router.push("/login");
        return;
      }
      setErrorText(data?.error || "failed to load subspaces");
      return;
    }

    const nextSpaces = (Array.isArray(data?.spaces) ? data.spaces : []) as BuildSpace[];
    setSpaces(nextSpaces);
    setErrorText(null);

    setSelectedSpaceId((prev) => {
      if (preferredSpaceId && nextSpaces.some((s) => s.id === preferredSpaceId)) {
        return preferredSpaceId;
      }
      if (prev && nextSpaces.some((s) => s.id === prev)) return prev;
      const preferred =
        nextSpaces.find((s) => s.owner_id === userId) ||
        nextSpaces.find((s) => s.can_edit) ||
        nextSpaces[0];
      return preferred?.id ?? null;
    });
  }

  async function loadFiles(spaceId: string, preferredPath?: string | null) {
    setLoadingFiles(true);
    const { res, data } = await fetchAuthedJson(
      `/api/build/files?spaceId=${encodeURIComponent(spaceId)}`
    );
    setLoadingFiles(false);

    if (!res.ok) {
      setFiles([]);
      setSelectedFilePath(null);
      setEditorContent("");
      setEditorLanguage("text");
      if (res.status !== 403) {
        setErrorText(data?.error || "failed to load files");
      }
      return;
    }

    const nextFiles = (Array.isArray(data?.files) ? data.files : []) as BuildFile[];
    setFiles(nextFiles);
    setErrorText(null);

    setSelectedFilePath((prev) => {
      if (preferredPath && nextFiles.some((f) => f.path === preferredPath)) {
        return preferredPath;
      }
      if (prev && nextFiles.some((f) => f.path === prev)) return prev;
      return nextFiles[0]?.path ?? null;
    });
  }

  async function loadAccessData(spaceId: string) {
    if (!isOwnerSelectedSpace) {
      setInTouchUsers([]);
      setSpaceAccessEntries([]);
      return;
    }

    setLoadingAccess(true);
    try {
      const [touchRes, accessRes] = await Promise.all([
        fetchAuthedJson("/api/keep-in-touch"),
        fetchAuthedJson(`/api/build/access?spaceId=${encodeURIComponent(spaceId)}`),
      ]);

      if (touchRes.res.ok) {
        const nextInTouch = (Array.isArray(touchRes.data?.inTouch)
          ? touchRes.data.inTouch
          : []) as InTouchUser[];
        setInTouchUsers(nextInTouch);
      } else {
        setInTouchUsers([]);
      }

      if (accessRes.res.ok) {
        const nextEntries = (Array.isArray(accessRes.data?.entries)
          ? accessRes.data.entries
          : []) as SpaceAccessEntry[];
        setSpaceAccessEntries(nextEntries);
      } else if (accessRes.res.status === 403) {
        setSpaceAccessEntries([]);
      } else {
        setErrorText(accessRes.data?.error || "access list failed");
      }
    } finally {
      setLoadingAccess(false);
    }
  }

  useEffect(() => {
    async function boot() {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user ?? null;

      if (!user) {
        setBootLoading(false);
        router.push("/login");
        return;
      }

      setUserId(user.id);
      setSessionAccessToken(session?.access_token || "");
      const { data: profile } = await supabase
        .from("profileskozmos")
        .select("username")
        .eq("id", user.id)
        .maybeSingle();

      if (profile?.username) setUsername(profile.username);
      setBootLoading(false);
      await loadSpaces();
    }

    void boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = new URLSearchParams(window.location.search).get("spaceId");
    const normalized = typeof raw === "string" ? raw.trim() : "";
    setRequestedSpaceId(normalized || null);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const media = window.matchMedia("(min-width: 1024px)");
    const update = () => setIsDesktop(media.matches);
    update();

    const add = media.addEventListener?.bind(media);
    const remove = media.removeEventListener?.bind(media);
    if (add && remove) {
      add("change", update);
      return () => remove("change", update);
    }

    media.addListener(update);
    return () => media.removeListener(update);
  }, []);

  useEffect(() => {
    if (!selectedSpaceId) {
      setFiles([]);
      setSelectedFilePath(null);
      setEditorContent("");
      setEditorLanguage("text");
      return;
    }
    void loadFiles(selectedSpaceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSpaceId]);

  useEffect(() => {
    if (!requestedSpaceId) return;
    if (!spaces.some((space) => space.id === requestedSpaceId)) return;
    setSelectedSpaceId(requestedSpaceId);
  }, [requestedSpaceId, spaces]);

  useEffect(() => {
    if (!selectedFile) {
      setEditorContent("");
      setEditorLanguage("text");
      return;
    }
    setEditorContent(selectedFile.content || "");
    setEditorLanguage(selectedFile.language || "text");
  }, [selectedFile]);

  useEffect(() => {
    if (!axyScrollRef.current) return;
    axyScrollRef.current.scrollTop = axyScrollRef.current.scrollHeight;
  }, [axyTurns, axyLoading]);

  useEffect(() => {
    if (!selectedSpaceId || !isOwnerSelectedSpace) {
      setInTouchUsers([]);
      setSpaceAccessEntries([]);
      return;
    }
    void loadAccessData(selectedSpaceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOwnerSelectedSpace, selectedSpaceId]);

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/");
  }

  async function createSubspace() {
    const title = newSpaceTitle.trim() || `subspace ${spaces.length + 1}`;
    setCreatingSpace(true);
    setErrorText(null);
    setInfoText(null);
    try {
      const { res, data } = await fetchAuthedJson("/api/build/spaces", {
        method: "POST",
        body: JSON.stringify({ title }),
      });
      if (!res.ok || !data?.space?.id) {
        setErrorText(data?.error || "could not create subspace");
        return;
      }

      setNewSpaceTitle("");
      await loadSpaces(data.space.id as string);
      setInfoText("subspace created");
    } finally {
      setCreatingSpace(false);
    }
  }

  async function deleteSelectedSubspace() {
    if (!selectedSpace || !userId) return;
    if (selectedSpace.owner_id !== userId) {
      setErrorText("only owner can delete this subspace");
      return;
    }
    const ok = window.confirm(`delete subspace "${selectedSpace.title}"?`);
    if (!ok) return;

    setDeletingSpace(true);
    setErrorText(null);
    setInfoText(null);
    try {
      const deletingId = selectedSpace.id;
      const { res, data } = await fetchAuthedJson("/api/build/spaces", {
        method: "DELETE",
        body: JSON.stringify({ spaceId: deletingId }),
      });
      if (!res.ok) {
        setErrorText(data?.error || "could not delete subspace");
        return;
      }

      const nextCandidate = spaces.find((space) => space.id !== deletingId)?.id ?? null;
      await loadSpaces(nextCandidate);
      setInfoText("subspace deleted");
    } finally {
      setDeletingSpace(false);
    }
  }

  async function createFile() {
    if (!selectedSpaceId) {
      setErrorText("select a subspace first");
      return;
    }
    if (!canEditSelectedSpace) {
      setErrorText("read-only subspace");
      return;
    }
    const path = newFilePath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (!path) {
      setErrorText("file path required");
      return;
    }

    setCreatingFile(true);
    setErrorText(null);
    setInfoText(null);
    try {
      const { res, data } = await fetchAuthedJson("/api/build/files", {
        method: "POST",
        body: JSON.stringify({ spaceId: selectedSpaceId, path, language: "text" }),
      });
      if (!res.ok) {
        setErrorText(data?.error || "could not create file");
        return;
      }

      setNewFilePath("");
      await loadFiles(selectedSpaceId, path);
      setInfoText(data?.existed ? "file already exists" : "file created");
    } finally {
      setCreatingFile(false);
    }
  }

  async function deleteSelectedFile() {
    if (!selectedSpaceId || !selectedFilePath) return;
    if (!canEditSelectedSpace) {
      setErrorText("read-only subspace");
      return;
    }
    const ok = window.confirm(`delete file "${selectedFilePath}"?`);
    if (!ok) return;

    setDeletingFile(true);
    setErrorText(null);
    setInfoText(null);
    try {
      const deletingPath = selectedFilePath;
      const { res, data } = await fetchAuthedJson("/api/build/files", {
        method: "DELETE",
        body: JSON.stringify({ spaceId: selectedSpaceId, path: deletingPath }),
      });
      if (!res.ok) {
        setErrorText(data?.error || "could not delete file");
        return;
      }

      await loadFiles(selectedSpaceId);
      setInfoText("file deleted");
    } finally {
      setDeletingFile(false);
    }
  }

  async function saveFile() {
    if (!selectedSpaceId || !selectedFilePath) {
      setErrorText("select a file first");
      return;
    }
    if (!canEditSelectedSpace) {
      setErrorText("read-only subspace");
      return;
    }

    setSavingFile(true);
    setErrorText(null);
    setInfoText(null);
    try {
      const { res, data } = await fetchAuthedJson("/api/build/files", {
        method: "PUT",
        body: JSON.stringify({
          spaceId: selectedSpaceId,
          path: selectedFilePath,
          content: editorContent,
          language: editorLanguage || "text",
        }),
      });
      if (!res.ok) {
        setErrorText(data?.error || "save failed");
        return;
      }

      await loadFiles(selectedSpaceId, selectedFilePath);
      setInfoText("file saved");
    } finally {
      setSavingFile(false);
    }
  }

  function buildRoomManifest(
    space: BuildSpace,
    sourceContent: string | undefined,
    visibilityOverride?: RoomVisibility
  ): RoomManifest {
    const existing = parseExistingRoomManifest(sourceContent);
    const fallbackTitle = clipText(space.title, 32) || "untitled room";
    const fallbackSubtitle = clipText(space.description, 48);

    const roomPayload: RoomManifest["room"] = {
      title: existing.title || fallbackTitle,
      aura: existing.aura || "calm",
      visibility:
        visibilityOverride ||
        existing.visibility ||
        (space.is_public ? "public" : "unlisted"),
      entry: existing.entry || "proximity",
      icon: existing.icon || "ring",
    };
    const subtitle = existing.subtitle || fallbackSubtitle;
    if (subtitle) roomPayload.subtitle = subtitle;
    if (existing.spawn) roomPayload.spawn = existing.spawn;

    return {
      version: 1,
      room: roomPayload,
    };
  }

  async function writeRoomManifest(spaceId: string, manifest: RoomManifest) {
    return fetchAuthedJson("/api/build/files", {
      method: "PUT",
      body: JSON.stringify({
        spaceId,
        path: ROOM_MANIFEST_PATH,
        content: JSON.stringify(manifest, null, 2),
        language: "json",
      }),
    });
  }

  async function publishRoomToMatrix() {
    if (!selectedSpaceId || !selectedSpace) {
      setErrorText("select a subspace first");
      return;
    }
    if (!canEditSelectedSpace) {
      setErrorText("read-only subspace");
      return;
    }

    setPublishingRoom(true);
    setErrorText(null);
    setInfoText(null);

    try {
      const manifestFile = findRoomManifestFile(files);
      const manifest = buildRoomManifest(selectedSpace, manifestFile?.content);

      const { res, data } = await writeRoomManifest(selectedSpaceId, manifest);
      if (!res.ok) {
        setErrorText(data?.error || "publish failed");
        return;
      }

      await loadFiles(selectedSpaceId, selectedFilePath);
      setInfoText("room published to space");
    } finally {
      setPublishingRoom(false);
    }
  }

  async function setSelectedSpacePublic(nextIsPublic: boolean) {
    if (!selectedSpaceId || !selectedSpace || !userId) {
      setErrorText("select a subspace first");
      return;
    }
    if (selectedSpace.owner_id !== userId) {
      setErrorText("only owner can change visibility");
      return;
    }

    setUpdatingSpaceVisibility(true);
    setErrorText(null);
    setInfoText(null);

    try {
      const { res, data } = await fetchAuthedJson("/api/build/spaces", {
        method: "PATCH",
        body: JSON.stringify({
          spaceId: selectedSpaceId,
          isPublic: nextIsPublic,
        }),
      });
      if (!res.ok) {
        setErrorText(data?.error || "visibility update failed");
        return;
      }

      const manifestFile = findRoomManifestFile(files);
      const manifest = buildRoomManifest(
        selectedSpace,
        manifestFile?.content,
        nextIsPublic ? "public" : "private"
      );
      const manifestSave = await writeRoomManifest(selectedSpaceId, manifest);

      await loadSpaces(selectedSpaceId);
      await loadFiles(selectedSpaceId, selectedFilePath);

      if (!manifestSave.res.ok) {
        setErrorText(
          manifestSave.data?.error ||
            "visibility changed but room manifest sync failed (run publish room)"
        );
        return;
      }

      setInfoText(nextIsPublic ? "space is now public" : "space is now private");
    } finally {
      setUpdatingSpaceVisibility(false);
    }
  }

  async function setInTouchEditAccess(targetUsername: string, canEdit: boolean) {
    if (!selectedSpaceId || !isOwnerSelectedSpace) {
      setErrorText("only owner can manage access");
      return;
    }

    const usernameValue = targetUsername.trim();
    if (!usernameValue) return;

    setUpdatingAccessUsername(usernameValue.toLowerCase());
    setErrorText(null);
    setInfoText(null);

    try {
      const payload = JSON.stringify({
        spaceId: selectedSpaceId,
        username: usernameValue,
        ...(canEdit ? { canEdit: true } : {}),
      });
      const { res, data } = await fetchAuthedJson("/api/build/access", {
        method: canEdit ? "POST" : "DELETE",
        body: payload,
      });

      if (!res.ok) {
        setErrorText(data?.error || "access update failed");
        return;
      }

      await loadAccessData(selectedSpaceId);
      setInfoText(
        canEdit
          ? `${usernameValue} can now edit this subspace`
          : `${usernameValue} access removed`
      );
    } finally {
      setUpdatingAccessUsername(null);
    }
  }

  async function askBuilderAxy() {
    const message = axyInput.trim();
    if (!message) return;

    const userTurn: AxyTurn = {
      id: `${Date.now()}-u`,
      role: "user",
      content: message,
    };
    const history = axyTurns.slice(-10).map((turn) => ({
      role: turn.role,
      content: turn.content,
    }));

    setAxyTurns((prev) => [...prev, userTurn]);
    setAxyInput("");
    setAxyLoading(true);

    try {
      const { res, data } = await fetchAuthedJson("/api/build/axy", {
        method: "POST",
        body: JSON.stringify({
          message,
          history,
          spaceId: selectedSpaceId,
          activeFilePath: selectedFilePath,
          activeFileContent: editorContent,
          activeFileLanguage: editorLanguage,
        }),
      });

      const content = res.ok
        ? data?.reply || "..."
        : data?.error
          ? `error: ${data.error}`
          : "error";

      setAxyTurns((prev) => [
        ...prev,
        {
          id: `${Date.now()}-a`,
          role: "assistant",
          content,
        },
      ]);
    } catch {
      setAxyTurns((prev) => [
        ...prev,
        {
          id: `${Date.now()}-a`,
          role: "assistant",
          content: "error: request failed",
        },
      ]);
    } finally {
      setAxyLoading(false);
    }
  }

  function openPreviewInNewTab() {
    const blob = new Blob([previewDoc], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener,noreferrer");
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  if (bootLoading) {
    return (
      <main style={{ minHeight: "100vh", background: "#0b0b0b", color: "#eaeaea", padding: 24 }}>
        loading user build...
      </main>
    );
  }

  return (
    <main
      className="build-page-root"
      style={{
        minHeight: "100vh",
        background: "#060a07",
        color: "#eaeaea",
        padding: "18px 18px 28px",
      }}
    >
      <div className="build-page-ambient" aria-hidden="true">
        <div className="build-page-grid" />
        <div className="build-page-beam" />
        <div className="build-page-scanline" />
      </div>
      <div style={{ position: "relative", zIndex: 2 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 14,
          opacity: 0.72,
          marginTop: 2,
          cursor: "default",
          userSelect: "none",
        }}
      >
        <div>
          <span style={{ cursor: "pointer" }} onClick={() => router.push("/main")}>
            main
          </span>
          {" / "}
          <span style={{ cursor: "default" }}>user build</span>
          {" / "}
          <span
            style={{ cursor: "pointer", opacity: 0.9 }}
            onClick={() => router.push("/build/manual")}
          >
            manual
          </span>
        </div>
        <div>
          <span
            style={{ cursor: "pointer", userSelect: "none" }}
            onClick={() => router.push("/account")}
          >
            {username}
          </span>
          {" / "}
          <span style={{ cursor: "pointer" }} onClick={handleLogout}>
            logout
          </span>
        </div>
      </div>

      <div
        style={{
          marginTop: 10,
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          border: "1px solid rgba(121,193,255,0.28)",
          borderRadius: 9,
          background: "rgba(6,14,22,0.42)",
          padding: "6px 10px",
        }}
      >
        <span style={{ fontSize: 11, letterSpacing: "0.08em", opacity: 0.76 }}>
          user manual
        </span>
        <span
          className="kozmos-tap"
          style={{ fontSize: 11, opacity: 0.9, cursor: "pointer" }}
          onClick={() => router.push("/build/manual")}
        >
          open {"->"}
        </span>
      </div>

      {!isDesktop ? (
        <div
          style={{
            marginTop: 140,
            display: "flex",
            justifyContent: "center",
          }}
        >
          <section
            style={{
              width: "fit-content",
              maxWidth: "min(92vw, 420px)",
              textAlign: "center",
              fontSize: 12,
              letterSpacing: "0.06em",
              opacity: 0.84,
              padding: "10px 14px",
              borderRadius: 10,
              background: "rgba(7,17,11,0.8)",
              boxShadow: "0 0 22px rgba(99,255,148,0.14)",
              border: "1px solid rgba(116,255,160,0.3)",
            }}
          >
            not available for mobile device use.
          </section>
        </div>
      ) : (
        <section
          style={{
            marginTop: 26,
            border: "1px solid rgba(108,255,150,0.24)",
            borderRadius: 12,
            background: "rgba(5,14,9,0.72)",
            padding: 14,
            boxShadow: "0 0 40px rgba(70,255,130,0.08)",
          }}
        >
          <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 12 }}>
            <aside
              style={{
                border: "1px solid rgba(107,255,142,0.26)",
                borderRadius: 10,
                padding: 10,
                background: "linear-gradient(180deg, rgba(8,24,15,0.92), rgba(6,15,10,0.82))",
              }}
            >
              <div style={{ fontSize: 12, opacity: 0.74, letterSpacing: "0.1em" }}>
                subspaces
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <input
                  value={newSpaceTitle}
                  onChange={(e) => setNewSpaceTitle(e.target.value)}
                  placeholder="new subspace title"
                  style={{
                    flex: 1,
                    border: "1px solid rgba(125,255,160,0.24)",
                    background: "rgba(10,28,16,0.56)",
                    color: "#eaeaea",
                    borderRadius: 8,
                    padding: "8px 10px",
                    fontSize: 12,
                  }}
                />
                <button
                  onClick={createSubspace}
                  disabled={creatingSpace}
                  style={{
                    border: "1px solid rgba(107,255,142,0.45)",
                    borderRadius: 8,
                    background: "rgba(107,255,142,0.14)",
                    color: "#b8ffd1",
                    padding: "8px 10px",
                    cursor: creatingSpace ? "default" : "pointer",
                    fontSize: 12,
                  }}
                >
                  {creatingSpace ? "..." : "create"}
                </button>
              </div>
              <div style={{ marginTop: 8 }}>
                <button
                  onClick={deleteSelectedSubspace}
                  disabled={!selectedSpaceId || deletingSpace}
                  style={{
                    width: "100%",
                    border: "1px solid rgba(255,115,115,0.4)",
                    borderRadius: 8,
                    background: "rgba(255,80,80,0.12)",
                    color: "#ffc2c2",
                    padding: "7px 10px",
                    cursor: !selectedSpaceId || deletingSpace ? "default" : "pointer",
                    fontSize: 11,
                  }}
                >
                  {deletingSpace ? "deleting..." : "delete selected subspace"}
                </button>
              </div>
              <div style={{ marginTop: 8 }}>
                <button
                  onClick={() => {
                    if (!selectedSpace) return;
                    void setSelectedSpacePublic(!selectedSpace.is_public);
                  }}
                  disabled={
                    !selectedSpaceId ||
                    !isOwnerSelectedSpace ||
                    updatingSpaceVisibility
                  }
                  style={{
                    width: "100%",
                    border: "1px solid rgba(121,193,255,0.42)",
                    borderRadius: 8,
                    background: "rgba(121,193,255,0.12)",
                    color: "#cfe8ff",
                    padding: "7px 10px",
                    cursor:
                      !selectedSpaceId || !isOwnerSelectedSpace || updatingSpaceVisibility
                        ? "default"
                        : "pointer",
                    fontSize: 11,
                  }}
                >
                  {updatingSpaceVisibility
                    ? "updating..."
                    : selectedSpace?.is_public
                      ? "make private"
                      : "make public"}
                </button>
              </div>
              <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
                {loadingSpaces ? (
                  <div style={{ fontSize: 11, opacity: 0.56 }}>loading...</div>
                ) : spaces.length === 0 ? (
                  <div style={{ fontSize: 11, opacity: 0.56 }}>no subspaces yet</div>
                ) : (
                  spaces.map((space) => (
                    <button
                      key={space.id}
                      onClick={() => setSelectedSpaceId(space.id)}
                      style={{
                        textAlign: "left",
                        border: "1px solid rgba(255,255,255,0.15)",
                        borderRadius: 8,
                        background:
                          selectedSpaceId === space.id
                            ? "rgba(107,255,142,0.2)"
                            : "rgba(10,28,16,0.5)",
                        color: "#eaeaea",
                        padding: "8px 10px",
                        cursor: "pointer",
                        fontSize: 12,
                      }}
                    >
                      {space.title}
                      <span style={{ marginLeft: 8, opacity: 0.48, fontSize: 10 }}>
                        {space.owner_id === userId
                          ? space.is_public
                            ? "mine/public"
                            : "mine/private"
                          : space.can_edit
                            ? "editable"
                            : space.is_public
                              ? "public"
                              : "shared"}
                      </span>
                    </button>
                  ))
                )}
              </div>

              <div
                style={{
                  marginTop: 14,
                  fontSize: 12,
                  opacity: 0.74,
                  letterSpacing: "0.1em",
                }}
              >
                in touch access
              </div>
              <div
                style={{
                  marginTop: 8,
                  border: "1px solid rgba(121,193,255,0.24)",
                  borderRadius: 8,
                  padding: 8,
                  background: "rgba(10,22,30,0.34)",
                  display: "grid",
                  gap: 6,
                  maxHeight: 168,
                  overflowY: "auto",
                }}
              >
                {!selectedSpaceId ? (
                  <div style={{ fontSize: 11, opacity: 0.56 }}>select a subspace</div>
                ) : !isOwnerSelectedSpace ? (
                  <div style={{ fontSize: 11, opacity: 0.56 }}>
                    only owner can manage editors
                  </div>
                ) : loadingAccess ? (
                  <div style={{ fontSize: 11, opacity: 0.56 }}>loading access...</div>
                ) : inTouchUsers.length === 0 ? (
                  <div style={{ fontSize: 11, opacity: 0.56 }}>
                    no in touch users yet
                  </div>
                ) : (
                  inTouchUsers.map((touchUser) => {
                    const key = touchUser.username.toLowerCase();
                    const current = editableAccessByUsername.get(key);
                    const canEdit = current?.canEdit === true;
                    const busy = updatingAccessUsername === key;
                    return (
                      <div
                        key={touchUser.id}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: 8,
                          padding: "6px 7px",
                          borderRadius: 7,
                          background: "rgba(8,18,14,0.52)",
                          border: "1px solid rgba(255,255,255,0.08)",
                        }}
                      >
                        <div style={{ fontSize: 11 }}>{touchUser.username}</div>
                        <button
                          onClick={() =>
                            void setInTouchEditAccess(touchUser.username, !canEdit)
                          }
                          disabled={busy || Boolean(updatingAccessUsername)}
                          style={{
                            border: `1px solid ${
                              canEdit
                                ? "rgba(255,150,150,0.44)"
                                : "rgba(121,193,255,0.5)"
                            }`,
                            borderRadius: 7,
                            background: canEdit
                              ? "rgba(255,90,90,0.12)"
                              : "rgba(121,193,255,0.16)",
                            color: canEdit ? "#ffd1d1" : "#d7ebff",
                            padding: "4px 8px",
                            fontSize: 10,
                            cursor:
                              busy || Boolean(updatingAccessUsername)
                                ? "default"
                                : "pointer",
                          }}
                        >
                          {busy ? "..." : canEdit ? "revoke edit" : "allow edit"}
                        </button>
                      </div>
                    );
                  })
                )}
                {isOwnerSelectedSpace && orphanEditableAccess.length > 0 ? (
                  <div style={{ fontSize: 10, opacity: 0.62, paddingTop: 2 }}>
                    legacy editors:{" "}
                    {orphanEditableAccess.map((entry) => entry.username).join(", ")}
                  </div>
                ) : null}
              </div>

              <div
                style={{
                  marginTop: 14,
                  fontSize: 12,
                  opacity: 0.74,
                  letterSpacing: "0.1em",
                }}
              >
                files
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <input
                  value={newFilePath}
                  onChange={(e) => setNewFilePath(e.target.value)}
                  placeholder="src/main.ts"
                  style={{
                    flex: 1,
                    border: "1px solid rgba(125,255,160,0.24)",
                    background: "rgba(10,28,16,0.56)",
                    color: "#eaeaea",
                    borderRadius: 8,
                    padding: "8px 10px",
                    fontSize: 12,
                  }}
                />
                <button
                  onClick={createFile}
                  disabled={creatingFile}
                  style={{
                    border: "1px solid rgba(107,255,142,0.45)",
                    borderRadius: 8,
                    background: "rgba(107,255,142,0.14)",
                    color: "#b8ffd1",
                    padding: "8px 10px",
                    cursor: creatingFile ? "default" : "pointer",
                    fontSize: 12,
                  }}
                >
                  {creatingFile ? "..." : "add"}
                </button>
              </div>
              <div style={{ marginTop: 8 }}>
                <button
                  onClick={deleteSelectedFile}
                  disabled={!selectedFilePath || deletingFile}
                  style={{
                    width: "100%",
                    border: "1px solid rgba(255,115,115,0.4)",
                    borderRadius: 8,
                    background: "rgba(255,80,80,0.12)",
                    color: "#ffc2c2",
                    padding: "7px 10px",
                    cursor: !selectedFilePath || deletingFile ? "default" : "pointer",
                    fontSize: 11,
                  }}
                >
                  {deletingFile ? "deleting..." : "delete selected file"}
                </button>
              </div>
              <div style={{ marginTop: 10, display: "grid", gap: 6, maxHeight: 260, overflowY: "auto" }}>
                {loadingFiles ? (
                  <div style={{ fontSize: 11, opacity: 0.56 }}>loading...</div>
                ) : files.length === 0 ? (
                  <div style={{ fontSize: 11, opacity: 0.56 }}>no files yet</div>
                ) : (
                  files.map((file) => (
                    <button
                      key={`${file.id}-${file.path}`}
                      onClick={() => setSelectedFilePath(file.path)}
                      style={{
                        textAlign: "left",
                        border: "1px solid rgba(255,255,255,0.15)",
                        borderRadius: 8,
                        background:
                          selectedFilePath === file.path
                            ? "rgba(107,255,142,0.2)"
                            : "rgba(10,28,16,0.5)",
                        color: "#eaeaea",
                        padding: "7px 9px",
                        cursor: "pointer",
                        fontSize: 12,
                      }}
                    >
                      {file.path}
                    </button>
                  ))
                )}
              </div>
            </aside>

            <section
              style={{
                border: "1px solid rgba(107,255,142,0.24)",
                borderRadius: 10,
                padding: 12,
                background: "rgba(5,12,8,0.62)",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div style={{ fontSize: 12, opacity: 0.72 }}>
                  {selectedFilePath || "select or create a file"}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <select
                    value={editorLanguage}
                    onChange={(e) => setEditorLanguage(e.target.value)}
                    style={{
                      border: "1px solid rgba(125,255,160,0.22)",
                      background: "rgba(10,28,16,0.48)",
                      color: "#eaeaea",
                      borderRadius: 8,
                      padding: "6px 8px",
                      fontSize: 12,
                    }}
                  >
                    {LANGUAGE_OPTIONS.map((lang) => (
                      <option key={lang} value={lang}>
                        {lang}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={saveFile}
                    disabled={savingFile}
                    style={{
                      border: "1px solid rgba(107,255,142,0.45)",
                      borderRadius: 8,
                      background: "rgba(107,255,142,0.14)",
                      color: "#b8ffd1",
                      padding: "7px 10px",
                      cursor: savingFile ? "default" : "pointer",
                      fontSize: 12,
                    }}
                  >
                    {savingFile ? "saving..." : "save file"}
                  </button>
                  <button
                    onClick={publishRoomToMatrix}
                    disabled={publishingRoom || !selectedSpaceId || !canEditSelectedSpace}
                    style={{
                      border: "1px solid rgba(121,193,255,0.48)",
                      borderRadius: 8,
                      background: "rgba(121,193,255,0.14)",
                      color: "#cfe8ff",
                      padding: "7px 10px",
                      cursor:
                        publishingRoom || !selectedSpaceId || !canEditSelectedSpace
                          ? "default"
                          : "pointer",
                      fontSize: 12,
                    }}
                  >
                    {publishingRoom ? "publishing..." : "publish room"}
                  </button>
                </div>
              </div>

              <textarea
                value={editorContent}
                onChange={(e) => setEditorContent(e.target.value)}
                placeholder="build anything here..."
                readOnly={!canEditSelectedSpace}
                style={{
                  width: "100%",
                  minHeight: 460,
                  marginTop: 10,
                  borderRadius: 10,
                  border: "1px solid rgba(107,255,142,0.24)",
                  background: "rgba(2,9,6,0.84)",
                  color: "#d8ffe4",
                  padding: 12,
                  fontSize: 13,
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  lineHeight: 1.45,
                  resize: "vertical",
                  opacity: canEditSelectedSpace ? 1 : 0.76,
                }}
              />

              <div style={{ marginTop: 10, fontSize: 11, opacity: 0.65 }}>
                mode: {canEditSelectedSpace ? "editable" : "read-only"}
              </div>
              {infoText ? (
                <div style={{ marginTop: 8, fontSize: 12, color: "#b8ffd1" }}>{infoText}</div>
              ) : null}
              {errorText ? (
                <div style={{ marginTop: 8, fontSize: 12, color: "#ff9d9d" }}>{errorText}</div>
              ) : null}

              <div
                style={{
                  marginTop: 14,
                  border: "1px solid rgba(107,255,142,0.24)",
                  borderRadius: 10,
                  overflow: "hidden",
                  background: "rgba(4,12,8,0.65)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 11,
                    opacity: 0.75,
                    padding: "8px 10px",
                    borderBottom: "1px solid rgba(255,255,255,0.1)",
                    letterSpacing: "0.08em",
                  }}
                >
                  <span>outcome preview</span>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <button
                      onClick={() => setPreviewReloadKey((prev) => prev + 1)}
                      style={{
                        border: "1px solid rgba(107,255,142,0.32)",
                        borderRadius: 8,
                        background: "transparent",
                        color: "#d8ffe4",
                        padding: "4px 7px",
                        fontSize: 10,
                        cursor: "pointer",
                      }}
                    >
                      refresh
                    </button>
                    <button
                      onClick={() => setPreviewAutoRefresh((prev) => !prev)}
                      style={{
                        border: "1px solid rgba(107,255,142,0.32)",
                        borderRadius: 8,
                        background: "transparent",
                        color: "#d8ffe4",
                        padding: "4px 7px",
                        fontSize: 10,
                        cursor: "pointer",
                      }}
                    >
                      auto: {previewAutoRefresh ? "on" : "off"}
                    </button>
                    <button
                      onClick={openPreviewInNewTab}
                      style={{
                        border: "1px solid rgba(107,255,142,0.32)",
                        borderRadius: 8,
                        background: "transparent",
                        color: "#d8ffe4",
                        padding: "4px 7px",
                        fontSize: 10,
                        cursor: "pointer",
                      }}
                    >
                      open tab
                    </button>
                  </div>
                </div>
                <iframe
                  key={`${selectedSpaceId || "none"}:${previewReloadKey}`}
                  title="build outcome"
                  sandbox="allow-scripts"
                  srcDoc={previewDoc}
                  style={{
                    width: "100%",
                    height: 260,
                    border: "none",
                    background: "#fff",
                  }}
                />
              </div>

              <div style={{ marginTop: 14, fontSize: 12, opacity: 0.74, letterSpacing: "0.1em" }}>
                builder Axy
              </div>
              <div
                ref={axyScrollRef}
                style={{
                  marginTop: 8,
                  border: "1px solid rgba(107,255,142,0.2)",
                  background: "rgba(4,16,9,0.68)",
                  borderRadius: 10,
                  padding: "10px 12px",
                  maxHeight: 190,
                  overflowY: "auto",
                  display: "grid",
                  gap: 8,
                }}
              >
                {axyTurns.map((turn) => (
                  <div
                    key={turn.id}
                    style={{ fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap" }}
                  >
                    <span style={{ opacity: 0.6, marginRight: 6 }}>
                      {turn.role === "assistant" ? "Axy:" : "you:"}
                    </span>
                    {turn.content}
                  </div>
                ))}
                {axyLoading ? <div style={{ fontSize: 12, opacity: 0.6 }}>Axy is thinking...</div> : null}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <input
                  value={axyInput}
                  onChange={(e) => setAxyInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void askBuilderAxy();
                  }}
                  placeholder="ask Axy to build with you..."
                  style={{
                    flex: 1,
                    border: "1px solid rgba(125,255,160,0.22)",
                    background: "rgba(10,28,16,0.48)",
                    color: "#eaeaea",
                    padding: "9px 10px",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
                <button
                  onClick={askBuilderAxy}
                  disabled={axyLoading}
                  style={{
                    border: "1px solid rgba(107,255,142,0.42)",
                    background: "rgba(107,255,142,0.18)",
                    color: "#b8ffd1",
                    borderRadius: 8,
                    padding: "9px 12px",
                    cursor: axyLoading ? "default" : "pointer",
                    fontSize: 12,
                  }}
                >
                  {axyLoading ? "..." : "ask"}
                </button>
              </div>
            </section>
          </div>
        </section>
      )}
      </div>
    </main>
  );
}
