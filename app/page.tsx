"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

const MATRIX_BASE_CHARS =
  'ﾊﾐﾋｰｳｼﾅﾓﾆｻﾜﾂｵﾘｱﾎﾃﾏｹﾒｴｶｷﾑﾕﾗｾﾈｽﾀﾇﾍｦｲｸｺｿﾁﾄﾉﾌﾔﾖﾙﾚﾛﾝ:・."=*+-<>¦｜çöşğı:."=*+-¦|_kozmos';
const MATRIX_DIGITS = "012345678";

function createSeededRng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function pickMatrixChar(seed: number) {
  const digitChance = 0.03;
  const useDigit = (seed % 100) / 100 < digitChance;
  if (useDigit) {
    return MATRIX_DIGITS[seed % MATRIX_DIGITS.length];
  }
  return MATRIX_BASE_CHARS[seed % MATRIX_BASE_CHARS.length];
}

function buildMatrixStream(seed: number, length = 42) {
  let s = seed;
  const lines: string[] = [];
  for (let i = 0; i < length; i += 1) {
    s = (s * 9301 + 49297) % 233280;
    const a = pickMatrixChar(s);
    s = (s * 9301 + 49297) % 233280;
    const b = pickMatrixChar(s);
    lines.push(`${a}${b}`);
  }
  return lines.join("\n");
}

function buildMatrixStreamSingle(seed: number, length = 42) {
  let s = seed;
  const lines: string[] = [];
  for (let i = 0; i < length; i += 1) {
    s = (s * 9301 + 49297) % 233280;
    lines.push(pickMatrixChar(s));
  }
  return lines.join("\n");
}

