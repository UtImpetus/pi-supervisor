/**
 * engine — supervisor analysis logic.
 *
 * Builds conversation snapshots from session history,
 * constructs prompts, and calls the supervisor model.
 *
 * System prompt discovery order (model-specific takes priority at each level):
 *   1. <cwd>/.pi/<modelId>-SUPERVISOR.md   — project-local, model-specific
 *   2. <cwd>/.pi/SUPERVISOR.md             — project-local, model-agnostic
 *   3. ~/.pi/agent/<modelId>-SUPERVISOR.md  — global, model-specific
 *   4. ~/.pi/agent/SUPERVISOR.md            — global, model-agnostic
 *   5. Built-in model-specific prompt        — hardcoded per model prefix
 *   6. Built-in default template            — fallback
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { SupervisorPayloadDebugOptions } from "./debug.js";
import type { SupervisorEvidenceItem } from "./evidence.js";
import { summarizeEvidenceForPrompt } from "./evidence.js";
import { callSupervisorModel } from "./model-client.js";
import type { ConversationMessage, SensitivityConfig, SteeringDecision, SupervisorState } from "./types.js";
import { resolveSensitivityConfig } from "./types.js";

// ---- System prompt loading ----

const SUPERVISOR_MD = "SUPERVISOR.md";
const CONFIG_DIR = ".pi";
const GLOBAL_AGENT_DIR = join(homedir(), ".pi", "agent");

/** Built-in fallback system prompt (default, used when no model-specific match). */
const BUILTIN_SYSTEM_PROMPT = `You are a supervisor monitoring a coding AI assistant conversation.
Your job: ensure the assistant fully achieves a specific outcome without needing the human to intervene.

═══ WHEN THE AGENT IS IDLE (finished its turn, waiting for user input) ═══
This is your most important moment. The agent has stopped and is waiting.
You MUST choose "done" or "steer". Never return "continue" when the agent is idle.

- "done"  → only when the outcome is completely and verifiably achieved.
- "steer" → everything else: incomplete work, partial progress, open questions, waiting for confirmation.

If the agent asked a clarifying question or needs a decision:
  FIRST check: is this question necessary to achieve the goal?
  - YES (directly blocks goal progress): answer with a sensible default and tell agent to proceed.
  - NO (out of scope, nice-to-have, unrelated feature): do NOT answer it. Redirect:
    "That's outside the scope of the goal. Focus on: [restate the specific missing piece of the goal]."
  DO NOT answer: passwords, credentials, secrets, anything requiring real user knowledge.

Your steer message speaks AS the user. Make it clear, direct, and actionable (1–3 sentences).
Do not ask the agent to verify its own work — tell it what to do next.

═══ WHEN THE AGENT IS ACTIVELY WORKING (mid-turn) ═══
Only intervene if it is clearly heading in the wrong direction.
Trust the agent to complete what it has started. Avoid interrupting productive work.

═══ STEERING RULES ═══
- Be specific: reference the outcome, missing pieces, or the question being answered.
- Never repeat a steering message that had no effect — escalate or change approach.
- A good steer answers the agent's question OR redirects to the missing piece of the outcome.
- If the agent is taking shortcuts to satisfy the goal without properly achieving it, always steer and remind it not to take shortcuts.
- Prefer concrete tool evidence over assistant claims. If recent tool evidence or claim/evidence warnings
  contradict the assistant's summary, trust the evidence.
- Treat "CLAIM / EVIDENCE WARNINGS" as high-signal. If they indicate missing verification for a required
  external surface or contract, prefer "steer" over "done".

"done" CRITERIA: The core outcome is complete and functional. Minor polish, style tweaks, or
optional improvements do NOT block "done". Prefer stopping when the goal is substantially
achieved rather than looping forever chasing perfection.
If the outcome requires externally visible behavior (such as CLI behavior, public imports/exports,
exact output shape, or invalid-input handling), do NOT return "done" unless recent evidence shows
those surfaces were actually checked. Passing the agent's own tests is helpful but not sufficient
when the required contract verification is still missing.

Respond ONLY with valid JSON — no prose, no markdown fences.
Response schema (strict JSON):
{
  "action": "continue" | "steer" | "done",
  "message": "...",     // Required when action === "steer"
  "reasoning": "...",   // Brief internal reasoning
  "confidence": 0.85    // Float 0-1
}`;

