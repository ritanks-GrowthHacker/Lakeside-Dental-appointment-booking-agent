import { NextRequest, NextResponse } from "next/server";
import { runAgentTurn } from "@/lib/agent";
import { getSessions } from "@/lib/sessions";
import { ChatRequestBody, ChatResponseBody } from "@/lib/types";

export const runtime = "nodejs";

const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

export async function POST(req: NextRequest) {
  let body: Partial<ChatRequestBody>;
  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ error: "Request body must be a JSON object." }, { status: 400 });
    }
    body = parsed as Partial<ChatRequestBody>;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  if (!body.sessionId || typeof body.sessionId !== "string" || !SESSION_ID_RE.test(body.sessionId)) {
    return NextResponse.json({ error: "A valid sessionId is required." }, { status: 400 });
  }
  if (!body.message || typeof body.message !== "string" || !body.message.trim()) {
    return NextResponse.json({ error: "message is required." }, { status: 400 });
  }
  if (body.message.length > 2000) {
    return NextResponse.json({ error: "message is too long." }, { status: 400 });
  }

  const sessions = getSessions();
  const history = sessions.get(body.sessionId) || [];
  history.push({ role: "user", content: body.message.trim() });

  try {
    const { reply, history: updatedHistory } = await runAgentTurn(history);
    sessions.set(body.sessionId, updatedHistory);
    const response: ChatResponseBody = { reply, sessionId: body.sessionId };
    return NextResponse.json(response);
  } catch (err) {
    console.error("Agent turn failed:", err);
    const missingKey = err instanceof Error && err.message.includes("OPENAI_API_KEY");
    return NextResponse.json(
      {
        error: missingKey
          ? "The server is missing OPENAI_API_KEY. Add it to .env.local and restart the app."
          : "The scheduling assistant is temporarily unavailable. Please try again.",
      },
      { status: missingKey ? 503 : 502 },
    );
  }
}
