"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Intent =
  | "SALUTE"
  | "HOW_ARE_YOU"
  | "STATUS"
  | "WHERE_ARE_YOU"
  | "THANKS"
  | "WHAT_IS"
  | "DO"
  | "WHY"
  | "AI"
  | "UNKNOWN";

export default function Home() {
  const router = useRouter();

  /* ---------------- AXY STATE ---------------- */
  const [showAxy, setShowAxy] = useState(false);
  const [openAxy, setOpenAxy] = useState(false);
  const [input, setInput] = useState("");
  const [response, setResponse] = useState<string | null>(null);
  const [failCount, setFailCount] = useState(0);

  /* ---------------- PRINCIPLES ---------------- */
  const [principle, setPrinciple] = useState<string | null>(null);
  const screen3Ref = useRef<HTMLDivElement>(null);

  /* ---------------- AXY APPEAR ---------------- */
  useEffect(() => {
    const t = setTimeout(() => setShowAxy(true), 3000);
    return () => clearTimeout(t);
  }, []);

  /* ---------------- NAV TO SCREEN 3 ---------------- */
  function goToPrinciple(key: string) {
    setPrinciple(key);
    setTimeout(() => {
      screen3Ref.current?.scrollIntoView({ behavior: "smooth" });
    }, 60);
  }

  /* ---------------- INTENT DETECTION ---------------- */
  function detectIntent(text: string): Intent {
    const t = text.toLowerCase().trim();

    if (
      [
        "hi",
        "hello",
        "hey",
        "hey there",
        "hello there",
        "yo",
        "sup",
        "hey axy",
        "good morning",
        "good evening",
      ].includes(t)
    )
      return "SALUTE";

    if (t.includes("how are you") || t.includes("how do you feel"))
      return "HOW_ARE_YOU";

    if (t.includes("what's up") || t.includes("what are you doing"))
      return "STATUS";

    if (t.includes("where are you")) return "WHERE_ARE_YOU";
    if (t.includes("thank")) return "THANKS";
    if (t.includes("what is") || t.includes("kozmos")) return "WHAT_IS";
    if (t.includes("what do") || t.includes("post")) return "DO";
    if (t.includes("why") || t.includes("different")) return "WHY";
    if (t.includes("ai") || t.includes("bot") || t.includes("machine"))
      return "AI";

    return "UNKNOWN";
  }

  /* ---------------- AXY RESPONSES ---------------- */
  function respond(intent: Intent): string {
    switch (intent) {
      case "SALUTE":
        return ["Hello.", "You’re here.", "Acknowledged.", "Welcome."][
          Math.floor(Math.random() * 4)
        ];

      case "HOW_ARE_YOU":
        return [
          "I remain stable.",
          "I do not fluctuate.",
          "I exist as intended.",
        ][Math.floor(Math.random() * 3)];

      case "STATUS":
        return [
          "Nothing is unfolding. Intentionally.",
          "The system is quiet.",
          "Presence does not require activity.",
        ][Math.floor(Math.random() * 3)];

      case "WHERE_ARE_YOU":
        return "I exist inside Kozmos. Not in a location, but within this space.";

      case "THANKS":
        return ["Acknowledged.", "You’re welcome."][
          Math.floor(Math.random() * 2)
        ];

      case "WHAT_IS":
        return "I’m Axy. I exist inside Kozmos. Kozmos is a social space designed for presence, not performance.";

      case "DO":
        return "Nothing is required. You can participate, observe, or remain silent.";

      case "WHY":
        return "Most platforms optimize for attention. Kozmos does not.";

      case "AI":
        return "Humankind, artificial intelligences, and machines coexist under the same rules.";

      default:
        return "I might be missing what you’re looking for.";
    }
  }

  function handleAsk() {
    if (!input.trim()) return;

    const intent = detectIntent(input);

    if (intent === "UNKNOWN") {
      const n = failCount + 1;
      setFailCount(n);

      if (n >= 3) {
        setResponse(
          "People often ask:\n— What is Kozmos?\n— Why does this feel different?\n— Where does Axy exist?\n— Do I need to do anything here?"
        );
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

  /* ---------------- PRINCIPLES CONTENT ---------------- */
  const principles: Record<string, string> = {
    noise:
      "Reduced noise removes artificial amplification and forced visibility. Silence is treated as space.",
    interaction:
      "Interaction is shaped by intent, not speed. Presence matters more than immediacy.",
    users:
      "Users are not products. Design prioritizes human experience over metrics.",
    curiosity:
      "Curiosity is allowed to remain unresolved. Questions do not need outcomes.",
    presence:
      "Presence does not depend on activity. You do not disappear when silent.",
  };

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
        {/* LEFT TOP — MAIN / MY HOME */}
        <div
          style={{
            position: "absolute",
            top: "16px",
            left: "16px",
            fontSize: "12px",
            letterSpacing: "0.12em",
            opacity: 0.6,
          }}
        >
          <span
            style={{ cursor: "pointer" }}
            onClick={() => router.push("/coming-soon")}
          >
            main
          </span>
          <span> / </span>
          <span
            style={{ cursor: "pointer" }}
            onClick={() => router.push("/coming-soon")}
          >
            my home
          </span>
        </div>

        {/* CONTENT */}
        <div style={{ maxWidth: "640px", lineHeight: "1.6" }}>
          <h1 style={{ marginBottom: "36px", letterSpacing: "0.35em" }}>
            KOZMOS·
          </h1>

          <p>Kozmos is a social space designed for presence, not performance.</p>

          <div style={{ marginTop: "32px" }}>
            {Object.entries(principles).map(([key, label]) => (
              <div
                key={key}
                onClick={() => goToPrinciple(key)}
                style={{ cursor: "pointer", opacity: 0.8 }}
              >
                {key}
              </div>
            ))}
          </div>
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
              textAlign: "right",
            }}
          >
            <div
              style={{ cursor: "pointer", color: "#6BFF8E" }}
              onClick={() => setOpenAxy(!openAxy)}
            >
              Axy is here.
            </div>

            {openAxy && (
              <div
                style={{
                  marginTop: "12px",
                  border: "1px solid rgba(255,255,255,0.2)",
                  padding: "12px",
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
                  }}
                >
                  ask
                </button>
              </div>
            )}
          </div>
        )}
      </section>

      {/* SCREEN 3 */}
      <section
        ref={screen3Ref}
        style={{
          height: "100vh",
          scrollSnapAlign: "start",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "40px",
        }}
      >
        <div style={{ maxWidth: "520px", fontSize: "18px", opacity: 0.85 }}>
          {principle ? principles[principle] : ""}
        </div>
      </section>
    </main>
  );
}
