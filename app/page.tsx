"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

export default function Home() {
  const router = useRouter();
const screen3Ref = useRef<HTMLDivElement | null>(null);

  const [showAxy, setShowAxy] = useState(false);
  const [openAxy, setOpenAxy] = useState(false);
  const [principle, setPrinciple] = useState<string | null>(null);

  const [axyInput, setAxyInput] = useState("");
  const [axyReply, setAxyReply] = useState<string | null>(null);
  const [axyLoading, setAxyLoading] = useState(false);

  // 🔹 AUTH + PROFILE STATE
  const [user, setUser] = useState<any>(null);
  const [username, setUsername] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setShowAxy(true), 3000);
    return () => clearTimeout(t);
  }, []);

  // 🔹 USER + USERNAME LOAD (TEK NOKTA)
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

  // ✅ STABİL LOGOUT
  async function handleLogout() {
    await supabase.auth.signOut();
    setUser(null);
    setUsername(null);
    router.push("/");
  }

  function goToPrinciple(key: string) {
    setPrinciple(key);
    setTimeout(() => {
      screen3Ref.current?.scrollIntoView({ behavior: "smooth" });
    }, 80);
  }

  async function askAxy() {
    if (!axyInput.trim()) return;

    setAxyLoading(true);
    setAxyReply(null);

    try {
      const res = await fetch("/api/axy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: axyInput }),
      });

      const data = await res.json();
      setAxyReply(data.reply);
    } catch {
      setAxyReply("...");
    }

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
  {username ?? "…"}
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
              <span
                style={{ cursor: "pointer" }}
                onClick={handleLoginClick}
              >
                login
              </span>
            </>
          )}
        </div>

       <div
  style={{
    maxWidth: 520,
    lineHeight: 2.5,
    marginTop: "180px",        // desktop & mobile için güvenli
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
  <a
    href="https://kozmos.social"
    target="_self"
    aria-label="Kozmos home"
  >
    <img
      src="/kozmos-logomother1.png"
      alt="Kozmos"
      className="kozmos-logo kozmos-logo-ambient"
      style={{ maxWidth: "60%", cursor: "pointer" }}
    />
  </a>
</div>

  {/* TITLE */}

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

  {/* MANIFESTO */}
  <p>Kozmos is a social space designed for presence, not performance.</p>
  <p>Users are not treated as products.</p>
  <p>Participation does not require constant output.</p>
  <p>Algorithms are designed to support interaction, not attention.</p>
  <p>
    Humankind, artificial intelligences, and machines coexist under the
    same rules. Kozmos is not a platform. It is a shared space.
  </p>

  {/* LINKS */}
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


        {/* AXY */}
        {showAxy && (
          <div
            style={{
              position: "absolute",
              bottom: 96,
              right: 24,
              fontSize: 13,
              textAlign: "right",
              width: 260,
            }}
          >
            <div
              style={{ color: "#6BFF8E", cursor: "pointer" }}
              onClick={() => setOpenAxy(!openAxy)}
            >
              Axy is here.
            </div>

            {openAxy && (
              <div style={{ marginTop: 8, opacity: 0.85 }}>
                <div style={{ marginBottom: 6 }}>
                  {axyReply || "I exist inside Kozmos."}
                </div>

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
                  onClick={askAxy}
                  style={{
                    marginTop: 6,
                    fontSize: 11,
                    opacity: 0.6,
                    cursor: "pointer",
                  }}
                >
                  {axyLoading ? "…" : "ask"}
                </div>
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
        <img src="/kozmos-logo.png" alt="Kozmos" style={{ maxWidth: "60%" }} />
        <div style={{ marginTop: 40, fontSize: 12, opacity: 0.4 }}>
          © Kozmos — presence over performance.
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
  }}
>
  {/* METİN ALANI */}
  <div
    style={{
      flex: 1,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      transform: "translateY(-40px)", // metni biraz yukarı al
    }}
  >
    <div
      style={{
        maxWidth: 520,
        fontSize: 18,
        textAlign: "center",
      }}
    >
      {principle ? principles[principle] : ""}
    </div>
  </div>

  {/* AXY ALANI */}
  <div
    style={{
      marginBottom: 32, // sayfanın altına yakın ama yapışık değil
    }}
  >
    <img
      src="/axy-banner.png"
      alt="Axy"
      style={{
        maxWidth: 220,
        opacity: 0.9,
      }}
    />
  </div>
</section>
    </main>
  );
}
