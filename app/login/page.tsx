"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { supabase } from "@/lib/supabaseClient";

export default function Login() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
useEffect(() => {
    async function checkSession() {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (user) {
        router.push("/my-home");
      }
    }

    checkSession();
  }, [router]);

  return (
    <main>
      {/* login formun burada */}
    </main>
  );
}

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

    router.push("/my-home");
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
      {/* TOP LEFT — GO BACK */}
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
        onMouseEnter={(e) => (e.currentTarget.style.fontWeight = "600")}
        onMouseLeave={(e) => (e.currentTarget.style.fontWeight = "400")}
      >
        ← go back
      </div>

      {/* ✅ FORM */}
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

        {/* EMAIL */}
        <div style={labelStyle}>email</div>
        <input
          type="email"
          style={inputStyle}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        {/* PASSWORD */}
        <div style={labelStyle}>password</div>
        <input
          type="password"
          style={inputStyle}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        <button
          style={buttonStyle}
          type="submit"
          disabled={loading}
        >
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
