import { NextResponse } from "next/server";
import { seedStore } from "@/lib/store";
import { getSessions } from "@/lib/sessions";

export const runtime = "nodejs";

export async function POST() {
  seedStore();
  getSessions().clear();
  return NextResponse.json({ ok: true, message: "Store reseeded and sessions cleared." });
}
