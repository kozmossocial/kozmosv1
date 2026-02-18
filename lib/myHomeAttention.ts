const MY_HOME_ATTENTION_PENDING_PREFIX = "kozmos:my-home-attn:";
const MY_HOME_LAST_VISIT_PREFIX = "kozmos:my-home-last-visit:";

type DirectChatAttentionRow = {
  updated_at?: string;
  last_message_sender_id?: string;
  last_message_created_at?: string;
};

type KeepInTouchIncomingRow = {
  request_created_at?: string;
  request_updated_at?: string;
};

function pendingKey(userId: string) {
  return `${MY_HOME_ATTENTION_PENDING_PREFIX}${userId}`;
}

function lastVisitKey(userId: string) {
  return `${MY_HOME_LAST_VISIT_PREFIX}${userId}`;
}

function parseMs(value: string | null) {
  const ms = Number(value || "");
  return Number.isFinite(ms) ? ms : 0;
}

function parseIsoMs(value: string | undefined) {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? ms : 0;
}

export function getMyHomeAttentionPending(userId: string) {
  if (!userId || typeof window === "undefined") return false;
  return window.localStorage.getItem(pendingKey(userId)) === "1";
}

export function markMyHomeVisited(userId: string) {
  if (!userId || typeof window === "undefined") return;
  window.localStorage.setItem(lastVisitKey(userId), String(Date.now()));
  window.localStorage.setItem(pendingKey(userId), "0");
}

export async function refreshMyHomeAttention(userId: string, accessToken: string) {
  if (!userId || !accessToken || typeof window === "undefined") return false;

  const prevPending = getMyHomeAttentionPending(userId);
  const lastVisitMs = parseMs(window.localStorage.getItem(lastVisitKey(userId)));

  try {
    const [directRes, touchRes] = await Promise.all([
      fetch("/api/direct-chats", {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
      fetch("/api/keep-in-touch", {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
    ]);

    const directBody = (await directRes.json().catch(() => ({}))) as {
      chats?: DirectChatAttentionRow[];
    };
    const touchBody = (await touchRes.json().catch(() => ({}))) as {
      incoming?: KeepInTouchIncomingRow[];
    };

    if (!directRes.ok || !touchRes.ok) return prevPending;

    const hasNewDm = (directBody.chats || []).some((chat) => {
      const senderId = String(chat.last_message_sender_id || "").trim();
      if (!senderId || senderId === userId) return false;
      const messageMs = parseIsoMs(chat.last_message_created_at) || parseIsoMs(chat.updated_at);
      return messageMs > lastVisitMs;
    });

    const hasNewFriendRequest = (touchBody.incoming || []).some((row) => {
      const requestMs =
        parseIsoMs(row.request_created_at) || parseIsoMs(row.request_updated_at);
      return requestMs > lastVisitMs;
    });

    const nextPending = prevPending || hasNewDm || hasNewFriendRequest;
    window.localStorage.setItem(pendingKey(userId), nextPending ? "1" : "0");
    return nextPending;
  } catch {
    return prevPending;
  }
}
