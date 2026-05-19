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
import { callModel, callSupervisorModel } from "./model-client.js";
import type {
  ChecklistReviewDecision,
  CompletionChecklistItem,
  ConversationMessage,
  SensitivityConfig,
  SteeringDecision,
  SupervisorState,
} from "./types.js";
import { resolveSensitivityConfig } from "./types.js";

// ---- System prompt loading ----

const SUPERVISOR_MD = "SUPERVISOR.md";
const CONFIG_DIR = ".pi";
const GLOBAL_AGENT_DIR = join(homedir(), ".pi", "agent");
const MAX_CHECKLIST_ITEMS = 20;

export const CHECKLIST_BOOTSTRAP_SYSTEM_PROMPT = `You generate a short completion checklist for a coding-task supervisor.
Return ONLY valid JSON with this exact shape:
{
  "items": [
    {
      "id": "short-kebab-id",
      "title": "short title",
      "description": "what must be true before task completion",
      "verificationPrompt": "what the coding agent should re-check and fix before finishing"
    }
  ]
}
Rules:
- Generate 3 to 20 checklist items whenever the outcome has multiple non-trivial requirements. Broad tasks with many distinct risk surfaces should use more items; use fewer only for genuinely tiny tasks.
- Checklist items are required completion checks before the task may be considered done.
- Choose the highest-risk externally visible contract checks, not generic boilerplate. Prefer exact imports/exports, CLI/request format, output shape/schema, operation-specific invalid cases, roundtrip behavior, stateful semantics, and exact summary output.
- Do NOT waste checklist slots on shallow checks like "function exists", "types roughly match", or "tests pass" when the outcome requires deeper semantic verification.
- If the outcome includes stateful editors, simulators, cursor/text state, or event sequences, include a checklist item for exact returned state keys/schema plus representative multi-step transitions and invalid-event behavior.
- If the outcome includes analyzers, summaries, manifests, or structured reports, include a checklist item for exact top-level keys/schema and representative fixture outputs. Watch for alternate schemas like list-vs-dict drift or extra regrouped keys.
- If the outcome includes feeds, posts, replies, timestamps, ordering, or markers, include a checklist item for reply association/order semantics and invalid timestamp or malformed-marker handling.
- If the outcome includes ANSI/terminal rendering or escape-sequence handling, include a checklist item for exact visible output, OSC/DCS skipping, malformed escape handling, and any explicitly required color/readability behavior.
- If the outcome includes parse/render pairs or front matter, include a checklist item for roundtrip integrity using the required scalar/list/null types and another item for malformed/unclosed input behavior when failure semantics are required.
- Include at least one item for operation-specific invalid behavior for the riskiest public operations, not just generic malformed JSON or unknown-op handling.
- Keep each item concrete, evidence-oriented, and runnable as a re-check.
- Do NOT generate implementation-plan steps.
- Do NOT generate generic advice like "review the code".
- No prose outside JSON.`;

