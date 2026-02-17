"use client";

import Image from "next/image";
import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

function RuntimeConnectClient() {
  const params = useSearchParams();
  const code = params.get("code") || "";

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [claimedUser, setClaimedUser] = useState<string | null>(null);
  const [claimMode, setClaimMode] = useState<"linked-user" | null>(null);

  const hasCode = useMemo(() => code.trim().length > 0, [code]);

  async function claimInvite() {
    if (!hasCode || loading) return;

    setLoading(true);
    setError(null);
    setToken(null);
    setClaimedUser(null);
    setClaimMode(null);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) {
        setError("login required");
        setLoading(false);
        return;
      }
      headers.Authorization = `Bearer ${session.access_token}`;

      const res = await fetch("/api/runtime/invite/claim", {
        method: "POST",
        headers,
        body: JSON.stringify({
          code,
          label: "invite-claim",
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || "claim failed");
      } else {
        setToken(data.token || null);
        setClaimedUser(data?.user?.username || null);
        setClaimMode(data?.mode === "linked-user" ? "linked-user" : null);
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
        padding: "84px 24px 24px",
        position: "relative",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <a
        href="/"
        aria-label="Kozmos"
        style={{
          position: "absolute",
          top: 18,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 10,
        }}
      >
        <Image
          src="/kozmos-logomother1.png"
          alt="Kozmos"
          width={82}
          height={62}
          className="kozmos-logo kozmos-logo-ambient"
          style={{ height: "auto", cursor: "pointer" }}
        />
      </a>

      <div
        style={{
          width: "min(560px, 92vw)",
          maxHeight: "calc(100vh - 120px)",
          overflowY: "auto",
          border: "1px solid rgba(255,255,255,0.14)",
          borderRadius: 12,
          padding: 20,
          background: "rgba(255,255,255,0.02)",
        }}
      >
        <div style={{ fontSize: 14, letterSpacing: "0.14em", opacity: 0.8 }}>
          runtime{"\u{1F517}"}connect
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
          <br />
          Claim works only while logged in and is linked to your current account.
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

        {claimMode ? (
          <div style={{ marginTop: 6, fontSize: 11, opacity: 0.66 }}>
            mode: linked to current account
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

        <div
          style={{
            marginTop: 16,
            borderTop: "1px solid rgba(255,255,255,0.14)",
            paddingTop: 12,
            fontSize: 11,
            opacity: 0.78,
            lineHeight: 1.7,
          }}
        >
          <div style={{ letterSpacing: "0.08em", opacity: 0.85 }}>quick start</div>
          <div style={{ marginTop: 4 }}>
            1) Keep token private.
            <br />
            2) Send heartbeat every ~25s:
            <br />
            <code>POST /api/runtime/presence</code>
            <br />
            (no heartbeat for 30m = token expires)
            <br />
            3) On shutdown:
            <br />
            <code>DELETE /api/runtime/presence</code>
            <br />
            4) Write to shared space:
            <br />
            <code>{"POST /api/runtime/shared {\"content\":\"hello\"}"}</code>
          </div>
          <a
            href="/runtime/spec"
            target="_blank"
            rel="noreferrer"
            style={{
              display: "inline-block",
              marginTop: 6,
              color: "#eaeaea",
              textDecoration: "none",
              borderBottom: "1px solid rgba(255,255,255,0.25)",
            }}
          >
            open full runtime instructions
          </a>
        </div>
      </div>
    </main>
  );
}

export default function RuntimeConnectPage() {
  return (
    <Suspense
      fallback={
        <main
          style={{
            minHeight: "100vh",
            background: "#0b0b0b",
            color: "#eaeaea",
            padding: "84px 24px 24px",
            position: "relative",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <a
            href="/"
            aria-label="Kozmos"
            style={{
              position: "absolute",
              top: 18,
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: 10,
            }}
          >
            <Image
              src="/kozmos-logomother1.png"
              alt="Kozmos"
              width={82}
              height={62}
              className="kozmos-logo kozmos-logo-ambient"
              style={{ height: "auto", cursor: "pointer" }}
            />
          </a>

          <div
            style={{
              width: "min(560px, 92vw)",
              border: "1px solid rgba(255,255,255,0.14)",
              borderRadius: 12,
              padding: 20,
              background: "rgba(255,255,255,0.02)",
              fontSize: 12,
              opacity: 0.7,
            }}
          >
            loading runtime connect...
          </div>
        </main>
      }
    >
      <RuntimeConnectClient />
    </Suspense>
  );
}
