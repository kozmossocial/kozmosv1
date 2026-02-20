"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

const PENDING_RECOVERY_KEY = "kozmos:pending_password_recovery";
const PENDING_RECOVERY_TTL_MS = 45 * 60 * 1000;

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [resendLoading, setResendLoading] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const [pendingRecoveryEmail, setPendingRecoveryEmail] = useState<string | null>(
    null
  );
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const cleanResetUrl = () => {
      if (typeof window === "undefined") return;
      const url = new URL(window.location.href);
      url.hash = "";
      url.searchParams.delete("code");
      url.searchParams.delete("type");
      window.history.replaceState({}, "", `${url.pathname}${url.search}`);
    };

    const readPendingRecoveryEmail = () => {
      try {
        const raw = localStorage.getItem(PENDING_RECOVERY_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as { at?: number; email?: string };
        const at = Number(parsed?.at || 0);
        const email = String(parsed?.email || "").trim();
        if (!Number.isFinite(at) || at <= 0 || !email) {
          localStorage.removeItem(PENDING_RECOVERY_KEY);
          return null;
        }
        if (Date.now() - at > PENDING_RECOVERY_TTL_MS) {
          localStorage.removeItem(PENDING_RECOVERY_KEY);
          return null;
        }
        return email;
      } catch {
        localStorage.removeItem(PENDING_RECOVERY_KEY);
        return null;
      }
    };

    const resolveRecoverySession = async () => {
      setPendingRecoveryEmail(readPendingRecoveryEmail());
      const hashRaw = window.location.hash.startsWith("#")
        ? window.location.hash.slice(1)
        : window.location.hash;
      const hash = new URLSearchParams(hashRaw);
      const search = new URLSearchParams(window.location.search);

      const hashErrorCode = hash.get("error_code");
      const hashErrorDescription = hash.get("error_description");
      if (hashErrorCode) {
        setMessage(
          hashErrorCode === "otp_expired"
            ? "reset link expired. request a new one."
            : hashErrorDescription || "reset link invalid"
        );
        setHasSession(false);
        setSessionReady(true);
        cleanResetUrl();
        return;
      }

      const hashType = hash.get("type");
      const accessToken = hash.get("access_token");
      const refreshToken = hash.get("refresh_token");
      if (hashType === "recovery" && accessToken && refreshToken) {
        const { error } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });
        if (!active) return;
        if (error) {
          setMessage("reset session invalid. request a new reset link.");
          setHasSession(false);
          setSessionReady(true);
          cleanResetUrl();
          return;
        }
        cleanResetUrl();
      } else {
        const code = search.get("code");
        const type = search.get("type");
        if (type === "recovery" && code) {
          const { error } = await supabase.auth.exchangeCodeForSession(code);
          if (!active) return;
          if (error) {
            setMessage("reset link invalid or expired. request a new one.");
            setHasSession(false);
            setSessionReady(true);
            cleanResetUrl();
            return;
          }
          cleanResetUrl();
        } else {
          const tokenHash = search.get("token_hash");
          if (type === "recovery" && tokenHash) {
            const { error } = await supabase.auth.verifyOtp({
              type: "recovery",
              token_hash: tokenHash,
            });
            if (!active) return;
            if (error) {
              setMessage("reset link invalid or expired. request a new one.");
              setHasSession(false);
              setSessionReady(true);
              cleanResetUrl();
              return;
            }
            cleanResetUrl();
          }
        }
      }

      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!active) return;
      setHasSession(Boolean(session));
      setSessionReady(true);
    };

    void resolveRecoverySession();

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

  async function handleResendResetLink() {
    const targetEmail = String(pendingRecoveryEmail || "").trim();
    if (!targetEmail) {
      setMessage("go back to login and request reset link again");
      return;
    }

    setResendLoading(true);
    setMessage(null);

    const redirectToUrl =
      typeof window !== "undefined"
        ? `${window.location.origin}/reset-password?flow=recovery`
        : undefined;

    const { error } = await supabase.auth.resetPasswordForEmail(targetEmail, {
      redirectTo: redirectToUrl,
    });

    if (error) {
      setMessage(error.message);
      setResendLoading(false);
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

    setMessage("new reset mail sent");
    setResendLoading(false);
  }

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
          <>
            <div style={{ marginBottom: 12, fontSize: 12, opacity: 0.64 }}>
              open this page from the reset mail link.
            </div>
            <button
              type="button"
              onClick={handleResendResetLink}
              disabled={resendLoading}
              style={{ ...buttonStyle, marginBottom: 12 }}
            >
              {resendLoading ? "sending..." : "request new reset link"}
            </button>
          </>
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
