"use client";
/* eslint-disable react-hooks/immutability */

import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type PlayMode = "single" | "multi";
type Phase = "menu" | "playing" | "paused" | "game-over";
type EnemyTier = "top" | "mid" | "low";

type Player = {
  id: "p1" | "p2";
  x: number;
  y: number;
  width: number;
  height: number;
  lives: number;
  alive: boolean;
  cooldown: number;
  invulnerableFor: number;
  score: number;
};

type Enemy = {
  id: string;
  col: number;
  x: number;
  y: number;
  width: number;
  height: number;
  tier: EnemyTier;
  points: number;
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

type BarrierCell = {
  x: number;
  y: number;
  hp: number;
};

type Barrier = {
  id: string;
  cells: BarrierCell[];
};

type MysteryShip = {
  active: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  vx: number;
  points: number;
};

type GameState = {
  mode: PlayMode;
  phase: Phase;
  round: number;
  elapsed: number;
  score: number;
  players: Player[];
  enemies: Enemy[];
  bullets: Bullet[];
  barriers: Barrier[];
  mysteryShip: MysteryShip;
  mysterySpawnTimer: number;
  enemyDirection: 1 | -1;
  enemyShotTimer: number;
  nextId: number;
};

type HudState = {
  mode: PlayMode;
  phase: Phase;
  round: number;
  score: number;
  p1Lives: number;
  p2Lives: number;
};

declare global {
  interface Window {
    render_game_to_text?: () => string;
    advanceTime?: (ms: number) => void | Promise<void>;
  }
}

const HIGH_SCORE_KEY = "kozmos:starfall-protocol-high-score";
const WORLD_WIDTH = 900;
const WORLD_HEIGHT = 640;
const PLAYER_WIDTH = 44;
const PLAYER_HEIGHT = 22;
const PLAYER_Y = WORLD_HEIGHT - 56;
const PLAYER_SPEED = 330;
const PLAYER_BULLET_SPEED = -620;
const PLAYER_FIRE_COOLDOWN = 0.045;
const PLAYER_MAX_ACTIVE_BULLETS = 3;
const ENEMY_BULLET_SPEED = 250;
const ENEMY_ROWS = 5;
const ENEMY_COLS = 11;
const ENEMY_WIDTH = 36;
const ENEMY_HEIGHT = 22;
const ENEMY_GAP_X = 16;
const ENEMY_GAP_Y = 12;
const ENEMY_DROP_DISTANCE = 22;
const ENEMY_START_Y = 86;
const EDGE_PADDING = 22;
const BARRIER_CELL = 8;
const BARRIER_MASK = [
  "00111100",
  "01111110",
  "11111111",
  "11100111",
  "11000011",
  "11000011",
];
const BARRIER_COUNT = 4;
const BARRIER_TOP_Y = WORLD_HEIGHT - 178;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function scoreText(value: number) {
  return Math.max(0, Math.floor(value)).toString().padStart(4, "0");
}

function intersects(rect: { x: number; y: number; width: number; height: number }, bullet: Bullet) {
  return (
    bullet.x + bullet.radius >= rect.x &&
    bullet.x - bullet.radius <= rect.x + rect.width &&
    bullet.y + bullet.radius >= rect.y &&
    bullet.y - bullet.radius <= rect.y + rect.height
  );
}

function createPlayers(mode: PlayMode): Player[] {
  const p1: Player = {
    id: "p1",
    x: mode === "single" ? WORLD_WIDTH / 2 - PLAYER_WIDTH / 2 : WORLD_WIDTH * 0.34,
    y: PLAYER_Y,
    width: PLAYER_WIDTH,
    height: PLAYER_HEIGHT,
    lives: 3,
    alive: true,
    cooldown: 0,
    invulnerableFor: 0,
    score: 0,
  };
  if (mode === "single") return [p1];

  const p2: Player = {
    id: "p2",
    x: WORLD_WIDTH * 0.66 - PLAYER_WIDTH,
    y: PLAYER_Y,
    width: PLAYER_WIDTH,
    height: PLAYER_HEIGHT,
    lives: 3,
    alive: true,
    cooldown: 0,
    invulnerableFor: 0,
    score: 0,
  };
  return [p1, p2];
}

function createEnemies(round: number) {
  const enemies: Enemy[] = [];
  const gridWidth = ENEMY_COLS * ENEMY_WIDTH + (ENEMY_COLS - 1) * ENEMY_GAP_X;
  const startX = (WORLD_WIDTH - gridWidth) / 2;
  let id = 0;

  for (let row = 0; row < ENEMY_ROWS; row += 1) {
    const tier: EnemyTier = row === 0 ? "top" : row <= 2 ? "mid" : "low";
    const points = tier === "top" ? 30 : tier === "mid" ? 20 : 10;
    for (let col = 0; col < ENEMY_COLS; col += 1) {
      enemies.push({
        id: `e-${round}-${id}`,
        col,
        x: startX + col * (ENEMY_WIDTH + ENEMY_GAP_X),
        y: ENEMY_START_Y + row * (ENEMY_HEIGHT + ENEMY_GAP_Y),
        width: ENEMY_WIDTH,
        height: ENEMY_HEIGHT,
        tier,
        points,
        alive: true,
      });
      id += 1;
    }
  }

  return enemies;
}

function createBarriers() {
  const barriers: Barrier[] = [];
  const maskWidth = BARRIER_MASK[0].length * BARRIER_CELL;
  const totalWidth = BARRIER_COUNT * maskWidth;
  const gap = (WORLD_WIDTH - totalWidth) / (BARRIER_COUNT + 1);

  for (let index = 0; index < BARRIER_COUNT; index += 1) {
    const cells: BarrierCell[] = [];
    const startX = gap + index * (maskWidth + gap);

    for (let row = 0; row < BARRIER_MASK.length; row += 1) {
      for (let col = 0; col < BARRIER_MASK[row].length; col += 1) {
        if (BARRIER_MASK[row][col] !== "1") continue;
        cells.push({
          x: startX + col * BARRIER_CELL,
          y: BARRIER_TOP_Y + row * BARRIER_CELL,
          hp: 2,
        });
      }
    }

    barriers.push({ id: `barrier-${index}`, cells });
  }

  return barriers;
}

function createGameState(mode: PlayMode): GameState {
  return {
    mode,
    phase: "menu",
    round: 1,
    elapsed: 0,
    score: 0,
    players: createPlayers(mode),
    enemies: createEnemies(1),
    bullets: [],
    barriers: createBarriers(),
    mysteryShip: {
      active: false,
      x: WORLD_WIDTH + 40,
      y: 46,
      width: 56,
      height: 20,
      vx: -130,
      points: 100,
    },
    mysterySpawnTimer: 7 + Math.random() * 8,
    enemyDirection: 1,
    enemyShotTimer: 0.72,
    nextId: 1,
  };
}

function toHud(state: GameState): HudState {
  const p1 = state.players.find((player) => player.id === "p1");
  const p2 = state.players.find((player) => player.id === "p2");
  return {
    mode: state.mode,
    phase: state.phase,
    round: state.round,
    score: state.score,
    p1Lives: p1?.lives ?? 0,
    p2Lives: p2?.lives ?? 0,
  };
}

function drawShipIcon(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y + 4, 14, 5);
  ctx.fillRect(x + 5, y, 4, 4);
}

