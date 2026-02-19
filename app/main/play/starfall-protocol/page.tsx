"use client";
/* eslint-disable react-hooks/immutability */

import type { CSSProperties, PointerEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type PlayMode = "single" | "multi";
type Phase = "menu" | "playing" | "victory" | "game-over";

type Player = {
  id: "p1" | "p2";
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  lives: number;
  cooldown: number;
  invulnerableFor: number;
  alive: boolean;
  score: number;
};

type Enemy = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  alive: boolean;
};

type Bullet = {
  id: string;
  owner: "p1" | "p2" | "enemy";
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  alive: boolean;
};

type Star = {
  x: number;
  y: number;
  size: number;
  speed: number;
};

type GameState = {
  phase: Phase;
  mode: PlayMode;
  worldWidth: number;
  worldHeight: number;
  players: Player[];
  enemies: Enemy[];
  playerBullets: Bullet[];
  enemyBullets: Bullet[];
  enemyDirection: 1 | -1;
  enemySpeed: number;
  enemyShootCooldown: number;
  wave: number;
  score: number;
  elapsed: number;
  stars: Star[];
  nextBulletId: number;
};

type HudState = {
  phase: Phase;
  mode: PlayMode;
  score: number;
  wave: number;
  elapsed: number;
  livesLabel: string;
};

declare global {
  interface Window {
    render_game_to_text?: () => string;
    advanceTime?: (ms: number) => void | Promise<void>;
  }
}

const LOGICAL_WIDTH = 960;
const LOGICAL_HEIGHT = 640;
const PLAYER_SPEED = 360;
const PLAYER_BULLET_SPEED = -640;
const ENEMY_BULLET_SPEED = 260;
const ENEMY_DROP = 24;
const PLAYER_MARGIN_BOTTOM = 56;
const EDGE_PADDING = 24;
const MAX_WAVE = 3;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function intersects(a: { x: number; y: number; width: number; height: number }, b: Bullet) {
  return (
    b.x + b.radius >= a.x &&
    b.x - b.radius <= a.x + a.width &&
    b.y + b.radius >= a.y &&
    b.y - b.radius <= a.y + a.height
  );
}

function createStars() {
  const stars: Star[] = [];
  for (let i = 0; i < 120; i += 1) {
    stars.push({
      x: Math.random() * LOGICAL_WIDTH,
      y: Math.random() * LOGICAL_HEIGHT,
      size: 1 + Math.random() * 1.8,
      speed: 6 + Math.random() * 18,
    });
  }
  return stars;
}

function createEnemies(wave: number) {
  const rows = 4 + Math.min(2, wave - 1);
  const cols = 10;
  const enemies: Enemy[] = [];
  const width = 44;
  const height = 28;
  const gapX = 22;
  const gapY = 16;
  const gridWidth = cols * width + (cols - 1) * gapX;
  const startX = (LOGICAL_WIDTH - gridWidth) / 2;
  const startY = 80;
  let id = 0;

  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      enemies.push({
        id: `e-${wave}-${id}`,
        x: startX + c * (width + gapX),
        y: startY + r * (height + gapY),
        width,
        height,
        alive: true,
      });
      id += 1;
    }
  }
  return enemies;
}

function createPlayers(mode: PlayMode): Player[] {
  const baseY = LOGICAL_HEIGHT - PLAYER_MARGIN_BOTTOM;
  const player1: Player = {
    id: "p1",
    x: mode === "single" ? LOGICAL_WIDTH * 0.5 : LOGICAL_WIDTH * 0.32,
    y: baseY,
    width: 52,
    height: 24,
    color: "#7df9ff",
    lives: 3,
    cooldown: 0,
    invulnerableFor: 0,
    alive: true,
    score: 0,
  };
  if (mode === "single") return [player1];
  const player2: Player = {
    id: "p2",
    x: LOGICAL_WIDTH * 0.68,
    y: baseY,
    width: 52,
    height: 24,
    color: "#ffd48d",
    lives: 3,
    cooldown: 0,
    invulnerableFor: 0,
    alive: true,
    score: 0,
  };
  return [player1, player2];
}

