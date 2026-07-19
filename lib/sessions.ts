import OpenAI from "openai";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/**
 * sessionId -> conversation history. In-memory, per the brief's scope.
 * A real deployment would put this in Redis/a DB with TTLs.
 *
 * Held on globalThis so it isn't wiped by Next.js dev-mode module reloads
 * (each edited file would otherwise re-run this module and reset every
 * open conversation).
 */
const globalForSessions = globalThis as unknown as { __lakesideSessions?: Map<string, ChatMessage[]> };

export function getSessions(): Map<string, ChatMessage[]> {
  if (!globalForSessions.__lakesideSessions) {
    globalForSessions.__lakesideSessions = new Map();
  }
  return globalForSessions.__lakesideSessions;
}