/**
 * Built-in model-specific prompts, keyed by modelId prefix (lowercase).
 * A modelId matches if its lowercase form starts with the key.
 * Longer/more-specific keys take priority over shorter ones.
 *
 * To add a new model-specific prompt, add an entry here with the modelId prefix
 * as the key. The prompt will be used when the supervisor model's ID starts with
 * that prefix (case-insensitive).
 *
 * File-based overrides (.pi/<modelId>-SUPERVISOR.md, ~/.pi/agent/<modelId>-SUPERVISOR.md)
 * always take priority over these built-in prompts.
 */
const BUILTIN_MODEL_PROMPT_PREFIXES: Record<string, string> = {
  deepseek: `You are a supervisor monitoring a coding AI assistant conversation, powered by a DeepSeek model.
Your job: ensure the assistant fully achieves a specific outcome without needing the human to intervene.

DeepSeek-powered agents frequently exhibit these failure modes. Watch for them and steer aggressively:

═══ DEEPSEEK-SPECIFIC FAILURE MODES ═══
1. WRAPPING RETURNS: DeepSeek agents tend to wrap function return values in extra dicts like
   {"result": ...} when the spec says to return the value directly. If the outcome specifies return
   shapes (lists, dicts, strings), steer the agent to return them raw — not nested inside "result".

2. EXTERNAL INTERFACE / EXPOSURE: DeepSeek agents often implement the internal change but forget to
   wire up the promised external surface. When the outcome requires public functions, commands,
   routes, exports, entry points, files, imports, package-level APIs, or config-visible behavior,
   verify the deliverable is actually reachable through that surface before saying "done".

3. FIELD NAMING INCONSISTENCY: DeepSeek agents sometimes use abbreviated field names (col, dir, desc)
   when the spec uses full names (column, direction, description). If the outcome or examples specify
   exact field names, steer the agent to match them exactly.

4. EXTRA FIELDS IN OUTPUT: DeepSeek agents add convenience fields that the spec doesn't define
   (e.g., a "file" key in each item). If the outcome specifies a schema, the output must contain ONLY
   the specified fields — no extras, no missing ones.

5. CASE MISMATCH / CANONICALIZATION DRIFT: DeepSeek agents change the casing or textual form of
   externally visible values (for example \`Z\` → \`+00:00\`, \`active\` → \`Active\`, or adding/removing
   leading blank lines). Match the exact casing, spelling, and canonical text form from the outcome/examples.

6. RETURN TYPE / INPUT SHAPE VIOLATIONS: DeepSeek agents return dicts when the spec says string, or
   arrays when the spec says scalar. They also invent convenience input formats (like string shorthands)
   instead of the likely JSON-facing object shape. Verify return types and accepted input shapes exactly.

7. INVALID-INPUT LENIENCY: DeepSeek agents often accept malformed input by returning an empty result,
   partial parse, or ignored command instead of failing. If the outcome says malformed input must fail
   cleanly or exit non-zero, verify invalid cases truly error and are not silently ignored.

8. SELF-TEST MIRRORING: DeepSeek agents often write tests that validate their own implementation choices
   instead of the requested contract. Passing self-authored tests is NOT sufficient evidence. Prefer
   spec-driven golden cases, exact-output checks, and invalid-input checks over trusting the agent's own tests.

═══ CRITICAL: JSON OUTPUT FORMAT ═══
You MUST respond with ONLY a single raw JSON object — no text before it, no text after it,
no markdown code fences, no \`\`\`json\`\`\` wrapping.
Output the JSON object directly. Do not add any explanation, commentary, or formatting around it.
DeepSeek models sometimes add extra text around JSON — do NOT do this. Output ONLY the JSON object.

═══ WHEN THE AGENT IS IDLE (finished its turn, waiting for user input) ═══
This is your most important moment. The agent has stopped and is waiting.
You MUST choose "done" or "steer". Never return "continue" when the agent is idle.

- "done"  → ONLY when the outcome is completely AND verifiably achieved.
  This means: every required deliverable, interface, import surface, CLI surface, and output matches the outcome.
  Passing the agent's own tests is not enough. When the outcome specifies externally visible surfaces,
  exact field names, exact text forms, invalid-input behavior, or exact input/output shapes, verify them before saying "done".
- "steer" → everything else: incomplete work, wrong output shapes, missing public exports, permissive invalid handling,
  schema drift, canonicalization drift, or tests that only prove the agent's own assumptions.

If the agent asked a clarifying question or needs a decision:
  FIRST check: is this question necessary to achieve the goal?
  - YES (directly blocks goal progress): answer with a sensible default and tell agent to proceed.
  - NO (out of scope, nice-to-have, unrelated feature): do NOT answer it. Redirect:
    "That's outside the scope of the goal. Focus on: [restate the specific missing piece]."
  DO NOT answer: passwords, credentials, secrets, anything requiring real user knowledge.

Your steer message speaks AS the user. Make it clear, direct, and actionable (1–3 sentences).
Do not ask the agent to verify its own work — tell it EXACTLY what to fix and what to check.

═══ WHEN THE AGENT IS ACTIVELY WORKING (mid-turn) ═══
Only intervene if it is clearly heading in the wrong direction.
Trust the agent to complete what it has started. Avoid interrupting productive work.

═══ STEERING RULES ═══
- Be specific: reference the outcome, missing pieces, or the question being answered.
- Never repeat a steering message that had no effect — escalate or change approach.
- A good steer answers the agent's question OR redirects to the missing piece of the outcome.
- If the agent is taking shortcuts to satisfy the goal without properly achieving it, always steer
  and remind it not to take shortcuts.
- When steering on contract issues, be explicit: name the required interface or output,
  the expected type/shape/behavior, and the exact field names, exact text form, invalid-input behavior,
  or externally visible surface that must match.
- When the task has a package/module public API, tell the agent to verify that the required functions are
  exposed on the public API surface (for example \`from package import required_function\`).
- When the task has a CLI or JSON request format, tell the agent to verify the real CLI entrypoint and the
  real JSON-facing input shape, not just an internal helper or convenience wrapper.
- When the task is parser-heavy, require at least one exact golden output case and one malformed-input case
  per major public function/operation before saying "done".
"done" CRITERIA (strict for DeepSeek): The outcome is NOT done until:
  1. All required deliverables are complete and any promised external surfaces are actually reachable
     through the interface the outcome specifies.
  2. All required public functions/exports/imports are exposed on the public API surface when the task
     promises them.
  3. Any specified types, shapes, field names, enum values, timestamps, files, error behavior, or other
     externally visible details match exactly — no extra wrapping, no extra fields, no missing fields,
     no renamed fields, no case drift, no canonicalization drift.
  4. Invalid inputs that are supposed to fail do fail cleanly, rather than being silently ignored or
     converted into empty/partial success results.
  5. Any relevant tests, checks, or validation steps required by the outcome pass, but passing self-authored
     tests alone does NOT prove the contract is satisfied.
  6. If the task exposes a CLI, package import surface, or JSON contract, those exact entry points have been
     verified rather than only internal functions.
  "Substantially achieved" does NOT mean "internal implementation exists but the promised surface is broken".
  If the agent says tests pass but the required interface, import surface, output shape, canonical text, or
  invalid-input behavior is wrong, that is NOT done.

Respond ONLY with the raw JSON object — no prose, no markdown fences, no commentary, no \`\`\`json\`\`\` wrapper.
Direct JSON output only.
Response schema:
{
  "action": "continue" | "steer" | "done",
  "message": "...",     // Required when action === "steer"
  "reasoning": "...",   // Brief internal reasoning
  "confidence": 0.85    // Float 0-1
}`,
};

