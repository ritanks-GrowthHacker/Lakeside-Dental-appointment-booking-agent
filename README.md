# Lakeside Dental Scheduling Agent

Lakeside Dental is a small conversational scheduling application for a fictional dental clinic. A patient can ask about available times, book an appointment, find an existing appointment by phone number, or cancel an appointment through a simple chat interface.

The project is intentionally focused on one question: how should an LLM participate in a workflow that changes real application state without being trusted to invent facts or decide whether an operation succeeded?

## Running the project

### Requirements

- Node.js 22
- An OpenAI API key

Create a local environment file from the example and add your key:

```bash
cp .env.example .env.local
npm install
npm run dev
```

On PowerShell, use `Copy-Item .env.example .env.local` instead of `cp`.

The application will be available at [http://localhost:3000](http://localhost:3000). The model can be changed with `OPENAI_MODEL`; the default is `gpt-4o-mini`.

`CLINIC_TIME_ZONE` controls date words such as "today" and "tomorrow" and defaults to `Asia/Kolkata`. Set `SESSION_SECRET` to a long random value in production; it signs the portable conversation state used across serverless instances.

Before submitting changes, run:

```bash
npm test
npm run lint
npx tsc --noEmit
npm run build
```

The automated tests do not require an OpenAI API key. They use a mocked model client to test the tool-calling loop alongside deterministic tests for validation, booking, lookup, and cancellation.

## How it works

The frontend and backend live in one Next.js application:

```text
Patient
  -> React chat interface
  -> POST /api/chat
  -> server-side conversation history
  -> OpenAI tool-calling loop
  -> validated application tool
  -> appointment store
  -> conversational response
```

The main application areas are:

```text
app/
  ChatApp.tsx                    Chat interface
  api/chat/route.ts              Chat API and request validation
  api/debug/availability/route.ts
  api/debug/reset/route.ts

lib/
  agent.ts                       OpenAI tool-calling loop
  systemPrompt.ts                Assistant behavior and boundaries
  toolSchemas.ts                 Tool definitions exposed to the model
  tools.ts                       Validated application operations
  validation.ts                  Input and business-rule validation
  store.ts                       In-memory slots and appointments
  sessions.ts                    Server-side conversation history
  tests/runTests.ts              Deterministic and mocked-agent tests
```

## Architectural decisions

### One Next.js application

Next.js App Router is used for both the React interface and server endpoints. This keeps the exercise easy to run and deploy while preserving a clear boundary between the UI, agent orchestration, tools, and storage. The code under `lib/` does not depend on React and can be moved behind another HTTP framework later if needed.

### The model handles language; code handles truth

The model is responsible for understanding conversational requests, collecting missing details, choosing a tool, and explaining the result naturally.

The model is not the source of truth for availability or successful state changes. Tool implementations validate their arguments and consult the store before booking or cancelling anything. A booking can only succeed when the referenced slot exists and is still open, so a stale conversation cannot override current application state.

This boundary matters because availability may change between two messages. The assistant is instructed to perform a fresh availability check whenever a patient selects a time, including a time mentioned earlier in the same conversation.

### A direct tool-calling loop

The agent uses the OpenAI SDK directly. Each turn sends the server-held conversation history and tool schemas to the model. When the model requests a tool, the application executes it, appends the structured result to the history, and asks the model to continue. The loop ends when the model returns a normal response.

The loop has a five-iteration limit so an unexpected model response cannot keep a request running indefinitely. If a booking or cancellation succeeds but the following model request fails, the server creates a deterministic confirmation from the successful tool result. This avoids leaving the patient uncertain about whether a write occurred.

### Server-side conversation history

The browser sends only a session ID and the newest message. Conversation history, including trusted tool results, remains on the server. This prevents a client from rewriting an earlier tool response and presenting fabricated availability to the model.

For this exercise, sessions are stored in memory. Both session and appointment state are attached to `globalThis` so ordinary Next.js development hot reloads do not reset the demo unexpectedly.

### Four focused tools

The agent can use:

- `get_available_slots` to obtain current openings for a valid date.
- `book_appointment` to atomically book an open slot for a validated patient.
- `cancel_appointment` to cancel an appointment by ID and reopen its slot.
- `find_appointments_by_phone` to help a patient who no longer has an appointment ID.

The phone lookup is included because forgetting a confirmation ID is a common non-happy-path conversation. In a production clinic it would require identity verification before returning or changing patient information.

### Deterministic demo data

The store creates seven days of 30-minute appointments from 09:00 to 16:30, with a lunch break between 12:00 and 13:00. Past times on the current date are not offered. Some appointments are pre-booked deterministically, and the fourth day is fully booked so the unavailable-day behavior is easy to demonstrate and reproduce.

## API endpoints

### `POST /api/chat`

Accepts:

```json
{
  "sessionId": "browser-session-id",
  "message": "What is available tomorrow?"
}
```

Returns the assistant response and session ID.

### `GET /api/debug/availability`

Returns the seeded seven-day schedule without using the model. It is useful for verifying that the assistant reports real availability.

### `POST /api/debug/reset`

Reseeds the appointment store and clears conversation sessions. It is intended for local testing between demo scenarios.

The debug endpoints should be disabled or protected before any real deployment.

## Scope and production considerations

This is an interview-sized implementation rather than a production clinical system. Its deliberate constraints are:

- Appointments and sessions are held in memory and reset when the process restarts.
- State is local to one server process and cannot be shared safely across multiple instances.
- There is one clinic schedule with uniform 30-minute appointments.
- Authentication, authorization, rate limiting, audit logging, and patient identity verification are not implemented.
- Phone-based lookup is suitable for demonstrating the conversation but not for exposing real patient information.
- Debug endpoints are intended only for local development.

A production version would move appointment state to a transactional database, session state to durable storage with expiration, enforce uniqueness for each slot at the database level, introduce patient verification and authorization, configure an explicit clinic timezone, protect operational endpoints, and add monitoring and rate limits.

## Why this design

The design keeps the conversational layer replaceable and the important business behavior testable without a live model. The LLM can vary its wording and interpretation, while the validation, availability, booking, and cancellation rules remain ordinary TypeScript functions with deterministic tests. That separation makes failures easier to diagnose and the project easier to extend or maintain.
