"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

type OrbPresencePayload = {
  userId: string;
  username: string;
  color: string;
  x: number;
  z: number;
  ts: number;
};

type OrbRender = {
  id: string;
  username: string;
  color: string;
  x: number;
  z: number;
  isSelf: boolean;
};

const WORLD_LIMIT = 14;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function isHexColor(value: string) {
  return /^#[0-9A-Fa-f]{6}$/.test(value.trim());
}

function hexToRgba(hex: string, alpha: number) {
  const safe = isHexColor(hex) ? hex : "#7df9ff";
  const r = parseInt(safe.slice(1, 3), 16);
  const g = parseInt(safe.slice(3, 5), 16);
  const b = parseInt(safe.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function seedPhase(input: string) {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) % 10000;
  }
  return (hash / 10000) * Math.PI * 2;
}

function projectOrb(x: number, z: number) {
  const cx = clamp(x, -WORLD_LIMIT, WORLD_LIMIT);
  const cz = clamp(z, -WORLD_LIMIT, WORLD_LIMIT);
  const depth = (cz + WORLD_LIMIT) / (WORLD_LIMIT * 2); // 0 near, 1 far

  const xPercent = clamp(50 + cx * (2.8 - depth * 0.8), 4, 96);
  const yPercent = clamp(78 - cz * 1.35, 20, 94);
  const size = 40 - depth * 18;

  return { xPercent, yPercent, size, depth };
}

