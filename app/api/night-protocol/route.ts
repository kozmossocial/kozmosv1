import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  NIGHT_PROTOCOL_MAX_PLAYERS,
  NIGHT_PROTOCOL_MIN_PLAYERS,
  NIGHT_PROTOCOL_NIGHT_SECONDS,
  NIGHT_PROTOCOL_SPEAKER_SECONDS,
  NIGHT_PROTOCOL_VOTE_SECONDS,
  ROLE_LABEL,
  ROLE_REVEAL_LINE,
  buildPresenceOrder,
  buildRoleDeck,
  computeWinner,
  generateSessionCode,
  getAiDayLine,
  getAiNightAction,
  getAiVoteTarget,
  resolveNight,
  resolveVote,
  type EnginePlayer,
  type NightActionType,
  type NightProtocolRole,
  type NightProtocolStatus,
  type NightProtocolWinner,
} from "@/lib/nightProtocol";
import { authenticateUser } from "./_auth";

type SessionRow = {
  id: string;
  session_code: string;
  host_user_id: string;
  status: NightProtocolStatus;
  round_no: number;
  min_players: number;
  max_players: number;
  presence_mode: boolean;
  axy_chat_bridge: boolean;
  voting_chat_mode: "closed" | "open_short";
  current_speaker_player_id: string | null;
  speaker_order: unknown;
  speaker_index: number;
  speaker_turn_ends_at: string | null;
  phase_ends_at: string | null;
  winner: NightProtocolWinner | null;
  created_at: string;
};

type PlayerRow = {
  id: string;
  session_id: string;
  user_id: string | null;
  username: string;
  is_ai: boolean;
  seat_no: number;
  role: NightProtocolRole | null;
  is_alive: boolean;
  elimination_type: "night_fade" | "exile" | null;
  revealed_role: NightProtocolRole | null;
  joined_at: string;
  eliminated_at: string | null;
};

type ActionRow = {
  id: number;
  session_id: string;
  round_no: number;
  actor_player_id: string;
  action_type: NightActionType;
  target_player_id: string;
  created_at: string;
};

type VoteRow = {
  id: number;
  session_id: string;
  round_no: number;
  voter_player_id: string;
  target_player_id: string;
  created_at: string;
};

type EventRow = {
  id: number;
  session_id: string;
  round_no: number;
  phase: string;
  scope: "public" | "private";
  target_player_id: string | null;
  event_type: string;
  content: string;
  created_at: string;
};

type DayMessageRow = {
  id: number;
  session_id: string;
  round_no: number;
  sender_player_id: string;
  username: string;
  content: string;
  created_at: string;
};

