"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

type SessionStatus = "LOBBY" | "NIGHT" | "DAY" | "VOTING" | "ENDED";
type Role = "shadow" | "oracle" | "guardian" | "citizen" | null;

type LobbySession = {
  id: string;
  sessionCode: string;
  status: SessionStatus;
  roundNo: number;
  minPlayers: number;
  maxPlayers: number;
  presenceMode: boolean;
  hostUserId: string;
  createdAt: string;
  playerCount: number;
  joined: boolean;
};

type MySession = {
  id: string;
  sessionCode: string;
  status: SessionStatus;
  roundNo: number;
  minPlayers: number;
  maxPlayers: number;
  presenceMode: boolean;
  hostUserId: string;
  createdAt: string;
};

type PlayerState = {
  id: string;
  username: string;
  isAi: boolean;
  seatNo: number;
  isAlive: boolean;
  eliminationType: "night_fade" | "exile" | null;
  roleVisible: Role;
};

type EventState = {
  id: number;
  roundNo: number;
  phase: string;
  scope: "public" | "private";
  eventType: string;
  content: string;
  createdAt: string;
};

type DayMessage = {
  id: number;
  roundNo: number;
  senderPlayerId: string;
  username: string;
  content: string;
  createdAt: string;
};

type SessionStatePayload = {
  session: {
    id: string;
    sessionCode: string;
    status: SessionStatus;
    roundNo: number;
    minPlayers: number;
    maxPlayers: number;
    presenceMode: boolean;
    currentSpeakerPlayerId: string | null;
    speakerOrder: string[];
    speakerIndex: number;
    speakerTurnEndsAt: string | null;
    phaseEndsAt: string | null;
    winner: "CITIZENS" | "SHADOWS" | null;
    hostUserId: string;
    createdAt: string;
  };
  me: {
    id: string;
    username: string;
    role: Role;
    isAlive: boolean;
    isHost: boolean;
    isAi: boolean;
  };
  players: PlayerState[];
  events: EventState[];
  dayMessages: DayMessage[];
  myRoundAction: { actionType: string; targetPlayerId: string } | null;
  myRoundVote: { targetPlayerId: string } | null;
  counts: {
    totalPlayers: number;
    alivePlayers: number;
    votesThisRound: number;
    actionsThisRound: number;
  };
};

const rolePromptByRole: Record<Exclude<Role, null>, string> = {
  shadow: "Choose who fades tonight.",
  oracle: "Whose truth do you seek?",
  guardian: "Who do you protect?",
  citizen: "Watch the pattern. Speak with care.",
};

const roleLabel: Record<Exclude<Role, null>, string> = {
  shadow: "Shadow Entity",
  oracle: "Oracle",
  guardian: "Guardian",
  citizen: "Citizen",
};

