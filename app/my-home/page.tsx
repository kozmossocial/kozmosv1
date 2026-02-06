"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

export default function MyHome() {
  const router = useRouter();
  const [username, setUsername] = useState<string>("user");

  useEffect(() => {
    async function loadUser() {
      // 1️⃣ Auth user
      const {
        data: { user },
        error: authError,
      } = await supabase.auth.getUser();

      if (authError || !user) {
        router.push("/login");
        return;
      }

      // 2️⃣ Profile username
      const { data: profile, error: profileError } = await supabase
        .from("profileskozmos")
        .select("username")
        .eq("id", user.id)
        .maybeSingle(); // ❗ single yerine maybeSingle

      if (profileError) {
        console.error("PROFILE FETCH ERROR:", profileError.message);
        setUsername("user");
        return;
      }

      if (profile?.username) {
        setUsername(profile.username);
      } else {
        setUsername("user");
      }
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
          onClick={() => router.push("/coming-soon")}
        >
          main
        </span>{" "}
        / <span>my home</span>
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
        <span style={{ marginRight: 6 }}>{username}</span> /{" "}
        <span
          style={{ cursor: "pointer" }}
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
