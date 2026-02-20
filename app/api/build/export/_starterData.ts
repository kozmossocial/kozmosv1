import { supabaseAdmin } from "@/lib/supabaseAdmin";

type StarterExportPayload = {
  version: 1;
  exported_at: string;
  space_id: string;
  mode: Record<string, unknown> | null;
  starter_users: Array<Record<string, unknown>>;
  friend_requests: Array<Record<string, unknown>>;
  friendships: Array<Record<string, unknown>>;
  posts: Array<Record<string, unknown>>;
  comments: Array<Record<string, unknown>>;
  likes: Array<Record<string, unknown>>;
  dm_threads: Array<Record<string, unknown>>;
  dm_participants: Array<Record<string, unknown>>;
  dm_messages: Array<Record<string, unknown>>;
};

async function safeSelect(table: string, columns: string, spaceId: string) {
  const { data, error } = await (supabaseAdmin as never as {
    from: (tableName: string) => {
      select: (cols: string) => {
        eq: (column: string, value: string) => Promise<{ data: unknown; error: unknown }>;
      };
    };
  })
    .from(table)
    .select(columns)
    .eq("space_id", spaceId);
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

function asRecordList(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((row) => row && typeof row === "object")
    .map((row) => row as Record<string, unknown>);
}

export async function exportStarterData(spaceId: string): Promise<StarterExportPayload> {
  const [modeRes, users, friendReqs, friendships, posts, comments, likes, threads, participants, messages] =
    await Promise.all([
      supabaseAdmin
        .from("user_build_backend_modes")
        .select(
          "space_id, enabled, posts_quota, comments_quota, likes_quota, dm_threads_quota, dm_messages_quota, starter_users_quota, friend_requests_quota, friendships_quota, updated_at"
        )
        .eq("space_id", spaceId)
        .maybeSingle(),
      safeSelect(
        "user_build_starter_users",
        "id, space_id, username, username_key, password_salt, password_hash, display_name, profile, created_at, updated_at",
        spaceId
      ),
      safeSelect(
        "user_build_starter_friend_requests",
        "id, space_id, from_user_id, to_user_id, status, created_at, updated_at",
        spaceId
      ),
      safeSelect(
        "user_build_starter_friendships",
        "id, space_id, user_a_id, user_b_id, created_at",
        spaceId
      ),
      safeSelect(
        "user_build_backend_posts",
        "id, space_id, author_id, body, meta, created_at, updated_at",
        spaceId
      ),
      safeSelect(
        "user_build_backend_comments",
        "id, space_id, post_id, author_id, body, meta, created_at, updated_at",
        spaceId
      ),
      safeSelect(
        "user_build_backend_likes",
        "id, space_id, post_id, user_id, created_at",
        spaceId
      ),
      safeSelect(
        "user_build_backend_dm_threads",
        "id, space_id, created_by, subject, metadata, created_at, updated_at",
        spaceId
      ),
      safeSelect(
        "user_build_backend_dm_participants",
        "id, space_id, thread_id, user_id, can_write, created_at",
        spaceId
      ),
      safeSelect(
        "user_build_backend_dm_messages",
        "id, space_id, thread_id, sender_id, body, metadata, created_at",
        spaceId
      ),
    ]);

  if (modeRes.error) throw modeRes.error;

  return {
    version: 1,
    exported_at: new Date().toISOString(),
    space_id: spaceId,
    mode: (modeRes.data as Record<string, unknown> | null) || null,
    starter_users: asRecordList(users),
    friend_requests: asRecordList(friendReqs),
    friendships: asRecordList(friendships),
    posts: asRecordList(posts),
    comments: asRecordList(comments),
    likes: asRecordList(likes),
    dm_threads: asRecordList(threads),
    dm_participants: asRecordList(participants),
    dm_messages: asRecordList(messages),
  };
}
