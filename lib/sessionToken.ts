import { createHmac, timingSafeEqual } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import OpenAI from "openai";
import { SchedulingState } from "./sessions";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export interface SessionCapsule {
  version: 1;
  sessionId: string;
  history: ChatMessage[];
  schedulingState: SchedulingState;
  issuedAt: number;
}

const MAX_TOKEN_LENGTH = 150_000;

function getSigningSecret(explicitSecret?: string): string {
  const secret = explicitSecret || process.env.SESSION_SECRET || process.env.OPENAI_API_KEY;
  if (!secret) {
    throw new Error("SESSION_SECRET or OPENAI_API_KEY is required to sign conversation state.");
  }
  return secret;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret)
    .update("lakeside-session-v1:")
    .update(payload)
    .digest("base64url");
}

export function encodeSessionToken(
  capsule: SessionCapsule,
  explicitSecret?: string,
): string {
  const payload = deflateRawSync(Buffer.from(JSON.stringify(capsule))).toString("base64url");
  return `${payload}.${sign(payload, getSigningSecret(explicitSecret))}`;
}

export function decodeSessionToken(
  token: string,
  expectedSessionId: string,
  explicitSecret?: string,
): SessionCapsule {
  if (!token || token.length > MAX_TOKEN_LENGTH) throw new Error("Invalid conversation token.");
  const [payload, suppliedSignature, extra] = token.split(".");
  if (!payload || !suppliedSignature || extra) throw new Error("Invalid conversation token.");

  const expectedSignature = sign(payload, getSigningSecret(explicitSecret));
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new Error("Invalid conversation token signature.");
  }

  let capsule: SessionCapsule;
  try {
    capsule = JSON.parse(inflateRawSync(Buffer.from(payload, "base64url")).toString("utf8"));
  } catch {
    throw new Error("Invalid conversation token payload.");
  }
  if (
    capsule.version !== 1 ||
    capsule.sessionId !== expectedSessionId ||
    !Array.isArray(capsule.history) ||
    !capsule.schedulingState ||
    typeof capsule.schedulingState !== "object"
  ) {
    throw new Error("Conversation token does not match this session.");
  }
  return capsule;
}
