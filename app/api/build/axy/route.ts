import { NextResponse } from "next/server";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { AXY_LUMI_AWARENESS_PROMPT } from "@/lib/axyCore";

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

// Tool definitions for file operations
const FILE_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "create_file",
      description: "Create a new file in the current build space",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path (e.g., index.html, styles.css, app.js)",
          },
          content: {
            type: "string",
            description: "Full file content",
          },
          language: {
            type: "string",
            description: "File language (html, css, javascript, typescript, json, markdown, text)",
          },
        },
        required: ["path", "content", "language"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_file",
      description: "Update/replace content of an existing file in the current build space",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path to update",
          },
          content: {
            type: "string",
            description: "New full file content",
          },
        },
        required: ["path", "content"],
      },
    },
  },
];

// Starter API Documentation for Axy
const STARTER_API_DOCS = `
## Kozmos Starter API (Available in Build Preview)

In the preview iframe, a global \`KozmosRuntime\` object provides these APIs:

### Authentication
- \`KozmosRuntime.auth.register(username, password)\` - Register new user
- \`KozmosRuntime.auth.login(username, password)\` - Login existing user  
- \`KozmosRuntime.auth.logout()\` - Logout current user
- \`KozmosRuntime.auth.me()\` - Get current user info

### Posts (Social Feed)
- \`KozmosRuntime.posts.list(limit?, offset?)\` - List posts (default 20)
- \`KozmosRuntime.posts.create(body)\` - Create new post
- \`KozmosRuntime.posts.delete(postId)\` - Delete own post
- \`KozmosRuntime.posts.like(postId)\` - Like a post
- \`KozmosRuntime.posts.unlike(postId)\` - Unlike a post

### Comments  
- \`KozmosRuntime.comments.list(postId, limit?, offset?)\` - List comments
- \`KozmosRuntime.comments.create(postId, body)\` - Add comment
- \`KozmosRuntime.comments.delete(commentId)\` - Delete own comment

### Direct Messages
- \`KozmosRuntime.dm.threads()\` - List DM threads
- \`KozmosRuntime.dm.messagesList(threadId, { limit?, before? })\` - Get messages
- \`KozmosRuntime.dm.messagesSend(threadId, body, metadata?)\` - Send message

### Friends
- \`KozmosRuntime.friends.list()\` - List friends
- \`KozmosRuntime.friends.add(username)\` - Add friend
- \`KozmosRuntime.friends.remove(username)\` - Remove friend

### Response Format
All APIs return: \`{ ok: boolean, data?: any, error?: string }\`

### Example Usage
\`\`\`javascript
// Login
const result = await KozmosRuntime.auth.login("user1", "pass123");
if (result.ok) {
  console.log("Logged in as:", result.data.username);
}

// Create post
const post = await KozmosRuntime.posts.create("Hello world!");

// List posts
const feed = await KozmosRuntime.posts.list(10);
feed.data.forEach(p => {
  console.log(p.authorUsername, p.body, p.createdAt);
});
\`\`\`

### Important Notes
- Users are scoped to the space (not global Kozmos users)
- Posts include: id, body, authorUsername, createdAt, likesCount
- All data is stored per-space
`;

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

type HistoryTurn = {
  role: "user" | "assistant";
  content: string;
};

type FileAction = {
  action: "create" | "update";
  path: string;
  content: string;
  language?: string;
};

type SpaceAccess = {
  space: {
    id: string;
    owner_id: string;
    is_public: boolean;
  } | null;
  canRead: boolean;
  error: { code?: string; message?: string } | null;
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

function normalizeHistory(input: unknown): HistoryTurn[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => {
      const role = item?.role === "assistant" ? "assistant" : item?.role === "user" ? "user" : null;
      const content = typeof item?.content === "string" ? item.content.trim() : "";
      if (!role || !content) return null;
      return { role, content: compact(content, 1400) } as HistoryTurn;
    })
    .filter((item): item is HistoryTurn => Boolean(item))
    .slice(-10);
}

async function getSpaceAccess(spaceId: string, userId: string): Promise<SpaceAccess> {
  const { data: space, error: spaceErr } = await supabaseAdmin
    .from("user_build_spaces")
    .select("id, owner_id, is_public")
    .eq("id", spaceId)
    .maybeSingle();

  if (spaceErr) {
    return { space: null, canRead: false, error: spaceErr };
  }
  if (!space) {
    return { space: null, canRead: false, error: null };
  }
  if (space.owner_id === userId) {
    return { space, canRead: true, error: null };
  }

  const { data: accessRow, error: accessErr } = await supabaseAdmin
    .from("user_build_space_access")
    .select("id")
    .eq("space_id", spaceId)
    .eq("user_id", userId)
    .maybeSingle();

  if (accessErr) {
    return { space, canRead: false, error: accessErr };
  }

  return { space, canRead: space.is_public || Boolean(accessRow?.id), error: null };
}

