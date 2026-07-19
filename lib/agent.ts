import OpenAI from "openai";
import { toolSchemas } from "./toolSchemas";
import { runTool, ToolName } from "./tools";
import { buildSystemPrompt } from "./systemPrompt";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const MAX_TOOL_ITERATIONS = 5;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

interface CompletedAction {
  name: "book_appointment" | "cancel_appointment";
  result: Record<string, unknown>;
}

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
): Promise<{ reply: string; history: ChatMessage[] }> {
  const updatedHistory = [...history];
  const completedActions: CompletedAction[] = [];

  // System prompt is rebuilt fresh each turn so "today's date" and the
  // 7-day window are always current, even in a conversation that runs
  // past midnight.
  const messages: ChatMessage[] = [{ role: "system", content: buildSystemPrompt() }, ...updatedHistory];

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

      const result = runTool(toolCall.function.name as ToolName, args);

      if (
        result.ok &&
        (toolCall.function.name === "book_appointment" || toolCall.function.name === "cancel_appointment")
      ) {
        completedActions.push({
          name: toolCall.function.name,
          result: (result.data || {}) as Record<string, unknown>,
        });
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
