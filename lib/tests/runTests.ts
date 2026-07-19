/**
 * Lightweight assertion-based tests for the deterministic parts of the system
 * (store, validation, tools). Does NOT call OpenAI — that part is verified
 * manually via the chat UI since it needs a live API key.
 *
 * Run with: npm test
 */
import { seedStore, getWindowDates, listAvailableSlotsForDate } from "../store";
import { toolGetAvailableSlots, toolBookAppointment, toolCancelAppointment, toolFindAppointmentsByPhone } from "../tools";
import { runAgentTurn } from "../agent";
import { decodeSessionToken, encodeSessionToken } from "../sessionToken";
import OpenAI from "openai";

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

seedStore();
const dates = getWindowDates();

section("portable signed conversation state");
{
  const secret = "test-only-session-secret";
  const capsule = {
    version: 1 as const,
    sessionId: "test_session_123",
    history: [{ role: "user" as const, content: "What is available tomorrow?" }],
    schedulingState: {
      selectedDate: dates[1],
      selectedTime: "09:30",
      selectedSlotId: `slot-${dates[1]}-0930`,
    },
    issuedAt: Date.now(),
  };
  const token = encodeSessionToken(capsule, secret);
  const decoded = decodeSessionToken(token, capsule.sessionId, secret);
  check("signed state preserves conversation history across processes", decoded.history.length === 1);
  check("signed state preserves the selected tomorrow date", decoded.schedulingState.selectedDate === dates[1]);

  let tamperRejected = false;
  try {
    decodeSessionToken(`${token.slice(0, -1)}x`, capsule.sessionId, secret);
  } catch {
    tamperRejected = true;
  }
  check("tampered conversation state is rejected", tamperRejected);

  let wrongSessionRejected = false;
  try {
    decodeSessionToken(token, "different_session", secret);
  } catch {
    wrongSessionRejected = true;
  }
  check("conversation state cannot be replayed under another session ID", wrongSessionRejected);
}

section("get_available_slots");
{
  const good = toolGetAvailableSlots({ date: dates[0] });
  check("valid in-window date returns ok:true", good.ok === true);

  const badFormat = toolGetAvailableSlots({ date: "07/19/2026" });
  check("malformed date is rejected", badFormat.ok === false);

  const outOfWindow = toolGetAvailableSlots({ date: "2099-01-01" });
  check("out-of-window date is rejected with valid dates hint", outOfWindow.ok === false && Array.isArray((outOfWindow.data as any)?.validDates));

  const missing = toolGetAvailableSlots({});
  check("missing date is rejected", missing.ok === false);

  const impossibleDate = toolGetAvailableSlots({ date: "2026-02-30" });
  check("impossible calendar date is rejected", impossibleDate.ok === false);

  const fullyBookedDay = dates[3];
  const slots = toolGetAvailableSlots({ date: fullyBookedDay });
  check("day 3 is seeded fully booked (0 available slots)", slots.ok === true && (slots.data as any).count === 0);
}

section("book_appointment");
{
  const availableDate = dates.find((date) => listAvailableSlotsForDate(date).length > 0)!;
  const openSlots = listAvailableSlotsForDate(availableDate);
  check("there is at least one open slot in the booking window", openSlots.length > 0);

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
  check(
    "lookup results include human-readable date and time",
    typeof (lookup.data as any).appointments[0]?.date === "string" &&
      typeof (lookup.data as any).appointments[0]?.time === "string",
  );

  const lookupDifferentFormatting = toolFindAppointmentsByPhone({ phone: "(555) 010-0100" });
  check("lookup normalizes phone formatting", lookupDifferentFormatting.ok === true && (lookupDifferentFormatting.data as any).count >= 1);

  const lookupMiss = toolFindAppointmentsByPhone({ phone: "555-999-9999" });
  check("lookup by unknown phone returns zero results, not an error", lookupMiss.ok === true && (lookupMiss.data as any).count === 0);

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

async function runAgentTests() {
section("agent tool-calling loop");
{
  const date = dates.find((candidate) => listAvailableSlotsForDate(candidate).length > 0)!;
  let callCount = 0;
  const fakeClient = {
    chat: {
      completions: {
        create: async () => {
          callCount++;
          if (callCount === 1) {
            return {
              choices: [{
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [{
                    id: "call_availability",
                    type: "function",
                    function: { name: "get_available_slots", arguments: JSON.stringify({ date }) },
                  }],
                },
              }],
            };
          }
          return { choices: [{ message: { role: "assistant", content: "I found some openings." } }] };
        },
      },
    },
  } as unknown as OpenAI;

  const turn = await runAgentTurn([{ role: "user", content: "What is open?" }], fakeClient);
  check("agent executes a requested tool and loops back to the model", callCount === 2);
  check("agent preserves the tool result in server-side history", turn.history.some((message) => message.role === "tool"));
  check("agent returns the final assistant text", turn.reply === "I found some openings.");
}

section("agent write recovery");
{
  seedStore();
  const slot = dates.flatMap((date) => listAvailableSlotsForDate(date))[0];
  let callCount = 0;
  const fakeClient = {
    chat: {
      completions: {
        create: async () => {
          callCount++;
          if (callCount === 1) {
            return {
              choices: [{
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [{
                    id: "call_booking",
                    type: "function",
                    function: {
                      name: "book_appointment",
                      arguments: JSON.stringify({ slotId: slot.id, name: "Jane Doe", phone: "555-010-0199" }),
                    },
                  }],
                },
              }],
            };
          }
          throw new Error("simulated provider failure after write");
        },
      },
    },
  } as unknown as OpenAI;

  const turn = await runAgentTurn([{ role: "user", content: "Yes, book it." }], fakeClient);
  check("successful booking is not reported as an ambiguous failure", turn.reply.includes("Appointment ID:"));
  check("recovery reply is stored in conversation history", turn.history.at(-1)?.role === "assistant");
}