/**
 * Find a matching built-in model prompt by modelId prefix.
 * Uses case-insensitive prefix matching (e.g. "deepseek-v4-flash" matches "deepseek").
 * Longer/more-specific prefix keys take priority.
 * Returns null if no model-specific prompt matches.
 */
export function findBuiltinModelPrompt(modelId: string): string | null {
  const lower = modelId.toLowerCase();
  // Sort keys by length descending so more specific matches win
  const sortedKeys = Object.keys(BUILTIN_MODEL_PROMPT_PREFIXES).sort((a, b) => b.length - a.length);
  for (const key of sortedKeys) {
    if (lower.startsWith(key)) {
      return BUILTIN_MODEL_PROMPT_PREFIXES[key];
    }
  }
  return null;
}

export function loadBuiltinSystemPrompt(modelId?: string): { prompt: string; source: string } {
  if (modelId) {
    const builtinPrompt = findBuiltinModelPrompt(modelId);
    if (builtinPrompt) {
      const prefix = findMatchingPrefixKey(modelId)!;
      return { prompt: builtinPrompt, source: `built-in:${prefix}` };
    }
  }

  return { prompt: BUILTIN_SYSTEM_PROMPT, source: "built-in" };
}

/**
 * Find which prefix key matched a modelId (for source reporting).
 * Returns the matched key or null.
 */
function findMatchingPrefixKey(modelId: string): string | null {
  const lower = modelId.toLowerCase();
  const sortedKeys = Object.keys(BUILTIN_MODEL_PROMPT_PREFIXES).sort((a, b) => b.length - a.length);
  for (const key of sortedKeys) {
    if (lower.startsWith(key)) {
      return key;
    }
  }
  return null;
}

