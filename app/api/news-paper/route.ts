import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export async function GET() {
  try {
    const { data, error } = await supabaseAdmin
      .from("news_paper_items")
      .select("id, topic, title, summary, source_name, source_url, created_at")
      .order("created_at", { ascending: false })
      .limit(10);

    if (error) {
      return NextResponse.json(
        { error: "news paper load failed" },
        { status: 500 }
      );
    }

    const items = (data || []).map((row) => ({
      id: Number((row as { id?: number | null }).id || 0),
      topic: String((row as { topic?: string | null }).topic || "science"),
      title: String((row as { title?: string | null }).title || ""),
      summary: String((row as { summary?: string | null }).summary || ""),
      sourceName: String(
        (row as { source_name?: string | null }).source_name || "source"
      ),
      sourceUrl: String((row as { source_url?: string | null }).source_url || ""),
      createdAt: String((row as { created_at?: string | null }).created_at || ""),
    }));

    return NextResponse.json({ items });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}