section("agent scheduling context regression");
{
  seedStore();
  const date = dates.slice(1).find((candidate) => listAvailableSlotsForDate(candidate).length >= 2)!;
  const availability = toolGetAvailableSlots({ date });
  const slots = (availability.data as any).availableSlots;
  let providerCalled = false;
  const fakeClient = {
    chat: {
      completions: {
        create: async () => {
          providerCalled = true;
          throw new Error("ordinal selection should be deterministic");
        },
      },
    },
  } as unknown as OpenAI;
  const schedulingState: { selectedDate?: string; selectedTime?: string; selectedSlotId?: string } = {};

  const turn = await runAgentTurn([
    { role: "user", content: "What is available tomorrow?" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_previous_availability",
        type: "function",
        function: { name: "get_available_slots", arguments: JSON.stringify({ date }) },
      }],
    },
    {
      role: "tool",
      tool_call_id: "call_previous_availability",
      content: JSON.stringify(availability),
    },
    { role: "assistant", content: "Here are the available appointments." },
    { role: "user", content: "I want the second available appointment." },
  ], fakeClient, schedulingState);

  check("ordinal selection inherits the date from the latest availability", schedulingState.selectedDate === date);
  check("ordinal selection resolves to the exact second slot", schedulingState.selectedSlotId === slots[1].slotId);
  check("ordinal selection returns the correct date without model interpretation", turn.reply.includes(date));
  check("ordinal selection does not depend on model behavior", providerCalled === false);
}

section("exact cross-instance tomorrow transcript");
{
  seedStore();
  const date = dates[1];
  const expectedSlots = listAvailableSlotsForDate(date);
  let firstTurnCalls = 0;
  const firstInstanceClient = {
    chat: {
      completions: {
        create: async () => {
          firstTurnCalls++;
          if (firstTurnCalls === 1) {
            return {
              choices: [{
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [{
                    id: "cross_instance_availability",
                    type: "function",
                    function: {
                      name: "get_available_slots",
                      arguments: JSON.stringify({ date }),
                    },
                  }],
                },
              }],
            };
          }
          return {
            choices: [{
              message: {
                role: "assistant",
                content: `Here are the available appointment slots for ${date}.`,
              },
            }],
          };
        },
      },
    },
  } as unknown as OpenAI;
  const firstState = {};
  const firstTurn = await runAgentTurn([
    { role: "user", content: "What appointments are available tomorrow?" },
  ], firstInstanceClient, firstState);
  const token = encodeSessionToken({
    version: 1,
    sessionId: "cross_instance_session",
    history: firstTurn.history,
    schedulingState: firstState,
    issuedAt: Date.now(),
  }, "cross-instance-test-secret");

  // Simulate the next serverless request landing in a freshly seeded process.
  seedStore();
  const restored = decodeSessionToken(
    token,
    "cross_instance_session",
    "cross-instance-test-secret",
  );
  let secondProviderCalled = false;
  const secondInstanceClient = {
    chat: {
      completions: {
        create: async () => {
          secondProviderCalled = true;
          throw new Error("ordinal resolution must not depend on the second model call");
        },
      },
    },
  } as unknown as OpenAI;
  const secondTurn = await runAgentTurn([
    ...restored.history,
    { role: "user", content: "I want the second available appointment." },
  ], secondInstanceClient, restored.schedulingState);

  check("cross-instance second selection keeps tomorrow", secondTurn.reply.includes(date));
  check("cross-instance second selection keeps the second time", secondTurn.reply.includes(expectedSlots[1].time));
  check("cross-instance ordinal response bypasses model drift", secondProviderCalled === false);
}