function createInitialState(mode: PlayMode): GameState {
  return {
    phase: "menu",
    mode,
    worldWidth: LOGICAL_WIDTH,
    worldHeight: LOGICAL_HEIGHT,
    players: createPlayers(mode),
    enemies: createEnemies(1),
    playerBullets: [],
    enemyBullets: [],
    enemyDirection: 1,
    enemySpeed: 46,
    enemyShootCooldown: 1.1,
    wave: 1,
    score: 0,
    elapsed: 0,
    stars: createStars(),
    nextBulletId: 1,
  };
}

function toHud(state: GameState): HudState {
  const livesLabel = state.players
    .map((player) => `${player.id.toUpperCase()}:${Math.max(0, player.lives)}`)
    .join("  ");
  return {
    phase: state.phase,
    mode: state.mode,
    score: state.score,
    wave: state.wave,
    elapsed: state.elapsed,
    livesLabel,
  };
}

export default function SpaceInvadersPage() {
  const router = useRouter();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const lastTsRef = useRef<number>(0);
  const hudTsRef = useRef<number>(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const keysRef = useRef<Record<string, boolean>>({});
  const touchRef = useRef<Record<string, boolean>>({});
  const gameRef = useRef<GameState>(createInitialState("single"));
  const [hud, setHud] = useState<HudState>(() => toHud(gameRef.current));
  const [mobileControls, setMobileControls] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const controlsHint = useMemo(() => {
    if (hud.mode === "single") {
      return "desktop: A/D or arrows move, Space shoots";
    }
    return "desktop: P1 A/D+W, P2 arrows+Enter";
  }, [hud.mode]);

  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const host = containerRef.current;
    if (!canvas || !host) return;

    const hostWidth = host.clientWidth;
    const availableHeight = Math.max(360, window.innerHeight - 220);
    const cssWidth = Math.min(hostWidth, 980);
    const cssHeight = Math.min(Math.round((cssWidth / LOGICAL_WIDTH) * LOGICAL_HEIGHT), availableHeight);
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));

    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    canvas.width = Math.floor(cssWidth * dpr);
    canvas.height = Math.floor(cssHeight * dpr);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }, []);

  const renderGame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const state = gameRef.current;
    const cssWidth = parseFloat(canvas.style.width || "0") || LOGICAL_WIDTH;
    const cssHeight = parseFloat(canvas.style.height || "0") || LOGICAL_HEIGHT;
    const sx = cssWidth / LOGICAL_WIDTH;
    const sy = cssHeight / LOGICAL_HEIGHT;

    ctx.save();
    ctx.scale(sx, sy);
    ctx.clearRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);

    const bg = ctx.createLinearGradient(0, 0, 0, LOGICAL_HEIGHT);
    bg.addColorStop(0, "#04122b");
    bg.addColorStop(1, "#09050f");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);

    state.stars.forEach((star) => {
      ctx.fillStyle = "rgba(190, 225, 255, 0.72)";
      ctx.fillRect(star.x, star.y, star.size, star.size);
    });

    const horizon = ctx.createLinearGradient(0, LOGICAL_HEIGHT - 80, 0, LOGICAL_HEIGHT);
    horizon.addColorStop(0, "rgba(97, 191, 255, 0)");
    horizon.addColorStop(1, "rgba(97, 191, 255, 0.14)");
    ctx.fillStyle = horizon;
    ctx.fillRect(0, LOGICAL_HEIGHT - 80, LOGICAL_WIDTH, 80);

    const aliveEnemies = state.enemies.filter((enemy) => enemy.alive);
    aliveEnemies.forEach((enemy, idx) => {
      const pulse = (Math.sin(state.elapsed * 3.4 + idx) + 1) * 0.5;
      ctx.fillStyle = `rgba(255, ${170 + Math.floor(pulse * 60)}, 110, 0.96)`;
      ctx.fillRect(enemy.x, enemy.y, enemy.width, enemy.height);
      ctx.fillStyle = "rgba(20, 7, 30, 0.75)";
      ctx.fillRect(enemy.x + 8, enemy.y + 7, enemy.width - 16, 8);
    });

    state.players.forEach((player) => {
      if (!player.alive) return;
      if (player.invulnerableFor > 0 && Math.floor(state.elapsed * 20) % 2 === 0) return;
      ctx.fillStyle = player.color;
      ctx.fillRect(player.x, player.y, player.width, player.height);
      ctx.fillStyle = "rgba(4, 8, 16, 0.84)";
      ctx.fillRect(player.x + 12, player.y - 9, player.width - 24, 9);
    });

    state.playerBullets.forEach((bullet) => {
      if (!bullet.alive) return;
      ctx.fillStyle = bullet.owner === "p1" ? "#9effff" : "#ffe4a9";
      ctx.beginPath();
      ctx.arc(bullet.x, bullet.y, bullet.radius, 0, Math.PI * 2);
      ctx.fill();
    });

    state.enemyBullets.forEach((bullet) => {
      if (!bullet.alive) return;
      ctx.fillStyle = "rgba(255, 129, 129, 0.95)";
      ctx.beginPath();
      ctx.arc(bullet.x, bullet.y, bullet.radius, 0, Math.PI * 2);
      ctx.fill();
    });

    ctx.fillStyle = "rgba(225, 241, 255, 0.92)";
    ctx.font = "16px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    ctx.fillText(`wave ${state.wave}`, 16, 26);
    ctx.fillText(`score ${state.score}`, 140, 26);
    ctx.fillText(`lives ${state.players.map((player) => `${player.id}:${Math.max(0, player.lives)}`).join(" ")}`, 286, 26);

    if (state.phase === "menu" || state.phase === "victory" || state.phase === "game-over") {
      ctx.fillStyle = "rgba(3, 8, 18, 0.64)";
      ctx.fillRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
      ctx.textAlign = "center";
      ctx.fillStyle = "#e8f6ff";
      ctx.font = "bold 46px ui-sans-serif, system-ui, -apple-system";
      if (state.phase === "menu") ctx.fillText("STARFALL PROTOCOL", LOGICAL_WIDTH / 2, 232);
      if (state.phase === "victory") ctx.fillText("SECTOR CLEARED", LOGICAL_WIDTH / 2, 232);
      if (state.phase === "game-over") ctx.fillText("DEFENSE LOST", LOGICAL_WIDTH / 2, 232);
      ctx.font = "16px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
      if (state.phase === "menu") ctx.fillText("Select mode and press Start", LOGICAL_WIDTH / 2, 274);
      if (state.phase !== "menu") ctx.fillText("Press Start to run again", LOGICAL_WIDTH / 2, 274);
      ctx.textAlign = "start";
    }

    ctx.restore();
  }, []);

  const syncHudIfNeeded = useCallback((force = false) => {
    const now = performance.now();
    if (!force && now - hudTsRef.current < 100) return;
    hudTsRef.current = now;
    setHud(toHud(gameRef.current));
  }, []);

  const spawnPlayerBullet = useCallback((player: Player) => {
    const state = gameRef.current;
    const id = state.nextBulletId;
    state.nextBulletId += 1;
    state.playerBullets.push({
      id: `pb-${id}`,
      owner: player.id,
      x: player.x + player.width * 0.5,
      y: player.y - 8,
      vx: 0,
      vy: PLAYER_BULLET_SPEED,
      radius: 4,
      alive: true,
    });
  }, []);

  const stepGame = useCallback((dt: number) => {
    const state = gameRef.current;
    if (state.phase !== "playing") {
      state.stars.forEach((star) => {
        star.y += star.speed * dt;
        if (star.y > LOGICAL_HEIGHT) {
          star.y = -2;
          star.x = Math.random() * LOGICAL_WIDTH;
        }
      });
      return;
    }

    state.elapsed += dt;

    state.stars.forEach((star) => {
      star.y += star.speed * dt;
      if (star.y > LOGICAL_HEIGHT) {
        star.y = -2;
        star.x = Math.random() * LOGICAL_WIDTH;
      }
    });

    state.players.forEach((player) => {
      if (!player.alive) return;
      player.cooldown = Math.max(0, player.cooldown - dt);
      player.invulnerableFor = Math.max(0, player.invulnerableFor - dt);
      const isP1 = player.id === "p1";
      const left = isP1
        ? state.mode === "single"
          ? Boolean(keysRef.current.KeyA || keysRef.current.ArrowLeft || touchRef.current.p1Left)
          : Boolean(keysRef.current.KeyA || touchRef.current.p1Left)
        : Boolean(keysRef.current.ArrowLeft || touchRef.current.p2Left);
      const right = isP1
        ? state.mode === "single"
          ? Boolean(keysRef.current.KeyD || keysRef.current.ArrowRight || touchRef.current.p1Right)
          : Boolean(keysRef.current.KeyD || touchRef.current.p1Right)
        : Boolean(keysRef.current.ArrowRight || touchRef.current.p2Right);
      const shoot = isP1
        ? Boolean(keysRef.current.Space || keysRef.current.KeyW || touchRef.current.p1Shoot)
        : Boolean(keysRef.current.Enter || touchRef.current.p2Shoot);

      const horizontal = Number(right) - Number(left);
      if (horizontal !== 0) {
        player.x = clamp(player.x + horizontal * PLAYER_SPEED * dt, EDGE_PADDING, LOGICAL_WIDTH - EDGE_PADDING - player.width);
      }
      if (shoot && player.cooldown <= 0) {
        spawnPlayerBullet(player);
        player.cooldown = 0.22;
      }
    });

    state.playerBullets.forEach((bullet) => {
      if (!bullet.alive) return;
      bullet.x += bullet.vx * dt;
      bullet.y += bullet.vy * dt;
      if (bullet.y < -12) bullet.alive = false;
    });

    state.enemyBullets.forEach((bullet) => {
      if (!bullet.alive) return;
      bullet.x += bullet.vx * dt;
      bullet.y += bullet.vy * dt;
      if (bullet.y > LOGICAL_HEIGHT + 12) bullet.alive = false;
    });

    const aliveEnemies = state.enemies.filter((enemy) => enemy.alive);
    let hitEdge = false;
    aliveEnemies.forEach((enemy) => {
      enemy.x += state.enemyDirection * state.enemySpeed * dt;
      if (enemy.x <= EDGE_PADDING || enemy.x + enemy.width >= LOGICAL_WIDTH - EDGE_PADDING) {
        hitEdge = true;
      }
    });

    if (hitEdge) {
      state.enemyDirection = state.enemyDirection === 1 ? -1 : 1;
      aliveEnemies.forEach((enemy) => {
        enemy.y += ENEMY_DROP;
      });
    }

    state.enemyShootCooldown -= dt;
    if (state.enemyShootCooldown <= 0 && aliveEnemies.length > 0) {
      const shooter = aliveEnemies[Math.floor(Math.random() * aliveEnemies.length)];
      const id = state.nextBulletId;
      state.nextBulletId += 1;
      state.enemyBullets.push({
        id: `eb-${id}`,
        owner: "enemy",
        x: shooter.x + shooter.width * 0.5,
        y: shooter.y + shooter.height + 3,
        vx: 0,
        vy: ENEMY_BULLET_SPEED + state.wave * 22,
        radius: 4,
        alive: true,
      });
      state.enemyShootCooldown = Math.max(0.26, 1.0 - state.wave * 0.08);
    }

    for (const bullet of state.playerBullets) {
      if (!bullet.alive) continue;
      for (const enemy of state.enemies) {
        if (!enemy.alive) continue;
        if (!intersects(enemy, bullet)) continue;
        enemy.alive = false;
        bullet.alive = false;
        const shooter = state.players.find((player) => player.id === bullet.owner);
        if (shooter) shooter.score += 10;
        state.score += 10;
        break;
      }
    }

    for (const bullet of state.enemyBullets) {
      if (!bullet.alive) continue;
      for (const player of state.players) {
        if (!player.alive) continue;
        if (player.invulnerableFor > 0) continue;
        if (!intersects(player, bullet)) continue;
        bullet.alive = false;
        player.lives -= 1;
        player.invulnerableFor = 1.0;
        if (player.lives <= 0) {
          player.alive = false;
        }
        break;
      }
    }

    state.playerBullets = state.playerBullets.filter((bullet) => bullet.alive);
    state.enemyBullets = state.enemyBullets.filter((bullet) => bullet.alive);

    const playerLine = Math.min(...state.players.map((player) => player.y - 14));
    const enemiesReachedLine = state.enemies.some(
      (enemy) => enemy.alive && enemy.y + enemy.height >= playerLine
    );
    const someoneAlive = state.players.some((player) => player.alive);
    const remainingEnemies = state.enemies.some((enemy) => enemy.alive);

    if (!someoneAlive || enemiesReachedLine) {
      state.phase = "game-over";
      return;
    }

    if (!remainingEnemies) {
      if (state.wave >= MAX_WAVE) {
        state.phase = "victory";
        return;
      }
      state.wave += 1;
      state.enemies = createEnemies(state.wave);
      state.enemyBullets = [];
      state.playerBullets = [];
      state.enemyDirection = state.enemyDirection === 1 ? -1 : 1;
      state.enemySpeed = 46 + state.wave * 12;
      state.enemyShootCooldown = 0.8;
    }
  }, [spawnPlayerBullet]);

  const stepAndRender = useCallback(
    (dt: number) => {
      const clamped = Math.min(0.05, Math.max(0, dt));
      stepGame(clamped);
      renderGame();
      syncHudIfNeeded();
    },
    [renderGame, stepGame, syncHudIfNeeded]
  );

  const beginGame = useCallback((mode: PlayMode) => {
    const next = createInitialState(mode);
    next.phase = "playing";
    gameRef.current = next;
    touchRef.current = {};
    syncHudIfNeeded(true);
    renderGame();
  }, [renderGame, syncHudIfNeeded]);

  const stopTouches = useCallback(() => {
    touchRef.current = {};
  }, []);

  const setTouch = useCallback((key: string, value: boolean) => {
    touchRef.current[key] = value;
  }, []);

  const toggleFullscreen = useCallback(async () => {
    const host = containerRef.current;
    if (!host) return;
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => undefined);
      return;
    }
    await host.requestFullscreen().catch(() => undefined);
  }, []);

  const renderGameToText = useCallback(() => {
    const state = gameRef.current;
    const payload = {
      coordinateSystem: "origin=(0,0) top-left, +x right, +y down",
      phase: state.phase,
      mode: state.mode,
      world: { width: state.worldWidth, height: state.worldHeight },
      wave: state.wave,
      score: state.score,
      elapsedSec: Number(state.elapsed.toFixed(2)),
      players: state.players.map((player) => ({
        id: player.id,
        x: Number(player.x.toFixed(1)),
        y: Number(player.y.toFixed(1)),
        width: player.width,
        height: player.height,
        lives: player.lives,
        alive: player.alive,
        cooldownSec: Number(player.cooldown.toFixed(2)),
        invulnerableSec: Number(player.invulnerableFor.toFixed(2)),
        score: player.score,
      })),
      enemies: state.enemies
        .filter((enemy) => enemy.alive)
        .map((enemy) => ({
          id: enemy.id,
          x: Number(enemy.x.toFixed(1)),
          y: Number(enemy.y.toFixed(1)),
          width: enemy.width,
          height: enemy.height,
        })),
      playerBullets: state.playerBullets.map((bullet) => ({
        x: Number(bullet.x.toFixed(1)),
        y: Number(bullet.y.toFixed(1)),
        owner: bullet.owner,
      })),
      enemyBullets: state.enemyBullets.map((bullet) => ({
        x: Number(bullet.x.toFixed(1)),
        y: Number(bullet.y.toFixed(1)),
      })),
    };
    return JSON.stringify(payload);
  }, []);

  useEffect(() => {
    const tick = (ts: number) => {
      if (!lastTsRef.current) lastTsRef.current = ts;
      const dt = (ts - lastTsRef.current) / 1000;
      lastTsRef.current = ts;
      stepAndRender(dt);
      frameRef.current = window.requestAnimationFrame(tick);
    };
    frameRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (frameRef.current) window.cancelAnimationFrame(frameRef.current);
    };
  }, [stepAndRender]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      keysRef.current[event.code] = true;
      if (event.code === "KeyF") {
        event.preventDefault();
        void toggleFullscreen();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      keysRef.current[event.code] = false;
    };
    const onBlur = () => {
      keysRef.current = {};
      stopTouches();
    };
    const onResize = () => {
      resizeCanvas();
      renderGame();
    };
    const onFullChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
      resizeCanvas();
      renderGame();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onResize);
    document.addEventListener("fullscreenchange", onFullChange);

    resizeCanvas();
    renderGame();

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("fullscreenchange", onFullChange);
    };
  }, [renderGame, resizeCanvas, stopTouches, toggleFullscreen]);

  useEffect(() => {
    const syncMobileControls = () => {
      const coarse = window.matchMedia("(pointer: coarse)").matches;
      setMobileControls(coarse || window.innerWidth <= 900);
    };
    syncMobileControls();
    window.addEventListener("resize", syncMobileControls);
    return () => window.removeEventListener("resize", syncMobileControls);
  }, []);

  useEffect(() => {
    window.render_game_to_text = renderGameToText;
    window.advanceTime = (ms: number) => {
      const frames = Math.max(1, Math.round(ms / (1000 / 60)));
      for (let i = 0; i < frames; i += 1) {
        stepAndRender(1 / 60);
      }
    };
    return () => {
      delete window.render_game_to_text;
      delete window.advanceTime;
    };
  }, [renderGameToText, stepAndRender]);

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "radial-gradient(circle at 50% 12%, #12395f 0%, #070913 58%, #05060d 100%)",
        color: "#e7f4ff",
        padding: "18px 16px 32px",
      }}
    >
      <div
        style={{
          maxWidth: 1100,
          margin: "0 auto",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          opacity: 0.9,
          fontSize: 13,
        }}
      >
        <div>
          <span style={{ cursor: "pointer" }} onClick={() => router.push("/main")}>
            main
          </span>
          {" / "}
          <span style={{ opacity: 0.85 }}>kozmos play</span>
          {" / "}
          <span style={{ opacity: 0.85 }}>Starfall Protocol🛦</span>
        </div>
        <button
          type="button"
          onClick={() => void toggleFullscreen()}
          style={{
            border: "1px solid rgba(172, 220, 255, 0.42)",
            borderRadius: 999,
            background: "rgba(7, 16, 28, 0.86)",
            color: "#def2ff",
            fontSize: 12,
            padding: "7px 12px",
            cursor: "pointer",
          }}
        >
          {isFullscreen ? "exit fullscreen" : "fullscreen (f)"}
        </button>
      </div>

      <section
        style={{
          maxWidth: 1100,
          margin: "14px auto 0",
          border: "1px solid rgba(147, 208, 255, 0.34)",
          borderRadius: 14,
          padding: 14,
          background: "linear-gradient(180deg, rgba(8, 22, 38, 0.86), rgba(6, 11, 20, 0.84))",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
            marginBottom: 10,
          }}
        >
          <div style={{ fontSize: 12, opacity: 0.86 }}>
            mode: {hud.mode} | phase: {hud.phase} | wave: {hud.wave} | score: {hud.score}
          </div>
          <div style={{ fontSize: 12, opacity: 0.72 }}>
            {controlsHint} | mobile: touch arrows + fire
          </div>
        </div>
        <div style={{ fontSize: 11, opacity: 0.66, marginBottom: 10 }}>
          lives: {hud.livesLabel} | time: {hud.elapsed.toFixed(1)}s
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          <button
            id="start-btn"
            type="button"
            onClick={() => beginGame("single")}
            style={primaryButton}
          >
            start single
          </button>
          <button id="start-multi-btn" type="button" onClick={() => beginGame("multi")} style={primaryButton}>
            start multi
          </button>
          <button
            type="button"
            onClick={() => {
              gameRef.current.phase = "menu";
              syncHudIfNeeded(true);
              renderGame();
            }}
            style={secondaryButton}
          >
            menu
          </button>
        </div>

        <div ref={containerRef} style={{ width: "100%", display: "grid", placeItems: "center" }}>
          <canvas
            ref={canvasRef}
            style={{
              display: "block",
              borderRadius: 12,
              border: "1px solid rgba(159, 215, 255, 0.42)",
              boxShadow: "0 0 0 1px rgba(255,255,255,0.06), 0 18px 45px rgba(0,0,0,0.42)",
              background: "#050a12",
              maxWidth: "100%",
            }}
          />
        </div>

        {mobileControls ? (
          <div
            style={{
              marginTop: 14,
              display: "grid",
              gap: 10,
            }}
          >
            <MobileRow
              label={hud.mode === "single" ? "pilot" : "player 1"}
              onPress={(key, down) => setTouch(key, down)}
              leftKey="p1Left"
              rightKey="p1Right"
              shootKey="p1Shoot"
            />
            {hud.mode === "multi" ? (
              <MobileRow
                label="player 2"
                onPress={(key, down) => setTouch(key, down)}
                leftKey="p2Left"
                rightKey="p2Right"
                shootKey="p2Shoot"
              />
            ) : null}
          </div>
        ) : null}
      </section>
    </main>
  );
}

