"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Supabase reset link ile gelinmiş mi?
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) {
        router.replace("/");
      }
    });
  }, [router]);

  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    if (!password) return;

    setLoading(true);

    const { error } = await supabase.auth.updateUser({
      password,
    });

    setLoading(false);

    if (error) {
      alert(error.message);
      return;
    }

    router.replace("/login");
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
          style={{
            width: "100%",
            background: "transparent",
            border: "none",
            borderBottom: "1px solid rgba(255,255,255,0.2)",
            color: "#eaeaea",
            padding: "10px 0",
            marginBottom: 24,
            outline: "none",
            fontSize: 14,
          }}
        />

        <button
          type="submit"
          disabled={loading}
          style={{
            width: "100%",
            background: "none",
            border: "1px solid rgba(255,255,255,0.3)",
            color: "#eaeaea",
            padding: "12px",
            cursor: "pointer",
            letterSpacing: "0.15em",
          }}
        >
          {loading ? "..." : "save"}
        </button>
      </form>
    </main>
  );
}
