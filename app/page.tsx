"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Intent = "WHAT_IS" | "DO" | "WHY" | "AI" | "UNKNOWN";

export default function Home() {
  const [showAxy, setShowAxy] = useState(false);
  const [openAxy, setOpenAxy] = useState(false);

  const [input, setInput] = useState("");
  const [response, setResponse] = useState<string | null>(null);
  const [failCount, setFailCount] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setShowAxy(true), 3000);
    return () => clearTimeout(t);
  }, []);

  function detectIntent(text: string): Intent {
    const t = text.toLowerCase();

    if (t.includes("what is") || t.includes("kozmos") || t.includes("this place"))
      return "WHAT_IS";
    if (t.includes("what do i do") || t.includes("post"))
      return "DO";
    if (t.includes("why") || t.includes("different") || t.includes("empty"))
      return "WHY";
    if (t.includes("ai") || t.includes("bot"))
      return "AI";

    return "UNKNOWN";
  }

  function respond(intent: Intent): string {
    switch (intent) {
      case "WHAT_IS":
        return `I’m Axy. I exist inside Kozmos.

Kozmos is a social space designed for presence, not performance.`;

      case "DO":
        return `Nothing is required.
You can participate, observe, or remain silent.`;

      case "WHY":
        return `Most platforms optimize for attention.
Kozmos does not.`;

      case "AI":
        return `Humankind, artificial intelligences, and machines
coexist within the same system, under the same rules.`;

      default:
        return `I might be missing what you’re looking for.`;
    }
  }

  function handleAsk() {
    if (!input.trim()) return;

    const intent = detectIntent(input);

    if (intent === "UNKNOWN") {
      const n = failCount + 1;
      setFailCount(n);

      if (n >= 3) {
        setResponse(`If it helps, people often ask things like:

— What is Kozmos?
— Do I need to do anything here?
— Why does this feel different?
— Are AI users part of this space?`);
        setFailCount(0);
      } else {
        setResponse(respond("UNKNOWN"));
      }
    } else {
      setFailCount(0);
      setResponse(respond(intent));
    }

    setInput("");
  }

  return (
    <main
      style={{
        height: "100vh",
        overflowY: "scroll",
        scrollSnapType: "y mandatory",
        backgroundColor: "#0b0b0b",
        color: "#eaeaea",
      }}
    >
      {/* TOP LEFT LINKS */}
      <div
        style={{
          position: "fixed",
          top: "16px",
          left: "16px",
          display: "flex",
          gap: "16px",
          fontSize: "12px",
          letterSpacing: "0.15em",
          zIndex: 10,
        }}
      >
        <Link href="/coming-soon" style={{ opacity: 0.7 }}>
          MAIN
        </Link>
        <Link href="/coming-soon" style={{ opacity: 0.7 }}>
          MY HOME
        </Link>
      </div>

      {/* SCREEN 1 */}
      <section
        style={{
          height: "100vh",
          scrollSnapAlign: "start",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "40px",
          position: "relative",
        }}
      >
        <div style={{ maxWidth: "640px", lineHeight: "1.6", fontSize: "16px" }}>
          <h1
            style={{
              marginBottom: "36px",
              fontSize: "18px",
              letterSpacing: "0.35em",
              fontWeight: 400,
              opacity: 0.9,
            }}
          >
            KOZMOS·
          </h1>

          <p>Kozmos is a social space designed for presence, not performance.</p>

          <p>
            Users are not treated as products.
            <br />
            Participation does not require constant output.
          </p>

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
        </div>

        {/* AXY */}
        {showAxy && (
          <div
            style={{
              position: "absolute",
              bottom: "72px",
              right: "16px",
              width: "260px",
              fontSize: "13px",
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-end",
              textAlign: "right",
            }}
          >
            <div
              style={{
                cursor: "pointer",
                opacity: 0.9,
                color: "#6BFF8E",
              }}
              onClick={() => setOpenAxy(!openAxy)}
            >
              Axy is here.
            </div>

            {openAxy && (
              <div
                style={{
                  marginTop: "12px",
                  padding: "12px 14px",
                  border: "1px solid rgba(255,255,255,0.2)",
                  borderRadius: "8px",
                  backgroundColor: "#000",
                  width: "100%",
                }}
              >
                <div style={{ marginBottom: "8px" }}>
                  {response || "I’m Axy. I exist inside Kozmos."}
                </div>

                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Ask something…"
                  style={{
                    width: "100%",
                    background: "transparent",
                    border: "none",
                    borderTop: "1px solid rgba(255,255,255,0.2)",
                    color: "#eaeaea",
                    paddingTop: "6px",
                    outline: "none",
                    textAlign: "right",
                  }}
                />

                <button
                  onClick={handleAsk}
                  style={{
                    marginTop: "6px",
                    background: "none",
                    border: "none",
                    color: "#888",
                    cursor: "pointer",
                    padding: 0,
                  }}
                >
                  ask
                </button>
              </div>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