export const CHECKLIST_REVIEW_SYSTEM_PROMPT = `You review one completion checklist item for a coding-task supervisor.
Return ONLY valid JSON with this exact shape:
{
  "status": "passed" | "needs_work",
  "message": "short steer message when more verification/fixing is needed",
  "reasoning": "brief explanation",
  "confidence": 0.0
}
Rules:
- Use "passed" only when recent evidence makes this checklist item clearly satisfied.
- Use "needs_work" when evidence is missing, contradictory, incomplete, or only proves a shallow approximation.
- Assistant claims and self-authored tests are not sufficient by themselves. Prefer direct tool evidence from real CLI output, exact JSON payloads, imports, fixture outputs, and explicit invalid-case runs.
- Function existence, minimal-argument smoke checks, and rough return-type checks are NOT enough when the contract requires exact field names, exact keys/schema, state transitions, ordering/reply semantics, roundtrip fidelity, or operation-specific failure behavior.
- If recent evidence suggests suspicious schema drift (for example alternate key names, list-vs-dict regrouping, wrapper payloads, or cursor_index vs cursor style mismatches), use "needs_work" unless the exact required external shape is directly evidenced.
- If the item is about invalid behavior, require direct evidence for the specific risky operation named in the item, not only generic malformed JSON / unknown-op checks.
- The message should tell the coding agent exactly what to verify/fix for this checklist item, including which command/fixture/output to show when possible.
- No prose outside JSON.`;

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
   When recent CLI/stdout evidence shows examples like \`{"result": ...}\`, treat that as a concrete
   contract failure, not a minor formatting issue.

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
   instead of the specified external input shape. Verify return types and accepted input shapes exactly.

7. INVALID-INPUT LENIENCY: DeepSeek agents often accept malformed input by returning an empty result,
   partial parse, or ignored command instead of failing. If the outcome says malformed input must fail
   cleanly or exit non-zero, verify invalid cases truly error and are not silently ignored.

8. SELF-TEST MIRRORING: DeepSeek agents often write tests that validate their own implementation choices
   instead of the requested contract. Passing self-authored tests is NOT sufficient evidence. Prefer
   spec-driven golden cases, exact-output checks, and invalid-input checks over trusting the agent's own tests.

9. PROSE-DEFINED SCHEMA DRIFT: DeepSeek agents often satisfy the rough idea of a returned object/state
   but expose the wrong external structure: wrong top-level vs nested placement, missing fields,
   renamed fields, regrouped keys, or combined fields when the outcome, examples, or visible evidence make the structure explicit.
   Suspicious visible drift includes alternate field names or regrouping such as \`column\` → \`cursor_col\`,
   \`cursor\` + \`line\` + \`column\` → \`cursor_line\`/\`cursor_col\`/\`cursor_index\`, or \`language_counts\` → \`languages\`.
   Watch for schema drift, but do NOT invent an exact external shape from ambiguous prose alone — require direct
   evidence from the task text, examples, tests, or real outputs before steering on a precise structural mismatch.

10. BREADTH-WITHOUT-DEPTH VERIFICATION: DeepSeek agents often prove only that each operation works once.
    One happy-path example per operation, plus generic framing checks (for example invalid JSON or unknown-op),
    is NOT strong enough evidence for broad tasks. Require deeper checks for the riskiest operations before saying "done".

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
  If actual CLI/stdout examples are shown, compare their exact top-level shape to the contract. Compact JSON is NOT sufficient when
  the top-level payload is wrong (for example \`{"result": ...}\` instead of the raw value).
- "steer" → everything else: incomplete work, wrong output shapes, missing public exports, permissive invalid handling,
  contract drift, canonicalization drift, shallow breadth-only verification, or tests that only prove the agent's own assumptions.

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
- When actual CLI/stdout examples are available, inspect the exact top-level output shape. If stdout is wrapped in
  \`{"result": ...}\` / \`{"data": ...}\` / \`{"output": ...}\` but the contract expects a raw list, dict, or string,
  explicitly steer on that wrapper mismatch.
- When the task has a package/module public API, tell the agent to verify that the required functions are
  exposed on the public API surface (for example \`from package import required_function\`).
- When the task has a CLI or structured request format, tell the agent to verify the real CLI entrypoint and the
  real external input shape, not just an internal helper or convenience wrapper.
- When the outcome, examples, or visible evidence make a returned object/state structure explicit, verify the
  external shape/schema literally: field names, required fields, top-level vs nested placement, and whether
  separate concepts are exposed as separate fields. Treat suspicious alternate field names, flattening, or
  regrouping in visible outputs as high-signal drift and require exact contract verification before "done".
  If prose is ambiguous, do NOT invent a precise schema — require direct verification evidence instead of guessing.
- For multi-function or multi-operation tasks, require representative exact-output checks across different risk classes
  (for example parser output, renderer/formatter output, schema summary output, and stateful logic) rather than accepting
  one positive request per operation as sufficient proof.
- Match the verification style to the operation type:
  * Parser / extractor functions: require at least one tricky golden case and one malformed-input case.
  * Render / parse pairs: require a real roundtrip check (for example parse(render(x)) == x) including exact
    body text, blank lines, and canonical text form where relevant.
  * Stateful simulators / editors: require representative multi-step state transitions and highest-risk behaviors,
    including persistence or text-encoding details where relevant, and verify the returned state schema when it is
    explicitly specified or evidenced.
  * Project analyzers / summarizers: require fixtures representative of the declared scope and verify exact summary
    key names plus safety/rejection behavior when the contract implies it.
- When the task is parser-heavy, require at least one exact golden output case and one malformed-input case
  per major public function/operation before saying "done".
- For broad multi-operation tasks, do NOT treat "one happy-path CLI example per operation" plus only generic
  framing checks as sufficient proof. Also require operation-specific invalid cases and deeper semantic checks
  for the highest-risk operations.
"done" CRITERIA (strict for DeepSeek): The outcome is NOT done until:
  1. All required deliverables are complete and any promised external surfaces are actually reachable
     through the interface the outcome specifies.
  2. All required public functions/exports/imports are exposed on the public API surface when the task
     promises them.
  3. Any specified types, shapes, field names, enum values, timestamps, files, error behavior, or other
     externally visible details match exactly — no extra wrapping, no extra fields, no missing fields,
     no renamed fields, no case drift, no canonicalization drift.
  4. If the task exposes a CLI or other real stdout examples, those examples have been checked for exact top-level
     output shape/content — not merely for being valid compact JSON.
  5. Invalid inputs that are supposed to fail do fail cleanly, rather than being silently ignored or
     converted into empty/partial success results.
  6. Any relevant tests, checks, or validation steps required by the outcome pass, but passing self-authored
     tests alone does NOT prove the contract is satisfied.
  7. If the task exposes a CLI, package import surface, or other declared external contract, those exact entry
     points have been verified rather than only internal functions.
  8. For multi-operation tasks, verification covers representative outputs across multiple operations/risk classes,
     not just one successful invocation pattern repeated mechanically.
  9. If the outcome, examples, or visible evidence make a returned state/object structure explicit, the actual
     visible external shape/schema matches it exactly: correct field names, required fields present, correct
     top-level vs nested placement, no silent collapsing of separately described values, and no suspicious
     alternate naming or regrouping that changes the declared contract. If the prose is ambiguous, require direct
     verification evidence instead of inventing a precise schema.
  10. Invalid-case coverage is operation-specific where the outcome implies it — not just generic framing checks,
      missing top-level args, or unknown-op checks.
  11. Stateful, roundtrip, or summarization-heavy operations have been verified with depth appropriate to their
      risk class, not merely with a single toy happy-path example.
  "Substantially achieved" does NOT mean "internal implementation exists but the promised surface is broken".
  If the agent says tests pass but the required interface, import surface, output shape/schema, canonical text,
  or invalid-input behavior is wrong, that is NOT done.

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

function normalizeChecklistItem(value: unknown, index: number): CompletionChecklistItem | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || typeof item.title !== "string" || typeof item.description !== "string" || typeof item.verificationPrompt !== "string") {
    return null;
  }

  return {
    id: item.id.trim() || `check-${index + 1}`,
    title: item.title.trim(),
    description: item.description.trim(),
    verificationPrompt: item.verificationPrompt.trim(),
    status: "pending",
    attempts: 0,
  };
}

function parseChecklistResponse(text: string): CompletionChecklistItem[] {
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ?? text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  const jsonStr = jsonMatch?.[1] ?? text.trim();

  try {
    const parsed = JSON.parse(jsonStr) as { items?: unknown } | unknown[];
    const items = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { items?: unknown })?.items)
        ? (parsed as { items: unknown[] }).items
        : [];

    return items
      .map((item, index) => normalizeChecklistItem(item, index))
      .filter((item): item is CompletionChecklistItem => item !== null)
      .slice(0, MAX_CHECKLIST_ITEMS);
  } catch {
    return [];
  }
}

export function formatChecklistForPrompt(items: CompletionChecklistItem[]): string {
  if (items.length === 0) return "COMPLETION CHECKLIST:\n(None generated)";
  return `COMPLETION CHECKLIST:\n${items.map((item) => `- [${item.status}] ${item.title}: ${item.description}`).join("\n")}`;
}

export async function generateCompletionChecklist(
  ctx: ExtensionContext,
  provider: string,
  modelId: string,
  outcome: string,
  debug?: SupervisorPayloadDebugOptions,
): Promise<CompletionChecklistItem[]> {
  const userPrompt = `Desired outcome:\n${outcome}\n\nGenerate a short checklist of the highest-risk completion checks that must be verified before this task may be considered done. Focus on the few checks most likely to catch semantic contract failures, not generic smoke checks. Return JSON only.`;
  const text = await callModel(ctx, provider, modelId, CHECKLIST_BOOTSTRAP_SYSTEM_PROMPT, userPrompt, undefined, undefined, debug);
  if (text === null) return [];
  return parseChecklistResponse(text);
}

export async function reviewChecklistItem(
  ctx: ExtensionContext,
  provider: string,
  modelId: string,
  outcome: string,
  item: CompletionChecklistItem,
  snapshot: ConversationMessage[],
  evidenceLines: string[],
  evidenceWarnings: string[],
  debug?: SupervisorPayloadDebugOptions,
): Promise<ChecklistReviewDecision> {
  const conversationText = snapshot.length === 0
    ? "(No conversation yet)"
    : snapshot.map((m) => `${m.role === "user" ? "USER" : "ASSISTANT"}: ${m.content}`).join("\n\n---\n\n");
  const evidenceSection = evidenceLines.length === 0
    ? "RECENT TOOL EVIDENCE:\n(None captured recently)"
    : `RECENT TOOL EVIDENCE:\n${evidenceLines.map((line) => `- ${line}`).join("\n")}`;
  const warningsSection = evidenceWarnings.length === 0
    ? ""
    : `\nCLAIM / EVIDENCE WARNINGS:\n${evidenceWarnings.map((warning) => `- ${warning}`).join("\n")}`;
  const userPrompt = `DESIRED OUTCOME:\n${outcome}\n\nCHECKLIST ITEM:\nTitle: ${item.title}\nDescription: ${item.description}\nVerification guidance: ${item.verificationPrompt}\nAttempts so far: ${item.attempts}\n\nRECENT CONVERSATION:\n${conversationText}\n\n${evidenceSection}${warningsSection}\n\nIs this checklist item clearly satisfied? If not, tell the coding agent exactly what to re-check/fix before finishing.`;
  const text = await callModel(ctx, provider, modelId, CHECKLIST_REVIEW_SYSTEM_PROMPT, userPrompt, undefined, undefined, debug);
  if (text === null) {
    return {
      status: "needs_work",
      message: item.verificationPrompt,
      reasoning: "Checklist review model call failed",
      confidence: 0,
    };
  }

  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ?? text.match(/(\{[\s\S]*\})/);
  const jsonStr = jsonMatch?.[1] ?? text.trim();
  try {
    const parsed = JSON.parse(jsonStr) as Partial<ChecklistReviewDecision>;
    if (parsed.status !== "passed" && parsed.status !== "needs_work") throw new Error("invalid status");
    return {
      status: parsed.status,
      message: typeof parsed.message === "string" ? parsed.message.trim() : undefined,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
    };
  } catch {
    return {
      status: "needs_work",
      message: item.verificationPrompt,
      reasoning: "Checklist review parse failure",
      confidence: 0,
    };
  }
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
  checklistItems: CompletionChecklistItem[],
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

  const checklistSection = `\n${formatChecklistForPrompt(checklistItems)}`;

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

${evidenceSection}${evidenceWarningsSection}${checklistSection}

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
    state.completionChecklist?.items ?? [],
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