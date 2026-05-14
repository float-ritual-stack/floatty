import {
  streamText,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  hasToolCall,
  wrapLanguageModel,
  gateway,
  type UIMessage,
  type ModelMessage,
} from "ai";
import { z } from "zod";
import { devToolsMiddleware } from "@ai-sdk/devtools";
import { pipeJsonRender } from "@json-render/core";
import {
  EXPLORER_INSTRUCTIONS,
  getExplorerTools,
} from "@/lib/agents/explorer-agent";
import { getSession, updateSession } from "@/lib/sessions/store";
import { extractBlockRefs } from "@/lib/sessions/block-index";

// Per ai-sdk persistence doc, the canonical wire shape is:
//   client sends `{ id, message }` (single new message)
//   server loads previous messages from store, appends, streams response
//   server saves the resulting messages array on stream finish
// The client-side `prepareSendMessagesRequest` (configured in ai-panel.tsx)
// trims the request body to this shape; legacy `{ messages }` is still
// accepted for backwards compat / non-persisted ad-hoc calls.
const requestSchema = z.object({
  id: z.string().optional(),
  message: z.unknown().optional(),
  messages: z.array(z.unknown()).optional(),
  maxSteps: z.number().int().min(1).max(20).optional(),
  maxTokens: z.number().int().min(500).max(16000).optional(),
});

/**
 * Filter empty text content blocks that cause Anthropic API errors.
 * The AI SDK types don't account for this edge case, so we use a
 * targeted type assertion on the content array only.
 */
function filterEmptyTextParts(msgs: ModelMessage[]): ModelMessage[] {
  return msgs
    .map((msg) => {
      if (!Array.isArray(msg.content)) return msg;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const filtered = (msg.content as any[]).filter(
        (part: { type: string; text?: string }) =>
          !(part.type === "text" && part.text === "")
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return filtered.length > 0 ? ({ ...msg, content: filtered } as any) : null;
    })
    .filter((msg): msg is ModelMessage => msg !== null);
}

export async function POST(req: Request) {
  const body = requestSchema.parse(await req.json());
  const steps = body.maxSteps ?? 8;
  const tokens = body.maxTokens ?? 4000;

  // Resolve the message array to feed the model. Two paths:
  //   1. Persisted-session path: client sent `{ id, message }`; we load
  //      previous messages from the store and append.
  //   2. Legacy/ad-hoc path: client sent the full `messages` array.
  // We also remember `originalMessages` so the onFinish callback can append
  // the assistant response and write it back to the store.
  let messages: UIMessage[];
  if (body.id && body.message !== undefined) {
    const session = getSession(body.id);
    const previous = (session?.messages ?? []) as UIMessage[];
    messages = [...previous, body.message as UIMessage];
  } else if (body.messages) {
    messages = body.messages as UIMessage[];
  } else {
    return new Response(
      JSON.stringify({ error: "Missing `id`+`message` or `messages`" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const originalMessages = messages;
  const sessionId = body.id ?? null;

  const stream = createUIMessageStream({
    originalMessages,
    onFinish: ({ messages: finalMessages }) => {
      if (!sessionId) return; // ad-hoc call, no persistence
      const blockRefs = extractBlockRefs({
        messages: finalMessages as Parameters<typeof extractBlockRefs>[0]["messages"],
      });
      updateSession(sessionId, {
        messages: finalMessages,
        blockRefs,
      });
    },
    execute: async ({ writer }) => {
      const modelMessages = await convertToModelMessages(messages);
      const filteredMessages = filterEmptyTextParts(modelMessages);

      const model = wrapLanguageModel({
        model: gateway("anthropic/claude-sonnet-4"),
        middleware: devToolsMiddleware(),
      });

      const tools = await getExplorerTools();

      const result = streamText({
        model,
        system: EXPLORER_INSTRUCTIONS,
        tools,
        stopWhen: [stepCountIs(steps), hasToolCall("suggest_walks")],
        maxOutputTokens: tokens,
        messages: filteredMessages,
        onFinish({ finishReason, steps: finishedSteps }) {
          const lastStep = finishedSteps[finishedSteps.length - 1];
          const completedViaSuggests =
            lastStep?.toolCalls?.some(
              (tc) => (tc as { toolName: string }).toolName === "suggest_walks"
            ) ?? false;
          writer.write({
            type: "data-step-status" as `data-${string}`,
            data: {
              finishReason: completedViaSuggests ? "completed" : finishReason,
              maxSteps: steps,
            },
          });
        },
      });

      // Ensure the stream runs to completion even if the client disconnects,
      // so persistence still fires via onFinish. Per the AI SDK persistence
      // guide: `consumeStream()` removes backpressure.
      result.consumeStream();

      // Pipe through json-render transform — extracts ```spec fences as data parts
      writer.merge(pipeJsonRender(result.toUIMessageStream()));
    },
  });

  return createUIMessageStreamResponse({ stream });
}
