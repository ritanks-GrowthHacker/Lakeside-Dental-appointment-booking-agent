import OpenAI from "openai";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export interface SchedulingState {
  selectedDate?: string;
  selectedTime?: string;
  selectedSlotId?: string;
}

/**
 * sessionId -> conversation history. In-memory, per the brief's scope.
 * A real deployment would put this in Redis/a DB with TTLs.
 *
 * Held on globalThis so it isn't wiped by Next.js dev-mode module reloads
 * (each edited file would otherwise re-run this module and reset every
 * open conversation).
 */
const globalForSessions = globalThis as unknown as { __lakesideSessions?: Map<string, ChatMessage[]> };
const globalForSchedulingStates = globalThis as unknown as {
  __lakesideSchedulingStates?: Map<string, SchedulingState>;
};

export function getSessions(): Map<string, ChatMessage[]> {
  if (!globalForSessions.__lakesideSessions) {
    globalForSessions.__lakesideSessions = new Map();
  }
  return globalForSessions.__lakesideSessions;
}

export function getSchedulingStates(): Map<string, SchedulingState> {
  if (!globalForSchedulingStates.__lakesideSchedulingStates) {
    globalForSchedulingStates.__lakesideSchedulingStates = new Map();
  }
  return globalForSchedulingStates.__lakesideSchedulingStates;
}
