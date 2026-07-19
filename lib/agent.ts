import OpenAI from "openai";
import { toolSchemas } from "./toolSchemas";
import { runTool, ToolName } from "./tools";
import { buildSystemPrompt } from "./systemPrompt";
import { getWindowDates, listAvailableSlotsForDate } from "./store";
import { SchedulingState } from "./sessions";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const MAX_TOOL_ITERATIONS = 5;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

interface CompletedAction {
  name: "book_appointment" | "cancel_appointment";
  result: Record<string, unknown>;
}

interface AvailabilitySlot {
  slotId: string;
  time: string;
}

interface AvailabilityContext {
  date: string;
  availableSlots: AvailabilitySlot[];
}

interface SelectionPreflight {
  systemContext?: string;
  unavailableReply?: string;
  selectionReply?: string;
  resolvedDate?: string;
}

const DEFERRED_REPLY_RE = /\b(one moment|just a moment|please wait|let me check|i(?:'|’)?ll check|checking (?:that|now))\b/i;
const REDUNDANT_DATE_QUESTION_RE = /\b(specific date|which date|what date|date (?:you(?:'|’)?d like|you are interested|you're interested)|confirm (?:the )?date)\b/i;

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!client) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not set. Add it to .env.local");
    }
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return client;
}

/**
 * Runs one turn of the conversation: takes the full history (including the
 * new user message already appended), executes the tool-calling loop until
 * the model produces a plain text reply (or we hit the safety cap), and
 * returns the updated history plus the assistant's final reply text.
 */
export async function runAgentTurn(
  history: ChatMessage[],
  openai: OpenAI = getClient(),
  schedulingState: SchedulingState = {},
): Promise<{ reply: string; history: ChatMessage[] }> {
  const updatedHistory = [...history];
  const completedActions: CompletedAction[] = [];
  const preflight = buildSelectionPreflight(history, schedulingState);

  // A selected time is checked in deterministic code before the model can
  // collect details or reuse a stale slot from conversation history.
  if (preflight.unavailableReply) {
    return {
      reply: preflight.unavailableReply,
      history: [
        ...updatedHistory,
        { role: "assistant", content: preflight.unavailableReply } as ChatMessage,
      ],
    };
  }

  if (preflight.selectionReply) {
    return {
      reply: preflight.selectionReply,
      history: [
        ...updatedHistory,
        { role: "assistant", content: preflight.selectionReply } as ChatMessage,
      ],
    };
  }

  // System prompt is rebuilt fresh each turn so "today's date" and the
  // 7-day window are always current, even in a conversation that runs
  // past midnight.
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt() },
    ...(preflight.systemContext
      ? [{ role: "system" as const, content: preflight.systemContext }]
      : []),
    ...updatedHistory,
  ];

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    let response: OpenAI.Chat.Completions.ChatCompletion;
    try {
      response = await openai.chat.completions.create({
        model: MODEL,
        messages,
        tools: toolSchemas,
        tool_choice: "auto",
      });
    } catch (error) {
      // Once a write tool succeeds, never return an ambiguous error that could
      // cause a duplicate retry or leave the patient unsure what happened.
      if (completedActions.length > 0) {
        const reply = buildCompletedActionsReply(completedActions);
        return {
          reply,
          history: [...updatedHistory, { role: "assistant", content: reply } as ChatMessage],
        };
      }
      throw error;
    }

    const choice = response.choices[0];
    const message = choice.message;

    // No tool calls -> the model is done, this is the reply to show the user.
    if (!message.tool_calls || message.tool_calls.length === 0) {
      const reply = message.content?.trim() || "Sorry, I didn't catch that — could you rephrase?";

      // A request cannot continue asynchronously. Correct deferred replies or
      // repeated date questions inside this turn instead of showing them.
      const deferred = DEFERRED_REPLY_RE.test(reply);
      const forgotResolvedDate =
        Boolean(preflight.resolvedDate) && REDUNDANT_DATE_QUESTION_RE.test(reply);
      const contradictedSelectedDate =
        Boolean(schedulingState.selectedDate) &&
        schedulingState.selectedDate !== getWindowDates()[0] &&
        /\btoday\b/i.test(reply);
      if (deferred || forgotResolvedDate || contradictedSelectedDate) {
        messages.push(message);
        messages.push({
          role: "system",
          content: deferred
            ? "Do not defer the work. Call the required scheduling tool now and answer with its result in this turn."
            : `The scheduling date is already resolved as ${preflight.resolvedDate}. Do not ask for it again. Continue using that date and call the required tool now.`,
        });
        continue;
      }

      return {
        reply,
        history: [...updatedHistory, { role: "assistant", content: reply } as ChatMessage],
      };
    }

    // Record the assistant's tool-call message, then execute each tool
    // call and append its result before looping back to the model.
    messages.push(message);
    updatedHistory.push(message);

    for (const toolCall of message.tool_calls) {
      if (toolCall.type !== "function") continue;

      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(toolCall.function.arguments || "{}");
      } catch {
        // Malformed JSON from the model — feed the error back so it can retry
        // instead of crashing the request.
      }


      // Once application code has resolved a selection, the model cannot
      // silently switch its date or reuse another slot from older history.
      if (toolCall.function.name === "get_available_slots" && schedulingState.selectedDate) {
        args.date = schedulingState.selectedDate;
      }
      if (toolCall.function.name === "book_appointment" && schedulingState.selectedSlotId) {
        args.slotId = schedulingState.selectedSlotId;
      }

      const result = runTool(toolCall.function.name as ToolName, args);

      if (
        result.ok &&
        (toolCall.function.name === "book_appointment" || toolCall.function.name === "cancel_appointment")
      ) {
        completedActions.push({
          name: toolCall.function.name,
          result: (result.data || {}) as Record<string, unknown>,
        });
        schedulingState.selectedDate = undefined;
        schedulingState.selectedTime = undefined;
        schedulingState.selectedSlotId = undefined;
      }

      const toolMessage: ChatMessage = {
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      };
      messages.push(toolMessage);
      updatedHistory.push(toolMessage);
    }
  }

  // Safety valve: if we somehow loop MAX_TOOL_ITERATIONS times without a
  // final text answer, fail gracefully instead of hanging the request.
  const fallback = completedActions.length
    ? buildCompletedActionsReply(completedActions)
    : "Sorry, I'm having trouble completing that right now. Could you try rephrasing your request, or ask me to check availability again?";
  return {
    reply: fallback,
    history: [...updatedHistory, { role: "assistant", content: fallback } as ChatMessage],
  };
}