function asString(input: unknown) {
  return String(input ?? "").trim();
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function addSecondsIso(seconds: number) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function parseSpeakerOrder(raw: unknown) {
  if (!Array.isArray(raw)) return [] as string[];
  return raw.map((value) => asString(value)).filter((value) => value.length > 0);
}

async function getProfileUsername(userId: string) {
  const { data } = await supabaseAdmin
    .from("profileskozmos")
    .select("username")
    .eq("id", userId)
    .maybeSingle();

  const username = asString((data as { username?: string } | null)?.username);
  if (username) return username;
  return `user-${userId.slice(0, 6)}`;
}

async function createUniqueSessionCode() {
  for (let i = 0; i < 20; i += 1) {
    const code = generateSessionCode();
    const { data } = await supabaseAdmin
      .from("night_protocol_sessions")
      .select("id")
      .eq("session_code", code)
      .maybeSingle();
    if (!data) return code;
  }
  return `${Date.now().toString(36).toUpperCase().slice(-6)}X`;
}

async function loadSession(sessionId: string) {
  const { data, error } = await supabaseAdmin
    .from("night_protocol_sessions")
    .select(
      "id, session_code, host_user_id, status, round_no, min_players, max_players, presence_mode, axy_chat_bridge, voting_chat_mode, current_speaker_player_id, speaker_order, speaker_index, speaker_turn_ends_at, phase_ends_at, winner, created_at"
    )
    .eq("id", sessionId)
    .maybeSingle();

  if (error || !data) return null;
  return data as SessionRow;
}

async function loadPlayers(sessionId: string) {
  const { data, error } = await supabaseAdmin
    .from("night_protocol_players")
    .select(
      "id, session_id, user_id, username, is_ai, seat_no, role, is_alive, elimination_type, revealed_role, joined_at, eliminated_at"
    )
    .eq("session_id", sessionId)
    .order("seat_no", { ascending: true });

  if (error) return [] as PlayerRow[];
  return (data || []) as PlayerRow[];
}

async function loadRoundActions(sessionId: string, roundNo: number) {
  const { data, error } = await supabaseAdmin
    .from("night_protocol_night_actions")
    .select(
      "id, session_id, round_no, actor_player_id, action_type, target_player_id, created_at"
    )
    .eq("session_id", sessionId)
    .eq("round_no", roundNo)
    .order("created_at", { ascending: true });

  if (error) return [] as ActionRow[];
  return (data || []) as ActionRow[];
}

async function loadRoundVotes(sessionId: string, roundNo: number) {
  const { data, error } = await supabaseAdmin
    .from("night_protocol_votes")
    .select(
      "id, session_id, round_no, voter_player_id, target_player_id, created_at"
    )
    .eq("session_id", sessionId)
    .eq("round_no", roundNo)
    .order("created_at", { ascending: true });

  if (error) return [] as VoteRow[];
  return (data || []) as VoteRow[];
}

async function insertEvents(
  rows: Array<{
    session_id: string;
    round_no: number;
    phase: string;
    scope: "public" | "private";
    target_player_id?: string | null;
    event_type: string;
    content: string;
    payload?: Record<string, unknown>;
  }>
) {
  if (rows.length === 0) return;
  await supabaseAdmin.from("night_protocol_events").insert(
    rows.map((row) => ({
      ...row,
      target_player_id: row.target_player_id ?? null,
      payload: row.payload ?? {},
    }))
  );
}

function ensureMembership(players: PlayerRow[], userId: string) {
  return players.find((player) => player.user_id === userId) ?? null;
}

function toEnginePlayers(players: PlayerRow[]): EnginePlayer[] {
  return players.map((player) => ({
    id: player.id,
    role: player.role,
    is_alive: player.is_alive,
    seat_no: player.seat_no,
    username: player.username,
    is_ai: player.is_ai,
  }));
}

async function applyAiNightActions(
  sessionId: string,
  roundNo: number,
  players: PlayerRow[]
) {
  const enginePlayers = toEnginePlayers(players);
  const rows: Array<{
    session_id: string;
    round_no: number;
    actor_player_id: string;
    action_type: NightActionType;
    target_player_id: string;
  }> = [];

  players
    .filter((player) => player.is_ai && player.is_alive)
    .forEach((aiPlayer) => {
      const decision = getAiNightAction(
        {
          id: aiPlayer.id,
          role: aiPlayer.role,
          is_alive: aiPlayer.is_alive,
          seat_no: aiPlayer.seat_no,
          username: aiPlayer.username,
          is_ai: true,
        },
        enginePlayers
      );
      if (!decision) return;
      rows.push({
        session_id: sessionId,
        round_no: roundNo,
        actor_player_id: aiPlayer.id,
        action_type: decision.actionType,
        target_player_id: decision.targetId,
      });
    });

  if (rows.length === 0) return;

  await supabaseAdmin
    .from("night_protocol_night_actions")
    .upsert(rows, {
      onConflict: "session_id,round_no,actor_player_id,action_type",
    });
}

async function applyAiVotes(sessionId: string, roundNo: number, players: PlayerRow[]) {
  const enginePlayers = toEnginePlayers(players);
  const rows: Array<{
    session_id: string;
    round_no: number;
    voter_player_id: string;
    target_player_id: string;
  }> = [];

  players
    .filter((player) => player.is_ai && player.is_alive)
    .forEach((aiPlayer) => {
      const targetId = getAiVoteTarget(
        {
          id: aiPlayer.id,
          role: aiPlayer.role,
          is_alive: aiPlayer.is_alive,
          seat_no: aiPlayer.seat_no,
          username: aiPlayer.username,
          is_ai: true,
        },
        enginePlayers
      );
      if (!targetId) return;
      rows.push({
        session_id: sessionId,
        round_no: roundNo,
        voter_player_id: aiPlayer.id,
        target_player_id: targetId,
      });
    });

  if (rows.length === 0) return;

  await supabaseAdmin
    .from("night_protocol_votes")
    .upsert(rows, { onConflict: "session_id,round_no,voter_player_id" });
}

async function autoPostAiSpeakerMessage(
  sessionId: string,
  roundNo: number,
  speakerPlayerId: string | null,
  players: PlayerRow[]
) {
  if (!speakerPlayerId) return;
  const speaker = players.find((player) => player.id === speakerPlayerId);
  if (!speaker || !speaker.is_ai || !speaker.is_alive) return;

  const { data: existing } = await supabaseAdmin
    .from("night_protocol_day_messages")
    .select("id")
    .eq("session_id", sessionId)
    .eq("round_no", roundNo)
    .eq("sender_player_id", speakerPlayerId)
    .limit(1);

  if ((existing || []).length > 0) return;

  await supabaseAdmin.from("night_protocol_day_messages").insert({
    session_id: sessionId,
    round_no: roundNo,
    sender_player_id: speaker.id,
    username: speaker.username,
    content: getAiDayLine(speaker.role),
  });
}

function roleActionType(role: NightProtocolRole | null): NightActionType | null {
  if (role === "shadow") return "shadow_target";
  if (role === "guardian") return "guardian_protect";
  if (role === "oracle") return "oracle_peek";
  return null;
}

function roleActionAck(role: NightProtocolRole | null) {
  if (role === "shadow") return "Selection received.";
  if (role === "guardian") return "Protection set.";
  if (role === "oracle") return "Inquiry received.";
  return "Action received.";
}

function serializeStateForViewer(
  session: SessionRow,
  players: PlayerRow[],
  viewerPlayer: PlayerRow,
  events: EventRow[],
  dayMessages: DayMessageRow[],
  roundActions: ActionRow[],
  roundVotes: VoteRow[]
) {
  const visibleEvents = events.filter(
    (event) =>
      event.scope === "public" || event.target_player_id === viewerPlayer.id
  );

  const isHost = session.host_user_id === viewerPlayer.user_id;
  const myAction =
    roundActions.find((action) => action.actor_player_id === viewerPlayer.id) ?? null;
  const myVote =
    roundVotes.find((vote) => vote.voter_player_id === viewerPlayer.id) ?? null;

  const alivePlayers = players.filter((player) => player.is_alive);
  const aliveIds = new Set(alivePlayers.map((player) => player.id));

  return {
    session: {
      id: session.id,
      sessionCode: session.session_code,
      status: session.status,
      roundNo: session.round_no,
      minPlayers: session.min_players,
      maxPlayers: session.max_players,
      presenceMode: session.presence_mode,
      axyChatBridge: session.axy_chat_bridge,
      votingChatMode: session.voting_chat_mode,
      currentSpeakerPlayerId: session.current_speaker_player_id,
      speakerOrder: parseSpeakerOrder(session.speaker_order),
      speakerIndex: session.speaker_index,
      speakerTurnEndsAt: session.speaker_turn_ends_at,
      phaseEndsAt: session.phase_ends_at,
      winner: session.winner,
      hostUserId: session.host_user_id,
      createdAt: session.created_at,
    },
    me: {
      id: viewerPlayer.id,
      username: viewerPlayer.username,
      role: viewerPlayer.role,
      isAlive: viewerPlayer.is_alive,
      isHost,
      isAi: viewerPlayer.is_ai,
    },
    players: players.map((player) => {
      const canSeeRole =
        session.status === "ENDED" ||
        player.id === viewerPlayer.id ||
        Boolean(player.revealed_role);
      return {
        id: player.id,
        username: player.username,
        isAi: player.is_ai,
        seatNo: player.seat_no,
        isAlive: player.is_alive,
        eliminationType: player.elimination_type,
        roleVisible: canSeeRole ? player.revealed_role || player.role : null,
      };
    }),
    events: visibleEvents.map((event) => ({
      id: event.id,
      roundNo: event.round_no,
      phase: event.phase,
      scope: event.scope,
      eventType: event.event_type,
      content: event.content,
      createdAt: event.created_at,
    })),
    dayMessages: dayMessages.map((msg) => ({
      id: msg.id,
      roundNo: msg.round_no,
      senderPlayerId: msg.sender_player_id,
      username: msg.username,
      content: msg.content,
      createdAt: msg.created_at,
    })),
    myRoundAction: myAction
      ? {
          actionType: myAction.action_type,
          targetPlayerId: myAction.target_player_id,
        }
      : null,
    myRoundVote: myVote
      ? {
          targetPlayerId: myVote.target_player_id,
        }
      : null,
    counts: {
      totalPlayers: players.length,
      alivePlayers: alivePlayers.length,
      votesThisRound: roundVotes.filter((vote) => aliveIds.has(vote.voter_player_id)).length,
      actionsThisRound: roundActions.length,
    },
  };
}

async function fetchStateForUser(sessionId: string, userId: string) {
  const session = await loadSession(sessionId);
  if (!session) return null;
  const players = await loadPlayers(sessionId);
  const me = ensureMembership(players, userId);
  if (!me) return { forbidden: true as const };

  const [eventsResult, dayMessages, roundActions, roundVotes] = await Promise.all([
    supabaseAdmin
      .from("night_protocol_events")
      .select(
        "id, session_id, round_no, phase, scope, target_player_id, event_type, content, created_at"
      )
      .eq("session_id", sessionId)
      .order("id", { ascending: true })
      .limit(500),
    supabaseAdmin
      .from("night_protocol_day_messages")
      .select(
        "id, session_id, round_no, sender_player_id, username, content, created_at"
      )
      .eq("session_id", sessionId)
      .order("id", { ascending: true })
      .limit(500),
    loadRoundActions(sessionId, session.round_no),
    loadRoundVotes(sessionId, session.round_no),
  ]);

  const events = ((eventsResult.data || []) as EventRow[]) ?? [];

  return serializeStateForViewer(
    session,
    players,
    me,
    events,
    ((dayMessages.data || []) as DayMessageRow[]) ?? [],
    roundActions,
    roundVotes
  );
}

export async function GET(req: Request) {
  try {
    const user = await authenticateUser(req);
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const sessionId = asString(searchParams.get("sessionId"));

    if (!sessionId) {
      const [lobbiesResult, myMembershipResult] = await Promise.all([
        supabaseAdmin
          .from("night_protocol_sessions")
          .select(
            "id, session_code, host_user_id, status, round_no, min_players, max_players, presence_mode, axy_chat_bridge, voting_chat_mode, created_at"
          )
          .eq("status", "LOBBY")
          .order("created_at", { ascending: false })
          .limit(30),
        supabaseAdmin
          .from("night_protocol_players")
          .select("session_id")
          .eq("user_id", user.id),
      ]);

      const lobbyRows = (lobbiesResult.data || []) as Array<{
        id: string;
        session_code: string;
        host_user_id: string;
        status: NightProtocolStatus;
        round_no: number;
        min_players: number;
        max_players: number;
        presence_mode: boolean;
        axy_chat_bridge: boolean;
        voting_chat_mode: "closed" | "open_short";
        created_at: string;
      }>;

      const lobbyIds = lobbyRows.map((row) => row.id);
      const myJoinedSet = new Set(
        ((myMembershipResult.data || []) as Array<{ session_id: string }>).map(
          (row) => row.session_id
        )
      );

      const playerCountMap: Record<string, number> = {};
      if (lobbyIds.length > 0) {
        const { data: players } = await supabaseAdmin
          .from("night_protocol_players")
          .select("session_id")
          .in("session_id", lobbyIds);
        (players || []).forEach((row) => {
          const key = (row as { session_id: string }).session_id;
          playerCountMap[key] = (playerCountMap[key] || 0) + 1;
        });
      }

      const mySessionsResult = await supabaseAdmin
        .from("night_protocol_players")
        .select(
          "session_id, night_protocol_sessions!inner(id, session_code, host_user_id, status, round_no, min_players, max_players, presence_mode, axy_chat_bridge, voting_chat_mode, created_at)"
        )
        .eq("user_id", user.id);

      const mySessions = ((mySessionsResult.data || []) as Array<{
        session_id: string;
        night_protocol_sessions: SessionRow | SessionRow[] | null;
      }>)
        .map((row) => {
          const session = Array.isArray(row.night_protocol_sessions)
            ? row.night_protocol_sessions[0]
            : row.night_protocol_sessions;
          if (!session || session.status === "ENDED") return null;
          return {
            id: session.id,
            sessionCode: session.session_code,
            status: session.status,
            roundNo: session.round_no,
            minPlayers: session.min_players,
            maxPlayers: session.max_players,
            presenceMode: session.presence_mode,
            axyChatBridge: session.axy_chat_bridge,
            votingChatMode: session.voting_chat_mode,
            hostUserId: session.host_user_id,
            createdAt: session.created_at,
          };
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item));

      return NextResponse.json({
        lobbies: lobbyRows.map((row) => ({
          id: row.id,
          sessionCode: row.session_code,
          status: row.status,
          roundNo: row.round_no,
          minPlayers: row.min_players,
          maxPlayers: row.max_players,
          presenceMode: row.presence_mode,
          axyChatBridge: row.axy_chat_bridge,
          votingChatMode: row.voting_chat_mode,
          hostUserId: row.host_user_id,
          createdAt: row.created_at,
          playerCount: playerCountMap[row.id] || 0,
          joined: myJoinedSet.has(row.id),
        })),
        mySessions,
      });
    }

    const state = await fetchStateForUser(sessionId, user.id);
    if (!state) {
      return NextResponse.json({ error: "session not found" }, { status: 404 });
    }
    if ("forbidden" in state) {
      return NextResponse.json({ error: "not in session" }, { status: 403 });
    }
    return NextResponse.json(state);
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const user = await authenticateUser(req);
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const action = asString((body as { action?: unknown })?.action).toLowerCase();
    const sessionId = asString((body as { sessionId?: unknown })?.sessionId);

    if (action === "create_session") {
      const maxPlayers = clampNumber(
        (body as { maxPlayers?: unknown }).maxPlayers,
        NIGHT_PROTOCOL_MIN_PLAYERS,
        NIGHT_PROTOCOL_MAX_PLAYERS,
        NIGHT_PROTOCOL_MAX_PLAYERS
      );
      const presenceMode =
        typeof (body as { presenceMode?: unknown }).presenceMode === "boolean"
          ? Boolean((body as { presenceMode?: boolean }).presenceMode)
          : true;
      const axyChatBridge =
        typeof (body as { axyChatBridge?: unknown }).axyChatBridge === "boolean"
          ? Boolean((body as { axyChatBridge?: boolean }).axyChatBridge)
          : true;
      const votingChatModeRaw = asString(
        (body as { votingChatMode?: unknown }).votingChatMode
      ).toLowerCase();
      const votingChatMode: "closed" | "open_short" =
        votingChatModeRaw === "open_short" ? "open_short" : "closed";

      const sessionCode = await createUniqueSessionCode();
      const { data: session, error: sessionErr } = await supabaseAdmin
        .from("night_protocol_sessions")
        .insert({
          session_code: sessionCode,
          host_user_id: user.id,
          status: "LOBBY",
          round_no: 0,
          min_players: NIGHT_PROTOCOL_MIN_PLAYERS,
          max_players: maxPlayers,
          presence_mode: presenceMode,
          axy_chat_bridge: axyChatBridge,
          voting_chat_mode: votingChatMode,
        })
        .select(
          "id, session_code, host_user_id, status, round_no, min_players, max_players, presence_mode, axy_chat_bridge, voting_chat_mode, current_speaker_player_id, speaker_order, speaker_index, speaker_turn_ends_at, phase_ends_at, winner, created_at"
        )
        .single();

      if (sessionErr || !session) {
        return NextResponse.json({ error: "create failed" }, { status: 500 });
      }

      const username = await getProfileUsername(user.id);
      const { error: playerErr } = await supabaseAdmin
        .from("night_protocol_players")
        .insert({
          session_id: (session as SessionRow).id,
          user_id: user.id,
          username,
          is_ai: false,
          seat_no: 1,
        });

      if (playerErr) {
        return NextResponse.json({ error: "host join failed" }, { status: 500 });
      }

      await insertEvents([
        {
          session_id: (session as SessionRow).id,
          round_no: 0,
          phase: "LOBBY",
          scope: "public",
          event_type: "system",
          content: "Welcome to Night Protocol. Presence over performance.",
        },
        {
          session_id: (session as SessionRow).id,
          round_no: 0,
          phase: "LOBBY",
          scope: "public",
          event_type: "system",
          content: "Minimum players: 6. Recommended: 8-12.",
        },
        {
          session_id: (session as SessionRow).id,
          round_no: 0,
          phase: "LOBBY",
          scope: "public",
          event_type: "system",
          content: "Choose your name. Enter the Circle.",
        },
        {
          session_id: (session as SessionRow).id,
          round_no: 0,
          phase: "LOBBY",
          scope: "public",
          event_type: "lobby",
          content: `Players in the Circle: 1 / ${maxPlayers}`,
        },
      ]);

      return NextResponse.json({
        ok: true,
        sessionId: (session as SessionRow).id,
        sessionCode: (session as SessionRow).session_code,
      });
    }

    if (action === "join_session") {
      const sessionCode = asString((body as { sessionCode?: unknown }).sessionCode).toUpperCase();
      if (!sessionCode) {
        return NextResponse.json({ error: "session code required" }, { status: 400 });
      }

      const { data: found } = await supabaseAdmin
        .from("night_protocol_sessions")
        .select(
          "id, session_code, host_user_id, status, round_no, min_players, max_players, presence_mode, axy_chat_bridge, voting_chat_mode, current_speaker_player_id, speaker_order, speaker_index, speaker_turn_ends_at, phase_ends_at, winner, created_at"
        )
        .eq("session_code", sessionCode)
        .maybeSingle();

      const session = found as SessionRow | null;
      if (!session) {
        return NextResponse.json({ error: "session not found" }, { status: 404 });
      }
      if (session.status !== "LOBBY") {
        return NextResponse.json({ error: "session already started" }, { status: 400 });
      }

      const players = await loadPlayers(session.id);
      const existing = players.find((player) => player.user_id === user.id);
      if (existing) {
        return NextResponse.json({ ok: true, sessionId: session.id, sessionCode });
      }
      if (players.length >= session.max_players) {
        return NextResponse.json({ error: "circle is full" }, { status: 400 });
      }

      const username = await getProfileUsername(user.id);
      const nextSeat =
        Math.max(0, ...players.map((player) => Number(player.seat_no) || 0)) + 1;

      const { error: joinErr } = await supabaseAdmin
        .from("night_protocol_players")
        .insert({
          session_id: session.id,
          user_id: user.id,
          username,
          is_ai: false,
          seat_no: nextSeat,
        });

      if (joinErr) {
        return NextResponse.json({ error: "join failed" }, { status: 500 });
      }

      await insertEvents([
        {
          session_id: session.id,
          round_no: 0,
          phase: "LOBBY",
          scope: "public",
          event_type: "lobby",
          content: `${username} entered the Circle.`,
        },
        {
          session_id: session.id,
          round_no: 0,
          phase: "LOBBY",
          scope: "public",
          event_type: "lobby",
          content: `Players in the Circle: ${players.length + 1} / ${session.max_players}`,
        },
      ]);

      return NextResponse.json({ ok: true, sessionId: session.id, sessionCode });
    }

    if (!sessionId) {
      return NextResponse.json({ error: "session id required" }, { status: 400 });
    }

    const session = await loadSession(sessionId);
    if (!session) {
      return NextResponse.json({ error: "session not found" }, { status: 404 });
    }

    const players = await loadPlayers(sessionId);
    const me = ensureMembership(players, user.id);
    const isHost = session.host_user_id === user.id;

    if (!me && !isHost) {
      return NextResponse.json({ error: "not in session" }, { status: 403 });
    }

    if (action === "add_ai_player") {
      if (!isHost) {
        return NextResponse.json({ error: "host only" }, { status: 403 });
      }
      if (session.status !== "LOBBY") {
        return NextResponse.json({ error: "lobby only" }, { status: 400 });
      }
      if (players.length >= session.max_players) {
        return NextResponse.json({ error: "circle is full" }, { status: 400 });
      }

      const aiBaseRaw = asString((body as { aiName?: unknown }).aiName);
      const aiBase = aiBaseRaw || "Echo";
      let candidate = aiBase.slice(0, 28);
      const nameSet = new Set(players.map((player) => player.username.toLowerCase()));
      let idx = 2;
      while (nameSet.has(candidate.toLowerCase())) {
        candidate = `${aiBase.slice(0, 24)} ${idx}`;
        idx += 1;
      }

      const nextSeat =
        Math.max(0, ...players.map((player) => Number(player.seat_no) || 0)) + 1;

      const { error: aiErr } = await supabaseAdmin
        .from("night_protocol_players")
        .insert({
          session_id: sessionId,
          user_id: null,
          username: candidate,
          is_ai: true,
          seat_no: nextSeat,
        });

      if (aiErr) {
        return NextResponse.json({ error: "ai join failed" }, { status: 500 });
      }

      await insertEvents([
        {
          session_id: sessionId,
          round_no: session.round_no,
          phase: "LOBBY",
          scope: "public",
          event_type: "lobby",
          content: `${candidate} (AI) entered the Circle.`,
        },
      ]);

      return NextResponse.json({ ok: true });
    }

    if (action === "update_settings") {
      if (!isHost) {
        return NextResponse.json({ error: "host only" }, { status: 403 });
      }
      if (session.status === "ENDED") {
        return NextResponse.json({ error: "session ended" }, { status: 400 });
      }

      const updates: Record<string, unknown> = {};

      if (typeof (body as { axyChatBridge?: unknown }).axyChatBridge === "boolean") {
        updates.axy_chat_bridge = Boolean(
          (body as { axyChatBridge?: boolean }).axyChatBridge
        );
      }

      const requestedVotingMode = asString(
        (body as { votingChatMode?: unknown }).votingChatMode
      ).toLowerCase();
      if (requestedVotingMode === "closed" || requestedVotingMode === "open_short") {
        updates.voting_chat_mode = requestedVotingMode;
      }

      if (typeof (body as { presenceMode?: unknown }).presenceMode === "boolean") {
        if (session.status !== "LOBBY") {
          return NextResponse.json(
            { error: "presence mode can only be changed in lobby" },
            { status: 400 }
          );
        }
        updates.presence_mode = Boolean((body as { presenceMode?: boolean }).presenceMode);
      }

      if (Object.keys(updates).length === 0) {
        return NextResponse.json({ ok: true, unchanged: true });
      }

      const { error: updateErr } = await supabaseAdmin
        .from("night_protocol_sessions")
        .update(updates)
        .eq("id", sessionId);
      if (updateErr) {
        return NextResponse.json({ error: "settings update failed" }, { status: 500 });
      }

      await insertEvents([
        {
          session_id: sessionId,
          round_no: session.round_no,
          phase: session.status,
          scope: "public",
          event_type: "system",
          content: "Host updated session settings.",
        },
      ]);

      return NextResponse.json({ ok: true });
    }

    if (action === "start_session") {
      if (!isHost) {
        return NextResponse.json({ error: "host only" }, { status: 403 });
      }
      if (session.status !== "LOBBY") {
        return NextResponse.json({ error: "already started" }, { status: 400 });
      }
      if (players.length < session.min_players) {
        return NextResponse.json(
          { error: `minimum players: ${session.min_players}` },
          { status: 400 }
        );
      }

      const roleDeck = buildRoleDeck(players.length);
      const playersWithRoles: PlayerRow[] = players.map((player, index) => ({
        ...player,
        role: roleDeck[index],
        is_alive: true,
        revealed_role: null,
        elimination_type: null,
        eliminated_at: null,
      }));

      await Promise.all(
        playersWithRoles.map((player) =>
          supabaseAdmin
            .from("night_protocol_players")
            .update({
              role: player.role,
              is_alive: true,
              elimination_type: null,
              revealed_role: null,
              eliminated_at: null,
            })
            .eq("id", player.id)
        )
      );

      await supabaseAdmin
        .from("night_protocol_sessions")
        .update({
          status: "NIGHT",
          round_no: 1,
          current_speaker_player_id: null,
          speaker_order: [],
          speaker_index: 0,
          speaker_turn_ends_at: null,
          phase_ends_at: addSecondsIso(NIGHT_PROTOCOL_NIGHT_SECONDS),
          winner: null,
        })
        .eq("id", sessionId);

      const shadows = playersWithRoles.filter((player) => player.role === "shadow");

      const events = [
        {
          session_id: sessionId,
          round_no: 1,
          phase: "LOBBY",
          scope: "public" as const,
          event_type: "system",
          content: "The Circle is closing. Roles are being assigned.",
        },
        ...playersWithRoles.map((player) => ({
          session_id: sessionId,
          round_no: 1,
          phase: "LOBBY",
          scope: "private" as const,
          target_player_id: player.id,
          event_type: "role",
          content: ROLE_REVEAL_LINE[player.role || "citizen"],
        })),
        ...shadows.map((shadow) => ({
          session_id: sessionId,
          round_no: 1,
          phase: "LOBBY",
          scope: "private" as const,
          target_player_id: shadow.id,
          event_type: "role",
          content: `You recognize the other Shadows: ${
            shadows
              .filter((mate) => mate.id !== shadow.id)
              .map((mate) => mate.username)
              .join(", ") || "none"
          }.`,
        })),
        {
          session_id: sessionId,
          round_no: 1,
          phase: "NIGHT",
          scope: "public" as const,
          event_type: "system",
          content: "Round 1 begins.",
        },
        {
          session_id: sessionId,
          round_no: 1,
          phase: "NIGHT",
          scope: "public" as const,
          event_type: "system",
          content: "The Circle sleeps. No one speaks.",
        },
        {
          session_id: sessionId,
          round_no: 1,
          phase: "NIGHT",
          scope: "public" as const,
          event_type: "system",
          content: "Shadows awaken.",
        },
      ];

      await insertEvents(events);
      await applyAiNightActions(sessionId, 1, playersWithRoles);
      return NextResponse.json({ ok: true });
    }

    if (action === "submit_night_action") {
      if (!me) {
        return NextResponse.json({ error: "not joined" }, { status: 403 });
      }
      if (session.status !== "NIGHT") {
        return NextResponse.json({ error: "night phase required" }, { status: 400 });
      }
      if (!me.is_alive) {
        return NextResponse.json({ error: "eliminated players cannot act" }, { status: 400 });
      }

      const actionType = roleActionType(me.role);
      if (!actionType) {
        return NextResponse.json({ error: "your role has no night action" }, { status: 400 });
      }

      const targetPlayerId = asString(
        (body as { targetPlayerId?: unknown }).targetPlayerId
      );
      const target = players.find((player) => player.id === targetPlayerId && player.is_alive);
      if (!target) {
        return NextResponse.json({ error: "target is not alive" }, { status: 400 });
      }
      if (actionType === "shadow_target" && target.role === "shadow") {
        return NextResponse.json({ error: "shadows cannot target shadows" }, { status: 400 });
      }

      await supabaseAdmin
        .from("night_protocol_night_actions")
        .upsert(
          {
            session_id: sessionId,
            round_no: session.round_no,
            actor_player_id: me.id,
            action_type: actionType,
            target_player_id: target.id,
          },
          { onConflict: "session_id,round_no,actor_player_id,action_type" }
        );

      await insertEvents([
        {
          session_id: sessionId,
          round_no: session.round_no,
          phase: "NIGHT",
          scope: "private",
          target_player_id: me.id,
          event_type: "ack",
          content: roleActionAck(me.role),
        },
      ]);

      return NextResponse.json({ ok: true });
    }

    if (action === "resolve_night") {
      if (!isHost) {
        return NextResponse.json({ error: "host only" }, { status: 403 });
      }
      if (session.status !== "NIGHT") {
        return NextResponse.json({ error: "night phase required" }, { status: 400 });
      }

      const roundActions = await loadRoundActions(sessionId, session.round_no);
      const roundPlayers = await loadPlayers(sessionId);
      const resolution = resolveNight(
        toEnginePlayers(roundPlayers),
        roundActions.map((row) => ({
          actor_player_id: row.actor_player_id,
          action_type: row.action_type,
          target_player_id: row.target_player_id,
          created_at: row.created_at,
        }))
      );

      const playersById = new Map(roundPlayers.map((player) => [player.id, { ...player }]));
      if (resolution.victimId) {
        const victim = playersById.get(resolution.victimId);
        if (victim) {
          victim.is_alive = false;
          victim.elimination_type = "night_fade";
          victim.eliminated_at = new Date().toISOString();
          playersById.set(victim.id, victim);
          await supabaseAdmin
            .from("night_protocol_players")
            .update({
              is_alive: false,
              elimination_type: "night_fade",
              eliminated_at: victim.eliminated_at,
            })
            .eq("id", victim.id);
        }
      }

      const postNightPlayers = Array.from(playersById.values());
      const winner = computeWinner(toEnginePlayers(postNightPlayers));

      const oracleEvents = resolution.oracleResults.map((result) => {
        const target = postNightPlayers.find((player) => player.id === result.targetPlayerId);
        return {
          session_id: sessionId,
          round_no: session.round_no,
          phase: "NIGHT",
          scope: "private" as const,
          target_player_id: result.oraclePlayerId,
          event_type: "oracle_truth",
          content: `Truth: ${target?.username || "Unknown"} is ${ROLE_LABEL[result.role]}.`,
        };
      });

      const baseNightEvents = [
        {
          session_id: sessionId,
          round_no: session.round_no,
          phase: "NIGHT",
          scope: "public" as const,
          event_type: "system",
          content: "Night actions locked. The Circle remains still.",
        },
        ...oracleEvents,
      ];

      if (winner) {
        await supabaseAdmin
          .from("night_protocol_sessions")
          .update({
            status: "ENDED",
            winner,
            current_speaker_player_id: null,
            speaker_order: [],
            speaker_index: 0,
            speaker_turn_ends_at: null,
            phase_ends_at: null,
          })
          .eq("id", sessionId);

        await Promise.all(
          postNightPlayers.map((player) =>
            supabaseAdmin
              .from("night_protocol_players")
              .update({ revealed_role: player.role })
              .eq("id", player.id)
          )
        );

        await insertEvents([
          ...baseNightEvents,
          {
            session_id: sessionId,
            round_no: session.round_no,
            phase: "DAY",
            scope: "public",
            event_type: "system",
            content: resolution.victimId
              ? `Dawn arrives. An absence is revealed: ${
                  postNightPlayers.find((p) => p.id === resolution.victimId)?.username || "Unknown"
                } has faded.`
              : "Dawn arrives. No absence. Someone was protected.",
          },
          {
            session_id: sessionId,
            round_no: session.round_no,
            phase: "END",
            scope: "public",
            event_type: "end",
            content:
              winner === "CITIZENS"
                ? "All Shadows have been removed. Citizens win. Presence held."
                : "Shadows are now equal to the remaining presences. Shadows win. Silence consumes the Circle.",
          },
        ]);

        return NextResponse.json({ ok: true, winner });
      }

      const dayEvents = [
        {
          session_id: sessionId,
          round_no: session.round_no,
          phase: "DAY",
          scope: "public" as const,
          event_type: "system",
          content: resolution.victimId
            ? `Dawn arrives. An absence is revealed: ${
                postNightPlayers.find((p) => p.id === resolution.victimId)?.username || "Unknown"
              } has faded.`
            : "Dawn arrives. No absence. Someone was protected.",
        },
        {
          session_id: sessionId,
          round_no: session.round_no,
          phase: "DAY",
          scope: "public" as const,
          event_type: "system",
          content: "The Circle is awake. Speak with care.",
        },
        {
          session_id: sessionId,
          round_no: session.round_no,
          phase: "DAY",
          scope: "public" as const,
          event_type: "system",
          content: "Accusations without listening create noise. Ask questions. Watch answers.",
        },
      ];

      const speakerOrder = session.presence_mode
        ? buildPresenceOrder(toEnginePlayers(postNightPlayers))
        : [];
      const currentSpeakerId = speakerOrder[0] ?? null;

      await supabaseAdmin
        .from("night_protocol_sessions")
        .update({
          status: "DAY",
          current_speaker_player_id: currentSpeakerId,
          speaker_order: speakerOrder,
          speaker_index: 0,
          speaker_turn_ends_at: session.presence_mode
            ? addSecondsIso(NIGHT_PROTOCOL_SPEAKER_SECONDS)
            : null,
          phase_ends_at: null,
        })
        .eq("id", sessionId);

      if (session.presence_mode) {
        dayEvents.push(
          {
            session_id: sessionId,
            round_no: session.round_no,
            phase: "DAY",
            scope: "public" as const,
            event_type: "system",
            content: "Presence Mode is active. Each voice receives 60s. Others remain silent.",
          },
          {
            session_id: sessionId,
            round_no: session.round_no,
            phase: "DAY",
            scope: "public" as const,
            event_type: "turn",
            content: `${
              postNightPlayers.find((player) => player.id === currentSpeakerId)?.username || "Unknown"
            }, you may speak.`,
          }
        );
      } else {
        dayEvents.push({
          session_id: sessionId,
          round_no: session.round_no,
          phase: "DAY",
          scope: "public" as const,
          event_type: "system",
          content: "Discussion is open. Remember: volume is not clarity.",
        });
      }

      await insertEvents([...baseNightEvents, ...dayEvents]);
      await autoPostAiSpeakerMessage(sessionId, session.round_no, currentSpeakerId, postNightPlayers);
      return NextResponse.json({ ok: true });
    }

    if (action === "send_day_message") {
      if (!me) {
        return NextResponse.json({ error: "not joined" }, { status: 403 });
      }
      const dayChatOpen = session.status === "DAY";
      const votingChatOpen =
        session.status === "VOTING" && session.voting_chat_mode === "open_short";
      if (!dayChatOpen && !votingChatOpen) {
        return NextResponse.json({ error: "chat is closed in this phase" }, { status: 400 });
      }
      if (!me.is_alive) {
        return NextResponse.json({ error: "eliminated players cannot speak" }, { status: 400 });
      }

      const content = asString((body as { content?: unknown }).content);
      if (!content) {
        return NextResponse.json({ error: "content required" }, { status: 400 });
      }
      if (content.length > 400) {
        return NextResponse.json({ error: "message too long" }, { status: 400 });
      }

      if (
        session.status === "DAY" &&
        session.presence_mode &&
        session.current_speaker_player_id !== me.id
      ) {
        return NextResponse.json({ error: "not your turn" }, { status: 403 });
      }

      await supabaseAdmin.from("night_protocol_day_messages").insert({
        session_id: sessionId,
        round_no: session.round_no,
        sender_player_id: me.id,
        username: me.username,
        content,
      });

      return NextResponse.json({ ok: true });
    }

    if (action === "advance_day_turn") {
      if (!isHost) {
        return NextResponse.json({ error: "host only" }, { status: 403 });
      }
      if (session.status !== "DAY") {
        return NextResponse.json({ error: "day phase required" }, { status: 400 });
      }
      if (!session.presence_mode) {
        return NextResponse.json({ error: "presence mode disabled" }, { status: 400 });
      }

      const roundPlayers = await loadPlayers(sessionId);
      const aliveSet = new Set(
        roundPlayers.filter((player) => player.is_alive).map((player) => player.id)
      );
      const order = parseSpeakerOrder(session.speaker_order).filter((id) => aliveSet.has(id));
      const currentIndex = Math.max(0, Number(session.speaker_index) || 0);
      const nextIndex = currentIndex + 1;

      await insertEvents([
        {
          session_id: sessionId,
          round_no: session.round_no,
          phase: "DAY",
          scope: "public",
          event_type: "turn",
          content: "Thank you. Silence.",
        },
      ]);

      if (order.length > 0 && nextIndex < order.length) {
        const nextSpeakerId = order[nextIndex];
        await supabaseAdmin
          .from("night_protocol_sessions")
          .update({
            speaker_order: order,
            speaker_index: nextIndex,
            current_speaker_player_id: nextSpeakerId,
            speaker_turn_ends_at: addSecondsIso(NIGHT_PROTOCOL_SPEAKER_SECONDS),
          })
          .eq("id", sessionId);

        await insertEvents([
          {
            session_id: sessionId,
            round_no: session.round_no,
            phase: "DAY",
            scope: "public",
            event_type: "turn",
            content: `${
              roundPlayers.find((player) => player.id === nextSpeakerId)?.username || "Unknown"
            }, you may speak.`,
          },
        ]);
        await autoPostAiSpeakerMessage(sessionId, session.round_no, nextSpeakerId, roundPlayers);
        return NextResponse.json({ ok: true });
      }

      await supabaseAdmin
        .from("night_protocol_sessions")
        .update({
          status: "VOTING",
          current_speaker_player_id: null,
          speaker_turn_ends_at: null,
          phase_ends_at: addSecondsIso(NIGHT_PROTOCOL_VOTE_SECONDS),
        })
        .eq("id", sessionId);

      await insertEvents([
        {
          session_id: sessionId,
          round_no: session.round_no,
          phase: "VOTING",
          scope: "public",
          event_type: "system",
          content: "Voting begins. Choose who you believe is a Shadow.",
        },
        {
          session_id: sessionId,
          round_no: session.round_no,
          phase: "VOTING",
          scope: "public",
          event_type: "system",
          content: `You have ${NIGHT_PROTOCOL_VOTE_SECONDS}s.`,
        },
        {
          session_id: sessionId,
          round_no: session.round_no,
          phase: "VOTING",
          scope: "public",
          event_type: "system",
          content:
            session.voting_chat_mode === "open_short"
              ? "Voting chat is briefly open."
              : "Voting chat is closed.",
        },
      ]);
      await applyAiVotes(sessionId, session.round_no, roundPlayers);
      return NextResponse.json({ ok: true });
    }

    if (action === "begin_voting") {
      if (!isHost) {
        return NextResponse.json({ error: "host only" }, { status: 403 });
      }
      if (session.status !== "DAY") {
        return NextResponse.json({ error: "day phase required" }, { status: 400 });
      }

      const roundPlayers = await loadPlayers(sessionId);
      await supabaseAdmin
        .from("night_protocol_sessions")
        .update({
          status: "VOTING",
          current_speaker_player_id: null,
          speaker_turn_ends_at: null,
          phase_ends_at: addSecondsIso(NIGHT_PROTOCOL_VOTE_SECONDS),
        })
        .eq("id", sessionId);

      await insertEvents([
        {
          session_id: sessionId,
          round_no: session.round_no,
          phase: "VOTING",
          scope: "public",
          event_type: "system",
          content: "Voting begins. Choose who you believe is a Shadow.",
        },
        {
          session_id: sessionId,
          round_no: session.round_no,
          phase: "VOTING",
          scope: "public",
          event_type: "system",
          content:
            session.voting_chat_mode === "open_short"
              ? "Voting chat is briefly open."
              : "Voting chat is closed.",
        },
      ]);
      await applyAiVotes(sessionId, session.round_no, roundPlayers);
      return NextResponse.json({ ok: true });
    }

    if (action === "submit_vote") {
      if (!me) {
        return NextResponse.json({ error: "not joined" }, { status: 403 });
      }
      if (session.status !== "VOTING") {
        return NextResponse.json({ error: "voting phase required" }, { status: 400 });
      }
      if (!me.is_alive) {
        return NextResponse.json({ error: "eliminated players cannot vote" }, { status: 400 });
      }

      const targetPlayerId = asString(
        (body as { targetPlayerId?: unknown }).targetPlayerId
      );
      const target = players.find((player) => player.id === targetPlayerId && player.is_alive);
      if (!target) {
        return NextResponse.json({ error: "target is not alive" }, { status: 400 });
      }
      if (target.id === me.id) {
        return NextResponse.json({ error: "cannot vote yourself" }, { status: 400 });
      }

      await supabaseAdmin
        .from("night_protocol_votes")
        .upsert(
          {
            session_id: sessionId,
            round_no: session.round_no,
            voter_player_id: me.id,
            target_player_id: target.id,
          },
          { onConflict: "session_id,round_no,voter_player_id" }
        );

      await insertEvents([
        {
          session_id: sessionId,
          round_no: session.round_no,
          phase: "VOTING",
          scope: "private",
          target_player_id: me.id,
          event_type: "ack",
          content: "Your vote is recorded.",
        },
      ]);

      const votes = await loadRoundVotes(sessionId, session.round_no);
      const alivePlayers = players.filter((player) => player.is_alive);
      const votedAlive = new Set(
        votes.filter((vote) =>
          alivePlayers.some((player) => player.id === vote.voter_player_id)
        ).map((vote) => vote.voter_player_id)
      );

      return NextResponse.json({
        ok: true,
        allVoted: votedAlive.size >= alivePlayers.length,
      });
    }

    if (action === "resolve_vote") {
      if (!isHost) {
        return NextResponse.json({ error: "host only" }, { status: 403 });
      }
      if (session.status !== "VOTING") {
        return NextResponse.json({ error: "voting phase required" }, { status: 400 });
      }

      const roundPlayers = await loadPlayers(sessionId);
      const votes = await loadRoundVotes(sessionId, session.round_no);
      const resolution = resolveVote(
        toEnginePlayers(roundPlayers),
        votes.map((vote) => ({
          voter_player_id: vote.voter_player_id,
          target_player_id: vote.target_player_id,
          created_at: vote.created_at,
        }))
      );

      const playersById = new Map(roundPlayers.map((player) => [player.id, { ...player }]));

      if (resolution.exiledId) {
        const exiled = playersById.get(resolution.exiledId);
        if (exiled) {
          exiled.is_alive = false;
          exiled.elimination_type = "exile";
          exiled.eliminated_at = new Date().toISOString();
          exiled.revealed_role = exiled.role;
          playersById.set(exiled.id, exiled);

          await supabaseAdmin
            .from("night_protocol_players")
            .update({
              is_alive: false,
              elimination_type: "exile",
              eliminated_at: exiled.eliminated_at,
              revealed_role: exiled.role,
            })
            .eq("id", exiled.id);
        }
      }

      const afterVotePlayers = Array.from(playersById.values());
      const winner = computeWinner(toEnginePlayers(afterVotePlayers));

      const events = [
        {
          session_id: sessionId,
          round_no: session.round_no,
          phase: "VOTING",
          scope: "public" as const,
          event_type: "system",
          content: "Voting is now closed.",
        },
      ];

      if (resolution.exiledId) {
        const exiled = afterVotePlayers.find((player) => player.id === resolution.exiledId);
        events.push(
          {
            session_id: sessionId,
            round_no: session.round_no,
            phase: "VOTING",
            scope: "public" as const,
            event_type: "system",
            content: `The Circle has chosen: ${exiled?.username || "Unknown"}.`,
          },
          {
            session_id: sessionId,
            round_no: session.round_no,
            phase: "VOTING",
            scope: "public" as const,
            event_type: "system",
            content: `${exiled?.username || "Unknown"} is exiled from the Circle.`,
          },
          {
            session_id: sessionId,
            round_no: session.round_no,
            phase: "VOTING",
            scope: "public" as const,
            event_type: "reveal",
            content: `Revealed truth: ${exiled?.username || "Unknown"} was ${
              exiled?.role ? ROLE_LABEL[exiled.role] : "Unknown"
            }.`,
          }
        );
      } else {
        events.push({
          session_id: sessionId,
          round_no: session.round_no,
          phase: "VOTING",
          scope: "public" as const,
          event_type: "system",
          content: "The Circle is split. No exile today.",
        });
      }

      if (winner) {
        await supabaseAdmin
          .from("night_protocol_sessions")
          .update({
            status: "ENDED",
            winner,
            current_speaker_player_id: null,
            speaker_order: [],
            speaker_index: 0,
            speaker_turn_ends_at: null,
            phase_ends_at: null,
          })
          .eq("id", sessionId);

        await Promise.all(
          afterVotePlayers.map((player) =>
            supabaseAdmin
              .from("night_protocol_players")
              .update({ revealed_role: player.role })
              .eq("id", player.id)
          )
        );

        events.push({
          session_id: sessionId,
          round_no: session.round_no,
          phase: "END",
          scope: "public" as const,
          event_type: "end",
          content:
            winner === "CITIZENS"
              ? "All Shadows have been removed. Citizens win. Presence held."
              : "Shadows are now equal to the remaining presences. Shadows win. Silence consumes the Circle.",
        });

        await insertEvents(events);
        return NextResponse.json({ ok: true, winner });
      }

      const nextRound = session.round_no + 1;
      await supabaseAdmin
        .from("night_protocol_sessions")
        .update({
          status: "NIGHT",
          round_no: nextRound,
          current_speaker_player_id: null,
          speaker_order: [],
          speaker_index: 0,
          speaker_turn_ends_at: null,
          phase_ends_at: addSecondsIso(NIGHT_PROTOCOL_NIGHT_SECONDS),
        })
        .eq("id", sessionId);

      events.push(
        {
          session_id: sessionId,
          round_no: nextRound,
          phase: "NIGHT",
          scope: "public" as const,
          event_type: "system",
          content: `Round ${nextRound} begins.`,
        },
        {
          session_id: sessionId,
          round_no: nextRound,
          phase: "NIGHT",
          scope: "public" as const,
          event_type: "system",
          content: "The Circle sleeps. No one speaks.",
        },
        {
          session_id: sessionId,
          round_no: nextRound,
          phase: "NIGHT",
          scope: "public" as const,
          event_type: "system",
          content: "Shadows awaken.",
        }
      );

      await insertEvents(events);
      await applyAiNightActions(sessionId, nextRound, afterVotePlayers);
      return NextResponse.json({ ok: true });
    }

    if (action === "sync_ai") {
      if (!isHost) {
        return NextResponse.json({ error: "host only" }, { status: 403 });
      }
      const freshSession = await loadSession(sessionId);
      if (!freshSession) {
        return NextResponse.json({ error: "session not found" }, { status: 404 });
      }
      const freshPlayers = await loadPlayers(sessionId);
      if (freshSession.status === "NIGHT") {
        await applyAiNightActions(sessionId, freshSession.round_no, freshPlayers);
      } else if (freshSession.status === "VOTING") {
        await applyAiVotes(sessionId, freshSession.round_no, freshPlayers);
      } else if (freshSession.status === "DAY" && freshSession.presence_mode) {
        await autoPostAiSpeakerMessage(
          sessionId,
          freshSession.round_no,
          freshSession.current_speaker_player_id,
          freshPlayers
        );
      }
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}
