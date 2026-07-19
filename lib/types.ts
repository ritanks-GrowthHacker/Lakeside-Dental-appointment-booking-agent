export interface Slot {
  id: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:mm, 24h
  booked: boolean;
  appointmentId?: string;
}

export interface Appointment {
  id: string;
  slotId: string;
  name: string;
  phone: string;
  createdAt: string;
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface ChatRequestBody {
  sessionId: string;
  message: string;
}

export interface ChatResponseBody {
  reply: string;
  sessionId: string;
}
