"use client";

import { useRouter } from "next/navigation";

export default function ComingSoon() {
  const router = useRouter();

  return (
    <main
      onClick={() => router.push("/")}
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