function buildSelectionPreflight(
  history: ChatMessage[],
  schedulingState: SchedulingState,
): SelectionPreflight {
  const userMessage = getLatestUserText(history);
  if (!userMessage) return {};

  const previousAvailability = getLatestAvailability(history);
  const ordinalIndex = extractOrdinalIndex(userMessage);
  const explicitDate = extractExplicitDate(userMessage);
  const sameTimeRequested = /\bsame\s+(?:slot|time|appointment)\b/i.test(userMessage);
  const explicitTime = extractTime(userMessage) ||
    (sameTimeRequested ? schedulingState.selectedTime : undefined);

  let requestedTime = explicitTime;
  let targetDate = explicitDate || previousAvailability?.date;
  let previousSlotId: string | undefined;

  if (ordinalIndex !== undefined && previousAvailability) {
    const selected = previousAvailability.availableSlots[ordinalIndex];
    if (!selected) {
      return {
        unavailableReply: `That list does not have an option number ${ordinalIndex + 1}. Please choose one of the displayed times.`,
      };
    }
    requestedTime = selected.time;
    targetDate = previousAvailability.date;
    previousSlotId = selected.slotId;
  }

  if (!requestedTime) {
    if (explicitDate && previousAvailability?.date !== explicitDate) {
      schedulingState.selectedDate = undefined;
      schedulingState.selectedTime = undefined;
      schedulingState.selectedSlotId = undefined;
      return {
        resolvedDate: explicitDate,
        systemContext: `The patient explicitly selected ${explicitDate}. Call get_available_slots for that date now. Do not ask for the date again and do not reuse availability from another date.`,
      };
    }
    if (
      schedulingState.selectedDate &&
      schedulingState.selectedTime &&
      schedulingState.selectedSlotId
    ) {
      return {
        resolvedDate: schedulingState.selectedDate,
        systemContext: [
          "AUTHORITATIVE ACTIVE SELECTION (stored by application code):",
          `Date: ${schedulingState.selectedDate}`,
          `Time: ${schedulingState.selectedTime}`,
          `Internal slotId: ${schedulingState.selectedSlotId}`,
          "Do not change or ask for the date/time. Use this exact slot when the patient confirms booking.",
          previousAvailability ? describeAvailability(previousAvailability) : "",
        ].join("\n"),
      };
    }
    return previousAvailability
      ? { systemContext: describeAvailability(previousAvailability) }
      : {};
  }

  if (!targetDate || !getWindowDates().includes(targetDate)) {
    return previousAvailability
      ? { systemContext: describeAvailability(previousAvailability) }
      : {};
  }

  const freshSlots = listAvailableSlotsForDate(targetDate).map((slot) => ({
    slotId: slot.id,
    time: slot.time,
  }));
  const matchingSlot = previousSlotId
    ? freshSlots.find((slot) => slot.slotId === previousSlotId)
    : freshSlots.find((slot) => slot.time === requestedTime);

  if (!matchingSlot) {
    schedulingState.selectedDate = undefined;
    schedulingState.selectedTime = undefined;
    schedulingState.selectedSlotId = undefined;
    const alternatives = freshSlots.map((slot) => slot.time);
    const alternativeText = alternatives.length
      ? ` The currently available times are: ${alternatives.join(", ")}.`
      : " There are no remaining appointments on that date.";
    return {
      resolvedDate: targetDate,
      unavailableReply: `Sorry, ${requestedTime} on ${targetDate} is no longer available.${alternativeText}`,
    };
  }

  schedulingState.selectedDate = targetDate;
  schedulingState.selectedTime = requestedTime;
  schedulingState.selectedSlotId = matchingSlot.slotId;

  if (!hasLikelyPhoneNumber(userMessage)) {
    return {
      resolvedDate: targetDate,
      selectionReply: `You selected ${targetDate} at ${requestedTime}. Please provide the patient's full name and phone number, then confirm that you want me to book it.`,
    };
  }

  return {
    resolvedDate: targetDate,
    systemContext: [
      "AUTHORITATIVE ACTIVE SCHEDULING CONTEXT (computed by application code):",
      `The patient's current selection resolves to ${targetDate} at ${requestedTime}.`,
      `The slot was freshly checked and is currently available. Its internal slotId is ${matchingSlot.slotId}.`,
      "Do not ask for the date or time again. Collect only genuinely missing patient details, then obtain explicit confirmation before booking.",
      describeAvailability({ date: targetDate, availableSlots: freshSlots }),
    ].join("\n"),
  };
}

