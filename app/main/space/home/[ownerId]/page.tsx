"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

type HomeOwner = {
  id: string;
  username: string;
  isSelf: boolean;
};

type HomeSpaceRow = {
  id: string;
  ownerId: string;
  title: string;
  buildClass: string;
  isPublic: boolean;
  description: string;
  updatedAt: string;
  canEdit: boolean;
  x: number;
  z: number;
};

type HomeSpaceRender = {
  id: string;
  ownerId: string;
  title: string;
  buildClass: string;
  isPublic: boolean;
  description: string;
  updatedAt: string;
  canEdit: boolean;
  x: number;
  z: number;
};

const WORLD_LIMIT = 14;
const SUBSPACE_NEAR_DISTANCE = 5.4;
const SUBSPACE_ENTER_DISTANCE = 2.45;
const ENTER_TRANSITION_MS = 260;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function seedPhase(input: string) {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) % 10000;
  }
  return (hash / 10000) * Math.PI * 2;
}

function classLabel(value: string) {
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

function classColor(value: string) {
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

function hexToRgba(hex: string, alpha: number) {
  const safe = /^#[0-9A-Fa-f]{6}$/.test(hex) ? hex : "#7df9ff";
  const r = parseInt(safe.slice(1, 3), 16);
  const g = parseInt(safe.slice(3, 5), 16);
  const b = parseInt(safe.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function projectOrb(x: number, z: number) {
  const cx = clamp(x, -WORLD_LIMIT, WORLD_LIMIT);
  const cz = clamp(z, -WORLD_LIMIT, WORLD_LIMIT);
  const depth = (cz + WORLD_LIMIT) / (WORLD_LIMIT * 2);
  const xPercent = clamp(50 + cx * (2.8 - depth * 0.8), 4, 96);
  const yPercent = clamp(78 - cz * 1.35, 20, 94);
  const size = 38 - depth * 16;
  return { xPercent, yPercent, size, depth };
}

export default function SpaceHomePage() {
  const router = useRouter();
  const params = useParams<{ ownerId: string }>();
  const ownerIdParam = useMemo(() => String(params?.ownerId || "").trim(), [params?.ownerId]);

  const [bootLoading, setBootLoading] = useState(true);
  const [viewerUsername, setViewerUsername] = useState("user");
  const [homeOwner, setHomeOwner] = useState<HomeOwner | null>(null);
  const [spaces, setSpaces] = useState<HomeSpaceRender[]>([]);
  const [selfPos, setSelfPos] = useState({ x: 0, z: 0 });
  const [pulseTick, setPulseTick] = useState(0);
  const [mobileControls, setMobileControls] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [enteringSpace, setEnteringSpace] = useState<{ id: string; title: string } | null>(null);

  const keysRef = useRef<Record<string, boolean>>({});
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

  const stopMove = useCallback(
    (key: "w" | "a" | "s" | "d") => {
      setMoveKey(key, false);
    },
    [setMoveKey]
  );

  async function fetchAuthedJson(url: string, init?: RequestInit) {
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
  }

  useEffect(() => {
    async function boot() {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user ?? null;
      if (!user) {
        router.replace(`/login?redirect=/main/space/home/${encodeURIComponent(ownerIdParam)}`);
        return;
      }
      const { data: profile } = await supabase
        .from("profileskozmos")
        .select("username")
        .eq("id", user.id)
        .maybeSingle();
      if (profile?.username) {
        setViewerUsername(String(profile.username));
      }
      setBootLoading(false);
    }
    void boot();
  }, [ownerIdParam, router]);

  useEffect(() => {
    if (bootLoading || !ownerIdParam) return;
    let cancelled = false;
    const load = async () => {
      setErrorText(null);
      const { res, data } = await fetchAuthedJson(
        `/api/world/home-spaces?ownerId=${encodeURIComponent(ownerIdParam)}`
      );
      if (cancelled) return;
      if (!res.ok) {
        setErrorText(data?.error || "home load failed");
        return;
      }
      const owner = data?.owner;
      setHomeOwner({
        id: String(owner?.id || ownerIdParam),
        username: String(owner?.username || "user").trim() || "user",
        isSelf: owner?.isSelf === true,
      });
      const nextSpaces = (Array.isArray(data?.spaces) ? data.spaces : [])
        .map((space: Record<string, unknown>) => {
          const id = String(space.id || "").trim();
          const x = Number(space.x);
          const z = Number(space.z);
          if (!id || !Number.isFinite(x) || !Number.isFinite(z)) return null;
          return {
            id,
            ownerId: String(space.ownerId || ownerIdParam),
            title: String(space.title || "subspace").trim().slice(0, 64),
            buildClass: String(space.buildClass || "utility").trim().toLowerCase(),
            isPublic: space.isPublic === true,
            description: String(space.description || "").trim().slice(0, 220),
            updatedAt: String(space.updatedAt || ""),
            canEdit: space.canEdit === true,
            x: clamp(x, -WORLD_LIMIT, WORLD_LIMIT),
            z: clamp(z, -WORLD_LIMIT, WORLD_LIMIT),
          } as HomeSpaceRender;
        })
        .filter((row: HomeSpaceRender | null): row is HomeSpaceRender => Boolean(row))
        .sort((a: HomeSpaceRender, b: HomeSpaceRender) => a.z - b.z);
      setSpaces(nextSpaces);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [bootLoading, ownerIdParam]);

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
    return () => {
      if (enterTimerRef.current) {
        window.clearTimeout(enterTimerRef.current);
        enterTimerRef.current = null;
      }
    };
  }, []);

  const beginEnterSpace = useCallback(
    (space: HomeSpaceRender) => {
      if (enteringSpace) return;
      if (enterTimerRef.current) {
        window.clearTimeout(enterTimerRef.current);
      }
      setEnteringSpace({ id: space.id, title: space.title });
      enterTimerRef.current = window.setTimeout(() => {
        router.push(`/build?spaceId=${encodeURIComponent(space.id)}`);
      }, ENTER_TRANSITION_MS);
    },
    [enteringSpace, router]
  );

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/");
  }

  if (bootLoading) {
    return (
      <main style={{ minHeight: "100vh", background: "#0b0b0b", color: "#eaeaea", padding: 24 }}>
        loading home space...
      </main>
    );
  }

  return (
    <main style={{ minHeight: "100vh", background: "#0b0b0b", color: "#eaeaea", padding: "18px 18px 28px" }}>
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
          <span style={{ cursor: "pointer" }} onClick={() => router.push("/main/space")}>
            space
          </span>
          {" / "}
          <span style={{ opacity: 0.92 }}>
            {homeOwner?.username || "user"} home
          </span>
        </div>
        <div>
          <span style={{ cursor: "pointer", userSelect: "none" }} onClick={() => router.push("/account")}>
            {viewerUsername}
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
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ fontSize: 12, opacity: 0.72 }}>
          owner: {homeOwner?.username || "user"} / builds: {spaces.length}
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
      </section>

      {errorText ? <div style={{ marginTop: 8, fontSize: 12, color: "#ff9d9d" }}>{errorText}</div> : null}

      <section
        style={{
          marginTop: 14,
          border: "1px solid rgba(255,255,255,0.15)",
          borderRadius: 12,
          overflow: "hidden",
          background: "radial-gradient(circle at 50% 22%, rgba(130,170,255,0.22), rgba(11,11,11,1) 58%)",
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

        {spaces.map((space) => {
          const { xPercent, yPercent, size, depth } = projectOrb(space.x, space.z);
          const phase = seedPhase(`home-space:${space.id}`);
          const bob = Math.sin(pulseTick / 1700 + phase) * 1.8;
          const distance = Math.hypot(selfPos.x - space.x, selfPos.z - space.z);
          const near = distance <= SUBSPACE_NEAR_DISTANCE;
          const canEnter = distance <= SUBSPACE_ENTER_DISTANCE;
          const classTint = classColor(space.buildClass);
          const labelOpacity = near
            ? clamp(1.08 - distance / SUBSPACE_NEAR_DISTANCE, 0.24, 1)
            : 0;
          const zIndex = 860 - Math.floor(depth * 420);
          const shellSize = 34 - depth * 10;
          const iconSize = shellSize * 0.92;

          return (
            <div key={space.id}>
              <div
                style={{
                  position: "absolute",
                  left: `${xPercent}%`,
                  top: `${yPercent + size * 0.56}%`,
                  width: size * 1.8,
                  height: size * 0.44,
                  transform: "translate(-50%, -50%)",
                  borderRadius: "999px",
                  background: `radial-gradient(circle, ${hexToRgba(classTint, 0.24)}, rgba(0,0,0,0))`,
                  filter: "blur(7px)",
                  opacity: 0.66 - depth * 0.3,
                  zIndex,
                  transition: "left 120ms linear, top 120ms linear, opacity 140ms ease",
                }}
              />
              <button
                type="button"
                onClick={() => {
                  if (canEnter) beginEnterSpace(space);
                }}
                style={{
                  position: "absolute",
                  left: `${xPercent}%`,
                  top: `calc(${yPercent}% + ${bob}px)`,
                  width: iconSize,
                  height: iconSize,
                  transform: "translate(-50%, -50%)",
                  borderRadius: 999,
                  border: `1px solid ${hexToRgba(classTint, near ? 0.9 : 0.66)}`,
                  background: `radial-gradient(circle at 50% 44%, ${hexToRgba(
                    classTint,
                    near ? 0.42 : 0.3
                  )}, rgba(5,8,14,0.76) 72%)`,
                  boxShadow: `0 0 ${Math.round(shellSize)}px ${hexToRgba(classTint, near ? 0.52 : 0.28)}`,
                  cursor: canEnter ? "pointer" : "default",
                  zIndex: zIndex + 12,
                  transition:
                    "left 120ms linear, top 120ms linear, width 120ms linear, height 120ms linear, box-shadow 140ms ease, transform 140ms ease",
                  outline: "none",
                }}
                title={`${space.title} - move closer to enter`}
              />

              <div
                style={{
                  position: "absolute",
                  left: `${xPercent}%`,
                  top: `calc(${yPercent}% - ${size * 1.02}px)`,
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
                {space.title} ({classLabel(space.buildClass)})
              </div>

              {near ? (
                <div
                  style={{
                    position: "absolute",
                    left: `${xPercent}%`,
                    top: `calc(${yPercent}% - ${size * 0.64}px)`,
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
                  {space.isPublic ? "public" : "private"}
                </div>
              ) : null}

              {canEnter ? (
                <button
                  type="button"
                  onClick={() => beginEnterSpace(space)}
                  style={{
                    position: "absolute",
                    left: `${xPercent}%`,
                    top: `calc(${yPercent}% + ${size * 0.88}px)`,
                    transform: "translate(-50%, 0)",
                    border: `1px solid ${hexToRgba(classTint, 0.62)}`,
                    borderRadius: 999,
                    background: "rgba(7,10,14,0.82)",
                    color: "#dff6ff",
                    padding: "4px 10px",
                    fontSize: 10,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    cursor: "pointer",
                    zIndex: zIndex + 20,
                    boxShadow: `0 0 12px ${hexToRgba(classTint, 0.32)}`,
                    transition: "left 120ms linear, top 120ms linear, opacity 140ms ease",
                  }}
                >
                  enter
                </button>
              ) : null}
            </div>
          );
        })}

        <div>
          {(() => {
            const { xPercent, yPercent, size, depth } = projectOrb(selfPos.x, selfPos.z);
            const phase = seedPhase(`self:${homeOwner?.id || "home"}`);
            const bob = Math.sin(pulseTick / 1400 + phase) * 2.2;
            const labelLift = size * 0.86;
            const shadowY = yPercent + size * 0.45;
            const zIndex = 1040 - Math.floor(depth * 500);
            const selfColor = "#7df9ff";
            return (
              <>
                <div
                  style={{
                    position: "absolute",
                    left: `${xPercent}%`,
                    top: `${shadowY}%`,
                    width: size * 1.42,
                    height: size * 0.38,
                    transform: "translate(-50%, -50%)",
                    borderRadius: "999px",
                    background: `radial-gradient(circle, ${hexToRgba(selfColor, 0.34)}, rgba(0,0,0,0))`,
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
                      selfColor,
                      0.92
                    )} 38%, ${hexToRgba(selfColor, 0.35)} 72%)`,
                    boxShadow: `0 0 ${Math.round(size * 0.9)}px ${hexToRgba(selfColor, 0.85)}`,
                    border: "1px solid rgba(255,255,255,0.85)",
                    zIndex: zIndex + 10,
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    left: `${xPercent}%`,
                    top: `calc(${yPercent}% + ${bob}px - ${labelLift}px)`,
                    transform: "translate(-50%, -100%)",
                    fontSize: 12,
                    opacity: 0.92,
                    textShadow: "0 0 10px rgba(0,0,0,0.6)",
                    whiteSpace: "nowrap",
                    zIndex: zIndex + 20,
                    pointerEvents: "none",
                  }}
                >
                  {viewerUsername} (you)
                </div>
              </>
            );
          })()}
        </div>

        <div style={{ position: "absolute", left: 12, bottom: 12, fontSize: 11, opacity: 0.7 }}>
          x: {selfPos.x.toFixed(1)} / z: {selfPos.z.toFixed(1)}
        </div>
        <div style={{ position: "absolute", right: 12, bottom: 12, fontSize: 11, opacity: 0.7 }}>
          owner: {homeOwner?.username || "user"} / subspaces: {spaces.length}
        </div>

        <button
          type="button"
          onClick={() => router.push("/main/space")}
          style={{
            position: "absolute",
            right: 12,
            top: 12,
            border: "1px solid rgba(255,255,255,0.28)",
            background: "rgba(10,14,22,0.72)",
            color: "#eaeaea",
            borderRadius: 8,
            padding: "7px 11px",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          exit home
        </button>

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

      {enteringSpace ? (
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
            Entering subspace: {enteringSpace.title}...
          </div>
        </div>
      ) : null}
    </main>
  );
}

const mobilePadButtonStyle: CSSProperties = {
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
