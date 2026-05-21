import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyLessonCritique,
  buildLessonCritiqueUserPrompt,
  buildLessonRendererUserPrompt,
  extractEvidenceNotes,
  extractKeyToolEvidence,
  extractSupervisorSessionNotes,
  inferLessonPatterns,
  filterLessonCandidates,
  getProjectSupervisorPromptPath,
  type LessonCandidate,
  normalizeLessonCandidates,
  normalizeLessonCritique,
  normalizeLessonProposalText,
  persistProjectSupervisorPrompt,
} from "../src/lesson-learned.js";

describe("lesson-learned helpers", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
  });

  it("builds the standard project-local SUPERVISOR.md path", () => {
    expect(getProjectSupervisorPromptPath("/repo")).toBe("/repo/.pi/SUPERVISOR.md");
  });

  it("normalizes markdown fences away from model output", () => {
    expect(normalizeLessonProposalText("```markdown\nhello\n```\n")).toBe("hello");
    expect(normalizeLessonProposalText("plain text\n")).toBe("plain text");
  });

  it("persists project supervisor prompt and ensures trailing newline", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-supervisor-lessons-"));
    tempDirs.push(dir);
    const path = getProjectSupervisorPromptPath(dir);

    persistProjectSupervisorPrompt(path, "lesson content");

    expect(readFileSync(path, "utf-8")).toBe("lesson content\n");
  });

  it("extracts recent supervisor interventions when present", () => {
    const notes = extractSupervisorSessionNotes([
      {
        type: "custom",
        customType: "supervisor-state",
        data: {
          outcome: "ship the feature",
          active: false,
          interventions: [
            { turnCount: 2, message: "Verify the CLI entrypoint.", reasoning: "missing external check", timestamp: 1 },
          ],
        },
      },
    ] as any);

    expect(notes).toContain("ship the feature");
    expect(notes).toContain("Verify the CLI entrypoint.");
  });

  it("falls back to behavior-only notes when no supervisor-state exists", () => {
    const notes = extractSupervisorSessionNotes([{ type: "message" }] as any);
    expect(notes).toContain("No explicit supervisor-state entries");
  });

  it("extracts visible supervisor evidence notes", () => {
    const notes = extractEvidenceNotes([
      {
        type: "custom_message",
        customType: "supervisor-evidence-note",
        content: "Supervisor evidence: wrapped output still wrong",
        details: {
          warnings: ["Top-level output is wrapped."],
          evidence: ["OK bash `python -m tool` → {\"result\": [1,2]}"],
        },
      },
    ] as any);

    expect(notes).toEqual([
      {
        content: "Supervisor evidence: wrapped output still wrong",
        warnings: ["Top-level output is wrapped."],
        evidence: ["OK bash `python -m tool` → {\"result\": [1,2]}"],
      },
    ]);
  });

  it("extracts key tool evidence using assistant tool call metadata", () => {
    const evidence = extractKeyToolEvidence([
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "python -m pet_polyglot '{\"op\":\"x\"}'" } }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          content: [{ type: "text", text: '{"result":[1,2]}' }],
          isError: false,
        },
      },
    ] as any);

    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.kind).toBe("cli");
    expect(evidence[0]?.summary).toContain("python -m pet_polyglot");
  });

  it("classifies generic script execution evidence as cli", () => {
    const evidence = extractKeyToolEvidence([
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-script", name: "bash", arguments: { command: "./scripts/check-contract.sh --json" } }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call-script",
          toolName: "bash",
          content: [{ type: "text", text: '{"ok":true}' }],
          isError: false,
        },
      },
    ] as any);

    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.kind).toBe("cli");
    expect(evidence[0]?.summary).toContain("./scripts/check-contract.sh");
  });

  it("classifies generic test-runner evidence as test", () => {
    const evidence = extractKeyToolEvidence([
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-test", name: "bash", arguments: { command: "make test" } }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call-test",
          toolName: "bash",
          content: [{ type: "text", text: 'ok' }],
          isError: false,
        },
      },
    ] as any);

    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.kind).toBe("test");
    expect(evidence[0]?.summary).toContain("make test");
  });

  it("infers generic execution-surface verification patterns from script evidence", () => {
    const patterns = inferLessonPatterns({
      interventions: [],
      evidenceNotes: [],
      keyToolEvidence: [{ kind: "cli", summary: "OK bash `./scripts/check-contract.sh --json` → {\"ok\":true}" }],
    });

    expect(patterns).toContain("Real external execution-surface verification appears high-signal for this project.");
  });

  it("infers generic execution-surface verification patterns from make run style evidence", () => {
    const patterns = inferLessonPatterns({
      interventions: [],
      evidenceNotes: [],
      keyToolEvidence: [{ kind: "cli", summary: "OK bash `make run-demo` → ready" }],
    });

    expect(patterns).toContain("Real external execution-surface verification appears high-signal for this project.");
  });

  it("normalizes lesson candidates from fenced JSON", () => {
    const candidates = normalizeLessonCandidates(
      "```json\n" +
        '{"candidates":[{"kind":"anti","scope":"project-specific","title":"Do not invent schemas","lesson":"Do not infer exact response schemas from ambiguous prose.","rationale":"This caused a regression.","evidence":["Supervisor over-inferred simulate_editor shape"],"promptDelta":"Do not invent a precise external schema from ambiguous prose alone.","confidence":"high","riskOfOverfitting":"low"}]}' +
        "\n```",
    );

    expect(candidates).toEqual([
      {
        kind: "anti",
        scope: "project-specific",
        title: "Do not invent schemas",
        lesson: "Do not infer exact response schemas from ambiguous prose.",
        rationale: "This caused a regression.",
        evidence: ["Supervisor over-inferred simulate_editor shape"],
        promptDelta: "Do not invent a precise external schema from ambiguous prose alone.",
        confidence: "high",
        riskOfOverfitting: "low",
      },
    ]);
  });

  it("filters out generic, low-confidence, overfit, duplicate, and base-covered lessons", () => {
    const basePrompt = "Prefer concrete tool evidence over assistant claims. Do not invent a precise external schema from ambiguous prose alone.";
    const candidates: LessonCandidate[] = [
      {
        kind: "positive",
        scope: "generic",
        title: "Generic lesson",
        lesson: "Prefer concrete tool evidence over assistant claims.",
        rationale: "Already in base.",
        evidence: ["x"],
        promptDelta: "Prefer concrete tool evidence over assistant claims.",
        confidence: "high",
        riskOfOverfitting: "low",
      },
      {
        kind: "anti",
        scope: "project-specific",
        title: "Schema invention",
        lesson: "Do not infer exact schemas from ambiguous prose.",
        rationale: "Regression.",
        evidence: ["x"],
        promptDelta: "Do not invent a precise external schema from ambiguous prose alone.",
        confidence: "high",
        riskOfOverfitting: "low",
      },
      {
        kind: "positive",
        scope: "project-specific",
        title: "CLI breadth",
        lesson: "Require deeper CLI verification.",
        rationale: "One happy-path check was insufficient.",
        evidence: ["y"],
        promptDelta: "For broad multi-operation tasks, require deeper verification than one happy-path CLI example per operation.",
        confidence: "high",
        riskOfOverfitting: "low",
      },
      {
        kind: "positive",
        scope: "project-specific",
        title: "CLI breadth",
        lesson: "Require deeper CLI verification.",
        rationale: "Duplicate.",
        evidence: ["z"],
        promptDelta: "For broad multi-operation tasks, require deeper verification than one happy-path CLI example per operation.",
        confidence: "high",
        riskOfOverfitting: "low",
      },
      {
        kind: "positive",
        scope: "project-specific",
        title: "Low confidence",
        lesson: "Maybe maybe.",
        rationale: "weak",
        evidence: [],
        promptDelta: "Maybe maybe.",
        confidence: "low",
        riskOfOverfitting: "low",
      },
      {
        kind: "positive",
        scope: "model-specific",
        title: "Overfit",
        lesson: "Very specific one-off issue.",
        rationale: "weak",
        evidence: [],
        promptDelta: "Very specific one-off issue.",
        confidence: "high",
        riskOfOverfitting: "high",
      },
    ];

    expect(filterLessonCandidates(candidates, basePrompt)).toEqual([
      {
        kind: "positive",
        scope: "project-specific",
        title: "CLI breadth",
        lesson: "Require deeper CLI verification.",
        rationale: "One happy-path check was insufficient.",
        evidence: ["y"],
        promptDelta: "For broad multi-operation tasks, require deeper verification than one happy-path CLI example per operation.",
        confidence: "high",
        riskOfOverfitting: "low",
      },
    ]);
  });

  it("normalizes critique responses from fenced JSON", () => {
    const critique = normalizeLessonCritique(
      "```json\n" +
        '{"keep":["CLI breadth"],"revise":[{"title":"Avoid schema invention","reason":"Too strong","revisedLesson":"Do not infer exact schema from ambiguous prose unless examples/tests make it explicit.","revisedPromptDelta":"Do not invent a precise external schema from ambiguous prose alone; require explicit evidence."}],"drop":[{"title":"Weak generic reminder","reason":"Already covered by base prompt"}],"notes":["Looks broadly good."]}' +
        "\n```",
    );

    expect(critique).toEqual({
      keep: ["CLI breadth"],
      revise: [
        {
          title: "Avoid schema invention",
          reason: "Too strong",
          revisedLesson: "Do not infer exact schema from ambiguous prose unless examples/tests make it explicit.",
          revisedPromptDelta: "Do not invent a precise external schema from ambiguous prose alone; require explicit evidence.",
          revisedRationale: undefined,
        },
      ],
      drop: [{ title: "Weak generic reminder", reason: "Already covered by base prompt" }],
      notes: ["Looks broadly good."],
    });
  });

  it("applies critique keep/revise/drop decisions without dropping everything on bad keep lists", () => {
    const candidates: LessonCandidate[] = [
      {
        kind: "positive",
        scope: "project-specific",
        title: "CLI breadth",
        lesson: "Require deeper CLI verification.",
        rationale: "One happy-path check was insufficient.",
        evidence: ["y"],
        promptDelta: "Require deeper CLI verification.",
        confidence: "high",
        riskOfOverfitting: "low",
      },
      {
        kind: "anti",
        scope: "project-specific",
        title: "Avoid schema invention",
        lesson: "Do not infer exact schema from ambiguous prose.",
        rationale: "Regression.",
        evidence: ["x"],
        promptDelta: "Do not invent a precise external schema from ambiguous prose alone.",
        confidence: "high",
        riskOfOverfitting: "low",
      },
    ];

    const critiqued = applyLessonCritique(candidates, {
      keep: ["CLI breadth"],
      revise: [
        {
          title: "Avoid schema invention",
          reason: "Make it narrower",
          revisedPromptDelta: "Do not invent a precise external schema from ambiguous prose alone; require explicit evidence.",
          revisedLesson: "Do not infer exact schema from ambiguous prose unless examples/tests make it explicit.",
        },
      ],
      drop: [],
      notes: [],
    });

    expect(critiqued).toEqual([
      {
        kind: "positive",
        scope: "project-specific",
        title: "CLI breadth",
        lesson: "Require deeper CLI verification.",
        rationale: "One happy-path check was insufficient.",
        evidence: ["y"],
        promptDelta: "Require deeper CLI verification.",
        confidence: "high",
        riskOfOverfitting: "low",
      },
      {
        kind: "anti",
        scope: "project-specific",
        title: "Avoid schema invention",
        lesson: "Do not infer exact schema from ambiguous prose unless examples/tests make it explicit.",
        rationale: "Regression.",
        evidence: ["x"],
        promptDelta: "Do not invent a precise external schema from ambiguous prose alone; require explicit evidence.",
        confidence: "high",
        riskOfOverfitting: "low",
      },
    ]);

    const unchanged = applyLessonCritique(candidates, {
      keep: ["nonexistent title"],
      revise: [],
      drop: [],
      notes: [],
    });
    expect(unchanged).toEqual(candidates);
  });

  it("builds critique prompts from accepted candidates", () => {
    const prompt = buildLessonCritiqueUserPrompt({
      basePrompt: "BASE",
      existingProjectPrompt: "EXISTING",
      bundle: {
        outcome: "ship it",
        supervisorNotes: "notes",
        sessionTranscript: "transcript that should not appear here",
        interventions: [],
        evidenceNotes: [{ warnings: ["Top-level shape mismatch"], evidence: ["example"], content: "note" }],
        keyToolEvidence: [{ kind: "cli", summary: "OK bash `python -m tool`" }],
        inferredPatterns: ["CLI verification mattered."],
      },
      acceptedCandidates: [
        {
          kind: "anti",
          scope: "project-specific",
          title: "Avoid schema invention",
          lesson: "Do not infer exact schema from ambiguous prose.",
          rationale: "Regression.",
          evidence: ["simulate_editor mismatch"],
          promptDelta: "Do not invent a precise external schema from ambiguous prose alone.",
          confidence: "high",
          riskOfOverfitting: "low",
        },
      ],
    });

    expect(prompt).toContain("ACCEPTED LESSON CANDIDATES");
    expect(prompt).toContain("Avoid schema invention");
    expect(prompt).toContain("Top-level shape mismatch");
    expect(prompt).not.toContain("CURRENT BRANCH SESSION TRANSCRIPT");
  });

  it("builds renderer prompts from accepted candidates rather than raw transcript only", () => {
    const prompt = buildLessonRendererUserPrompt({
      basePrompt: "BASE",
      existingProjectPrompt: "EXISTING",
      bundle: {
        outcome: "ship it",
        supervisorNotes: "notes",
        sessionTranscript: "transcript that should not appear here",
        interventions: [],
        evidenceNotes: [],
        keyToolEvidence: [],
        inferredPatterns: ["CLI verification mattered."],
      },
      acceptedCandidates: [
        {
          kind: "anti",
          scope: "project-specific",
          title: "Avoid schema invention",
          lesson: "Do not infer exact schema from ambiguous prose.",
          rationale: "Regression.",
          evidence: ["simulate_editor mismatch"],
          promptDelta: "Do not invent a precise external schema from ambiguous prose alone.",
          confidence: "high",
          riskOfOverfitting: "low",
        },
      ],
    });

    expect(prompt).toContain("ACCEPTED LESSON CANDIDATES");
    expect(prompt).toContain("Avoid schema invention");
    expect(prompt).toContain("CLI verification mattered.");
    expect(prompt).not.toContain("CURRENT BRANCH SESSION TRANSCRIPT");
  });
});
