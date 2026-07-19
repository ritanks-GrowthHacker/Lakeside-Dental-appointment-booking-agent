import OpenAI from "openai";
import { toolSchemas } from "./toolSchemas";
import { runTool, ToolName } from "./tools";
import { buildSystemPrompt } from "./systemPrompt";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const MAX_TOOL_ITERATIONS = 5;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

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
 *
 * `openai` is injectable so tests can pass a fake client and exercise this
 * loop deterministically without a live API key or network call.
 */
export async function runAgentTurn(
  history: ChatMessage[],
  openai: OpenAI = getClient(),
): Promise<{ reply: string; history: ChatMessage[] }> {
  // System prompt is rebuilt fresh each turn so "today's date" and the
  // 7-day window are always current, even in a conversation that runs
  // past midnight.
  const messages: ChatMessage[] = [{ role: "system", content: buildSystemPrompt() }, ...history];

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages,
      tools: toolSchemas,
      tool_choice: "auto",
      temperature: 0,
    });

    const choice = response.choices[0];
    const message = choice.message;

    // No tool calls -> the model is done, this is the reply to show the user.
    if (!message.tool_calls || message.tool_calls.length === 0) {
      const reply = message.content?.trim() || "Sorry, I didn't catch that — could you rephrase?";
      const updatedHistory = [...history, { role: "assistant", content: reply } as ChatMessage];
      return { reply, history: updatedHistory };
    }

    // Record the assistant's tool-call message, then execute each tool
    // call and append its result before looping back to the model.
    messages.push(message);
    history.push(message);

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

      const toolMessage: ChatMessage = {
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      };
      messages.push(toolMessage);
      history.push(toolMessage);
    }
  }

  // Safety valve: if we somehow loop MAX_TOOL_ITERATIONS times without a
  // final text answer, fail gracefully instead of hanging the request.
  const fallback =
    "Sorry, I'm having trouble completing that right now. Could you try rephrasing your request, or ask me to check availability again?";
  const updatedHistory = [...history, { role: "assistant", content: fallback } as ChatMessage];
  return { reply: fallback, history: updatedHistory };
}
