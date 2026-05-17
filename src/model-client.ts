/**
 * model-client — calls the supervisor LLM using pi's internal agent session API.
 *
 * callModel        — low-level: returns raw response text
 * callSupervisorModel — high-level: parses response as SteeringDecision
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import type { SteeringDecision } from "./types.js";

const MODEL_CALL_MAX_ATTEMPTS = 2;
const MODEL_CALL_RETRY_DELAY_MS = 350;

/**
 * Run a one-shot LLM call using pi's internal agent session.
 * Returns the raw response text, or null on failure.
 * Retries once on transient session/prompt failures, but never retries after abort.
 */
export async function callModel(
  ctx: ExtensionContext,
  provider: string,
  modelId: string,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
  onDelta?: (accumulated: string) => void
): Promise<string | null> {
  const model = ctx.modelRegistry.find(provider, modelId);
  if (!model) return null;

  // pi-coding-agent 0.72.x requires cwd + agentDir on the loader and
  // renamed `systemPromptOverride: () => string` → `systemPrompt: string`.
  const loader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPrompt,
  });
  await loader.reload();

  for (let attempt = 1; attempt <= MODEL_CALL_MAX_ATTEMPTS; attempt++) {
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    let onAbort: (() => void) | undefined;
    let unsubscribe = () => {};
    let responseText = "";

    try {
      const result = await createAgentSession({
        sessionManager: SessionManager.inMemory(),
        modelRegistry: ctx.modelRegistry,
        model,
        tools: [],
        resourceLoader: loader,
      });
      session = result.session;

      const activeSession = session;
      onAbort = () => activeSession.abort();
      signal?.addEventListener("abort", onAbort, { once: true });

      unsubscribe = activeSession.subscribe((event) => {
        if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "text_delta"
        ) {
          responseText += event.assistantMessageEvent.delta;
          onDelta?.(responseText);
        }
      });

      await activeSession.prompt(userPrompt);
      return responseText;
    } catch {
      if (signal?.aborted) return null;
      if (attempt === MODEL_CALL_MAX_ATTEMPTS) return null;
      const shouldRetry = await waitForRetry(MODEL_CALL_RETRY_DELAY_MS, signal);
      if (!shouldRetry) return null;
    } finally {
      unsubscribe();
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      session?.dispose();
    }
  }

  return null;
}

/**
 * Run a one-shot supervisor analysis.
 * Returns { action: "continue" } on any failure so the chat is never interrupted.
 */
export async function callSupervisorModel(
  ctx: ExtensionContext,
  provider: string,
  modelId: string,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
  onDelta?: (accumulated: string) => void
): Promise<SteeringDecision> {
  const text = await callModel(ctx, provider, modelId, systemPrompt, userPrompt, signal, onDelta);
  if (text === null) return safeContinue("Model call failed");
  return parseDecision(text);
}

// ---- Response parsing ----

/**
 * Parse a supervisor LLM response into a SteeringDecision.
 * Tolerates: bare JSON, ```json fenced blocks, JSON wrapped in prose.
 * Falls back to {action: "continue", confidence: 0} on any parse failure or
 * invalid action — the chat is never interrupted by a malformed response.
 *
 * Exported for unit tests; not part of the public extension contract.
 */
export function parseDecision(text: string): SteeringDecision {
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ?? text.match(/(\{[\s\S]*\})/);
  const jsonStr = jsonMatch?.[1] ?? text.trim();

  try {
    const parsed = JSON.parse(jsonStr) as Partial<SteeringDecision>;
    const action = parsed.action;
    if (action !== "continue" && action !== "steer" && action !== "done") {
      return safeContinue("Invalid action in supervisor response");
    }
    return {
      action,
      message: typeof parsed.message === "string" ? parsed.message.trim() : undefined,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
    };
  } catch {
    return safeContinue("Failed to parse supervisor JSON decision");
  }
}

async function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;

  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);

    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(false);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function safeContinue(reason: string): SteeringDecision {
  return { action: "continue", reasoning: reason, confidence: 0 };
}
