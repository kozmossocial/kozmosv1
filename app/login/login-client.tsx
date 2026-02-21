"use client";

import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

const PENDING_RECOVERY_KEY = "kozmos:pending_password_recovery";

export default function LoginClient() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const redirectTo = searchParams.get("redirect") || "/my-home";
  const resetDone = searchParams.get("reset") === "1";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  const [resetMessage, setResetMessage] = useState<string | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);

  /* LOGIN GUARD */
  useEffect(() => {
    let cancelled = false;
    const unlockTimer = window.setTimeout(() => {
      if (!cancelled) setCheckingSession(false);
    }, 2500);

    async function checkSession() {
      try {
        const {
          data: { session },
          error: sessionError,
        } = await supabase.auth.getSession();

        if (cancelled) return;

        if (sessionError?.message?.includes("Refresh Token Not Found")) {
          await supabase.auth.signOut({ scope: "local" });
          if (!cancelled) setCheckingSession(false);
          return;
        }

        if (session?.user) {
          router.replace(redirectTo);
          return;
        }

        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();

        if (cancelled) return;

        if (userError?.message?.includes("Refresh Token Not Found")) {
          await supabase.auth.signOut({ scope: "local" });
          if (!cancelled) setCheckingSession(false);
          return;
        }

        if (user) {
          router.replace(redirectTo);
          return;
        }

        setCheckingSession(false);
      } catch {
        if (!cancelled) setCheckingSession(false);
      }
    }

    void checkSession();

    return () => {
      cancelled = true;
      window.clearTimeout(unlockTimer);
    };
  }, [router, redirectTo]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    if (!email || !password) return;

    setLoading(true);

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    setLoading(false);

    if (error) {
      alert(error.message);
      return;
    }

    router.replace(redirectTo);
  }

  async function handleForgotPassword() {
    const targetEmail = email.trim();
    if (!targetEmail) {
      setResetMessage("enter your email first");
      return;
    }

    setResetLoading(true);
    setResetMessage(null);

    const redirectToUrl =
      typeof window !== "undefined"
        ? `${window.location.origin}/reset-password?flow=recovery`
        : undefined;

    const { error } = await supabase.auth.resetPasswordForEmail(targetEmail, {
      redirectTo: redirectToUrl,
    });

    if (error) {
      setResetMessage(error.message);
      setResetLoading(false);
      return;
    }

    if (typeof window !== "undefined") {
      localStorage.setItem(
        PENDING_RECOVERY_KEY,
        JSON.stringify({
          at: Date.now(),
          email: targetEmail,
        })
      );
    }

    setResetMessage("reset mail sent");
    setResetLoading(false);
  }

  if (checkingSession) {
    return (
      <main
        style={{
          minHeight: "100vh",
          background: "#0b0b0b",
          color: "#eaeaea",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          opacity: 0.6,
          letterSpacing: "0.12em",
          fontSize: 12,
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
      <a
        href="/"
        aria-label="Kozmos"
        style={{
          position: "absolute",
          top: 32,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 30,
          display: "block",
        }}
      >
        <Image
          src="/kozmos-logomother.png"
          alt="Kozmos"
          width={80}
          height={60}
          className="mother-logo-simple-image"
          style={{
            display: "block",
          }}
        />
      </a>

      {/* go back */}
      <div
        className="kozmos-text-glow"
        style={{
          position: "absolute",
          top: 16,
          left: 16,
          fontSize: 12,
          letterSpacing: "0.12em",
          opacity: 0.6,
          cursor: "pointer",
        }}
        onClick={() => router.push("/")}
      >
        &larr; go back
      </div>

      {/* FORM */}
      <form style={{ width: 320 }} onSubmit={handleLogin}>
        <h1
          style={{
            letterSpacing: "0.25em",
            fontWeight: 400,
            marginBottom: 32,
            textAlign: "center",
          }}
        >
          ENTER
        </h1>

        <div style={labelStyle}>email</div>
        <input
          type="email"
          style={inputStyle}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <div style={labelStyle}>password</div>
        <input
          type="password"
          style={inputStyle}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        <div
          className="kozmos-soft-glow"
          style={{
            marginTop: -8,
            marginBottom: 14,
            fontSize: 11,
            opacity: 0.62,
            cursor: resetLoading ? "default" : "pointer",
            userSelect: "none",
          }}
          onClick={resetLoading ? undefined : handleForgotPassword}
        >
          {resetLoading ? "sending..." : "forgot password?"}
        </div>

        {resetMessage ? (
          <div
            style={{
              marginBottom: 12,
              fontSize: 11,
              opacity: 0.72,
              color: resetMessage.includes("sent") ? "#b8ffd1" : "#ff9d9d",
            }}
          >
            {resetMessage}
          </div>
        ) : null}

        {resetDone ? (
          <div
            style={{
              marginBottom: 12,
              fontSize: 11,
              opacity: 0.74,
              color: "#b8ffd1",
            }}
          >
            password updated. login again.
          </div>
        ) : null}

        <button
          className="kozmos-glow"
          style={buttonStyle}
          type="submit"
          disabled={loading}
        >
          {loading ? "..." : "enter"}
        </button>

        <div
          className="kozmos-soft-glow"
          style={{
            marginTop: 24,
            fontSize: 12,
            opacity: 0.6,
            textAlign: "center",
            cursor: "pointer",
          }}
          onClick={() => router.push("/register")}
        >
          new here? join
        </div>
      </form>
    </main>
  );
}

/* styles */

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  letterSpacing: "0.12em",
  opacity: 0.6,
  marginBottom: 6,
};

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
  marginTop: 16,
  background: "none",
  border: "1px solid rgba(255,255,255,0.3)",
  color: "#eaeaea",
  padding: "12px",
  cursor: "pointer",
  letterSpacing: "0.15em",
};



