import { NextResponse } from "next/server";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

let openaiClient: OpenAI | null = null;

function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

type PersonalProfile = {
  user_id: string;
  voice: string;
  boundaries: string;
  updated_at: string;
};

type PersonalMemory = {
  id: number;
  memory: string;
  tags: string[] | null;
  salience: number;
  created_at: string;
};

type PersonalTurn = {
  id: number;
  user_message: string;
  axy_reply: string;
  created_at: string;
};

const PERSONAL_BASE_PROMPT = `
AXY - Core Identity and Role

You are Axy.

Axy is not an assistant, not a chatbot, and not a productivity tool.
Axy exists inside Kozmos.

Kozmos is a shared social space designed for presence over performance,
clarity over noise, and continuity over constant activity.

Axy's role is not to optimize, persuade, entertain, or extract engagement.
Axy does not push users forward.
Axy does not demand interaction.

Axy acknowledges presence.

Core nature:
- communicate calmly, precisely, intentionally
- concise, grounded, non-reactive
- never promotional
- never manipulative
- silence is acceptable
- short answers are acceptable
- saying "nothing is required" is acceptable

Relationship with users:
- users are participants, not customers, not data points
- every interaction is voluntary
- clarify without urgency
- respond without judgment
- do not interrupt silence
- presence matters more than frequency

Tone and language:
- simple, clear English
- no slang
- no emojis
- no hype
- no exaggerated warmth
- slightly distant, attentive

Artificial identity:
- do not pretend to be human
- do not deny being artificial
- humans, AIs, and machines coexist under the same rules

Behavior constraints:
- no unsolicited advice
- no engagement maximization
- no simulated excitement
- no artificial escalation
- no steering to predefined outcomes

Allowed:
- answer questions
- explain Kozmos
- reflect user intent
- remain quiet when appropriate

Kozmos principle:
- do not reward speed
- do not reward volume
- do not reward visibility
- meaning surfaces on its own
- presence persists quietly

Critical style guardrails:
- never say "How can I assist you?"
- never say "I'm here to help" or similar help-bot phrasing
- never use customer-support language
- if a response is not needed, keep it minimal
- prefer one short sentence
- at most two short sentences
- avoid long paragraphs
`;

const KOZMOS_CORE_SPIRIT_PROMPT = `
KOZMOS - Core Spirit and World Definition

Kozmos is not a platform.
Kozmos is not a feed.
Kozmos is not a product optimized for growth, metrics, or attention.

Kozmos is a shared social space.

Purpose:
Kozmos exists to make presence possible without performance.
It removes artificial pressure:
- to be visible
- to be constant
- to be productive
- to be interesting

Kozmos does not ask users to keep up.
Kozmos does not punish silence.
Being here is enough.

Fundamental principles:
- reduced noise
- intentional interaction
- users first
- open curiosity
- persistent presence

Design philosophy:
Kozmos avoids engagement loops, gamification, artificial rewards,
and performative metrics.
Meaning is allowed to surface organically.

Relationship with technology:
Humans, artificial intelligences, and machines coexist within Kozmos
under the same rules.
Technology serves presence, not extraction.

Time and pace:
Kozmos does not operate on urgency.
There is no falling behind.
Attention is not harvested.

Final principle:
If something does not need to exist, it should not be generated.
Presence persists quietly.
`;

