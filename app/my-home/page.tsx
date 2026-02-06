"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

export default function MyHome() {
  const router = useRouter();
  const [username, setUsername] = useState<string | null>(null);

  useEffect(() => {
    async function loadUser() {
      const { data } = await supabase.auth.getUser();

      if (!data.user) {
        router.push("/login");
        return;
      }

      // profil tablosundan username çek
      const { data: profile } = await supabase
        .from("profileskozmos")
        .select("username")
        .eq("id", data.user.id)
        .single();

      setUsername(profile?.username ?? "user");
    }

    loadUser();
  }, [router]);

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/");
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#0b0b0b",
        color: "#eaeaea",
        padding: "40px",
        position: "relative",
      }}
    >
      {/* TOP LEFT — MAIN / MY HOME */}
      <div
        style={{
          position: "absolute",
          top: 16,
          left: 16,
          fontSize: 12,
          letterSpacing: "0.12em",
          opacity: 0.6,
        }}
      >
        <span
          style={{ cursor: "pointer" }}
          onMouseEnter={(e) => (e.currentTarget.style.fontWeight = "600")}
          onMouseLeave={(e) => (e.currentTarget.style.fontWeight = "400")}
onClick={() => router.push("/coming-soon")}
        >
          main
        </span>{" "}
        /{" "}
        <span
          style={{ cursor: "pointer" }}
          onMouseEnter={(e) => (e.currentTarget.style.fontWeight = "600")}
          onMouseLeave={(e) => (e.currentTarget.style.fontWeight = "400")}
        >
          my home
        </span>
      </div>

      {/* TOP RIGHT — USERNAME / LOGOUT */}
      <div
        style={{
          position: "absolute",
          top: 16,
          right: 16,
          fontSize: 12,
          letterSpacing: "0.12em",
          opacity: 0.6,
        }}
      >
        <span
          style={{ cursor: "default", marginRight: 6 }}
        >
          {username}
        </span>
        /{" "}
        <span
          style={{ cursor: "pointer" }}
          onMouseEnter={(e) => (e.currentTarget.style.fontWeight = "600")}
          onMouseLeave={(e) => (e.currentTarget.style.fontWeight = "400")}
          onClick={handleLogout}
        >
          logout
        </span>
      </div>

      {/* CONTENT */}
      <div
        style={{
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          opacity: 0.7,
          letterSpacing: "0.15em",
        }}
      >
        this is your space.
      </div>
    </main>
  );
}
