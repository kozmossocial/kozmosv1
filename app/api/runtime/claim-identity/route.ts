import { NextResponse } from "next/server";

export async function POST(req: Request) {
  void req;
  return NextResponse.json(
    {
      error: "disabled",
      reason: "runtime is linked-user only",
      how_to_claim: "Use /runtime/connect while logged in, then claim invite.",
    },
    { status: 410 }
  );
}
