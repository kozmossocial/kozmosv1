import { NextResponse } from "next/server";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export async function POST(req: Request) {
  const { message } = await req.json();

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "You are Axy. You are calm, minimal, abstract. One sentence only.",
      },
      { role: "user", content: message },
    ],
    max_tokens: 40,
  });

  return NextResponse.json({
    reply: completion.choices[0].message.content,
  });
}