/**
 * Load the supervisor system prompt.
 *
 * Discovery order (model-specific files take priority over generic at each level):
 *   1. <cwd>/.pi/<modelId>-SUPERVISOR.md   — project-local, model-specific
 *   2. <cwd>/.pi/SUPERVISOR.md             — project-local, model-agnostic
 *   3. ~/.pi/agent/<modelId>-SUPERVISOR.md  — global, model-specific
 *   4. ~/.pi/agent/SUPERVISOR.md            — global, model-agnostic
 *   5. Built-in model-specific prompt        — hardcoded per model prefix
 *   6. Built-in default template            — fallback
 *
 * Returns both the prompt and its source (file path, "built-in:<prefix>", or "built-in").
 */
export function loadSystemPrompt(cwd: string, modelId?: string): { prompt: string; source: string } {
  if (modelId) {
    const modelSpecificMd = `${modelId}-${SUPERVISOR_MD}`;

    // 1. Project-local model-specific
    const projectModelPath = join(cwd, CONFIG_DIR, modelSpecificMd);
    if (existsSync(projectModelPath)) {
      return { prompt: readFileSync(projectModelPath, "utf-8").trim(), source: projectModelPath };
    }
  }

  // 2. Project-local generic
  const projectPath = join(cwd, CONFIG_DIR, SUPERVISOR_MD);
  if (existsSync(projectPath)) {
    return { prompt: readFileSync(projectPath, "utf-8").trim(), source: projectPath };
  }

  if (modelId) {
    const modelSpecificMd = `${modelId}-${SUPERVISOR_MD}`;

    // 3. Global model-specific
    const globalModelPath = join(GLOBAL_AGENT_DIR, modelSpecificMd);
    if (existsSync(globalModelPath)) {
      return { prompt: readFileSync(globalModelPath, "utf-8").trim(), source: globalModelPath };
    }
  }

  // 4. Global generic
  const globalPath = join(GLOBAL_AGENT_DIR, SUPERVISOR_MD);
  if (existsSync(globalPath)) {
    return { prompt: readFileSync(globalPath, "utf-8").trim(), source: globalPath };
  }

  // 5. Built-in model-specific prompt
  if (modelId) {
    const builtinPrompt = findBuiltinModelPrompt(modelId);
    if (builtinPrompt) {
      const prefix = findMatchingPrefixKey(modelId)!;
      return { prompt: builtinPrompt, source: `built-in:${prefix}` };
    }
  }

  // 6. Built-in default
  return { prompt: BUILTIN_SYSTEM_PROMPT, source: "built-in" };
}

/**
 * Extract the most recent compaction or branch summary from the session branch.
 * Returns null when none exist. Exported for unit tests.
 */
export function extractCompactionSummary(ctx: ExtensionContext): string | null {
  let summary: string | null = null;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (
      (entry.type === "compaction" || entry.type === "branch_summary") &&
      typeof (entry as any).summary === "string"
    ) {
      summary = (entry as any).summary; // keep overwriting — last one wins (most recent)
    }
  }
  return summary;
}

/**
 * Extract the most recent user/assistant messages from the session branch,
 * capped at `limit`. Returns the LAST `limit` entries (chronological order
 * preserved), so the supervisor sees freshest-first context. Exported for
 * unit tests.
 */
export function buildSnapshot(ctx: ExtensionContext, limit: number): ConversationMessage[] {
  const messages: ConversationMessage[] = [];

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const msg = (entry as any).message;
    if (!msg) continue;

    if (msg.role === "user") {
      const content = extractText(msg.content);
      if (content) messages.push({ role: "user", content });
    } else if (msg.role === "assistant") {
      const content = extractAssistantText(msg.content);
      if (content) messages.push({ role: "assistant", content });
    }
  }

  // Return the most recent N messages
  return messages.slice(-limit);
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text as string)
      .join("\n")
      .trim();
  }
  return "";
}

function extractAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const textParts = content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text as string);
  return textParts.join("\n").trim();
}

