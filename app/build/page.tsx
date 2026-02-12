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

const LANGUAGE_OPTIONS = ["text", "ts", "tsx", "js", "json", "md", "sql", "py"];

type AxyTurn = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

export default function BuildPage() {
  const router = useRouter();

  const [bootLoading, setBootLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);
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
  const [errorText, setErrorText] = useState<string | null>(null);
  const [infoText, setInfoText] = useState<string | null>(null);
  const [axyInput, setAxyInput] = useState("");
  const [axyTurns, setAxyTurns] = useState<AxyTurn[]>([]);
  const [axyLoading, setAxyLoading] = useState(false);
  const axyScrollRef = useRef<HTMLDivElement | null>(null);
  const [previewAutoRefresh, setPreviewAutoRefresh] = useState(true);
  const [previewReloadKey, setPreviewReloadKey] = useState(0);

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

    if (!htmlFile) {
      return `<!doctype html><html><body style="margin:0;padding:18px;background:#0b0b0b;color:#eaeaea;font-family:system-ui,sans-serif;">
<h3 style="margin:0 0 8px;">No HTML entry found</h3>
<p style="opacity:.75;">Create <code>index.html</code> and save it to see live outcome here.</p>
</body></html>`;
    }

    let doc = htmlFile.content || "";
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
    return doc;
  }, [editorContent, editorLanguage, files, previewAutoRefresh, selectedFilePath]);

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
      await loadSpaces();
    }

    void boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

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
      style={{
        minHeight: "100vh",
        background: "#0b0b0b",
        color: "#eaeaea",
        padding: "18px 18px 28px",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 14,
          opacity: 0.72,
          marginTop: 2,
        }}
      >
        <div>
          <span style={{ cursor: "pointer" }} onClick={() => router.push("/main")}>
            main
          </span>
          {" / "}
          <span style={{ cursor: "default" }}>user build</span>
        </div>
        <div>
          {username} /{" "}
          <span style={{ cursor: "pointer" }} onClick={handleLogout}>
            logout
          </span>
        </div>
      </div>

      {!isDesktop ? (
        <section
          style={{
            marginTop: 120,
            maxWidth: 700,
            border: "1px solid rgba(255,255,255,0.16)",
            borderRadius: 12,
            padding: 18,
            background: "rgba(255,255,255,0.03)",
          }}
        >
          <div style={{ letterSpacing: "0.12em", opacity: 0.86 }}>user build</div>
          <div style={{ marginTop: 10, opacity: 0.72, lineHeight: 1.6 }}>
            user build is desktop-only for now.
            <br />
            please open this page from a desktop browser.
          </div>
        </section>
      ) : (
        <section
          style={{
            marginTop: 100,
            border: "1px solid rgba(255,255,255,0.16)",
            borderRadius: 12,
            background: "rgba(255,255,255,0.02)",
            padding: 14,
          }}
        >
          <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 12 }}>
            <aside
              style={{
                border: "1px solid rgba(255,230,170,0.22)",
                borderRadius: 10,
                padding: 10,
                background: "linear-gradient(180deg, rgba(28,22,12,0.9), rgba(16,12,8,0.8))",
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
                    border: "1px solid rgba(255,255,255,0.22)",
                    background: "rgba(255,255,255,0.04)",
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
                    border: "1px solid rgba(255,230,170,0.45)",
                    borderRadius: 8,
                    background: "rgba(255,230,170,0.12)",
                    color: "#f5e4b8",
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
                            ? "rgba(255,230,170,0.2)"
                            : "rgba(255,255,255,0.04)",
                        color: "#eaeaea",
                        padding: "8px 10px",
                        cursor: "pointer",
                        fontSize: 12,
                      }}
                    >
                      {space.title}
                      <span style={{ marginLeft: 8, opacity: 0.48, fontSize: 10 }}>
                        {space.owner_id === userId
                          ? "mine"
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
                files
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <input
                  value={newFilePath}
                  onChange={(e) => setNewFilePath(e.target.value)}
                  placeholder="src/main.ts"
                  style={{
                    flex: 1,
                    border: "1px solid rgba(255,255,255,0.22)",
                    background: "rgba(255,255,255,0.04)",
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
                    border: "1px solid rgba(255,230,170,0.45)",
                    borderRadius: 8,
                    background: "rgba(255,230,170,0.12)",
                    color: "#f5e4b8",
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
                            ? "rgba(255,230,170,0.2)"
                            : "rgba(255,255,255,0.04)",
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
                border: "1px solid rgba(255,255,255,0.16)",
                borderRadius: 10,
                padding: 12,
                background: "rgba(255,255,255,0.02)",
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
                    onClick={saveFile}
                    disabled={savingFile}
                    style={{
                      border: "1px solid rgba(255,230,170,0.45)",
                      borderRadius: 8,
                      background: "rgba(255,230,170,0.12)",
                      color: "#f5e4b8",
                      padding: "7px 10px",
                      cursor: savingFile ? "default" : "pointer",
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
                  minHeight: 460,
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
                  border: "1px solid rgba(255,255,255,0.16)",
                  borderRadius: 10,
                  overflow: "hidden",
                  background: "rgba(0,0,0,0.26)",
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
                        border: "1px solid rgba(255,255,255,0.24)",
                        borderRadius: 8,
                        background: "transparent",
                        color: "#eaeaea",
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
                        border: "1px solid rgba(255,255,255,0.24)",
                        borderRadius: 8,
                        background: "transparent",
                        color: "#eaeaea",
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
                        border: "1px solid rgba(255,255,255,0.24)",
                        borderRadius: 8,
                        background: "transparent",
                        color: "#eaeaea",
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
                  background: "rgba(8,20,12,0.5)",
                  borderRadius: 10,
                  padding: "10px 12px",
                  maxHeight: 190,
                  overflowY: "auto",
                  display: "grid",
                  gap: 8,
                }}
              >
                {axyTurns.length === 0 ? (
                  <div style={{ fontSize: 12, opacity: 0.55 }}>
                    ask Axy to build with you...
                  </div>
                ) : (
                  axyTurns.map((turn) => (
                    <div
                      key={turn.id}
                      style={{ fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap" }}
                    >
                      <span style={{ opacity: 0.6, marginRight: 6 }}>
                        {turn.role === "assistant" ? "Axy:" : "you:"}
                      </span>
                      {turn.content}
                    </div>
                  ))
                )}
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
            </section>
          </div>
        </section>
      )}
    </main>
  );
}
