"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import { useRouter, useParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

type BuildFile = {
  id: string;
  path: string;
  language: string;
  content: string;
};

type SpaceInfo = {
  id: string;
  title: string;
  owner_id: string;
  is_public: boolean;
};

function injectPreviewRuntimeBridge(
  doc: string,
  spaceId: string,
  accessToken: string,
  apiBase: string
) {
  const safeSpaceId = JSON.stringify(spaceId);
  const safeToken = JSON.stringify(accessToken);
  const safeApiBase = JSON.stringify(apiBase.replace(/\/+$/, ""));
  const bridgeScript = [
    "<script>",
    "(function () {",
    `  const __SPACE_ID__ = ${safeSpaceId};`,
    `  const __TOKEN__ = ${safeToken};`,
    `  const __API_BASE__ = ${safeApiBase};`,
    "  async function req(url, init) {",
    "    const headers = new Headers((init && init.headers) || {});",
    "    headers.set('Authorization', 'Bearer ' + __TOKEN__);",
    "    if (init && init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');",
    "    const target = String(url || '').startsWith('http') ? String(url) : (__API_BASE__ + String(url || ''));",
    "    const res = await fetch(target, { ...(init || {}), headers });",
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
    "    },",
    "    starter: {",
    "      _tokenKey: 'kozmos:starterToken:' + __SPACE_ID__,",
    "      _getToken: function () {",
    "        try { return localStorage.getItem(this._tokenKey) || ''; } catch { return ''; }",
    "      },",
    "      _setToken: function (token) {",
    "        try {",
    "          if (token) localStorage.setItem(this._tokenKey, String(token));",
    "          else localStorage.removeItem(this._tokenKey);",
    "        } catch {}",
    "      },",
    "      auth: {",
    "        register: async function (username, password, displayName, profile) {",
    "          const res = await req('/api/build/runtime/starter/auth', { method: 'POST', body: JSON.stringify({ action: 'register', spaceId: __SPACE_ID__, username: String(username || ''), password: String(password || ''), displayName: String(displayName || ''), profile: (profile && typeof profile === 'object') ? profile : {} }) });",
    "          if (res && res.starterToken) window.KozmosRuntime.starter._setToken(res.starterToken);",
    "          return res;",
    "        },",
    "        login: async function (username, password) {",
    "          const res = await req('/api/build/runtime/starter/auth', { method: 'POST', body: JSON.stringify({ action: 'login', spaceId: __SPACE_ID__, username: String(username || ''), password: String(password || '') }) });",
    "          if (res && res.starterToken) window.KozmosRuntime.starter._setToken(res.starterToken);",
    "          return res;",
    "        },",
    "        me: async function () {",
    "          const q = new URLSearchParams({ spaceId: __SPACE_ID__ });",
    "          const token = window.KozmosRuntime.starter._getToken();",
    "          return req('/api/build/runtime/starter/auth?' + q.toString(), { method: 'GET', headers: token ? { 'x-kozmos-starter-token': token } : {} });",
    "        },",
    "        logout: async function () {",
    "          const token = window.KozmosRuntime.starter._getToken();",
    "          const res = await req('/api/build/runtime/starter/auth', { method: 'POST', headers: token ? { 'x-kozmos-starter-token': token } : {}, body: JSON.stringify({ action: 'logout', spaceId: __SPACE_ID__ }) });",
    "          window.KozmosRuntime.starter._setToken('');",
    "          return res;",
    "        }",
    "      },",
    "      posts: {",
    "        list: async function (input) {",
    "          const payload = (input && typeof input === 'object') ? input : {};",
    "          const q = new URLSearchParams({ spaceId: __SPACE_ID__ });",
    "          if (Number.isFinite(Number(payload.limit))) q.set('limit', String(Math.round(Number(payload.limit))));",
    "          if (Number.isFinite(Number(payload.beforeId))) q.set('beforeId', String(Math.round(Number(payload.beforeId))));",
    "          const token = window.KozmosRuntime.starter._getToken();",
    "          return req('/api/build/runtime/starter/posts?' + q.toString(), { method: 'GET', headers: token ? { 'x-kozmos-starter-token': token } : {} });",
    "        },",
    "        create: async function (body, meta) {",
    "          const token = window.KozmosRuntime.starter._getToken();",
    "          return req('/api/build/runtime/starter/posts', { method: 'POST', headers: token ? { 'x-kozmos-starter-token': token } : {}, body: JSON.stringify({ spaceId: __SPACE_ID__, body: String(body || ''), meta: (meta && typeof meta === 'object') ? meta : {} }) });",
    "        },",
    "        delete: async function (postId) {",
    "          const token = window.KozmosRuntime.starter._getToken();",
    "          return req('/api/build/runtime/starter/posts', { method: 'DELETE', headers: token ? { 'x-kozmos-starter-token': token } : {}, body: JSON.stringify({ spaceId: __SPACE_ID__, postId: Number(postId) }) });",
    "        },",
    "        like: async function (postId) {",
    "          const token = window.KozmosRuntime.starter._getToken();",
    "          return req('/api/build/runtime/starter/likes', { method: 'POST', headers: token ? { 'x-kozmos-starter-token': token } : {}, body: JSON.stringify({ spaceId: __SPACE_ID__, postId: Number(postId) }) });",
    "        },",
    "        unlike: async function (postId) {",
    "          const token = window.KozmosRuntime.starter._getToken();",
    "          return req('/api/build/runtime/starter/likes', { method: 'DELETE', headers: token ? { 'x-kozmos-starter-token': token } : {}, body: JSON.stringify({ spaceId: __SPACE_ID__, postId: Number(postId) }) });",
    "        }",
    "      },",
    "      comments: {",
    "        list: async function (postId, input) {",
    "          const payload = (input && typeof input === 'object') ? input : {};",
    "          const q = new URLSearchParams({ spaceId: __SPACE_ID__, postId: String(postId || '') });",
    "          if (Number.isFinite(Number(payload.limit))) q.set('limit', String(Math.round(Number(payload.limit))));",
    "          if (Number.isFinite(Number(payload.offset))) q.set('offset', String(Math.round(Number(payload.offset))));",
    "          const token = window.KozmosRuntime.starter._getToken();",
    "          return req('/api/build/runtime/starter/comments?' + q.toString(), { method: 'GET', headers: token ? { 'x-kozmos-starter-token': token } : {} });",
    "        },",
    "        create: async function (postId, body) {",
    "          const token = window.KozmosRuntime.starter._getToken();",
    "          return req('/api/build/runtime/starter/comments', { method: 'POST', headers: token ? { 'x-kozmos-starter-token': token } : {}, body: JSON.stringify({ spaceId: __SPACE_ID__, postId: Number(postId), body: String(body || '') }) });",
    "        },",
    "        delete: async function (commentId) {",
    "          const token = window.KozmosRuntime.starter._getToken();",
    "          return req('/api/build/runtime/starter/comments', { method: 'DELETE', headers: token ? { 'x-kozmos-starter-token': token } : {}, body: JSON.stringify({ spaceId: __SPACE_ID__, commentId: Number(commentId) }) });",
    "        }",
    "      },",
    "      dm: {",
    "        threads: async function () {",
    "          const q = new URLSearchParams({ spaceId: __SPACE_ID__ });",
    "          const token = window.KozmosRuntime.starter._getToken();",
    "          return req('/api/build/runtime/starter/dm/threads?' + q.toString(), { method: 'GET', headers: token ? { 'x-kozmos-starter-token': token } : {} });",
    "        },",
    "        messagesList: async function (threadId, input) {",
    "          const payload = (input && typeof input === 'object') ? input : {};",
    "          const q = new URLSearchParams({ spaceId: __SPACE_ID__, threadId: String(threadId || '') });",
    "          if (Number.isFinite(Number(payload.limit))) q.set('limit', String(Math.round(Number(payload.limit))));",
    "          if (payload.before) q.set('before', String(payload.before));",
    "          const token = window.KozmosRuntime.starter._getToken();",
    "          return req('/api/build/runtime/starter/dm/messages?' + q.toString(), { method: 'GET', headers: token ? { 'x-kozmos-starter-token': token } : {} });",
    "        },",
    "        messagesSend: async function (threadId, body, metadata) {",
    "          const token = window.KozmosRuntime.starter._getToken();",
    "          return req('/api/build/runtime/starter/dm/messages', { method: 'POST', headers: token ? { 'x-kozmos-starter-token': token } : {}, body: JSON.stringify({ spaceId: __SPACE_ID__, threadId: String(threadId || ''), body: String(body || ''), metadata: (metadata && typeof metadata === 'object') ? metadata : {} }) });",
    "        }",
    "      },",
    "      friends: {",
    "        list: async function () {",
    "          const q = new URLSearchParams({ spaceId: __SPACE_ID__ });",
    "          const token = window.KozmosRuntime.starter._getToken();",
    "          return req('/api/build/runtime/starter/friends?' + q.toString(), { method: 'GET', headers: token ? { 'x-kozmos-starter-token': token } : {} });",
    "        },",
    "        add: async function (username) {",
    "          const token = window.KozmosRuntime.starter._getToken();",
    "          return req('/api/build/runtime/starter/friends', { method: 'POST', headers: token ? { 'x-kozmos-starter-token': token } : {}, body: JSON.stringify({ spaceId: __SPACE_ID__, username: String(username || '') }) });",
    "        },",
    "        remove: async function (username) {",
    "          const token = window.KozmosRuntime.starter._getToken();",
    "          return req('/api/build/runtime/starter/friends', { method: 'DELETE', headers: token ? { 'x-kozmos-starter-token': token } : {}, body: JSON.stringify({ spaceId: __SPACE_ID__, username: String(username || '') }) });",
    "        }",
    "      }",
    "    },",
    "    auth: {},",
    "    posts: {},",
    "    comments: {},",
    "    dm: {},",
    "    friends: {}",
    "  };",
    "  // Aliases for simpler access",
    "  window.KozmosRuntime.auth = window.KozmosRuntime.starter.auth;",
    "  window.KozmosRuntime.posts = window.KozmosRuntime.starter.posts;",
    "  window.KozmosRuntime.comments = window.KozmosRuntime.starter.comments;",
    "  window.KozmosRuntime.dm = window.KozmosRuntime.starter.dm;",
    "  window.KozmosRuntime.friends = window.KozmosRuntime.starter.friends;",
    "})();",
    "</script>",
  ].join("\n");

  if (/<head[^>]*>/i.test(doc)) {
    return doc.replace(/<head[^>]*>/i, `$&\n${bridgeScript}`);
  }
  if (/<html[^>]*>/i.test(doc)) {
    return doc.replace(/<html[^>]*>/i, `$&\n<head>${bridgeScript}</head>`);
  }
  return `${bridgeScript}\n${doc}`;
}

