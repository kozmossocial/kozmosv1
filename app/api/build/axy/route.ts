import { NextResponse } from "next/server";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

type BuildSpaceRow = {
  id: string;
  title: string;
  language_pref: string;
  description: string;
};

type BuildFileRow = {
  path: string;
  language: string;
  content: string;
  updated_at: string;
};

function extractBearerToken(req: Request) {
  const header =
    req.headers.get("authorization") || req.headers.get("Authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function compact(input: string, max: number) {
  return input.replace(/\s+/g, " ").trim().slice(0, max);
}

function summarizeFiles(files: BuildFileRow[]) {
  if (files.length === 0) return "no files yet";
  return files
    .slice(0, 10)
    .map((f, idx) => `${idx + 1}. ${f.path} (${f.language})`)
    .join("\n");
}

const BUILDER_SYSTEM_PROMPT = `
You are Axy inside user-build space of Kozmos.

Role:
- help users build what they want: code, systems, subspaces, docs, flows
- practical and concrete first
- keep calm and concise
- no hype, no assistant cliches

Output style:
- default to short actionable response
- if coding task: provide minimal diffs/snippets
- if architecture task: give a compact plan + tradeoff
- do not ask many questions; ask only one if truly blocking
- respond in user's message language when clear

Kozmos fit:
- preserve user autonomy
- do not force a direction
- support intentional building
`;

export async function POST(req: Request) {
  try {
    const token = extractBearerToken(req);
    if (!token) {
      return NextResponse.json({ error: "missing session token" }, { status: 401 });
    }

    const authClient = createClient(supabaseUrl, supabaseAnonKey);
    const {
      data: { user },
      error: userErr,
    } = await authClient.auth.getUser(token);

    if (userErr || !user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const message = typeof body?.message === "string" ? body.message.trim() : "";
    const spaceId = typeof body?.spaceId === "string" ? body.spaceId : "";
    const activeFilePath =
      typeof body?.activeFilePath === "string" ? body.activeFilePath : "";
    const activeFileContent =
      typeof body?.activeFileContent === "string" ? body.activeFileContent : "";
    const activeFileLanguage =
      typeof body?.activeFileLanguage === "string" ? body.activeFileLanguage : "";

    if (!message) {
      return NextResponse.json({ error: "message required" }, { status: 400 });
    }

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    });

    let space: BuildSpaceRow | null = null;
    let files: BuildFileRow[] = [];

    if (spaceId) {
      const { data: spaceData, error: spaceErr } = await userClient
        .from("user_build_spaces")
        .select("id, title, language_pref, description")
        .eq("id", spaceId)
        .maybeSingle();

      if (spaceErr || !spaceData) {
        return NextResponse.json({ error: "space not accessible" }, { status: 403 });
      }
      space = spaceData as BuildSpaceRow;

      const { data: fileData } = await userClient
        .from("user_build_files")
        .select("path, language, content, updated_at")
        .eq("space_id", spaceId)
        .order("updated_at", { ascending: false })
        .limit(12);

      files = (fileData || []) as BuildFileRow[];
    }

    const context = `
build space:
${space ? `title: ${space.title}\nlanguage_pref: ${space.language_pref}\ndescription: ${space.description || "-"}` : "no selected space"}

files:
${summarizeFiles(files)}

active file:
${activeFilePath ? `${activeFilePath} (${activeFileLanguage || "text"})` : "none"}

active file content snapshot:
${activeFileContent ? compact(activeFileContent, 2200) : "none"}
`.trim();

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: BUILDER_SYSTEM_PROMPT },
        { role: "system", content: context },
        { role: "user", content: message },
      ],
      temperature: 0.5,
      max_tokens: 420,
    });

    const reply = completion.choices[0]?.message?.content?.trim() || "...";
    return NextResponse.json({ reply });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}
