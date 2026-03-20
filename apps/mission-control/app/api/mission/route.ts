import { NextResponse } from "next/server";
import { getMissionControlSnapshot } from "../../../lib/mission-data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const snapshot = await getMissionControlSnapshot();
  return NextResponse.json(snapshot);
}