export default function BuildViewPage() {
  const router = useRouter();
  const params = useParams();
  const spaceId = typeof params.spaceId === "string" ? params.spaceId : "";
  const bootedRef = useRef(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [space, setSpace] = useState<SpaceInfo | null>(null);
  const [files, setFiles] = useState<BuildFile[]>([]);
  const [accessToken, setAccessToken] = useState("");
  const [apiBase, setApiBase] = useState("");
  const [canEdit, setCanEdit] = useState(false);
  const [username, setUsername] = useState("");

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;

    async function loadData() {
      if (!spaceId) {
        setError("no space id");
        setLoading(false);
        return;
      }

      const {
        data: { session },
      } = await supabase.auth.getSession();

    if (!session?.user) {
      router.push("/login");
      return;
    }

    setAccessToken(session.access_token);
    setApiBase(window.location.origin);

    // Get username
    const { data: profileData } = await supabase
      .from("profiles")
      .select("username")
      .eq("id", session.user.id)
      .maybeSingle();
    setUsername(profileData?.username || "");

    const headers = new Headers();
    headers.set("Authorization", `Bearer ${session.access_token}`);
    headers.set("Content-Type", "application/json");

    // Load space info
    const spaceRes = await fetch(
      `/api/build/spaces?action=list`,
      { method: "GET", headers }
    );
    const spaceData = await spaceRes.json();
    const foundSpace = (spaceData?.spaces || []).find(
      (s: SpaceInfo) => s.id === spaceId
    );

    if (!foundSpace) {
      setError("space not found or no access");
      setLoading(false);
      return;
    }

    setSpace(foundSpace);
    setCanEdit(foundSpace.owner_id === session.user.id || foundSpace.can_edit === true);

    // Load files
    const filesRes = await fetch(
      `/api/build/files?spaceId=${encodeURIComponent(spaceId)}`,
      { method: "GET", headers }
    );
    const filesData = await filesRes.json();
    setFiles(filesData?.files || []);
    setLoading(false);
    }

    loadData();
  }, [spaceId, router]);

  const previewDoc = useMemo(() => {
    const htmlFile =
      files.find((file) => /(^|\/)index\.html$/i.test(file.path)) ||
      files.find((file) => /\.html?$/i.test(file.path));
    const css = files
      .filter((file) => /\.css$/i.test(file.path))
      .map((file) => file.content || "")
      .join("\n\n");
    const js = files
      .filter((file) => /\.js$/i.test(file.path))
      .map((file) => file.content || "")
      .join("\n\n");

    let doc = "";
    if (!htmlFile) {
      doc = `<!doctype html><html><body style="margin:0;padding:18px;background:#0b0b0b;color:#eaeaea;font-family:system-ui,sans-serif;">
<h3 style="margin:0 0 8px;">No HTML entry found</h3>
<p style="opacity:.75;">This space has no index.html file.</p>
</body></html>`;
    } else {
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
    }

    if (spaceId && accessToken && apiBase) {
      return injectPreviewRuntimeBridge(doc, spaceId, accessToken, apiBase);
    }
    return doc;
  }, [files, spaceId, accessToken, apiBase]);

  function goToEditor() {
    router.push(`/build?spaceId=${encodeURIComponent(spaceId)}`);
  }

  function goBack() {
    router.back();
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/");
  }

  if (loading) {
    return (
      <main style={{ minHeight: "100vh", background: "#0b0b0b", color: "#eaeaea", padding: 24 }}>
        loading...
      </main>
    );
  }

  if (error) {
    return (
      <main style={{ minHeight: "100vh", background: "#0b0b0b", color: "#eaeaea", padding: 24 }}>
        <div style={{ marginBottom: 16 }}>{error}</div>
        <button
          onClick={goBack}
          style={{
            border: "1px solid rgba(107,255,142,0.4)",
            background: "rgba(107,255,142,0.12)",
            color: "#b8ffd1",
            borderRadius: 8,
            padding: "8px 14px",
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          go back
        </button>
      </main>
    );
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#060a07",
        color: "#eaeaea",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "12px 18px",
          borderBottom: "1px solid rgba(107,255,142,0.12)",
          background: "rgba(4,12,8,0.9)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span
            style={{ cursor: "pointer", opacity: 0.7, fontSize: 13 }}
            onClick={goBack}
          >
            ← back
          </span>
          <span style={{ fontSize: 14, fontWeight: 500 }}>
            {space?.title || "subspace"}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {canEdit && (
            <button
              onClick={goToEditor}
              style={{
                border: "1px solid rgba(107,255,142,0.45)",
                background: "rgba(107,255,142,0.14)",
                color: "#b8ffd1",
                borderRadius: 6,
                padding: "6px 12px",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              edit
            </button>
          )}
          <span
            style={{ cursor: "pointer", fontSize: 13, opacity: 0.8 }}
            onClick={() => router.push("/account")}
          >
            {username}
          </span>
          <span
            style={{ cursor: "pointer", fontSize: 13, opacity: 0.6 }}
            onClick={handleLogout}
          >
            logout
          </span>
        </div>
      </div>

      {/* Preview iframe - full screen */}
      <iframe
        title="subspace view"
        sandbox="allow-scripts allow-same-origin allow-forms"
        srcDoc={previewDoc}
        style={{
          flex: 1,
          width: "100%",
          border: "none",
          background: "#fff",
        }}
      />
    </main>
  );
}
