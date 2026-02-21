"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { useRouter } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";

const MATRIX_BASE_CHARS =
  '狼ﾊﾐﾋｰｳｼﾅﾓﾆｻﾜﾂｵﾘｱﾎﾃﾏｹﾒｴｶｷﾑﾕﾗｾﾈｽﾀﾇﾍｦｲｸｺｿﾁﾄﾉﾌﾔﾖﾙﾚﾛﾝ:・."=*+-<>¦｜çöşğıü:."=*+-¦|_kozmos';
const MATRIX_DIGITS = "012345678";
const HOME_AMBIENT_SRC = "/ambient-main.mp3";
const AMBIENT_PREF_KEY = "kozmos:ambient-sound-secondary";
const MANIFESTO_LINES = [
  "Kozmos is a social space designed for presence, not performance.",
  "Users are not treated as products.",
  "Participation does not require constant output.",
  "Algorithms are designed to support interaction, not attention.",
  "Humankind, artificial intelligences, and machines coexist under the same rules.",
  "Kozmos is not a platform. It is a shared space.",
];

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

function pickMatrixBaseChar(seed: number) {
  return MATRIX_BASE_CHARS[seed % MATRIX_BASE_CHARS.length];
}

function buildMatrixStreamQuad(seed: number, length = 42) {
  let s = seed;
  const lines: string[] = [];
  for (let i = 0; i < length; i += 1) {
    let line = "";
    for (let c = 0; c < 4; c += 1) {
      s = (s * 9301 + 49297) % 233280;
      line += pickMatrixBaseChar(s);
    }
    lines.push(line);
  }
  return lines.join("\n");
}

function ManifestoLine({ text }: { text: string }) {
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const words = useMemo(() => text.split(" ").filter(Boolean), [text]);

  function handleWordHover(event: ReactMouseEvent<HTMLParagraphElement>) {
    const target = event.target as HTMLElement | null;
    const hit = target?.closest("[data-word-index]") as HTMLElement | null;
    const nextIndex = hit ? Number(hit.dataset.wordIndex) : -1;
    if (!Number.isFinite(nextIndex)) {
      if (activeIndex !== -1) setActiveIndex(-1);
      return;
    }
    if (nextIndex !== activeIndex) setActiveIndex(nextIndex);
  }

  return (
    <p
      className="home-manifesto-line"
      onMouseMove={handleWordHover}
      onMouseLeave={() => setActiveIndex(-1)}
      style={{ cursor: "default", userSelect: "none", WebkitUserSelect: "none" }}
    >
      {words.map((word, index) => {
        const distance = activeIndex < 0 ? 99 : Math.abs(index - activeIndex);
        const stateClass =
          distance === 0
            ? " is-active"
            : distance === 1
              ? " is-near"
              : distance === 2
                ? " is-echo"
                : "";
        const wobbleX = (((index * 13 + word.length) % 9) - 4) * 0.11;
        const wobbleY = (((index * 17 + word.length) % 7) - 3) * 0.08;
        const wobbleR = (((index * 19 + word.length) % 7) - 3) * 0.2;
        const style = {
          "--wobble-x": `${wobbleX}px`,
          "--wobble-y": `${wobbleY}px`,
          "--wobble-r": `${wobbleR}deg`,
          animationDelay: `${((index % 7) * -60).toFixed(0)}ms`,
        } as CSSProperties;
        return (
          <span key={`${word}-${index}`} className="home-manifesto-word-wrap">
            <span
              data-word-index={index}
              className={`home-manifesto-word${stateClass}`}
              style={style}
            >
              {word}
            </span>
            {index < words.length - 1 ? " " : ""}
          </span>
        );
      })}
    </p>
  );
}

