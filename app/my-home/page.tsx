"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { markMyHomeVisited } from "@/lib/myHomeAttention";

type Note = {
  id: string;
  content: string;
};

type TouchUser = {
  id: string;
  username: string;
  avatar_url: string | null;
};

type TouchRequest = {
  id: number;
  username: string;
  avatar_url: string | null;
};

type DirectChat = {
  chat_id: string;
  other_user_id: string;
  username: string;
  avatar_url: string | null;
  updated_at: string;
  last_message_sender_id?: string | null;
  last_message_created_at?: string | null;
};

type DirectMessage = {
  id: number;
  chat_id: string;
  sender_id: string;
  content: string;
  created_at: string;
};

type HoloFlightStyle = React.CSSProperties & {
  [key: `--ufo-${string}`]: string | number;
};

const DIRECT_CHAT_SEEN_STORAGE_PREFIX = "kozmos:dm-seen:";
const SECONDARY_AMBIENT_SRC = "/ambient-main.mp3";
const SECONDARY_AMBIENT_PREF_KEY = "kozmos:ambient-sound-secondary";
const AXY_SHIP_SRC = "/ufo.png";
const LUMI_SHIP_SRC = "/ufoholo.png";

export default function MyHome() {
  const router = useRouter();
  const ambientAudioRef = useRef<HTMLAudioElement | null>(null);

  const [username, setUsername] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const displayUsername = username?.trim() ? username.trim() : "\u00A0";

  //  AXY MICRO STATES
  const [axyPulseId, setAxyPulseId] = useState<string | null>(null);
  const [axyFadeId, setAxyFadeId] = useState<string | null>(null);

  const [noteInput, setNoteInput] = useState("");
  const [notes, setNotes] = useState<Note[]>([]);
  const [notesBootstrapping, setNotesBootstrapping] = useState(true);
  const [loading, setLoading] = useState(false);
  const [touchUsers, setTouchUsers] = useState<TouchUser[]>([]);
  const [incomingTouchRequests, setIncomingTouchRequests] = useState<TouchRequest[]>(
    []
  );
  const [touchLoading, setTouchLoading] = useState(false);
  const [touchInitialized, setTouchInitialized] = useState(false);
  const [touchBusyId, setTouchBusyId] = useState<number | null>(null);
  const [touchEditMode, setTouchEditMode] = useState(false);
  const [touchSavingOrder, setTouchSavingOrder] = useState(false);
  const [touchRemovingUserId, setTouchRemovingUserId] = useState<string | null>(null);
  const [touchHoverUserId, setTouchHoverUserId] = useState<string | null>(null);
  const [chatStartBusyUserId, setChatStartBusyUserId] = useState<string | null>(null);
  const [activeChats, setActiveChats] = useState<DirectChat[]>([]);
  const [selectedDirectChatId, setSelectedDirectChatId] = useState<string | null>(null);
  const [directMessages, setDirectMessages] = useState<DirectMessage[]>([]);
  const [directInput, setDirectInput] = useState("");
  const [directLoading, setDirectLoading] = useState(false);
  const [directSending, setDirectSending] = useState(false);
  const [directChatEditMode, setDirectChatEditMode] = useState(false);
  const [directChatSavingOrder, setDirectChatSavingOrder] = useState(false);
  const [directChatRemovingId, setDirectChatRemovingId] = useState<string | null>(null);
  const [directUnreadChatIds, setDirectUnreadChatIds] = useState<Record<string, true>>(
    {}
  );
  const [isMobileLayout, setIsMobileLayout] = useState(false);
  const directMessagesViewportRef = useRef<HTMLDivElement | null>(null);
  const lastDirectScrollKeyRef = useRef<string>("");
  const directChatsInitializedRef = useRef(false);
  const directChatUpdatedAtRef = useRef<Record<string, string>>({});
  const directChatSeenAtRef = useRef<Record<string, string>>({});

  //  AXY STATES
  const [axyReflection, setAxyReflection] = useState<Record<string, string>>({});
  const [, setAxyLoadingId] = useState<string | null>(null);
  const [personalAxyOpen, setPersonalAxyOpen] = useState(false);
  const [personalAxyInput, setPersonalAxyInput] = useState("");
  const [personalAxyReply, setPersonalAxyReply] = useState<string | null>(null);
  const [personalAxyLoading, setPersonalAxyLoading] = useState(false);
  const [personalLastMessage, setPersonalLastMessage] = useState<string | null>(
    null
  );
  const [ufoBeamActive, setUfoBeamActive] = useState(false);
  const [ufoBeamHasFired, setUfoBeamHasFired] = useState(false);
  const [holoFlightPhase, setHoloFlightPhase] = useState<
    "idle" | "tour" | "exit" | "return" | "special"
  >("idle");
  const [holoFlightOrigin, setHoloFlightOrigin] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [holoFlightMotionStyle, setHoloFlightMotionStyle] =
    useState<HoloFlightStyle>({});
  const [lumiMobileTapHintVisible, setLumiMobileTapHintVisible] = useState(false);
  const [ambientSoundOn, setAmbientSoundOn] = useState(false);
  const [ambientPrefReady, setAmbientPrefReady] = useState(false);
  const touchPanelRef = useRef<HTMLDivElement | null>(null);
  const holoShipRef = useRef<HTMLDivElement | null>(null);
  const holoFlightTimersRef = useRef<number[]>([]);
  const holoFlightPhaseRef = useRef<"idle" | "tour" | "exit" | "return" | "special">(
    "idle"
  );
  const holoLaunchRafRef = useRef<number | null>(null);
  const holoDockRafRef = useRef<number | null>(null);
  const holoSpecialRafRef = useRef<number | null>(null);
  const holoSpecialLaunchTimerRef = useRef<number | null>(null);
  const holoSpecialIntervalRef = useRef<number | null>(null);
  const lumiMobileTapHintTimerRef = useRef<number | null>(null);
  const holoDockLeft = isMobileLayout ? 12 : 18;
  const holoDockTop = isMobileLayout ? -92 : -128;
  const holoShipWidth = isMobileLayout ? 94 : 140;

  const loadKeepInTouch = useCallback(async () => {
    setTouchLoading(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) {
        if (!touchInitialized) {
          setTouchUsers([]);
          setIncomingTouchRequests([]);
        }
        setTouchInitialized(true);
        return;
      }

      const res = await fetch("/api/keep-in-touch", {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      });
      const body = (await res.json().catch(() => ({}))) as {
        inTouch?: TouchUser[];
        incoming?: TouchRequest[];
      };

      if (!res.ok) {
        setTouchInitialized(true);
        return;
      }

      setTouchUsers(Array.isArray(body.inTouch) ? body.inTouch : []);
      setIncomingTouchRequests(Array.isArray(body.incoming) ? body.incoming : []);
      setTouchInitialized(true);
    } finally {
      setTouchLoading(false);
    }
  }, [touchInitialized]);

  const loadDirectChats = useCallback(async () => {
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) {
        setActiveChats([]);
        return;
      }

      const res = await fetch("/api/direct-chats", {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      });
      const body = (await res.json().catch(() => ({}))) as {
        chats?: DirectChat[];
      };

      if (!res.ok) return;
      const nextChats = Array.isArray(body.chats) ? body.chats : [];
      const seenMap = directChatSeenAtRef.current;

      const isFirstLoad = !directChatsInitializedRef.current;
      if (isFirstLoad) {
        directChatsInitializedRef.current = true;
        directChatUpdatedAtRef.current = nextChats.reduce<Record<string, string>>(
          (acc, chat) => {
            acc[chat.chat_id] = chat.last_message_created_at || chat.updated_at || "";
            return acc;
          },
          {}
        );
      } else {
        const previous = directChatUpdatedAtRef.current;
        const nextMap = nextChats.reduce<Record<string, string>>((acc, chat) => {
          acc[chat.chat_id] = chat.last_message_created_at || chat.updated_at || "";
          return acc;
        }, {});

        const nextUnread: Record<string, true> = {};
        nextChats.forEach((chat) => {
          if (chat.chat_id === selectedDirectChatId) return;
          if (chat.last_message_sender_id && chat.last_message_sender_id === userId) {
            return;
          }

          const nextSignalAt = chat.last_message_created_at || chat.updated_at || "";
          const nextTs = Date.parse(nextSignalAt);
          if (!Number.isFinite(nextTs)) return;

          const seenTs = Date.parse(seenMap[chat.chat_id] || "");
          if (Number.isFinite(seenTs)) {
            if (nextTs > seenTs) nextUnread[chat.chat_id] = true;
            return;
          }

          if (isFirstLoad) return;

          const prevTs = Date.parse(previous[chat.chat_id] || "");
          const isNewChat = !previous[chat.chat_id];
          const isUpdated = !Number.isFinite(prevTs) || nextTs > prevTs;
          if (isNewChat || isUpdated) {
            nextUnread[chat.chat_id] = true;
          }
        });

        if (Object.keys(nextUnread).length > 0) {
          setDirectUnreadChatIds((prev) => ({ ...prev, ...nextUnread }));
        }

        directChatUpdatedAtRef.current = nextMap;
      }

      setActiveChats(nextChats);
      setSelectedDirectChatId((prev) => {
        if (prev && nextChats.some((chat) => chat.chat_id === prev)) {
          return prev;
        }
        return null;
      });
    } catch {
      // ignore transient fetch failures
    }
  }, [selectedDirectChatId, userId]);

  const persistDirectSeenMap = useCallback(
    (nextMap: Record<string, string>) => {
    if (!userId) return;
    try {
      window.localStorage.setItem(
        `${DIRECT_CHAT_SEEN_STORAGE_PREFIX}${userId}`,
        JSON.stringify(nextMap)
      );
    } catch {
      // ignore localStorage write failures
    }
    },
    [userId]
  );

  const markDirectChatSeen = useCallback((chatId: string, seenAtIso: string) => {
    if (!chatId || !seenAtIso) return;
    const current = directChatSeenAtRef.current[chatId];
    const currentTs = Date.parse(current || "");
    const nextTs = Date.parse(seenAtIso);
    if (Number.isFinite(currentTs) && Number.isFinite(nextTs) && currentTs >= nextTs) {
      return;
    }

    const nextMap = {
      ...directChatSeenAtRef.current,
      [chatId]: seenAtIso,
    };
    directChatSeenAtRef.current = nextMap;
    persistDirectSeenMap(nextMap);
  }, [persistDirectSeenMap]);

  const loadDirectMessages = useCallback(async (chatId: string) => {
    if (!chatId) return;
    setDirectLoading(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) {
        setDirectMessages([]);
        return;
      }

      const res = await fetch(
        `/api/direct-chats/messages?chatId=${encodeURIComponent(chatId)}`,
        {
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
        }
      );

      const body = (await res.json().catch(() => ({}))) as {
        messages?: DirectMessage[];
      };

      if (!res.ok) return;
      setDirectMessages(Array.isArray(body.messages) ? body.messages : []);
    } finally {
      setDirectLoading(false);
    }
  }, []);

  async function startDirectChat(targetUserId: string) {
    if (!targetUserId || chatStartBusyUserId) return;
    setChatStartBusyUserId(targetUserId);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) return;

      const res = await fetch("/api/direct-chats", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ targetUserId }),
      });

      const body = (await res.json().catch(() => ({}))) as {
        chat?: DirectChat;
      };
      if (!res.ok || !body.chat?.chat_id) return;
      await loadDirectChats();
      setSelectedDirectChatId(body.chat.chat_id);
      setDirectUnreadChatIds((prev) => {
        if (!prev[body.chat!.chat_id]) return prev;
        const copy = { ...prev };
        delete copy[body.chat!.chat_id];
        return copy;
      });
      await loadDirectMessages(body.chat.chat_id);
    } finally {
      setChatStartBusyUserId(null);
    }
  }

  async function persistDirectChatOrder(nextChats: DirectChat[]) {
    setDirectChatSavingOrder(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) return;

      await fetch("/api/direct-chats/order", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          orderedChatIds: nextChats.map((chat) => chat.chat_id),
        }),
      });
    } finally {
      setDirectChatSavingOrder(false);
    }
  }

  function moveDirectChat(index: number, direction: -1 | 1) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= activeChats.length) return;

    const nextChats = [...activeChats];
    const swap = nextChats[index];
    nextChats[index] = nextChats[nextIndex];
    nextChats[nextIndex] = swap;
    setActiveChats(nextChats);
    void persistDirectChatOrder(nextChats);
  }

  async function removeDirectChat(chatId: string) {
    if (!chatId || directChatRemovingId) return;
    setDirectChatRemovingId(chatId);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) return;

      const res = await fetch("/api/direct-chats/remove", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ chatId }),
      });

      if (!res.ok) return;
      setActiveChats((prev) => prev.filter((chat) => chat.chat_id !== chatId));
      setSelectedDirectChatId((prev) => (prev === chatId ? null : prev));
      setDirectMessages((prev) => prev.filter((msg) => msg.chat_id !== chatId));
      setDirectUnreadChatIds((prev) => {
        if (!prev[chatId]) return prev;
        const copy = { ...prev };
        delete copy[chatId];
        return copy;
      });
    } finally {
      setDirectChatRemovingId(null);
    }
  }

  async function sendDirectMessage() {
    const content = directInput.trim();
    if (!selectedDirectChatId || !content || directSending) return;

    setDirectSending(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) return;

      const res = await fetch("/api/direct-chats/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          chatId: selectedDirectChatId,
          content,
        }),
      });

      if (!res.ok) return;

      setDirectInput("");
      await Promise.all([
        loadDirectMessages(selectedDirectChatId),
        loadDirectChats(),
      ]);
    } finally {
      setDirectSending(false);
    }
  }

  async function respondKeepInTouch(requestId: number, decision: "accept" | "decline") {
    if (touchBusyId) return;
    setTouchBusyId(requestId);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) return;

      await fetch("/api/keep-in-touch/respond", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          requestId,
          decision,
        }),
      });

      await loadKeepInTouch();
    } finally {
      setTouchBusyId(null);
    }
  }

  async function persistTouchOrder(nextUsers: TouchUser[]) {
    setTouchSavingOrder(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) return;

      await fetch("/api/keep-in-touch/order", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          orderedUserIds: nextUsers.map((row) => row.id),
        }),
      });
    } finally {
      setTouchSavingOrder(false);
    }
  }

  function moveTouchUser(index: number, direction: -1 | 1) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= touchUsers.length) return;

    const nextUsers = [...touchUsers];
    const swap = nextUsers[index];
    nextUsers[index] = nextUsers[nextIndex];
    nextUsers[nextIndex] = swap;
    setTouchUsers(nextUsers);
    void persistTouchOrder(nextUsers);
  }

  async function removeTouchUser(targetUserId: string) {
    if (!targetUserId || touchRemovingUserId) return;
    setTouchRemovingUserId(targetUserId);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) return;

      await fetch("/api/keep-in-touch/remove", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ targetUserId }),
      });

      await loadKeepInTouch();
    } finally {
      setTouchRemovingUserId(null);
    }
  }

  useEffect(() => {

    async function loadUserAndNotes() {
      setNotesBootstrapping(true);
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();

        if (!user) {
          router.push("/login");
          return;
        }

        setUserId(user.id);
        try {
          const raw = window.localStorage.getItem(
            `${DIRECT_CHAT_SEEN_STORAGE_PREFIX}${user.id}`
          );
          if (raw) {
            const parsed = JSON.parse(raw) as Record<string, string>;
            if (parsed && typeof parsed === "object") {
              directChatSeenAtRef.current = parsed;
            }
          }
        } catch {
          directChatSeenAtRef.current = {};
        }

        const { data: profile } = await supabase
          .from("profileskozmos")
          .select("username")
          .eq("id", user.id)
          .maybeSingle();

        setUsername(profile?.username?.trim() || "user");

        const { data: notesData } = await supabase
          .from("notes")
          .select("id, content")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false });

        setNotes(notesData || []);
        await Promise.all([loadKeepInTouch(), loadDirectChats()]);
      } finally {
        setNotesBootstrapping(false);
      }
    }

    loadUserAndNotes();
  }, [loadDirectChats, loadKeepInTouch, router]);
