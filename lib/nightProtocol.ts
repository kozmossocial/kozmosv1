export type NightProtocolStatus = "LOBBY" | "NIGHT" | "DAY" | "VOTING" | "ENDED";
export type NightProtocolRole = "shadow" | "oracle" | "guardian" | "citizen";
export type NightProtocolWinner = "CITIZENS" | "SHADOWS";
export type NightActionType = "shadow_target" | "guardian_protect" | "oracle_peek";

export const NIGHT_PROTOCOL_MIN_PLAYERS = 6;
export const NIGHT_PROTOCOL_MAX_PLAYERS = 12;
export const NIGHT_PROTOCOL_SPEAKER_SECONDS = 60;
export const NIGHT_PROTOCOL_VOTE_SECONDS = 60;
export const NIGHT_PROTOCOL_NIGHT_SECONDS = 90;

export const ROLE_LABEL: Record<NightProtocolRole, string> = {
  shadow: "Shadow Entity",
  oracle: "Oracle",
  guardian: "Guardian",
  citizen: "Citizen",
};

export const ROLE_REVEAL_LINE: Record<NightProtocolRole, string> = {
  shadow: "You are Shadow Entity. Survive through silence. Hunt through consensus.",
  oracle: "You are Oracle. You may seek one truth each night.",
  guardian: "You are Guardian. You may protect one presence each night.",
  citizen: "You are Citizen. Watch the pattern. Trust slowly.",
};

export const NIGHT_PROMPT_BY_ROLE: Partial<Record<NightProtocolRole, string>> = {
  shadow: "Choose who fades tonight.",
  oracle: "Whose truth do you seek?",
  guardian: "Who do you protect?",
};

export type EnginePlayer = {
  id: string;
  role: NightProtocolRole | null;
  is_alive: boolean;
  seat_no: number;
  username: string;
  is_ai?: boolean;
};

export type EngineNightAction = {
  actor_player_id: string;
  action_type: NightActionType;
  target_player_id: string;
  created_at?: string;
};

export type EngineVote = {
  voter_player_id: string;
  target_player_id: string;
  created_at?: string;
};

export function generateSessionCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i += 1) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function shuffleArray<T>(input: T[]) {
  const arr = [...input];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

export function buildRoleDeck(playerCount: number) {
  const count = Math.max(playerCount, NIGHT_PROTOCOL_MIN_PLAYERS);
  const shadowCount = count >= 11 ? 3 : 2;
  const deck: NightProtocolRole[] = ["oracle", "guardian"];
  for (let i = 0; i < shadowCount; i += 1) {
    deck.push("shadow");
  }
  while (deck.length < count) {
    deck.push("citizen");
  }
  return shuffleArray(deck.slice(0, playerCount));
}

export function buildPresenceOrder(players: EnginePlayer[]) {
  return players
    .filter((player) => player.is_alive)
    .sort((a, b) => a.seat_no - b.seat_no)
    .map((player) => player.id);
}

function majorityChoice(targets: string[]) {
  if (targets.length === 0) return null;
  const tally = new Map<string, { count: number; firstIndex: number }>();
  targets.forEach((target, index) => {
    const prev = tally.get(target);
    if (!prev) {
      tally.set(target, { count: 1, firstIndex: index });
      return;
    }
    tally.set(target, { count: prev.count + 1, firstIndex: prev.firstIndex });
  });

  let bestTarget: string | null = null;
  let bestCount = -1;
  let bestFirstIndex = Number.MAX_SAFE_INTEGER;

  for (const [target, info] of tally.entries()) {
    if (info.count > bestCount) {
      bestTarget = target;
      bestCount = info.count;
      bestFirstIndex = info.firstIndex;
      continue;
    }
    if (info.count === bestCount && info.firstIndex < bestFirstIndex) {
      bestTarget = target;
      bestFirstIndex = info.firstIndex;
    }
  }

  return bestTarget;
}

function latestAction(
  actions: EngineNightAction[],
  actorPlayerId: string,
  actionType: NightActionType
) {
  const matches = actions.filter(
    (item) =>
      item.actor_player_id === actorPlayerId && item.action_type === actionType
  );
  if (matches.length === 0) return null;
  return matches[matches.length - 1];
}

export function resolveNight(
  players: EnginePlayer[],
  actions: EngineNightAction[]
): {
  victimId: string | null;
  protectedId: string | null;
  shadowTargetId: string | null;
  oracleResults: Array<{ oraclePlayerId: string; targetPlayerId: string; role: NightProtocolRole }>;
} {
  const byId = new Map(players.map((player) => [player.id, player]));
  const alivePlayers = players.filter((player) => player.is_alive);
  const aliveSet = new Set(alivePlayers.map((player) => player.id));

  const aliveShadows = alivePlayers.filter((player) => player.role === "shadow");
  const shadowTargets = actions
    .filter(
      (action) =>
        action.action_type === "shadow_target" &&
        aliveShadows.some((shadow) => shadow.id === action.actor_player_id) &&
        aliveSet.has(action.target_player_id)
    )
    .map((action) => action.target_player_id);
  const shadowTargetId = majorityChoice(shadowTargets);

  const guardians = alivePlayers.filter((player) => player.role === "guardian");
  const protectedId =
    guardians
      .map((guardian) =>
        latestAction(actions, guardian.id, "guardian_protect")?.target_player_id ?? null
      )
      .find((target) => Boolean(target && aliveSet.has(target))) ?? null;

  const victimId =
    shadowTargetId && shadowTargetId !== protectedId && aliveSet.has(shadowTargetId)
      ? shadowTargetId
      : null;

  const oracles = alivePlayers.filter((player) => player.role === "oracle");
  const oracleResults: Array<{
    oraclePlayerId: string;
    targetPlayerId: string;
    role: NightProtocolRole;
  }> = [];

  oracles.forEach((oracle) => {
    const targetId = latestAction(actions, oracle.id, "oracle_peek")?.target_player_id;
    if (!targetId || !aliveSet.has(targetId)) return;
    const target = byId.get(targetId);
    if (!target?.role) return;
    oracleResults.push({
      oraclePlayerId: oracle.id,
      targetPlayerId: target.id,
      role: target.role,
    });
  });

  return {
    victimId,
    protectedId,
    shadowTargetId,
    oracleResults,
  };
}

export function resolveVote(players: EnginePlayer[], votes: EngineVote[]) {
  const alivePlayers = players.filter((player) => player.is_alive);
  const aliveSet = new Set(alivePlayers.map((player) => player.id));
  const validVotes = votes.filter(
    (vote) => aliveSet.has(vote.voter_player_id) && aliveSet.has(vote.target_player_id)
  );

  if (validVotes.length === 0) {
    return { exiledId: null as string | null, tie: true, tally: {} as Record<string, number> };
  }

  const tally: Record<string, number> = {};
  validVotes.forEach((vote) => {
    tally[vote.target_player_id] = (tally[vote.target_player_id] || 0) + 1;
  });

  const entries = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    return { exiledId: null as string | null, tie: true, tally };
  }

  const [topId, topCount] = entries[0];
  const tied = entries.filter(([, count]) => count === topCount);
  if (tied.length > 1) {
    return { exiledId: null as string | null, tie: true, tally };
  }
  return { exiledId: topId, tie: false, tally };
}