function MobileRow({
  label,
  onPress,
  leftKey,
  rightKey,
  shootKey,
}: {
  label: string;
  onPress: (key: string, down: boolean) => void;
  leftKey: string;
  rightKey: string;
  shootKey: string;
}) {
  const down = (key: string, event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    onPress(key, true);
  };
  const up = (key: string, event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    onPress(key, false);
  };

  return (
    <div
      style={{
        border: "1px solid rgba(168, 219, 255, 0.28)",
        borderRadius: 10,
        background: "rgba(5, 12, 20, 0.6)",
        padding: "8px 9px",
      }}
    >
      <div style={{ fontSize: 11, opacity: 0.76, marginBottom: 8 }}>{label}</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
        <button
          type="button"
          style={touchButton}
          onPointerDown={(event) => down(leftKey, event)}
          onPointerUp={(event) => up(leftKey, event)}
          onPointerLeave={(event) => up(leftKey, event)}
          onPointerCancel={(event) => up(leftKey, event)}
        >
          left
        </button>
        <button
          type="button"
          style={touchButton}
          onPointerDown={(event) => down(rightKey, event)}
          onPointerUp={(event) => up(rightKey, event)}
          onPointerLeave={(event) => up(rightKey, event)}
          onPointerCancel={(event) => up(rightKey, event)}
        >
          right
        </button>
        <button
          type="button"
          style={{ ...touchButton, background: "rgba(255, 168, 90, 0.22)" }}
          onPointerDown={(event) => down(shootKey, event)}
          onPointerUp={(event) => up(shootKey, event)}
          onPointerLeave={(event) => up(shootKey, event)}
          onPointerCancel={(event) => up(shootKey, event)}
        >
          fire
        </button>
      </div>
    </div>
  );
}

const primaryButton: CSSProperties = {
  border: "1px solid rgba(183, 225, 255, 0.52)",
  borderRadius: 999,
  background: "rgba(18, 57, 89, 0.72)",
  color: "#e9f6ff",
  fontSize: 12,
  padding: "7px 12px",
  cursor: "pointer",
};

const secondaryButton: CSSProperties = {
  border: "1px solid rgba(183, 225, 255, 0.34)",
  borderRadius: 999,
  background: "rgba(8, 18, 33, 0.76)",
  color: "#dcefff",
  fontSize: 12,
  padding: "7px 12px",
  cursor: "pointer",
};

const touchButton: CSSProperties = {
  border: "1px solid rgba(197, 231, 255, 0.36)",
  borderRadius: 10,
  background: "rgba(90, 168, 255, 0.2)",
  color: "#e7f5ff",
  fontSize: 13,
  letterSpacing: "0.04em",
  padding: "9px 8px",
  textTransform: "uppercase",
  userSelect: "none",
  touchAction: "none",
};
