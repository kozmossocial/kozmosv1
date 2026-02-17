"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setHasSession(Boolean(data.session));
      setSessionReady(true);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active) return;
      setHasSession(Boolean(session));
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  async function handleReset(e: React.FormEvent) {
    e.preventDefault();

    const nextPassword = password.trim();
    const nextConfirm = confirmPassword.trim();

    if (!nextPassword) {
      setMessage("enter new password");
      return;
    }
    if (nextPassword.length < 8) {
      setMessage("password must be at least 8 characters");
      return;
    }
    if (nextPassword !== nextConfirm) {
      setMessage("passwords do not match");
      return;
    }
    if (!hasSession) {
      setMessage("open this page from reset mail link");
      return;
    }

    setLoading(true);
    setMessage(null);

    const { error } = await supabase.auth.updateUser({
      password: nextPassword,
    });

    if (error) {
      setLoading(false);
      setMessage(error.message);
      return;
    }

    // Recovery flow creates a temporary authenticated session.
    // We explicitly sign out so user must re-login with new password.
    await supabase.auth.signOut({ scope: "local" });

    setLoading(false);
    setMessage("password updated. please login again.");
    setTimeout(() => {
      router.replace("/login?reset=1");
    }, 700);
  }

  if (!sessionReady) {
    return (
      <main
        style={{
          minHeight: "100vh",
          background: "#0b0b0b",
          color: "#eaeaea",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 40,
        }}
      >
        loading...
      </main>
    );
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#0b0b0b",
        color: "#eaeaea",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 40,
      }}
    >
      <form style={{ width: 320 }} onSubmit={handleReset}>
        <h1
          style={{
            letterSpacing: "0.25em",
            fontWeight: 400,
            marginBottom: 32,
            textAlign: "center",
          }}
        >
          NEW PASSWORD
        </h1>

        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="new password"
          style={inputStyle}
        />

        <input
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          placeholder="confirm new password"
          style={inputStyle}
        />

        {!hasSession ? (
          <div style={{ marginBottom: 12, fontSize: 12, opacity: 0.64 }}>
            open this page from the reset mail link.
          </div>
        ) : null}

        {message ? (
          <div
            style={{
              marginBottom: 12,
              fontSize: 12,
              opacity: 0.72,
              color: message.includes("updated") ? "#b8ffd1" : "#ff9d9d",
            }}
          >
            {message}
          </div>
        ) : null}

        <button type="submit" disabled={loading} style={buttonStyle}>
          {loading ? "..." : "save"}
        </button>

        <div
          style={{
            marginTop: 20,
            fontSize: 12,
            opacity: 0.62,
            textAlign: "center",
            cursor: "pointer",
          }}
          onClick={() => router.replace("/login")}
        >
          back to login
        </div>
      </form>
    </main>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "transparent",
  border: "none",
  borderBottom: "1px solid rgba(255,255,255,0.2)",
  color: "#eaeaea",
  padding: "10px 0",
  marginBottom: 20,
  outline: "none",
  fontSize: 14,
};

const buttonStyle: React.CSSProperties = {
  width: "100%",
  background: "none",
  border: "1px solid rgba(255,255,255,0.3)",
  color: "#eaeaea",
  padding: "12px",
  cursor: "pointer",
  letterSpacing: "0.15em",
};
