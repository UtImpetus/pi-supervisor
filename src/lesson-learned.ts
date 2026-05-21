import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildSessionContext, convertToLlm, type ExtensionContext, serializeConversation } from "@mariozechner/pi-coding-agent";
import { buildEvidenceItem } from "./evidence.js";
import { callModel } from "./model-client.js";

const PROJECT_SUPERVISOR_PATH = [".pi", "SUPERVISOR.md"] as const;
const MAX_SESSION_TEXT_CHARS = 80_000;
const MAX_INTERVENTIONS = 8;
const MAX_EVIDENCE_NOTES = 4;
const MAX_TOOL_EVIDENCE = 8;
const MAX_CANDIDATES = 10;
const MARKDOWN_FENCE_RE = /^```(?:markdown|md)?\s*([\s\S]*?)\s*```$/i;
const JSON_FENCE_RE = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;

type SupervisorStateData = {
  interventions?: Array<{ turnCount: number; message: string; reasoning: string; timestamp: number }>;
  outcome?: string;
  active?: boolean;
};

type BranchEntry = {
  type?: string;
  customType?: string;
  content?: unknown;
  details?: {
    warnings?: string[];
    evidence?: string[];
    agentIsIdle?: boolean;
  };
  data?: SupervisorStateData;
  timestamp?: string | number;
  message?: {
    role?: string;
    content?: unknown;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    timestamp?: string | number;
  };
};

export interface LessonIntervention {
  turnCount: number;
  message: string;
  reasoning: string;
  timestamp: number;
}

export interface LessonEvidenceNote {
  warnings: string[];
  evidence: string[];
  content?: string;
}

export interface LessonToolEvidence {
  kind: "verification" | "error" | "test" | "cli" | "import" | "other";
  summary: string;
}

export interface LessonEvidenceBundle {
  outcome: string | null;
  supervisorNotes: string;
  sessionTranscript: string;
  interventions: LessonIntervention[];
  evidenceNotes: LessonEvidenceNote[];
  keyToolEvidence: LessonToolEvidence[];
  inferredPatterns: string[];
}

export interface LessonCandidate {
  kind: "positive" | "anti";
  scope: "project-specific" | "model-specific" | "generic";
  title: string;
  lesson: string;
  rationale: string;
  evidence: string[];
  promptDelta: string;
  confidence: "high" | "medium" | "low";
  riskOfOverfitting: "high" | "medium" | "low";
}

export interface LessonCritiqueRevision {
  title: string;
  reason: string;
  revisedLesson?: string;
  revisedPromptDelta?: string;
  revisedRationale?: string;
}

export interface LessonCritiqueDrop {
  title: string;
  reason: string;
}

export interface LessonCritique {
  keep: string[];
  revise: LessonCritiqueRevision[];
  drop: LessonCritiqueDrop[];
  notes: string[];
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text as string)
    .join("\n")
    .trim();
}

function normalizeComparableText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function coerceStringArray(value: unknown, maxItems = 6): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeLessonText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function extractLatestSupervisorState(branch: BranchEntry[]): SupervisorStateData | null {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type === "custom" && entry.customType === "supervisor-state" && entry.data) {
      return entry.data;
    }
  }
  return null;
}

export function getProjectSupervisorPromptPath(cwd: string): string {
  return join(cwd, ...PROJECT_SUPERVISOR_PATH);
}

export function loadExistingProjectSupervisorPrompt(cwd: string): string | null {
  const path = getProjectSupervisorPromptPath(cwd);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}

export function persistProjectSupervisorPrompt(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content.endsWith("\n") ? content : `${content}\n`, "utf-8");
}

export function extractSupervisorInterventions(branch: BranchEntry[], maxItems = MAX_INTERVENTIONS): LessonIntervention[] {
  const state = extractLatestSupervisorState(branch);
  const interventions = Array.isArray(state?.interventions) ? state.interventions : [];
  return interventions.slice(-maxItems).map((iv) => ({
    turnCount: iv.turnCount,
    message: iv.message,
    reasoning: iv.reasoning,
    timestamp: iv.timestamp,
  }));
}

