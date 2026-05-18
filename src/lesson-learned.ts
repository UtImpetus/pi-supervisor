import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildSessionContext, convertToLlm, type ExtensionContext, serializeConversation } from "@mariozechner/pi-coding-agent";
import { callModel } from "./model-client.js";

const PROJECT_SUPERVISOR_PATH = [".pi", "SUPERVISOR.md"] as const;
const MAX_SESSION_TEXT_CHARS = 80_000;
const MARKDOWN_FENCE_RE = /^```(?:markdown|md)?\s*([\s\S]*?)\s*```$/i;

type BranchEntry = {
  type?: string;
  customType?: string;
  data?: {
    interventions?: Array<{ turnCount: number; message: string; reasoning: string; timestamp: number }>;
    outcome?: string;
    active?: boolean;
  };
};

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
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

export function extractSupervisorSessionNotes(branch: BranchEntry[]): string {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type !== "custom" || entry.customType !== "supervisor-state") continue;
    const data = entry.data;
    if (!data) continue;

    const interventions = Array.isArray(data.interventions) ? data.interventions : [];
    const interventionText = interventions.length === 0
      ? "None recorded in this session."
      : interventions
          .slice(-8)
          .map((iv, index) => `${index + 1}. Turn ${iv.turnCount}: ${iv.message}${iv.reasoning ? ` (reasoning: ${iv.reasoning})` : ""}`)
          .join("\n");

    return `Last supervised outcome: ${data.outcome ?? "(unknown)"}\nSupervisor active at snapshot: ${data.active === true ? "yes" : "no"}\nRecent supervisor interventions:\n${interventionText}`;
  }

  return "No explicit supervisor-state entries were recorded on this branch. Infer lessons from the full session behavior only.";
}

export function buildLessonWriterSystemPrompt(): string {
  return `You are maintaining a project-local SUPERVISOR.md override for a coding-agent supervisor.
Produce the COMPLETE markdown content for <cwd>/.pi/SUPERVISOR.md — no commentary, no code fences.

Your job:
- Start from the provided base supervisor prompt.
- If an existing project-local SUPERVISOR.md already exists, preserve useful project-specific wording from it.
- Learn only project-specific supervisor lessons from the provided session.
- Focus on:
  1. project-specific failure modes,
  2. concrete verification checklist items,
  3. steering style/tactics that work for this project.
- Avoid adding generic advice already covered by the base prompt.
- Do NOT weaken important safety or completion rules from the base prompt.
- Keep the result concise, practical, and directly usable as a full SUPERVISOR.md override.

Output markdown only.`;
}

export function buildLessonWriterUserPrompt(options: {
  basePrompt: string;
  existingProjectPrompt: string | null;
  sessionTranscript: string;
  supervisorNotes: string;
}): string {
  return `Generate a project-specific supervisor prompt override from this session.

GOAL
Create a full <cwd>/.pi/SUPERVISOR.md prompt that preserves the base supervisor behavior while adding only useful lessons that are specific to this project/session.

REQUIREMENTS
- Return the COMPLETE SUPERVISOR.md file content.
- Keep it concise.
- Add project-specific failure modes only when supported by the session.
- Add concrete verification checks the supervisor should require before saying done.
- Add steering guidance only when it is genuinely project-specific.
- Do not add generic filler or repeat obvious base-prompt content unnecessarily.

BASE PROMPT
<base-prompt>
${options.basePrompt}
</base-prompt>

EXISTING PROJECT PROMPT
<existing-project-prompt>
${options.existingProjectPrompt ?? "(none)"}
</existing-project-prompt>

SUPERVISOR NOTES
<supervisor-notes>
${options.supervisorNotes}
</supervisor-notes>

CURRENT BRANCH SESSION TRANSCRIPT
<session>
${options.sessionTranscript}
</session>`;
}

export function buildSessionTranscript(ctx: Pick<ExtensionContext, "sessionManager">): string {
  const entries = ctx.sessionManager.getEntries() as any[];
  const leafId = ctx.sessionManager.getLeafId();
  const context = buildSessionContext(entries, leafId);
  const transcript = serializeConversation(convertToLlm(context.messages));
  return truncate(transcript, MAX_SESSION_TEXT_CHARS);
}

export function normalizeLessonProposalText(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(MARKDOWN_FENCE_RE);
  return (match?.[1] ?? trimmed).trim();
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
  const sessionTranscript = buildSessionTranscript(options.ctx);
  const supervisorNotes = extractSupervisorSessionNotes(options.ctx.sessionManager.getBranch() as BranchEntry[]);

  return await callModel(
    options.ctx,
    options.provider,
    options.modelId,
    buildLessonWriterSystemPrompt(),
    `${buildLessonWriterUserPrompt({
      basePrompt: options.basePrompt,
      existingProjectPrompt: options.existingProjectPrompt,
      sessionTranscript,
      supervisorNotes,
    })}${options.extraInstruction?.trim() ? `\n\nADDITIONAL USER INSTRUCTION\n${options.extraInstruction.trim()}` : ""}`,
    undefined,
    undefined,
    options.debug,
  );
}
