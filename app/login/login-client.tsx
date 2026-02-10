"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

export default function LoginClient() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const redirectTo = searchParams.get("redirect") || "/my-home";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);

  // ✅ LOGIN GUARD
  useEffect(() => {
    async function checkSession() {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (user) {
        router.replace(redirectTo);
        return;
      }

      setCheckingSession(false);
    }

    checkSession();
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

  if (checkingSession) {
    return null;
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
        position: "relative",
      }}
    >
      {/* 🌌 KOZMOS LOGO — STABİL, SCROLL ETMEZ */}
      <div
        style={{
          position: "absolute",
          top: 32,
          left: "50%",
          transform: "translateX(-50%)",
          cursor: "pointer",
          zIndex: 10,
        }}
        onClick={() => router.push("/")}
      >
        <img
          src="/kozmos-logomother1.png"
          alt="Kozmos"
          style={{
            width: 120,
            opacity: 0.85,
            borderRadius: 6,
            transition:
              "opacity 0.25s ease, box-shadow 0.25s ease, transform 0.08s ease",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.opacity = "1";
            e.currentTarget.style.boxShadow =
              "0 0 18px rgba(0,255,170,0.45)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.opacity = "0.85";
            e.currentTarget.style.boxShadow = "none";
          }}
          onMouseDown={(e) => {
            e.currentTarget.style.transform = "scale(0.97)";
          }}
          onMouseUp={(e) => {
            e.currentTarget.style.transform = "scale(1)";
          }}
        />
      </div>

      {/* ← go back */}
      <div
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
        ← go back
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

        <button style={buttonStyle} type="submit" disabled={loading}>
          {loading ? "..." : "enter"}
        </button>

        <div
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
