"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

type BuildSpace = {
  id: string;
  owner_id: string;
  title: string;
  is_public: boolean;
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

type AccessEntry = {
  userId: string;
  username: string;
  canEdit: boolean;
};

const LANGUAGE_OPTIONS = ["text", "ts", "tsx", "js", "json", "md", "sql", "py"];

export default function BuildPage() {
  const router = useRouter();

  const [userId, setUserId] = useState<string | null>(null);
  const [username, setUsername] = useState("user");
  const [bootLoading, setBootLoading] = useState(true);

  const [spaces, setSpaces] = useState<BuildSpace[]>([]);
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null);
  const [newSpaceTitle, setNewSpaceTitle] = useState("");
  const [creatingSpace, setCreatingSpace] = useState(false);

  const [files, setFiles] = useState<BuildFile[]>([]);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [newFilePath, setNewFilePath] = useState("");
  const [creatingFile, setCreatingFile] = useState(false);
  const [savingFile, setSavingFile] = useState(false);
  const [editorContent, setEditorContent] = useState("");
  const [editorLanguage, setEditorLanguage] = useState("text");

  const [axyInput, setAxyInput] = useState("");
  const [axyReply, setAxyReply] = useState<string | null>(null);
  const [axyLoading, setAxyLoading] = useState(false);

  const [errorText, setErrorText] = useState<string | null>(null);
  const [canEditSelectedSpace, setCanEditSelectedSpace] = useState(false);
  const [accessEntries, setAccessEntries] = useState<AccessEntry[]>([]);
  const [accessLoading, setAccessLoading] = useState(false);
  const [shareSaving, setShareSaving] = useState(false);
  const [grantUsername, setGrantUsername] = useState("");
  const [grantMode, setGrantMode] = useState<"use" | "edit">("use");
  const [grantLoading, setGrantLoading] = useState(false);

  const selectedFile = useMemo(
    () => files.find((f) => f.path === selectedFilePath) ?? null,
    [files, selectedFilePath]
  );
  const selectedSpace = useMemo(
    () => spaces.find((s) => s.id === selectedSpaceId) ?? null,
    [selectedSpaceId, spaces]
  );
  const isOwnerSelectedSpace = Boolean(
    userId && selectedSpace && selectedSpace.owner_id === userId
  );

  const fetchAuthedJson = useCallback(
    async (url: string, init?: RequestInit) => {
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
    },
    []
  );

  const loadSpaces = useCallback(async () => {
    if (!userId) return;
    const { res, data } = await fetchAuthedJson("/api/build/spaces");
    if (!res.ok) {
      if (res.status === 401) router.push("/login");
      setErrorText(data?.error || "failed to load subspaces");
      return;
    }
    setErrorText((prev) =>
      prev && /(subspace|load spaces|load subspaces)/i.test(prev) ? null : prev
    );

    const nextSpaces = (Array.isArray(data?.spaces) ? data.spaces : []) as BuildSpace[];
    setSpaces(nextSpaces);
    setSelectedSpaceId((prev) => {
      if (!prev && nextSpaces.length > 0) return nextSpaces[0].id;
      if (prev && !nextSpaces.some((space) => space.id === prev)) {
        return nextSpaces[0]?.id ?? null;
      }
      return prev;
    });
  }, [fetchAuthedJson, router, userId]);

  const loadFiles = useCallback(async (spaceId: string) => {
    const { res, data } = await fetchAuthedJson(
      `/api/build/files?spaceId=${encodeURIComponent(spaceId)}`
    );
    if (!res.ok) {
      if (res.status === 401) router.push("/login");
      setErrorText(data?.error || "failed to load files");
      return;
    }
    setErrorText((prev) =>
      prev && /(load files|save file|create file)/i.test(prev) ? null : prev
    );

    const nextFiles = (Array.isArray(data?.files) ? data.files : []) as BuildFile[];
    setFiles(nextFiles);
    setCanEditSelectedSpace(Boolean(data?.canEdit || data?.isOwner));
    setSelectedFilePath((prev) => {
      if (!prev && nextFiles.length > 0) return nextFiles[0].path;
      if (prev && !nextFiles.some((file) => file.path === prev)) {
        return nextFiles[0]?.path ?? null;
      }
      return prev;
    });
  }, [fetchAuthedJson, router]);

  const loadAccessEntries = useCallback(async (spaceId: string) => {
    setAccessLoading(true);
    const {
      data: { session },
    } = await supabase.auth.getSession();

    const res = await fetch(`/api/build/access?spaceId=${encodeURIComponent(spaceId)}`, {
      headers: {
        ...(session?.access_token
          ? { Authorization: `Bearer ${session.access_token}` }
          : {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    setAccessLoading(false);

    if (!res.ok) {
      setAccessEntries([]);
      return;
    }

    setAccessEntries(Array.isArray(data?.entries) ? data.entries : []);
  }, []);

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

      const { data: profile } = await supabase
        .from("profileskozmos")
        .select("username")
        .eq("id", user.id)
        .maybeSingle();
      if (profile?.username) setUsername(profile.username);

      setBootLoading(false);
    }

    void boot();
  }, [router]);

  useEffect(() => {
    if (!userId || bootLoading) return;
    const timer = window.setTimeout(() => {
      void loadSpaces();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [bootLoading, loadSpaces, userId]);

  useEffect(() => {
    if (!selectedSpaceId || !userId || !selectedSpace) {
      const timer = window.setTimeout(() => {
        setCanEditSelectedSpace(false);
        setAccessEntries([]);
      }, 0);
      return () => window.clearTimeout(timer);
    }

    const timer = window.setTimeout(() => {
      void (async () => {
        if (selectedSpace.owner_id === userId) {
          setCanEditSelectedSpace(true);
          await loadAccessEntries(selectedSpaceId);
          return;
        }
        setAccessEntries([]);
      })();
    }, 0);

    return () => window.clearTimeout(timer);
  }, [
    loadAccessEntries,
    selectedSpace,
    selectedSpaceId,
    userId,
  ]);

  useEffect(() => {
    if (!selectedSpaceId) {
      const timer = window.setTimeout(() => {
        setFiles([]);
        setSelectedFilePath(null);
        setEditorContent("");
        setEditorLanguage("text");
      }, 0);
      return () => window.clearTimeout(timer);
    }

    const timer = window.setTimeout(() => {
      void loadFiles(selectedSpaceId);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadFiles, selectedSpaceId]);

  useEffect(() => {
    if (!selectedFile) {
      const timer = window.setTimeout(() => {
        setEditorContent("");
        setEditorLanguage("text");
      }, 0);
      return () => window.clearTimeout(timer);
    }

    const timer = window.setTimeout(() => {
      setEditorContent(selectedFile.content || "");
      setEditorLanguage(selectedFile.language || "text");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [selectedFile]);

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/");
  }

  async function createSubspace() {
    if (!userId) return;
    const title = newSpaceTitle.trim() || `subspace ${spaces.length + 1}`;
    setCreatingSpace(true);
    setErrorText(null);
    try {
      const { res, data } = await fetchAuthedJson("/api/build/spaces", {
        method: "POST",
        body: JSON.stringify({ title }),
      });

      if (!res.ok || !data?.space?.id) {
        if (res.status === 401) router.push("/login");
        setErrorText(data?.error || "could not create subspace");
        return;
      }

      setNewSpaceTitle("");
      await loadSpaces();
      setSelectedSpaceId(data.space.id as string);
    } catch {
      setErrorText("could not create subspace");
    } finally {
      setCreatingSpace(false);
    }
  }

  async function togglePublicShare() {
    if (!selectedSpaceId || !isOwnerSelectedSpace || !selectedSpace) return;
    setShareSaving(true);
    setErrorText(null);
    try {
      const { res, data } = await fetchAuthedJson("/api/build/spaces", {
        method: "PATCH",
        body: JSON.stringify({
          spaceId: selectedSpaceId,
          isPublic: !selectedSpace.is_public,
        }),
      });

      if (!res.ok) {
        if (res.status === 401) router.push("/login");
        setErrorText(data?.error || "share update failed");
        return;
      }

      await loadSpaces();
    } catch {
      setErrorText("share update failed");
    } finally {
      setShareSaving(false);
    }
  }

  async function grantAccess() {
    if (!selectedSpaceId || !isOwnerSelectedSpace) return;
    const username = grantUsername.trim();
    if (!username) return;

    setGrantLoading(true);
    setErrorText(null);

    const {
      data: { session },
    } = await supabase.auth.getSession();

    const res = await fetch("/api/build/access", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(session?.access_token
          ? { Authorization: `Bearer ${session.access_token}` }
          : {}),
      },
      body: JSON.stringify({
        spaceId: selectedSpaceId,
        username,
        canEdit: grantMode === "edit",
      }),
    });
    const data = await res.json().catch(() => ({}));
    setGrantLoading(false);

    if (!res.ok) {
      setErrorText(data?.error || "grant failed");
      return;
    }

    setGrantUsername("");
    await loadAccessEntries(selectedSpaceId);
  }

  async function revokeAccess(username: string) {
    if (!selectedSpaceId || !isOwnerSelectedSpace) return;

    setGrantLoading(true);
    setErrorText(null);

    const {
      data: { session },
    } = await supabase.auth.getSession();

    const res = await fetch("/api/build/access", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        ...(session?.access_token
          ? { Authorization: `Bearer ${session.access_token}` }
          : {}),
      },
      body: JSON.stringify({
        spaceId: selectedSpaceId,
        username,
      }),
    });
    const data = await res.json().catch(() => ({}));
    setGrantLoading(false);

    if (!res.ok) {
      setErrorText(data?.error || "revoke failed");
      return;
    }

    await loadAccessEntries(selectedSpaceId);
  }

  async function createFile() {
    if (!selectedSpaceId || !userId) return;
    const normalized = newFilePath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (!normalized) return;

    setCreatingFile(true);
    setErrorText(null);
    try {
      const { res, data } = await fetchAuthedJson("/api/build/files", {
        method: "POST",
        body: JSON.stringify({
          spaceId: selectedSpaceId,
          path: normalized,
          language: "text",
        }),
      });

      if (!res.ok) {
        if (res.status === 401) router.push("/login");
        setErrorText(data?.error || "could not create file");
        return;
      }

      setNewFilePath("");
      await loadFiles(selectedSpaceId);
      setSelectedFilePath(normalized);
    } catch {
      setErrorText("could not create file");
    } finally {
      setCreatingFile(false);
    }
  }

  async function saveActiveFile() {
    if (!selectedSpaceId || !selectedFilePath || !userId) return;
    setSavingFile(true);
    setErrorText(null);
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
        if (res.status === 401) router.push("/login");
        setErrorText(data?.error || "save failed");
        return;
      }

      await loadFiles(selectedSpaceId);
    } catch {
      setErrorText("save failed");
    } finally {
      setSavingFile(false);
    }
  }

  async function askBuilderAxy() {
    const message = axyInput.trim();
    if (!message) return;

    setAxyLoading(true);
    setAxyReply(null);
    setErrorText(null);
    setAxyInput("");

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      const res = await fetch("/api/build/axy", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token
            ? { Authorization: `Bearer ${session.access_token}` }
            : {}),
        },
        body: JSON.stringify({
          message,
          spaceId: selectedSpaceId,
          activeFilePath: selectedFilePath,
          activeFileContent: editorContent,
          activeFileLanguage: editorLanguage,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setAxyReply(data?.error ? `error: ${data.error}` : "error");
      } else {
        setAxyReply(data.reply || "...");
      }
    } catch {
      setAxyReply("...");
    }

    setAxyLoading(false);
  }

  if (bootLoading) {
    return (
      <main style={{ minHeight: "100vh", background: "#0b0b0b", color: "#eaeaea", padding: 28 }}>
        loading build lane...
      </main>
    );
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#0b0b0b",
        color: "#eaeaea",
        padding: "18px 18px 28px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, opacity: 0.72 }}>
        <div>
          <span style={{ cursor: "pointer" }} onClick={() => router.push("/main")}>
            main
          </span>
          {" / "}
          <span style={{ cursor: "pointer" }} onClick={() => router.refresh()}>
            user build
          </span>
        </div>
        <div>
          {username} /{" "}
          <span style={{ cursor: "pointer" }} onClick={handleLogout}>
            logout
          </span>
        </div>
      </div>

      <div style={{ marginTop: 20, marginBottom: 14, opacity: 0.78, letterSpacing: "0.14em" }}>
        user🔨build
      </div>

      <div className="build-shell">
        <aside
          className="build-sidebar"
          style={{
            border: "1px solid rgba(255,230,170,0.24)",
            borderRadius: 12,
            padding: 12,
            background: "linear-gradient(180deg, rgba(28,22,12,0.9), rgba(16,12,8,0.78))",
            boxShadow: "0 0 22px rgba(255,230,170,0.15)",
          }}
        >
          <div style={{ fontSize: 12, letterSpacing: "0.1em", opacity: 0.7 }}>subspaces</div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <input
              value={newSpaceTitle}
              onChange={(e) => setNewSpaceTitle(e.target.value)}
              placeholder="new subspace title"
              style={{
                flex: 1,
                border: "1px solid rgba(255,255,255,0.2)",
                background: "rgba(255,255,255,0.04)",
                color: "#eaeaea",
                padding: "8px 10px",
                borderRadius: 8,
                fontSize: 12,
              }}
            />
            <button
              onClick={createSubspace}
              disabled={creatingSpace}
              style={{
                border: "1px solid rgba(255,230,170,0.45)",
                background: "rgba(255,230,170,0.12)",
                color: "#f5e4b8",
                borderRadius: 8,
                padding: "8px 10px",
                cursor: creatingSpace ? "default" : "pointer",
                fontSize: 12,
              }}
            >
              {creatingSpace ? "..." : "create"}
            </button>
          </div>

          <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
            {spaces.length === 0 ? (
              <div style={{ fontSize: 11, opacity: 0.5 }}>no subspaces yet</div>
            ) : (
              spaces.map((space) => (
                <button
                  key={space.id}
                  onClick={() => setSelectedSpaceId(space.id)}
                  style={{
                    textAlign: "left",
                    border: "1px solid rgba(255,255,255,0.16)",
                    background:
                      selectedSpaceId === space.id
                        ? "rgba(255,230,170,0.2)"
                        : "rgba(255,255,255,0.04)",
                    color: "#eaeaea",
                    borderRadius: 8,
                    padding: "8px 10px",
                    cursor: "pointer",
                    fontSize: 12,
                  }}
                >
                  {space.title}
                  <span style={{ marginLeft: 8, opacity: 0.45, fontSize: 10 }}>
                    {space.owner_id === userId
                      ? "mine"
                      : space.is_public
                        ? "public"
                        : "shared"}
                  </span>
                </button>
              ))
            )}
          </div>

          <div style={{ marginTop: 16, fontSize: 12, letterSpacing: "0.1em", opacity: 0.7 }}>files</div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <input
              value={newFilePath}
              onChange={(e) => setNewFilePath(e.target.value)}
              placeholder="src/main.ts"
              style={{
                flex: 1,
                border: "1px solid rgba(255,255,255,0.2)",
                background: "rgba(255,255,255,0.04)",
                color: "#eaeaea",
                padding: "8px 10px",
                borderRadius: 8,
                fontSize: 12,
              }}
            />
            <button
              onClick={createFile}
              disabled={!selectedSpaceId || creatingFile || !canEditSelectedSpace}
              style={{
                border: "1px solid rgba(255,230,170,0.45)",
                background: "rgba(255,230,170,0.12)",
                color: "#f5e4b8",
                borderRadius: 8,
                padding: "8px 10px",
                cursor:
                  !selectedSpaceId || creatingFile || !canEditSelectedSpace
                    ? "default"
                    : "pointer",
                fontSize: 12,
              }}
            >
              {creatingFile ? "..." : "add"}
            </button>
          </div>
          {!canEditSelectedSpace && selectedSpaceId ? (
            <div style={{ marginTop: 6, fontSize: 11, opacity: 0.56 }}>
              read-only access
            </div>
          ) : null}

          <div style={{ marginTop: 10, display: "grid", gap: 6, maxHeight: 260, overflowY: "auto" }}>
            {files.length === 0 ? (
              <div style={{ fontSize: 11, opacity: 0.5 }}>no files yet</div>
            ) : (
              files.map((file) => (
                <button
                  key={file.id}
                  onClick={() => setSelectedFilePath(file.path)}
                  style={{
                    textAlign: "left",
                    border: "1px solid rgba(255,255,255,0.16)",
                    background:
                      selectedFilePath === file.path
                        ? "rgba(255,230,170,0.2)"
                        : "rgba(255,255,255,0.04)",
                    color: "#eaeaea",
                    borderRadius: 8,
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
          className="build-main"
          style={{
            border: "1px solid rgba(255,255,255,0.16)",
            borderRadius: 12,
            padding: 12,
            background: "rgba(255,255,255,0.03)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
            <div style={{ fontSize: 12, opacity: 0.72 }}>
              {selectedFilePath || "select or create a file"}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <select
                value={editorLanguage}
                onChange={(e) => setEditorLanguage(e.target.value)}
                style={{
                  border: "1px solid rgba(255,255,255,0.2)",
                  background: "rgba(255,255,255,0.04)",
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
                onClick={saveActiveFile}
                disabled={!selectedFilePath || savingFile || !canEditSelectedSpace}
                style={{
                  border: "1px solid rgba(255,230,170,0.45)",
                  background: "rgba(255,230,170,0.12)",
                  color: "#f5e4b8",
                  borderRadius: 8,
                  padding: "7px 10px",
                  cursor:
                    !selectedFilePath || savingFile || !canEditSelectedSpace
                      ? "default"
                      : "pointer",
                  fontSize: 12,
                }}
              >
                {savingFile ? "saving..." : "save file"}
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
              minHeight: 330,
              marginTop: 10,
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.18)",
              background: "rgba(0,0,0,0.28)",
              color: "#eaeaea",
              padding: 12,
              fontSize: 13,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              lineHeight: 1.45,
              resize: "vertical",
              opacity: canEditSelectedSpace ? 1 : 0.76,
            }}
          />

          <div
            style={{
              marginTop: 12,
              border: "1px solid rgba(255,230,170,0.24)",
              borderRadius: 10,
              padding: 10,
              background: "rgba(255,230,170,0.04)",
            }}
          >
            <div style={{ fontSize: 12, opacity: 0.72, marginBottom: 8 }}>
              permissions
            </div>
            {selectedSpace ? (
              <>
                <div style={{ fontSize: 11, opacity: 0.64 }}>
                  owner: {selectedSpace.owner_id === userId ? "you" : "other user"}
                </div>
                <div style={{ marginTop: 6, fontSize: 11, opacity: 0.64 }}>
                  mode: {canEditSelectedSpace ? "editable" : "read-only"}
                </div>
                {isOwnerSelectedSpace ? (
                  <>
                    <div style={{ marginTop: 8 }}>
                      <button
                        onClick={togglePublicShare}
                        disabled={shareSaving}
                        style={{
                          border: "1px solid rgba(255,230,170,0.45)",
                          background: "rgba(255,230,170,0.12)",
                          color: "#f5e4b8",
                          borderRadius: 8,
                          padding: "7px 10px",
                          cursor: shareSaving ? "default" : "pointer",
                          fontSize: 11,
                        }}
                      >
                        {selectedSpace.is_public ? "set private" : "set public"}
                      </button>
                    </div>

                    <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
                      <input
                        value={grantUsername}
                        onChange={(e) => setGrantUsername(e.target.value)}
                        placeholder="username"
                        style={{
                          flex: 1,
                          border: "1px solid rgba(255,255,255,0.2)",
                          background: "rgba(255,255,255,0.04)",
                          color: "#eaeaea",
                          padding: "7px 9px",
                          borderRadius: 8,
                          fontSize: 11,
                        }}
                      />
                      <select
                        value={grantMode}
                        onChange={(e) =>
                          setGrantMode(e.target.value === "edit" ? "edit" : "use")
                        }
                        style={{
                          border: "1px solid rgba(255,255,255,0.2)",
                          background: "rgba(255,255,255,0.04)",
                          color: "#eaeaea",
                          borderRadius: 8,
                          padding: "6px 8px",
                          fontSize: 11,
                        }}
                      >
                        <option value="use">use</option>
                        <option value="edit">edit</option>
                      </select>
                      <button
                        onClick={grantAccess}
                        disabled={grantLoading}
                        style={{
                          border: "1px solid rgba(255,230,170,0.45)",
                          background: "rgba(255,230,170,0.12)",
                          color: "#f5e4b8",
                          borderRadius: 8,
                          padding: "7px 10px",
                          cursor: grantLoading ? "default" : "pointer",
                          fontSize: 11,
                        }}
                      >
                        grant
                      </button>
                    </div>

                    <div style={{ marginTop: 10, fontSize: 11, opacity: 0.7 }}>
                      shared users
                    </div>
                    <div style={{ marginTop: 6, display: "grid", gap: 6 }}>
                      {accessLoading ? (
                        <div style={{ fontSize: 11, opacity: 0.5 }}>loading...</div>
                      ) : accessEntries.length === 0 ? (
                        <div style={{ fontSize: 11, opacity: 0.5 }}>none</div>
                      ) : (
                        accessEntries.map((entry) => (
                          <div
                            key={`${entry.userId}-${entry.username}`}
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              border: "1px solid rgba(255,255,255,0.14)",
                              borderRadius: 8,
                              padding: "6px 8px",
                              fontSize: 11,
                              background: "rgba(255,255,255,0.03)",
                            }}
                          >
                            <span>
                              {entry.username} · {entry.canEdit ? "edit" : "use"}
                            </span>
                            <button
                              onClick={() => revokeAccess(entry.username)}
                              disabled={grantLoading}
                              style={{
                                border: "1px solid rgba(255,255,255,0.24)",
                                background: "transparent",
                                color: "#eaeaea",
                                borderRadius: 8,
                                padding: "3px 7px",
                                cursor: grantLoading ? "default" : "pointer",
                                fontSize: 10,
                              }}
                            >
                              revoke
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  </>
                ) : null}
              </>
            ) : (
              <div style={{ fontSize: 11, opacity: 0.5 }}>no selected space</div>
            )}
          </div>

          <div style={{ marginTop: 14, opacity: 0.74, letterSpacing: "0.1em", fontSize: 12 }}>
            builder Axy
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
                border: "1px solid rgba(255,255,255,0.2)",
                background: "rgba(255,255,255,0.04)",
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
                background: "rgba(107,255,142,0.12)",
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

          {axyReply ? (
            <div
              style={{
                marginTop: 10,
                border: "1px solid rgba(107,255,142,0.2)",
                background: "rgba(8,20,12,0.72)",
                borderRadius: 10,
                padding: "10px 12px",
                fontSize: 13,
                whiteSpace: "pre-wrap",
                lineHeight: 1.5,
              }}
            >
              {axyReply}
            </div>
          ) : null}

          {errorText ? (
            <div style={{ marginTop: 10, fontSize: 12, color: "#ff9d9d" }}>{errorText}</div>
          ) : null}
        </section>
      </div>
    </main>
  );
}
