"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

type Message = {
  id: string;
  user_id: string;
  username: string;
  content: string;
};

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

  const [username, setUsername] = useState("user");
  const [userId, setUserId] = useState<string | null>(null);

  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [realtimePresentUsers, setRealtimePresentUsers] = useState<string[]>(
    []
  );
  const [runtimePresentUsers, setRuntimePresentUsers] = useState<string[]>([]);
  const [presentUserGlow, setPresentUserGlow] = useState<string | null>(null);

  /* AXY reflection (messages) */
  const [axyMsgReflection, setAxyMsgReflection] = useState<
    Record<string, string>
  >({});
  const [axyMsgLoadingId, setAxyMsgLoadingId] = useState<string | null>(null);
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
  const [hushInviteTarget, setHushInviteTarget] = useState<{
    userId: string;
    username: string;
    chatId?: string;
  } | null>(null);
  const [playOpen, setPlayOpen] = useState(false);
  const [activePlay, setActivePlay] = useState<
    "signal-drift" | "slow-orbit" | "hush-puzzle" | null
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
  const hushPanelRef = useRef<HTMLDivElement | null>(null);
  const sharedMessagesRef = useRef<HTMLDivElement | null>(null);
  const [playClosedHeight, setPlayClosedHeight] = useState<number | null>(null);
  const presentUsers = useMemo(
    () =>
      Array.from(new Set([...realtimePresentUsers, ...runtimePresentUsers])).sort(
        (a, b) => a.localeCompare(b, "en", { sensitivity: "base" })
      ),
    [realtimePresentUsers, runtimePresentUsers]
  );

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
        .select("username")
        .eq("id", user.id)
        .maybeSingle();

      setUsername(profile?.username ?? "user");

      const { data } = await supabase
        .from("main_messages")
        .select("id, user_id, username, content")
        .order("created_at", { ascending: true });

      setMessages(data || []);
    }

    load();
  }, [router]);

  async function loadHush() {
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
  }

  async function loadHushMessages(chatId: string) {
    const { data } = await supabase
      .from("hush_chat_messages")
      .select("id, chat_id, user_id, content, created_at")
      .eq("chat_id", chatId)
      .order("created_at", { ascending: true });

    setHushMessages(data || []);
  }

  async function loadRuntimePresentUsers() {
    try {
      const thresholdIso = new Date(Date.now() - 90 * 1000).toISOString();

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
  }

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

  function getMyHushMembership(chatId: string) {
    if (!userId) return null;
    return hushMembers.find(
      (member) => member.chat_id === chatId && member.user_id === userId
    );
  }

  useEffect(() => {
    if (!userId) return;
    loadHush();
  }, [userId]);

  useEffect(() => {
    if (!userId) return;

    const channel = supabase
      .channel("hush-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "hush_chats" },
        () => {
          loadHush();
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "hush_chat_members" },
        () => {
          loadHush();
          if (selectedHushChatId) {
            loadHushMessages(selectedHushChatId);
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
            loadHushMessages(selectedHushChatId);
          }
        }
      )
      .subscribe();

    const poll = setInterval(() => {
      loadHush();
      if (selectedHushChatId) {
        loadHushMessages(selectedHushChatId);
      }
    }, 6000);

    return () => {
      clearInterval(poll);
      supabase.removeChannel(channel);
    };
  }, [userId, selectedHushChatId]);

  useEffect(() => {
    if (!selectedHushChatId || !userId) {
      setHushMessages([]);
      return;
    }

    const myMembership = getMyHushMembership(selectedHushChatId);
    if (!myMembership || myMembership.status !== "accepted") {
      setHushMessages([]);
      return;
    }

    loadHushMessages(selectedHushChatId);
  }, [selectedHushChatId, userId, hushMembers]);

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
    const el = sharedMessagesRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    const el = sharedMessagesRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
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
      Object.values(state).forEach((metas) => {
        metas.forEach((meta) => {
          if (meta?.user_id && meta?.username) {
            map.set(meta.user_id, meta.username);
          }
        });
      });

      const names = Array.from(map.values()).sort((a, b) =>
        a.localeCompare(b, "en", { sensitivity: "base" })
      );
      setRealtimePresentUsers(names);
    };

    channel
      .on("presence", { event: "sync" }, syncPresentUsers)
      .on("presence", { event: "join" }, syncPresentUsers)
      .on("presence", { event: "leave" }, syncPresentUsers)
      .subscribe(async (status) => {
        if (status !== "SUBSCRIBED") return;
        await channel.track({
          user_id: userId,
          username: username || "user",
          online_at: new Date().toISOString(),
        });
      });

    return () => {
      channel.untrack();
      supabase.removeChannel(channel);
    };
  }, [userId, username]);

  useEffect(() => {
    if (!userId) return;

    const run = () => {
      void loadRuntimePresentUsers();
    };

    const first = window.setTimeout(run, 0);
    const poll = window.setInterval(run, 12000);

    return () => {
      window.clearTimeout(first);
      window.clearInterval(poll);
    };
  }, [userId]);

  /*  send */
  async function sendMessage() {
    if (!input.trim() || !userId) return;

    setLoading(true);

    await supabase.from("main_messages").insert({
      user_id: userId,
      username,
      content: input,
    });

    setInput("");
    setLoading(false);
  }

  /*  delete */
  async function deleteMessage(id: string) {
    await supabase.from("main_messages").delete().eq("id", id);
  }

  /* AXY reflect (message) */
  async function askAxyOnMessage(messageId: string, content: string) {
    setAxyMsgLoadingId(messageId);

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
        [messageId]: data.reply,
      }));
    } catch {
      setAxyMsgReflection((prev) => ({
        ...prev,
        [messageId]: "...",
      }));
    }

    setAxyMsgLoadingId(null);
  }

  function openPlay(game: "signal-drift" | "slow-orbit" | "hush-puzzle") {
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
  }

  function togglePlayPanel() {
    setPlayOpen((prev) => {
      const next = !prev;
      if (!next) {
        setActivePlay(null);
        setDriftRunning(false);
        setOrbitRunning(false);
      }
      return next;
    });
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

  async function createHushWith(targetUserId: string) {
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
          display_name: username,
        },
        {
          chat_id: chat.id,
          user_id: targetUserId,
          role: "member",
          status: "invited",
          display_name: hushInviteTarget?.username ?? "user",
        },
      ]);

    if (!memberError) {
      setSelectedHushChatId(chat.id);
      setHushInviteTarget(null);
      await loadHush();
    }

    setHushLoading(false);
  }

  async function inviteToHushChat(chatId: string, targetUserId: string) {
    if (!userId || hushLoading) return;

    setHushLoading(true);

    await supabase.from("hush_chat_members").insert({
      chat_id: chatId,
      user_id: targetUserId,
      role: "member",
      status: "invited",
      display_name: hushInviteTarget?.username ?? "user",
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
          display_name: username,
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

  const selectedHushMembership = selectedHushChatId
    ? getMyHushMembership(selectedHushChatId)
    : null;

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

  return (
    <main
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
  <img
    src="/kozmos-logomother1.png"
    alt="Kozmos"
      className="kozmos-logo kozmos-logo-ambient"
    style={{
      maxWidth: 80,          // ana sayfadakiyle uyumlu
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
        }}
      >
        <span style={{ cursor: "pointer" }} onClick={() => router.push("/main")}>
          main
        </span>{" "}
        /{" "}
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
        }}
      >
        <span
          style={{ marginRight: 8, cursor: "pointer", opacity: 0.8 }}
          onClick={() => router.push("/account")}
        >
          {username}
        </span>
        /{" "}
        <span style={{ cursor: "pointer" }} onClick={handleLogout}>
          logout
        </span>
      </div>

      {/* MAIN GRID */}
      <div className="main-grid" style={mainGridStyle}>
        {/* HUSH PANEL */}
        <div
          className="hush-panel"
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
          <div
            className="kozmos-tap hush-refresh"
            style={{ opacity: 0.4, cursor: "pointer" }}
            onClick={loadHush}
          >
            refresh
          </div>
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
                      hushInviteTarget.userId
                    );
                  } else {
                    createHushWith(hushInviteTarget.userId);
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
                onClick={() =>
                  setSelectedHushChatId((prev) =>
                    prev === chat.id ? null : chat.id
                  )
                }
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

            {canChatInSelectedHush ? (
              <>
                <div
                  style={{
                    maxHeight: 160,
                    overflowY: "auto",
                    marginBottom: 8,
                  }}
                >
                  {hushMessages.map((msg) => (
                    <div key={msg.id} style={{ marginBottom: 6 }}>
                      <span style={{ opacity: 0.6 }}>
                        {getHushUserName(msg.user_id)}:
                      </span>{" "}
                      <span>{msg.content}</span>
                    </div>
                  ))}
                </div>

                <input
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
            className="kozmos-shared-glow"
            style={{
              fontSize: 20,
              letterSpacing: "0.12em",
              fontWeight: 500,
              opacity: 0.6,
              textTransform: "none",
              textAlign: "center",
            }}
          >
            shared space
          </div>
          <div
            style={{
              width: "min(220px, 64%)",
              height: 1,
              marginTop: 9,
              background:
                "linear-gradient(90deg, transparent 0%, rgba(255,230,170,0.75) 50%, transparent 100%)",
              boxShadow: "0 0 8px rgba(255,230,170,0.35)",
            }}
          />
        </div>

        <div ref={sharedMessagesRef} style={sharedMessagesScrollStyle}>
          {messages.map((m) => (
            <div
              key={m.id}
              style={{
                marginBottom: 12,
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
                      cursor: m.user_id === userId ? "default" : "pointer",
                    }}
                    onMouseEnter={() => setHoveredMsgId(m.id)}
                    onMouseLeave={() => setHoveredMsgId(null)}
                    onClick={() => {
                      if (m.user_id === userId) return;
                      setHushInviteTarget({
                        userId: m.user_id,
                        username: m.username,
                        chatId: isSelectedHushOwner
                          ? selectedHushChatId ?? undefined
                          : undefined,
                      });
                    }}
                  >
                    {m.user_id !== userId && hoveredMsgId === m.id && (
                      <span style={hushPillStyle}>hush-chat</span>
                    )}
                    {m.username}:
                  </span>{" "}
                  <span>{m.content}</span>
                  {m.user_id === userId && (
                    <span
                      onClick={() => deleteMessage(m.id)}
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

                {axyMsgReflection[m.id] && (
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
                        setAxyMsgFadeId(m.id);

                        setAxyMsgReflection((prev) => {
                          const copy = { ...prev };
                          delete copy[m.id];
                          return copy;
                        });

                        setTimeout(() => {
                          setAxyMsgFadeId(null);
                        }, 400);
                      }}
                    >
                      Axy reflects:
                    </span>
                    {axyMsgReflection[m.id]}
                  </div>
                )}
              </div>

              <img
                src="/axy-logofav.png"
                alt="Axy"
                style={{
                  width: 22,
                  height: 22,
                  cursor: "pointer",
                  opacity: axyMsgFadeId === m.id ? 0.25 : 0.6,
                  transform: axyMsgPulseId === m.id ? "scale(1.2)" : "scale(1)",
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
                  setAxyMsgPulseId(m.id);
                  askAxyOnMessage(m.id, m.content);

                  setTimeout(() => {
                    setAxyMsgPulseId(null);
                  }, 300);
                }}
              />
            </div>
          ))}
        </div>

        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="write something..."
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
          onClick={sendMessage}
        >
          {loading ? "sending..." : "send"}
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
              presentUsers.map((name) => (
                <span
                  key={`present-${name}`}
                  className="present-user-chip"
                  onClick={() => {
                    setPresentUserGlow(name);
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
              ))
            )}
          </div>
        </div>
        </div>

        {/* PLAY PANEL */}
        <div
          className="play-panel"
          style={{
            ...playPanelStyle,
            minHeight: playOpen ? undefined : playClosedHeight ?? undefined,
          }}
          onClick={togglePlayPanel}
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
            <div style={{ opacity: 0.35 }}>beta</div>
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
  marginRight: 16,
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


