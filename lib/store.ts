import { v4 as uuid } from "uuid";
import { Slot, Appointment } from "./types";

/**
 * In-memory store. Deliberately simple (per the exercise brief, "an in-memory
 * store is fine"). Kept behind a small module interface so it could be swapped
 * for a real DB later without touching the tool/agent layer.
 *
 * Stored on `globalThis` rather than as plain module-level variables because
 * Next.js dev mode hot-reloads route modules on every edit — without this,
 * the schedule would silently reset mid-demo every time a file changes.
 */

interface StoreState {
  slots: Map<string, Slot>;
  appointments: Map<string, Appointment>;
  seededOn: string;
}

const globalForStore = globalThis as unknown as { __lakesideStore?: StoreState };

function getState(): StoreState {
  if (!globalForStore.__lakesideStore) {
    globalForStore.__lakesideStore = { slots: new Map(), appointments: new Map(), seededOn: "" };
  }
  return globalForStore.__lakesideStore;
}

const BUSINESS_HOURS = [
  "09:00", "09:30", "10:00", "10:30", "11:00", "11:30",
  "13:00", "13:30", "14:00", "14:30", "15:00", "15:30", "16:00", "16:30",
]; // lunch break 12:00-13:00

function todayISO(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function ensureCurrentSeed(): StoreState {
  const state = getState();
  if (state.seededOn !== todayISO()) seedStore();
  return getState();
}

/** Deterministic pseudo-randomness so the seed is stable across restarts (no Math.random surprises during a live demo). */
function seededPick(seed: number, mod: number): number {
  return Math.abs(Math.sin(seed) * 10000) % mod | 0;
}

export function seedStore(): void {
  const state = getState();
  state.slots.clear();
  state.appointments.clear();
  state.seededOn = todayISO();

  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    const date = todayISO(dayOffset);

    // Day index 3 (3 days from now) is fully booked on purpose, so there is
    // always a guaranteed "sorry, nothing available" scenario to test.
    const fullyBooked = dayOffset === 3;

    BUSINESS_HOURS.forEach((time, i) => {
      const id = uuid();
      const seed = dayOffset * 100 + i;
      // Roughly a third of remaining slots are pre-booked so results look realistic.
      const preBooked = fullyBooked || seededPick(seed, 3) === 0;

      const slot: Slot = { id, date, time, booked: false };
      state.slots.set(id, slot);

      if (preBooked) {
        const appt: Appointment = {
          id: uuid(),
          slotId: id,
          name: "Existing Patient",
          phone: "555-0100",
          createdAt: new Date().toISOString(),
        };
        state.appointments.set(appt.id, appt);
        slot.booked = true;
        slot.appointmentId = appt.id;
      }
    });
  }
}

export function getWindowDates(): string[] {
  return Array.from({ length: 7 }, (_, i) => todayISO(i));
}

export function isDateInWindow(date: string): boolean {
  return getWindowDates().includes(date);
}

export function listAvailableSlotsForDate(date: string): Slot[] {
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const today = todayISO();

  return Array.from(ensureCurrentSeed().slots.values())
    .filter((s) => {
      if (s.date !== date || s.booked) return false;
      if (s.date !== today) return true;
      const [hours, minutes] = s.time.split(":").map(Number);
      return hours * 60 + minutes > currentMinutes;
    })
    .sort((a, b) => a.time.localeCompare(b.time));
}

export function getSlot(slotId: string): Slot | undefined {
  return ensureCurrentSeed().slots.get(slotId);
}

export function bookSlot(slotId: string, name: string, phone: string): Appointment | { error: string } {
  const state = ensureCurrentSeed();
  const slot = state.slots.get(slotId);
  if (!slot) return { error: "SLOT_NOT_FOUND" };
  if (slot.booked) return { error: "SLOT_ALREADY_BOOKED" };

  const appt: Appointment = {
    id: uuid(),
    slotId,
    name,
    phone,
    createdAt: new Date().toISOString(),
  };
  state.appointments.set(appt.id, appt);
  slot.booked = true;
  slot.appointmentId = appt.id;
  return appt;
}

export function cancelAppointmentById(appointmentId: string): { ok: true } | { error: string } {
  const state = ensureCurrentSeed();
  const appt = state.appointments.get(appointmentId);
  if (!appt) return { error: "APPOINTMENT_NOT_FOUND" };

  const slot = state.slots.get(appt.slotId);
  if (slot) {
    slot.booked = false;
    slot.appointmentId = undefined;
  }
  state.appointments.delete(appointmentId);
  return { ok: true };
}

export function findAppointmentsByPhone(phone: string): Appointment[] {
  const normalized = phone.replace(/\D/g, "");
  return Array.from(ensureCurrentSeed().appointments.values()).filter(
    (a) => a.phone.replace(/\D/g, "") === normalized,
  );
}

export function getAppointment(appointmentId: string): Appointment | undefined {
  return ensureCurrentSeed().appointments.get(appointmentId);
}

// Seed on first import only (guarded, since this module can be re-imported
// across route handlers within the same running server).
if (!globalForStore.__lakesideStore) {
  seedStore();
}