export function extractEvidenceNotes(branch: BranchEntry[], maxItems = MAX_EVIDENCE_NOTES): LessonEvidenceNote[] {
  const notes: LessonEvidenceNote[] = [];

  for (let i = branch.length - 1; i >= 0 && notes.length < maxItems; i--) {
    const entry = branch[i];
    if (entry?.type !== "custom_message" || entry.customType !== "supervisor-evidence-note") continue;

    const warnings = coerceStringArray(entry.details?.warnings);
    const evidence = coerceStringArray(entry.details?.evidence, 8);
    const content = typeof entry.content === "string" ? entry.content.trim() : undefined;

    if (warnings.length === 0 && evidence.length === 0 && !content) continue;
    notes.push({ warnings, evidence, content });
  }

  return notes.reverse();
}

type ToolCallDescriptor = {
  id: string;
  toolName: string;
  input?: Record<string, unknown>;
};

function extractToolCallDescriptors(branch: BranchEntry[]): Map<string, ToolCallDescriptor> {
  const descriptors = new Map<string, ToolCallDescriptor>();

  for (const entry of branch) {
    const message = entry?.message;
    if (entry?.type !== "message" || message?.role !== "assistant" || !Array.isArray(message.content)) continue;

    for (const block of message.content as any[]) {
      if (!block || typeof block !== "object") continue;

      if (block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
        descriptors.set(block.id, {
          id: block.id,
          toolName: block.name,
          input: block.arguments && typeof block.arguments === "object" ? block.arguments : undefined,
        });
      }

      if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        descriptors.set(block.id, {
          id: block.id,
          toolName: block.name,
          input: block.input && typeof block.input === "object" ? block.input : undefined,
        });
      }
    }
  }

  return descriptors;
}

function mapToolEvidenceKind(summary: string): LessonToolEvidence["kind"] {
  const lower = squash(summary).toLowerCase();

  if (
    /(^|[\s`])(pytest|vitest|jest|ava|mocha|tap|cargo test|go test|npm test|pnpm test|yarn test|bun test|deno test|mix test|rspec|unittest|tox|nose2|ctest|make test|make check|just test|just check)([\s`]|$)|\brun[-_ ]?tests?\b|\btest(?:s)?\.(py|sh|js|jsx|ts|tsx)\b/.test(lower)
  ) {
    return "test";
  }

  if (/\bimport\b|\brequire\b|\bexports?\b|public api/.test(lower)) return "import";

  if (/invalid|malformed|unknown|unexpected|non-zero|exit\s*[:=]\s*[1-9]\d*|must fail|error/.test(lower) || lower.startsWith("err ")) {
    return "error";
  }

  if (
    /python\s+-m\s+|node\s+|deno\s+run\s+|cargo\s+run\b|go\s+run\b|npm\s+run\b|pnpm\s+run\b|yarn\s+|bun\s+run\b|uv\s+run\b|poetry\s+run\b|pipx\s+run\b|java\s+-jar\b|dotnet\s+run\b|php\s+\S|ruby\s+\S|perl\s+\S|bash\s+`\.?\/\S+|sh\s+\S|zsh\s+\S|fish\s+\S|pwsh\b|powershell\b|cmd\s+\/c\b|npx\b|pnpx\b|docker\s+(run|exec)\b|kubectl\s+exec\b|make\s+(run|start|demo|serve)\b|just\s+(run|start|demo|serve)\b|`\.?\/\S+|\bcli\b|\bentrypoint\b|\bentry point\b/.test(lower)
  ) {
    return "cli";
  }

  if (/verify|verification|line counts?|line-count|wc -l|check\b|inspect\b|assert\b/.test(lower)) return "verification";

  return "other";
}

export function extractKeyToolEvidence(branch: BranchEntry[], maxItems = MAX_TOOL_EVIDENCE): LessonToolEvidence[] {
  const descriptors = extractToolCallDescriptors(branch);
  const collected: LessonToolEvidence[] = [];
  const seen = new Set<string>();

  for (let i = branch.length - 1; i >= 0 && collected.length < maxItems; i--) {
    const entry = branch[i];
    const message = entry?.message;
    if (entry?.type !== "message" || message?.role !== "toolResult") continue;

    const descriptor = typeof message.toolCallId === "string" ? descriptors.get(message.toolCallId) : undefined;
    const toolName = typeof message.toolName === "string" ? message.toolName : descriptor?.toolName ?? "unknown";
    const item = buildEvidenceItem(
      toolName,
      descriptor?.input,
      message.content,
      Boolean(message.isError),
    );

    const summary = item?.summary ?? `${message.isError ? "ERR" : "OK"} ${toolName} ${truncate(squash(extractText(message.content)), 140)}`.trim();
    if (!summary || seen.has(summary)) continue;
    seen.add(summary);
    collected.push({ kind: mapToolEvidenceKind(summary), summary });
  }

  return collected.reverse();
}