useEffect(() => {
  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") {
      router.replace("/login");
    }
  });

  return () => {
    subscription.unsubscribe();
  };
}, [router]);

  useEffect(() => {
    if (!userId) return;
    markMyHomeVisited(userId);
  }, [userId]);

  useEffect(() => {
    if (!userId) return;

    const poll = window.setInterval(() => {
      void loadKeepInTouch();
      void loadDirectChats();
    }, 15000);

    return () => {
      window.clearInterval(poll);
    };
  }, [loadDirectChats, loadKeepInTouch, userId]);

  useEffect(() => {
    if (!selectedDirectChatId) {
      setDirectMessages([]);
      return;
    }

    markDirectChatSeen(selectedDirectChatId, new Date().toISOString());

    setDirectUnreadChatIds((prev) => {
      if (!prev[selectedDirectChatId]) return prev;
      const copy = { ...prev };
      delete copy[selectedDirectChatId];
      return copy;
    });

    const run = () => {
      void loadDirectMessages(selectedDirectChatId);
    };

    const first = window.setTimeout(run, 0);
    const poll = window.setInterval(run, 4500);

    return () => {
      window.clearTimeout(first);
      window.clearInterval(poll);
    };
  }, [loadDirectMessages, markDirectChatSeen, selectedDirectChatId]);

  useEffect(() => {
    lastDirectScrollKeyRef.current = "";
  }, [selectedDirectChatId]);

  useEffect(() => {
    if (!selectedDirectChatId) return;

    const lastMessage = directMessages[directMessages.length - 1];
    if (lastMessage?.created_at) {
      markDirectChatSeen(selectedDirectChatId, String(lastMessage.created_at));
    }
    const scrollKey = `${selectedDirectChatId}:${lastMessage?.id ?? "none"}:${directMessages.length}`;

    if (scrollKey === lastDirectScrollKeyRef.current) return;
    lastDirectScrollKeyRef.current = scrollKey;

    const el = directMessagesViewportRef.current;
    if (!el) return;

    const raf = window.requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });

    return () => {
      window.cancelAnimationFrame(raf);
    };
  }, [directMessages, markDirectChatSeen, selectedDirectChatId]);

  useEffect(() => {
    const sync = () => {
      const narrowViewport = window.innerWidth <= 1080;
      const coarsePointer = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
      setIsMobileLayout(narrowViewport && coarsePointer);
    };
    sync();
    window.addEventListener("resize", sync);
    return () => {
      window.removeEventListener("resize", sync);
    };
  }, []);

  useEffect(() => {
    if (touchEditMode) {
      setTouchHoverUserId(null);
    }
  }, [touchEditMode]);

  useEffect(() => {
    if (!directChatEditMode) return;
    setTouchHoverUserId(null);
  }, [directChatEditMode]);

  useEffect(() => {
    if (isMobileLayout) {
      setUfoBeamActive(false);
      setUfoBeamHasFired(false);
      return;
    }
    if (notesBootstrapping) {
      setUfoBeamActive(false);
      return;
    }

    let cancelled = false;
    let cycleTimer: number | null = null;
    let beamOffTimer: number | null = null;

    const scheduleNext = (firstCycle: boolean) => {
      if (cancelled) return;
      const waitMs = firstCycle
        ? 10000 + Math.random() * 5000
        : 20000 + Math.random() * 10000; // 20-30s => ~2-3/min

      cycleTimer = window.setTimeout(() => {
        if (cancelled) return;
        setUfoBeamActive(true);
        setUfoBeamHasFired(true);
        beamOffTimer = window.setTimeout(() => {
          setUfoBeamActive(false);
        }, 5000);
        scheduleNext(false);
      }, waitMs);
    };

    scheduleNext(true);

    return () => {
      cancelled = true;
      if (cycleTimer) window.clearTimeout(cycleTimer);
      if (beamOffTimer) window.clearTimeout(beamOffTimer);
    };
  }, [isMobileLayout, notesBootstrapping]);

  useEffect(() => {
    const saved = window.localStorage.getItem(SECONDARY_AMBIENT_PREF_KEY);
    if (saved === "1") {
      setAmbientSoundOn(true);
    } else {
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
    audio.volume = 0.24;
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

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/");
  }

  async function saveNote() {
    if (!noteInput.trim() || !userId) return;

    setLoading(true);

    const { data } = await supabase
      .from("notes")
      .insert({
        user_id: userId,
        content: noteInput,
      })
      .select("id, content")
      .single();

    if (data) {
      setNotes((prev) => [data, ...prev]);
    }

    setNoteInput("");
    setLoading(false);
  }

  async function deleteNote(id: string) {
    await supabase.from("notes").delete().eq("id", id);
    setNotes((prev) => prev.filter((n) => n.id !== id));
  }

  //  ASK AXY
  async function askAxy(noteId: string, content: string) {
    setAxyLoadingId(noteId);

    try {
      const res = await fetch("/api/axy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: `Reflect on this note in one calm sentence:\n\n${content}`,
        }),
      });

      const data = await res.json();

      setAxyReflection((prev) => ({
        ...prev,
        [noteId]: data.reply,
      }));
    } catch {
      setAxyReflection((prev) => ({
        ...prev,
        [noteId]: "...",
      }));
    }

    setAxyLoadingId(null);
  }

  async function askPersonalAxy() {
    const message = personalAxyInput.trim();
    if (!message) return;

    setPersonalAxyLoading(true);
    setPersonalAxyReply(null);
    setPersonalLastMessage(message);
    setPersonalAxyInput("");

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      const res = await fetch("/api/axy/personal", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token
            ? { Authorization: `Bearer ${session.access_token}` }
            : {}),
        },
        body: JSON.stringify({
          message,
          recentNotes: notes.slice(0, 6).map((n) => n.content),
        }),
      });

      const data = await res.json();
      const reply =
        typeof data?.reply === "string" && data.reply.trim().length > 0
          ? data.reply
          : "...";
      setPersonalAxyReply(reply);
    } catch {
      setPersonalAxyReply("...");
    }

    setPersonalAxyLoading(false);
  }

  function resetPersonalAxy() {
    setPersonalAxyReply(null);
    setPersonalLastMessage(null);
    setPersonalAxyInput("");
    setPersonalAxyLoading(false);
  }

  function clearHoloFlightTimers() {
    holoFlightTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    holoFlightTimersRef.current = [];
    if (holoLaunchRafRef.current !== null) {
      window.cancelAnimationFrame(holoLaunchRafRef.current);
      holoLaunchRafRef.current = null;
    }
    if (holoDockRafRef.current !== null) {
      window.cancelAnimationFrame(holoDockRafRef.current);
      holoDockRafRef.current = null;
    }
    if (holoSpecialRafRef.current !== null) {
      window.cancelAnimationFrame(holoSpecialRafRef.current);
      holoSpecialRafRef.current = null;
    }
  }

  function clearHoloSpecialSchedule() {
    if (holoSpecialLaunchTimerRef.current !== null) {
      window.clearTimeout(holoSpecialLaunchTimerRef.current);
      holoSpecialLaunchTimerRef.current = null;
    }
    if (holoSpecialIntervalRef.current !== null) {
      window.clearInterval(holoSpecialIntervalRef.current);
      holoSpecialIntervalRef.current = null;
    }
  }

  function launchHoloFlight() {
    if (isMobileLayout) return;
    if (holoFlightPhaseRef.current !== "idle") return;
    const ship = holoShipRef.current;
    const panel = touchPanelRef.current;
    if (!ship || !panel) return;
    const rng = Math.random;
    const randomRange = (min: number, max: number) => min + rng() * (max - min);
    const randomOffscreenPoint = () => {
      const side = Math.floor(randomRange(0, 4));
      if (side === 0) {
        return { x: randomRange(120, 165), y: randomRange(-34, 120) };
      }
      if (side === 1) {
        return { x: randomRange(-165, -120), y: randomRange(-34, 120) };
      }
      if (side === 2) {
        return { x: randomRange(-36, 120), y: randomRange(-132, -84) };
      }
      return { x: randomRange(-36, 120), y: randomRange(124, 162) };
    };

    const exitPoint = randomOffscreenPoint();
    const returnStartPoint = randomOffscreenPoint();
    const motionStyle: HoloFlightStyle = {
      "--ufo-r0": "-2deg",
      "--ufo-r1": `${randomRange(-22, 24).toFixed(2)}deg`,
      "--ufo-r2": `${randomRange(-24, 22).toFixed(2)}deg`,
      "--ufo-r3": `${randomRange(-19, 25).toFixed(2)}deg`,
      "--ufo-r4": `${randomRange(-24, 20).toFixed(2)}deg`,
      "--ufo-r5": `${randomRange(-16, 18).toFixed(2)}deg`,
      "--ufo-tour1-x": `${randomRange(10, 36).toFixed(2)}vw`,
      "--ufo-tour1-y": `${randomRange(4, 18).toFixed(2)}vh`,
      "--ufo-tour2-x": `${randomRange(-20, 56).toFixed(2)}vw`,
      "--ufo-tour2-y": `${randomRange(14, 42).toFixed(2)}vh`,
      "--ufo-tour3-x": `${randomRange(-12, 66).toFixed(2)}vw`,
      "--ufo-tour3-y": `${randomRange(8, 52).toFixed(2)}vh`,
      "--ufo-tour4-x": `${randomRange(-26, 58).toFixed(2)}vw`,
      "--ufo-tour4-y": `${randomRange(10, 46).toFixed(2)}vh`,
      "--ufo-tour-end-x": `${randomRange(14, 58).toFixed(2)}vw`,
      "--ufo-tour-end-y": `${randomRange(12, 40).toFixed(2)}vh`,
      "--ufo-exit-x": `${exitPoint.x.toFixed(2)}vw`,
      "--ufo-exit-y": `${exitPoint.y.toFixed(2)}vh`,
      "--ufo-exit-rot": `${randomRange(-46, 46).toFixed(2)}deg`,
      "--ufo-return-start-x": `${returnStartPoint.x.toFixed(2)}vw`,
      "--ufo-return-start-y": `${returnStartPoint.y.toFixed(2)}vh`,
      "--ufo-return-mid-x": `${randomRange(-22, 24).toFixed(2)}vw`,
      "--ufo-return-mid-y": `${randomRange(-2, 12).toFixed(2)}vh`,
      "--ufo-return-mid-rot": `${randomRange(-18, 20).toFixed(2)}deg`,
      "--ufo-return-rot": `${randomRange(-40, 40).toFixed(2)}deg`,
    };

    const panelRect = panel.getBoundingClientRect();
    const shipWidth = ship.offsetWidth || 140;
    const shipHeight = ship.offsetHeight || 76;
    const dockLeft = holoDockLeft;
    const dockTop = holoDockTop;
    const rect = {
      x: panelRect.left + dockLeft + shipWidth * 0.5,
      y: panelRect.top + dockTop + shipHeight * 0.5,
    };
    setHoloFlightOrigin({
      x: rect.x,
      y: rect.y,
    });
    setHoloFlightMotionStyle(motionStyle);
    clearHoloFlightTimers();

    holoLaunchRafRef.current = window.requestAnimationFrame(() => {
      holoLaunchRafRef.current = null;
      setHoloFlightPhase("tour");

      const toExit = window.setTimeout(() => {
        setHoloFlightPhase("exit");
      }, 8000);
      const toReturn = window.setTimeout(() => {
        setHoloFlightPhase("return");
      }, 8920);
      const toIdle = window.setTimeout(() => {
        finishHoloFlight();
      }, 10080);

      holoFlightTimersRef.current = [toExit, toReturn, toIdle];
    });
  }

  function launchSpecialHoloFlight() {
    if (isMobileLayout) return;
    if (holoFlightPhaseRef.current !== "idle") return;
    const ship = holoShipRef.current;
    const panel = touchPanelRef.current;
    if (!ship || !panel) return;
    clearHoloFlightTimers();
    const panelRect = panel.getBoundingClientRect();
    const shipWidth = ship.offsetWidth || 140;
    const shipHeight = ship.offsetHeight || 76;
    const dockLeft = holoDockLeft;
    const dockTop = holoDockTop;
    const originX = panelRect.left + dockLeft + shipWidth * 0.5;
    const originY = panelRect.top + dockTop + shipHeight * 0.5;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const centerX = viewportW * (isMobileLayout ? 0.5 : 0.52);
    const centerY = viewportH * (isMobileLayout ? 0.38 : 0.42);
    const loopCount = isMobileLayout ? 14 : 20;
    const enterMs = 1900;
    const hoverMs = 820;
    const loopMs = 11200;
    const slowMs = 1650;
    const homeMs = 1950;
    const totalMs = enterMs + hoverMs + loopMs + slowMs + homeMs;
    const leftEntryX = -viewportW * (isMobileLayout ? 0.22 : 0.16);
    const rightExitX = viewportW * (isMobileLayout ? 1.22 : 1.16);
    const loopSpan = rightExitX - leftEntryX;
    const startLoopFrac = Math.min(
      0.96,
      Math.max(0.04, (centerX - leftEntryX) / loopSpan)
    );
    const specialStart = performance.now();
    setHoloFlightOrigin({ x: originX, y: originY });
    setHoloFlightMotionStyle({
      transform: "translate(-50%, -50%) translate(0px, 0px) rotate(-2deg) scale(1)",
      opacity: 0.78,
    });

    const easeInOut = (value: number) =>
      value < 0.5
        ? 4 * value * value * value
        : 1 - Math.pow(-2 * value + 2, 3) / 2;
    const easeOut = (value: number) => 1 - Math.pow(1 - value, 3);
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

    const loopState = (progress: number) => {
      const accel = Math.pow(progress, 2);
      const cycles = startLoopFrac + accel * (loopCount - 0.02);
      const frac = cycles - Math.floor(cycles);
      const x = leftEntryX + loopSpan * frac;
      const wave = Math.sin((cycles - startLoopFrac) * Math.PI * 2);
      const y = centerY + wave * 20 + Math.sin(progress * Math.PI * 2.8) * 7;
      const rotate = wave * 14 + progress * 10 - 6;
      const scale = 1 + Math.sin(cycles * Math.PI * 2) * 0.016;
      return { x, y, rotate, scale };
    };

    const specialTick = (now: number) => {
      const elapsed = now - specialStart;
      if (elapsed >= totalMs) {
        finishHoloFlight();
        holoSpecialRafRef.current = null;
        return;
      }

      let x = originX;
      let y = originY;
      let rotate = -2;
      let scale = 1;
      let opacity = 0.78;

      if (elapsed < enterMs) {
        const t = easeOut(elapsed / enterMs);
        x = lerp(originX, centerX, t);
        y = lerp(originY, centerY, t) + Math.sin(t * Math.PI) * 6;
        rotate = lerp(-2, 2, t);
        scale = lerp(1, 1.03, t);
      } else if (elapsed < enterMs + hoverMs) {
        const t = (elapsed - enterMs) / hoverMs;
        x = centerX + Math.sin(t * Math.PI * 2) * 10;
        y = centerY + Math.sin(t * Math.PI * 4) * 4;
        rotate = Math.sin(t * Math.PI * 2) * 5;
        scale = 1.02;
      } else if (elapsed < enterMs + hoverMs + loopMs) {
        const t = (elapsed - enterMs - hoverMs) / loopMs;
        const state = loopState(t);
        x = state.x;
        y = state.y;
        rotate = state.rotate;
        scale = state.scale;
        opacity = 0.74 + Math.sin(t * Math.PI * 20) * 0.04;
      } else if (elapsed < enterMs + hoverMs + loopMs + slowMs) {
        const t = easeOut((elapsed - enterMs - hoverMs - loopMs) / slowMs);
        const endState = loopState(1);
        x = lerp(endState.x, centerX, t);
        y = lerp(endState.y, centerY, t) + Math.sin((1 - t) * Math.PI) * 5;
        rotate = lerp(endState.rotate, 1, t);
        scale = lerp(endState.scale, 1.01, t);
      } else {
        const t = easeInOut((elapsed - enterMs - hoverMs - loopMs - slowMs) / homeMs);
        x = lerp(centerX, originX, t);
        y = lerp(centerY, originY, t);
        rotate = lerp(1, -2, t);
        scale = lerp(1.01, 1, t);
      }

      setHoloFlightMotionStyle({
        transform: `translate(-50%, -50%) translate(${(x - originX).toFixed(2)}px, ${(y - originY).toFixed(2)}px) rotate(${rotate.toFixed(2)}deg) scale(${scale.toFixed(3)})`,
        opacity,
      });

      holoSpecialRafRef.current = window.requestAnimationFrame(specialTick);
    };

    holoLaunchRafRef.current = window.requestAnimationFrame(() => {
      holoLaunchRafRef.current = null;
      setHoloFlightPhase("special");
      holoSpecialRafRef.current = window.requestAnimationFrame(specialTick);
    });
  }

  function finishHoloFlight() {
    if (holoFlightPhaseRef.current === "idle") return;
    if (holoDockRafRef.current !== null) {
      window.cancelAnimationFrame(holoDockRafRef.current);
      holoDockRafRef.current = null;
    }

    setHoloFlightMotionStyle({
      transform: "translate(-50%, -50%) translate(0px, 0px) rotate(-2deg) scale(1)",
      opacity: 0.78,
    });

    holoDockRafRef.current = window.requestAnimationFrame(() => {
      holoDockRafRef.current = null;
      setHoloFlightPhase("idle");
      setHoloFlightOrigin(null);
      setHoloFlightMotionStyle({});
    });
  }

  useEffect(() => {
    holoFlightPhaseRef.current = holoFlightPhase;
  }, [holoFlightPhase]);

  useEffect(() => {
    return () => {
      clearHoloFlightTimers();
      clearHoloSpecialSchedule();
      if (lumiMobileTapHintTimerRef.current !== null) {
        window.clearTimeout(lumiMobileTapHintTimerRef.current);
        lumiMobileTapHintTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (isMobileLayout) {
      clearHoloFlightTimers();
      clearHoloSpecialSchedule();
      setHoloFlightPhase("idle");
      setHoloFlightOrigin(null);
      setHoloFlightMotionStyle({});
      return;
    }
    if (notesBootstrapping) return;
    const initialDelayMs = 30000;
    const intervalMs = 180000;
    clearHoloSpecialSchedule();
    holoSpecialLaunchTimerRef.current = window.setTimeout(() => {
      launchSpecialHoloFlight();
      holoSpecialIntervalRef.current = window.setInterval(() => {
        launchSpecialHoloFlight();
      }, intervalMs);
    }, initialDelayMs);

    return () => {
      clearHoloSpecialSchedule();
    };
  }, [isMobileLayout, notesBootstrapping]);

  function renderTouchPanel() {
    const holoPhaseClassName =
      holoFlightPhase === "idle"
        ? undefined
        : holoFlightPhase === "tour"
          ? "lumi-ship-flight-tour"
          : holoFlightPhase === "exit"
            ? "lumi-ship-flight-exit"
            : holoFlightPhase === "return"
              ? "lumi-ship-flight-return"
              : "lumi-ship-flight-special";
    const holoWrapperClassName = ["lumi-ship-hover-target", holoPhaseClassName]
      .filter(Boolean)
      .join(" ");

    const holoWrapperStyle: React.CSSProperties =
      holoFlightPhase === "idle"
        ? {
            ...touchHoloShipStyle,
            left: holoDockLeft,
            top: holoDockTop,
            width: holoShipWidth,
            opacity: touchHoloShipStyle.opacity,
          }
        : {
            ...touchHoloFlightOverlayStyle,
            width: holoShipWidth,
            ...holoFlightMotionStyle,
            left: holoFlightOrigin?.x ?? 0,
            top: holoFlightOrigin?.y ?? 0,
          };

    return (
      <div ref={touchPanelRef} style={touchPanelStyle}>
        {!isMobileLayout ? (
          <div
            ref={holoShipRef}
            className={holoWrapperClassName}
            onClick={() => {
              if (!isMobileLayout) launchHoloFlight();
            }}
            style={holoWrapperStyle}
            aria-hidden
          >
            <img
              src={LUMI_SHIP_SRC}
              alt=""
              aria-hidden
              draggable={false}
              className="lumi-ship-float"
              style={touchHoloShipImageStyle}
            />
            <span
              className="lumi-ship-label lumi-ship-label-follow"
              aria-hidden
              style={{
                position: "absolute",
                left: "50%",
                top: "calc(100% - 16px)",
                fontSize: 11,
                letterSpacing: "0.14em",
                color: "rgba(196, 236, 255, 0.9)",
                textShadow:
                  "0 0 6px rgba(160,220,255,0.55), 0 0 14px rgba(112,196,255,0.34)",
                opacity: 0,
                transition: "opacity 280ms ease",
                pointerEvents: "none",
                userSelect: "none",
              }}
            >
              Lumi
            </span>
          </div>
        ) : null}
        <div style={touchPanelContentLayerStyle}>
        <div style={touchPanelHeadStyle}>
          <div style={{ ...labelStyle, marginBottom: 0 }}>users in touch</div>
          <button
            type="button"
            onClick={() => setTouchEditMode((prev) => !prev)}
            style={touchEditButtonStyle}
          >
            {touchEditMode ? "done" : "edit"}
          </button>
        </div>

        {!touchInitialized && touchLoading ? (
          <div style={touchMutedStyle}>loading...</div>
        ) : touchUsers.length === 0 ? (
          <div style={touchMutedStyle}>no users in touch yet</div>
        ) : (
          <div style={touchListStyle}>
            {touchUsers.map((user, idx) => (
              <div
                key={user.id}
                style={touchUserRowStyle}
                onMouseEnter={() => {
                  if (!touchEditMode) {
                    setTouchHoverUserId(user.id);
                  }
                }}
                onMouseLeave={() => {
                  if (!touchEditMode) {
                    setTouchHoverUserId((prev) => (prev === user.id ? null : prev));
                  }
                }}
              >
                <div style={touchAvatarStyle}>
                  {user.avatar_url ? (
                    <img
                      src={user.avatar_url}
                      alt={`${user.username} avatar`}
                      style={touchAvatarImageStyle}
                    />
                  ) : (
                    <span style={{ fontSize: 12, opacity: 0.72 }}>
                      {(user.username[0] ?? "?").toUpperCase()}
                    </span>
                  )}
                </div>
                <span style={{ opacity: 0.82 }}>{user.username}</span>
                {!touchEditMode && touchHoverUserId === user.id ? (
                  <button
                    type="button"
                    onClick={() => {
                      void startDirectChat(user.id);
                    }}
                    disabled={chatStartBusyUserId === user.id}
                    style={touchOneToOneButtonStyle}
                  >
                    {chatStartBusyUserId === user.id ? "..." : "1:1"}
                  </button>
                ) : null}
                {touchEditMode ? (
                  <div style={touchEditActionsStyle}>
                    <button
                      type="button"
                      onClick={() => moveTouchUser(idx, -1)}
                      disabled={idx === 0 || touchSavingOrder}
                      style={touchMiniButtonStyle}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => moveTouchUser(idx, 1)}
                      disabled={idx === touchUsers.length - 1 || touchSavingOrder}
                      style={touchMiniButtonStyle}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void removeTouchUser(user.id);
                      }}
                      disabled={touchRemovingUserId === user.id}
                      style={{ ...touchMiniButtonStyle, opacity: 0.72 }}
                    >
                      {touchRemovingUserId === user.id ? "..." : "remove"}
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {incomingTouchRequests.length > 0 ? (
          <div style={{ marginTop: 14 }}>
            <div style={{ ...labelStyle, marginBottom: 8, opacity: 0.5 }}>
              keep in touch requests
            </div>
            <div style={touchListStyle}>
              {incomingTouchRequests.map((row) => (
                <div key={`touch-request-${row.id}`} style={touchRequestRowStyle}>
                  <div style={touchUserRowStyle}>
                    <div style={touchAvatarStyle}>
                      {row.avatar_url ? (
                        <img
                          src={row.avatar_url}
                          alt={`${row.username} avatar`}
                          style={touchAvatarImageStyle}
                        />
                      ) : (
                        <span style={{ fontSize: 12, opacity: 0.72 }}>
                          {(row.username[0] ?? "?").toUpperCase()}
                        </span>
                      )}
                    </div>
                    <span style={{ opacity: 0.82 }}>{row.username}</span>
                  </div>

                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      type="button"
                      onClick={() => {
                        void respondKeepInTouch(row.id, "accept");
                      }}
                      disabled={touchBusyId === row.id}
                      style={touchActionButtonStyle}
                    >
                      {touchBusyId === row.id ? "..." : "yes"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void respondKeepInTouch(row.id, "decline");
                      }}
                      disabled={touchBusyId === row.id}
                      style={{ ...touchActionButtonStyle, opacity: 0.6 }}
                    >
                      no
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        </div>
      </div>
    );
  }

  function renderDirectChatPanel() {
    return (
      <div style={touchPanelStyle}>
        <div style={touchPanelHeadStyle}>
          <div style={{ ...labelStyle, marginBottom: 0 }}>1:1 chat</div>
          <button
            type="button"
            onClick={() => setDirectChatEditMode((prev) => !prev)}
            style={touchEditButtonStyle}
          >
            {directChatEditMode ? "done" : "edit"}
          </button>
        </div>

        {activeChats.length === 0 ? (
          <div style={touchMutedStyle}>no active chats</div>
        ) : (
          <div style={touchListStyle}>
            {activeChats.map((chat, idx) => (
              <div
                key={chat.chat_id}
                className={
                  !directChatEditMode &&
                  selectedDirectChatId !== chat.chat_id &&
                  directUnreadChatIds[chat.chat_id]
                    ? "dm-unread-breathe"
                    : undefined
                }
                style={{
                  ...touchUserRowStyle,
                  border:
                    selectedDirectChatId === chat.chat_id
                      ? "1px solid rgba(255,255,255,0.2)"
                      : directUnreadChatIds[chat.chat_id]
                        ? "1px solid rgba(230,255,240,0.45)"
                        : "1px solid transparent",
                  borderRadius: 8,
                  padding: "3px 4px",
                  cursor: directChatEditMode ? "default" : "pointer",
                }}
                onClick={() => {
                  if (!directChatEditMode) {
                    setSelectedDirectChatId((prev) => {
                      const next = prev === chat.chat_id ? null : chat.chat_id;
                      if (next) {
                        setDirectUnreadChatIds((prevUnread) => {
                          if (!prevUnread[next]) return prevUnread;
                          const copy = { ...prevUnread };
                          delete copy[next];
                          return copy;
                        });
                      }
                      return next;
                    });
                  }
                }}
              >
                <div style={touchAvatarStyle}>
                  {chat.avatar_url ? (
                    <img
                      src={chat.avatar_url}
                      alt={`${chat.username} avatar`}
                      style={touchAvatarImageStyle}
                    />
                  ) : (
                    <span style={{ fontSize: 12, opacity: 0.72 }}>
                      {(chat.username[0] ?? "?").toUpperCase()}
                    </span>
                  )}
                </div>
                <span style={{ opacity: 0.82 }}>{chat.username}</span>
                {directChatEditMode ? (
                  <div style={touchEditActionsStyle}>
                    <button
                      type="button"
                      onClick={() => moveDirectChat(idx, -1)}
                      disabled={idx === 0 || directChatSavingOrder}
                      style={touchMiniButtonStyle}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => moveDirectChat(idx, 1)}
                      disabled={idx === activeChats.length - 1 || directChatSavingOrder}
                      style={touchMiniButtonStyle}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void removeDirectChat(chat.chat_id);
                      }}
                      disabled={directChatRemovingId === chat.chat_id}
                      style={{ ...touchMiniButtonStyle, opacity: 0.72 }}
                    >
                      {directChatRemovingId === chat.chat_id ? "..." : "delete"}
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {selectedDirectChat ? (
          <div style={{ ...directThreadWrapStyle, marginTop: 10 }}>
            <div style={directThreadHeadStyle}>
              <div style={{ opacity: 0.8 }}>
                chat with {selectedDirectChat.username}
              </div>
            </div>

            <div ref={directMessagesViewportRef} style={directThreadMessagesStyle}>
              {directLoading && directMessages.length === 0 ? (
                <div style={touchMutedStyle}>loading chat...</div>
              ) : directMessages.length === 0 ? (
                <div style={touchMutedStyle}>no messages yet</div>
              ) : (
                directMessages.map((msg) => {
                  const mine = msg.sender_id === userId;
                  return (
                    <div
                      key={`dm-${msg.id}`}
                      style={{
                        ...directMessageRowStyle,
                        justifyContent: mine ? "flex-end" : "flex-start",
                      }}
                    >
                      <div
                        style={{
                          ...directMessageBubbleStyle,
                          borderColor: mine
                            ? "rgba(255,255,255,0.22)"
                            : "rgba(255,255,255,0.12)",
                          background: mine
                            ? "rgba(255,255,255,0.06)"
                            : "rgba(255,255,255,0.03)",
                        }}
                      >
                        {msg.content}
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <div style={directComposerStyle}>
              <textarea
                value={directInput}
                onChange={(e) => setDirectInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void sendDirectMessage();
                  }
                }}
                placeholder={`message ${selectedDirectChat.username}...`}
                style={directComposerInputStyle}
              />
              <button
                type="button"
                onClick={() => {
                  void sendDirectMessage();
                }}
                disabled={directSending || !directInput.trim()}
                style={{
                  ...touchActionButtonStyle,
                  opacity: directSending || !directInput.trim() ? 0.4 : 0.82,
                }}
              >
                {directSending ? "..." : "send"}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  const selectedDirectChat = selectedDirectChatId
    ? activeChats.find((chat) => chat.chat_id === selectedDirectChatId) || null
    : null;

  return (
    <main className="my-home-shell" style={pageStyle}>
      <audio
        ref={ambientAudioRef}
        src={SECONDARY_AMBIENT_SRC}
        preload="auto"
        loop
        playsInline
        style={{ display: "none" }}
      />
{/*  KOZMOS LOGO */}
<div
  style={{
    position: "absolute",
    top: 32,
    left: "50%",
    transform: "translateX(-50%)",
    cursor: "pointer",
    zIndex: 10,
  }}
  onClick={() => router.push("/")}
>
  <Image
    src="/kozmos-logomother1.png"
    alt="Kozmos"
    width={131}
    height={98}
    className="kozmos-logo kozmos-logo-ambient"
    style={{
      width: 80,
      height: "auto",
      opacity: 0.85,
      borderRadius: 6,
      transition:
        "opacity 0.25s ease, box-shadow 0.25s ease, transform 0.08s ease",
    }}
    onMouseEnter={(e) => {
      e.currentTarget.style.opacity = "1";
      e.currentTarget.style.boxShadow =
        "0 0 18px rgba(0,255,170,0.45)";
    }}
    onMouseLeave={(e) => {
      e.currentTarget.style.opacity = "0.85";
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
      <div style={topLeftStyle}>
        <span style={{ cursor: "pointer" }} onClick={() => router.push("/main")}>
          main
        </span>{" "}
        /{" "}
        <span
          style={{ cursor: "pointer" }}
          onClick={() => router.refresh()}
        >
          my home
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
      {isMobileLayout ? (
        <div
          onClick={() => {
            setLumiMobileTapHintVisible(true);
            if (lumiMobileTapHintTimerRef.current !== null) {
              window.clearTimeout(lumiMobileTapHintTimerRef.current);
            }
            lumiMobileTapHintTimerRef.current = window.setTimeout(() => {
              setLumiMobileTapHintVisible(false);
              lumiMobileTapHintTimerRef.current = null;
            }, 900);
          }}
          style={{
            position: "absolute",
            left: 44,
            top: 71,
            width: holoShipWidth,
            opacity: 0.78,
            pointerEvents: "auto",
            userSelect: "none",
            zIndex: 3,
            cursor: "pointer",
          }}
        >
          <img
            src={LUMI_SHIP_SRC}
            alt=""
            aria-hidden
            draggable={false}
            className="lumi-ship-mobile-hover"
            style={touchHoloShipImageMobileStyle}
          />
          <span
            className="lumi-ship-label"
            aria-hidden
            style={{
              position: "absolute",
              left: "50%",
              top: "calc(100% - 16px)",
              transform: "translateX(-50%)",
              fontSize: 11,
              letterSpacing: "0.14em",
              color: "rgba(196, 236, 255, 0.9)",
              textShadow:
                "0 0 6px rgba(160,220,255,0.55), 0 0 14px rgba(112,196,255,0.34)",
              opacity: lumiMobileTapHintVisible ? 1 : 0,
              transition: "opacity 280ms ease",
              pointerEvents: "none",
              userSelect: "none",
            }}
          >
            Lumi
          </span>
        </div>
      ) : null}

      {/* TOP RIGHT */}
      <div style={topRightStyle}>
        <span
          style={{ cursor: "pointer", opacity: 0.8 }}
          onClick={() => router.push("/account")}
        >
          {displayUsername}
        </span>
        {" / "}
        <span style={{ cursor: "pointer" }} onClick={handleLogout}>
          logout
        </span>
      </div>

      {!isMobileLayout ? <div style={touchDockStyle}>{renderTouchPanel()}</div> : null}
      {!isMobileLayout ? <div style={directChatDockStyle}>{renderDirectChatPanel()}</div> : null}

      {/* CONTENT */}
      <div style={contentStyle}>
        <div style={{ opacity: 0.6, marginBottom: 6 }}>
          this is your space.
        </div>

        <div style={labelStyle}>keep your notes here</div>

        <textarea
          value={noteInput}
          onChange={(e) => setNoteInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void saveNote();
            }
          }}
          placeholder="write something..."
          style={textareaStyle}
        />

        <div style={saveStyle} onClick={saveNote}>
          {loading ? "saving..." : "save"}
        </div>

        {/* NOTES */}
        <div style={notesShellStyle}>
          {!notesBootstrapping ? (
            <div
              aria-hidden
              className={
                isMobileLayout
                  ? "ufo-ambient-faint"
                  : `ufo-ambient-faint ufo-ambient-beam ${ufoBeamActive ? "ufo-beam-on" : ufoBeamHasFired ? "ufo-beam-off" : "ufo-beam-idle"}`
              }
              style={{
                position: "absolute",
                inset: 0,
                pointerEvents: "none",
                zIndex: 0,
                backgroundImage: `url('${AXY_SHIP_SRC}')`,
                backgroundRepeat: "no-repeat",
                backgroundPosition: "center 62%",
                backgroundSize: "min(380px, 82%) auto",
                mixBlendMode: "screen",
                opacity: 0.16,
                WebkitMaskImage:
                  "radial-gradient(circle at 50% 62%, rgba(0,0,0,0.94) 0%, rgba(0,0,0,0.8) 52%, rgba(0,0,0,0.34) 72%, rgba(0,0,0,0) 88%)",
                maskImage:
                  "radial-gradient(circle at 50% 62%, rgba(0,0,0,0.94) 0%, rgba(0,0,0,0.8) 52%, rgba(0,0,0,0.34) 72%, rgba(0,0,0,0) 88%)",
              }}
            />
          ) : null}
          <div style={notesListStyle}>
          {notesBootstrapping ? (
            <div aria-hidden style={{ position: "relative", zIndex: 1, height: "100%" }}>
              <div
                className={
                  isMobileLayout
                    ? "ufo-boot-glow-soft"
                    : `ufo-boot-glow ufo-ambient-beam ${ufoBeamActive ? "ufo-beam-on" : ufoBeamHasFired ? "ufo-beam-off" : "ufo-beam-idle"}`
                }
                style={isMobileLayout ? notesBootPlaceholderMobileStyle : notesBootPlaceholderStyle}
              />
              <div
                style={{
                  position: "absolute",
                  left: "50%",
                  bottom: 14,
                  transform: "translateX(-50%)",
                  fontSize: 11,
                  letterSpacing: "0.12em",
                  opacity: 0.42,
                  color: "rgba(226,236,255,0.9)",
                  textShadow: "0 0 8px rgba(180,210,255,0.32)",
                  textTransform: "lowercase",
                }}
              >
                syncing notes...
              </div>
            </div>
          ) : (
            <div style={{ position: "relative", zIndex: 1 }}>
              {notes.map((note) => (
                <div
                  key={note.id}
                  style={{
                    ...noteStyle,
                    display: "flex",
                    gap: 16,
                    justifyContent: "space-between",
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={noteContentStyle}>
                      {note.content}
                    </div>

                    {axyReflection[note.id] && (
                      <div
                        style={{
                          marginTop: 8,
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
                            setAxyFadeId(note.id);

                            setAxyReflection((prev) => {
                              const copy = { ...prev };
                              delete copy[note.id];
                              return copy;
                            });

                            setTimeout(() => {
                              setAxyFadeId(null);
                            }, 400);
                          }}
                        >
                          Axy reflects:
                        </span>
                        {axyReflection[note.id]}
                      </div>
                    )}

                    <div style={noteActionsStyle}>
                      <span onClick={() => deleteNote(note.id)}>delete</span>
                    </div>
                  </div>

                  {/* AXY LOGO */}
                  <Image
                    src="/axy-logofav.png"
                    alt="Axy"
                    width={22}
                    height={22}
                    style={{
                      width: 22,
                      height: 22,
                      cursor: "pointer",
                      opacity: axyFadeId === note.id ? 0.25 : 0.6,
                      transform: axyPulseId === note.id ? "scale(1.2)" : "scale(1)",
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
                      setAxyPulseId(note.id);
                      askAxy(note.id, note.content);

                      setTimeout(() => {
                        setAxyPulseId(null);
                      }, 300);
                    }}
                  />

                </div>
              ))}
            </div>
          )}
          </div>
        </div>

        {isMobileLayout ? (
          <div style={touchMobileWrapStyle}>
            {renderTouchPanel()}
            <div style={touchMobileSecondaryWrapStyle}>{renderDirectChatPanel()}</div>
          </div>
        ) : null}

        <div style={personalAxyWrapStyle}>
          <div
            className={`axy-shell${personalAxyOpen ? " open" : ""}`}
            onClick={() => setPersonalAxyOpen((prev) => !prev)}
            role="button"
            tabIndex={0}
            aria-expanded={personalAxyOpen}
            style={personalAxyShellStyle}
          >
            <Image
              src="/axy-banner.png"
              alt="Personal Axy"
              width={504}
              height={360}
              className="axy-shell-logo"
              style={personalAxyLogoStyle}
            />

            <div
              className="axy-shell-chat"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="axy-shell-card" style={personalAxyCardStyle}>
                <div style={{ marginBottom: 8, opacity: 0.8, fontSize: 11 }}>
                  {personalAxyReply ? (
                    personalAxyReply
                  ) : (
                    <>
                      I&apos;m <span className="axy-name-glow">Axy</span>. I am present inside Kozmos&middot;
                    </>
                  )}
                </div>

                {personalLastMessage ? (
                  <div
                    style={{
                      marginBottom: 8,
                      fontSize: 11,
                      color: "rgba(150, 95, 210, 0.9)",
                    }}
                  >
                    {personalLastMessage}
                  </div>
                ) : null}

                <input
                  value={personalAxyInput}
                  onChange={(e) => setPersonalAxyInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && askPersonalAxy()}
                  placeholder="say something"
                  style={personalAxyInputStyle}
                />

                <div style={personalAxyActionsStyle}>
                  <span
                    className="kozmos-tap"
                    onClick={askPersonalAxy}
                    style={{ cursor: "pointer" }}
                  >
                    {personalAxyLoading ? "..." : "ask"}
                  </span>
                  <span
                    className="kozmos-tap"
                    onClick={resetPersonalAxy}
                    style={{ cursor: "pointer" }}
                  >
                    reset
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

/* styles */

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  background: "#0b0b0b",
  color: "#eaeaea",
  padding: 40,
  position: "relative",
  userSelect: "none",
  WebkitUserSelect: "none",
};

const topLeftStyle: React.CSSProperties = {
  position: "absolute",
  top: 16,
  left: 16,
  fontSize: 12,
  letterSpacing: "0.12em",
  opacity: 0.6,
  cursor: "default",
  userSelect: "none",
};

const topRightStyle: React.CSSProperties = {
  position: "absolute",
  top: 16,
  right: 16,
  fontSize: 12,
  letterSpacing: "0.12em",
  opacity: 0.6,
  cursor: "default",
  userSelect: "none",
};

const contentStyle: React.CSSProperties = {
  maxWidth: 580,
  margin: "120px auto 0",
  paddingBottom: 36,
};

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  letterSpacing: "0.12em",
  opacity: 0.6,
  marginBottom: 12,
};

const textareaStyle: React.CSSProperties = {
  width: "100%",
  minHeight: 120,
  background: "transparent",
  border: "1px solid rgba(255,255,255,0.2)",
  color: "#eaeaea",
  padding: 16,
  resize: "none",
  outline: "none",
  fontSize: 14,
  lineHeight: 1.6,
  userSelect: "text",
  WebkitUserSelect: "text",
};

const saveStyle: React.CSSProperties = {
  marginTop: 12,
  fontSize: 12,
  letterSpacing: "0.12em",
  opacity: 0.6,
  cursor: "pointer",
};

const noteStyle: React.CSSProperties = {
  marginBottom: 14,
  paddingBottom: 10,
  borderBottom: "1px solid rgba(255,255,255,0.08)",
};

const noteActionsStyle: React.CSSProperties = {
  marginTop: 6,
  fontSize: 12,
  opacity: 0.5,
  cursor: "pointer",
};

const notesShellStyle: React.CSSProperties = {
  marginTop: 24,
  height: "clamp(340px, 46vh, 560px)",
  maxHeight: "clamp(340px, 46vh, 560px)",
  position: "relative",
};

const notesListStyle: React.CSSProperties = {
  height: "100%",
  maxHeight: "100%",
  overflowY: "auto",
  overflowX: "hidden",
  paddingRight: 8,
  position: "relative",
  zIndex: 1,
};

const notesBootPlaceholderStyle: React.CSSProperties = {
  height: "100%",
  background: `url('${AXY_SHIP_SRC}') no-repeat center 62% / min(380px, 82%) auto`,
  mixBlendMode: "screen",
  WebkitMaskImage:
    "radial-gradient(circle at 50% 62%, rgba(0,0,0,0.98) 0%, rgba(0,0,0,0.92) 42%, rgba(0,0,0,0.44) 66%, rgba(0,0,0,0) 84%)",
  maskImage:
    "radial-gradient(circle at 50% 62%, rgba(0,0,0,0.98) 0%, rgba(0,0,0,0.92) 42%, rgba(0,0,0,0.44) 66%, rgba(0,0,0,0) 84%)",
};

const notesBootPlaceholderMobileStyle: React.CSSProperties = {
  ...notesBootPlaceholderStyle,
  mixBlendMode: "normal",
  WebkitMaskImage: "none",
  maskImage: "none",
  opacity: 0.2,
};

const noteContentStyle: React.CSSProperties = {
  whiteSpace: "pre-wrap",
  lineHeight: 1.45,
  userSelect: "text",
  WebkitUserSelect: "text",
};

const touchDockStyle: React.CSSProperties = {
  position: "absolute",
  left: 44,
  top: 214,
  width: "clamp(180px, calc((100vw - 700px) / 2), 360px)",
};

const directChatDockStyle: React.CSSProperties = {
  position: "absolute",
  right: 44,
  top: 214,
  width: "clamp(180px, calc((100vw - 700px) / 2), 360px)",
};

const directThreadWrapStyle: React.CSSProperties = {
  marginTop: 16,
  border: "1px solid rgba(255,255,255,0.14)",
  borderRadius: 12,
  padding: "10px 12px",
  background: "rgba(255,255,255,0.02)",
};

const directThreadHeadStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  fontSize: 12,
  letterSpacing: "0.08em",
  marginBottom: 8,
};

const directThreadMessagesStyle: React.CSSProperties = {
  minHeight: 84,
  maxHeight: 220,
  overflowY: "auto",
  overflowX: "hidden",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 10,
  padding: "8px 8px",
  background: "rgba(0,0,0,0.18)",
};

const directMessageRowStyle: React.CSSProperties = {
  display: "flex",
  width: "100%",
  marginBottom: 6,
};

const directMessageBubbleStyle: React.CSSProperties = {
  maxWidth: "85%",
  fontSize: 12,
  lineHeight: 1.4,
  padding: "6px 8px",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 8,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  userSelect: "text",
  WebkitUserSelect: "text",
};

const directComposerStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  marginTop: 8,
  alignItems: "flex-end",
};

const directComposerInputStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 52,
  maxHeight: 120,
  resize: "none",
  outline: "none",
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 8,
  background: "rgba(255,255,255,0.03)",
  color: "#eaeaea",
  padding: "8px 10px",
  fontSize: 12,
  lineHeight: 1.4,
  userSelect: "text",
  WebkitUserSelect: "text",
};

const touchMobileWrapStyle: React.CSSProperties = {
  marginTop: 14,
  marginBottom: 12,
};

const touchMobileSecondaryWrapStyle: React.CSSProperties = {
  marginTop: 10,
};

const touchPanelStyle: React.CSSProperties = {
  width: "100%",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 10,
  padding: "12px 14px",
  background: "rgba(255,255,255,0.02)",
  position: "relative",
};

const touchHoloShipStyle: React.CSSProperties = {
  position: "absolute",
  left: 18,
  top: -128,
  width: 140,
  height: "auto",
  opacity: 0.72,
  pointerEvents: "auto",
  userSelect: "none",
  cursor: "pointer",
  zIndex: 1,
};

const touchHoloShipImageStyle: React.CSSProperties = {
  width: "100%",
  height: "auto",
  display: "block",
  pointerEvents: "none",
  userSelect: "none",
};

const touchHoloShipImageMobileStyle: React.CSSProperties = {
  ...touchHoloShipImageStyle,
  filter:
    "drop-shadow(10px 0 8px rgba(132,212,255,0.18)) drop-shadow(-10px 0 8px rgba(154,216,255,0.16))",
  opacity: 0.76,
};

const touchHoloFlightOverlayStyle: React.CSSProperties = {
  position: "fixed",
  width: 140,
  height: "auto",
  pointerEvents: "none",
  userSelect: "none",
  zIndex: 4,
  opacity: 0.76,
  filter:
    "drop-shadow(0 0 12px rgba(224,236,255,0.26)) drop-shadow(0 0 22px rgba(188,210,246,0.18))",
};

const touchPanelContentLayerStyle: React.CSSProperties = {
  position: "relative",
  zIndex: 2,
};

const touchMutedStyle: React.CSSProperties = {
  fontSize: 12,
  opacity: 0.48,
};

const touchPanelHeadStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginBottom: 10,
};

const touchEditButtonStyle: React.CSSProperties = {
  border: "1px solid rgba(255,255,255,0.16)",
  borderRadius: 999,
  background: "transparent",
  color: "#eaeaea",
  fontSize: 10,
  letterSpacing: "0.08em",
  padding: "3px 10px",
  opacity: 0.7,
  cursor: "pointer",
};

const touchListStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const touchUserRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  minWidth: 0,
};

const touchEditActionsStyle: React.CSSProperties = {
  marginLeft: "auto",
  display: "flex",
  gap: 6,
};

const touchOneToOneButtonStyle: React.CSSProperties = {
  marginLeft: "auto",
  border: "1px solid rgba(255,255,255,0.2)",
  borderRadius: 999,
  background: "transparent",
  color: "#eaeaea",
  fontSize: 10,
  letterSpacing: "0.08em",
  padding: "2px 8px",
  cursor: "pointer",
  opacity: 0.8,
};

const touchMiniButtonStyle: React.CSSProperties = {
  border: "1px solid rgba(255,255,255,0.16)",
  borderRadius: 999,
  background: "transparent",
  color: "#eaeaea",
  fontSize: 10,
  letterSpacing: "0.04em",
  padding: "2px 8px",
  cursor: "pointer",
  opacity: 0.78,
};

const touchAvatarStyle: React.CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: "50%",
  border: "1px solid rgba(255,255,255,0.2)",
  overflow: "hidden",
  display: "grid",
  placeItems: "center",
  background: "rgba(255,255,255,0.05)",
  flexShrink: 0,
};

const touchAvatarImageStyle: React.CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "cover",
  display: "block",
};

const touchRequestRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 999,
  padding: "6px 8px",
};

const touchActionButtonStyle: React.CSSProperties = {
  border: "1px solid rgba(255,255,255,0.22)",
  borderRadius: 999,
  background: "transparent",
  color: "#eaeaea",
  padding: "2px 10px",
  fontSize: 11,
  letterSpacing: "0.08em",
  cursor: "pointer",
  opacity: 0.82,
};

const personalAxyWrapStyle: React.CSSProperties = {
  marginTop: 72,
  marginBottom: 28,
  display: "flex",
  justifyContent: "center",
};

const personalAxyShellStyle: React.CSSProperties = {
  width: "min(280px, 88vw)",
  minHeight: 120,
};

const personalAxyLogoStyle: React.CSSProperties = {
  width: "min(120px, 62%)",
};

const personalAxyCardStyle: React.CSSProperties = {
  width: "min(220px, 84vw)",
  minHeight: 108,
  padding: 10,
};

const personalAxyInputStyle: React.CSSProperties = {
  width: "100%",
  background: "transparent",
  border: "none",
  borderBottom: "1px solid rgba(255,255,255,0.2)",
  color: "#eaeaea",
  fontSize: 11,
  outline: "none",
};

const personalAxyActionsStyle: React.CSSProperties = {
  marginTop: 8,
  display: "flex",
  gap: 12,
  justifyContent: "center",
  fontSize: 10,
  opacity: 0.65,
};