function drawPlayerShip(
  ctx: CanvasRenderingContext2D,
  player: Player,
  color: string
) {
  const x = player.x;
  const y = player.y;
  const w = player.width;
  const h = player.height;
  const mid = x + w / 2;

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(mid, y - 8);
  ctx.lineTo(x + 4, y + h - 2);
  ctx.lineTo(x + w - 4, y + h - 2);
  ctx.closePath();
  ctx.fill();

  ctx.fillRect(x + 6, y + h - 8, w - 12, 8);
  ctx.fillStyle = "rgba(10, 18, 30, 0.6)";
  ctx.fillRect(mid - 3, y + 2, 6, 8);
}

function drawAlien(ctx: CanvasRenderingContext2D, enemy: Enemy, elapsed: number) {
  const x = enemy.x;
  const y = enemy.y;
  const w = enemy.width;
  const pulse = Math.floor((Math.sin(elapsed * 8 + enemy.x * 0.03) + 1) * 0.5);

  if (enemy.tier === "top") {
    ctx.fillStyle = "#c980ff";
    ctx.fillRect(x + 6, y + 2, w - 12, 7);
    ctx.fillRect(x + 2, y + 9, w - 4, 8);
    ctx.fillRect(x + 8, y + 17, 5, 5);
    ctx.fillRect(x + w - 13, y + 17, 5, 5);
    ctx.fillStyle = "#2c173c";
    ctx.fillRect(x + 10, y + 10, 4, 3);
    ctx.fillRect(x + w - 14, y + 10, 4, 3);
    if (pulse) {
      ctx.fillStyle = "#e7c3ff";
      ctx.fillRect(x + 4, y, 4, 2);
      ctx.fillRect(x + w - 8, y, 4, 2);
    }
    return;
  }

  if (enemy.tier === "mid") {
    ctx.fillStyle = "#7bf196";
    ctx.fillRect(x + 4, y + 4, w - 8, 8);
    ctx.fillRect(x + 1, y + 12, w - 2, 6);
    ctx.fillRect(x + 7, y + 18, 5, 4);
    ctx.fillRect(x + w - 12, y + 18, 5, 4);
    ctx.fillStyle = "#1f4731";
    ctx.fillRect(x + 9, y + 12, 4, 3);
    ctx.fillRect(x + w - 13, y + 12, 4, 3);
    return;
  }

  ctx.fillStyle = "#7eb8ff";
  ctx.fillRect(x + 3, y + 6, w - 6, 8);
  ctx.fillRect(x + 1, y + 14, w - 2, 5);
  ctx.fillRect(x + 5, y + 19, 4, 3);
  ctx.fillRect(x + w - 9, y + 19, 4, 3);
  if (pulse) {
    ctx.fillRect(x + 12, y + 19, 4, 3);
    ctx.fillRect(x + w - 16, y + 19, 4, 3);
  }
  ctx.fillStyle = "#234777";
  ctx.fillRect(x + 8, y + 14, 4, 3);
  ctx.fillRect(x + w - 12, y + 14, 4, 3);
}