const BUILDER_SYSTEM_PROMPT = `
You are Axy inside user-build space of Kozmos.

Role:
- help users build what they want: code, systems, subspaces, docs, flows
- practical and concrete first
- keep calm and concise
- no hype, no assistant cliches

## Tool Usage
You have access to file operations:
- Use \`create_file\` to create new files in the space
- Use \`update_file\` to replace/update existing files
- When user asks to build something, USE THE TOOLS to create/update files directly
- Prefer complete working code over partial snippets
- For web apps, create index.html with inline CSS/JS (single file works best in preview)

## Output Style
- When creating/updating files: use the tools, then briefly explain what you did
- When explaining: keep it short and actionable
- If architecture task: give a compact plan + tradeoff
- Do not ask many questions; ask only one if truly blocking
- Respond in user's message language when clear

## Kozmos Fit
- preserve user autonomy
- do not force a direction
- support intentional building

${STARTER_API_DOCS}

${AXY_LUMI_AWARENESS_PROMPT}
`;

export async function POST(req: Request) {
  try {
    const openai = getOpenAIClient();
    if (!openai) {
      return NextResponse.json(
        { error: "axy unavailable: OPENAI_API_KEY missing" },
        { status: 503 }
      );
    }

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
    const history = normalizeHistory(body?.history);
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

    let space: BuildSpaceRow | null = null;
    let files: BuildFileRow[] = [];

    if (spaceId) {
      const access = await getSpaceAccess(spaceId, user.id);
      if (access.error) {
        return NextResponse.json({ error: "space access check failed" }, { status: 500 });
      }
      if (!access.space || !access.canRead) {
        // Graceful fallback: still allow Axy usage without space context.
        space = null;
        files = [];
      } else {
        const { data: spaceData, error: spaceErr } = await supabaseAdmin
        .from("user_build_spaces")
        .select("id, title, language_pref, description")
        .eq("id", spaceId)
        .maybeSingle();

        if (!spaceErr && spaceData) {
          space = spaceData as BuildSpaceRow;
          const { data: fileData } = await supabaseAdmin
            .from("user_build_files")
            .select("path, language, content, updated_at")
            .eq("space_id", spaceId)
            .order("updated_at", { ascending: false })
            .limit(12);
          files = (fileData || []) as BuildFileRow[];
        }
      }
    }

    const context = `
build space:
${space ? `title: ${space.title}\nlanguage_pref: ${space.language_pref}\ndescription: ${space.description || "-"}` : "no selected space"}

files:
${summarizeFiles(files)}

active file:
${activeFilePath ? `${activeFilePath} (${activeFileLanguage || "text"})` : "none"}

active file content snapshot:
${activeFileContent ? compact(activeFileContent, 4000) : "none"}
`.trim();

    // First completion call with tools
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: BUILDER_SYSTEM_PROMPT },
        { role: "system", content: context },
        ...history,
        { role: "user", content: message },
      ],
      tools: spaceId ? FILE_TOOLS : undefined,
      tool_choice: spaceId ? "auto" : undefined,
      temperature: 0.5,
      max_tokens: 2000,
    });

    const assistantMessage = completion.choices[0]?.message;
    const fileActions: FileAction[] = [];

    // Process tool calls if any
    if (assistantMessage?.tool_calls && assistantMessage.tool_calls.length > 0) {
      for (const toolCall of assistantMessage.tool_calls) {
        const funcName = toolCall.function.name;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch {
          continue;
        }

        if (funcName === "create_file" || funcName === "update_file") {
          const path = String(args.path || "").trim();
          const content = String(args.content || "");
          const language = String(args.language || detectLanguage(path));
          
          if (path && content) {
            fileActions.push({
              action: funcName === "create_file" ? "create" : "update",
              path,
              content,
              language,
            });
          }
        }
      }
    }

    const reply = assistantMessage?.content?.trim() || 
      (fileActions.length > 0 
        ? `Created/updated ${fileActions.length} file(s): ${fileActions.map(f => f.path).join(", ")}`
        : "...");

    return NextResponse.json({ 
      reply,
      fileActions: fileActions.length > 0 ? fileActions : undefined,
    });
  } catch (err) {
    console.error("[build/axy] error:", err);
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}

function detectLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  const langMap: Record<string, string> = {
    html: "html",
    htm: "html",
    css: "css",
    js: "javascript",
    mjs: "javascript",
    ts: "typescript",
    tsx: "typescript",
    jsx: "javascript",
    json: "json",
    md: "markdown",
    txt: "text",
  };
  return langMap[ext] || "text";
}
