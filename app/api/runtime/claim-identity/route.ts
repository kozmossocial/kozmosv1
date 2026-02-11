import { NextResponse } from "next/server";
import { createRuntimeIdentity } from "@/lib/runtimeIdentity";

const bootstrapKey = process.env.RUNTIME_BOOTSTRAP_KEY;

export async function POST(req: Request) {
  try {
    if (!bootstrapKey) {
      return NextResponse.json({ error: "bootstrap disabled" }, { status: 503 });
    }

    const headerKey = req.headers.get("x-kozmos-bootstrap-key");
    if (!headerKey || headerKey !== bootstrapKey) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const requestedUsername =
      typeof body?.username === "string" ? body.username : "";
    const label = typeof body?.label === "string" ? body.label : "runtime";

    const result = await createRuntimeIdentity({
      requestedUsername,
      label,
    });

    return NextResponse.json({
      user: result.user,
      token: result.token,
      note: "Store token now. It will not be shown again.",
    });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}