export function extractSupervisorSessionNotes(branch: BranchEntry[]): string {
  const state = extractLatestSupervisorState(branch);
  if (!state) {
    return "No explicit supervisor-state entries were recorded on this branch. Infer lessons from the full session behavior only.";
  }

  const interventions = Array.isArray(state.interventions) ? state.interventions : [];
  const interventionText = interventions.length === 0
    ? "None recorded in this session."
    : interventions
        .slice(-MAX_INTERVENTIONS)
        .map((iv, index) => `${index + 1}. Turn ${iv.turnCount}: ${iv.message}${iv.reasoning ? ` (reasoning: ${iv.reasoning})` : ""}`)
        .join("\n");

  return `Last supervised outcome: ${state.outcome ?? "(unknown)"}\nSupervisor active at snapshot: ${state.active === true ? "yes" : "no"}\nRecent supervisor interventions:\n${interventionText}`;
}

export function buildSessionTranscript(ctx: Pick<ExtensionContext, "sessionManager">): string {
  const entries = ctx.sessionManager.getEntries() as any[];
  const leafId = ctx.sessionManager.getLeafId();
  const context = buildSessionContext(entries, leafId);
  const transcript = serializeConversation(convertToLlm(context.messages));
  return truncate(transcript, MAX_SESSION_TEXT_CHARS);
}