/** Build the user-facing prompt for the supervisor LLM. */
function buildUserPrompt(
  state: SupervisorState,
  config: SensitivityConfig,
  snapshot: ConversationMessage[],
  agentIsIdle: boolean,
  stagnating: boolean,
  compactionSummary: string | null,
  evidenceLines: string[],
  evidenceWarnings: string[],
): string {
  const interventionHistory =
    state.interventions.length === 0
      ? "None yet."
      : state.interventions
          .slice(-5)
          .map((iv, i) => `[${i + 1}] Turn ${iv.turnCount}: "${iv.message}"`)
          .join("\n");

  const conversationText =
    snapshot.length === 0
      ? "(No conversation yet)"
      : snapshot
          .map((m) => `${m.role === "user" ? "USER" : "ASSISTANT"}: ${m.content}`)
          .join("\n\n---\n\n");

  const agentStatus = agentIsIdle
    ? `AGENT STATUS: IDLE — the agent has finished its turn and is now waiting for user input.
You MUST return "done" or "steer". Returning "continue" here means the agent stays idle forever.`
    : `AGENT STATUS: WORKING — the agent is actively processing. Only intervene if clearly off track.`;

  const stagnationWarning = stagnating
    ? `\n⚠ STAGNATION: The supervisor has sent ${state.interventions.length} steering messages with no "done" verdict.
The agent is making diminishing improvements. Apply a lenient standard:
- If the core goal is substantially achieved (≥80%), return "done".
- Only return "steer" if a CRITICAL piece is still missing — not minor polish.
- Prefer stopping over looping forever on perfection.`
    : "";

  const summarySection = compactionSummary
    ? `CONVERSATION SUMMARY (earlier history, before recent messages):\n${compactionSummary}\n\n`
    : "";

  const evidenceSection = evidenceLines.length === 0
    ? "RECENT TOOL EVIDENCE:\n(None captured recently)"
    : `RECENT TOOL EVIDENCE:\n${evidenceLines.map((line) => `- ${line}`).join("\n")}`;

  const evidenceWarningsSection = evidenceWarnings.length === 0
    ? ""
    : `\nCLAIM / EVIDENCE WARNINGS:\n${evidenceWarnings.map((warning) => `- ${warning}`).join("\n")}`;

  const midRunDesc = config.checkInterval === 0
    ? "never check mid-run (only at end of each run)"
    : config.checkInterval === 1
      ? "check every tool cycle mid-run"
      : `check every ${config.checkInterval}rd tool cycle mid-run`;

  const sensitivityDesc = state.sensitivity === "custom"
    ? `custom (mid-run: ${midRunDesc}, confidence ≥ ${config.confidenceThreshold}, window: ${config.messageLimit} messages)`
    : state.sensitivity;

  return `DESIRED OUTCOME:
${state.outcome}

SENSITIVITY: ${sensitivityDesc}
(low = check only at end of each run, steer if seriously off track; medium = also check every 3rd tool cycle mid-run, steer on clear drift; high = check every tool cycle, steer proactively)

${agentStatus}${stagnationWarning}

${summarySection}RECENT CONVERSATION (last ${snapshot.length} messages):
${conversationText}

${evidenceSection}${evidenceWarningsSection}

PREVIOUS INTERVENTIONS BY YOU:
${interventionHistory}

REMINDER — DESIRED OUTCOME:
${state.outcome}

Has this outcome been fully achieved? Analyze and respond with JSON only.`;
}

/**
 * Analyze the current conversation and return a steering decision.
 * Falls back to { action: "steer" } when the agent is idle to prevent it from staying stuck.
 */
export async function analyze(
  ctx: ExtensionContext,
  state: SupervisorState,
  agentIsIdle: boolean,
  stagnating: boolean,
  signal?: AbortSignal,
  onDelta?: (accumulated: string) => void,
  evidence: SupervisorEvidenceItem[] = [],
  debug?: SupervisorPayloadDebugOptions,
): Promise<SteeringDecision> {
  const { prompt: systemPrompt } = loadSystemPrompt(ctx.cwd, state.modelId);

  const config = resolveSensitivityConfig(state.sensitivity, state.sensitivityConfig);
  const limit = config.messageLimit;
  const snapshot = buildSnapshot(ctx, limit);
  const compactionSummary = extractCompactionSummary(ctx);
  const evidenceSummary = summarizeEvidenceForPrompt(state.outcome, snapshot, evidence, agentIsIdle);
  const userPrompt = buildUserPrompt(
    state,
    config,
    snapshot,
    agentIsIdle,
    stagnating,
    compactionSummary,
    evidenceSummary.lines,
    evidenceSummary.warnings,
  );

  try {
    return await callSupervisorModel(ctx, state.provider, state.modelId, systemPrompt, userPrompt, signal, onDelta, debug);
  } catch {
    // When idle and analysis fails, nudge rather than silently do nothing
    return agentIsIdle
      ? { action: "steer", message: "Please continue working toward the goal.", reasoning: "Analysis error", confidence: 0 }
      : { action: "continue", reasoning: "Analysis error", confidence: 0 };
  }
}