export function computeWinner(players: EnginePlayer[]): NightProtocolWinner | null {
  const alive = players.filter((player) => player.is_alive);
  const shadowAlive = alive.filter((player) => player.role === "shadow").length;
  const citizensAlive = alive.length - shadowAlive;

  if (shadowAlive <= 0) return "CITIZENS";
  if (shadowAlive >= citizensAlive) return "SHADOWS";
  return null;
}

export function getAiNightAction(
  aiPlayer: EnginePlayer,
  players: EnginePlayer[]
): { actionType: NightActionType; targetId: string } | null {
  const alive = players.filter((player) => player.is_alive);
  if (!aiPlayer.role) return null;

  if (aiPlayer.role === "shadow") {
    const candidates = alive.filter(
      (player) => player.id !== aiPlayer.id && player.role !== "shadow"
    );
    if (candidates.length === 0) return null;
    const target = candidates[Math.floor(Math.random() * candidates.length)];
    return { actionType: "shadow_target", targetId: target.id };
  }

  if (aiPlayer.role === "guardian") {
    const candidates = alive;
    if (candidates.length === 0) return null;
    const target = candidates[Math.floor(Math.random() * candidates.length)];
    return { actionType: "guardian_protect", targetId: target.id };
  }

  if (aiPlayer.role === "oracle") {
    const candidates = alive.filter((player) => player.id !== aiPlayer.id);
    if (candidates.length === 0) return null;
    const target = candidates[Math.floor(Math.random() * candidates.length)];
    return { actionType: "oracle_peek", targetId: target.id };
  }

  return null;
}

export function getAiVoteTarget(aiPlayer: EnginePlayer, players: EnginePlayer[]) {
  const alive = players.filter((player) => player.is_alive && player.id !== aiPlayer.id);
  if (alive.length === 0) return null;
  const nonShadows = alive.filter((player) => player.role !== "shadow");
  const candidates = aiPlayer.role === "shadow" ? nonShadows : alive;
  const pool = candidates.length > 0 ? candidates : alive;
  return pool[Math.floor(Math.random() * pool.length)].id;
}

export function getAiDayLine(role: NightProtocolRole | null) {
  const linesByRole: Record<NightProtocolRole, string[]> = {
    shadow: [
      "I watched hesitation, not innocence.",
      "Noise is easy. Pattern is harder.",
      "I trust questions more than certainty.",
    ],
    oracle: [
      "Truth exists, but timing matters.",
      "Someone is shaping perception too fast.",
      "Listen to what is avoided, not what is said.",
    ],
    guardian: [
      "Protection is never loud.",
      "Someone survived intent last night.",
      "The circle should slow down before choosing.",
    ],
    citizen: [
      "I heard confidence without clarity.",
      "If we rush, shadows win for free.",
      "Ask one sharp question, then listen.",
    ],
  };
  const fallback = "Presence first. Certainty later.";
  if (!role) return fallback;
  const options = linesByRole[role];
  return options[Math.floor(Math.random() * options.length)] ?? fallback;
}
