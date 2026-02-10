"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

export default function AccountPage() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    const loadUser = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        router.push("/login");
        return;
      }

      sif (user.email) {
  setEmail(user.email);
}
    };

    loadUser();
  }, []);

  async function handleChangePassword() {
    if (!email) return;
    await supabase.auth.resetPasswordForEmail(email);
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        padding: 40,
        background: "#0b0b0b",
        color: "#eaeaea",
      }}
    >
      <h1 style={{ fontSize: 14, opacity: 0.6, marginBottom: 24 }}>
        account
      </h1>

      <div style={{ maxWidth: 420 }}>
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 12, opacity: 0.5 }}>email</div>
          <div style={{ fontSize: 14 }}>{email}</div>
        </div>

        <button
          onClick={handleChangePassword}
          style={{
            fontSize: 13,
            opacity: 0.7,
            cursor: "pointer",
          }}
        >
          change password
        </button>
      </div>
    </main>
  );
}