export default function NightProtocolPage() {
  const router = useRouter();
  const [sessionId, setSessionId] = useState<string>("");
  const [sessionCode, setSessionCode] = useState("");
  const [maxPlayers, setMaxPlayers] = useState(12);
  const [presenceMode, setPresenceMode] = useState(true);
  const [aiName, setAiName] = useState("");
  const [targetPlayerId, setTargetPlayerId] = useState("");
  const [dayMessage, setDayMessage] = useState("");
  const [ambientOn, setAmbientOn] = useState(false);
  const [lobbies, setLobbies] = useState<LobbySession[]>([]);
  const [mySessions, setMySessions] = useState<MySession[]>([]);
  const [state, setState] = useState<SessionStatePayload | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string>("");

  const authedFetch = useCallback(async (url: string, init?: RequestInit) => {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session?.access_token) {
      throw new Error("Please login first.");
    }

    const headers = new Headers(init?.headers || {});
    headers.set("Authorization", `Bearer ${session.access_token}`);
    if (init?.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const res = await fetch(url, { ...init, headers });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(String(payload?.error || "request failed"));
    }
    return payload;
  }, []);

  const loadLobby = useCallback(async () => {
    try {
      const payload = await authedFetch("/api/night-protocol");
      setLobbies((payload?.lobbies as LobbySession[]) || []);
      setMySessions((payload?.mySessions as MySession[]) || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "lobby load failed");
    }
  }, [authedFetch]);

  const loadSession = useCallback(async (nextSessionId: string) => {
    if (!nextSessionId) return;
    try {
      const payload = await authedFetch(
        `/api/night-protocol?sessionId=${encodeURIComponent(nextSessionId)}`
      );
      setState(payload as SessionStatePayload);
      setError("");
    } catch (err) {
      setState(null);
      setError(err instanceof Error ? err.message : "session load failed");
    }
  }, [authedFetch]);

  const runAction = useCallback(
    async (action: string, extra?: Record<string, unknown>) => {
      setBusyAction(action);
      setError("");
      try {
        const payload = await authedFetch("/api/night-protocol", {
          method: "POST",
          body: JSON.stringify({
            action,
            sessionId: sessionId || undefined,
            ...extra,
          }),
        });

        const nextSessionId = String(payload?.sessionId || sessionId || "");
        if (nextSessionId && nextSessionId !== sessionId) {
          setSessionId(nextSessionId);
          window.history.replaceState({}, "", `/main/night-protocol?session=${nextSessionId}`);
        }
        await loadLobby();
        if (nextSessionId) {
          await loadSession(nextSessionId);
        }
        return payload;
      } catch (err) {
        setError(err instanceof Error ? err.message : "action failed");
        return null;
      } finally {
        setBusyAction(null);
      }
    },
    [authedFetch, loadLobby, loadSession, sessionId]
  );

  useEffect(() => {
    void loadLobby();
  }, [loadLobby]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = String(params.get("session") || "").trim();
    if (!fromQuery) return;
    setSessionId(fromQuery);
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    void loadSession(sessionId);
  }, [loadSession, sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    const timer = window.setInterval(() => {
      void loadSession(sessionId);
      void loadLobby();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [loadLobby, loadSession, sessionId]);

  const aliveTargets = useMemo(() => {
    return (state?.players || []).filter((player) => player.isAlive);
  }, [state?.players]);

  const currentSpeaker = useMemo(() => {
    if (!state?.session.currentSpeakerPlayerId) return null;
    return (
      state.players.find((player) => player.id === state.session.currentSpeakerPlayerId) || null
    );
  }, [state]);

  const canSpeak = useMemo(() => {
    if (!state) return false;
    if (!state.me.isAlive) return false;
    if (state.session.status !== "DAY") return false;
    if (!state.session.presenceMode) return true;
    return state.session.currentSpeakerPlayerId === state.me.id;
  }, [state]);

  const canDoNightAction = useMemo(() => {
    if (!state) return false;
    if (!state.me.isAlive) return false;
    if (state.session.status !== "NIGHT") return false;
    return state.me.role === "shadow" || state.me.role === "oracle" || state.me.role === "guardian";
  }, [state]);

  const canVote = useMemo(() => {
    if (!state) return false;
    return state.session.status === "VOTING" && state.me.isAlive;
  }, [state]);

  return (
    <main
      style={{
        minHeight: "100vh",
        background:
          state?.session.status === "NIGHT"
            ? "radial-gradient(circle at 50% 20%, rgba(26,27,44,0.9), #040507 70%)"
            : "radial-gradient(circle at 50% 20%, rgba(28,40,44,0.9), #050708 72%)",
        color: "#e7ecef",
        padding: 24,
      }}
    >
      {ambientOn ? <audio src="/ambient-main.mp3" autoPlay loop /> : null}

      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 22, letterSpacing: "0.08em" }}>Night Protocol</div>
          <div style={{ opacity: 0.68, fontSize: 12 }}>Presence over performance.</div>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={() => setAmbientOn((prev) => !prev)} style={buttonStyle}>
            {ambientOn ? "Ambient On" : "Ambient Off"}
          </button>
          <button onClick={() => router.push("/main")} style={buttonStyle}>
            Back
          </button>
        </div>
      </div>

      {error ? <div style={{ color: "#ff9ea3", marginBottom: 10 }}>{error}</div> : null}

      <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 16 }}>
        <section style={panelStyle}>
          <div style={panelTitleStyle}>Enter The Circle</div>
          <div style={{ marginBottom: 8 }}>
            <input
              value={sessionCode}
              onChange={(e) => setSessionCode(e.target.value.toUpperCase())}
              placeholder="session code"
              style={inputStyle}
            />
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <button
              disabled={busyAction === "join_session" || !sessionCode}
              onClick={() => void runAction("join_session", { sessionCode })}
              style={buttonStyle}
            >
              Join
            </button>
            <button
              disabled={busyAction === "create_session"}
              onClick={() =>
                void runAction("create_session", { maxPlayers, presenceMode })
              }
              style={buttonStyle}
            >
              Create
            </button>
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <input
              type="number"
              min={6}
              max={12}
              value={maxPlayers}
              onChange={(e) => setMaxPlayers(Number(e.target.value) || 12)}
              style={{ ...inputStyle, width: 80 }}
            />
            <label style={{ fontSize: 12, opacity: 0.8 }}>
              <input
                type="checkbox"
                checked={presenceMode}
                onChange={(e) => setPresenceMode(e.target.checked)}
                style={{ marginRight: 6 }}
              />
              Presence mode
            </label>
          </div>

          <div style={panelTitleStyle}>My Sessions</div>
          <div style={{ maxHeight: 140, overflowY: "auto", marginBottom: 12 }}>
            {mySessions.length === 0 ? (
              <div style={{ opacity: 0.5, fontSize: 12 }}>No active session.</div>
            ) : (
              mySessions.map((item) => (
                <div key={item.id} style={listRowStyle}>
                  <span>{item.sessionCode}</span>
                  <button onClick={() => setSessionId(item.id)} style={miniButtonStyle}>
                    Open
                  </button>
                </div>
              ))
            )}
          </div>

          <div style={panelTitleStyle}>Open Lobbies</div>
          <div style={{ maxHeight: 220, overflowY: "auto" }}>
            {lobbies.length === 0 ? (
              <div style={{ opacity: 0.5, fontSize: 12 }}>No lobby now.</div>
            ) : (
              lobbies.map((item) => (
                <div key={item.id} style={listRowStyle}>
                  <div>
                    <div>{item.sessionCode}</div>
                    <div style={{ fontSize: 11, opacity: 0.55 }}>
                      {item.playerCount}/{item.maxPlayers}
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      setSessionCode(item.sessionCode);
                      void runAction("join_session", { sessionCode: item.sessionCode });
                    }}
                    style={miniButtonStyle}
                  >
                    Join
                  </button>
                </div>
              ))
            )}
          </div>
        </section>

        <section style={panelStyle}>
          {!state ? (
            <div style={{ opacity: 0.6 }}>Select or join a session.</div>
          ) : (
            <>
              <div
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
              >
                <div>
                  <div style={{ fontSize: 20 }}>{state.session.sessionCode}</div>
                  <div style={{ opacity: 0.7, fontSize: 12 }}>
                    {state.session.status} · round {state.session.roundNo}
                  </div>
                </div>
                <div style={{ textAlign: "right", fontSize: 12, opacity: 0.8 }}>
                  <div>Players: {state.counts.totalPlayers}</div>
                  <div>Alive: {state.counts.alivePlayers}</div>
                </div>
              </div>

              <div style={{ marginTop: 12, padding: 10, border: "1px solid rgba(255,255,255,0.12)" }}>
                <div style={{ fontSize: 12, opacity: 0.72 }}>Your role</div>
                <div style={{ fontSize: 18 }}>
                  {state.me.role ? roleLabel[state.me.role] : "Not assigned"}
                </div>
                <div style={{ opacity: 0.72, fontSize: 12 }}>
                  {state.me.role ? rolePromptByRole[state.me.role] : "Waiting for start."}
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "240px 1fr", gap: 12, marginTop: 12 }}>
                <div>
                  <div style={panelTitleStyle}>Players</div>
                  <div style={{ maxHeight: 260, overflowY: "auto" }}>
                    {state.players.map((player) => (
                      <div key={player.id} style={listRowStyle}>
                        <span style={{ opacity: player.isAlive ? 1 : 0.5 }}>
                          {player.username}
                          {player.isAi ? " [AI]" : ""}
                          {!player.isAlive ? " (faded)" : ""}
                        </span>
                        <span style={{ fontSize: 11, opacity: 0.7 }}>
                          {player.roleVisible ? roleLabel[player.roleVisible] : ""}
                        </span>
                      </div>
                    ))}
                  </div>

                  {state.me.isHost ? (
                    <div style={{ marginTop: 12 }}>
                      <div style={panelTitleStyle}>Host Controls</div>
                      {state.session.status === "LOBBY" ? (
                        <>
                          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                            <input
                              value={aiName}
                              onChange={(e) => setAiName(e.target.value)}
                              placeholder="ai name (optional)"
                              style={inputStyle}
                            />
                            <button
                              onClick={() => void runAction("add_ai_player", { aiName })}
                              style={miniButtonStyle}
                            >
                              +AI
                            </button>
                          </div>
                          <button
                            onClick={() => void runAction("start_session")}
                            style={buttonStyle}
                            disabled={state.counts.totalPlayers < state.session.minPlayers}
                          >
                            Start Game
                          </button>
                        </>
                      ) : null}
                      {state.session.status === "NIGHT" ? (
                        <button onClick={() => void runAction("resolve_night")} style={buttonStyle}>
                          Resolve Night
                        </button>
                      ) : null}
                      {state.session.status === "DAY" && state.session.presenceMode ? (
                        <button onClick={() => void runAction("advance_day_turn")} style={buttonStyle}>
                          Next Speaker / Start Vote
                        </button>
                      ) : null}
                      {state.session.status === "DAY" && !state.session.presenceMode ? (
                        <button onClick={() => void runAction("begin_voting")} style={buttonStyle}>
                          Begin Voting
                        </button>
                      ) : null}
                      {state.session.status === "VOTING" ? (
                        <button onClick={() => void runAction("resolve_vote")} style={buttonStyle}>
                          Resolve Vote
                        </button>
                      ) : null}
                      <button onClick={() => void runAction("sync_ai")} style={buttonStyle}>
                        Sync AI
                      </button>
                    </div>
                  ) : null}
                </div>

                <div>
                  <div style={panelTitleStyle}>Axy Watch</div>
                  <div style={{ maxHeight: 170, overflowY: "auto", border: "1px solid rgba(255,255,255,0.12)", padding: 8 }}>
                    {state.events.slice(-80).map((event) => (
                      <div key={event.id} style={{ marginBottom: 7, fontSize: 12 }}>
                        <span style={{ opacity: 0.55 }}>{event.phase}</span>{" "}
                        <span>{event.content}</span>
                      </div>
                    ))}
                  </div>

                  <div style={{ marginTop: 10 }}>
                    <div style={panelTitleStyle}>Presence Chat</div>
                    {state.session.presenceMode && state.session.status === "DAY" ? (
                      <div style={{ fontSize: 12, opacity: 0.72, marginBottom: 6 }}>
                        Current speaker: {currentSpeaker?.username || "-"}
                      </div>
                    ) : null}
                    <div style={{ maxHeight: 140, overflowY: "auto", border: "1px solid rgba(255,255,255,0.12)", padding: 8 }}>
                      {state.dayMessages.slice(-100).map((msg) => (
                        <div key={msg.id} style={{ marginBottom: 6, fontSize: 12 }}>
                          <span style={{ opacity: 0.65 }}>{msg.username}:</span>{" "}
                          <span>{msg.content}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {canDoNightAction || canVote ? (
                    <div style={{ marginTop: 10 }}>
                      <select
                        value={targetPlayerId}
                        onChange={(e) => setTargetPlayerId(e.target.value)}
                        style={inputStyle}
                      >
                        <option value="">Select target</option>
                        {aliveTargets
                          .filter((player) => player.id !== state.me.id)
                          .map((player) => (
                            <option key={player.id} value={player.id}>
                              {player.username}
                            </option>
                          ))}
                      </select>
                    </div>
                  ) : null}

                  {canDoNightAction ? (
                    <button
                      onClick={() => void runAction("submit_night_action", { targetPlayerId })}
                      disabled={!targetPlayerId}
                      style={buttonStyle}
                    >
                      Submit Night Action
                    </button>
                  ) : null}

                  {canVote ? (
                    <button
                      onClick={() => void runAction("submit_vote", { targetPlayerId })}
                      disabled={!targetPlayerId}
                      style={buttonStyle}
                    >
                      Submit Vote
                    </button>
                  ) : null}

                  {state.session.status === "DAY" ? (
                    <div style={{ marginTop: 10 }}>
                      <textarea
                        value={dayMessage}
                        onChange={(e) => setDayMessage(e.target.value)}
                        placeholder={canSpeak ? "Speak with care..." : "Waiting your turn"}
                        style={{ ...inputStyle, minHeight: 70 }}
                        disabled={!canSpeak}
                      />
                      <button
                        onClick={() => {
                          void runAction("send_day_message", { content: dayMessage });
                          setDayMessage("");
                        }}
                        disabled={!canSpeak || !dayMessage.trim()}
                        style={buttonStyle}
                      >
                        Send Message
                      </button>
                    </div>
                  ) : null}

                  {state.session.status === "ENDED" ? (
                    <div style={{ marginTop: 12, fontSize: 14, color: "#9df3be" }}>
                      {state.session.winner === "CITIZENS"
                        ? "Citizens win. Presence held."
                        : "Shadows win. Silence consumes the Circle."}
                    </div>
                  ) : null}
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  );
}

const panelStyle: React.CSSProperties = {
  border: "1px solid rgba(255,255,255,0.14)",
  borderRadius: 12,
  padding: 12,
  background: "rgba(4, 8, 12, 0.55)",
};

const panelTitleStyle: React.CSSProperties = {
  fontSize: 12,
  letterSpacing: "0.12em",
  opacity: 0.7,
  marginBottom: 8,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.2)",
  color: "#e7ecef",
  borderRadius: 8,
  padding: "8px 10px",
  fontSize: 12,
};

const buttonStyle: React.CSSProperties = {
  background: "rgba(118, 214, 255, 0.18)",
  border: "1px solid rgba(118, 214, 255, 0.6)",
  color: "#e7ecef",
  borderRadius: 8,
  padding: "8px 10px",
  cursor: "pointer",
  fontSize: 12,
  marginTop: 8,
};

const miniButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  marginTop: 0,
  padding: "4px 8px",
};

const listRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 6,
  borderBottom: "1px solid rgba(255,255,255,0.08)",
  paddingBottom: 6,
  fontSize: 12,
};
