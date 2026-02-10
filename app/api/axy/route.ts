import { NextResponse } from "next/server";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

/**
 * AXY - SYSTEM PROMPT
 * Core identity. Never exposed to frontend.
 */
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

/**
 * Reflection prompt (note-based)
 * Used when mode === "reflect"
 */
function buildReflectionPrompt(
  note: string,
  background: string | null
) {
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

/**
 * Summarize recent notes into a silent background texture
 * This is NOT stored. Used only for this request.
 */
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

    // --- REFLECTION MODE ---
    if (mode === "reflect") {
      const background = await summarizeNotes(recentNotes);

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: buildReflectionPrompt(message, background),
          },
        ],
        max_tokens: 50,
        temperature: 0.6,
      });

      return NextResponse.json({
        reply: completion.choices[0].message.content ?? "...",
      });
    }

    // --- NORMAL AXY CHAT MODE ---
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: AXY_SYSTEM_PROMPT },
        { role: "user", content: message },
      ],
      max_tokens: 80,
      temperature: 0.7,
    });

    return NextResponse.json({
      reply: completion.choices[0].message.content ?? "...",
    });
  } catch (err) {
    console.error("axy error", err);
    return NextResponse.json({ reply: "..." }, { status: 200 });
  }
}


