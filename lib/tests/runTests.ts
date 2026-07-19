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

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
}

runAgentTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
