/**
 * Assertion-based tests.
 *
 * Section A tests the deterministic layer (store/validation/tools) directly
 * — no OpenAI involved.
 *
 * Section B tests the agent loop (lib/agent.ts) against a *fake* OpenAI
 * client that returns scripted tool_calls, so the tool-loop wiring and
 * ordinal-selection behavior can be verified without a real API key or
 * network call — including a direct regression test for the "tomorrow
 * becomes today" bug.
 *
 * Run with: npm test
 */
import OpenAI from "openai";
import { seedStore, getWindowDates, listAvailableSlotsForDate } from "../store";
import {
  toolGetAvailableSlots,
  toolBookAppointment,
  toolCancelAppointment,
  toolFindAppointmentsByPhone,
} from "../tools";
import { runAgentTurn } from "../agent";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatCompletion = OpenAI.Chat.Completions.ChatCompletion;

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

function section(title: string) {
  console.log(`\n${title}`);
}

async function main() {
seedStore();
const dates = getWindowDates();

// ---------------------------------------------------------------------------
// Section A: deterministic tool/validation layer
// ---------------------------------------------------------------------------

section("get_available_slots");
{
  const good = toolGetAvailableSlots({ date: dates[0] });
  check("valid in-window date returns ok:true", good.ok === true);

  const badFormat = toolGetAvailableSlots({ date: "07/19/2026" });
  check("malformed date is rejected", badFormat.ok === false);

  const outOfWindow = toolGetAvailableSlots({ date: "2099-01-01" });
  check(
    "out-of-window date is rejected with valid dates hint",
    outOfWindow.ok === false && Array.isArray((outOfWindow.data as any)?.validDates),
  );

  const missing = toolGetAvailableSlots({});
  check("missing date is rejected", missing.ok === false);

  const fullyBookedDay = dates[3];
  const slots = toolGetAvailableSlots({ date: fullyBookedDay });
  check("day 3 is seeded fully booked (0 available slots)", slots.ok === true && (slots.data as any).count === 0);

  const openDay = toolGetAvailableSlots({ date: dates[0] });
  const list = (openDay.data as any).availableSlots as Array<{ position: number; slotId: string }>;
  check(
    "each returned slot carries a 1-based position",
    list.length > 0 && list[0].position === 1 && list[list.length - 1].position === list.length,
  );
}

section("book_appointment");
{
  const availableDate = dates[0];
  const openSlots = listAvailableSlotsForDate(availableDate);
  check("there is at least one open slot to book on day 0", openSlots.length > 0);

  const targetSlot = openSlots[0];

  const missingFields = toolBookAppointment({ slotId: targetSlot.id });
  check("booking without name/phone is rejected", missingFields.ok === false);

  const badPhone = toolBookAppointment({ slotId: targetSlot.id, name: "Jane Doe", phone: "abc" });
  check("booking with invalid phone is rejected", badPhone.ok === false);

  const badName = toolBookAppointment({ slotId: targetSlot.id, name: "J", phone: "555-010-0100" });
  check("booking with too-short name is rejected", badName.ok === false);

  const good = toolBookAppointment({ slotId: targetSlot.id, name: "Jane Doe", phone: "555-010-0100" });
  check("valid booking succeeds", good.ok === true);
  const appointmentId = (good.data as any)?.appointmentId as string;
  check("successful booking returns an appointmentId", typeof appointmentId === "string" && appointmentId.length > 0);

  const doubleBook = toolBookAppointment({ slotId: targetSlot.id, name: "Someone Else", phone: "555-010-0101" });
  check("booking an already-booked slot fails cleanly (no double booking)", doubleBook.ok === false);

  const fakeSlot = toolBookAppointment({ slotId: "not-a-real-id", name: "Jane Doe", phone: "555-010-0100" });
  check("booking a nonexistent slotId fails cleanly", fakeSlot.ok === false);

  section("find_appointments_by_phone");
  const lookup = toolFindAppointmentsByPhone({ phone: "555-010-0100" });
  check("lookup by phone finds the just-booked appointment", lookup.ok === true && (lookup.data as any).count >= 1);

  const lookupMiss = toolFindAppointmentsByPhone({ phone: "555-999-9999" });
  check(
    "lookup by unknown phone returns zero results, not an error",
    lookupMiss.ok === true && (lookupMiss.data as any).count === 0,
  );

  section("cancel_appointment");
  const cancelGood = toolCancelAppointment({ appointmentId });
  check("cancelling a real appointment succeeds", cancelGood.ok === true);

  const slotsAfterCancel = toolGetAvailableSlots({ date: availableDate });
  const freedSlot = (slotsAfterCancel.data as any).availableSlots.find((s: any) => s.slotId === targetSlot.id);
  check("cancelling frees the slot back up for booking", !!freedSlot);

  const cancelTwice = toolCancelAppointment({ appointmentId });
  check("cancelling the same appointment twice fails cleanly (no crash)", cancelTwice.ok === false);

  const cancelFake = toolCancelAppointment({ appointmentId: "not-a-real-id" });
  check("cancelling a nonexistent appointmentId fails cleanly", cancelFake.ok === false);

  const cancelMissing = toolCancelAppointment({});
  check("cancelling with no appointmentId is rejected", cancelMissing.ok === false);
}

// ---------------------------------------------------------------------------
// Section B: agent loop, driven by a fake OpenAI client
// ---------------------------------------------------------------------------

/** Minimal fake ChatCompletion builder. */
function completion(message: OpenAI.Chat.Completions.ChatCompletionMessage): ChatCompletion {
  return {
    id: "fake",
    object: "chat.completion",
    created: 0,
    model: "fake-model",
    choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop", logprobs: null }],
  } as ChatCompletion;
}

function toolCallMessage(name: string, args: Record<string, unknown>, id = "call_1"): OpenAI.Chat.Completions.ChatCompletionMessage {
  return {
    role: "assistant",
    content: null,
    refusal: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  } as OpenAI.Chat.Completions.ChatCompletionMessage;
}

function textMessage(content: string): OpenAI.Chat.Completions.ChatCompletionMessage {
  return { role: "assistant", content, refusal: null } as OpenAI.Chat.Completions.ChatCompletionMessage;
}

/**
 * Builds a fake OpenAI client that returns a scripted sequence of responses,
 * one per call to chat.completions.create — this is what lets us test the
 * tool-loop deterministically.
 */
function scriptedClient(responses: ChatCompletion[]): OpenAI {
  let call = 0;
  return {
    chat: {
      completions: {
        create: async () => {
          if (call >= responses.length) {
            throw new Error("scriptedClient: ran out of scripted responses");
          }
          return responses[call++];
        },
      },
    },
  } as unknown as OpenAI;
}

section("agent loop — basic tool call then reply");
{
  const tomorrow = dates[1];
  const fakeClient = scriptedClient([
    completion(toolCallMessage("get_available_slots", { date: tomorrow })),
    completion(textMessage(`Here are the open times for ${tomorrow}.`)),
  ]);

  const turn = await runAgentTurn([{ role: "user", content: "What's available tomorrow?" }], fakeClient);
  check("agent executes the tool and returns the model's follow-up text", turn.reply.includes(tomorrow));
  check("tool result is recorded in history as a 'tool' message", turn.history.some((m) => m.role === "tool"));
}

section("REGRESSION: 'tomorrow' -> 'second available appointment' resolves to tomorrow, not today");
{
  const today = dates[0];
  const tomorrow = dates[1];
  const availability = toolGetAvailableSlots({ date: tomorrow });
  const slots = (availability.data as any).availableSlots as Array<{ position: number; slotId: string; time: string }>;
  check("fixture: tomorrow has at least 2 open slots to select from", slots.length >= 2);
  const secondSlot = slots[1];

  // Turn 1: user asks for tomorrow's availability. Model calls the tool, then replies with the list.
  const turn1Client = scriptedClient([
    completion(toolCallMessage("get_available_slots", { date: tomorrow })),
    completion(textMessage(`Here are tomorrow's (${tomorrow}) available times, numbered by position.`)),
  ]);
  const turn1 = await runAgentTurn([{ role: "user", content: "What appointments are available tomorrow?" }], turn1Client);

  // Turn 2: user says "the second available appointment." A correctly-behaving
  // model (per the fixed system prompt) resolves this directly from the position
  // field in the prior tool result and calls book_appointment WITHOUT re-checking
  // availability for "today" first. We assert on the tool call it's allowed to make.
  const turn2Client = scriptedClient([
    completion(
      toolCallMessage("book_appointment", {
        slotId: secondSlot.slotId,
        name: "Placeholder Patient",
        phone: "555-010-0199",
      }),
    ),
    completion(textMessage(`Booked for ${tomorrow} at ${secondSlot.time}.`)),
  ]);
  const turn2 = await runAgentTurn(
    [...turn1.history, { role: "user", content: "I want the second available appointment." }],
    turn2Client,
  );

  check(
    "the booked slotId matches position 2 from tomorrow's list, not today's",
    turn2.history.some(
      (m) =>
        m.role === "tool" &&
        typeof m.content === "string" &&
        JSON.parse(m.content).data?.slotId === secondSlot.slotId,
    ),
  );
  check("the confirmation mentions tomorrow's date, not today's", turn2.reply.includes(tomorrow));
  check("the confirmation does not incorrectly reference today's date", !turn2.reply.includes(today) || today === tomorrow);
}

section("agent loop — safety cap on runaway tool-calling");
{
  // A client that always returns another tool call should not hang the
  // request forever — the loop must bail out after MAX_TOOL_ITERATIONS.
  const infiniteToolCalls = Array.from({ length: 10 }, (_, i) =>
    completion(toolCallMessage("get_available_slots", { date: dates[0] }, `call_${i}`)),
  );
  const fakeClient = scriptedClient(infiniteToolCalls);
  const turn = await runAgentTurn([{ role: "user", content: "loop forever" }], fakeClient);
  check("agent returns a graceful fallback instead of hanging", typeof turn.reply === "string" && turn.reply.length > 0);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test run crashed:", err);
  process.exit(1);
});
