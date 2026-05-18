import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractSupervisorSessionNotes,
  getProjectSupervisorPromptPath,
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
});