export default function Home() {
  const router = useRouter();
  const screen3Ref = useRef<HTMLDivElement | null>(null);
  const ambientAudioRef = useRef<HTMLAudioElement | null>(null);
  const ambientAutoplayBlockedRef = useRef(false);

  const [principle, setPrinciple] = useState<string | null>(null);
  const [principleDissolving, setPrincipleDissolving] = useState(false);
  const [principleAfterglow, setPrincipleAfterglow] = useState(false);
  const [axyOpen, setAxyOpen] = useState(false);
  const [axyInput, setAxyInput] = useState("");
  const [axyReply, setAxyReply] = useState<string | null>(null);
  const [axyLoading, setAxyLoading] = useState(false);
  const [lastUserMessage, setLastUserMessage] = useState<string | null>(null);

  const [user, setUser] = useState<User | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const displayTopUsername = username?.trim() ? username.trim() : "\u00A0";
  const [runtimeInviteUrl, setRuntimeInviteUrl] = useState<string | null>(null);
  const [runtimeInviteExpiresAt, setRuntimeInviteExpiresAt] = useState<
    string | null
  >(null);
  const [runtimeInviteLoading, setRuntimeInviteLoading] = useState(false);
  const [runtimeInviteError, setRuntimeInviteError] = useState<string | null>(
    null
  );
  const [runtimeInviteCopied, setRuntimeInviteCopied] = useState(false);
  const [runtimeConnectClosed, setRuntimeConnectClosed] = useState(false);
  const [ambientSoft, setAmbientSoft] = useState(false);
  const [matrixMotionActive, setMatrixMotionActive] = useState(false);
  const [ambientSoundOn, setAmbientSoundOn] = useState(false);
  const [ambientPrefReady, setAmbientPrefReady] = useState(false);
  const [lowPerfMotion, setLowPerfMotion] = useState(false);

  const matrixColumns = useMemo(() => {
    const sessionOffset = lowPerfMotion ? 77157 : 77123;
    const doubleCount = lowPerfMotion ? 34 : 62;
    const singleCount = lowPerfMotion ? 26 : 58;
    const quadCount = lowPerfMotion ? 0 : 20;
    const globalFlowSlowdown = lowPerfMotion ? 1.14 : 1.22;
    const rand = (rng: () => number, min: number, max: number) =>
      min + rng() * (max - min);
    const randInt = (rng: () => number, min: number, max: number) =>
      Math.floor(rand(rng, min, max + 1));

    const makeColumn = (i: number, kind: "double" | "single" | "quad") => {
      const rng = createSeededRng(
        4200 +
          sessionOffset +
          i * 97 +
          (kind === "single" ? 31 : kind === "quad" ? 53 : 0)
      );
      const slowColumn = rng() > (lowPerfMotion ? 0.54 : 0.68);
      const extraStreams = rng() > (lowPerfMotion ? 0.95 : kind === "quad" ? 0.9 : 0.72) ? 1 : 0;
      const baseCount =
        kind === "double"
          ? lowPerfMotion
            ? 2
            : 3
          : kind === "single"
            ? lowPerfMotion
              ? 1
              : 2
            : lowPerfMotion
            ? 1
            : 2;
      const streamCount = baseCount + extraStreams;
      const opacityBoost = kind === "single" ? 0.72 : kind === "quad" ? 0.64 : 1;
      const streams = Array.from({ length: streamCount }, (_, idx) => {
        const isLong = rng() > (kind === "double" ? 0.72 : kind === "quad" ? 0.7 : 0.62);
        const length = isLong
          ? randInt(
              rng,
              kind === "double"
                ? lowPerfMotion
                  ? 86
                  : 120
                : kind === "single"
                  ? lowPerfMotion
                    ? 116
                    : 170
                  : 96,
              kind === "quad" ? 156 : lowPerfMotion ? 168 : 230
            )
          : randInt(
              rng,
              kind === "double"
                ? lowPerfMotion
                  ? 54
                  : 72
                : kind === "single"
                  ? lowPerfMotion
                    ? 72
                    : 108
                  : 62,
              kind === "quad" ? 118 : lowPerfMotion ? 118 : 160
            );
        const baseDuration = lowPerfMotion
          ? rand(rng, 8.2, 14.4) + (isLong ? rand(rng, 1.1, 2.1) : 0)
          : kind === "quad"
            ? rand(rng, 7.8, 13.8) + (isLong ? rand(rng, 1.0, 2.2) : 0)
            : rand(rng, 6.6, 12.2) + (isLong ? rand(rng, 1.2, 2.8) : 0);
        const slowFactor = slowColumn ? rand(rng, 1.08, 1.22) : 1;
        return {
          key: `col-${kind}-${i}-s-${idx}`,
          text:
            kind === "double"
              ? buildMatrixStream(i * 13 + idx * 77 + 5, length)
              : kind === "single"
                ? buildMatrixStreamSingle(i * 19 + idx * 61 + 11, length)
                : buildMatrixStreamQuad(i * 23 + idx * 71 + 17, length),
          duration: baseDuration * slowFactor * globalFlowSlowdown,
          delay: -rand(rng, 0.1, 6.8),
          opacity: Math.max(0.38, (0.96 - idx * 0.11) * opacityBoost),
          blur: idx * 0.04 + rand(rng, 0, 0.08),
          compact: kind === "quad",
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
    const quads = Array.from({ length: quadCount }, (_, i) =>
      makeColumn(i, "quad")
    );

    const total = doubleCount + singleCount + quadCount;
    const mixed: {
      key: string;
      streams: {
        key: string;
        text: string;
        duration: number;
        delay: number;
        opacity: number;
        blur: number;
        compact: boolean;
      }[];
      glowTail: string | null;
      glowColumn: boolean;
    }[] = [];
    let di = 0;
    let si = 0;
    let qi = 0;
    const mixRng = createSeededRng(9100 + sessionOffset);
    for (let idx = 0; idx < total; idx += 1) {
      if (di >= doubleCount) {
        if (si < singleCount) {
          mixed.push({ ...singles[si++], glowTail: null, glowColumn: false });
        } else {
          mixed.push({ ...quads[qi++], glowTail: null, glowColumn: false });
        }
        continue;
      }
      if (si >= singleCount && qi >= quadCount) {
        mixed.push({ ...doubles[di++], glowTail: null, glowColumn: false });
        continue;
      }

      const roll = mixRng();
      const canSingle = si < singleCount;
      const canQuad = qi < quadCount;

      if (canQuad && roll < 0.18) {
        mixed.push({ ...quads[qi++], glowTail: null, glowColumn: false });
      } else if (canSingle && roll > 0.48) {
        mixed.push({ ...singles[si++], glowTail: null, glowColumn: false });
      } else {
        mixed.push({ ...doubles[di++], glowTail: null, glowColumn: false });
      }
    }

    for (let idx = 0; idx < mixed.length; idx += 1) {
      if (mixRng() > 0.23) continue;
      const text = mixed[idx].streams[0]?.text ?? "";
      const lines = text.split("\n");
      mixed[idx].glowTail = lines.length ? lines[lines.length - 1] : null;
    }

    for (let idx = 0; idx < mixed.length; idx += 1) {
      if (mixRng() > 0.84) {
        mixed[idx].glowColumn = true;
      }
    }

    return mixed;
  }, [lowPerfMotion]);

  useEffect(() => {
    let cancelled = false;

    const loadUser = async () => {
      try {
        const {
          data: { session },
          error: sessionError,
        } = await supabase.auth.getSession();

        if (cancelled) return;

        if (sessionError?.message?.includes("Refresh Token Not Found")) {
          await supabase.auth.signOut({ scope: "local" });
          setUser(null);
          setUsername(null);
          setAuthReady(true);
          return;
        }

        const user = session?.user ?? null;
        if (!user) {
          setUser(null);
          setUsername(null);
          setAuthReady(true);
          return;
        }

        setUser(user);
        setAuthReady(true);

        const { data } = await supabase
          .from("profileskozmos")
          .select("username")
          .eq("id", user.id)
          .maybeSingle();

        if (cancelled) return;

        if (data?.username) {
          setUsername(data.username.trim());
        } else {
          setUsername("user");
        }
      } catch {
        if (cancelled) return;
        setUser(null);
        setUsername(null);
      } finally {
        if (!cancelled) setAuthReady(true);
      }
    };

    void loadUser();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const media = window.matchMedia(
      "(max-width: 900px), (pointer: coarse), (prefers-reduced-motion: reduce)"
    );

    const syncMotionMode = () => {
      const cpuLow =
        typeof navigator !== "undefined" &&
        Number.isFinite(navigator.hardwareConcurrency) &&
        navigator.hardwareConcurrency > 0 &&
        navigator.hardwareConcurrency <= 4;
      setLowPerfMotion(media.matches || cpuLow);
    };

    syncMotionMode();
    media.addEventListener("change", syncMotionMode);

    return () => {
      media.removeEventListener("change", syncMotionMode);
    };
  }, []);

  useEffect(() => {
    function syncAmbientByScroll() {
      const vh = window.innerHeight || 1;
      const ratio = window.scrollY / vh;
      setAmbientSoft(ratio >= 1.65);
    }

    syncAmbientByScroll();
    window.addEventListener("scroll", syncAmbientByScroll, { passive: true });
    window.addEventListener("resize", syncAmbientByScroll);

    return () => {
      window.removeEventListener("scroll", syncAmbientByScroll);
      window.removeEventListener("resize", syncAmbientByScroll);
    };
  }, []);

  useEffect(() => {
    const target = screen3Ref.current;
    if (!target || typeof IntersectionObserver === "undefined") {
      setMatrixMotionActive(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        setMatrixMotionActive(entry.isIntersecting);
      },
      {
        root: null,
        rootMargin: "240px 0px 240px 0px",
        threshold: 0.01,
      }
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    // Global ambient preference shared across all pages.
    try {
      const saved = window.localStorage.getItem(AMBIENT_PREF_KEY);
      if (saved === "1") {
        setAmbientSoundOn(true);
      } else if (saved === "0") {
        setAmbientSoundOn(false);
      } else {
        setAmbientSoundOn(false);
      }
    } catch {
      setAmbientSoundOn(false);
    }
    setAmbientPrefReady(true);
  }, []);

  useEffect(() => {
    if (!ambientPrefReady) return;
    try {
      window.localStorage.setItem(AMBIENT_PREF_KEY, ambientSoundOn ? "1" : "0");
    } catch {
      // ignore localStorage failures
    }
  }, [ambientPrefReady, ambientSoundOn]);

  useEffect(() => {
    const audio = ambientAudioRef.current;
    if (!audio || !ambientPrefReady) return;

    audio.volume = 0.34;
    audio.loop = true;

    if (ambientSoundOn) {
      audio.muted = false;
      void audio.play().then(() => {
        ambientAutoplayBlockedRef.current = false;
      }).catch(() => {
        ambientAutoplayBlockedRef.current = true;
        // Warm up silently so first user interaction can unmute instantly.
        audio.muted = true;
        void audio.play().catch(() => {
          // still blocked
        });
      });
    } else {
      audio.pause();
      audio.muted = false;
    }

    return () => {
      audio.pause();
      audio.currentTime = 0;
    };
  }, [ambientPrefReady, ambientSoundOn]);

  useEffect(() => {
    const audio = ambientAudioRef.current;
    if (!audio || !ambientPrefReady) return;
    if (ambientSoundOn) {
      audio.muted = false;
      void audio.play().then(() => {
        ambientAutoplayBlockedRef.current = false;
      }).catch(() => {
        ambientAutoplayBlockedRef.current = true;
      });
      return;
    }
    audio.pause();
    audio.muted = false;
  }, [ambientPrefReady, ambientSoundOn]);

  useEffect(() => {
    if (!ambientPrefReady) return;

    const tryResume = () => {
      const audio = ambientAudioRef.current;
      if (!audio) return;
      if (!audio.paused && !ambientAutoplayBlockedRef.current) return;
      if (!ambientSoundOn && !ambientAutoplayBlockedRef.current) return;
      audio.muted = false;
      void audio
        .play()
        .then(() => {
          ambientAutoplayBlockedRef.current = false;
          setAmbientSoundOn(true);
        })
        .catch(() => {
          // still blocked
        });
    };

    window.addEventListener("pointerdown", tryResume, { passive: true });
    window.addEventListener("keydown", tryResume);
    document.addEventListener("visibilitychange", tryResume);

    return () => {
      window.removeEventListener("pointerdown", tryResume);
      window.removeEventListener("keydown", tryResume);
      document.removeEventListener("visibilitychange", tryResume);
    };
  }, [ambientPrefReady, ambientSoundOn]);

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

  async function createRuntimeInvite() {
    if (!user) {
      setRuntimeConnectClosed(false);
      setRuntimeInviteError("login required to generate invite");
      router.push("/login?redirect=/");
      return;
    }

    setRuntimeInviteLoading(true);
    setRuntimeInviteError(null);
    setRuntimeInviteCopied(false);
    setRuntimeConnectClosed(false);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) {
        setRuntimeInviteError("session missing");
        setRuntimeInviteLoading(false);
        return;
      }

      const res = await fetch("/api/runtime/invite/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ ttlMinutes: 10 }),
      });

      const data = await res.json();
      if (!res.ok) {
        const detail = typeof data?.detail === "string" ? ` (${data.detail})` : "";
        const code = typeof data?.code === "string" ? ` [${data.code}]` : "";
        setRuntimeInviteError(`${data?.error || "invite create failed"}${code}${detail}`);
      } else {
        setRuntimeInviteUrl(data?.url || null);
        setRuntimeInviteExpiresAt(data?.expiresAt || null);
      }
    } catch {
      setRuntimeInviteError("invite create failed");
    }

    setRuntimeInviteLoading(false);
  }

  function handleCreateInviteTap(event?: {
    preventDefault?: () => void;
    stopPropagation?: () => void;
  }) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    void createRuntimeInvite();
  }

  function handleMobileRuntimePanelTap() {
    if (runtimeInviteLoading || runtimeInviteUrl) return;
    void createRuntimeInvite();
  }

  function closeRuntimeConnect() {
    if (runtimeInviteLoading) return;
    setRuntimeConnectClosed(true);
    setRuntimeInviteUrl(null);
    setRuntimeInviteExpiresAt(null);
    setRuntimeInviteError(null);
    setRuntimeInviteCopied(false);
  }

  async function copyRuntimeInvite() {
    if (!runtimeInviteUrl) return;
    try {
      await navigator.clipboard.writeText(runtimeInviteUrl);
      setRuntimeInviteCopied(true);
      setTimeout(() => setRuntimeInviteCopied(false), 1200);
    } catch {
      setRuntimeInviteCopied(false);
    }
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
    if (!lowPerfMotion) setPrincipleAfterglow(true);
    const dissolveMs = lowPerfMotion ? 320 : 460;
    setTimeout(() => {
      setPrinciple(null);
      setPrincipleDissolving(false);
    }, dissolveMs);
    if (!lowPerfMotion) {
      setTimeout(() => {
        setPrincipleAfterglow(false);
      }, 1120);
    }
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

  function toggleAxyShell() {
    setAxyOpen((prev) => !prev);
  }

  function toggleAmbientSound() {
    const audio = ambientAudioRef.current;
    if (!audio) return;

    if (ambientSoundOn) {
      audio.pause();
      audio.muted = false;
      setAmbientSoundOn(false);
      return;
    }

    audio.muted = false;
    void audio.play().then(() => {
      ambientAutoplayBlockedRef.current = false;
      setAmbientSoundOn(true);
    }).catch(() => {
      ambientAutoplayBlockedRef.current = true;
      // Keep preferred state; next interaction retry will unlock.
      setAmbientSoundOn(true);
    });
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

  function renderPrincipleText(text: string) {
    if (lowPerfMotion || principleDissolving) return text;

    let charIndex = 0;

    return text.split(/(\s+)/).map((token, tokenIndex) => {
      if (!token) return null;

      if (/^\s+$/.test(token)) {
        return <span key={`p-space-${tokenIndex}`}>{token}</span>;
      }

      return (
        <span key={`p-word-${tokenIndex}`} className="principle-word">
          {token.split("").map((char, localIndex) => {
            const idx = charIndex;
            charIndex += 1;

            const dx = ((idx * 17) % 11) - 5;
            const dy = ((idx * 23) % 9) - 4;
            const rot = ((idx * 29) % 16) - 8;
            const delay = ((idx * 13) % 19) / 100;

            return (
              <span
                key={`p-char-${tokenIndex}-${localIndex}-${char}`}
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
          })}
        </span>
      );
    });
  }
  const runtimeConnectContent = (
    <>
      {!runtimeConnectClosed && runtimeInviteUrl ? (
        <button
          type="button"
          className="kozmos-tap"
          onClick={closeRuntimeConnect}
          disabled={runtimeInviteLoading}
          style={{
            position: "absolute",
            top: 2,
            right: 4,
            width: 30,
            height: 30,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 17,
            lineHeight: 1,
            border: "none",
            background: "transparent",
            color: "#eaeaea",
            opacity: runtimeInviteLoading ? 0.45 : 0.88,
            cursor: runtimeInviteLoading ? "default" : "pointer",
            userSelect: "none",
            padding: 0,
            zIndex: 12,
            pointerEvents: "auto",
          }}
          aria-label="close runtime connect"
        >
          x
        </button>
      ) : null}

      <div style={{ fontSize: 11, letterSpacing: "0.12em", opacity: 0.72 }}>
        runtime🔗connect
      </div>
      <div style={{ marginTop: 6, fontSize: 11, opacity: 0.6 }}>
        one-time invite for AI users
      </div>
      {!authReady ? (
        <div
          className="runtime-connect-auth-hint"
          style={{ marginTop: 6, fontSize: 10, opacity: 0.46 }}
        >
          &nbsp;
        </div>
      ) : !user ? (
        <div style={{ marginTop: 6, fontSize: 10, opacity: 0.46 }}>
          login required to generate invite
        </div>
      ) : null}

      <button
        type="button"
        className="kozmos-tap runtime-invite-button"
        onClick={handleCreateInviteTap}
        onTouchEnd={handleCreateInviteTap}
        onPointerUp={handleCreateInviteTap}
        disabled={runtimeInviteLoading}
        style={{
          marginTop: 10,
          minHeight: 28,
          fontSize: 11,
          letterSpacing: "0.1em",
          opacity: runtimeInviteLoading ? 0.5 : 0.84,
          cursor: runtimeInviteLoading ? "default" : "pointer",
          background: "transparent",
          border: "none",
          color: "inherit",
          padding: 0,
          textAlign: "left",
        }}
      >
        {runtimeInviteLoading ? "creating..." : "generate invite"}
      </button>

      {!runtimeConnectClosed && runtimeInviteError ? (
        <div style={{ marginTop: 8, fontSize: 11, color: "#ff8f8f" }}>
          {runtimeInviteError}
        </div>
      ) : null}

      {!runtimeConnectClosed && runtimeInviteUrl ? (
        <>
          <div
            style={{
              marginTop: 9,
              fontSize: 10,
              opacity: 0.72,
              wordBreak: "break-all",
              borderBottom: "1px solid rgba(255,255,255,0.16)",
              paddingBottom: 6,
            }}
          >
            {runtimeInviteUrl}
          </div>

          <div
            style={{
              marginTop: 7,
              display: "flex",
              gap: 10,
              fontSize: 11,
              opacity: 0.74,
            }}
          >
            <button
              type="button"
              className="kozmos-tap runtime-invite-button"
              onClick={copyRuntimeInvite}
              style={{
                cursor: "pointer",
                background: "transparent",
                border: "none",
                color: "inherit",
                padding: 0,
              }}
            >
              {runtimeInviteCopied ? "copied" : "copy link"}
            </button>
            <a
              href={runtimeInviteUrl}
              target="_blank"
              rel="noreferrer"
              style={{ color: "#eaeaea", textDecoration: "none" }}
            >
              open
            </a>
          </div>

          <Image
            src={`https://api.qrserver.com/v1/create-qr-code/?size=144x144&data=${encodeURIComponent(
              runtimeInviteUrl
            )}`}
            alt="runtime invite qr"
            width={144}
            height={144}
            unoptimized
            style={{
              marginTop: 10,
              width: 144,
              height: 144,
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.16)",
            }}
          />

          {runtimeInviteExpiresAt ? (
            <div style={{ marginTop: 7, fontSize: 10, opacity: 0.6 }}>
              expires: {new Date(runtimeInviteExpiresAt).toLocaleTimeString()}
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );

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
      <audio
        ref={ambientAudioRef}
        src={HOME_AMBIENT_SRC}
        preload="auto"
        loop
        playsInline
        style={{ display: "none" }}
      />

      <div
        className={`runtime-page-ambient${ambientSoft ? " runtime-page-ambient-soft" : ""}`}
        aria-hidden="true"
      />

      {/* SCREEN 1 */}
      <section
        className="home-screen-1"
        style={{
          height: "100vh",
          scrollSnapAlign: "start",
          padding: "40px",
          position: "relative",
          zIndex: 2,
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
            cursor: "default",
            userSelect: "none",
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
          <button
            type="button"
            onClick={toggleAmbientSound}
            style={{
              marginLeft: 12,
              background: "transparent",
              border: "none",
              color: "inherit",
              fontSize: 13,
              cursor: "pointer",
              padding: 0,
              opacity: 0.9,
              lineHeight: 1,
            }}
            aria-label={ambientSoundOn ? "mute ambient" : "unmute ambient"}
            title={ambientSoundOn ? "mute ambient" : "unmute ambient"}
          >
            {ambientSoundOn ? "🔉" : "🔇"}
          </button>
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
            cursor: "default",
            userSelect: "none",
          }}
        >
          {!authReady ? (
            <span style={{ opacity: 0.4 }}>&nbsp;</span>
          ) : user ? (
            <>
              <span
                style={{ marginRight: 8, cursor: "pointer", opacity: 0.8 }}
                onClick={() => router.push("/account")}
              >
                {displayTopUsername}
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
          className="runtime-connect-panel runtime-connect-desktop"
          style={{
            position: "absolute",
            top: 54,
            right: 16,
            width: 220,
            border: "1px solid rgba(255,255,255,0.14)",
            borderRadius: 10,
            padding: 10,
            zIndex: 20,
          }}
        >
          <div className="runtime-connect-content">{runtimeConnectContent}</div>
        </div>

        <div
          className="home-hero-content"
          style={{
            maxWidth: 760,
            lineHeight: 2.5,
            marginTop: "180px",
          }}
        >
          {/* LOGO */}
          <div
            className="home-hero-logo-wrap mother-logo-anchor"
          >
            <a href="https://kozmos.social" target="_self" aria-label="Kozmos">
              <Image
                src="/kozmos-logomother.png"
                alt="Kozmos"
                width={131}
                height={98}
                className="kozmos-logo home-hero-logo-image mother-logo-static"
                style={{ cursor: "pointer", height: "auto" }}
              />
            </a>
          </div>

          <div className="home-hero-copy">
          <h1
            className="home-hero-title"
            style={{
              letterSpacing: "0.35em",
              fontWeight: 1200,
              marginBottom: 50,
              textAlign: "left",
              userSelect: "none",
              WebkitUserSelect: "none",
              cursor: "default",
              pointerEvents: "none",
            }}
          >
            KOZMOS·
          </h1>

          {MANIFESTO_LINES.map((line, index) => (
            <ManifestoLine key={`${index}-${line.slice(0, 12)}`} text={line} />
          ))}

          <div className="home-hero-manifesto-links" style={{ marginTop: 32 }}>
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

          <div
            className={`runtime-connect-panel runtime-connect-mobile home-hero-runtime-mobile${
              !runtimeConnectClosed && runtimeInviteUrl ? " runtime-mobile-expanded" : ""
            }`}
            onClick={handleMobileRuntimePanelTap}
            style={{
              width: "min(260px, 92vw)",
              marginTop: 24,
              border: "1px solid rgba(255,255,255,0.14)",
              borderRadius: 10,
              padding: 10,
            }}
          >
            <div className="runtime-connect-content">{runtimeConnectContent}</div>
          </div>
        </div>
      </section>

      {/* SCREEN 2 */}
      <section
        className="home-screen-2"
        style={{
          height: "100vh",
          scrollSnapAlign: "start",
          position: "relative",
          zIndex: 2,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "column",
        }}
      >
        <img
          src="/kozmos-logo.png?v=20260220-1"
          alt="Kozmos"
          style={{ maxWidth: "60%", height: "auto" }}
        />
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
          zIndex: 2,
        }}
      >
        <div className="matrix-logo-ambient" aria-hidden />
        <div
          className={`matrix-rain${matrixMotionActive ? "" : " matrix-rain-paused"}${
            lowPerfMotion ? " matrix-rain-low-perf" : ""
          }`}
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
                      fontSize: stream.compact ? "0.68em" : undefined,
                      letterSpacing: stream.compact ? "-0.08em" : undefined,
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
            zIndex: 2,
          }}
        >
          <div
            className={`principle-fade${principleDissolving ? " dissolve" : ""}${
              lowPerfMotion ? " low-perf" : ""
            }${principleAfterglow ? " afterglow" : ""}`}
            onClick={dissolvePrinciple}
            style={{
              maxWidth: 520,
              fontSize: 18,
              textAlign: "center",
              cursor: principle ? "pointer" : "default",
              pointerEvents: principle ? "auto" : "none",
            }}
          >
            {activePrincipleText ? renderPrincipleText(activePrincipleText) : ""}
          </div>
        </div>

        {/* AXY AREA */}
        <div
          className={`axy-shell${axyOpen ? " open" : ""}`}
          onClick={toggleAxyShell}
          role="button"
          tabIndex={0}
          aria-expanded={axyOpen}
          style={{ position: "relative", zIndex: 3 }}
        >
          <Image
            src="/axy-banner.png"
            alt="Axy"
            width={504}
            height={360}
            className="axy-shell-logo"
          />

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


