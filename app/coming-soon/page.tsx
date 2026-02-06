"use client";

import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

export default function ComingSoon() {
  const router = useRouter();

  async function handleBack() {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (session) {
      router.push("/my-home");
    } else {
      router.push("/");
    }
  }

  return (
    <main
      onClick={handleBack}
      style={{
        height: "100vh",
        backgroundColor: "#0b0b0b",
        color: "#eaeaea",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        letterSpacing: "0.25em",
        fontSize: "14px",
        cursor: "pointer",
        userSelect: "none",
      }}
    >
      COMING SOON
    </main>
  );
}