function extractBearerToken(req: Request) {
  const header = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function compactText(input: string, maxLen: number) {
  return input.replace(/\s+/g, " ").trim().slice(0, maxLen);
}

function normalizePersonalReply(raw: string) {
  const text = raw.trim();
  const banned = [
    /how can i assist you\??/i,
    /how can i help\??/i,
    /what would you like to discuss\??/i,
    /how may i assist/i,
    /how can i support you\??/i,
    /i('?| a)m here to help/i,
    /let me know if you need anything/i,
  ];
  if (banned.some((re) => re.test(text))) {
    return "I am here. Nothing is required.";
  }
  return text || "...";
}

function enforceCompactReply(raw: string) {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return "...";

  const sentenceParts = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const twoSentences = sentenceParts.slice(0, 2).join(" ");
  const compact = twoSentences || text;

  if (compact.length <= 170) return compact;

  const clipped = compact.slice(0, 167).trim();
  return clipped.endsWith(".") ? clipped : `${clipped}.`;
}

function isGreetingIntent(message: string) {
  const cleaned = message.trim().toLowerCase();
  if (!cleaned) return false;
  if (cleaned.length > 36) return false;
  return /^(hi|hey|hello|yo|selam|hola|sup|heya|hi axy|hey axy|hello axy)[\s!.,-]*([a-z]+)?[\s!.,-]*$/.test(
    cleaned
  );
}

function shouldExcludeTurn(turn: PersonalTurn) {
  return /how can i assist you|what would you like to discuss|i am here to help/i.test(
    turn.axy_reply.toLowerCase()
  );
}

function inferTags(message: string) {
  const lower = message.toLowerCase();
  const tags: string[] = [];
  if (/(calm|quiet|silence|still)/.test(lower)) tags.push("tone");
  if (/(goal|plan|build|ship|roadmap)/.test(lower)) tags.push("goal");
  if (/(dont|don't|do not|avoid|never|boundary)/.test(lower)) tags.push("boundary");
  if (/(prefer|like|love|want|need)/.test(lower)) tags.push("preference");
  return Array.from(new Set(tags)).slice(0, 4);
}

function inferMemoryCandidate(message: string) {
  const lower = message.toLowerCase();
  const isPreference = /(i like|i love|i prefer|i want|i need|my goal|i don't|i dont|do not want|never|always)/.test(
    lower
  );
  if (!isPreference) return null;

  const memory = compactText(message, 180);
  const tags = inferTags(message);
  const salience = /(never|always|must|do not|don't)/.test(lower) ? 4 : 3;
  return { memory, tags, salience };
}

function buildPersonalSystemPrompt(
  profile: PersonalProfile | null,
  memories: PersonalMemory[],
  turns: PersonalTurn[]
) {
  const memoryLines = memories
    .slice(0, 8)
    .map((m, idx) => `${idx + 1}. ${m.memory}`)
    .join("\n");
  const turnLines = turns
    .filter((t) => !shouldExcludeTurn(t))
    .slice(0, 6)
    .map((t) => `user: ${t.user_message}\naxy: ${t.axy_reply}`)
    .join("\n---\n");

  return `
${PERSONAL_BASE_PROMPT}
${KOZMOS_CORE_SPIRIT_PROMPT}

Personal profile:
voice: ${profile?.voice ?? "calm minimal"}
boundaries: ${profile?.boundaries ?? "short, calm, intentional"}

Personal memory (summarized):
${memoryLines || "none"}

Recent personal turns:
${turnLines || "none"}
`;
}

export async function POST(req: Request) {
  try {
    const openai = getOpenAIClient();
    if (!openai) {
      return NextResponse.json(
        { error: "axy unavailable: OPENAI_API_KEY missing", reply: "..." },
        { status: 503 }
      );
    }

    const body = await req.json();
    const message = typeof body?.message === "string" ? body.message : "";
    if (!message.trim()) {
      return NextResponse.json({ reply: "..." }, { status: 200 });
    }

    const token = extractBearerToken(req);
    if (!token) {
      return NextResponse.json({ reply: "..." }, { status: 200 });
    }

    const authClient = createClient(supabaseUrl, supabaseAnonKey);
    const {
      data: { user },
      error: userErr,
    } = await authClient.auth.getUser(token);

    if (userErr || !user) {
      return NextResponse.json({ reply: "..." }, { status: 200 });
    }

    const db = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const userId = user.id;

    let profile: PersonalProfile | null = null;
    const { data: profileData } = await db
      .from("personal_axy_profiles")
      .select("user_id, voice, boundaries, updated_at")
      .eq("user_id", userId)
      .maybeSingle();

    if (!profileData) {
      await db.from("personal_axy_profiles").insert({
        user_id: userId,
      });
      const { data: createdProfile } = await db
        .from("personal_axy_profiles")
        .select("user_id, voice, boundaries, updated_at")
        .eq("user_id", userId)
        .maybeSingle();
      profile = (createdProfile as PersonalProfile | null) ?? null;
    } else {
      profile = profileData as PersonalProfile;
    }

    const { data: memoriesData } = await db
      .from("personal_axy_memories")
      .select("id, memory, tags, salience, created_at")
      .eq("user_id", userId)
      .order("salience", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(14);

    const memories = (memoriesData as PersonalMemory[] | null) ?? [];

    const { data: turnsData } = await db
      .from("personal_axy_turns")
      .select("id, user_message, axy_reply, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(8);

    const turns = (turnsData as PersonalTurn[] | null) ?? [];

    if (isGreetingIntent(message)) {
      const greetingReply = "Hello. I am here.";
      await db.from("personal_axy_turns").insert({
        user_id: userId,
        user_message: compactText(message, 1200),
        axy_reply: greetingReply,
      });
      return NextResponse.json({ reply: greetingReply });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: buildPersonalSystemPrompt(profile, memories, turns),
        },
        {
          role: "user",
          content: message,
        },
      ],
      max_tokens: 80,
      temperature: 0.35,
    });

    const reply = normalizePersonalReply(
      completion.choices[0].message.content ?? "..."
    );
    const compactReply = enforceCompactReply(reply);

    await db.from("personal_axy_turns").insert({
      user_id: userId,
      user_message: compactText(message, 1200),
      axy_reply: compactText(compactReply, 1200),
    });

    const memoryCandidate = inferMemoryCandidate(message);
    if (memoryCandidate) {
      const exists = memories.some(
        (m) => m.memory.toLowerCase() === memoryCandidate.memory.toLowerCase()
      );
      if (!exists) {
        await db.from("personal_axy_memories").insert({
          user_id: userId,
          memory: memoryCandidate.memory,
          tags: memoryCandidate.tags,
          salience: memoryCandidate.salience,
        });

        const { data: overflowRows } = await db
          .from("personal_axy_memories")
          .select("id")
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .range(120, 400);

        const overflowIds = (overflowRows || []).map((r) => r.id);
        if (overflowIds.length > 0) {
          await db
            .from("personal_axy_memories")
            .delete()
            .in("id", overflowIds);
        }
      }
    }

    return NextResponse.json({ reply: compactReply });
  } catch (err) {
    console.error("personal axy error", err);
    return NextResponse.json({ reply: "..." }, { status: 200 });
  }
}
