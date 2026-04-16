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

const requestSchema = z.object({
  messages: z.array(z.any()),
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
  const messages = body.messages as UIMessage[];
  const steps = body.maxSteps ?? 8;
  const tokens = body.maxTokens ?? 4000;

  const stream = createUIMessageStream({
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

      // Pipe through json-render transform — extracts ```spec fences as data parts
      writer.merge(pipeJsonRender(result.toUIMessageStream()));
    },
  });

  return createUIMessageStreamResponse({ stream });
}
