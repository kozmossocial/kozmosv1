"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

export default function AccountPage() {
  const router = useRouter();

  const [email, setEmail] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadAccount = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        router.replace("/login");
        return;
      }

      setEmail(user.email ?? null);

      const { data } = await supabase
        .from("profileskozmos")
        .select("username")
        .eq("id", user.id)
        .maybeSingle();

      setUsername(data?.username ?? null);
      setLoading(false);
    };

    loadAccount();
  }, [router]);

  async function handleLogout() {
    await supabase.auth.signOut();
    router.replace("/");
  }

  if (loading) {
    return null;
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#0b0b0b",
        color: "#eaeaea",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        padding: 40,
        position: "relative",
      }}
    >
      {/* KOZMOS LOGO - TOP CENTER */}
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
          className="kozmos-logo kozmos-logo-ambient"
          style={{
            width: 80,
          }}
        />
      </div>

      {/* TOP LEFT NAV */}
      <div
        style={{
          position: "absolute",
          top: 16,
          left: 16,
          fontSize: 12,
          opacity: 0.6,
          letterSpacing: "0.12em",
        }}
      >
        <span
          style={{ cursor: "pointer" }}
          onClick={() => router.push("/main")}
        >
          main
        </span>{" "}
        /{" "}
        <span
          style={{ cursor: "pointer" }}
          onClick={() => router.push("/my-home")}
        >
          my home
        </span>
      </div>

      {/* CONTENT */}
      <div style={{ maxWidth: 420 }}>
        <div style={{ marginBottom: 32 }}>
          <div style={label}>username</div>
          <div>{username ?? "..."}</div>
        </div>

        <div style={{ marginBottom: 32 }}>
          <div style={label}>email</div>
          <div>{email}</div>
        </div>

        <div
          style={{
            ...action,
            opacity: 0.4,
            cursor: "default",
          }}
        >
          change password - coming soon
        </div>

        <div
          style={{ ...action, marginTop: 24, opacity: 0.5 }}
          onClick={handleLogout}
        >
          logout
        </div>
      </div>
    </main>
  );
}

const label: React.CSSProperties = {
  fontSize: 12,
  opacity: 0.5,
  letterSpacing: "0.12em",
  marginBottom: 6,
};

const action: React.CSSProperties = {
  fontSize: 13,
  opacity: 0.7,
  cursor: "pointer",
};

