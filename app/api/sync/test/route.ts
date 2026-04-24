import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET() {
  return NextResponse.json(
    {
      ok: false,
      error:
        "This endpoint is disabled. Use the operator dashboard preview or test-save flow instead.",
    },
    { status: 410 },
  );
}
