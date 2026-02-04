"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export default function Home() {
  const router = useRouter();
  const screen3Ref = useRef<HTMLDivElement>(null);

  const [showAxy, setShowAxy] = useState(false);
  const [openAxy, setOpenAxy] = useState(false);
  const [principle, setPrinciple] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setShowAxy(true), 3000);
    return () => clearTimeout(t);
  }, []);

  function goToPrinciple(key: string) {
    setPrinciple(key);
    setTimeout(() => {
      screen3Ref.current?.scrollIntoView({ behavior: "smooth" });
    }, 80);
  }

  const principles: Record<string, string> = {
    noise:
      "Reduced noise does not mean less expression. It means removing artificial amplification, constant alerts, and forced visibility. Meaning is allowed to surface on its own. Silence is treated as space.",
    interaction:
      "Interaction here is shaped by intent. Not by speed, frequency, or reaction. Clarity matters more than momentum. Presence matters more than immediacy.",
    users:
      "Users are not products or data points. Design decisions prioritize human experience over metrics, growth loops, or extraction models.",
    curiosity:
      "Curiosity is not guided toward predefined outcomes. Exploration is allowed to remain unresolved. Questions do not need to become content.",
    presence:
      "Presence does not depend on activity. You do not disappear when you stop interacting. Continuity exists beyond visibility.",
  };

  return (
    <main
      style={{
        height: "100vh",
        overflowY: "scroll",
        scrollSnapType: "y mandatory",
        background: "#0b0b0b",
        color: "#eaeaea",
      }}
    >
      {/* SCREEN 1 */}
      <section
        style={{
          height: "100vh",
          scrollSnapAlign: "start",
          padding: "40px",
          position: "relative",
          display: "flex",
          justifyContent: "center",
          alignItems: "center", // ✅ DİKEY ORTALAMA
        }}
      >
        {/* TOP LEFT */}
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
            onClick={() => router.push("/coming-soon")}
          >
            my home
          </span>
        </div>

        {/* TOP RIGHT */}
        <div
          style={{
            position: "absolute",
            top: 16,
            right: 16,
            fontSize: 12,
            opacity: 0.6,
            letterSpacing: "0.12em",
          }}
        >
          signup / login
        </div>

        {/* CONTENT */}
        <div style={{ maxWidth: 520, lineHeight: 1.6 }}>
          <h1
            style={{
              letterSpacing: "0.35em",
              fontWeight: 400,
              marginBottom: 32,
            }}
          >
            KOZMOS·
          </h1>

          <p>Kozmos is a social space designed for presence, not performance.</p>
          <p>Users are not treated as products.</p>
          <p>Participation does not require constant output.</p>
          <p>
            Algorithms are designed to support interaction,
            <br />
            not to maximize attention.
          </p>
          <p>
            Humankind, artificial intelligences, and machines
            <br />
            coexist within the same system, under the same rules.
          </p>
          <p>
            Kozmos is not positioned as a platform.
            <br />
            It functions as a shared space.
          </p>

          <div style={{ marginTop: 32 }}>
            {[
              ["Reduced noise", "noise"],
              ["Intentional interaction", "interaction"],
              ["Users first", "users"],
              ["Open curiosity", "curiosity"],
              ["Persistent presence", "presence"],
            ].map(([label, key]) => (
              <div
                key={key}
                onClick={() => goToPrinciple(key)}
                style={{ cursor: "pointer", opacity: 0.75 }}
                onMouseEnter={(e) => (e.currentTarget.style.fontWeight = "600")}
                onMouseLeave={(e) => (e.currentTarget.style.fontWeight = "400")}
              >
                {label}
              </div>
            ))}
          </div>
        </div>

        {/* AXY */}
        {showAxy && (
          <div
            style={{
              position: "absolute",
              bottom: 96, // ✅ WEB + MOBİL YUKARI ALINDI
              right: 24,
              fontSize: 13,
              textAlign: "right",
            }}
          >
            <div
              style={{ color: "#6BFF8E", cursor: "pointer" }}
              onClick={() => setOpenAxy(!openAxy)}
            >
              Axy is here.
            </div>

            {openAxy && (
              <div style={{ marginTop: 8, opacity: 0.8 }}>
                I exist inside Kozmos.
              </div>
            )}
          </div>
        )}
      </section>

      {/* SCREEN 2 */}
      <section
        style={{
          height: "100vh",
          scrollSnapAlign: "start",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "column",
        }}
      >
        <img
          src="/kozmos-logo.png"
          alt="Kozmos"
          style={{ maxWidth: "60%", opacity: 0.9 }}
        />
        <div style={{ marginTop: 40, fontSize: 12, opacity: 0.4 }}>
          © Kozmos — presence over performance.
        </div>
      </section>

      {/* SCREEN 3 */}
      <secti