function hasLikelyPhoneNumber(message: string): boolean {
  const candidates = message.match(/[+\d][\d\s().-]{5,20}/g) || [];
  return candidates.some((candidate) => {
    const digits = candidate.replace(/\D/g, "").length;
    return digits >= 7 && digits <= 15;
  });
}

function getLatestUserText(history: ChatMessage[]): string | undefined {
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    if (message.role === "user" && typeof message.content === "string") {
      return message.content;
    }
  }
  return undefined;
}

function getLatestAvailability(history: ChatMessage[]): AvailabilityContext | undefined {
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    if (message.role !== "tool" || typeof message.content !== "string") continue;
    try {
      const parsed = JSON.parse(message.content) as {
        ok?: boolean;
        data?: { date?: unknown; availableSlots?: unknown };
      };
      if (
        parsed.ok &&
        typeof parsed.data?.date === "string" &&
        Array.isArray(parsed.data.availableSlots)
      ) {
        const availableSlots = parsed.data.availableSlots.filter(
          (slot): slot is AvailabilitySlot =>
            Boolean(slot) &&
            typeof slot === "object" &&
            typeof (slot as AvailabilitySlot).slotId === "string" &&
            typeof (slot as AvailabilitySlot).time === "string",
        );
        return { date: parsed.data.date, availableSlots };
      }
    } catch {
      // Ignore unrelated or malformed historical tool output.
    }
  }
  return undefined;
}

function extractOrdinalIndex(message: string): number | undefined {
  const words: Record<string, number> = {
    first: 0,
    second: 1,
    third: 2,
    fourth: 3,
    fifth: 4,
    sixth: 5,
    seventh: 6,
    eighth: 7,
    ninth: 8,
    tenth: 9,
  };
  const ordinalWords = "first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth";
  const wordMatch =
    message.match(new RegExp(`\\b(?:want|take|choose|book|prefer|select)\\s+(?:the\\s+)?(${ordinalWords})\\b`, "i")) ||
    message.match(new RegExp(`\\b(?:the\\s+)?(${ordinalWords})\\s+(?:one|slot|appointment|available)\\b`, "i")) ||
    message.trim().match(new RegExp(`^(?:the\\s+)?(${ordinalWords})(?:\\s+one)?[.!?]?$`, "i"));
  if (wordMatch) return words[wordMatch[1].toLowerCase()];
  const numericMatch = message.match(/\b(?:option|slot|appointment)\s+(\d{1,2})(?:st|nd|rd|th)?\b/i);
  if (!numericMatch) return undefined;
  const value = Number(numericMatch[1]);
  return value > 0 ? value - 1 : undefined;
}

