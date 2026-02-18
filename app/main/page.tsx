"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

type Message = {
  id: string;
  user_id: string;
  username: string;
  content: string;
};

type ChatMode = "open" | "game";

type HushChat = {
  id: string;
  created_by: string;
  status: "open" | "closed";
  created_at: string;
};

type HushMember = {
  id: number;
  chat_id: string;
  user_id: string;
  role: "owner" | "member";
  status:
    | "invited"
    | "accepted"
    | "declined"
    | "left"
    | "removed"
    | "requested";
  display_name?: string | null;
  created_at: string;
};

type HushMessage = {
  id: string;
  chat_id: string;
  user_id: string;
  content: string;
  created_at: string;
};

const ORBIT_TRACK_SIZE = 12;
const QUITE_SWARM_MODE = "quite-swarm";
const VS_ARENA_LIMIT = 48;
const VS_MATCH_SECONDS = 60;
const VS_STEP_SECONDS = 0.1;

type VsPlayer = {
  id: string;
  name: string;
  x: number;
  y: number;
  hp: number;
  alive: boolean;
  reload: number;
  kills: number;
  phase: number;
  color: string;
};

type VsEnemy = {
  id: string;
  x: number;
  y: number;
  hp: number;
  speed: number;
};

type VsProjectile = {
  id: string;
  ownerId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  ttl: number;
};

type VsSession = {
  running: boolean;
  timeLeft: number;
  wave: number;
  tick: number;
  players: VsPlayer[];
  enemies: VsEnemy[];
  projectiles: VsProjectile[];
  moderatorLine: string;
  spawnCooldown: number;
  modCooldown: number;
  lastEnemyId: number;
  lastProjectileId: number;
};

const VS_PLAYER_COLORS = [
  "#7df9ff",
  "#8cb8ff",
  "#b6c6ff",
  "#9bffdf",
  "#ffd28f",
  "#c2a7ff",
];

function uniqueNames(names: string[]) {
  const seen = new Set<string>();
  const next: string[] = [];
  names.forEach((name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    next.push(trimmed);
  });
  return next;
}

function vsClamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function createVsSession(participants: string[], running = false): VsSession {
  const roster = uniqueNames(participants);
  const players = roster.map((name, index) => {
    const angle = (index / Math.max(1, roster.length)) * Math.PI * 2;
    return {
      id: `${name.toLowerCase().replace(/\s+/g, "-")}-${index}`,
      name,
      x: Math.cos(angle) * 16,
      y: Math.sin(angle) * 16,
      hp: 100,
      alive: true,
      reload: 0.2 + Math.random() * 0.45,
      kills: 0,
      phase: angle,
      color: VS_PLAYER_COLORS[index % VS_PLAYER_COLORS.length],
    } as VsPlayer;
  });

  return {
    running,
    timeLeft: VS_MATCH_SECONDS,
    wave: 1,
    tick: 0,
    players,
    enemies: [],
    projectiles: [],
    moderatorLine: running
      ? `Axy moderator: ${players.length} survivors entered the hush field.`
      : "Axy moderator: choose present users, then start the hunt.",
    spawnCooldown: 0.8,
    modCooldown: 2.4,
    lastEnemyId: 0,
    lastProjectileId: 0,
  };
}

function advanceVsSession(
  prev: VsSession,
  options?: {
    controlledName?: string;
    controls?: { up: boolean; down: boolean; left: boolean; right: boolean };
  }
): VsSession {
  if (!prev.running) return prev;

  const dt = VS_STEP_SECONDS;
  const players = prev.players.map((player) => ({ ...player }));
  const enemies = prev.enemies.map((enemy) => ({ ...enemy }));
  const projectiles = prev.projectiles.map((projectile) => ({ ...projectile }));

  let timeLeft = Math.max(0, prev.timeLeft - dt);
  const elapsed = VS_MATCH_SECONDS - timeLeft;
  let wave = 1 + Math.floor(elapsed / 12);
  let spawnCooldown = prev.spawnCooldown - dt;
  let modCooldown = prev.modCooldown - dt;
  let lastEnemyId = prev.lastEnemyId;
  let lastProjectileId = prev.lastProjectileId;
  let moderatorLine = prev.moderatorLine;
  const controlledName = options?.controlledName?.trim().toLowerCase() || "";
  const controls = options?.controls;

  if (spawnCooldown <= 0) {
    const spawnCount = 1 + Math.floor(elapsed / 18) + Math.floor(Math.random() * 2);
    for (let i = 0; i < spawnCount; i += 1) {
      const side = Math.floor(Math.random() * 4);
      const edge = VS_ARENA_LIMIT - 1;
      let x = 0;
      let y = 0;
      if (side === 0) {
        x = -edge;
        y = (Math.random() * 2 - 1) * edge;
      } else if (side === 1) {
        x = edge;
        y = (Math.random() * 2 - 1) * edge;
      } else if (side === 2) {
        x = (Math.random() * 2 - 1) * edge;
        y = -edge;
      } else {
        x = (Math.random() * 2 - 1) * edge;
        y = edge;
      }
      lastEnemyId += 1;
      enemies.push({
        id: `foe-${lastEnemyId}`,
        x,
        y,
        hp: 18 + wave * 4,
        speed: 5.8 + wave * 0.65,
      });
    }
    spawnCooldown = Math.max(0.28, 1.05 - wave * 0.08);
  }

  const alivePlayers = players.filter((player) => player.alive);

  for (const player of alivePlayers) {
    player.phase += dt * 1.7;
    const isControlled =
      Boolean(controls) && player.name.trim().toLowerCase() === controlledName;
    if (isControlled && controls) {
      const horizontal =
        Number(Boolean(controls.right)) - Number(Boolean(controls.left));
      const vertical = Number(Boolean(controls.down)) - Number(Boolean(controls.up));
      if (horizontal !== 0 || vertical !== 0) {
        const norm = Math.hypot(horizontal, vertical) || 1;
        const speed = 16;
        player.x = vsClamp(
          player.x + (horizontal / norm) * speed * dt,
          -VS_ARENA_LIMIT + 2,
          VS_ARENA_LIMIT - 2
        );
        player.y = vsClamp(
          player.y + (vertical / norm) * speed * dt,
          -VS_ARENA_LIMIT + 2,
          VS_ARENA_LIMIT - 2
        );
      } else {
        player.x = vsClamp(
          player.x + Math.cos(player.phase) * 0.5 * dt,
          -VS_ARENA_LIMIT + 2,
          VS_ARENA_LIMIT - 2
        );
        player.y = vsClamp(
          player.y + Math.sin(player.phase) * 0.5 * dt,
          -VS_ARENA_LIMIT + 2,
          VS_ARENA_LIMIT - 2
        );
      }
    } else {
      player.x = vsClamp(
        player.x + Math.cos(player.phase * 0.9) * 2.2 * dt + (Math.random() - 0.5) * 0.25,
        -VS_ARENA_LIMIT + 2,
        VS_ARENA_LIMIT - 2
      );
      player.y = vsClamp(
        player.y + Math.sin(player.phase * 1.2) * 2.2 * dt + (Math.random() - 0.5) * 0.25,
        -VS_ARENA_LIMIT + 2,
        VS_ARENA_LIMIT - 2
      );
    }

    player.reload -= dt;
    if (player.reload <= 0 && enemies.length > 0) {
      let target: VsEnemy | null = null;
      let bestDist = Number.POSITIVE_INFINITY;
      for (const enemy of enemies) {
        const dx = enemy.x - player.x;
        const dy = enemy.y - player.y;
        const dist = Math.hypot(dx, dy);
        if (dist < bestDist) {
          bestDist = dist;
          target = enemy;
        }
      }
      if (target) {
        const dx = target.x - player.x;
        const dy = target.y - player.y;
        const norm = Math.hypot(dx, dy) || 1;
        const speed = 34;
        lastProjectileId += 1;
        projectiles.push({
          id: `shot-${lastProjectileId}`,
          ownerId: player.id,
          x: player.x,
          y: player.y,
          vx: (dx / norm) * speed,
          vy: (dy / norm) * speed,
          ttl: 1.35,
        });
      }
      player.reload = Math.max(0.2, 0.58 - player.kills * 0.012);
    }
  }

  const killsByPlayer: Record<string, number> = {};
  const nextProjectiles: VsProjectile[] = [];
  for (const projectile of projectiles) {
    projectile.x += projectile.vx * dt;
    projectile.y += projectile.vy * dt;
    projectile.ttl -= dt;
    if (projectile.ttl <= 0) continue;

    let hit = false;
    for (const enemy of enemies) {
      if (enemy.hp <= 0) continue;
      const dist = Math.hypot(enemy.x - projectile.x, enemy.y - projectile.y);
      if (dist > 3.2) continue;
      enemy.hp -= 22;
      hit = true;
      if (enemy.hp <= 0) {
        killsByPlayer[projectile.ownerId] =
          (killsByPlayer[projectile.ownerId] || 0) + 1;
      }
      break;
    }
    if (!hit) nextProjectiles.push(projectile);
  }

  for (const enemy of enemies) {
    if (enemy.hp <= 0) continue;
    let target: VsPlayer | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const player of players) {
      if (!player.alive) continue;
      const dist = Math.hypot(player.x - enemy.x, player.y - enemy.y);
      if (dist < bestDist) {
        bestDist = dist;
        target = player;
      }
    }
    if (!target) continue;

    const dx = target.x - enemy.x;
    const dy = target.y - enemy.y;
    const norm = Math.hypot(dx, dy) || 1;
    enemy.x = vsClamp(
      enemy.x + (dx / norm) * enemy.speed * dt,
      -VS_ARENA_LIMIT,
      VS_ARENA_LIMIT
    );
    enemy.y = vsClamp(
      enemy.y + (dy / norm) * enemy.speed * dt,
      -VS_ARENA_LIMIT,
      VS_ARENA_LIMIT
    );

    if (bestDist < 3.6) {
      target.hp -= 19 * dt;
      if (target.hp <= 0) {
        target.hp = 0;
        target.alive = false;
      }
    }
  }

  for (const player of players) {
    player.kills += killsByPlayer[player.id] || 0;
  }

  const nextEnemies = enemies.filter((enemy) => enemy.hp > 0);
  const aliveCount = players.filter((player) => player.alive).length;
  const ended = timeLeft <= 0 || aliveCount === 0;
  const running = !ended;

  if (!running) {
    if (aliveCount > 0) {
      moderatorLine = `Axy moderator: extraction complete. ${aliveCount} survivors held the line.`;
    } else {
      moderatorLine = "Axy moderator: field collapsed. regroup and retry.";
    }
  } else if (modCooldown <= 0) {
    const topKiller = [...players].sort((a, b) => b.kills - a.kills)[0];
    moderatorLine = `Axy moderator: wave ${wave}. ${aliveCount} alive, ${nextEnemies.length} swarm, top ${topKiller?.name || "none"} ${topKiller?.kills || 0}k.`;
    modCooldown = 2.6;
  }

  return {
    ...prev,
    running,
    timeLeft,
    wave,
    tick: prev.tick + 1,
    players,
    enemies: nextEnemies,
    projectiles: nextProjectiles,
    moderatorLine,
    spawnCooldown,
    modCooldown,
    lastEnemyId,
    lastProjectileId,
  };
}

function nextOrbitTarget(prev: number) {
  let next = prev;
  while (next === prev) {
    next = Math.floor(Math.random() * ORBIT_TRACK_SIZE);
  }
  return next;
}

function puzzleToggle(board: boolean[], idx: number) {
  const row = Math.floor(idx / 3);
  const col = idx % 3;
  const next = [...board];
  const cells = [
    [row, col],
    [row - 1, col],
    [row + 1, col],
    [row, col - 1],
    [row, col + 1],
  ];

  cells.forEach(([r, c]) => {
    if (r < 0 || r > 2 || c < 0 || c > 2) return;
    const flat = r * 3 + c;
    next[flat] = !next[flat];
  });

  return next;
}

function puzzleEqual(a: boolean[], b: boolean[]) {
  return a.every((v, idx) => v === b[idx]);
}

function createPuzzle() {
  const goals: boolean[][] = [
    [false, true, false, true, true, true, false, true, false],
    [true, false, true, false, true, false, true, false, true],
    [false, false, false, true, true, true, false, false, false],
  ];
  const goal = goals[Math.floor(Math.random() * goals.length)];
  let board = [...goal];
  const scramble = 4 + Math.floor(Math.random() * 4);
  for (let i = 0; i < scramble; i += 1) {
    board = puzzleToggle(board, Math.floor(Math.random() * 9));
  }
  return { board, goal };
}