section("stored selection cannot drift to today");
{
  seedStore();
  const date = dates.slice(1).find((candidate) => listAvailableSlotsForDate(candidate).length > 0)!;
  const slot = listAvailableSlotsForDate(date)[0];
  const schedulingState = {
    selectedDate: date,
    selectedTime: slot.time,
    selectedSlotId: slot.id,
  };
  let callCount = 0;
  let toolResultDate: string | undefined;
  const fakeClient = {
    chat: {
      completions: {
        create: async (request: any) => {
          callCount++;
          if (callCount === 1) {
            return {
              choices: [{
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [{
                    id: "call_wrong_today",
                    type: "function",
                    function: {
                      name: "get_available_slots",
                      arguments: JSON.stringify({ date: dates[0] }),
                    },
                  }],
                },
              }],
            };
          }
          const toolMessage = request.messages.findLast((message: any) => message.role === "tool");
          toolResultDate = JSON.parse(toolMessage.content).data.date;
          return {
            choices: [{
              message: {
                role: "assistant",
                content: `Your selected appointment remains ${date} at ${slot.time}.`,
              },
            }],
          };
        },
      },
    },
  } as unknown as OpenAI;

  const turn = await runAgentTurn([
    { role: "user", content: "My name is Ritank Saxena and my phone is 9399039501." },
  ], fakeClient, schedulingState);
  check("model availability calls are forced to the stored selected date", toolResultDate === date);
  check("stored tomorrow selection remains tomorrow in the response", turn.reply.includes(date));
}

section("stale selection regression");
{
  seedStore();
  const date = dates.find((candidate) => listAvailableSlotsForDate(candidate).length > 0)!;
  const availability = toolGetAvailableSlots({ date });
  const selected = (availability.data as any).availableSlots[0];
  const booked = toolBookAppointment({
    slotId: selected.slotId,
    name: "Ritank Saxena",
    phone: "9399039501",
  });
  check("stale-selection setup booking succeeds", booked.ok === true);

  let providerCalled = false;
  const fakeClient = {
    chat: {
      completions: {
        create: async () => {
          providerCalled = true;
          throw new Error("provider should not be needed for a deterministic stale-slot rejection");
        },
      },
    },
  } as unknown as OpenAI;

  const hour = Number(selected.time.slice(0, 2));
  const minute = selected.time.slice(3);
  const displayTime = hour > 12
    ? `${hour - 12}:${minute} PM`
    : `${hour}:${minute} AM`;
  const turn = await runAgentTurn([
    { role: "user", content: "What appointments are available?" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_stale_availability",
        type: "function",
        function: { name: "get_available_slots", arguments: JSON.stringify({ date }) },
      }],
    },
    {
      role: "tool",
      tool_call_id: "call_stale_availability",
      content: JSON.stringify(availability),
    },
    { role: "assistant", content: "Here are the available appointments." },
    { role: "user", content: `I want ${displayTime}.` },
  ], fakeClient);

  check("a stale requested time is rejected before asking for patient details", turn.reply.includes("no longer available"));
  check("stale selection rejection does not depend on model behavior", providerCalled === false);
}

section("deferred response guard");
{
  seedStore();
  const date = dates.find((candidate) => listAvailableSlotsForDate(candidate).length > 0)!;
  let callCount = 0;
  const fakeClient = {
    chat: {
      completions: {
        create: async () => {
          callCount++;
          if (callCount === 1) {
            return { choices: [{ message: { role: "assistant", content: "One moment please, let me check." } }] };
          }
          if (callCount === 2) {
            return {
              choices: [{
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [{
                    id: "call_after_deferred_reply",
                    type: "function",
                    function: { name: "get_available_slots", arguments: JSON.stringify({ date }) },
                  }],
                },
              }],
            };
          }
          return { choices: [{ message: { role: "assistant", content: "Here are the current openings." } }] };
        },
      },
    },
  } as unknown as OpenAI;

  const turn = await runAgentTurn([{ role: "user", content: "What is available tomorrow?" }], fakeClient);
  check("agent does not return a one-moment placeholder", turn.reply === "Here are the current openings.");
  check("agent continues into the tool call during the same turn", callCount === 3);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
}

runAgentTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