export default function Home() {
  const router = useRouter();
  const screen3Ref = useRef<HTMLDivElement | null>(null);

  const [principle, setPrinciple] = useState<string | null>(null);
  const [principleDissolving, setPrincipleDissolving] = useState(false);
  const [axyOpen, setAxyOpen] = useState(false);
  const [axyInput, setAxyInput] = useState("");
  const [axyReply, setAxyReply] = useState<string | null>(null);
  const [axyLoading, setAxyLoading] = useState(false);
  const [lastUserMessage, setLastUserMessage] = useState<string | null>(null);

  const [user, setUser] = useState<any>(null);
  const [username, setUsername] = useState<string | null>(null);

  const matrixColumns = useMemo(() => {
    const doubleCount = 46;
    const singleCount = Math.floor(doubleCount * 0.9);
    const rand = (rng: () => number, min: number, max: number) =>
      min + rng() * (max - min);
    const randInt = (rng: () => number, min: number, max: number) =>
      Math.floor(rand(rng, min, max + 1));

    const makeColumn = (i: number, kind: "double" | "single") => {
      const rng = createSeededRng(4200 + i * 97 + (kind === "single" ? 31 : 0));
      const extraStreams = rng() > 0.8 ? 1 : 0;
      const baseCount = kind === "double" ? 3 : 2;
      const streamCount = baseCount + extraStreams;
      const opacityBoost = kind === "single" ? 0.72 : 1;
      const streams = Array.from({ length: streamCount }, (_, idx) => {
        const isLong = rng() > (kind === "double" ? 0.78 : 0.68);
        const length = isLong
          ? randInt(rng, kind === "double" ? 140 : 180, 240)
          : randInt(rng, kind === "double" ? 80 : 120, 170);
        return {
          key: `col-${kind}-${i}-s-${idx}`,
          text:
            kind === "double"
              ? buildMatrixStream(i * 13 + idx * 77 + 5, length)
              : buildMatrixStreamSingle(i * 19 + idx * 61 + 11, length),
          duration:
            rand(rng, 7.6, 13.4) + (isLong ? rand(rng, 1.6, 3.4) : 0),
          delay: -rand(rng, 0.2, 2.6),
          opacity: Math.max(0.45, (0.98 - idx * 0.12) * opacityBoost),
          blur: idx * 0.05,
        };
      });
      return { key: `col-${kind}-${i}`, streams };
    };

    const doubles = Array.from({ length: doubleCount }, (_, i) =>
      makeColumn(i, "double")
    );
    const singles = Array.from({ length: singleCount }, (_, i) =>
      makeColumn(i, "single")
    );

    const total = doubleCount + singleCount;
    const mixed: {
      key: string;
      streams: any[];
      glowTail: string | null;
      glowColumn: boolean;
    }[] = [];
    let di = 0;
    let si = 0;
    for (let idx = 0; idx < total; idx += 1) {
      if ((idx % 3 === 2 && si < singleCount) || di >= doubleCount) {
        mixed.push({ ...singles[si++], glowTail: null, glowColumn: false });
      } else {
        mixed.push({ ...doubles[di++], glowTail: null, glowColumn: false });
      }
    }

    for (let idx = 0; idx < mixed.length; idx += 1) {
      if (idx % 5 !== 0) continue;
      const text = mixed[idx].streams[0]?.text ?? "";
      const lines = text.split("\n");
      mixed[idx].glowTail = lines.length ? lines[lines.length - 1] : null;
    }

    for (let idx = 0; idx < mixed.length; idx += 1) {
      if ((idx * 7 + 3) % 11 === 0) {
        mixed[idx].glowColumn = true;
      }
    }

    return mixed;
  }, []);

  useEffect(() => {
    const loadUser = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        setUser(null);
        return;
      }

      setUser(user);

      const { data } = await supabase
        .from("profileskozmos")
        .select("username")
        .eq("id", user.id)
        .maybeSingle();

      if (data?.username) {
        setUsername(data.username);
      }
    };

    loadUser();
  }, []);

  async function handleLoginClick() {
    if (user) {
      router.push("/my-home");
    } else {
      router.push("/login");
    }
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    setUser(null);
    setUsername(null);
    router.push("/");
  }

  function goToPrinciple(key: string) {
    setPrincipleDissolving(false);
    setPrinciple(key);
    setTimeout(() => {
      screen3Ref.current?.scrollIntoView({ behavior: "smooth" });
    }, 80);
  }

  function dissolvePrinciple() {
    if (!principle || principleDissolving) return;
    setPrincipleDissolving(true);
    setTimeout(() => {
      setPrinciple(null);
      setPrincipleDissolving(false);
    }, 1300);
  }

  async function askAxy() {
    const message = axyInput.trim();
    if (!message) return;

    setAxyLoading(true);
    setAxyReply(null);
    setLastUserMessage(message);
    setAxyInput("");

    try {
      const res = await fetch("/api/axy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });

      const data = await res.json();
      setAxyReply(data.reply);
    } catch {
      setAxyReply("...");
    }

    setAxyLoading(false);
  }

  function resetAxy() {
    setAxyReply(null);
    setLastUserMessage(null);
    setAxyInput("");
    setAxyLoading(false);
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
  const activePrincipleText = principle ? principles[principle] : "";

  return (
    <main
      style={{
        minHeight: "100vh",
        overflowY: "scroll",
        overflowX: "hidden",
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
          alignItems: "center",
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
            onClick={() => router.push("/login?redirect=/main")}
          >
            main
          </span>{" "}
          /{" "}
          <span
            style={{ cursor: "pointer" }}
            onClick={() => router.push("/login")}
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
          {user ? (
            <>
              <span
                style={{ marginRight: 8, cursor: "pointer", opacity: 0.8 }}
                onClick={() => router.push("/account")}
              >
                {username ?? "..."}
              </span>
              /{" "}
              <span style={{ cursor: "pointer" }} onClick={handleLogout}>
                logout
              </span>
            </>
          ) : (
            <>
              <span
                style={{ cursor: "pointer" }}
                onClick={() => router.push("/register")}
              >
                signup
              </span>{" "}
              /{" "}
              <span style={{ cursor: "pointer" }} onClick={handleLoginClick}>
                login
              </span>
            </>
          )}
        </div>

        <div
          style={{
            maxWidth: 520,
            lineHeight: 2.5,
            marginTop: "180px",
          }}
        >
          {/* LOGO */}
          <div
            style={{
              position: "absolute",
              top: 30,
              left: "50%",
              transform: "translateX(-27%)",
              zIndex: 50,
            }}
          >
            <a href="https://kozmos.social" target="_self" aria-label="Kozmos">
              <img
                src="/kozmos-logomother1.png"
                alt="Kozmos"
                className="kozmos-logo kozmos-logo-ambient"
                style={{ maxWidth: "60%", cursor: "pointer" }}
              />
            </a>
          </div>

          <h1
            style={{
              letterSpacing: "0.35em",
              fontWeight: 1200,
              marginBottom: 50,
              textAlign: "left",
            }}
          >
            KOZMOS·
          </h1>

          <p>Kozmos is a social space designed for presence, not performance.</p>
          <p>Users are not treated as products.</p>
          <p>Participation does not require constant output.</p>
          <p>Algorithms are designed to support interaction, not attention.</p>
          <p>
            Humankind, artificial intelligences, and machines coexist under the
            same rules. Kozmos is not a platform. It is a shared space.
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
                className="manifesto-link"
                style={{ cursor: "pointer", opacity: 0.75 }}
              >
                {label}
              </div>
            ))}
          </div>
        </div>
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
        <img src="/kozmos-logo.png" alt="Kozmos" style={{ maxWidth: "60%" }} />
        <div style={{ marginTop: 40, fontSize: 12, opacity: 0.4 }}>
          (c) Kozmos - presence over performance.
        </div>
      </section>

      {/* SCREEN 3 */}
      <section
        ref={screen3Ref}
        style={{
          height: "100vh",
          scrollSnapAlign: "start",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          padding: 40,
          position: "relative",
        }}
      >
        <div
          className="matrix-rain"
          aria-hidden="true"
          style={
            {
              "--matrix-cols": matrixColumns.length,
            } as React.CSSProperties
          }
        >
          {matrixColumns.map((col) => (
            <div
              key={col.key}
              className={`matrix-column${col.glowColumn ? " matrix-column-glow" : ""}`}
            >
              {col.streams.map((stream) => (
                <span
                  key={stream.key}
                  className="matrix-stream"
                  style={
                    {
                      "--duration": `${stream.duration}s`,
                      "--delay": `${stream.delay}s`,
                      opacity: stream.opacity,
                      filter: `blur(${stream.blur}px)`,
                    } as React.CSSProperties
                  }
                >
                  {stream.text}
                </span>
              ))}
              {col.glowTail ? (
                <span className="matrix-tail-glow">{col.glowTail}</span>
              ) : null}
            </div>
          ))}
        </div>
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transform: "translateY(-40px)",
            position: "relative",
            zIndex: 1,
          }}
        >
          <div
            className={`principle-fade${principleDissolving ? " dissolve" : ""}`}
            onClick={dissolvePrinciple}
            style={{
              maxWidth: 520,
              fontSize: 18,
              textAlign: "center",
              cursor: principle ? "pointer" : "default",
              pointerEvents: principle ? "auto" : "none",
            }}
          >
            {activePrincipleText
              ? activePrincipleText.split("").map((char, idx) => {
                  const dx = ((idx * 17) % 11) - 5;
                  const dy = ((idx * 23) % 9) - 4;
                  const rot = ((idx * 29) % 16) - 8;
                  const delay = ((idx * 13) % 19) / 100;
                  return (
                    <span
                      key={`p-char-${idx}-${char}`}
                      className="principle-char"
                      style={
                        {
                          "--char-dx": `${dx * 1.6}px`,
                          "--char-dy": `${dy * 1.2}px`,
                          "--char-rot": `${rot}deg`,
                          "--char-delay": `${delay}s`,
                        } as React.CSSProperties
                      }
                    >
                      {char}
                    </span>
                  );
                })
              : ""}
          </div>
        </div>

        {/* AXY AREA */}
        <div
          className={`axy-shell${axyOpen ? " open" : ""}`}
          onClick={() => setAxyOpen((prev) => !prev)}
          role="button"
          tabIndex={0}
          aria-expanded={axyOpen}
          style={{ position: "relative", zIndex: 2 }}
        >
          <img src="/axy-banner.png" alt="Axy" className="axy-shell-logo" />

          <div className="axy-shell-chat" onClick={(e) => e.stopPropagation()}>
            <div className="axy-shell-card">
              <div style={{ marginBottom: 8, opacity: 0.8, fontSize: 12 }}>
                {axyReply ? (
                  axyReply
                ) : (
                  <>
                    I&apos;m <span className="axy-name-glow">Axy</span>. I exist
                    inside Kozmos·
                  </>
                )}
              </div>
              {lastUserMessage ? (
                <div
                  style={{
                    marginBottom: 10,
                    fontSize: 12,
                    color: "rgba(150, 95, 210, 0.9)",
                  }}
                >
                  {lastUserMessage}
                </div>
              ) : null}

              <input
                value={axyInput}
                onChange={(e) => setAxyInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && askAxy()}
                placeholder="say something"
                style={{
                  width: "100%",
                  background: "transparent",
                  border: "none",
                  borderBottom: "1px solid rgba(255,255,255,0.2)",
                  color: "#eaeaea",
                  fontSize: 12,
                  outline: "none",
                }}
              />

              <div
                style={{
                  marginTop: 8,
                  display: "flex",
                  gap: 12,
                  justifyContent: "center",
                  fontSize: 11,
                  opacity: 0.6,
                }}
              >
                <span
                  className="kozmos-tap"
                  onClick={askAxy}
                  style={{ cursor: "pointer" }}
                >
                  {axyLoading ? "..." : "ask"}
                </span>
                <span
                  className="kozmos-tap"
                  onClick={resetAxy}
                  style={{ cursor: "pointer" }}
                >
                  reset
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
