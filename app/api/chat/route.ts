import { NextRequest, NextResponse } from "next/server";
import { runAgentTurn } from "@/lib/agent";
import { getSchedulingStates, getSessions } from "@/lib/sessions";
import { ChatRequestBody, ChatResponseBody } from "@/lib/types";
import { decodeSessionToken, encodeSessionToken } from "@/lib/sessionToken";

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

  if (
    !body.sessionId ||
    typeof body.sessionId !== "string" ||
    !SESSION_ID_RE.test(body.sessionId)
  ) {
    return NextResponse.json({ error: "A valid sessionId is required." }, { status: 400 });
  }
  if (!body.message || typeof body.message !== "string" || !body.message.trim()) {
    return NextResponse.json({ error: "message is required." }, { status: 400 });
  }
  if (body.message.length > 2000) {
    return NextResponse.json({ error: "message is too long." }, { status: 400 });
  }
  if (body.conversationToken !== undefined && typeof body.conversationToken !== "string") {
    return NextResponse.json({ error: "conversationToken must be a string." }, { status: 400 });
  }

  const sessions = getSessions();
  const schedulingStates = getSchedulingStates();
  let priorHistory = sessions.get(body.sessionId) || [];
  let schedulingState = schedulingStates.get(body.sessionId) || {};
  if (body.conversationToken) {
    try {
      const capsule = decodeSessionToken(body.conversationToken, body.sessionId);
      priorHistory = capsule.history;
      schedulingState = capsule.schedulingState;
    } catch {
      return NextResponse.json(
        { error: "Conversation state is invalid or expired. Please refresh and start again." },
        { status: 400 },
      );
    }
  }
  const history = [
    ...priorHistory,
    { role: "user" as const, content: body.message.trim() },
  ];

  try {
    const { reply, history: updatedHistory } = await runAgentTurn(
      history,
      undefined,
      schedulingState,
    );
    sessions.set(body.sessionId, updatedHistory);
    schedulingStates.set(body.sessionId, schedulingState);
    const conversationToken = encodeSessionToken({
      version: 1,
      sessionId: body.sessionId,
      history: updatedHistory,
      schedulingState,
      issuedAt: Date.now(),
    });
    const response: ChatResponseBody = {
      reply,
      sessionId: body.sessionId,
      conversationToken,
    };
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