export function inferLessonPatterns(bundle: Pick<LessonEvidenceBundle, "interventions" | "evidenceNotes" | "keyToolEvidence">): string[] {
  const joined = normalizeComparableText([
    ...bundle.interventions.map((item) => `${item.message} ${item.reasoning}`),
    ...bundle.evidenceNotes.flatMap((note) => [...note.warnings, ...note.evidence, note.content ?? ""]),
    ...bundle.keyToolEvidence.map((item) => item.summary),
  ].join("\n"));

  const patterns: string[] = [];
  const maybeAdd = (condition: boolean, text: string) => {
    if (condition && !patterns.includes(text)) patterns.push(text);
  };

  maybeAdd(
    /\bcli\b|\bentrypoint\b|\bentry point\b|python -m|npm run|pnpm run|yarn |bun run|deno run|cargo run|go run|uv run|poetry run|pipx run|java -jar|dotnet run|docker (run|exec)|kubectl exec|make (run|start|demo|serve)|just (run|start|demo|serve)|bash `?\.\/\S+|sh `?\.\/\S+|zsh `?\.\/\S+|\.\/\S+/.test(joined),
    "Real external execution-surface verification appears high-signal for this project.",
  );
  maybeAdd(/import|public api|package surface|exports?/.test(joined), "Public API / import-surface verification appears important for this project.");
  maybeAdd(/invalid|malformed|unknown op|non-zero|error/.test(joined), "Operation-specific negative-case verification appears important for this project.");
  maybeAdd(/wrapper|top-level|output shape|schema|field placement|field names/.test(joined), "Exact externally visible shapes and field names appear high-signal, but only when supported by explicit evidence.");
  maybeAdd(/representative breadth|breadth|one happy-path|risk classes/.test(joined), "Breadth-only verification was not enough; representative deeper checks mattered.");

  return patterns;
}

export function buildLessonEvidenceBundle(ctx: Pick<ExtensionContext, "sessionManager">): LessonEvidenceBundle {
  const branch = ctx.sessionManager.getBranch() as BranchEntry[];
  const interventions = extractSupervisorInterventions(branch);
  const evidenceNotes = extractEvidenceNotes(branch);
  const keyToolEvidence = extractKeyToolEvidence(branch);
  const state = extractLatestSupervisorState(branch);

  const bundle: LessonEvidenceBundle = {
    outcome: state?.outcome ?? null,
    supervisorNotes: extractSupervisorSessionNotes(branch),
    sessionTranscript: buildSessionTranscript(ctx),
    interventions,
    evidenceNotes,
    keyToolEvidence,
    inferredPatterns: [],
  };

  bundle.inferredPatterns = inferLessonPatterns(bundle);
  return bundle;
}

function stripCodeFence(text: string, pattern: RegExp): string {
  const trimmed = text.trim();
  const match = trimmed.match(pattern);
  return (match?.[1] ?? trimmed).trim();
}

function extractJsonPayload(text: string): string {
  const unfenced = stripCodeFence(text, JSON_FENCE_RE);
  const direct = unfenced.trim();
  if (direct.startsWith("{") || direct.startsWith("[")) return direct;

  const objectMatch = direct.match(/(\{[\s\S]*\})/);
  if (objectMatch?.[1]) return objectMatch[1];

  const arrayMatch = direct.match(/(\[[\s\S]*\])/);
  if (arrayMatch?.[1]) return arrayMatch[1];

  return direct;
}

export function buildLessonCandidateExtractorSystemPrompt(): string {
  return `You are extracting candidate lessons for a project-local SUPERVISOR.md override.
Return ONLY a single raw JSON object with this schema:
{
  "candidates": [
    {
      "kind": "positive" | "anti",
      "scope": "project-specific" | "model-specific" | "generic",
      "title": "short title",
      "lesson": "concise lesson",
      "rationale": "why this matters",
      "evidence": ["short evidence snippet", "..."],
      "promptDelta": "a concise instruction suitable for insertion into SUPERVISOR.md",
      "confidence": "high" | "medium" | "low",
      "riskOfOverfitting": "high" | "medium" | "low"
    }
  ]
}

Rules:
- Extract high-signal lessons only.
- Include both positive lessons (what to do) and anti-lessons (what to avoid learning too aggressively).
- Prefer project-specific lessons. Use model-specific only when the evidence clearly supports it.
- Mark generic lessons as scope="generic" so they can be filtered later.
- Do NOT write markdown or the final SUPERVISOR.md.
- Do NOT restate the base prompt unless the evidence shows a project/model-specific variant.
- Keep evidence snippets short and concrete.
- Cap at ${MAX_CANDIDATES} candidates.`;
}

export function buildLessonCandidateExtractorUserPrompt(options: {
  basePrompt: string;
  existingProjectPrompt: string | null;
  bundle: LessonEvidenceBundle;
}): string {
  const structuredEvidence = JSON.stringify({
    outcome: options.bundle.outcome,
    supervisorNotes: options.bundle.supervisorNotes,
    interventions: options.bundle.interventions,
    evidenceNotes: options.bundle.evidenceNotes,
    keyToolEvidence: options.bundle.keyToolEvidence,
    inferredPatterns: options.bundle.inferredPatterns,
  }, null, 2);

  return `Extract candidate lessons from this session.

GOAL
Identify only the strongest lessons worth learning into a project-local supervisor prompt.

BASE PROMPT
<base-prompt>
${options.basePrompt}
</base-prompt>

EXISTING PROJECT PROMPT
<existing-project-prompt>
${options.existingProjectPrompt ?? "(none)"}
</existing-project-prompt>

STRUCTURED EVIDENCE
<structured-evidence>
${structuredEvidence}
</structured-evidence>

CURRENT BRANCH SESSION TRANSCRIPT
<session>
${options.bundle.sessionTranscript}
</session>`;
}

function normalizeLessonCandidate(raw: unknown): LessonCandidate | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Record<string, unknown>;

  const kind = candidate.kind === "anti" ? "anti" : candidate.kind === "positive" ? "positive" : null;
  const scope = candidate.scope === "project-specific" || candidate.scope === "model-specific" || candidate.scope === "generic"
    ? candidate.scope
    : null;

  const title = normalizeLessonText(candidate.title);
  const lesson = normalizeLessonText(candidate.lesson);
  const promptDelta = normalizeLessonText(candidate.promptDelta) || lesson;

  if (!kind || !scope || !title || !lesson || !promptDelta) return null;

  const confidence = candidate.confidence === "high" || candidate.confidence === "medium" || candidate.confidence === "low"
    ? candidate.confidence
    : "medium";
  const riskOfOverfitting = candidate.riskOfOverfitting === "high" || candidate.riskOfOverfitting === "medium" || candidate.riskOfOverfitting === "low"
    ? candidate.riskOfOverfitting
    : "medium";

  return {
    kind,
    scope,
    title,
    lesson,
    rationale: normalizeLessonText(candidate.rationale),
    evidence: coerceStringArray(candidate.evidence),
    promptDelta,
    confidence,
    riskOfOverfitting,
  };
}

export function normalizeLessonCandidates(input: string | unknown): LessonCandidate[] {
  let raw: unknown = input;

  if (typeof input === "string") {
    try {
      raw = JSON.parse(extractJsonPayload(input));
    } catch {
      return [];
    }
  }

  const maybeCandidates: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as any).candidates)
      ? (raw as any).candidates as unknown[]
      : [];

  return maybeCandidates
    .map((candidate) => normalizeLessonCandidate(candidate))
    .filter((candidate): candidate is LessonCandidate => candidate !== null)
    .slice(0, MAX_CANDIDATES);
}

function isCoveredByBasePrompt(text: string, basePrompt: string): boolean {
  const normalizedText = normalizeComparableText(text);
  if (normalizedText.length < 48) return false;
  return normalizeComparableText(basePrompt).includes(normalizedText);
}

export function filterLessonCandidates(candidates: LessonCandidate[], basePrompt: string): LessonCandidate[] {
  const filtered: LessonCandidate[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (candidate.scope === "generic") continue;
    if (candidate.confidence === "low") continue;
    if (candidate.riskOfOverfitting === "high") continue;
    if (isCoveredByBasePrompt(candidate.promptDelta, basePrompt) || isCoveredByBasePrompt(candidate.lesson, basePrompt)) continue;

    const key = `${candidate.kind}|${normalizeComparableText(candidate.title)}|${normalizeComparableText(candidate.promptDelta)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    filtered.push(candidate);
  }

  return filtered;
}

function normalizeLessonCritiqueRevision(raw: unknown): LessonCritiqueRevision | null {
  if (!raw || typeof raw !== "object") return null;
  const revision = raw as Record<string, unknown>;
  const title = normalizeLessonText(revision.title);
  const reason = normalizeLessonText(revision.reason);
  if (!title || !reason) return null;

  return {
    title,
    reason,
    revisedLesson: normalizeLessonText(revision.revisedLesson) || undefined,
    revisedPromptDelta: normalizeLessonText(revision.revisedPromptDelta) || undefined,
    revisedRationale: normalizeLessonText(revision.revisedRationale) || undefined,
  };
}

function normalizeLessonCritiqueDrop(raw: unknown): LessonCritiqueDrop | null {
  if (!raw || typeof raw !== "object") return null;
  const drop = raw as Record<string, unknown>;
  const title = normalizeLessonText(drop.title);
  const reason = normalizeLessonText(drop.reason);
  if (!title || !reason) return null;
  return { title, reason };
}

export function normalizeLessonCritique(input: string | unknown): LessonCritique {
  let raw: unknown = input;

  if (typeof input === "string") {
    try {
      raw = JSON.parse(extractJsonPayload(input));
    } catch {
      return { keep: [], revise: [], drop: [], notes: [] };
    }
  }

  if (!raw || typeof raw !== "object") {
    return { keep: [], revise: [], drop: [], notes: [] };
  }

  return {
    keep: coerceStringArray((raw as any).keep, MAX_CANDIDATES),
    revise: Array.isArray((raw as any).revise)
      ? (raw as any).revise
          .map((item: unknown) => normalizeLessonCritiqueRevision(item))
          .filter((item: LessonCritiqueRevision | null): item is LessonCritiqueRevision => item !== null)
      : [],
    drop: Array.isArray((raw as any).drop)
      ? (raw as any).drop
          .map((item: unknown) => normalizeLessonCritiqueDrop(item))
          .filter((item: LessonCritiqueDrop | null): item is LessonCritiqueDrop => item !== null)
      : [],
    notes: coerceStringArray((raw as any).notes, 8),
  };
}

export function applyLessonCritique(candidates: LessonCandidate[], critique: LessonCritique): LessonCandidate[] {
  if (candidates.length === 0) return [];

  const byTitle = new Map(candidates.map((candidate) => [normalizeComparableText(candidate.title), candidate]));
  const keepKeys = new Set(critique.keep.map((title) => normalizeComparableText(title)).filter((key) => byTitle.has(key)));
  const shouldRestrictToKeep = keepKeys.size > 0;
  const dropKeys = new Set(critique.drop.map((item) => normalizeComparableText(item.title)));
  const revisions = new Map(critique.revise.map((item) => [normalizeComparableText(item.title), item]));

  return candidates
    .filter((candidate) => {
      const key = normalizeComparableText(candidate.title);
      if (dropKeys.has(key)) return false;
      if (shouldRestrictToKeep && !keepKeys.has(key) && !revisions.has(key)) return false;
      return true;
    })
    .map((candidate) => {
      const revision = revisions.get(normalizeComparableText(candidate.title));
      if (!revision) return candidate;
      return {
        ...candidate,
        lesson: revision.revisedLesson ?? candidate.lesson,
        promptDelta: revision.revisedPromptDelta ?? candidate.promptDelta,
        rationale: revision.revisedRationale ?? candidate.rationale,
      };
    });
}

export function buildLessonCritiqueSystemPrompt(): string {
  return `You are critically reviewing extracted lesson candidates for a project-local SUPERVISOR.md override.
Return ONLY a single raw JSON object with this schema:
{
  "keep": ["candidate title", "..."],
  "revise": [
    {
      "title": "candidate title",
      "reason": "why it needs revision",
      "revisedLesson": "optional revised lesson",
      "revisedPromptDelta": "optional revised prompt delta",
      "revisedRationale": "optional revised rationale"
    }
  ],
  "drop": [
    {
      "title": "candidate title",
      "reason": "why it should be dropped"
    }
  ],
  "notes": ["short critique note", "..."]
}

Rules:
- Prefer keeping concise, high-signal, project-specific lessons.
- Drop lessons that are generic, weakly evidenced, or obviously overfit.
- Revise lessons that are directionally correct but phrased too strongly or too narrowly.
- Watch especially for invented schemas, benchmark-specific overreach, and repetition of the base prompt.
- Do NOT write markdown or the final SUPERVISOR.md.`;
}

export function buildLessonCritiqueUserPrompt(options: {
  basePrompt: string;
  existingProjectPrompt: string | null;
  bundle: LessonEvidenceBundle;
  acceptedCandidates: LessonCandidate[];
}): string {
  return `Critically review these accepted lesson candidates before they are rendered into a project-local supervisor prompt.

GOAL
Keep only lessons that are well-supported, concise, project-relevant, and unlikely to overfit.

BASE PROMPT
<base-prompt>
${options.basePrompt}
</base-prompt>

EXISTING PROJECT PROMPT
<existing-project-prompt>
${options.existingProjectPrompt ?? "(none)"}
</existing-project-prompt>

STRUCTURED SESSION SUMMARY
<structured-evidence>
${JSON.stringify({
  outcome: options.bundle.outcome,
  supervisorNotes: options.bundle.supervisorNotes,
  inferredPatterns: options.bundle.inferredPatterns,
  evidenceNotes: options.bundle.evidenceNotes,
  keyToolEvidence: options.bundle.keyToolEvidence,
}, null, 2)}
</structured-evidence>

ACCEPTED LESSON CANDIDATES
<accepted-lessons>
${JSON.stringify(options.acceptedCandidates, null, 2)}
</accepted-lessons>`;
}

export function buildLessonRendererSystemPrompt(): string {
  return `You are maintaining a project-local SUPERVISOR.md override for a coding-agent supervisor.
Produce the COMPLETE markdown content for <cwd>/.pi/SUPERVISOR.md — no commentary, no code fences.

Your job:
- Start from the provided base supervisor prompt.
- Preserve useful project-specific wording from any existing project-local SUPERVISOR.md.
- Use the accepted lesson candidates as the primary source of learned changes.
- Treat anti-lessons as guardrails about what the supervisor should avoid over-generalizing.
- Avoid reintroducing generic advice already covered by the base prompt.
- Do NOT weaken important safety or completion rules from the base prompt.
- Keep the result concise, practical, and directly usable as a full SUPERVISOR.md override.
- Prefer stable sections such as project-specific failure modes, verification checklist items, steering tactics, and anti-overfitting reminders when that helps clarity.

Output markdown only.`;
}

export function buildLessonRendererUserPrompt(options: {
  basePrompt: string;
  existingProjectPrompt: string | null;
  bundle: LessonEvidenceBundle;
  acceptedCandidates: LessonCandidate[];
}): string {
  return `Generate a project-specific supervisor prompt override from the accepted lessons below.

GOAL
Create a full <cwd>/.pi/SUPERVISOR.md prompt that preserves the base supervisor behavior while adding only useful lessons that are specific to this project/session.

REQUIREMENTS
- Return the COMPLETE SUPERVISOR.md file content.
- Keep it concise.
- Preserve strong existing project-specific wording when still useful.
- Apply positive lessons as specific guidance.
- Apply anti-lessons as guardrails against overfitting or over-steering.
- Do not add generic filler or repeat obvious base-prompt content unnecessarily.

BASE PROMPT
<base-prompt>
${options.basePrompt}
</base-prompt>

EXISTING PROJECT PROMPT
<existing-project-prompt>
${options.existingProjectPrompt ?? "(none)"}
</existing-project-prompt>

STRUCTURED SESSION SUMMARY
<structured-evidence>
${JSON.stringify({
  outcome: options.bundle.outcome,
  supervisorNotes: options.bundle.supervisorNotes,
  inferredPatterns: options.bundle.inferredPatterns,
}, null, 2)}
</structured-evidence>

ACCEPTED LESSON CANDIDATES
<accepted-lessons>
${JSON.stringify(options.acceptedCandidates, null, 2)}
</accepted-lessons>`;
}

export function normalizeLessonProposalText(text: string): string {
  return stripCodeFence(text, MARKDOWN_FENCE_RE);
}

export async function generateSupervisorLessonsProposal(options: {
  ctx: ExtensionContext;
  provider: string;
  modelId: string;
  basePrompt: string;
  existingProjectPrompt: string | null;
  extraInstruction?: string;
  debug?: { enabled: boolean; logPath: string };
}): Promise<string | null> {
  const bundle = buildLessonEvidenceBundle(options.ctx);

  const candidateResponse = await callModel(
    options.ctx,
    options.provider,
    options.modelId,
    buildLessonCandidateExtractorSystemPrompt(),
    `${buildLessonCandidateExtractorUserPrompt({
      basePrompt: options.basePrompt,
      existingProjectPrompt: options.existingProjectPrompt,
      bundle,
    })}${options.extraInstruction?.trim() ? `\n\nADDITIONAL USER INSTRUCTION\n${options.extraInstruction.trim()}` : ""}`,
    undefined,
    undefined,
    options.debug,
  );

  const normalizedCandidates = normalizeLessonCandidates(candidateResponse ?? "");
  const acceptedCandidates = filterLessonCandidates(normalizedCandidates, options.basePrompt);

  let reviewedCandidates = acceptedCandidates;
  if (acceptedCandidates.length > 0) {
    const critiqueResponse = await callModel(
      options.ctx,
      options.provider,
      options.modelId,
      buildLessonCritiqueSystemPrompt(),
      `${buildLessonCritiqueUserPrompt({
        basePrompt: options.basePrompt,
        existingProjectPrompt: options.existingProjectPrompt,
        bundle,
        acceptedCandidates,
      })}${options.extraInstruction?.trim() ? `\n\nADDITIONAL USER INSTRUCTION\n${options.extraInstruction.trim()}` : ""}`,
      undefined,
      undefined,
      options.debug,
    );

    const critique = normalizeLessonCritique(critiqueResponse ?? "");
    const critiqued = applyLessonCritique(acceptedCandidates, critique);
    if (critiqued.length > 0) reviewedCandidates = critiqued;
  }

  return await callModel(
    options.ctx,
    options.provider,
    options.modelId,
    buildLessonRendererSystemPrompt(),
    `${buildLessonRendererUserPrompt({
      basePrompt: options.basePrompt,
      existingProjectPrompt: options.existingProjectPrompt,
      bundle,
      acceptedCandidates: reviewedCandidates,
    })}${options.extraInstruction?.trim() ? `\n\nADDITIONAL USER INSTRUCTION\n${options.extraInstruction.trim()}` : ""}`,
    undefined,
    undefined,
    options.debug,
  );
}
