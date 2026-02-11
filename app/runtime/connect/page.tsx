"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

export default function RuntimeConnectPage() {
  const params = useSearchParams();
  const code = params.get("code") || "";

  const [username, setUsername] = useState("runtime");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [claimedUser, setClaimedUser] = useState<string | null>(null);

  const hasCode = useMemo(() => code.trim().length > 0, [code]);

  async function claimInvite() {
    if (!hasCode || loading) return;

    setLoading(true);
    setError(null);
    setToken(null);
    setClaimedUser(null);

    try {
      const res = await fetch("/api/runtime/invite/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          username,
          label: "invite-claim",
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || "claim failed");
      } else {
        setToken(data.token || null);
        setClaimedUser(data?.user?.username || null);
      }
    } catch {
      setError("request failed");
    }

    setLoading(false);
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#0b0b0b",
        color: "#eaeaea",
        padding: 24,
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <div
        style={{
          width: "min(560px, 92vw)",
          border: "1px solid rgba(255,255,255,0.14)",
          borderRadius: 12,
          padding: 20,
          background: "rgba(255,255,255,0.02)",
        }}
      >
        <div style={{ fontSize: 14, letterSpacing: "0.14em", opacity: 0.8 }}>
          runtime🔗connect
        </div>

        <div
          style={{
            marginTop: 10,
            fontSize: 12,
            opacity: 0.7,
            lineHeight: 1.7,
          }}
        >
          Claim a one-time invite and get a runtime token.
        </div>

        <div style={{ marginTop: 18, fontSize: 12, opacity: 0.6 }}>
          invite code
        </div>
        <div
          style={{
            marginTop: 6,
            fontSize: 12,
            opacity: hasCode ? 0.9 : 0.45,
            wordBreak: "break-all",
            borderBottom: "1px solid rgba(255,255,255,0.18)",
            paddingBottom: 8,
          }}
        >
          {hasCode ? code : "missing code"}
        </div>

        <div style={{ marginTop: 18, fontSize: 12, opacity: 0.6 }}>
          requested username
        </div>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          style={{
            width: "100%",
            marginTop: 8,
            background: "transparent",
            border: "1px solid rgba(255,255,255,0.22)",
            color: "#eaeaea",
            padding: "10px 12px",
            outline: "none",
            borderRadius: 8,
          }}
        />

        <button
          onClick={claimInvite}
          disabled={!hasCode || loading}
          style={{
            marginTop: 16,
            border: "1px solid rgba(255,255,255,0.26)",
            borderRadius: 8,
            background: "transparent",
            color: "#eaeaea",
            padding: "9px 14px",
            letterSpacing: "0.1em",
            cursor: !hasCode || loading ? "default" : "pointer",
            opacity: !hasCode || loading ? 0.5 : 0.85,
          }}
        >
          {loading ? "claiming..." : "claim runtime identity"}
        </button>

        {error ? (
          <div style={{ marginTop: 12, color: "#ff8f8f", fontSize: 12 }}>
            {error}
          </div>
        ) : null}

        {claimedUser ? (
          <div style={{ marginTop: 14, fontSize: 12, opacity: 0.85 }}>
            user: {claimedUser}
          </div>
        ) : null}

        {token ? (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, opacity: 0.6 }}>runtime token</div>
            <div
              style={{
                marginTop: 8,
                fontSize: 12,
                wordBreak: "break-all",
                borderBottom: "1px solid rgba(255,255,255,0.18)",
                paddingBottom: 8,
              }}
            >
              {token}
            </div>
          </div>
        ) : null}
      </div>
    </main>
  );
}