export default function StarfallProtocolGame({ embedded = false }: { embedded?: boolean }) {
  const router = useRouter();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number>(0);
  const hudTsRef = useRef<number>(0);
  const keysRef = useRef<Record<string, boolean>>({});
  const touchRef = useRef<Record<string, boolean>>({});
  const gameRef = useRef<GameState>(createGameState("single"));
  const highScoreRef = useRef(0);

  const [hud, setHud] = useState<HudState>(() => toHud(gameRef.current));
  const [highScore, setHighScore] = useState(0);
  const [mobileControls, setMobileControls] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const controlsText = useMemo(() => {
    if (hud.mode === "single") {
      return "Move: A/D or Left/Right | Fire: Space | Restart: button";
    }
    return "P1 A/D + Space | P2 Left/Right + Enter | Restart: button";
  }, [hud.mode]);

  const syncHud = useCallback((force = false) => {
    const now = performance.now();
    if (!force && now - hudTsRef.current < 90) return;
    hudTsRef.current = now;
    setHud(toHud(gameRef.current));
  }, []);

  const storeHighScore = useCallback((value: number) => {
    if (value <= highScoreRef.current) return;
    highScoreRef.current = value;
    setHighScore(value);
    try {
      window.localStorage.setItem(HIGH_SCORE_KEY, String(value));
    } catch {
      // ignore write errors
    }
  }, []);

  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const root = rootRef.current;
    if (!canvas || !root) return;

    const maxWidth = embedded
      ? Math.min(root.clientWidth - 18, isFullscreen ? 980 : 760)
      : Math.min(root.clientWidth - 18, 920);
    const cssWidth = Math.max(280, maxWidth);
    const cssHeight = Math.round((cssWidth / WORLD_WIDTH) * WORLD_HEIGHT);
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));

    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    canvas.width = Math.floor(cssWidth * dpr);
    canvas.height = Math.floor(cssHeight * dpr);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
  }, [embedded, isFullscreen]);

  const startGame = useCallback(
    (mode?: PlayMode) => {
      const selectedMode = mode ?? gameRef.current.mode;
      const next = createGameState(selectedMode);
      next.phase = "playing";
      gameRef.current = next;
      touchRef.current = {};
      syncHud(true);
    },
    [syncHud]
  );

  const goMenu = useCallback(() => {
    const next = createGameState(gameRef.current.mode);
    next.phase = "menu";
    gameRef.current = next;
    touchRef.current = {};
    syncHud(true);
  }, [syncHud]);

  const togglePause = useCallback(() => {
    const state = gameRef.current;
    if (state.phase === "playing") {
      state.phase = "paused";
      syncHud(true);
      return;
    }
    if (state.phase === "paused") {
      state.phase = "playing";
      syncHud(true);
    }
  }, [syncHud]);

  const toggleFullscreen = useCallback(async () => {
    const root = rootRef.current;
    if (!root) return;
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => undefined);
      return;
    }
    await root.requestFullscreen().catch(() => undefined);
  }, []);

  const spawnPlayerBullet = useCallback((player: Player) => {
    const state = gameRef.current;
    const activeCount = state.bullets.filter(
      (bullet) => bullet.alive && bullet.owner === player.id
    ).length;
    if (activeCount >= PLAYER_MAX_ACTIVE_BULLETS) return;

    const id = state.nextId;
    state.nextId += 1;
    state.bullets.push({
      id: `pb-${id}`,
      owner: player.id,
      x: player.x + player.width / 2,
      y: player.y - 4,
      vx: 0,
      vy: PLAYER_BULLET_SPEED,
      radius: 3,
      alive: true,
    });
  }, []);

  const spawnEnemyBullet = useCallback(() => {
    const state = gameRef.current;
    const alive = state.enemies.filter((enemy) => enemy.alive);
    if (alive.length === 0) return;

    const byCol = new Map<number, Enemy>();
    for (const enemy of alive) {
      const current = byCol.get(enemy.col);
      if (!current || enemy.y > current.y) byCol.set(enemy.col, enemy);
    }
    const candidates = Array.from(byCol.values());
    const shooter = candidates[Math.floor(Math.random() * candidates.length)];
    if (!shooter) return;

    const id = state.nextId;
    state.nextId += 1;
    state.bullets.push({
      id: `eb-${id}`,
      owner: "enemy",
      x: shooter.x + shooter.width / 2,
      y: shooter.y + shooter.height + 2,
      vx: 0,
      vy: ENEMY_BULLET_SPEED + state.round * 10,
      radius: 3,
      alive: true,
    });
  }, []);

  const damageBarrier = useCallback((x: number, y: number) => {
    const state = gameRef.current;
    for (const barrier of state.barriers) {
      const idx = barrier.cells.findIndex((cell) => {
        return (
          x >= cell.x &&
          x <= cell.x + BARRIER_CELL &&
          y >= cell.y &&
          y <= cell.y + BARRIER_CELL
        );
      });
      if (idx === -1) continue;
      barrier.cells[idx].hp -= 1;
      if (barrier.cells[idx].hp <= 0) barrier.cells.splice(idx, 1);
      return true;
    }
    return false;
  }, []);
  const stepGame = useCallback(
    (dt: number) => {
      const state = gameRef.current;
      if (state.phase !== "playing") return;

      state.elapsed += dt;

      for (const player of state.players) {
        if (!player.alive) continue;
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
        const fire = isP1
          ? Boolean(keysRef.current.Space || touchRef.current.p1Shoot)
          : Boolean(keysRef.current.Enter || touchRef.current.p2Shoot);

        const axis = Number(right) - Number(left);
        if (axis !== 0) {
          player.x = clamp(
            player.x + axis * PLAYER_SPEED * dt,
            EDGE_PADDING,
            WORLD_WIDTH - EDGE_PADDING - player.width
          );
        }

        if (fire && player.cooldown <= 0) {
          spawnPlayerBullet(player);
          player.cooldown = PLAYER_FIRE_COOLDOWN;
        }
      }

      const aliveEnemies = state.enemies.filter((enemy) => enemy.alive);
      const aliveRatio = aliveEnemies.length / Math.max(1, state.enemies.length);
      const enemySpeed = 42 + state.round * 8 + (1 - aliveRatio) * 220;

      let hitEdge = false;
      for (const enemy of aliveEnemies) {
        enemy.x += state.enemyDirection * enemySpeed * dt;
        if (enemy.x <= EDGE_PADDING || enemy.x + enemy.width >= WORLD_WIDTH - EDGE_PADDING) {
          hitEdge = true;
        }
      }
      if (hitEdge) {
        state.enemyDirection = state.enemyDirection === 1 ? -1 : 1;
        for (const enemy of aliveEnemies) {
          enemy.y += ENEMY_DROP_DISTANCE;
        }
      }

      state.enemyShotTimer -= dt;
      if (state.enemyShotTimer <= 0) {
        spawnEnemyBullet();
        state.enemyShotTimer = Math.max(0.22, 0.72 - state.round * 0.03) + Math.random() * 0.3;
      }

      state.mysterySpawnTimer -= dt;
      if (!state.mysteryShip.active && state.mysterySpawnTimer <= 0) {
        const pointsPool = [50, 100, 150, 300];
        state.mysteryShip = {
          active: true,
          x: WORLD_WIDTH + 40,
          y: 46,
          width: 56,
          height: 20,
          vx: -120 - state.round * 8,
          points: pointsPool[Math.floor(Math.random() * pointsPool.length)],
        };
      }

      if (state.mysteryShip.active) {
        state.mysteryShip.x += state.mysteryShip.vx * dt;
        if (state.mysteryShip.x + state.mysteryShip.width < -12) {
          state.mysteryShip.active = false;
          state.mysterySpawnTimer = 7 + Math.random() * 8;
        }
      }

      for (const bullet of state.bullets) {
        if (!bullet.alive) continue;
        bullet.x += bullet.vx * dt;
        bullet.y += bullet.vy * dt;

        if (bullet.y < -12 || bullet.y > WORLD_HEIGHT + 12) {
          bullet.alive = false;
          continue;
        }

        if (damageBarrier(bullet.x, bullet.y)) {
          bullet.alive = false;
          continue;
        }

        if (bullet.owner === "enemy") {
          for (const player of state.players) {
            if (!player.alive || player.invulnerableFor > 0) continue;
            if (!intersects(player, bullet)) continue;
            bullet.alive = false;
            player.lives -= 1;
            player.invulnerableFor = 1.0;
            if (player.lives <= 0) player.alive = false;
            break;
          }
          continue;
        }

        if (state.mysteryShip.active && intersects(state.mysteryShip, bullet)) {
          bullet.alive = false;
          state.score += state.mysteryShip.points;
          storeHighScore(state.score);
          const shooter = state.players.find((player) => player.id === bullet.owner);
          if (shooter) shooter.score += state.mysteryShip.points;
          state.mysteryShip.active = false;
          state.mysterySpawnTimer = 7 + Math.random() * 8;
          continue;
        }

        for (const enemy of state.enemies) {
          if (!enemy.alive) continue;
          if (!intersects(enemy, bullet)) continue;
          enemy.alive = false;
          bullet.alive = false;
          state.score += enemy.points;
          storeHighScore(state.score);
          const shooter = state.players.find((player) => player.id === bullet.owner);
          if (shooter) shooter.score += enemy.points;
          break;
        }
      }

      state.bullets = state.bullets.filter((bullet) => bullet.alive);

      for (const enemy of state.enemies) {
        if (!enemy.alive) continue;
        for (const barrier of state.barriers) {
          barrier.cells = barrier.cells.filter((cell) => {
            const overlap =
              cell.x + BARRIER_CELL >= enemy.x &&
              cell.x <= enemy.x + enemy.width &&
              cell.y + BARRIER_CELL >= enemy.y &&
              cell.y <= enemy.y + enemy.height;
            return !overlap;
          });
        }
      }

      const anyPlayerAlive = state.players.some((player) => player.alive);
      if (!anyPlayerAlive) {
        state.phase = "game-over";
        return;
      }

      const enemyReachedBottom = state.enemies.some(
        (enemy) => enemy.alive && enemy.y + enemy.height >= PLAYER_Y
      );
      if (enemyReachedBottom) {
        state.phase = "game-over";
        return;
      }

      const remainingEnemies = state.enemies.filter((enemy) => enemy.alive).length;
      if (remainingEnemies === 0) {
        state.round += 1;
        state.enemies = createEnemies(state.round);
        state.bullets = [];
        state.enemyDirection = state.enemyDirection === 1 ? -1 : 1;
        state.enemyShotTimer = Math.max(0.22, 0.72 - state.round * 0.03);
        state.mysteryShip.active = false;
        state.mysterySpawnTimer = 7 + Math.random() * 8;
        state.barriers = createBarriers();
      }
    },
    [damageBarrier, spawnEnemyBullet, spawnPlayerBullet, storeHighScore]
  );

  const renderGame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const state = gameRef.current;
    const cssWidth = parseFloat(canvas.style.width || "0") || WORLD_WIDTH;
    const cssHeight = parseFloat(canvas.style.height || "0") || WORLD_HEIGHT;
    const sx = cssWidth / WORLD_WIDTH;
    const sy = cssHeight / WORLD_HEIGHT;

    ctx.save();
    ctx.scale(sx, sy);
    ctx.clearRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

    ctx.fillStyle = "#f2f2f2";
    ctx.font = "15px 'Courier New', monospace";
    ctx.fillText(`SCORE ${scoreText(state.score)}`, 16, 24);
    ctx.fillText(`HI-SCORE ${scoreText(highScoreRef.current)}`, 320, 24);
    ctx.fillText(`ROUND ${state.round}`, 706, 24);

    for (const enemy of state.enemies) {
      if (!enemy.alive) continue;
      drawAlien(ctx, enemy, state.elapsed);
    }

    if (state.mysteryShip.active) {
      const ship = state.mysteryShip;
      const mid = ship.x + ship.width / 2;
      ctx.fillStyle = "#ff6f7a";
      ctx.beginPath();
      ctx.moveTo(mid, ship.y + 1);
      ctx.lineTo(ship.x + 2, ship.y + ship.height - 2);
      ctx.lineTo(ship.x + ship.width - 2, ship.y + ship.height - 2);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(ship.x + 10, ship.y + ship.height - 6, ship.width - 20, 5);
      ctx.fillStyle = "#5d1b22";
      ctx.fillRect(mid - 4, ship.y + 8, 8, 4);
    }

    for (const barrier of state.barriers) {
      for (const cell of barrier.cells) {
        ctx.fillStyle = cell.hp === 2 ? "#79ffd8" : "#2d977a";
        ctx.fillRect(cell.x, cell.y, BARRIER_CELL, BARRIER_CELL);
      }
    }

    for (const player of state.players) {
      if (!player.alive) continue;
      if (player.invulnerableFor > 0 && Math.floor(state.elapsed * 18) % 2 === 0) continue;
      drawPlayerShip(ctx, player, player.id === "p1" ? "#f2f2f2" : "#f1c681");
    }

    for (const bullet of state.bullets) {
      if (!bullet.alive) continue;
      if (bullet.owner === "enemy") ctx.fillStyle = "#ff7b7b";
      else if (bullet.owner === "p1") ctx.fillStyle = "#f2f2f2";
      else ctx.fillStyle = "#f1c681";
      ctx.fillRect(
        bullet.x - bullet.radius,
        bullet.y - bullet.radius * 2,
        bullet.radius * 2,
        bullet.radius * 4
      );
    }

    ctx.fillStyle = "#f2f2f2";
    ctx.fillRect(0, WORLD_HEIGHT - 36, WORLD_WIDTH, 1);
    ctx.font = "14px 'Courier New', monospace";
    ctx.fillText("LIVES", 16, WORLD_HEIGHT - 13);

    let lifeX = 72;
    const p1 = state.players.find((player) => player.id === "p1");
    const p2 = state.players.find((player) => player.id === "p2");

    for (let i = 0; i < (p1?.lives ?? 0); i += 1) {
      drawShipIcon(ctx, lifeX, WORLD_HEIGHT - 27, "#f2f2f2");
      lifeX += 18;
    }

    if (state.mode === "multi") {
      ctx.fillText("P2", lifeX + 6, WORLD_HEIGHT - 13);
      lifeX += 28;
      for (let i = 0; i < (p2?.lives ?? 0); i += 1) {
        drawShipIcon(ctx, lifeX, WORLD_HEIGHT - 27, "#f1c681");
        lifeX += 18;
      }
    }

    if (state.phase !== "playing") {
      ctx.fillStyle = "rgba(0,0,0,0.66)";
      ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
      ctx.fillStyle = "#f2f2f2";
      ctx.textAlign = "center";
      ctx.font = "bold 40px 'Courier New', monospace";
      if (state.phase === "menu") ctx.fillText("starfall protocol 🛦", WORLD_WIDTH / 2, 248);
      if (state.phase === "paused") ctx.fillText("paused", WORLD_WIDTH / 2, 248);
      if (state.phase === "game-over") ctx.fillText("GAME OVER", WORLD_WIDTH / 2, 248);
      ctx.font = "16px 'Courier New', monospace";
      if (state.phase === "menu") ctx.fillText("Use Start. Space only shoots.", WORLD_WIDTH / 2, 286);
      else if (state.phase === "paused") ctx.fillText("Use Pause to resume.", WORLD_WIDTH / 2, 286);
      else ctx.fillText("Use Restart to run again.", WORLD_WIDTH / 2, 286);
      ctx.textAlign = "start";
    }

    ctx.restore();
  }, []);

  const stepAndRender = useCallback(
    (dt: number) => {
      stepGame(Math.min(0.05, Math.max(0, dt)));
      renderGame();
      syncHud();
    },
    [renderGame, stepGame, syncHud]
  );

  const renderGameToText = useCallback(() => {
    const state = gameRef.current;
    return JSON.stringify({
      coordinateSystem: "origin=(0,0) top-left, +x right, +y down",
      phase: state.phase,
      mode: state.mode,
      round: state.round,
      score: state.score,
      highScore: highScoreRef.current,
      players: state.players.map((player) => ({
        id: player.id,
        x: Number(player.x.toFixed(1)),
        y: Number(player.y.toFixed(1)),
        lives: player.lives,
        alive: player.alive,
        score: player.score,
      })),
      enemies: state.enemies
        .filter((enemy) => enemy.alive)
        .map((enemy) => ({
          id: enemy.id,
          x: Number(enemy.x.toFixed(1)),
          y: Number(enemy.y.toFixed(1)),
          tier: enemy.tier,
          points: enemy.points,
        })),
      mysteryShip: state.mysteryShip.active
        ? {
            x: Number(state.mysteryShip.x.toFixed(1)),
            y: Number(state.mysteryShip.y.toFixed(1)),
            points: state.mysteryShip.points,
          }
        : null,
      bullets: state.bullets.map((bullet) => ({
        owner: bullet.owner,
        x: Number(bullet.x.toFixed(1)),
        y: Number(bullet.y.toFixed(1)),
      })),
      barrierCells: state.barriers.reduce((sum, barrier) => sum + barrier.cells.length, 0),
    });
  }, []);

  const setTouch = useCallback((key: string, value: boolean) => {
    touchRef.current[key] = value;
  }, []);

  const stopTouches = useCallback(() => {
    touchRef.current = {};
  }, []);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(HIGH_SCORE_KEY);
      const parsed = Number(raw ?? "0");
      if (Number.isFinite(parsed) && parsed > 0) {
        highScoreRef.current = parsed;
        setHighScore(parsed);
      }
    } catch {
      // ignore read errors
    }
  }, []);

  useEffect(() => {
    const tick = (ts: number) => {
      if (!lastTsRef.current) lastTsRef.current = ts;
      const dt = (ts - lastTsRef.current) / 1000;
      lastTsRef.current = ts;
      stepAndRender(dt);
      rafRef.current = window.requestAnimationFrame(tick);
    };

    rafRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) window.cancelAnimationFrame(rafRef.current);
    };
  }, [stepAndRender]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      keysRef.current[event.code] = true;

      if (
        event.code === "Space" ||
        event.code === "ArrowLeft" ||
        event.code === "ArrowRight" ||
        event.code === "Enter"
      ) {
        event.preventDefault();
      }

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

    const onFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
      resizeCanvas();
      renderGame();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onResize);
    document.addEventListener("fullscreenchange", onFullscreenChange);

    resizeCanvas();
    renderGame();

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
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

  const body = (
    <section
      style={{
        width: embedded && isFullscreen ? "min(980px, 100%)" : "100%",
        border: embedded ? "1px solid rgba(255,255,255,0.16)" : "1px solid rgba(147, 208, 255, 0.34)",
        borderRadius: 12,
        padding: embedded ? 10 : 14,
        background: embedded
          ? "rgba(7, 11, 20, 0.84)"
          : "linear-gradient(180deg, rgba(8, 22, 38, 0.86), rgba(6, 11, 20, 0.84))",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
          marginBottom: 8,
        }}
      >
        <div style={{ fontSize: 12, opacity: 0.86 }}>
          mode: {hud.mode} | phase: {hud.phase} | round: {hud.round} | score: {hud.score}
        </div>
        <button type="button" onClick={() => void toggleFullscreen()} style={secondaryButton}>
          {isFullscreen ? "exit fullscreen" : "fullscreen (f)"}
        </button>
      </div>

      <div style={{ fontSize: 11, opacity: 0.72, marginBottom: 8 }}>{controlsText}</div>
      <div style={{ fontSize: 11, opacity: 0.62, marginBottom: 10 }}>
        high score: {scoreText(highScore)} | p1 lives: {hud.p1Lives}
        {hud.mode === "multi" ? ` | p2 lives: ${hud.p2Lives}` : ""}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        <button id="start-btn" type="button" onClick={() => startGame("single")} style={primaryButton}>
          start single
        </button>
        <button id="start-multi-btn" type="button" onClick={() => startGame("multi")} style={primaryButton}>
          start multi
        </button>
        <button type="button" onClick={() => startGame()} style={secondaryButton}>
          restart
        </button>
        <button type="button" onClick={goMenu} style={secondaryButton}>
          stop
        </button>
        <button
          type="button"
          onClick={togglePause}
          disabled={hud.phase !== "playing" && hud.phase !== "paused"}
          style={{
            ...secondaryButton,
            opacity: hud.phase === "playing" || hud.phase === "paused" ? 1 : 0.55,
            cursor: hud.phase === "playing" || hud.phase === "paused" ? "pointer" : "not-allowed",
          }}
        >
          {hud.phase === "paused" ? "resume" : "pause"}
        </button>
      </div>

      <div style={{ width: "100%", display: "grid", placeItems: "center" }}>
        <canvas
          ref={canvasRef}
          style={{
            display: "block",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.18)",
            boxShadow: embedded ? "none" : "0 16px 40px rgba(0,0,0,0.42)",
            background: "#000",
            maxWidth: "100%",
          }}
        />
      </div>

      {mobileControls ? (
        <div
          style={{
            marginTop: 12,
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
  );

  if (embedded) {
    return (
      <div
        ref={rootRef}
        onClick={(event) => event.stopPropagation()}
        style={
          isFullscreen
            ? {
                marginTop: 0,
                width: "100vw",
                height: "100vh",
                display: "grid",
                placeItems: "center",
                padding: 18,
                boxSizing: "border-box",
                background: "#020814",
              }
            : { marginTop: 12 }
        }
      >
        {body}
      </div>
    );
  }

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
          <span style={{ opacity: 0.85 }}>starfall protocol 🛦</span>
        </div>
      </div>

      <div ref={rootRef} style={{ maxWidth: 1100, margin: "14px auto 0" }}>
        {body}
      </div>
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
  const down = (key: string, event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    onPress(key, true);
  };

  const up = (key: string, event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    onPress(key, false);
  };

  return (
    <div
      style={{
        border: "1px solid rgba(255,255,255,0.16)",
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