export default function MainMatrixPage() {
  const router = useRouter();

  const [bootLoading, setBootLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);
  const [username, setUsername] = useState("user");
  const [orbColor, setOrbColor] = useState("#7df9ff");
  const [draftColor, setDraftColor] = useState("#7df9ff");

  const [selfPos, setSelfPos] = useState({ x: 0, z: 0 });
  const [remoteOrbs, setRemoteOrbs] = useState<OrbRender[]>([]);
  const [pulseTick, setPulseTick] = useState(0);

  const [savingColor, setSavingColor] = useState(false);
  const [infoText, setInfoText] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const keysRef = useRef<Record<string, boolean>>({});
  const latestTrackRef = useRef({ x: 0, z: 0, color: "#7df9ff" });

  useEffect(() => {
    latestTrackRef.current = { x: selfPos.x, z: selfPos.z, color: orbColor };
  }, [selfPos.x, selfPos.z, orbColor]);

  const fetchAuthedJson = useCallback(async (url: string, init?: RequestInit) => {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    const headers = new Headers(init?.headers ?? {});
    if (session?.access_token) {
      headers.set("Authorization", `Bearer ${session.access_token}`);
    }
    if (init?.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const res = await fetch(url, { ...init, headers });
    const data = await res.json().catch(() => ({}));
    return { res, data } as const;
  }, []);

  const syncPresence = useCallback(() => {
    if (!channelRef.current) return;
    const state = channelRef.current.presenceState<OrbPresencePayload>();
    const parsed: OrbRender[] = [];
    Object.entries(state).forEach(([key, entries]) => {
      const latest = entries[entries.length - 1];
      if (!latest) return;
      parsed.push({
        id: key,
        username: latest.username || "user",
        color: isHexColor(latest.color || "") ? latest.color : "#7df9ff",
        x: typeof latest.x === "number" ? latest.x : 0,
        z: typeof latest.z === "number" ? latest.z : 0,
        isSelf: latest.userId === userId,
      });
    });
    setRemoteOrbs(parsed.filter((orb) => !orb.isSelf));
  }, [userId]);

  useEffect(() => {
    async function boot() {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user ?? null;
      if (!user) {
        setBootLoading(false);
        router.push("/login");
        return;
      }

      setUserId(user.id);

      const { res, data } = await fetchAuthedJson("/api/world/orb-settings");
      if (!res.ok || !data?.profile) {
        setBootLoading(false);
        setErrorText(data?.error || "could not load orb profile");
        return;
      }

      setUsername(data.profile.username || "user");
      setOrbColor(data.profile.orbColor || "#7df9ff");
      setDraftColor(data.profile.orbColor || "#7df9ff");
      setBootLoading(false);
    }

    void boot();
  }, [fetchAuthedJson, router]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      keysRef.current[event.key.toLowerCase()] = true;
    }

    function handleKeyUp(event: KeyboardEvent) {
      keysRef.current[event.key.toLowerCase()] = false;
    }

    function handleBlur() {
      keysRef.current = {};
    }

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, []);

  useEffect(() => {
    const moveTimer = window.setInterval(() => {
      const key = keysRef.current;
      const horizontal = Number(Boolean(key.d || key.arrowright)) - Number(Boolean(key.a || key.arrowleft));
      const vertical = Number(Boolean(key.w || key.arrowup)) - Number(Boolean(key.s || key.arrowdown));
      if (horizontal === 0 && vertical === 0) return;

      const norm = Math.hypot(horizontal, vertical) || 1;
      const speed = 0.18;
      const dx = (horizontal / norm) * speed;
      const dz = (vertical / norm) * speed;

      setSelfPos((prev) => ({
        x: clamp(prev.x + dx, -WORLD_LIMIT, WORLD_LIMIT),
        z: clamp(prev.z + dz, -WORLD_LIMIT, WORLD_LIMIT),
      }));
    }, 16);

    const pulseTimer = window.setInterval(() => {
      setPulseTick(Date.now());
    }, 60);

    return () => {
      window.clearInterval(moveTimer);
      window.clearInterval(pulseTimer);
    };
  }, []);

  useEffect(() => {
    if (!userId) return;

    const channel = supabase.channel("world-orbs-v1", {
      config: {
        presence: {
          key: userId,
        },
      },
    });
    channelRef.current = channel;

    const track = () =>
      channel.track({
        userId,
        username,
        color: latestTrackRef.current.color,
        x: latestTrackRef.current.x,
        z: latestTrackRef.current.z,
        ts: Date.now(),
      });

    channel
      .on("presence", { event: "sync" }, syncPresence)
      .on("presence", { event: "join" }, syncPresence)
      .on("presence", { event: "leave" }, syncPresence)
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await track();
          syncPresence();
        }
      });

    const trackTimer = window.setInterval(() => {
      void track();
    }, 250);

    return () => {
      window.clearInterval(trackTimer);
      void channel.unsubscribe();
      if (channelRef.current === channel) {
        channelRef.current = null;
      }
      setRemoteOrbs([]);
    };
  }, [syncPresence, userId, username]);

  useEffect(() => {
    if (!channelRef.current || !userId) return;
    void channelRef.current.track({
      userId,
      username,
      color: orbColor,
      x: selfPos.x,
      z: selfPos.z,
      ts: Date.now(),
    });
  }, [orbColor, selfPos.x, selfPos.z, userId, username]);

  const allOrbs = useMemo(() => {
    const self: OrbRender = {
      id: userId || "self",
      username,
      color: orbColor,
      x: selfPos.x,
      z: selfPos.z,
      isSelf: true,
    };
    return [self, ...remoteOrbs].sort((a, b) => a.z - b.z);
  }, [orbColor, remoteOrbs, selfPos.x, selfPos.z, userId, username]);

  async function saveOrbColor() {
    if (!isHexColor(draftColor)) {
      setErrorText("invalid color");
      return;
    }
    setSavingColor(true);
    setErrorText(null);
    setInfoText(null);
    try {
      const { res, data } = await fetchAuthedJson("/api/world/orb-settings", {
        method: "PATCH",
        body: JSON.stringify({ orbColor: draftColor }),
      });
      if (!res.ok || !data?.profile) {
        setErrorText(data?.error || "color update failed");
        return;
      }
      setOrbColor(data.profile.orbColor || draftColor);
      setInfoText("orb color updated");
    } finally {
      setSavingColor(false);
    }
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/");
  }

  if (bootLoading) {
    return (
      <main style={{ minHeight: "100vh", background: "#0b0b0b", color: "#eaeaea", padding: 24 }}>
        loading 3d main...
      </main>
    );
  }

  return (
    <main style={{ minHeight: "100vh", background: "#0b0b0b", color: "#eaeaea", padding: "18px 18px 28px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, opacity: 0.74 }}>
        <div>
          <span style={{ cursor: "pointer" }} onClick={() => router.push("/main")}>
            main
          </span>
          {" / "}
          <span style={{ opacity: 0.92, cursor: "default", userSelect: "none" }}>
            matrix
          </span>
        </div>
        <div>
          <span
            style={{ cursor: "pointer", userSelect: "none" }}
            onClick={() => router.push("/account")}
          >
            {username}
          </span>
          {" / "}
          <span style={{ cursor: "pointer" }} onClick={handleLogout}>
            logout
          </span>
        </div>
      </div>

      <section
        style={{
          marginTop: 14,
          border: "1px solid rgba(255,255,255,0.15)",
          borderRadius: 12,
          padding: 12,
          background: "rgba(255,255,255,0.02)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <label style={{ fontSize: 12, opacity: 0.74 }}>orb color</label>
            <input
              type="color"
              value={draftColor}
              onChange={(e) => setDraftColor(e.target.value)}
              style={{
                width: 34,
                height: 28,
                border: "1px solid rgba(255,255,255,0.25)",
                borderRadius: 8,
                background: "transparent",
                padding: 2,
                cursor: "pointer",
              }}
            />
            <button
              onClick={saveOrbColor}
              disabled={savingColor}
              style={{
                border: "1px solid rgba(255,255,255,0.28)",
                background: "transparent",
                color: "#eaeaea",
                borderRadius: 8,
                padding: "7px 11px",
                fontSize: 12,
                cursor: savingColor ? "default" : "pointer",
              }}
            >
              {savingColor ? "saving..." : "save color"}
            </button>
          </div>

          <div style={{ fontSize: 12, opacity: 0.66 }}>
            controls: <code>WASD</code> / arrow keys
          </div>
        </div>

        {infoText ? <div style={{ marginTop: 8, fontSize: 12, color: "#b8ffd1" }}>{infoText}</div> : null}
        {errorText ? <div style={{ marginTop: 8, fontSize: 12, color: "#ff9d9d" }}>{errorText}</div> : null}
      </section>

      <section
        style={{
          marginTop: 14,
          border: "1px solid rgba(255,255,255,0.15)",
          borderRadius: 12,
          overflow: "hidden",
          background:
            "radial-gradient(circle at 50% 22%, rgba(130,170,255,0.22), rgba(11,11,11,1) 58%)",
          height: 560,
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "72%",
            width: "120%",
            height: "52%",
            transform: "translateX(-50%)",
            borderTop: "1px solid rgba(255,255,255,0.18)",
            backgroundImage:
              "linear-gradient(rgba(255,255,255,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.08) 1px, transparent 1px)",
            backgroundSize: "40px 40px",
            opacity: 0.24,
            filter: "blur(0.4px)",
          }}
        />

        {allOrbs.map((orb) => {
          const { xPercent, yPercent, size, depth } = projectOrb(orb.x, orb.z);
          const phase = seedPhase(orb.id);
          const bob = Math.sin(pulseTick / 1400 + phase) * 2.2;
          const labelLift = size * 0.86;
          const shadowY = yPercent + size * 0.45;
          const zIndex = 1000 - Math.floor(depth * 500) + (orb.isSelf ? 80 : 0);
          const glow = orb.isSelf ? 0.85 : 0.6;

          return (
            <div key={orb.id}>
              <div
                style={{
                  position: "absolute",
                  left: `${xPercent}%`,
                  top: `${shadowY}%`,
                  width: size * 1.42,
                  height: size * 0.38,
                  transform: "translate(-50%, -50%)",
                  borderRadius: "999px",
                  background: `radial-gradient(circle, ${hexToRgba(orb.color, 0.34)}, rgba(0,0,0,0))`,
                  filter: "blur(5px)",
                  opacity: 0.75 - depth * 0.35,
                  zIndex,
                }}
              />

              <div
                style={{
                  position: "absolute",
                  left: `${xPercent}%`,
                  top: `calc(${yPercent}% + ${bob}px)`,
                  width: size,
                  height: size,
                  transform: "translate(-50%, -50%)",
                  borderRadius: "999px",
                  background: `radial-gradient(circle at 28% 26%, rgba(255,255,255,0.96), ${hexToRgba(
                    orb.color,
                    0.92
                  )} 38%, ${hexToRgba(orb.color, 0.35)} 72%)`,
                  boxShadow: `0 0 ${Math.round(size * 0.9)}px ${hexToRgba(orb.color, glow)}`,
                  border: orb.isSelf ? "1px solid rgba(255,255,255,0.85)" : "1px solid rgba(255,255,255,0.45)",
                  zIndex: zIndex + 10,
                }}
              />

              <div
                style={{
                  position: "absolute",
                  left: `${xPercent}%`,
                  top: `calc(${yPercent}% + ${bob}px - ${labelLift}px)`,
                  transform: "translate(-50%, -100%)",
                  fontSize: orb.isSelf ? 12 : 11,
                  opacity: orb.isSelf ? 0.92 : 0.75,
                  textShadow: "0 0 10px rgba(0,0,0,0.6)",
                  whiteSpace: "nowrap",
                  zIndex: zIndex + 20,
                  pointerEvents: "none",
                }}
              >
                {orb.isSelf ? `${orb.username} (you)` : orb.username}
              </div>
            </div>
          );
        })}

        <div style={{ position: "absolute", left: 12, bottom: 12, fontSize: 11, opacity: 0.7 }}>
          x: {selfPos.x.toFixed(1)} / z: {selfPos.z.toFixed(1)}
        </div>
        <div style={{ position: "absolute", right: 12, bottom: 12, fontSize: 11, opacity: 0.7 }}>
          present: {allOrbs.length}
        </div>
      </section>
    </main>
  );
}