function extractTime(message: string): string | undefined {
  const meridiemMatch = message.match(
    /\b(0?[1-9]|1[0-2])(?:[:.]([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)\b/i,
  );
  if (meridiemMatch) {
    let hour = Number(meridiemMatch[1]);
    const minute = Number(meridiemMatch[2] || "0");
    const meridiem = meridiemMatch[3].replace(/\./g, "").toLowerCase();
    if (meridiem === "pm" && hour !== 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }

  const twentyFourHourMatch = message.match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/);
  if (!twentyFourHourMatch) return undefined;
  return `${String(Number(twentyFourHourMatch[1])).padStart(2, "0")}:${twentyFourHourMatch[2]}`;
}

function extractExplicitDate(message: string): string | undefined {
  const dates = getWindowDates();
  if (/\btoday\b/i.test(message)) return dates[0];
  if (/\btomorrow\b/i.test(message)) return dates[1];
  if (/\bday after tomorrow\b/i.test(message)) return dates[2];
  const isoDate = message.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (isoDate) return isoDate[0];

  const monthNames: Record<string, number> = {
    january: 1, jan: 1,
    february: 2, feb: 2,
    march: 3, mar: 3,
    april: 4, apr: 4,
    may: 5,
    june: 6, jun: 6,
    july: 7, jul: 7,
    august: 8, aug: 8,
    september: 9, sep: 9, sept: 9,
    october: 10, oct: 10,
    november: 11, nov: 11,
    december: 12, dec: 12,
  };
  const monthPattern = Object.keys(monthNames).join("|");
  const namedMonth =
    message.match(new RegExp(`\\b(${monthPattern})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "i")) ||
    message.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${monthPattern})\\b`, "i"));
  if (namedMonth) {
    const firstIsMonth = monthNames[namedMonth[1].toLowerCase()] !== undefined;
    const month = firstIsMonth
      ? monthNames[namedMonth[1].toLowerCase()]
      : monthNames[namedMonth[2].toLowerCase()];
    const day = Number(firstIsMonth ? namedMonth[2] : namedMonth[1]);
    const match = dates.find((date) => {
      const [, candidateMonth, candidateDay] = date.split("-").map(Number);
      return candidateMonth === month && candidateDay === day;
    });
    if (match) return match;
  }

  const numericDate = message.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
  if (numericDate) {
    const first = Number(numericDate[1]);
    const second = Number(numericDate[2]);
    const candidates = dates.filter((date) => {
      const [year, month, day] = date.split("-").map(Number);
      const suppliedYear = numericDate[3]
        ? Number(numericDate[3].length === 2 ? `20${numericDate[3]}` : numericDate[3])
        : year;
      if (year !== suppliedYear) return false;
      return (month === first && day === second) || (day === first && month === second);
    });
    if (candidates.length === 1) return candidates[0];
  }

  const weekdays: Record<string, number> = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  };
  const weekdayMatch = message.match(/\b(?:next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
  if (weekdayMatch) {
    const weekday = weekdays[weekdayMatch[1].toLowerCase()];
    const startIndex = /\bnext\s+/i.test(weekdayMatch[0]) ? 1 : 0;
    const match = dates.slice(startIndex).find(
      (date) => new Date(`${date}T00:00:00Z`).getUTCDay() === weekday,
    );
    if (match) return match;
  }

  // In an active scheduling conversation, phrases such as "for 22", "on
  // the 22nd", or "22 same slot" mean the day of month within the current
  // seven-day window. Restricting the pattern to date language avoids reading
  // a phone number as a date.
  const bareDay = message.match(
    /(?:\b(?:for|on|date)\s+(?:the\s+)?|^\s*)([1-9]|[12]\d|3[01])(?:st|nd|rd|th)?(?=\s+(?:same\s+(?:slot|time|appointment)|at\b)|\s*$|[,.!?])/i,
  );
  if (bareDay) {
    const day = Number(bareDay[1]);
    const matches = dates.filter((date) => Number(date.slice(-2)) === day);
    if (matches.length === 1) return matches[0];
  }

  return undefined;
}

function describeAvailability(context: AvailabilityContext): string {
  const slots = context.availableSlots
    .map((slot, index) => `${index + 1}. ${slot.time} (slotId: ${slot.slotId})`)
    .join("\n");
  return `Most recent availability for ${context.date}:\n${slots || "No open slots."}`;
}

function buildCompletedActionsReply(actions: CompletedAction[]): string {
  return actions
    .map(({ name, result }) => {
      if (name === "book_appointment") {
        const when = result.date && result.time ? ` for ${result.date} at ${result.time}` : "";
        const patient = result.name ? ` for ${result.name}` : "";
        return `Your appointment is booked${when}${patient}. Appointment ID: ${result.appointmentId}. Please save this ID.`;
      }
      const when = result.date && result.time ? ` for ${result.date} at ${result.time}` : "";
      return `Your appointment${when} has been cancelled successfully.`;
    })
    .join(" ");
}
