import { isDateInWindow } from "./store";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Accepts formats like 555-0100, (555) 010-0100, 5550100100, +1 555 010 0100.
// Intentionally permissive on formatting but strict on digit count (7-15 digits,
// per the loose international range) so we reject obvious junk like "abc" or "123".
const PHONE_DIGITS_RE = /^\+?[\d\s().-]{7,20}$/;

export function validateDateFormat(date: unknown): { ok: true } | { ok: false; error: string } {
  if (typeof date !== "string" || !DATE_RE.test(date)) {
    return { ok: false, error: "Date must be in YYYY-MM-DD format." };
  }
  const [year, month, day] = date.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return { ok: false, error: "That is not a valid calendar date." };
  }
  return { ok: true };
}

export function validateDateInWindow(date: string): { ok: true } | { ok: false; error: string } {
  if (!isDateInWindow(date)) {
    return {
      ok: false,
      error: `We only take bookings within the next 7 days. "${date}" is outside that window.`,
    };
  }
  return { ok: true };
}

export function validateName(name: unknown): { ok: true } | { ok: false; error: string } {
  if (typeof name !== "string" || name.trim().length < 2) {
    return { ok: false, error: "Please provide the patient's full name (at least 2 characters)." };
  }
  if (name.trim().length > 100) {
    return { ok: false, error: "That name looks too long — please double check it." };
  }
  return { ok: true };
}

export function validatePhone(phone: unknown): { ok: true } | { ok: false; error: string } {
  if (typeof phone !== "string" || !PHONE_DIGITS_RE.test(phone.trim())) {
    return { ok: false, error: "That doesn't look like a valid phone number. Please provide digits, e.g. 555-010-0100." };
  }
  const digitCount = phone.replace(/\D/g, "").length;
  if (digitCount < 7 || digitCount > 15) {
    return { ok: false, error: "Phone number should have between 7 and 15 digits." };
  }
  return { ok: true };
}

export function validateSlotId(slotId: unknown): { ok: true } | { ok: false; error: string } {
  if (typeof slotId !== "string" || slotId.trim().length === 0) {
    return { ok: false, error: "A valid slotId is required." };
  }
  return { ok: true };
}

export function validateAppointmentId(appointmentId: unknown): { ok: true } | { ok: false; error: string } {
  if (typeof appointmentId !== "string" || appointmentId.trim().length === 0) {
    return { ok: false, error: "A valid appointmentId is required." };
  }
  return { ok: true };
}
