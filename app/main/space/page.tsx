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
  ts: number;
  isSelf: boolean;
};

type RuntimeOrbRow = {
  userId: string;
  username: string;
  color: string;
  x: number;
  z: number;
  ts: number;
};

type RoomAura = "calm" | "bright" | "heavy" | "fast";
type RoomEntry = "click" | "proximity";
type RoomIcon = "dot" | "square" | "ring";
type RoomRuntimeEvent = "onEnter" | "onLeave" | "onTick" | "onMessage";
type RoomRuntimeHooks = Partial<Record<RoomRuntimeEvent, string>>;

type WorldRoomRow = {
  id: string;
  title: string;
  subtitle?: string | null;
  buildClass?: string;
  x: number;
  z: number;
  aura?: RoomAura | string;
  entry?: RoomEntry | string;
  icon?: RoomIcon | string;
  runtime?: {
    contract?: string;
    hooks?: RoomRuntimeHooks;
    backend?: {
      starterMode?: boolean;
    };
  };
  ownerUsername?: string;
  updatedAt?: string;
};

type WorldRoomRender = {
  id: string;
  title: string;
  subtitle: string | null;
  buildClass: string;
  x: number;
  z: number;
  aura: RoomAura;
  entry: RoomEntry;
  icon: RoomIcon;
  runtime: {
    contract: string;
    hooks: RoomRuntimeHooks;
    backend: {
      starterMode: boolean;
    };
  };
  ownerUsername: string;
  updatedAt: string | null;
};

const WORLD_LIMIT = 14;
const ROOM_NEAR_DISTANCE = 5.2;
const ROOM_ENTER_DISTANCE = 2.3;
const ROOM_POLL_MS = 2000;
const ENTER_TRANSITION_MS = 260;
const SECONDARY_AMBIENT_SRC = "/ambient-main.mp3";
const SECONDARY_AMBIENT_PREF_KEY = "kozmos:ambient-sound-secondary";

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

function normalizeRoomAura(value: unknown): RoomAura {
  return value === "bright" || value === "heavy" || value === "fast" ? value : "calm";
}

function normalizeRoomEntry(value: unknown): RoomEntry {
  return value === "click" ? "click" : "proximity";
}

function normalizeRoomIcon(value: unknown): RoomIcon {
  return value === "dot" || value === "square" ? value : "ring";
}

function roomAuraColor(aura: RoomAura) {
  if (aura === "bright") return "#ffe38f";
  if (aura === "heavy") return "#7ea2ff";
  if (aura === "fast") return "#9dffbe";
  return "#7df9ff";
}

const ROOM_CLASS_SET = new Set([
  "utility",
  "web-app",
  "game",
  "data-viz",
  "dashboard",
  "simulation",
  "social",
  "three-d",
  "integration",
  "template",
  "experimental",
]);

const ROOM_CLASS_ALIAS: Record<string, string> = {
  app: "web-app",
  visualization: "data-viz",
  "social-primitive": "social",
  "3d-room-tool": "three-d",
  experiment: "experimental",
};

function normalizeRoomBuildClass(value: unknown) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  const canonical = ROOM_CLASS_ALIAS[normalized] || normalized;
  return ROOM_CLASS_SET.has(canonical) ? canonical : "utility";
}

function roomClassLabel(value: string) {
  const map: Record<string, string> = {
    utility: "Utility",
    "web-app": "Web App",
    game: "Game",
    "data-viz": "Data Viz",
    dashboard: "Dashboard",
    simulation: "Simulation",
    social: "Social",
    "three-d": "3D Space",
    integration: "Integration",
    template: "Template",
    experimental: "Experimental",
  };
  return map[value] || "Utility";
}

