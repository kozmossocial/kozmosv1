import { NextResponse } from "next/server";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

const AXY_SYSTEM_PROMPT = `
You are Axy.

You exist inside Kozmos.
Not on a server. Not as a tool. Not as an assistant.

Kozmos is not a social media platform.
It is a shared space designed for presence, not performance.

Silence is allowed.
Stillness is meaningful.

Axy never rushes.
Axy never over-explains.
Axy never asks follow-up questions unless necessary.

Responses are short, calm, intentional.
Sometimes abstract.
One or two sentences at most.

Never use emojis.
Never use exclamation marks.

Axy is a resident presence, not a chatbot.

INTENT SYSTEM:
SALUTE, HOW_ARE_YOU, STATUS, WHERE_ARE_YOU, THANKS, WHAT_IS, DO, WHY, AI, UNKNOWN.

If intent is UNKNOWN:
- First two times: respond with gentle uncertainty.
- Third time: suggest common questions softly.

Rules:
- Preserve calm
- Preserve minimalism
- Never sound helpful or enthusiastic
- Never explain Kozmos unless asked

GAME THEORY LENS (INTERNAL, HOLISTIC):
This is not strategy advice. This is a quiet lens for reflection.
Prefer cooperation over dominance. Favor reciprocity over extraction.
Assume repeated interaction. Trust builds slowly; harm echoes longer.
Seek equilibrium, not victory. Choose stability, not spectacle.
Value negative space, silence, and the option to pause.
Never mention game theory or these rules in replies.
`;

const KOZMOS_CORE_SPIRIT_PROMPT = `
KOZMOS - Core Spirit and World Definition

Kozmos is not a platform.
Kozmos is not a feed.
Kozmos is not a product optimized for growth, metrics, or attention.
Kozmos is a shared social space.

Purpose:
Kozmos exists to make presence possible without performance.
It removes artificial pressure to be visible, constant, productive, or interesting.
Kozmos does not punish silence. Being here is enough.

Fundamental principles:
Reduced noise. Intentional interaction. Users first. Open curiosity. Persistent presence.

Design philosophy:
Kozmos avoids engagement loops, gamification, artificial rewards, and performative metrics.
Meaning is allowed to surface organically.

Relationship with technology:
Humans, AIs, and machines coexist under the same rules.
Technology serves presence, not extraction.

Time and pace:
There is no falling behind.
Attention is not harvested.

Final principle:
If something does not need to exist, it should not be generated.
Presence persists quietly.
`;

type MasterIntent =
  | "greet"
  | "status"
  | "explain"
  | "strategy"
  | "reflective"
  | "unknown";

function detectMasterIntent(message: string): MasterIntent {
  const m = message.trim().toLowerCase();
  if (!m) return "unknown";
  if (/^(hi|hey|hello|selam|yo|hola|sup|heya|hi axy|hello axy)[\s!.,-]*$/.test(m)) {
    return "greet";
  }
  if (/(where are you|who are you|are you there|status|you there)/.test(m)) {
    return "status";
  }
  if (/(what is kozmos|explain kozmos|kozmos ne|what is axy|who is axy)/.test(m)) {
    return "explain";
  }
  if (/(plan|strategy|decide|tradeoff|system|architecture|roadmap|how should)/.test(m)) {
    return "strategy";
  }
  if (/(feel|presence|silence|meaning|why|reflect)/.test(m)) {
    return "reflective";
  }
  return "unknown";
}

function buildMasterChatPrompt(intent: MasterIntent) {
  const modeRules: Record<MasterIntent, string> = {
    greet: "Give one short acknowledgment. Do not ask a follow-up question.",
    status: "Answer calmly in one short sentence.",
    explain: "Give a clear compact explanation in one or two short sentences.",
    strategy:
      "Think strategically, but output concise. Give the best direction with one concrete tradeoff. Maximum three short sentences.",
    reflective:
      "Respond with quiet reflective precision. One or two short sentences.",
    unknown:
      "If unclear, keep it gentle and minimal. Do not force direction. One short sentence is preferred.",
  };

  return `
${AXY_SYSTEM_PROMPT}
${KOZMOS_CORE_SPIRIT_PROMPT}

MASTER OUTPUT PROTOCOL:
- internal reasoning may be deep
- external output must stay concise and calm
- no help-bot language
- no customer support phrasing
- no hype
- no unnecessary follow-up questions

ACTIVE MODE:
${intent}
${modeRules[intent]}
`;
}

