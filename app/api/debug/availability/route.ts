import { NextResponse } from "next/server";
import { getWindowDates, listAvailableSlotsForDate } from "@/lib/store";

export const runtime = "nodejs";

export async function GET() {
  const dates = getWindowDates();
  const summary = dates.map((date) => ({
    date,
    openSlots: listAvailableSlotsForDate(date).map((s) => s.time),
  }));
  return NextResponse.json({ dates, summary });
}
