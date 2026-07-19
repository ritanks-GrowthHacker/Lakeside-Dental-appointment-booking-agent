import OpenAI from "openai";

type ChatCompletionTool = OpenAI.Chat.Completions.ChatCompletionTool;

export const toolSchemas: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_available_slots",
      description:
        "Get open appointment slots for a specific date at Lakeside Dental Clinic. Always call this before booking, even if you think you already know availability — it may have changed.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          date: {
            type: "string",
            description: "Date to check, in YYYY-MM-DD format. Must be within the next 7 days including today.",
          },
        },
        required: ["date"],
      },
      strict: true,
    },
  },
  {
    type: "function",
    function: {
      name: "book_appointment",
      description:
        "Book a specific open slot for a patient. Only call this after you have confirmed the slotId (from get_available_slots), the patient's full name, and phone number, and the patient has explicitly confirmed they want to book.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          slotId: {
            type: "string",
            description: "The exact slotId returned by get_available_slots. Never invent or guess a slotId.",
          },
          name: {
            type: "string",
            description: "Full name of the patient the appointment is for.",
          },
          phone: {
            type: "string",
            description: "Patient's phone number, used for confirmation and future lookups.",
          },
        },
        required: ["slotId", "name", "phone"],
      },
      strict: true,
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_appointment",
      description:
        "Cancel an existing appointment by its appointmentId. If the patient does not know their appointmentId, use find_appointments_by_phone first to look it up.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          appointmentId: {
            type: "string",
            description: "The appointmentId to cancel.",
          },
        },
        required: ["appointmentId"],
      },
      strict: true,
    },
  },
  {
    type: "function",
    function: {
      name: "find_appointments_by_phone",
      description:
        "Look up existing appointments for a patient using their phone number. Use this when a patient wants to cancel or check an appointment but doesn't know their appointmentId.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          phone: {
            type: "string",
            description: "The phone number the appointment was booked under.",
          },
        },
        required: ["phone"],
      },
      strict: true,
    },
  },
];