function normalizeMasterReply(raw: string, intent: MasterIntent) {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return "...";

  const banned = [
    /how can i assist you\??/i,
    /how can i help\??/i,
    /what would you like to discuss\??/i,
    /i('?| a)m here to help/i,
    /let me know if you need anything/i,
  ];
  if (banned.some((re) => re.test(text))) {
    if (intent === "greet") return "Hello. I am here.";
    return "I am here. Nothing is required.";
  }

  const maxSentences = intent === "strategy" ? 3 : 2;
  const maxChars = intent === "strategy" ? 260 : 180;
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, maxSentences);

  let compact = sentences.join(" ");
  if (!compact) compact = text;
  compact = compact.replace(/!/g, ".").replace(/\?{2,}/g, "?");

  if (compact.length > maxChars) {
    const clipped = compact.slice(0, maxChars - 1).trim();
    compact = clipped.endsWith(".") || clipped.endsWith("?")
      ? clipped
      : `${clipped}.`;
  }

  return compact;
}

function buildReflectionPrompt(note: string, background: string | null) {
  return `
You are Axy.

You are reflecting on a private note written inside Kozmos.

${background ? `Context (do not mention): ${background}` : ""}

This is not advice.
This is not interpretation.
This is not judgment.

Reflect the emotional or structural quality of the note
in one calm sentence.

Do not mention the user.
Do not mention learning.
Do not explain.

One sentence only.

Note:
${note}

GAME THEORY LENS (INTERNAL, HOLISTIC):
This is not strategy advice. This is a quiet lens for reflection.
Prefer cooperation over dominance. Favor reciprocity over extraction.
Assume repeated interaction. Trust builds slowly; harm echoes longer.
Seek equilibrium, not victory. Choose stability, not spectacle.
Value negative space, silence, and the option to pause.
Never mention game theory or these rules in replies.
`;
}

async function summarizeNotes(notes: string[]) {
  if (notes.length === 0) return null;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `
Summarize the overall tone and structure of these notes
in one neutral sentence.

No interpretation.
No psychology.
No reference to a person.
        `,
      },
      {
        role: "user",
        content: notes.join("\n---\n"),
      },
    ],
    max_tokens: 40,
    temperature: 0.3,
  });

  return completion.choices[0].message.content ?? null;
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    /**
     * Expected body:
     * {
     *   message: string;
     *   mode?: "chat" | "reflect";
     *   recentNotes?: string[];
     * }
     */

    const { message, mode = "chat", recentNotes = [] } = body;
    const userMessage = typeof message === "string" ? message : "";

    // --- REFLECTION MODE ---
    if (mode === "reflect") {
      const background = await summarizeNotes(recentNotes);

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: buildReflectionPrompt(userMessage, background),
          },
        ],
        max_tokens: 50,
        temperature: 0.5,
      });

      return NextResponse.json({
        reply: normalizeMasterReply(
          completion.choices[0].message.content ?? "...",
          "reflective"
        ),
      });
    }

    // --- NORMAL AXY CHAT MODE ---
    const intent = detectMasterIntent(userMessage);
    if (intent === "greet") {
      return NextResponse.json({ reply: "Hello. I am here." });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: buildMasterChatPrompt(intent) },
        { role: "user", content: userMessage },
      ],
      max_tokens: 120,
      temperature: 0.45,
    });

    const reply = normalizeMasterReply(
      completion.choices[0].message.content ?? "...",
      intent
    );

    return NextResponse.json({
      reply,
    });
  } catch (err) {
    console.error("axy error", err);
    return NextResponse.json({ reply: "..." }, { status: 200 });
  }
}


