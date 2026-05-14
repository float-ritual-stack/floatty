import {
  streamText,
  generateText,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  hasToolCall,
  wrapLanguageModel,
  gateway,
  validateUIMessages,
  TypeValidationError,
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
  // Hoist origin metadata outside the persisted-session branch so the
  // onFinish closure can pass it through to extractBlockRefs — otherwise
  // the `context` source rows never get written to session_blocks and
  // listSessionsByBlock(blockId) silently misses sessions started with
  // that block in context. (Greptile P1.)
  let messages: UIMessage[];
  let sessionOriginPageId: string | null = null;
  let sessionOriginSelected: string[] = [];
  if (body.id && body.message !== undefined) {
    const session = getSession(body.id);
    sessionOriginPageId = session?.originPageId ?? null;
    sessionOriginSelected = session?.originSelected ?? [];
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
        originPageId: sessionOriginPageId,
        originSelectedIds: sessionOriginSelected,
      });
      updateSession(sessionId, {
        messages: finalMessages,
        blockRefs,
      });
      // Fire-and-forget: name the session from the conversation arc once
      // it has enough material (1+ assistant turn) and is still on the
      // default "New conversation" title. Don't await — title generation
      // shouldn't block the response stream from closing.
      void maybeGenerateTitle(sessionId, finalMessages);
    },
    execute: async ({ writer }) => {
      const tools = await getExplorerTools();

      // Per ai-sdk persistence guide, validate loaded messages against the
      // current tool schemas before sending to the model. If a stored session
      // contains tool calls whose schemas have since changed, we'd otherwise
      // pass malformed args downstream. Fall back to the unvalidated array on
      // TypeValidationError — defensive, preserves existing sessions across
      // tool-schema drift. Re-throws non-validation errors.
      let validatedMessages = messages;
      try {
        validatedMessages = (await validateUIMessages({
          messages,
          // Cast: validateUIMessages' tools-shape generic is narrower than the
          // ToolSet union we load (the `load_skill` tool is conditional). The
          // runtime behavior is correct; the type asserts here keep TS happy
          // without forcing every tool through the same shape.
          tools: tools as Parameters<typeof validateUIMessages>[0]["tools"],
        })) as UIMessage[];
      } catch (err) {
        if (!(err instanceof TypeValidationError)) throw err;
        console.warn(
          "[chat/route] message validation failed, proceeding with raw messages:",
          err.message
        );
      }

      const modelMessages = await convertToModelMessages(validatedMessages);
      const filteredMessages = filterEmptyTextParts(modelMessages);

      const model = wrapLanguageModel({
        // Vercel AI Gateway model IDs — fetched fresh via
        // `curl https://ai-gateway.vercel.sh/v1/models`. Bump as new
        // versions ship; do not pin a stale ID from memory.
        model: gateway("anthropic/claude-sonnet-4.6"),
        middleware: devToolsMiddleware(),
      });

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

/**
 * Auto-name a session once it has enough conversation arc. Runs after the
 * stream's onFinish fires, fire-and-forget so the response can close. Only
 * acts when the session is still on the default "New conversation" title
 * AND there is at least one user+assistant turn pair. Uses a small, cheap
 * model (haiku) — title generation isn't worth the sonnet budget.
 */
async function maybeGenerateTitle(
  sessionId: string,
  finalMessages: UIMessage[]
): Promise<void> {
  try {
    const session = getSession(sessionId);
    if (!session) return;
    if (session.title && session.title !== "New conversation") return;

    const userTurns = finalMessages.filter((m) => m.role === "user").length;
    const assistantTurns = finalMessages.filter((m) => m.role === "assistant").length;
    if (userTurns < 1 || assistantTurns < 1) return;

    // Compose a small digest of the first turns for titling — skip the
    // contextual preamble baked into every user message by buildContextMessage.
    const digestParts: string[] = [];
    for (const msg of finalMessages.slice(0, 4)) {
      const parts = (msg as { parts?: Array<{ type: string; text?: string }> }).parts;
      if (!Array.isArray(parts)) continue;
      for (const p of parts) {
        if (p.type !== "text" || typeof p.text !== "string") continue;
        const txt = p.text;
        const marker = "Then:\n\n";
        const idx = txt.lastIndexOf(marker);
        const useful = idx >= 0 ? txt.slice(idx + marker.length) : txt;
        digestParts.push(`${msg.role.toUpperCase()}: ${useful.slice(0, 400)}`);
      }
    }
    if (digestParts.length === 0) return;

    const result = await generateText({
      model: gateway("anthropic/claude-haiku-4.5"),
      maxOutputTokens: 60,
      system:
        "You write short titles for chat sessions. Output ONLY the title — 3 to 7 words, no quotes, no punctuation at the end, no leading verbs like 'discussing' or 'about'. Capture the topic, not the medium.",
      prompt: `Title this chat session:\n\n${digestParts.join("\n\n")}`,
    });

    const title = result.text
      .trim()
      .replace(/^["'`]|["'`]$/g, "")
      .replace(/\.$/, "")
      .slice(0, 80);
    if (!title) return;

    updateSession(sessionId, { title });
  } catch (err) {
    console.warn("[chat/route] auto-title failed:", err);
  }
}