export default function Main() {
  const router = useRouter();

  const [username, setUsername] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [gameInput, setGameInput] = useState("");
  const [gameMessages, setGameMessages] = useState<Message[]>([]);
  const [gameLoading, setGameLoading] = useState(false);
  const [chatMode, setChatMode] = useState<ChatMode>("open");
  const [chatWheelDragOffset, setChatWheelDragOffset] = useState(0);
  const [chatWheelIsDragging, setChatWheelIsDragging] = useState(false);
  const chatModeRef = useRef<ChatMode>("open");
  const chatWheelAnimatingRef = useRef(false);
  const chatWheelDragRef = useRef<{
    active: boolean;
    pointerId: number | null;
    startX: number;
  }>({ active: false, pointerId: null, startX: 0 });
  const [loading, setLoading] = useState(false);
  const [realtimePresentUsers, setRealtimePresentUsers] = useState<string[]>(
    []
  );
  const [realtimePresentUserIdsByName, setRealtimePresentUserIdsByName] =
    useState<Record<string, string>>({});
  const [runtimePresentUsers, setRuntimePresentUsers] = useState<string[]>([]);
  const [presentUserGlow, setPresentUserGlow] = useState<string | null>(null);
  const [presentUserOpen, setPresentUserOpen] = useState<string | null>(null);
  const [presentUserAvatars, setPresentUserAvatars] = useState<
    Record<string, string | null>
  >({});
  const [selfAvatarUrl, setSelfAvatarUrl] = useState<string | null>(null);
  const [presentUserHover, setPresentUserHover] = useState<string | null>(null);
  const [touchPromptUser, setTouchPromptUser] = useState<string | null>(null);
  const [touchBusy, setTouchBusy] = useState(false);
  const [inTouchByName, setInTouchByName] = useState<Record<string, boolean>>({});

  /* AXY reflection (messages) */
  const [axyMsgReflection, setAxyMsgReflection] = useState<
    Record<string, string>
  >({});
  const [, setAxyMsgLoadingId] = useState<string | null>(null);
  const [axyMsgPulseId, setAxyMsgPulseId] = useState<string | null>(null);
  const [axyMsgFadeId, setAxyMsgFadeId] = useState<string | null>(null);
  const [hoveredMsgId, setHoveredMsgId] = useState<string | null>(null);
  const [hoveredHushChatId, setHoveredHushChatId] = useState<string | null>(
    null
  );
  const [hoveredHushMemberId, setHoveredHushMemberId] = useState<number | null>(
    null
  );
  const [requestingChatId, setRequestingChatId] = useState<string | null>(null);
  const [initialPuzzle] = useState(() => createPuzzle());

  /* HUSH */
  const [hushChats, setHushChats] = useState<HushChat[]>([]);
  const [hushMembers, setHushMembers] = useState<HushMember[]>([]);
  const [hushUsers, setHushUsers] = useState<Record<string, string>>({});
  const [selectedHushChatId, setSelectedHushChatId] = useState<string | null>(
    null
  );
  const [hushMessages, setHushMessages] = useState<HushMessage[]>([]);
  const [hushInput, setHushInput] = useState("");
  const [hushLoading, setHushLoading] = useState(false);
  const [hushSending, setHushSending] = useState(false);
  const [hushPanelOpen, setHushPanelOpen] = useState(false);
  const [hushAlertPulse, setHushAlertPulse] = useState(false);
  const [hushInviteTarget, setHushInviteTarget] = useState<{
    userId: string;
    username: string;
    chatId?: string;
  } | null>(null);
  const [hushInviteUserId, setHushInviteUserId] = useState("");
  const [hushCreateUserId, setHushCreateUserId] = useState("");
  const [playOpen, setPlayOpen] = useState(false);
  const [activePlay, setActivePlay] = useState<
    "signal-drift" | "slow-orbit" | "hush-puzzle" | typeof QUITE_SWARM_MODE | null
  >(null);
  const [driftRunning, setDriftRunning] = useState(false);
  const [driftScore, setDriftScore] = useState(0);
  const [driftTimeLeft, setDriftTimeLeft] = useState(25);
  const [driftCell, setDriftCell] = useState(5);
  const [driftFlashCell, setDriftFlashCell] = useState<number | null>(null);
  const [orbitRunning, setOrbitRunning] = useState(false);
  const [orbitScore, setOrbitScore] = useState(0);
  const [orbitTimeLeft, setOrbitTimeLeft] = useState(22);
  const [orbitPosition, setOrbitPosition] = useState(0);
  const [orbitTarget, setOrbitTarget] = useState(4);
  const [orbitPulse, setOrbitPulse] = useState(false);
  const [puzzleBoard, setPuzzleBoard] = useState<boolean[]>(
    initialPuzzle.board
  );
  const [puzzleGoal, setPuzzleGoal] = useState<boolean[]>(
    initialPuzzle.goal
  );
  const [puzzleMoves, setPuzzleMoves] = useState(0);
  const [puzzleSolved, setPuzzleSolved] = useState(false);
  const [vsSelectedUsers, setVsSelectedUsers] = useState<string[]>([]);
  const [vsSession, setVsSession] = useState<VsSession>(() =>
    createVsSession(["user"], false)
  );
  const hushPanelRef = useRef<HTMLDivElement | null>(null);
  const hushMembersRef = useRef<HushMember[]>([]);
  const hushAlertTimeoutRef = useRef<number | null>(null);
  const prevInvitesCountRef = useRef(0);
  const prevRequestsCountRef = useRef(0);
  const sharedMessagesRef = useRef<HTMLDivElement | null>(null);
  const sharedStickToBottomRef = useRef(true);
  const presentUsersPanelRef = useRef<HTMLDivElement | null>(null);
  const vsMoveKeysRef = useRef<{
    up: boolean;
    down: boolean;
    left: boolean;
    right: boolean;
  }>({ up: false, down: false, left: false, right: false });
  const [playClosedHeight, setPlayClosedHeight] = useState<number | null>(null);
  const currentUsername = username?.trim() ? username.trim() : "user";
  const displayUsername = username?.trim() ? username.trim() : "\u00A0";
  const presentUsers = useMemo(() => {
    const normalized = [...realtimePresentUsers, ...runtimePresentUsers]
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    return Array.from(new Set(normalized)).sort((a, b) =>
      a.localeCompare(b, "en", { sensitivity: "base" })
    );
  }, [realtimePresentUsers, runtimePresentUsers]);
  const activeMessages = chatMode === "open" ? messages : gameMessages;
  const activeChatLabel = chatMode === "open" ? "open chat" : "game chat";
  const adjacentChatLabel = chatMode === "open" ? "game chat" : "open chat";
  const chatWheelStep = Math.PI / 2.75;
  const chatWheelRadius = 164;
  const chatWheelDepth = 56;
  const chatWheelLeftAngle = (-1 + chatWheelDragOffset) * chatWheelStep;
  const chatWheelCenterAngle = (0 + chatWheelDragOffset) * chatWheelStep;
  const chatWheelRightAngle = (1 + chatWheelDragOffset) * chatWheelStep;
  const chatWheelLeftProminence = (Math.cos(chatWheelLeftAngle) + 1) / 2;
  const chatWheelCenterProminence = (Math.cos(chatWheelCenterAngle) + 1) / 2;
  const chatWheelRightProminence = (Math.cos(chatWheelRightAngle) + 1) / 2;
  const chatWheelLeftX = Math.sin(chatWheelLeftAngle) * chatWheelRadius;
  const chatWheelCenterX = Math.sin(chatWheelCenterAngle) * chatWheelRadius;
  const chatWheelRightX = Math.sin(chatWheelRightAngle) * chatWheelRadius;
  const chatWheelLeftScale = 0.72 + chatWheelLeftProminence * 0.34;
  const chatWheelCenterScale = 0.72 + chatWheelCenterProminence * 0.34;
  const chatWheelRightScale = 0.72 + chatWheelRightProminence * 0.34;
  const chatWheelLeftOpacity = 0.16 + chatWheelLeftProminence * 0.78;
  const chatWheelCenterOpacity = 0.16 + chatWheelCenterProminence * 0.78;
  const chatWheelRightOpacity = 0.16 + chatWheelRightProminence * 0.78;
  const chatWheelLeftBlur = (1 - chatWheelLeftProminence) * 2.1;
  const chatWheelCenterBlur = (1 - chatWheelCenterProminence) * 2.1;
  const chatWheelRightBlur = (1 - chatWheelRightProminence) * 2.1;
  const chatWheelLeftTilt = (-chatWheelLeftAngle * 180) / Math.PI * 0.85;
  const chatWheelCenterTilt = (-chatWheelCenterAngle * 180) / Math.PI * 0.85;
  const chatWheelRightTilt = (-chatWheelRightAngle * 180) / Math.PI * 0.85;
  const chatWheelLeftZ = Math.cos(chatWheelLeftAngle) * chatWheelDepth;
  const chatWheelCenterZ = Math.cos(chatWheelCenterAngle) * chatWheelDepth;
  const chatWheelRightZ = Math.cos(chatWheelRightAngle) * chatWheelDepth;
  const chatWheelTransition = chatWheelIsDragging
    ? "none"
    : "transform 560ms cubic-bezier(0.17, 0.8, 0.22, 1), opacity 360ms ease, filter 360ms ease";
  const vsJoinableUsers = useMemo(
    () => uniqueNames([currentUsername, ...presentUsers]),
    [currentUsername, presentUsers]
  );

  useEffect(() => {
    chatModeRef.current = chatMode;
  }, [chatMode]);

  useEffect(() => {
    setVsSelectedUsers((prev) => {
      const availableSet = new Set(vsJoinableUsers.map((name) => name.toLowerCase()));
      const selfKey = currentUsername.toLowerCase();
      let next = prev.filter((name) => availableSet.has(name.toLowerCase()));
      if (!next.some((name) => name.toLowerCase() === selfKey)) {
        next = [currentUsername, ...next];
      }
      if (next.length === 0) {
        next = vsJoinableUsers.slice(0, Math.min(5, vsJoinableUsers.length));
      }
      const deduped = uniqueNames(next);
      if (
        deduped.length === prev.length &&
        deduped.every((value, idx) => value === prev[idx])
      ) {
        return prev;
      }
      return deduped;
    });
  }, [currentUsername, vsJoinableUsers]);

  useEffect(() => {
    if (!presentUserOpen) return;
    if (!presentUsers.includes(presentUserOpen)) {
      setPresentUserOpen(null);
      setTouchPromptUser(null);
    }
  }, [presentUserOpen, presentUsers]);

  useEffect(() => {
    if (!presentUserOpen) return;

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      if (presentUsersPanelRef.current?.contains(target)) return;
      setPresentUserOpen(null);
      setTouchPromptUser(null);
      setPresentUserHover(null);
    }

    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [presentUserOpen]);

  useEffect(() => {
    const names = Array.from(
      new Set(
        presentUsers
          .map((name) => name.trim())
          .filter((name) => name.length > 0)
      )
    );

    if (names.length === 0) {
      setPresentUserAvatars({});
      return;
    }

    let cancelled = false;

    async function loadPresentUserAvatars() {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token || cancelled) return;

      const params = new URLSearchParams();
      params.set("usernames", names.join(","));

      const res = await fetch(`/api/profiles/public?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      });
      const body = (await res.json().catch(() => ({}))) as {
        rows?: Array<{ username: string; avatar_url: string | null }>;
      };

      if (cancelled || !res.ok) return;

      const nextMap: Record<string, string | null> = {};
      names.forEach((name) => {
        nextMap[name.trim().toLowerCase()] = null;
      });

      (body.rows || []).forEach((row) => {
        if (!row?.username) return;
        nextMap[String(row.username).trim().toLowerCase()] =
          typeof row.avatar_url === "string" ? row.avatar_url : null;
      });

      setPresentUserAvatars(nextMap);
    }

    void loadPresentUserAvatars();

    return () => {
      cancelled = true;
    };
  }, [presentUsers]);

  const loadTouchState = useCallback(async () => {
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) {
        setInTouchByName({});
        return;
      }

      const res = await fetch("/api/keep-in-touch", {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      });

      const body = (await res.json().catch(() => ({}))) as {
        inTouch?: Array<{ username: string }>;
      };

      if (!res.ok) return;

      const nextMap: Record<string, boolean> = {};
      (body.inTouch || []).forEach((row) => {
        if (!row?.username) return;
        nextMap[String(row.username).trim().toLowerCase()] = true;
      });
      setInTouchByName(nextMap);
    } catch {
      // ignore background load failures
    }
  }, []);

  /*  load user + messages */
  useEffect(() => {
    async function load() {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        router.push("/login");
        return;
      }

      setUserId(user.id);

      const { data: profile } = await supabase
        .from("profileskozmos")
        .select("username, avatar_url")
        .eq("id", user.id)
        .maybeSingle();

      setUsername(profile?.username?.trim() || "user");
      setSelfAvatarUrl(
        typeof profile?.avatar_url === "string" ? profile.avatar_url : null
      );

      const { data } = await supabase
        .from("main_messages")
        .select("id, user_id, username, content")
        .order("created_at", { ascending: true });

      setMessages(data || []);

      const { data: gameData } = await supabase
        .from("game_chat_messages")
        .select("id, user_id, username, content")
        .order("created_at", { ascending: true });

      setGameMessages(gameData || []);
    }

    load();
  }, [router]);

  const loadHush = useCallback(async () => {
    const { data: chats } = await supabase
      .from("hush_chats")
      .select("id, created_by, status, created_at")
      .eq("status", "open")
      .order("created_at", { ascending: false });

    setHushChats(chats || []);

    if (!chats || chats.length === 0) {
      setHushMembers([]);
      setHushUsers({});
      setHushMessages([]);
      setSelectedHushChatId(null);
      return;
    }

    if (
      selectedHushChatId &&
      !chats.some((chat) => chat.id === selectedHushChatId)
    ) {
      setSelectedHushChatId(null);
    }

    const chatIds = chats.map((chat) => chat.id);
    const { data: members } = await supabase
      .from("hush_chat_members")
      .select("id, chat_id, user_id, role, status, display_name, created_at")
      .in("chat_id", chatIds);

    setHushMembers(members || []);

    const map: Record<string, string> = {};
    (members || []).forEach((member) => {
      if (member.display_name) {
        map[member.user_id] = member.display_name;
      }
    });

    const userIds = Array.from(
      new Set((members || []).map((member) => member.user_id))
    );

    if (userIds.length === 0) {
      setHushUsers(map);
      return;
    }

    const missingUserIds = userIds.filter((id) => !map[id]);
    if (missingUserIds.length === 0) {
      setHushUsers(map);
      return;
    }

    const { data: profiles } = await supabase
      .from("profileskozmos")
      .select("id, username")
      .in("id", missingUserIds);

    (profiles || []).forEach((profile) => {
      map[profile.id] = profile.username;
    });

    setHushUsers(map);
  }, [selectedHushChatId]);

  const loadHushMessages = useCallback(async (chatId: string) => {
    const { data } = await supabase
      .from("hush_chat_messages")
      .select("id, chat_id, user_id, content, created_at")
      .eq("chat_id", chatId)
      .order("created_at", { ascending: true });

    setHushMessages(data || []);
  }, []);

  const loadRuntimePresentUsers = useCallback(async () => {
    try {
      const thresholdIso = new Date(Date.now() - 35 * 1000).toISOString();

      const { data: runtimeRows, error: runtimeErr } = await supabase
        .from("runtime_presence")
        .select("username,last_seen_at")
        .gte("last_seen_at", thresholdIso);

      if (runtimeErr || !runtimeRows || runtimeRows.length === 0) {
        setRuntimePresentUsers([]);
        return;
      }

      const names = runtimeRows
        .map((row) => row.username)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));

      setRuntimePresentUsers(names);
    } catch {
      setRuntimePresentUsers([]);
    }
  }, []);

  function getHushUserName(id: string) {
    return hushUsers[id] || "user";
  }

  function getHushChatLabel(chatId: string) {
    const activeMembers = hushMembers.filter(
      (member) =>
        member.chat_id === chatId &&
        member.status !== "declined" &&
        member.status !== "requested" &&
        member.status !== "removed" &&
        member.status !== "left"
    );

    const names = activeMembers.map((member) =>
      getHushUserName(member.user_id)
    );

    return names.length ? names.join(" + ") : "hush";
  }

  function canRequestHush(chatId: string) {
    const myMember = getMyHushMembership(chatId);
    if (!myMember) return true;
    return (
      myMember.status === "declined" ||
      myMember.status === "left" ||
      myMember.status === "removed"
    );
  }

  const getMyHushMembership = useCallback((chatId: string) => {
    if (!userId) return null;
    return hushMembers.find(
      (member) => member.chat_id === chatId && member.user_id === userId
    );
  }, [hushMembers, userId]);

  const triggerHushAlert = useCallback(() => {
    if (hushPanelOpen) return;
    setHushAlertPulse(true);
    if (hushAlertTimeoutRef.current) {
      window.clearTimeout(hushAlertTimeoutRef.current);
    }
    hushAlertTimeoutRef.current = window.setTimeout(() => {
      setHushAlertPulse(false);
      hushAlertTimeoutRef.current = null;
    }, 2400);
  }, [hushPanelOpen]);

  useEffect(() => {
    if (!userId) return;

    const run = () => {
      void loadHush();
      if (selectedHushChatId) {
        void loadHushMessages(selectedHushChatId);
      }
    };

    const first = window.setTimeout(run, 0);

    const channel = supabase
      .channel("hush-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "hush_chats" },
        () => {
          void loadHush();
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "hush_chat_members" },
        () => {
          void loadHush();
          if (selectedHushChatId) {
            void loadHushMessages(selectedHushChatId);
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "hush_chat_messages" },
        (payload) => {
          const next = payload.new as HushMessage | null;
          const prev = payload.old as HushMessage | null;
          const chatId = next?.chat_id || prev?.chat_id;

          if (selectedHushChatId && chatId === selectedHushChatId) {
            void loadHushMessages(selectedHushChatId);
          }

          if (
            payload.eventType === "INSERT" &&
            next &&
            next.user_id !== userId &&
            chatId
          ) {
            const meAcceptedInChat = hushMembersRef.current.some(
              (member) =>
                member.chat_id === chatId &&
                member.user_id === userId &&
                member.status === "accepted"
            );
            if (meAcceptedInChat) {
              triggerHushAlert();
            }
          }
        }
      )
      .subscribe();

    const poll = setInterval(() => {
      void loadHush();
      if (selectedHushChatId) {
        void loadHushMessages(selectedHushChatId);
      }
    }, 6000);

    return () => {
      window.clearTimeout(first);
      clearInterval(poll);
      supabase.removeChannel(channel);
    };
  }, [loadHush, loadHushMessages, selectedHushChatId, triggerHushAlert, userId]);

  useEffect(() => {
    hushMembersRef.current = hushMembers;
  }, [hushMembers]);

  useEffect(() => {
    if (hushPanelOpen) {
      setHushAlertPulse(false);
    }
  }, [hushPanelOpen]);

  useEffect(() => {
    return () => {
      if (hushAlertTimeoutRef.current) {
        window.clearTimeout(hushAlertTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!selectedHushChatId || !userId) return;

    const myMembership = hushMembers.find(
      (member) =>
        member.chat_id === selectedHushChatId && member.user_id === userId
    );
    if (!myMembership || myMembership.status !== "accepted") return;

    const tick = window.setTimeout(() => {
      void loadHushMessages(selectedHushChatId);
    }, 0);

    return () => {
      window.clearTimeout(tick);
    };
  }, [hushMembers, loadHushMessages, selectedHushChatId, userId]);

  useEffect(() => {
    if (playClosedHeight !== null) return;
    const el = hushPanelRef.current;
    if (!el) return;

    setPlayClosedHeight(el.getBoundingClientRect().height);
  }, [playClosedHeight]);

  useEffect(() => {
    if (!playOpen || activePlay !== "signal-drift" || !driftRunning) return;
    const timer = window.setInterval(() => {
      setDriftTimeLeft((prev) => {
        if (prev <= 1) {
          setDriftRunning(false);
          return 0;
        }
        return prev - 1;
      });
      setDriftCell((prev) => {
        let next = prev;
        while (next === prev) {
          next = Math.floor(Math.random() * 16);
        }
        return next;
      });
    }, 850);

    return () => window.clearInterval(timer);
  }, [playOpen, activePlay, driftRunning]);

  useEffect(() => {
    if (!playOpen || activePlay !== "slow-orbit" || !orbitRunning) return;

    const orbitTick = window.setInterval(() => {
      setOrbitPosition((prev) => (prev + 1) % ORBIT_TRACK_SIZE);
    }, 170);

    const secondTick = window.setInterval(() => {
      setOrbitTimeLeft((prev) => {
        if (prev <= 1) {
          setOrbitRunning(false);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      window.clearInterval(orbitTick);
      window.clearInterval(secondTick);
    };
  }, [playOpen, activePlay, orbitRunning]);

  useEffect(() => {
    if (!playOpen || activePlay !== QUITE_SWARM_MODE || !vsSession.running) return;

    const timer = window.setInterval(() => {
      const controls = vsMoveKeysRef.current;
      setVsSession((prev) =>
        advanceVsSession(prev, {
          controlledName: currentUsername,
          controls,
        })
      );
    }, VS_STEP_SECONDS * 1000);

    return () => window.clearInterval(timer);
  }, [playOpen, activePlay, currentUsername, vsSession.running]);

  useEffect(() => {
    if (activePlay !== QUITE_SWARM_MODE || vsSession.running) return;
    const roster = uniqueNames(
      vsSelectedUsers.length > 0 ? vsSelectedUsers : [currentUsername]
    );
    const currentRoster = vsSession.players.map((player) => player.name);
    if (
      roster.length === currentRoster.length &&
      roster.every((name, idx) => name === currentRoster[idx])
    ) {
      return;
    }
    setVsSession(createVsSession(roster, false));
  }, [activePlay, currentUsername, vsSelectedUsers, vsSession.players, vsSession.running]);

  useEffect(() => {
    if (!playOpen || activePlay !== QUITE_SWARM_MODE || !vsSession.running) return;

    function resetKeys() {
      vsMoveKeysRef.current.up = false;
      vsMoveKeysRef.current.down = false;
      vsMoveKeysRef.current.left = false;
      vsMoveKeysRef.current.right = false;
    }

    function applyKey(key: string, pressed: boolean) {
      const normalized = key.toLowerCase();
      if (normalized === "w" || normalized === "arrowup") {
        vsMoveKeysRef.current.up = pressed;
      } else if (normalized === "s" || normalized === "arrowdown") {
        vsMoveKeysRef.current.down = pressed;
      } else if (normalized === "a" || normalized === "arrowleft") {
        vsMoveKeysRef.current.left = pressed;
      } else if (normalized === "d" || normalized === "arrowright") {
        vsMoveKeysRef.current.right = pressed;
      } else {
        return false;
      }
      return true;
    }

    function onKeyDown(event: KeyboardEvent) {
      if (applyKey(event.key, true)) {
        event.preventDefault();
      }
    }

    function onKeyUp(event: KeyboardEvent) {
      if (applyKey(event.key, false)) {
        event.preventDefault();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", resetKeys);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", resetKeys);
      resetKeys();
    };
  }, [playOpen, activePlay, vsSession.running]);

  const syncSharedStickToBottom = useCallback(() => {
    const el = sharedMessagesRef.current;
    if (!el) return;
    const distanceToBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
    sharedStickToBottomRef.current = distanceToBottom <= 28;
  }, []);

  useEffect(() => {
    const el = sharedMessagesRef.current;
    if (!el) return;
    if (!sharedStickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [activeMessages, chatMode]);

  useEffect(() => {
    const el = sharedMessagesRef.current;
    if (!el) return;
    if (!sharedStickToBottomRef.current) return;
    const raf = window.requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => {
      window.cancelAnimationFrame(raf);
    };
  }, [axyMsgReflection]);

  /*  REALTIME (insert + delete) */
  useEffect(() => {
    const channel = supabase
      .channel("main-messages-realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "main_messages" },
        (payload) => {
          const msg = payload.new as Message;
          setMessages((prev) =>
            prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]
          );
        }
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "main_messages" },
        (payload) => {
          const id = payload.old.id;
          setMessages((prev) => prev.filter((m) => m.id !== id));
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  useEffect(() => {
    const channel = supabase
      .channel("game-chat-messages-realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "game_chat_messages" },
        (payload) => {
          const msg = payload.new as Message;
          setGameMessages((prev) =>
            prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]
          );
        }
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "game_chat_messages" },
        (payload) => {
          const id = payload.old.id;
          setGameMessages((prev) => prev.filter((m) => m.id !== id));
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  useEffect(() => {
    if (!userId) return;

    const channel = supabase.channel("shared-space-presence", {
      config: {
        presence: {
          key: userId,
        },
      },
    });

    const syncPresentUsers = () => {
      const state = channel.presenceState<{
        user_id: string;
        username: string;
        online_at: string;
      }>();

      const map = new Map<string, string>();
      const idsByName: Record<string, string> = {};
      Object.values(state).forEach((metas) => {
        metas.forEach((meta) => {
          if (meta?.user_id && meta?.username) {
            map.set(meta.user_id, meta.username);
            idsByName[meta.username.trim().toLowerCase()] = meta.user_id;
          }
        });
      });

      const names = Array.from(map.values()).sort((a, b) =>
        a.localeCompare(b, "en", { sensitivity: "base" })
      );
      setRealtimePresentUsers(names);
      setRealtimePresentUserIdsByName(idsByName);
    };

    channel
      .on("presence", { event: "sync" }, syncPresentUsers)
      .on("presence", { event: "join" }, syncPresentUsers)
      .on("presence", { event: "leave" }, syncPresentUsers)
      .subscribe(async (status) => {
        if (status !== "SUBSCRIBED") return;
        await channel.track({
          user_id: userId,
          username: currentUsername,
          online_at: new Date().toISOString(),
        });
      });

    return () => {
      channel.untrack();
      supabase.removeChannel(channel);
    };
  }, [currentUsername, userId]);

  useEffect(() => {
    if (!userId) return;

    const run = () => {
      void loadRuntimePresentUsers();
    };

    const first = window.setTimeout(run, 0);
    const poll = window.setInterval(run, 2000);

    return () => {
      window.clearTimeout(first);
      window.clearInterval(poll);
    };
  }, [loadRuntimePresentUsers, userId]);

  useEffect(() => {
    if (!userId) return;

    const channel = supabase
      .channel("runtime-presence-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "runtime_presence" },
        () => {
          void loadRuntimePresentUsers();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [loadRuntimePresentUsers, userId]);

  useEffect(() => {
    if (!userId) return;

    const run = () => {
      void loadTouchState();
    };

    const first = window.setTimeout(run, 0);
    const poll = window.setInterval(run, 15000);

    return () => {
      window.clearTimeout(first);
      window.clearInterval(poll);
    };
  }, [loadTouchState, userId]);

  /*  send */
  async function sendMessage() {
    if (!input.trim() || !userId) return;

    setLoading(true);

    await supabase.from("main_messages").insert({
      user_id: userId,
      username: currentUsername,
      content: input,
    });

    setInput("");
    setLoading(false);
  }

  async function sendGameMessage() {
    if (!gameInput.trim() || !userId) return;

    setGameLoading(true);

    await supabase.from("game_chat_messages").insert({
      user_id: userId,
      username: currentUsername,
      content: gameInput,
    });

    setGameInput("");
    setGameLoading(false);
  }

  async function requestKeepInTouch(targetUsername: string) {
    const name = targetUsername.trim();
    if (!name || touchBusy) return;
    if (name.toLowerCase() === currentUsername.toLowerCase()) return;

    setTouchBusy(true);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) {
        return;
      }

      const res = await fetch("/api/keep-in-touch/request", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ targetUsername: name }),
      });

      await res.json().catch(() => ({}));

      if (!res.ok) {
        return;
      }
      await loadTouchState();
      setTouchPromptUser(null);
    } catch {
      // no inline status toast for keep-in-touch action
    } finally {
      setTouchBusy(false);
    }
  }

  /*  delete */
  async function deleteMessage(id: string) {
    await supabase.from("main_messages").delete().eq("id", id);
  }

  async function deleteGameMessage(id: string) {
    await supabase.from("game_chat_messages").delete().eq("id", id);
  }

  /* AXY reflect (message) */
  async function askAxyOnMessage(
    mode: ChatMode,
    messageId: string,
    content: string
  ) {
    const reflectionKey = `${mode}:${messageId}`;
    setAxyMsgLoadingId(reflectionKey);

    try {
      const res = await fetch("/api/axy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: `Reflect on this message in one calm sentence:\n\n${content}`,
        }),
      });

      const data = await res.json();

      setAxyMsgReflection((prev) => ({
        ...prev,
        [reflectionKey]: data.reply,
      }));
    } catch {
      setAxyMsgReflection((prev) => ({
        ...prev,
        [reflectionKey]: "...",
      }));
    }

    setAxyMsgLoadingId(null);
  }

  function openPlay(
    game: "signal-drift" | "slow-orbit" | "hush-puzzle" | typeof QUITE_SWARM_MODE
  ) {
    setActivePlay(game);
    if (game === "signal-drift") {
      setDriftRunning(false);
      setDriftScore(0);
      setDriftTimeLeft(25);
      setDriftCell(Math.floor(Math.random() * 16));
      setDriftFlashCell(null);
    }
    if (game === "slow-orbit") {
      setOrbitRunning(false);
      setOrbitScore(0);
      setOrbitTimeLeft(22);
      setOrbitPosition(0);
      setOrbitTarget(Math.floor(Math.random() * ORBIT_TRACK_SIZE));
      setOrbitPulse(false);
    }
    if (game === "hush-puzzle") {
      const puzzle = createPuzzle();
      setPuzzleBoard(puzzle.board);
      setPuzzleGoal(puzzle.goal);
      setPuzzleMoves(0);
      setPuzzleSolved(false);
    }
    if (game === QUITE_SWARM_MODE) {
      const roster =
        vsSelectedUsers.length > 0 ? vsSelectedUsers : [currentUsername];
      setVsSession(createVsSession(roster, false));
    }
  }

  function togglePlayPanel() {
    setPlayOpen((prev) => {
      const next = !prev;
      if (!next) {
        setActivePlay(null);
        setDriftRunning(false);
        setOrbitRunning(false);
        setVsSession((prev) => ({ ...prev, running: false }));
      }
      return next;
    });
  }

  function animateChatModeChange(nextMode: ChatMode, direction: 1 | -1) {
    if (chatWheelAnimatingRef.current) return;
    chatWheelAnimatingRef.current = true;
    setChatWheelIsDragging(false);
    const targetOffset = direction;
    setChatWheelDragOffset(targetOffset);
    window.setTimeout(() => {
      setChatMode(nextMode);
      setChatWheelDragOffset(0);
    }, 520);
    window.setTimeout(() => {
      chatWheelAnimatingRef.current = false;
    }, 620);
  }

  function cycleChatMode(direction: 1 | -1) {
    const current = chatModeRef.current;
    const next = current === "open" ? "game" : "open";
    animateChatModeChange(next, direction);
  }

  function selectChatMode(target: ChatMode, direction: 1 | -1) {
    const current = chatModeRef.current;
    if (target === current) return;
    animateChatModeChange(target, direction);
  }

  function onChatWheelPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (chatWheelAnimatingRef.current) return;
    setChatWheelIsDragging(true);
    chatWheelDragRef.current = {
      active: true,
      pointerId: e.pointerId,
      startX: e.clientX,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onChatWheelPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const state = chatWheelDragRef.current;
    if (!state.active || state.pointerId !== e.pointerId) return;
    const dx = e.clientX - state.startX;
    const normalized = Math.tanh(dx / 150);
    setChatWheelDragOffset(normalized);
  }

  function onChatWheelPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const state = chatWheelDragRef.current;
    if (state.pointerId !== e.pointerId) return;
    const finalOffset = chatWheelDragOffset;
    chatWheelDragRef.current = { active: false, pointerId: null, startX: 0 };
    setChatWheelIsDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    if (Math.abs(finalOffset) < 0.32) {
      setChatWheelDragOffset(0);
      return;
    }
    cycleChatMode(finalOffset > 0 ? 1 : -1);
  }

  function startSignalDrift() {
    setDriftScore(0);
    setDriftTimeLeft(25);
    setDriftCell(Math.floor(Math.random() * 16));
    setDriftFlashCell(null);
    setDriftRunning(true);
  }

  function tapDriftCell(cell: number) {
    if (!driftRunning) return;
    if (cell !== driftCell) return;
    setDriftScore((prev) => prev + 1);
    setDriftFlashCell(cell);
    setTimeout(() => setDriftFlashCell(null), 180);
    setDriftCell((prev) => {
      let next = prev;
      while (next === prev) {
        next = Math.floor(Math.random() * 16);
      }
      return next;
    });
  }

  function startSlowOrbit() {
    setOrbitRunning(true);
    setOrbitScore(0);
    setOrbitTimeLeft(22);
    setOrbitPosition(0);
    setOrbitTarget(Math.floor(Math.random() * ORBIT_TRACK_SIZE));
    setOrbitPulse(false);
  }

  function syncSlowOrbit() {
    if (!orbitRunning) return;
    const dist = Math.abs(orbitPosition - orbitTarget);
    const wrapDist = Math.min(dist, ORBIT_TRACK_SIZE - dist);
    if (wrapDist <= 1) {
      setOrbitScore((prev) => prev + (wrapDist === 0 ? 2 : 1));
      setOrbitTarget((prev) => nextOrbitTarget(prev));
      setOrbitPulse(true);
      setTimeout(() => setOrbitPulse(false), 170);
    }
  }

  function resetHushPuzzle() {
    const puzzle = createPuzzle();
    setPuzzleBoard(puzzle.board);
    setPuzzleGoal(puzzle.goal);
    setPuzzleMoves(0);
    setPuzzleSolved(false);
  }

  function tapPuzzleCell(idx: number) {
    if (puzzleSolved) return;
    setPuzzleBoard((prev) => {
      const next = puzzleToggle(prev, idx);
      const solved = puzzleEqual(next, puzzleGoal);
      setPuzzleSolved(solved);
      return next;
    });
    setPuzzleMoves((prev) => prev + 1);
  }

  function toggleVsParticipant(name: string) {
    if (vsSession.running) return;
    const key = name.toLowerCase();
    const selfKey = currentUsername.toLowerCase();
    if (key === selfKey) return;

    setVsSelectedUsers((prev) => {
      const exists = prev.some((item) => item.toLowerCase() === key);
      if (exists) {
        return prev.filter((item) => item.toLowerCase() !== key);
      }
      if (prev.length >= 8) return prev;
      return [...prev, name];
    });
  }

  function startAxyVampire() {
    const roster = uniqueNames(
      vsSelectedUsers.length > 0 ? vsSelectedUsers : [currentUsername]
    );
    if (roster.length === 0) return;
    setVsSession(createVsSession(roster, true));
  }

  function stopAxyVampire() {
    setVsSession((prev) => ({
      ...prev,
      running: false,
      moderatorLine: "Axy moderator: session paused.",
    }));
  }

  async function createHushWith(targetUserId: string, targetUsername?: string) {
    if (!userId || hushLoading) return;

    setHushLoading(true);

    const { data: chat, error: chatError } = await supabase
      .from("hush_chats")
      .insert({ created_by: userId })
      .select("id, created_by, status, created_at")
      .single();

    if (chatError || !chat) {
      setHushLoading(false);
      return;
    }

    const { error: memberError } = await supabase
      .from("hush_chat_members")
      .insert([
        {
          chat_id: chat.id,
          user_id: userId,
          role: "owner",
          status: "accepted",
          display_name: currentUsername,
        },
        {
          chat_id: chat.id,
          user_id: targetUserId,
          role: "member",
          status: "invited",
          display_name: targetUsername ?? hushInviteTarget?.username ?? "user",
        },
      ]);

    if (!memberError) {
      setSelectedHushChatId(chat.id);
      setHushInviteTarget(null);
      await loadHush();
    }

    setHushLoading(false);
  }

  async function inviteToHushChat(
    chatId: string,
    targetUserId: string,
    targetUsername?: string
  ) {
    if (!userId || hushLoading) return;

    setHushLoading(true);

    await supabase.from("hush_chat_members").insert({
      chat_id: chatId,
      user_id: targetUserId,
      role: "member",
      status: "invited",
      display_name: targetUsername ?? hushInviteTarget?.username ?? "user",
    });

    setHushInviteTarget(null);
    await loadHush();
    setHushLoading(false);
  }

  async function requestHushJoin(chatId: string) {
    if (!userId || hushLoading) return;
    if (!canRequestHush(chatId)) return;

    setHushLoading(true);
    setRequestingChatId(chatId);

    await supabase
      .from("hush_chat_members")
      .upsert(
        {
          chat_id: chatId,
          user_id: userId,
          role: "member",
          status: "requested",
          display_name: currentUsername,
        },
        { onConflict: "chat_id,user_id" }
      );

    await loadHush();
    setHushLoading(false);
    setRequestingChatId(null);
  }

  async function acceptHushRequest(chatId: string, memberUserId: string) {
    await supabase
      .from("hush_chat_members")
      .update({ status: "accepted" })
      .eq("chat_id", chatId)
      .eq("user_id", memberUserId);

    await loadHush();
  }

  async function declineHushRequest(chatId: string, memberUserId: string) {
    await supabase
      .from("hush_chat_members")
      .update({ status: "declined" })
      .eq("chat_id", chatId)
      .eq("user_id", memberUserId);

    await loadHush();
  }

  async function acceptHushInvite(chatId: string) {
    if (!userId) return;

    await supabase
      .from("hush_chat_members")
      .update({ status: "accepted" })
      .eq("chat_id", chatId)
      .eq("user_id", userId);

    setSelectedHushChatId(chatId);
    await loadHush();
  }

  async function declineHushInvite(chatId: string) {
    if (!userId) return;

    await supabase
      .from("hush_chat_members")
      .update({ status: "declined" })
      .eq("chat_id", chatId)
      .eq("user_id", userId);

    await loadHush();
  }

  async function leaveHushChat(chatId: string) {
    if (!userId) return;

    const myMembership = getMyHushMembership(chatId);
    const activeMembers = hushMembers.filter(
      (member) =>
        member.chat_id === chatId &&
        member.status !== "declined" &&
        member.status !== "removed" &&
        member.status !== "left"
    );

    await supabase
      .from("hush_chat_members")
      .update({ status: "left" })
      .eq("chat_id", chatId)
      .eq("user_id", userId);

    if (myMembership?.role === "owner" && activeMembers.length <= 2) {
      await supabase
        .from("hush_chats")
        .update({ status: "closed" })
        .eq("id", chatId);
    }

    if (selectedHushChatId === chatId) {
      setSelectedHushChatId(null);
    }

    await loadHush();
  }

  async function removeHushMember(chatId: string, memberUserId: string) {
    await supabase
      .from("hush_chat_members")
      .update({ status: "removed" })
      .eq("chat_id", chatId)
      .eq("user_id", memberUserId);

    await loadHush();
  }

  async function sendHushMessage() {
    if (!selectedHushChatId || !userId || !hushInput.trim() || hushSending)
      return;

    const myMembership = getMyHushMembership(selectedHushChatId);
    if (!myMembership || myMembership.status !== "accepted") return;

    setHushSending(true);

    await supabase.from("hush_chat_messages").insert({
      chat_id: selectedHushChatId,
      user_id: userId,
      content: hushInput.trim(),
    });

    setHushInput("");
    setHushSending(false);
    await loadHushMessages(selectedHushChatId);
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/");
  }

  const invitesForMe = userId
    ? hushMembers.filter(
        (member) => member.user_id === userId && member.status === "invited"
      )
    : [];

  const myHushChatIds = userId
    ? hushChats.filter((chat) => chat.created_by === userId).map((chat) => chat.id)
    : [];

  const requestsForMe = myHushChatIds.length
    ? hushMembers.filter(
        (member) =>
          member.status === "requested" &&
          myHushChatIds.includes(member.chat_id)
      )
    : [];

  useEffect(() => {
    const inviteCount = invitesForMe.length;
    const requestCount = requestsForMe.length;
    const inviteIncreased = inviteCount > prevInvitesCountRef.current;
    const requestIncreased = requestCount > prevRequestsCountRef.current;

    if (inviteIncreased || requestIncreased) {
      triggerHushAlert();
    }

    prevInvitesCountRef.current = inviteCount;
    prevRequestsCountRef.current = requestCount;
  }, [invitesForMe.length, requestsForMe.length, triggerHushAlert]);

  const selectedHushMembership = selectedHushChatId
    ? getMyHushMembership(selectedHushChatId)
    : null;

  const hushCreatablePresentUsers = useMemo(() => {
    const byId = new Map<string, string>();
    presentUsers.forEach((username) => {
      const mappedUserId = realtimePresentUserIdsByName[username.trim().toLowerCase()];
      if (!mappedUserId || mappedUserId === userId) return;
      if (!byId.has(mappedUserId)) {
        byId.set(mappedUserId, username);
      }
    });
    return Array.from(byId.entries()).map(([id, username]) => ({
      userId: id,
      username,
    }));
  }, [presentUsers, realtimePresentUserIdsByName, userId]);

  const selectedHushMembers = selectedHushChatId
    ? hushMembers.filter(
        (member) =>
          member.chat_id === selectedHushChatId &&
          member.status !== "declined" &&
          member.status !== "requested" &&
          member.status !== "removed" &&
          member.status !== "left"
      )
    : [];

  const canChatInSelectedHush =
    selectedHushMembership?.status === "accepted";
  const isSelectedHushOwner = selectedHushMembership?.role === "owner";

  const hushInvitablePresentUsers = useMemo(() => {
    if (!selectedHushChatId || !isSelectedHushOwner) return [];

    const memberIds = new Set(selectedHushMembers.map((member) => member.user_id));

    return presentUsers
      .map((username) => {
        const mappedUserId =
          realtimePresentUserIdsByName[username.trim().toLowerCase()];
        return { userId: mappedUserId, username };
      })
      .filter(
        (entry) =>
          Boolean(entry.userId) &&
          entry.userId !== userId &&
          !memberIds.has(entry.userId)
      );
  }, [
    isSelectedHushOwner,
    presentUsers,
    realtimePresentUserIdsByName,
    selectedHushChatId,
    selectedHushMembers,
    userId,
  ]);

  const selectedHushInviteUser =
    hushInvitablePresentUsers.find((entry) => entry.userId === hushInviteUserId) ??
    hushInvitablePresentUsers[0] ??
    null;

  const selectedHushCreateUser =
    hushCreatablePresentUsers.find((entry) => entry.userId === hushCreateUserId) ??
    hushCreatablePresentUsers[0] ??
    null;

  const selectedChatMessages = selectedHushChatId
    ? hushMessages.filter((msg) => msg.chat_id === selectedHushChatId)
    : [];

  useEffect(() => {
    if (hushInvitablePresentUsers.length === 0) {
      setHushInviteUserId("");
      return;
    }
    if (
      hushInviteUserId &&
      hushInvitablePresentUsers.some((entry) => entry.userId === hushInviteUserId)
    ) {
      return;
    }
    setHushInviteUserId(hushInvitablePresentUsers[0].userId);
  }, [hushInviteUserId, hushInvitablePresentUsers]);

  useEffect(() => {
    if (hushCreatablePresentUsers.length === 0) {
      setHushCreateUserId("");
      return;
    }
    if (
      hushCreateUserId &&
      hushCreatablePresentUsers.some((entry) => entry.userId === hushCreateUserId)
    ) {
      return;
    }
    setHushCreateUserId(hushCreatablePresentUsers[0].userId);
  }, [hushCreateUserId, hushCreatablePresentUsers]);

  useEffect(() => {
    if (selectedHushChatId) {
      setHushPanelOpen(true);
    }
  }, [selectedHushChatId]);

  return (
    <main
      className="main-page-shell"
      style={{
        minHeight: "100vh",
        background: "#0b0b0b",
        color: "#eaeaea",
        padding: 40,
        position: "relative",
      }}
    >
{/* LOGO */}
<div
  style={{
    position: "absolute",
    top: 30,
    left: "50%",
    transform: "translateX(-54%)",
    zIndex: 5,
  }}
>
  <Image
    src="/kozmos-logomother1.png"
    alt="Kozmos"
    width={131}
    height={98}
    className="kozmos-logo kozmos-logo-ambient"
    style={{
      maxWidth: 80, // ana sayfadakiyle uyumlu
      height: "auto",
      opacity: 0.9,
      cursor: "pointer",
      transition:
        "opacity 0.25s ease, transform 0.08s ease, box-shadow 0.25s ease",
    }}
    onClick={() => window.location.href = "https://kozmos.social"}
    onMouseEnter={(e) => {
      e.currentTarget.style.opacity = "1";
      e.currentTarget.style.boxShadow =
        "0 0 18px rgba(107,255,142,0.45)";
    }}
    onMouseLeave={(e) => {
      e.currentTarget.style.opacity = "0.9";
      e.currentTarget.style.boxShadow = "none";
    }}
    onMouseDown={(e) => {
      e.currentTarget.style.transform = "scale(0.97)";
    }}
    onMouseUp={(e) => {
      e.currentTarget.style.transform = "scale(1)";
    }}
  />
</div>

      {/* TOP LEFT */}
      <div
        style={{
          position: "absolute",
          top: 16,
          left: 16,
          fontSize: 12,
          letterSpacing: "0.12em",
          opacity: 0.6,
          cursor: "default",
          userSelect: "none",
        }}
      >
        <span style={{ cursor: "pointer" }} onClick={() => router.push("/main")}>
          main
        </span>{" "}
        /{" "}
        <span
          style={{ cursor: "pointer" }}
          onClick={() => router.push("/main/space")}
        >
          space
        </span>
        {" / "}
        <span
          style={{ cursor: "pointer" }}
          onClick={() => router.push("/my-home")}
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
          letterSpacing: "0.12em",
          opacity: 0.6,
          cursor: "default",
          userSelect: "none",
        }}
      >
        <span
          style={{ marginRight: 8, cursor: "pointer", opacity: 0.8 }}
          onClick={() => router.push("/account")}
          >
          {displayUsername}
        </span>
        /{" "}
        <span style={{ cursor: "pointer" }} onClick={handleLogout}>
          logout
        </span>
      </div>

      {/* MAIN GRID */}
      <div className="main-grid" style={mainGridStyle}>
        {/* LEFT PANELS */}
        <div className="left-panel-stack" style={leftPanelStackStyle}>
          {/* HUSH PANEL */}
          <div
            className={`hush-panel${hushAlertPulse ? " hush-panel-alert" : ""}`}
            style={hushPanelStyle}
            ref={hushPanelRef}
          >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 12,
          }}
        >
          <div style={{ opacity: 0.6, letterSpacing: "0.2em" }}>
            {"hush\u00b7chat"}
          </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            className="kozmos-tap hush-refresh"
            style={{ opacity: 0.4, cursor: "pointer" }}
            onClick={(e) => {
              e.stopPropagation();
              loadHush();
            }}
          >
            refresh
          </div>
          <div
            className="kozmos-tap"
            style={{ opacity: 0.52, cursor: "pointer" }}
            onClick={(e) => {
              e.stopPropagation();
              setHushPanelOpen((prev) => !prev);
            }}
          >
            {hushPanelOpen ? "close" : "open"}
          </div>
        </div>
      </div>

      {!hushPanelOpen ? (
        <div
          className="kozmos-tap"
          style={{ opacity: 0.55, fontSize: 11, cursor: "pointer" }}
          onClick={(e) => {
            e.stopPropagation();
            setHushPanelOpen(true);
          }}
        >
          {`active hushes: ${hushChats.length}`}
        </div>
      ) : (
      <>

      <div style={{ marginBottom: 12 }}>
        <div style={{ opacity: 0.5, marginBottom: 4 }}>start hush</div>
        {selectedHushCreateUser ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <select
              value={selectedHushCreateUser.userId}
              onChange={(e) => setHushCreateUserId(e.target.value)}
              style={{
                flex: 1,
                background: "rgba(255,255,255,0.03)",
                border: "1px solid rgba(255,255,255,0.18)",
                color: "#eaeaea",
                fontSize: 12,
                padding: "6px 8px",
                outline: "none",
              }}
            >
              {hushCreatablePresentUsers.map((entry) => (
                <option key={entry.userId} value={entry.userId}>
                  {entry.username}
                </option>
              ))}
            </select>
            <span
              className="kozmos-tap"
              style={{ opacity: hushLoading ? 0.4 : 0.72, cursor: "pointer" }}
              onClick={() => {
                if (!selectedHushCreateUser || hushLoading) return;
                void createHushWith(
                  selectedHushCreateUser.userId,
                  selectedHushCreateUser.username
                );
              }}
            >
              {hushLoading ? "..." : "create"}
            </span>
          </div>
        ) : (
          <div style={{ opacity: 0.4, fontSize: 11 }}>
            no present users available
          </div>
        )}
      </div>

        {hushInviteTarget && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ opacity: 0.5, marginBottom: 4 }}>
              {hushInviteTarget.chatId ? "invite to hush" : "invite"}
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 6,
              }}
            >
              <span>{hushInviteTarget.username}</span>
              <span
                className="kozmos-tap"
                style={{ cursor: "pointer", opacity: 0.7 }}
                onClick={() => {
                  if (hushInviteTarget.chatId) {
                    inviteToHushChat(
                      hushInviteTarget.chatId,
                      hushInviteTarget.userId,
                      hushInviteTarget.username
                    );
                  } else {
                    createHushWith(
                      hushInviteTarget.userId,
                      hushInviteTarget.username
                    );
                  }
                }}
              >
                {hushLoading ? "..." : "send"}
              </span>
            </div>
          <div
            className="kozmos-tap"
            style={{ opacity: 0.4, cursor: "pointer" }}
            onClick={() => setHushInviteTarget(null)}
          >
            cancel
          </div>
          </div>
        )}

        {invitesForMe.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ opacity: 0.5, marginBottom: 4 }}>invites</div>
            {invitesForMe.map((invite) => (
              <div
                key={invite.chat_id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 6,
                }}
              >
                <span>{getHushChatLabel(invite.chat_id)}</span>
                <span
                  className="kozmos-tap"
                  style={{ cursor: "pointer", opacity: 0.7, marginLeft: 8 }}
                  onClick={() => acceptHushInvite(invite.chat_id)}
                >
                  accept
                </span>
                <span
                  className="kozmos-tap"
                  style={{ cursor: "pointer", opacity: 0.4, marginLeft: 6 }}
                  onClick={() => declineHushInvite(invite.chat_id)}
                >
                  decline
                </span>
              </div>
            ))}
          </div>
        )}

        {requestsForMe.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ opacity: 0.5, marginBottom: 4 }}>requests</div>
            {requestsForMe.map((request) => (
              <div
                key={`${request.chat_id}-${request.user_id}`}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 6,
                }}
              >
                <span>{`request by ${getHushUserName(request.user_id)}?`}</span>
                <span
                  className="kozmos-tap"
                  style={{ cursor: "pointer", opacity: 0.7, marginLeft: 8 }}
                  onClick={() =>
                    acceptHushRequest(request.chat_id, request.user_id)
                  }
                >
                  yes
                </span>
                <span
                  className="kozmos-tap"
                  style={{ cursor: "pointer", opacity: 0.4, marginLeft: 6 }}
                  onClick={() =>
                    declineHushRequest(request.chat_id, request.user_id)
                  }
                >
                  no
                </span>
              </div>
            ))}
          </div>
        )}

        <div style={{ opacity: 0.5, marginBottom: 6 }}>active hushes</div>
        <div style={{ marginBottom: 12 }}>
          {hushChats.map((chat) => {
            const myMember = getMyHushMembership(chat.id);
            const isSelected = selectedHushChatId === chat.id;
            const canRequest = canRequestHush(chat.id);

            return (
              <div
                key={chat.id}
                style={{
                  marginBottom: 10,
                  cursor: "pointer",
                  opacity: isSelected ? 0.9 : 0.6,
                  paddingBottom: 8,
                  borderBottom: "1px solid rgba(255,255,255,0.06)",
                }}
                onClick={() => {
                  if (selectedHushChatId === chat.id) return;
                  setSelectedHushChatId(chat.id);
                  void loadHushMessages(chat.id);
                }}
                onMouseEnter={() => setHoveredHushChatId(chat.id)}
                onMouseLeave={() => setHoveredHushChatId(null)}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <span>{getHushChatLabel(chat.id)}</span>
                  {hoveredHushChatId === chat.id && canRequest && (
                    <span
                      className="kozmos-tap"
                      style={{ opacity: 0.6, cursor: "pointer" }}
                      onClick={(e) => {
                        e.stopPropagation();
                        requestHushJoin(chat.id);
                      }}
                    >
                      {requestingChatId === chat.id ? "..." : "request"}
                    </span>
                  )}
                </div>
                {myMember?.status === "invited" && (
                  <div style={{ fontSize: 11, opacity: 0.4 }}>invited</div>
                )}
                {myMember?.status === "requested" && (
                  <div style={{ fontSize: 11, opacity: 0.4 }}>requested</div>
                )}
              </div>
            );
          })}
        </div>

        {selectedHushChatId && (
          <div
            style={{
              borderTop: "1px solid rgba(255,255,255,0.08)",
              paddingTop: 12,
            }}
          >
            <div style={{ opacity: 0.5, marginBottom: 6 }}>hush chat</div>

            <div style={{ fontSize: 11, opacity: 0.5, marginBottom: 8 }}>
              {getHushChatLabel(selectedHushChatId)}
            </div>

            <div style={{ marginBottom: 8 }}>
              {selectedHushMembers.map((member) => (
                <div
                  key={member.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 4,
                  }}
                >
                  <span style={{ opacity: 0.6 }}>
                    {getHushUserName(member.user_id)}
                  </span>
                  <span
                    className={isSelectedHushOwner ? "kozmos-tap" : undefined}
                    style={{
                      opacity: 0.4,
                      fontSize: 11,
                      cursor:
                        isSelectedHushOwner &&
                        member.user_id !== userId &&
                        member.status === "accepted"
                          ? "pointer"
                          : "default",
                    }}
                    onMouseEnter={() => setHoveredHushMemberId(member.id)}
                    onMouseLeave={() => setHoveredHushMemberId(null)}
                    onClick={() => {
                      if (!isSelectedHushOwner) return;
                      if (member.user_id === userId) return;
                      if (member.status !== "accepted") return;
                      removeHushMember(selectedHushChatId!, member.user_id);
                    }}
                  >
                    {isSelectedHushOwner &&
                    member.user_id !== userId &&
                    member.status === "accepted" &&
                    hoveredHushMemberId === member.id
                      ? "remove"
                      : member.status}
                  </span>
                </div>
              ))}
            </div>

            {isSelectedHushOwner && (
              <div
                style={{
                  marginBottom: 10,
                  paddingBottom: 10,
                  borderBottom: "1px solid rgba(255,255,255,0.08)",
                }}
              >
                <div style={{ opacity: 0.5, marginBottom: 6, fontSize: 11 }}>
                  invite present user
                </div>
                {selectedHushInviteUser ? (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <select
                      value={selectedHushInviteUser.userId}
                      onChange={(e) => setHushInviteUserId(e.target.value)}
                      style={{
                        flex: 1,
                        background: "rgba(255,255,255,0.03)",
                        border: "1px solid rgba(255,255,255,0.18)",
                        color: "#eaeaea",
                        fontSize: 12,
                        padding: "6px 8px",
                        outline: "none",
                      }}
                    >
                      {hushInvitablePresentUsers.map((entry) => (
                        <option key={entry.userId} value={entry.userId}>
                          {entry.username}
                        </option>
                      ))}
                    </select>
                    <span
                      className="kozmos-tap"
                      style={{ opacity: hushLoading ? 0.4 : 0.72, cursor: "pointer" }}
                      onClick={() => {
                        if (!selectedHushChatId || !selectedHushInviteUser || hushLoading) {
                          return;
                        }
                        void inviteToHushChat(
                          selectedHushChatId,
                          selectedHushInviteUser.userId,
                          selectedHushInviteUser.username
                        );
                      }}
                    >
                      {hushLoading ? "..." : "invite"}
                    </span>
                  </div>
                ) : (
                  <div style={{ opacity: 0.4, fontSize: 11 }}>
                    no present users available
                  </div>
                )}
              </div>
            )}

            {canChatInSelectedHush ? (
              <>
                <div
                  style={{
                    maxHeight: 160,
                    overflowY: "auto",
                    marginBottom: 8,
                  }}
                >
                  {selectedChatMessages.map((msg) => (
                    <div key={msg.id} style={{ marginBottom: 6 }}>
                      <span style={{ opacity: 0.6 }}>
                        {getHushUserName(msg.user_id)}:
                      </span>{" "}
                      <span className="selectable-text">{msg.content}</span>
                    </div>
                  ))}
                </div>

                <input
                  className="kozmos-text-input"
                  value={hushInput}
                  onChange={(e) => setHushInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      sendHushMessage();
                    }
                  }}
                  placeholder="hush message..."
                  style={{
                    width: "100%",
                    background: "transparent",
                    border: "none",
                    borderBottom: "1px solid rgba(255,255,255,0.2)",
                    color: "#eaeaea",
                    fontSize: 12,
                    outline: "none",
                    paddingBottom: 6,
                    cursor: "text",
                    userSelect: "text",
                    WebkitUserSelect: "text",
                  }}
                />

                <div
                  className="kozmos-tap"
                  style={{
                    marginTop: 6,
                    fontSize: 11,
                    opacity: 0.6,
                    cursor: "pointer",
                  }}
                  onClick={sendHushMessage}
                >
                  {hushSending ? "..." : "send"}
                </div>

                <div
                  className="kozmos-tap"
                  style={{
                    marginTop: 6,
                    fontSize: 11,
                    opacity: 0.4,
                    cursor: "pointer",
                  }}
                  onClick={() => leaveHushChat(selectedHushChatId!)}
                >
                  leave
                </div>
              </>
            ) : selectedHushMembership?.status === "invited" ? (
              <div style={{ opacity: 0.5 }}>
                invite pending.{" "}
                <span
                  style={{ cursor: "pointer", opacity: 0.8 }}
                  onClick={() => acceptHushInvite(selectedHushChatId!)}
                >
                  accept
                </span>{" "}
                /{" "}
                <span
                  style={{ cursor: "pointer", opacity: 0.6 }}
                  onClick={() => declineHushInvite(selectedHushChatId!)}
                >
                  decline
                </span>
              </div>
            ) : (
              <div style={{ opacity: 0.4 }}>not inside</div>
            )}
          </div>
        )}
      </>
      )}
          </div>

          <div
            className="play-panel user-build-panel user-build-mobile"
            style={userBuildPanelStyle}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 12,
              }}
            >
              <div style={{ opacity: 0.72, letterSpacing: "0.2em" }}>
                {"user🔨build"}
              </div>
              <div
                style={{ opacity: 0.42 }}
              >
                mobile
              </div>
            </div>

            <div style={{ opacity: 0.58, marginBottom: 6 }}>
              user-built modules inside kozmos
            </div>

            <div style={{ opacity: 0.46, fontSize: 11 }}>
              not available for mobile use
            </div>
          </div>

          <div
            className="play-panel news-paper-panel news-paper-mobile"
            style={newsPaperPanelMobileStyle}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 12,
              }}
            >
              <div style={{ opacity: 0.8, letterSpacing: "0.2em" }}>
                {"news📰paper"}
              </div>
              <div style={{ opacity: 0.5 }}>soon</div>
            </div>

            <div style={{ opacity: 0.62, marginBottom: 6 }}>bright pulses from kozmos</div>

            <div style={{ opacity: 0.52, fontSize: 11 }}>
              headlines will appear here
            </div>
          </div>

          <div className="hush-panel space-tv-panel" style={spaceTvPanelStyle}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 12,
              }}
            >
              <div style={{ opacity: 0.74, letterSpacing: "0.2em" }}>
                {"space📺TV"}
              </div>
              <div style={{ opacity: 0.42 }}>soon</div>
            </div>

            <div style={{ opacity: 0.58, marginBottom: 6 }}>
              ambient streams for shared presence
            </div>

            <div style={{ opacity: 0.48, fontSize: 11 }}>
              channels arriving quietly
            </div>
          </div>

          <div className="hush-panel space-radio-panel" style={spaceRadioPanelStyle}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 12,
              }}
            >
              <div style={{ opacity: 0.74, letterSpacing: "0.2em" }}>
                {"space📻radio"}
              </div>
              <div style={{ opacity: 0.42 }}>soon</div>
            </div>

            <div style={{ opacity: 0.58, marginBottom: 6 }}>
              low-noise channels for shared signals
            </div>

            <div style={{ opacity: 0.48, fontSize: 11 }}>
              transmissions arriving quietly
            </div>
          </div>
        </div>

        {/* CHAT */}
        <div className="chat-panel" style={chatColumnStyle}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            marginBottom: 14,
            transform: "translateX(-18px)",
          }}
        >
          <div
            onPointerDown={onChatWheelPointerDown}
            onPointerMove={onChatWheelPointerMove}
            onPointerUp={onChatWheelPointerUp}
            onPointerCancel={onChatWheelPointerUp}
            onWheel={(e) => {
              if (Math.abs(e.deltaY) < 8 && Math.abs(e.deltaX) < 8) return;
              e.preventDefault();
              cycleChatMode(e.deltaY > 0 || e.deltaX > 0 ? 1 : -1);
            }}
            style={{
              width: "min(420px, 84vw)",
              position: "relative",
              height: 34,
              userSelect: "none",
              touchAction: "pan-y",
              cursor: "grab",
              opacity: 0.88,
              overflow: "hidden",
              perspective: "900px",
            }}
          >
            <button
              type="button"
              onClick={() =>
                selectChatMode(chatMode === "open" ? "game" : "open", 1)
              }
              onPointerDown={(e) => e.stopPropagation()}
              style={{
                position: "absolute",
                left: "50%",
                top: "50%",
                border: "none",
                background: "transparent",
                color: "rgba(234,234,234,0.42)",
                fontSize: 14,
                fontWeight: 320,
                letterSpacing: "0.12em",
                textTransform: "none",
                cursor: "pointer",
                padding: "0 6px",
                transform: `translate(-50%, -50%) translateX(${chatWheelLeftX}px) translateZ(${chatWheelLeftZ}px) rotateY(${chatWheelLeftTilt}deg) scale(${chatWheelLeftScale})`,
                transition: chatWheelTransition,
                opacity: chatWheelLeftOpacity,
                appearance: "none",
                whiteSpace: "nowrap",
                filter: `blur(${chatWheelLeftBlur}px)`,
                outline: "none",
              }}
            >
              {adjacentChatLabel}
            </button>
            <div
              style={{
                position: "absolute",
                left: "50%",
                top: "50%",
                fontSize: 20,
                letterSpacing: "0.12em",
                fontWeight: 340,
                opacity: chatWheelCenterOpacity,
                textTransform: "none",
                textAlign: "center",
                transform: `translate(-50%, -50%) translateX(${chatWheelCenterX}px) translateZ(${chatWheelCenterZ}px) rotateY(${chatWheelCenterTilt}deg) scale(${chatWheelCenterScale})`,
                transition: chatWheelTransition,
                whiteSpace: "nowrap",
                filter: `blur(${chatWheelCenterBlur}px)`,
                textShadow: "0 0 8px rgba(255,230,170,0.22)",
              }}
            >
              {activeChatLabel}
            </div>
            <button
              type="button"
              onClick={() =>
                selectChatMode(chatMode === "open" ? "game" : "open", -1)
              }
              onPointerDown={(e) => e.stopPropagation()}
              style={{
                position: "absolute",
                left: "50%",
                top: "50%",
                border: "none",
                background: "transparent",
                color: "rgba(234,234,234,0.42)",
                fontSize: 14,
                fontWeight: 320,
                letterSpacing: "0.12em",
                textTransform: "none",
                cursor: "pointer",
                padding: "0 6px",
                transform: `translate(-50%, -50%) translateX(${chatWheelRightX}px) translateZ(${chatWheelRightZ}px) rotateY(${chatWheelRightTilt}deg) scale(${chatWheelRightScale})`,
                transition: chatWheelTransition,
                opacity: chatWheelRightOpacity,
                appearance: "none",
                whiteSpace: "nowrap",
                filter: `blur(${chatWheelRightBlur}px)`,
                outline: "none",
              }}
            >
              {adjacentChatLabel}
            </button>
          </div>
          <div
            style={{
              width: "min(220px, 64%)",
              height: 1,
              marginTop: 11,
              background:
                "linear-gradient(90deg, transparent 0%, rgba(255,230,170,0.75) 50%, transparent 100%)",
              boxShadow: "0 0 8px rgba(255,230,170,0.35)",
            }}
          />
        </div>

        <div
          ref={sharedMessagesRef}
          style={sharedMessagesScrollStyle}
          onScroll={syncSharedStickToBottom}
        >
          {activeMessages.map((m) => {
            const reflectionKey = `${chatMode}:${m.id}`;
            return (
            <div
              key={`${chatMode}-${m.id}`}
              style={{
                marginBottom: 12,
                paddingBottom: 10,
                borderBottom: "1px solid rgba(255,255,255,0.14)",
                display: "flex",
                gap: 16,
                justifyContent: "space-between",
                alignItems: "flex-start",
              }}
            >
              <div style={{ flex: 1, lineHeight: 1.6 }}>
                <div>
                  <span
                    style={{
                      opacity: 0.6,
                      cursor: "default",
                    }}
                  >
                    {m.username}:
                  </span>{" "}
                  <span className="selectable-text">{m.content}</span>
                  {m.user_id === userId && (
                    <span
                      onClick={() => {
                        if (chatMode === "open") {
                          void deleteMessage(m.id);
                        } else {
                          void deleteGameMessage(m.id);
                        }
                      }}
                      style={{
                        marginLeft: 8,
                        fontSize: 11,
                        opacity: 0.4,
                        cursor: "pointer",
                      }}
                    >
                      delete
                    </span>
                  )}
                </div>

                {axyMsgReflection[reflectionKey] && (
                  <div
                    style={{
                      marginTop: 6,
                      fontSize: 13,
                      opacity: 0.75,
                      fontStyle: "italic",
                    }}
                  >
                    <span
                      style={{
                        color: "#6BFF8E",
                        letterSpacing: "0.12em",
                        marginRight: 4,
                        cursor: "pointer",
                      }}
                      onClick={() => {
                        setAxyMsgFadeId(reflectionKey);

                        setAxyMsgReflection((prev) => {
                          const copy = { ...prev };
                          delete copy[reflectionKey];
                          return copy;
                        });

                        setTimeout(() => {
                          setAxyMsgFadeId(null);
                        }, 400);
                      }}
                    >
                      Axy reflects:
                    </span>
                    {axyMsgReflection[reflectionKey]}
                  </div>
                )}
              </div>

              <Image
                src="/axy-logofav.png"
                alt="Axy"
                width={22}
                height={22}
                style={{
                  width: 22,
                  height: 22,
                  cursor: "pointer",
                  opacity: axyMsgFadeId === reflectionKey ? 0.25 : 0.6,
                  transform:
                    axyMsgPulseId === reflectionKey ? "scale(1.2)" : "scale(1)",
                  transition:
                    "opacity 0.4s ease, transform 0.3s ease, filter 0.25s ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.filter =
                    "drop-shadow(0 0 4px rgba(107,255,142,0.35))";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.filter = "none";
                }}
                onClick={() => {
                  setAxyMsgPulseId(reflectionKey);
                  askAxyOnMessage(chatMode, m.id, m.content);

                  setTimeout(() => {
                    setAxyMsgPulseId(null);
                  }, 300);
                }}
              />
            </div>
            );
          })}
        </div>

        <textarea
          className="kozmos-text-input"
          value={chatMode === "open" ? input : gameInput}
          onChange={(e) => {
            if (chatMode === "open") {
              setInput(e.target.value);
            } else {
              setGameInput(e.target.value);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (chatMode === "open") {
                if (!loading) {
                  void sendMessage();
                }
              } else if (!gameLoading) {
                void sendGameMessage();
              }
            }
          }}
          placeholder={chatMode === "open" ? "write something..." : "write game chat..."}
          style={{
            width: "100%",
            minHeight: 80,
            background: "transparent",
            border: "1px solid rgba(255,255,255,0.2)",
            color: "#eaeaea",
            padding: 16,
            resize: "none",
            outline: "none",
            fontSize: 14,
            cursor: "text",
            userSelect: "text",
            WebkitUserSelect: "text",
          }}
        />

        <div
          style={{
            marginTop: 12,
            fontSize: 12,
            letterSpacing: "0.12em",
            opacity: 0.6,
            cursor: "pointer",
          }}
          onClick={() => {
            if (chatMode === "open") {
              void sendMessage();
            } else {
              void sendGameMessage();
            }
          }}
        >
          {chatMode === "open"
            ? loading
              ? "sending..."
              : "send"
            : gameLoading
              ? "sending..."
              : "send"}
        </div>

        <div
          style={{
            marginTop: 22,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
          }}
        >
          <div
            style={{
              fontSize: 13,
              letterSpacing: "0.12em",
              opacity: 0.55,
              textAlign: "center",
            }}
          >
            present users
          </div>
          <div
            style={{
              width: "min(180px, 54%)",
              height: 1,
              marginTop: 8,
              background:
                "linear-gradient(90deg, transparent 0%, rgba(255,230,170,0.75) 50%, transparent 100%)",
              boxShadow: "0 0 8px rgba(255,230,170,0.32)",
            }}
          />

          <div
            ref={presentUsersPanelRef}
            style={{
              marginTop: 10,
              minHeight: 42,
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.14)",
              background: "rgba(255,255,255,0.03)",
              padding: "8px 10px",
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              alignItems: "center",
            }}
          >
            {presentUsers.length === 0 ? (
              <span style={{ fontSize: 11, opacity: 0.4 }}>nobody visible</span>
            ) : (
              presentUsers.map((name) => {
                const normalizedName = name.trim().toLowerCase();
                const isSelf = normalizedName === currentUsername.toLowerCase();
                const avatarUrl =
                  presentUserAvatars[normalizedName] ??
                  (isSelf ? selfAvatarUrl : null);
                const isOpen = presentUserOpen === name;
                const isHoveringAvatar = presentUserHover === name;
                const showTouchPrompt = touchPromptUser === name && !isSelf;
                const alreadyInTouch = inTouchByName[normalizedName] === true;
                return (
                  <div
                    key={`present-${name}`}
                    style={{ position: "relative" }}
                    onMouseLeave={() => setPresentUserHover(null)}
                  >
                    <span
                      className="present-user-chip"
                      onClick={() => {
                        setPresentUserGlow(name);
                        setPresentUserOpen((prev) => (prev === name ? null : name));
                        setTimeout(() => {
                          setPresentUserGlow((prev) => (prev === name ? null : prev));
                        }, 220);
                      }}
                      style={{
                        fontSize: 11,
                        opacity: 0.72,
                        border: "1px solid rgba(255,255,255,0.14)",
                        borderRadius: 999,
                        padding: "2px 8px",
                        cursor: "pointer",
                        userSelect: "none",
                        textShadow:
                          presentUserGlow === name
                            ? "0 0 6px rgba(255,255,255,0.95), 0 0 14px rgba(255,255,255,0.45)"
                            : "none",
                      }}
                    >
                      {name}
                    </span>

                    {isOpen ? (
                      <div
                        style={{
                          position: "absolute",
                          left: "50%",
                          bottom: "calc(100% + 8px)",
                          transform: "translateX(-50%)",
                          width: 78,
                          height: 78,
                          borderRadius: "50%",
                          border: "1px solid rgba(255,255,255,0.28)",
                          background: "rgba(11,11,11,0.95)",
                          overflow: "hidden",
                          boxShadow:
                            "0 0 12px rgba(255,255,255,0.28), 0 0 24px rgba(255,255,255,0.14)",
                          zIndex: 24,
                          display: "grid",
                          placeItems: "center",
                        }}
                        onMouseEnter={() => setPresentUserHover(name)}
                        onMouseLeave={() => setPresentUserHover(null)}
                        onClick={() => {
                          if (!isSelf) {
                            setTouchPromptUser(name);
                          }
                        }}
                      >
                        {avatarUrl ? (
                          <img
                            src={avatarUrl}
                            alt={`${name} avatar`}
                            style={{
                              width: "100%",
                              height: "100%",
                              objectFit: "cover",
                              display: "block",
                            }}
                          />
                        ) : (
                          <span style={{ fontSize: 20, opacity: 0.72 }}>
                            {(name[0] ?? "?").toUpperCase()}
                          </span>
                        )}

                        {!isSelf ? (
                          <div
                            style={{
                              position: "absolute",
                              inset: 0,
                              borderRadius: "50%",
                              display: "grid",
                              placeItems: "center",
                              background: isHoveringAvatar
                                ? "rgba(0,0,0,0.36)"
                                : "rgba(0,0,0,0)",
                              opacity: isHoveringAvatar ? 1 : 0,
                              transition:
                                "opacity 0.16s ease, background 0.16s ease",
                              cursor: "pointer",
                            }}
                          >
                            <span
                              style={{
                                fontSize: 28,
                                lineHeight: 1,
                                fontWeight: 500,
                                opacity: 0.9,
                                textShadow:
                                  "0 0 8px rgba(255,255,255,0.45), 0 0 18px rgba(255,255,255,0.28)",
                              }}
                            >
                              +
                            </span>
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    {showTouchPrompt ? (
                      <div
                        style={{
                          position: "absolute",
                          left: "50%",
                          bottom: "calc(100% + 94px)",
                          transform: "translateX(-50%)",
                          minWidth: 210,
                          maxWidth: 260,
                          padding: "10px 12px",
                          borderRadius: 10,
                          border: "1px solid rgba(255,255,255,0.18)",
                          background: "rgba(7,7,7,0.94)",
                          boxShadow:
                            "0 0 14px rgba(255,255,255,0.12), 0 0 28px rgba(255,255,255,0.08)",
                          zIndex: 28,
                        }}
                      >
                        <div
                          style={{
                            fontSize: 11,
                            opacity: 0.78,
                            marginBottom: 10,
                            textAlign: "center",
                            letterSpacing: "0.04em",
                          }}
                        >
                          {alreadyInTouch
                            ? `already in touch with ${name}`
                            : `keep in touch with ${name}?`}
                        </div>

                        <div
                          style={{
                            display: "flex",
                            justifyContent: "center",
                            gap: 10,
                          }}
                        >
                          {!alreadyInTouch ? (
                            <button
                              type="button"
                              onClick={() => {
                                void requestKeepInTouch(name);
                              }}
                              disabled={touchBusy}
                              style={{
                                border: "1px solid rgba(255,255,255,0.26)",
                                borderRadius: 999,
                                background: "transparent",
                                color: "#eaeaea",
                                fontSize: 11,
                                letterSpacing: "0.08em",
                                padding: "4px 12px",
                                cursor: touchBusy ? "default" : "pointer",
                                opacity: touchBusy ? 0.5 : 0.84,
                              }}
                            >
                              {touchBusy ? "..." : "yes"}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => setTouchPromptUser(null)}
                            style={{
                              border: "1px solid rgba(255,255,255,0.14)",
                              borderRadius: 999,
                              background: "transparent",
                              color: "#eaeaea",
                              fontSize: 11,
                              letterSpacing: "0.08em",
                              padding: "4px 12px",
                              cursor: "pointer",
                              opacity: 0.62,
                            }}
                          >
                            {alreadyInTouch ? "ok" : "no"}
                          </button>
                        </div>
                      </div>
                    ) : null}

                  </div>
                );
              })
            )}
          </div>
        </div>
        </div>

        {/* RIGHT PANELS */}
        <div className="right-panel-stack" style={rightPanelStackStyle}>
          {/* PLAY PANEL */}
          <div
            className="play-panel"
            style={{
              ...playPanelStyle,
              minHeight: playOpen ? undefined : playClosedHeight ?? undefined,
            }}
          >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 12,
            }}
          >
            <div style={{ opacity: 0.6, letterSpacing: "0.2em" }}>
              {"kozmos\u00b7play"}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ opacity: 0.35 }}>beta</span>
              <span
                className="kozmos-tap"
                style={{ opacity: 0.58, cursor: "pointer" }}
                onClick={(e) => {
                  e.stopPropagation();
                  togglePlayPanel();
                }}
              >
                {playOpen ? "close" : "open"}
              </span>
            </div>
          </div>

          <div style={{ opacity: 0.5, marginBottom: 6 }}>
            quiet games inside kozmos
          </div>

            {playOpen && (
              <>
              <div style={{ marginBottom: 10 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 6,
                  }}
                >
                  <span>signal drift</span>
                  <span
                    className="kozmos-tap"
                    style={{ opacity: 0.6, cursor: "pointer" }}
                    onClick={(e) => {
                      e.stopPropagation();
                      openPlay("signal-drift");
                    }}
                  >
                    enter
                  </span>
                </div>

                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 6,
                  }}
                >
                  <span>slow orbit</span>
                  <span
                    className="kozmos-tap"
                    style={{ opacity: 0.6, cursor: "pointer" }}
                    onClick={(e) => {
                      e.stopPropagation();
                      openPlay("slow-orbit");
                    }}
                  >
                    enter
                  </span>
                </div>

                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 6,
                  }}
                >
                  <span>Quite Swarm</span>
                  <span
                    className="kozmos-tap"
                    style={{ opacity: 0.6, cursor: "pointer" }}
                    onClick={(e) => {
                      e.stopPropagation();
                      openPlay(QUITE_SWARM_MODE);
                    }}
                  >
                    enter
                  </span>
                </div>

                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <span>hush puzzle</span>
                  <span
                    className="kozmos-tap"
                    style={{ opacity: 0.6, cursor: "pointer" }}
                    onClick={(e) => {
                      e.stopPropagation();
                      openPlay("hush-puzzle");
                    }}
                  >
                    enter
                  </span>
                </div>
              </div>

              {activePlay === "signal-drift" && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    marginTop: 12,
                    border: "1px solid rgba(102, 2, 60, 0.32)",
                    borderRadius: 10,
                    padding: 10,
                    background: "rgba(12, 8, 18, 0.72)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: 8,
                      fontSize: 11,
                    }}
                  >
                    <span>signal drift: catch the pulse</span>
                    <span style={{ opacity: 0.7 }}>
                      score {driftScore} · {driftTimeLeft}s
                    </span>
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(4, 1fr)",
                      gap: 6,
                      marginBottom: 10,
                    }}
                  >
                    {Array.from({ length: 16 }, (_, idx) => {
                      const isTarget = idx === driftCell;
                      const isFlash = idx === driftFlashCell;
                      return (
                        <button
                          key={`drift-${idx}`}
                          onClick={() => tapDriftCell(idx)}
                          style={{
                            height: 30,
                            borderRadius: 6,
                            border: "1px solid rgba(255,255,255,0.16)",
                            background: isTarget
                              ? "rgba(255,120,210,0.28)"
                              : "rgba(255,255,255,0.04)",
                            boxShadow: isFlash
                              ? "0 0 14px rgba(255, 120, 210, 0.7)"
                              : isTarget
                                ? "0 0 8px rgba(255, 120, 210, 0.32)"
                                : "none",
                            cursor: driftRunning ? "pointer" : "default",
                            transition: "all 0.16s ease",
                            color: "rgba(255,255,255,0.75)",
                            fontSize: 11,
                          }}
                        >
                          {isTarget ? "•" : ""}
                        </button>
                      );
                    })}
                  </div>

                  <div
                    style={{
                      display: "flex",
                      gap: 10,
                      fontSize: 11,
                      opacity: 0.8,
                    }}
                  >
                    <span
                      className="kozmos-tap"
                      style={{ cursor: "pointer" }}
                      onClick={startSignalDrift}
                    >
                      {driftRunning ? "restart" : "start"}
                    </span>
                    <span
                      className="kozmos-tap"
                      style={{ cursor: "pointer" }}
                      onClick={() => {
                        setDriftRunning(false);
                        setDriftScore(0);
                        setDriftTimeLeft(25);
                        setDriftFlashCell(null);
                      }}
                    >
                      reset
                    </span>
                  </div>
                </div>
              )}

              {activePlay === "slow-orbit" && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    marginTop: 12,
                    border: "1px solid rgba(102, 2, 60, 0.32)",
                    borderRadius: 10,
                    padding: 10,
                    background: "rgba(12, 8, 18, 0.72)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: 8,
                      fontSize: 11,
                    }}
                  >
                    <span>slow orbit: sync at the pulse</span>
                    <span style={{ opacity: 0.7 }}>
                      score {orbitScore} · {orbitTimeLeft}s
                    </span>
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(6, 1fr)",
                      gap: 6,
                      marginBottom: 10,
                    }}
                  >
                    {Array.from({ length: ORBIT_TRACK_SIZE }, (_, idx) => {
                      const isTarget = idx === orbitTarget;
                      const isCursor = idx === orbitPosition;
                      return (
                        <div
                          key={`orbit-${idx}`}
                          style={{
                            height: 22,
                            borderRadius: 999,
                            border: "1px solid rgba(255,255,255,0.14)",
                            background: isTarget
                              ? "rgba(255,120,210,0.18)"
                              : "rgba(255,255,255,0.03)",
                            boxShadow: isCursor
                              ? orbitPulse
                                ? "0 0 16px rgba(255, 120, 210, 0.82)"
                                : "0 0 8px rgba(255,255,255,0.25)"
                              : "none",
                            transform: isCursor ? "scale(1.06)" : "scale(1)",
                            transition: "all 0.14s ease",
                          }}
                        />
                      );
                    })}
                  </div>

                  <div
                    style={{
                      display: "flex",
                      gap: 10,
                      fontSize: 11,
                      opacity: 0.82,
                    }}
                  >
                    <span
                      className="kozmos-tap"
                      style={{ cursor: "pointer" }}
                      onClick={startSlowOrbit}
                    >
                      {orbitRunning ? "restart" : "start"}
                    </span>
                    <span
                      className="kozmos-tap"
                      style={{ cursor: orbitRunning ? "pointer" : "default" }}
                      onClick={syncSlowOrbit}
                    >
                      sync
                    </span>
                    <span
                      className="kozmos-tap"
                      style={{ cursor: "pointer" }}
                      onClick={() => {
                        setOrbitRunning(false);
                        setOrbitScore(0);
                        setOrbitTimeLeft(22);
                        setOrbitPosition(0);
                      }}
                    >
                      reset
                    </span>
                  </div>
                </div>
              )}

              {activePlay === QUITE_SWARM_MODE && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    marginTop: 12,
                    border: "1px solid rgba(116,186,255,0.36)",
                    borderRadius: 10,
                    padding: 10,
                    background: "rgba(7, 14, 28, 0.8)",
                    boxShadow:
                      "0 0 18px rgba(84,160,255,0.2), inset 0 0 10px rgba(110,184,255,0.12)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: 8,
                      fontSize: 11,
                    }}
                  >
                    <span>Axy mod: survive the quiet swarm</span>
                    <span style={{ opacity: 0.74 }}>
                      wave {vsSession.wave} · {Math.ceil(vsSession.timeLeft)}s
                    </span>
                  </div>

                  <div style={{ marginBottom: 8, fontSize: 10, opacity: 0.68 }}>
                    present users can join before start
                  </div>
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 6,
                      marginBottom: 10,
                    }}
                  >
                    {vsJoinableUsers.length === 0 ? (
                      <span style={{ fontSize: 10, opacity: 0.48 }}>nobody visible</span>
                    ) : (
                      vsJoinableUsers.map((name) => {
                        const key = name.toLowerCase();
                        const isSelf = key === currentUsername.toLowerCase();
                        const selected = vsSelectedUsers.some(
                          (item) => item.toLowerCase() === key
                        );
                        return (
                          <button
                            key={`vs-user-${name}`}
                            onClick={() => toggleVsParticipant(name)}
                            disabled={isSelf || vsSession.running}
                            style={{
                              border: selected
                                ? "1px solid rgba(136,201,255,0.9)"
                                : "1px solid rgba(255,255,255,0.18)",
                              borderRadius: 999,
                              background: selected
                                ? "rgba(110,182,255,0.24)"
                                : "rgba(255,255,255,0.03)",
                              color: "#eaf4ff",
                              padding: "3px 8px",
                              fontSize: 10,
                              opacity: isSelf ? 0.86 : 0.74,
                              cursor:
                                isSelf || vsSession.running ? "default" : "pointer",
                            }}
                          >
                            {isSelf ? `${name} (you)` : selected ? `✓ ${name}` : name}
                          </button>
                        );
                      })
                    )}
                  </div>

                  <div
                    style={{
                      position: "relative",
                      height: 184,
                      borderRadius: 8,
                      border: "1px solid rgba(255,255,255,0.14)",
                      background:
                        "radial-gradient(circle at 50% 40%, rgba(24,49,86,0.42), rgba(6,10,18,0.86) 72%)",
                      overflow: "hidden",
                      marginBottom: 10,
                    }}
                  >
                    <div
                      style={{
                        position: "absolute",
                        inset: 0,
                        backgroundImage:
                          "linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px)",
                        backgroundSize: "20px 20px",
                        opacity: 0.38,
                      }}
                    />
                    {vsSession.enemies.map((enemy) => {
                      const x = ((enemy.x + VS_ARENA_LIMIT) / (VS_ARENA_LIMIT * 2)) * 100;
                      const y = ((enemy.y + VS_ARENA_LIMIT) / (VS_ARENA_LIMIT * 2)) * 100;
                      return (
                        <div
                          key={enemy.id}
                          style={{
                            position: "absolute",
                            left: `${x}%`,
                            top: `${y}%`,
                            width: 9,
                            height: 9,
                            transform: "translate(-50%, -50%)",
                            borderRadius: "999px",
                            background: "rgba(255,116,128,0.92)",
                            boxShadow: "0 0 8px rgba(255,116,128,0.6)",
                          }}
                        />
                      );
                    })}
                    {vsSession.projectiles.map((projectile) => {
                      const x = ((projectile.x + VS_ARENA_LIMIT) / (VS_ARENA_LIMIT * 2)) * 100;
                      const y = ((projectile.y + VS_ARENA_LIMIT) / (VS_ARENA_LIMIT * 2)) * 100;
                      return (
                        <div
                          key={projectile.id}
                          style={{
                            position: "absolute",
                            left: `${x}%`,
                            top: `${y}%`,
                            width: 4,
                            height: 4,
                            transform: "translate(-50%, -50%)",
                            borderRadius: "999px",
                            background: "rgba(174,224,255,0.96)",
                            boxShadow: "0 0 8px rgba(168,223,255,0.8)",
                          }}
                        />
                      );
                    })}
                    {vsSession.players.map((player) => {
                      const x = ((player.x + VS_ARENA_LIMIT) / (VS_ARENA_LIMIT * 2)) * 100;
                      const y = ((player.y + VS_ARENA_LIMIT) / (VS_ARENA_LIMIT * 2)) * 100;
                      return (
                        <div key={player.id}>
                          <div
                            style={{
                              position: "absolute",
                              left: `${x}%`,
                              top: `${y}%`,
                              width: player.alive ? 12 : 10,
                              height: player.alive ? 12 : 10,
                              transform: "translate(-50%, -50%)",
                              borderRadius: "999px",
                              border: "1px solid rgba(255,255,255,0.46)",
                              background: player.alive
                                ? player.color
                                : "rgba(160,170,184,0.36)",
                              boxShadow: player.alive
                                ? `0 0 9px ${player.color}`
                                : "none",
                              opacity: player.alive ? 1 : 0.64,
                            }}
                          />
                          <div
                            style={{
                              position: "absolute",
                              left: `${x}%`,
                              top: `calc(${y}% - 10px)`,
                              transform: "translate(-50%, -100%)",
                              fontSize: 9,
                              opacity: 0.8,
                              whiteSpace: "nowrap",
                              textShadow: "0 0 6px rgba(0,0,0,0.8)",
                            }}
                          >
                            {player.name}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div style={{ fontSize: 10, opacity: 0.7, marginBottom: 8 }}>
                    {vsSession.moderatorLine}
                  </div>
                  <div style={{ fontSize: 10, opacity: 0.62, marginBottom: 8 }}>
                    control: WASD or Arrow keys (you)
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gap: 4,
                      marginBottom: 8,
                    }}
                  >
                    {[...vsSession.players]
                      .sort((a, b) => b.kills - a.kills)
                      .map((player) => (
                        <div
                          key={`score-${player.id}`}
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            fontSize: 10,
                            opacity: player.alive ? 0.86 : 0.5,
                          }}
                        >
                          <span>{player.name}</span>
                          <span>
                            {player.kills} kill · {Math.ceil(player.hp)} hp
                          </span>
                        </div>
                      ))}
                  </div>

                  <div
                    style={{
                      display: "flex",
                      gap: 10,
                      fontSize: 11,
                      opacity: 0.84,
                    }}
                  >
                    <span
                      className="kozmos-tap"
                      style={{ cursor: "pointer" }}
                      onClick={startAxyVampire}
                    >
                      {vsSession.running ? "restart" : "start"}
                    </span>
                    <span
                      className="kozmos-tap"
                      style={{ cursor: "pointer" }}
                      onClick={stopAxyVampire}
                    >
                      stop
                    </span>
                    <span style={{ opacity: 0.6 }}>
                      joined {vsSelectedUsers.length}
                    </span>
                  </div>
                </div>
              )}

              {activePlay === "hush-puzzle" && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    marginTop: 12,
                    border: "1px solid rgba(102, 2, 60, 0.32)",
                    borderRadius: 10,
                    padding: 10,
                    background: "rgba(12, 8, 18, 0.72)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: 8,
                      fontSize: 11,
                    }}
                  >
                    <span>hush puzzle: align the quiet pattern</span>
                    <span style={{ opacity: 0.7 }}>
                      {puzzleSolved ? `solved in ${puzzleMoves}` : `moves ${puzzleMoves}`}
                    </span>
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(3, 1fr)",
                      gap: 7,
                      marginBottom: 10,
                    }}
                  >
                    {Array.from({ length: 9 }, (_, idx) => (
                      <button
                        key={`puzzle-${idx}`}
                        onClick={() => tapPuzzleCell(idx)}
                        style={{
                          height: 36,
                          borderRadius: 8,
                          border: "1px solid rgba(255,255,255,0.16)",
                          background: puzzleBoard[idx]
                            ? "rgba(255, 206, 120, 0.24)"
                            : "rgba(255,255,255,0.04)",
                          boxShadow: puzzleGoal[idx]
                            ? "inset 0 0 0 1px rgba(255, 120, 210, 0.36)"
                            : "none",
                          cursor: puzzleSolved ? "default" : "pointer",
                          transition: "all 0.16s ease",
                        }}
                      />
                    ))}
                  </div>

                  <div
                    style={{
                      display: "flex",
                      gap: 10,
                      fontSize: 11,
                      opacity: 0.82,
                    }}
                  >
                    <span
                      className="kozmos-tap"
                      style={{ cursor: "pointer" }}
                      onClick={resetHushPuzzle}
                    >
                      new
                    </span>
                    <span
                      className="kozmos-tap"
                      style={{ cursor: "pointer" }}
                      onClick={() => {
                        setPuzzleBoard([...puzzleGoal]);
                        setPuzzleSolved(true);
                      }}
                    >
                      reveal
                    </span>
                  </div>
                </div>
              )}

                <div style={{ opacity: 0.35, fontSize: 11 }}>
                  more arriving soon
                </div>
              </>
            )}
          </div>

          <div
            className="play-panel user-build-panel user-build-desktop"
            style={userBuildPanelStyle}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 12,
              }}
            >
              <div style={{ opacity: 0.72, letterSpacing: "0.2em" }}>
                {"user🔨build"}
              </div>
              <div
                className="kozmos-tap"
                style={{ opacity: 0.66, cursor: "pointer" }}
                onClick={() => router.push("/build")}
              >
                enter
              </div>
            </div>

            <div style={{ opacity: 0.58, marginBottom: 6 }}>
              user-built modules inside kozmos
            </div>

            <div style={{ opacity: 0.46, fontSize: 11 }}>open your subspace</div>
          </div>

          <div
            className="play-panel news-paper-panel news-paper-desktop"
            style={newsPaperPanelDesktopStyle}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 12,
              }}
            >
              <div style={{ opacity: 0.8, letterSpacing: "0.2em" }}>
                {"news📰paper"}
              </div>
              <div style={{ opacity: 0.52 }}>soon</div>
            </div>

            <div style={{ opacity: 0.62, marginBottom: 6 }}>bright pulses from kozmos</div>

            <div style={{ opacity: 0.52, fontSize: 11 }}>
              headlines will appear here
            </div>
          </div>
        </div>
      </div>

    </main>
  );
}

const hushPillStyle: React.CSSProperties = {
  display: "inline-block",
  marginRight: 6,
  padding: "2px 6px",
  border: "1px solid rgba(255,255,255,0.18)",
  borderRadius: 999,
  fontSize: 10,
  letterSpacing: "0.12em",
  textTransform: "lowercase",
  opacity: 0.6,
};

const hushPanelStyle: React.CSSProperties = {
  width: "100%",
  marginLeft: -32,
  padding: 12,
  fontSize: 12,
  letterSpacing: "0.04em",
  opacity: 0.9,
  borderRadius: 12,
  border: "1px solid rgba(107,255,142,0.15)",
  background:
    "linear-gradient(180deg, rgba(10,16,12,0.92), rgba(6,10,8,0.78))",
  boxShadow:
    "0 0 24px rgba(107,255,142,0.16), inset 0 0 12px rgba(107,255,142,0.08)",
  backdropFilter: "blur(6px)",
};

const mainGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(260px, 1fr) minmax(0, 680px) minmax(0, 1fr)",
  columnGap: 24,
  alignItems: "start",
  marginTop: 120,
  paddingLeft: 36,
  paddingRight: 0,
};

const chatColumnStyle: React.CSSProperties = {
  width: "100%",
};

const sharedMessagesScrollStyle: React.CSSProperties = {
  maxHeight: "clamp(360px, 45vh, 540px)",
  overflowY: "auto",
  overflowX: "hidden",
  paddingRight: 8,
  marginBottom: 12,
};

const playPanelStyle: React.CSSProperties = {
  width: "100%",
  padding: 12,
  fontSize: 12,
  letterSpacing: "0.04em",
  opacity: 0.9,
  borderRadius: 12,
  border: "1px solid rgba(102, 2, 60, 0.28)",
  background:
    "linear-gradient(180deg, rgba(20,10,24,0.92), rgba(12,6,16,0.78))",
  boxShadow:
    "0 0 24px rgba(102, 2, 60, 0.28), inset 0 0 12px rgba(102, 2, 60, 0.18)",
  backdropFilter: "blur(6px)",
};

const userBuildPanelStyle: React.CSSProperties = {
  width: "100%",
  marginTop: 88,
  padding: 12,
  fontSize: 12,
  letterSpacing: "0.04em",
  opacity: 0.9,
  borderRadius: 12,
  border: "1px solid rgba(255, 230, 170, 0.36)",
  background:
    "linear-gradient(180deg, rgba(32,24,14,0.9), rgba(18,14,9,0.78))",
  boxShadow:
    "0 0 24px rgba(255, 230, 170, 0.24), inset 0 0 12px rgba(255, 230, 170, 0.14)",
  backdropFilter: "blur(6px)",
};

const newsPaperPanelBaseStyle: React.CSSProperties = {
  width: "100%",
  padding: 12,
  fontSize: 12,
  letterSpacing: "0.04em",
  opacity: 0.94,
  borderRadius: 12,
  border: "1px solid rgba(94, 176, 255, 0.52)",
  background:
    "linear-gradient(180deg, rgba(12,28,46,0.92), rgba(7,16,30,0.8))",
  boxShadow:
    "0 0 24px rgba(94, 176, 255, 0.34), inset 0 0 12px rgba(118, 194, 255, 0.22)",
  backdropFilter: "blur(6px)",
};

const newsPaperPanelMobileStyle: React.CSSProperties = {
  ...newsPaperPanelBaseStyle,
  marginTop: 20,
};

const newsPaperPanelDesktopStyle: React.CSSProperties = {
  ...newsPaperPanelBaseStyle,
  marginTop: 18,
};

const leftPanelStackStyle: React.CSSProperties = {
  width: "100%",
};

const spaceTvPanelStyle: React.CSSProperties = {
  width: "100%",
  marginLeft: -32,
  marginTop: 88,
  padding: 12,
  fontSize: 12,
  letterSpacing: "0.04em",
  opacity: 0.92,
  borderRadius: 12,
  border: "1px solid rgba(226, 232, 242, 0.38)",
  background:
    "linear-gradient(180deg, rgba(34,38,44,0.9), rgba(20,24,30,0.78))",
  boxShadow:
    "0 0 24px rgba(226, 232, 242, 0.2), inset 0 0 12px rgba(226, 232, 242, 0.12)",
  backdropFilter: "blur(6px)",
};

const spaceRadioPanelStyle: React.CSSProperties = {
  width: "100%",
  marginLeft: -32,
  marginTop: 20,
  padding: 12,
  fontSize: 12,
  letterSpacing: "0.04em",
  opacity: 0.92,
  borderRadius: 12,
  border: "1px solid rgba(255, 95, 95, 0.4)",
  background:
    "linear-gradient(180deg, rgba(44,16,16,0.9), rgba(28,10,10,0.78))",
  boxShadow:
    "0 0 24px rgba(255, 95, 95, 0.22), inset 0 0 12px rgba(255, 95, 95, 0.14)",
  backdropFilter: "blur(6px)",
};

const rightPanelStackStyle: React.CSSProperties = {
  width: "100%",
  marginRight: 16,
};