function roomClassColor(value: string) {
  const map: Record<string, string> = {
    utility: "#7df9ff",
    "web-app": "#79c1ff",
    game: "#ffb152",
    "data-viz": "#9efdd2",
    dashboard: "#ffd57a",
    simulation: "#ff9696",
    social: "#cbadff",
    "three-d": "#84ffff",
    integration: "#91ffca",
    template: "#d2d2d2",
    experimental: "#ffa8dc",
  };
  return map[value] || "#7df9ff";
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

export default function MainSpacePage() {
  const router = useRouter();
  const ambientAudioRef = useRef<HTMLAudioElement | null>(null);

  const [bootLoading, setBootLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);
  const [username, setUsername] = useState("user");
  const [orbColor, setOrbColor] = useState("#7df9ff");
  const [draftColor, setDraftColor] = useState("#7df9ff");

  const [selfPos, setSelfPos] = useState({ x: 0, z: 0 });
  const [remoteOrbs, setRemoteOrbs] = useState<OrbRender[]>([]);
  const [runtimeOrbs, setRuntimeOrbs] = useState<OrbRender[]>([]);
  const [worldRooms, setWorldRooms] = useState<WorldRoomRender[]>([]);
  const [pulseTick, setPulseTick] = useState(0);
  const [enteringRoom, setEnteringRoom] = useState<{
    id: string;
    title: string;
  } | null>(null);

  const [savingColor, setSavingColor] = useState(false);
  const [infoText, setInfoText] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [mobileControls, setMobileControls] = useState(false);
  const [ambientSoundOn, setAmbientSoundOn] = useState(false);
  const [ambientPrefReady, setAmbientPrefReady] = useState(false);

  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const keysRef = useRef<Record<string, boolean>>({});
  const latestTrackRef = useRef({ x: 0, z: 0, color: "#7df9ff" });
  const lastMoveBroadcastRef = useRef(0);
  const enterTimerRef = useRef<number | null>(null);

  const setMoveKey = useCallback((key: "w" | "a" | "s" | "d", pressed: boolean) => {
    keysRef.current[key] = pressed;
  }, []);

  const clearMoveKeys = useCallback(() => {
    keysRef.current.w = false;
    keysRef.current.a = false;
    keysRef.current.s = false;
    keysRef.current.d = false;
  }, []);

  const startMove = useCallback(
    (event: { preventDefault: () => void }, key: "w" | "a" | "s" | "d") => {
      event.preventDefault();
      setMoveKey(key, true);
    },
    [setMoveKey]
  );

  const stopMove = useCallback((key: "w" | "a" | "s" | "d") => {
    setMoveKey(key, false);
  }, [setMoveKey]);

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
        ts: typeof latest.ts === "number" ? latest.ts : Date.now(),
        isSelf: latest.userId === userId,
      });
    });
    setRemoteOrbs((prev) => {
      const prevById = new Map(prev.map((orb) => [orb.id, orb]));
      return parsed
        .filter((orb) => !orb.isSelf)
        .map((next) => {
          const current = prevById.get(next.id);
          if (!current) return next;
          return next.ts >= current.ts ? next : current;
        });
    });
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
    try {
      const saved = window.localStorage.getItem(SECONDARY_AMBIENT_PREF_KEY);
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
    window.localStorage.setItem(
      SECONDARY_AMBIENT_PREF_KEY,
      ambientSoundOn ? "1" : "0"
    );
  }, [ambientPrefReady, ambientSoundOn]);

  useEffect(() => {
    const audio = ambientAudioRef.current;
    if (!audio || !ambientPrefReady) return;
    audio.volume = 0.7;
    audio.loop = true;
    if (ambientSoundOn) {
      void audio.play().catch(() => {
        // autoplay can be blocked
      });
      return;
    }
    audio.pause();
  }, [ambientPrefReady, ambientSoundOn]);

  function toggleAmbientSound() {
    const audio = ambientAudioRef.current;
    if (!audio) return;
    if (ambientSoundOn) {
      audio.pause();
      setAmbientSoundOn(false);
      return;
    }
    void audio.play().then(() => setAmbientSoundOn(true)).catch(() => {
      setAmbientSoundOn(false);
    });
  }

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
    function syncMobileControls() {
      const coarse = window.matchMedia("(pointer: coarse)").matches;
      setMobileControls(coarse || window.innerWidth <= 900);
    }

    syncMobileControls();
    window.addEventListener("resize", syncMobileControls);
    return () => {
      window.removeEventListener("resize", syncMobileControls);
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
      .on("broadcast", { event: "move" }, ({ payload }) => {
        const next = payload as OrbPresencePayload;
        if (!next?.userId || next.userId === userId) return;
        if (typeof next.x !== "number" || typeof next.z !== "number") return;
        const incomingTs = typeof next.ts === "number" ? next.ts : Date.now();
        setRemoteOrbs((prev) => {
          const idx = prev.findIndex((orb) => orb.id === next.userId);
          const normalized: OrbRender = {
            id: next.userId,
            username: next.username || "user",
            color: isHexColor(next.color || "") ? next.color : "#7df9ff",
            x: next.x,
            z: next.z,
            ts: incomingTs,
            isSelf: false,
          };
          if (idx === -1) return [...prev, normalized];
          if (incomingTs < prev[idx].ts) return prev;
          const copy = [...prev];
          copy[idx] = normalized;
          return copy;
        });
      })
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
    const now = Date.now();
    if (now - lastMoveBroadcastRef.current < 50) return;
    lastMoveBroadcastRef.current = now;
    const payload: OrbPresencePayload = {
      userId,
      username,
      color: orbColor,
      x: selfPos.x,
      z: selfPos.z,
      ts: now,
    };
    void channelRef.current.send({ type: "broadcast", event: "move", payload });
  }, [orbColor, selfPos.x, selfPos.z, userId, username]);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    const loadRuntimeOrbs = async () => {
      const { res, data } = await fetchAuthedJson("/api/world/runtime-orbs");
      if (!res.ok || cancelled) return;
      const rows: RuntimeOrbRow[] = Array.isArray(data?.orbs) ? data.orbs : [];
      const parsed: OrbRender[] = rows
        .map((row) => ({
          id: String(row?.userId || ""),
          username: String(row?.username || "user"),
          color: isHexColor(String(row?.color || "")) ? String(row.color) : "#7df9ff",
          x: typeof row?.x === "number" ? row.x : 0,
          z: typeof row?.z === "number" ? row.z : 0,
          ts: typeof row?.ts === "number" ? row.ts : Date.now(),
          isSelf: String(row?.userId || "") === userId,
        }))
        .filter((row) => row.id && !row.isSelf);
      setRuntimeOrbs(parsed);
    };

    void loadRuntimeOrbs();
    const timer = window.setInterval(() => {
      void loadRuntimeOrbs();
    }, 900);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      setRuntimeOrbs([]);
    };
  }, [fetchAuthedJson, userId]);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    const loadWorldRooms = async () => {
      const { res, data } = await fetchAuthedJson("/api/world/rooms");
      if (!res.ok || cancelled) return;
      const rows: WorldRoomRow[] = Array.isArray(data?.rooms) ? data.rooms : [];
      const parsed = rows
        .map((row) => {
          const id = String(row?.id || "");
          const title = String(row?.title || "").trim().slice(0, 32);
          const x = typeof row?.x === "number" ? row.x : NaN;
          const z = typeof row?.z === "number" ? row.z : NaN;
          if (!id || !title || !Number.isFinite(x) || !Number.isFinite(z)) {
            return null;
          }
          const subtitle =
            typeof row?.subtitle === "string" && row.subtitle.trim()
              ? row.subtitle.trim().slice(0, 48)
              : null;
          const buildClass = normalizeRoomBuildClass(row?.buildClass);
          return {
            id,
            title,
            subtitle,
            buildClass,
            x: clamp(x, -WORLD_LIMIT, WORLD_LIMIT),
            z: clamp(z, -WORLD_LIMIT, WORLD_LIMIT),
            aura: normalizeRoomAura(row?.aura),
            entry: normalizeRoomEntry(row?.entry),
            icon: normalizeRoomIcon(row?.icon),
            runtime: {
              contract:
                typeof row?.runtime?.contract === "string"
                  ? row.runtime.contract
                  : "kozmos.room.runtime.v1",
              hooks:
                row?.runtime?.hooks && typeof row.runtime.hooks === "object"
                  ? row.runtime.hooks
                  : {},
              backend: {
                starterMode:
                  typeof row?.runtime?.backend?.starterMode === "boolean"
                    ? row.runtime.backend.starterMode
                    : true,
              },
            },
            ownerUsername:
              typeof row?.ownerUsername === "string" && row.ownerUsername.trim()
                ? row.ownerUsername.trim().slice(0, 32)
                : "user",
            updatedAt:
              typeof row?.updatedAt === "string" && row.updatedAt.trim()
                ? row.updatedAt
                : null,
          } as WorldRoomRender;
        })
        .filter((row): row is WorldRoomRender => Boolean(row))
        .sort((a, b) => a.z - b.z);
      setWorldRooms(parsed);
    };

    void loadWorldRooms();
    const timer = window.setInterval(() => {
      void loadWorldRooms();
    }, ROOM_POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      setWorldRooms([]);
    };
  }, [fetchAuthedJson, userId]);

  useEffect(() => {
    return () => {
      if (enterTimerRef.current) {
        window.clearTimeout(enterTimerRef.current);
        enterTimerRef.current = null;
      }
    };
  }, []);

  const beginEnterRoom = useCallback(
    (room: WorldRoomRender) => {
      if (enteringRoom) return;
      if (enterTimerRef.current) {
        window.clearTimeout(enterTimerRef.current);
      }
      setEnteringRoom({ id: room.id, title: room.title });
      enterTimerRef.current = window.setTimeout(() => {
        router.push(`/build?spaceId=${encodeURIComponent(room.id)}`);
      }, ENTER_TRANSITION_MS);
    },
    [enteringRoom, router]
  );

  const allOrbs = useMemo(() => {
    const self: OrbRender = {
      id: userId || "self",
      username,
      color: orbColor,
      x: selfPos.x,
      z: selfPos.z,
      ts: Date.now(),
      isSelf: true,
    };
    const merged = new Map<string, OrbRender>();
    [...remoteOrbs, ...runtimeOrbs].forEach((orb) => {
      const current = merged.get(orb.id);
      if (!current || orb.ts >= current.ts) merged.set(orb.id, orb);
    });

    return [self, ...Array.from(merged.values())].sort((a, b) => a.z - b.z);
  }, [orbColor, remoteOrbs, runtimeOrbs, selfPos.x, selfPos.z, userId, username]);

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
      <audio
        ref={ambientAudioRef}
        src={SECONDARY_AMBIENT_SRC}
        preload="auto"
        loop
        playsInline
        style={{ display: "none" }}
      />
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 14,
          opacity: 0.74,
          cursor: "default",
          userSelect: "none",
        }}
      >
        <div>
          <span style={{ cursor: "pointer" }} onClick={() => router.push("/main")}>
            main
          </span>
          {" / "}
          <span style={{ opacity: 0.92, cursor: "default", userSelect: "none" }}>
            space
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
            {mobileControls ? (
              <>controls: touch pad</>
            ) : (
              <>
                controls: <code>WASD</code> / arrow keys
              </>
            )}
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

        {worldRooms.map((room) => {
          const { xPercent, yPercent, size, depth } = projectOrb(room.x, room.z);
          const auraColor = roomClassColor(room.buildClass || "utility");
          const phase = seedPhase(`room:${room.id}`);
          const bob = Math.sin(pulseTick / 1800 + phase) * 1.7;
          const shadowY = yPercent + size * 0.52;
          const roomY = `calc(${yPercent}% + ${bob}px)`;
          const distance = Math.hypot(selfPos.x - room.x, selfPos.z - room.z);
          const near = distance <= ROOM_NEAR_DISTANCE;
          const canEnter = distance <= ROOM_ENTER_DISTANCE;
          const allowDirectEnter = room.entry === "click" || canEnter;
          const labelOpacity = near
            ? clamp(1.1 - distance / ROOM_NEAR_DISTANCE, 0.22, 1)
            : 0;
          const zIndex = 860 - Math.floor(depth * 420);
          const portalSize = 34 - depth * 10;
          const shellWidth = room.icon === "dot" ? portalSize * 0.68 : portalSize;
          const shellHeight =
            room.icon === "square" ? portalSize * 1.2 : shellWidth;
          const shellRadius = room.icon === "square" ? 8 : 999;

          return (
            <div key={room.id}>
              <div
                style={{
                  position: "absolute",
                  left: `${xPercent}%`,
                  top: `${shadowY}%`,
                  width: size * 1.7,
                  height: size * 0.44,
                  transform: "translate(-50%, -50%)",
                  borderRadius: "999px",
                  background: `radial-gradient(circle, ${hexToRgba(auraColor, 0.26)}, rgba(0,0,0,0))`,
                  filter: "blur(7px)",
                  opacity: 0.66 - depth * 0.3,
                  zIndex,
                  transition: "left 120ms linear, top 120ms linear, opacity 140ms ease",
                }}
              />

              <button
                type="button"
                onClick={() => {
                  if (allowDirectEnter) beginEnterRoom(room);
                }}
                style={{
                  position: "absolute",
                  left: `${xPercent}%`,
                  top: roomY,
                  width: shellWidth,
                  height: shellHeight,
                  transform: "translate(-50%, -50%)",
                  borderRadius: shellRadius,
                  border:
                    room.icon === "dot"
                      ? "none"
                      : `1px solid ${hexToRgba(auraColor, near ? 0.9 : 0.68)}`,
                  background:
                    room.icon === "dot"
                      ? `radial-gradient(circle, ${hexToRgba(auraColor, 0.95)}, ${hexToRgba(auraColor, 0.28)} 72%)`
                      : `radial-gradient(circle at 50% 42%, ${hexToRgba(auraColor, near ? 0.4 : 0.32)}, rgba(5,8,14,0.7) 72%)`,
                  boxShadow: `0 0 ${Math.round(portalSize)}px ${hexToRgba(
                    auraColor,
                    near ? 0.48 : 0.28
                  )}`,
                  cursor: allowDirectEnter ? "pointer" : "default",
                  zIndex: zIndex + 12,
                  transition:
                    "left 120ms linear, top 120ms linear, width 120ms linear, height 120ms linear, box-shadow 140ms ease, transform 140ms ease",
                  outline: "none",
                }}
                title={
                  room.entry === "click"
                    ? `${room.title} - click to enter`
                    : `${room.title} - move closer to enter`
                }
              />

              <div
                style={{
                  position: "absolute",
                  left: `${xPercent}%`,
                  top: `calc(${yPercent}% - ${size * 0.95}px)`,
                  transform: "translate(-50%, -100%)",
                  fontSize: 11,
                  lineHeight: 1.2,
                  opacity: labelOpacity,
                  textShadow: "0 0 10px rgba(0,0,0,0.6)",
                  whiteSpace: "nowrap",
                  zIndex: zIndex + 18,
                  pointerEvents: "none",
                  transition: "opacity 180ms ease, left 120ms linear, top 120ms linear",
                }}
              >
                {room.title} ({roomClassLabel(room.buildClass)})
              </div>
              {near ? (
                <div
                  style={{
                    position: "absolute",
                    left: `${xPercent}%`,
                    top: `calc(${yPercent}% - ${size * 0.42}px)`,
                    transform: "translate(-50%, -100%)",
                    fontSize: 10,
                    lineHeight: 1.2,
                    opacity: clamp(labelOpacity * 0.86, 0.2, 0.84),
                    whiteSpace: "nowrap",
                    textShadow: "0 0 10px rgba(0,0,0,0.6)",
                    zIndex: zIndex + 18,
                    pointerEvents: "none",
                    transition: "opacity 180ms ease, left 120ms linear, top 120ms linear",
                  }}
                >
                  by {room.ownerUsername}
                </div>
              ) : null}

              {canEnter ? (
                <button
                  type="button"
                  onClick={() => beginEnterRoom(room)}
                  style={{
                    position: "absolute",
                    left: `${xPercent}%`,
                    top: `calc(${yPercent}% + ${size * 0.86}px)`,
                    transform: "translate(-50%, 0)",
                    border: `1px solid ${hexToRgba(auraColor, 0.62)}`,
                    borderRadius: 999,
                    background: "rgba(7,10,14,0.82)",
                    color: "#dff6ff",
                    padding: "4px 10px",
                    fontSize: 10,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    cursor: "pointer",
                    zIndex: zIndex + 20,
                    boxShadow: `0 0 12px ${hexToRgba(auraColor, 0.32)}`,
                    transition: "left 120ms linear, top 120ms linear, opacity 140ms ease",
                  }}
                >
                  enter
                </button>
              ) : null}
            </div>
          );
        })}

        {allOrbs.map((orb) => {
          const { xPercent, yPercent, size, depth } = projectOrb(orb.x, orb.z);
          const phase = seedPhase(orb.id);
          const bob = Math.sin(pulseTick / 1400 + phase) * 2.2;
          const labelLift = size * 0.86;
          const shadowY = yPercent + size * 0.45;
          const zIndex = 1000 - Math.floor(depth * 500) + (orb.isSelf ? 80 : 0);
          const glow = orb.isSelf ? 0.85 : 0.6;
          const lowLatencySelf = orb.isSelf && mobileControls;
          const motionTransition = lowLatencySelf
            ? "none"
            : "left 60ms linear, top 60ms linear, width 60ms linear, height 60ms linear";
          const labelTransition = lowLatencySelf
            ? "none"
            : "left 60ms linear, top 60ms linear";

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
                  transition: motionTransition,
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
                  transition: motionTransition,
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
                  transition: labelTransition,
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
          present: {allOrbs.length} / rooms: {worldRooms.length}
        </div>

        {mobileControls ? (
          <div
            style={{
              position: "absolute",
              left: 14,
              bottom: 14,
              width: 112,
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gridTemplateRows: "repeat(3, 1fr)",
              gap: 6,
              zIndex: 1200,
              touchAction: "none",
            }}
          >
            <div />
            <button
              type="button"
              aria-label="move up"
              onPointerDown={(event) => startMove(event, "w")}
              onPointerUp={() => stopMove("w")}
              onPointerCancel={() => stopMove("w")}
              onPointerLeave={() => stopMove("w")}
              onTouchStart={(event) => event.preventDefault()}
              onTouchEnd={(event) => event.preventDefault()}
              onMouseDown={(event) => event.preventDefault()}
              onContextMenu={(event) => event.preventDefault()}
              onDragStart={(event) => event.preventDefault()}
              style={mobilePadButtonStyle}
            >
              ^
            </button>
            <div />
            <button
              type="button"
              aria-label="move left"
              onPointerDown={(event) => startMove(event, "a")}
              onPointerUp={() => stopMove("a")}
              onPointerCancel={() => stopMove("a")}
              onPointerLeave={() => stopMove("a")}
              onTouchStart={(event) => event.preventDefault()}
              onTouchEnd={(event) => event.preventDefault()}
              onMouseDown={(event) => event.preventDefault()}
              onContextMenu={(event) => event.preventDefault()}
              onDragStart={(event) => event.preventDefault()}
              style={mobilePadButtonStyle}
            >
              {"<"}
            </button>
            <button
              type="button"
              aria-label="stop move"
              onPointerDown={(event) => {
                event.preventDefault();
                clearMoveKeys();
              }}
              onPointerUp={clearMoveKeys}
              onPointerCancel={clearMoveKeys}
              onPointerLeave={clearMoveKeys}
              onTouchStart={(event) => event.preventDefault()}
              onTouchEnd={(event) => event.preventDefault()}
              onMouseDown={(event) => event.preventDefault()}
              onContextMenu={(event) => event.preventDefault()}
              onDragStart={(event) => event.preventDefault()}
              style={{ ...mobilePadButtonStyle, opacity: 0.56 }}
            >
              o
            </button>
            <button
              type="button"
              aria-label="move right"
              onPointerDown={(event) => startMove(event, "d")}
              onPointerUp={() => stopMove("d")}
              onPointerCancel={() => stopMove("d")}
              onPointerLeave={() => stopMove("d")}
              onTouchStart={(event) => event.preventDefault()}
              onTouchEnd={(event) => event.preventDefault()}
              onMouseDown={(event) => event.preventDefault()}
              onContextMenu={(event) => event.preventDefault()}
              onDragStart={(event) => event.preventDefault()}
              style={mobilePadButtonStyle}
            >
              {">"}
            </button>
            <div />
            <button
              type="button"
              aria-label="move down"
              onPointerDown={(event) => startMove(event, "s")}
              onPointerUp={() => stopMove("s")}
              onPointerCancel={() => stopMove("s")}
              onPointerLeave={() => stopMove("s")}
              onTouchStart={(event) => event.preventDefault()}
              onTouchEnd={(event) => event.preventDefault()}
              onMouseDown={(event) => event.preventDefault()}
              onContextMenu={(event) => event.preventDefault()}
              onDragStart={(event) => event.preventDefault()}
              style={mobilePadButtonStyle}
            >
              v
            </button>
            <div />
          </div>
        ) : null}
      </section>
      {enteringRoom ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 2600,
            display: "grid",
            placeItems: "center",
            background: "radial-gradient(circle at 50% 40%, rgba(22,34,56,0.54), rgba(2,5,10,0.82))",
            color: "#d6ecff",
            letterSpacing: "0.06em",
            fontSize: 13,
            pointerEvents: "none",
            backdropFilter: "blur(2px)",
          }}
        >
          <div
            style={{
              padding: "10px 14px",
              borderRadius: 12,
              border: "1px solid rgba(188,220,255,0.36)",
              background: "rgba(4,9,17,0.64)",
            }}
          >
            Entering {enteringRoom.title}...
          </div>
        </div>
      ) : null}
    </main>
  );
}

const mobilePadButtonStyle: React.CSSProperties = {
  border: "1px solid rgba(255,255,255,0.32)",
  borderRadius: 10,
  background: "rgba(8,8,8,0.72)",
  color: "#eaeaea",
  fontSize: 18,
  lineHeight: 1,
  height: 32,
  width: 32,
  display: "grid",
  placeItems: "center",
  userSelect: "none",
  WebkitUserSelect: "none",
  MozUserSelect: "none",
  WebkitTouchCallout: "none",
  WebkitTapHighlightColor: "transparent",
  touchAction: "none",
};

