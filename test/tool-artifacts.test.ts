import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveArtifactSearchTerms, SessionToolArtifactStore } from "../src/tool-artifacts.js";

const tempDirs: string[] = [];

function makeCtx() {
  const sessionDir = mkdtempSync(join(tmpdir(), "pi-supervisor-artifacts-"));
  tempDirs.push(sessionDir);
  return {
    sessionManager: {
      getSessionDir: () => sessionDir,
      getSessionId: () => "session-123",
    },
  } as any;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("SessionToolArtifactStore", () => {
  it("writes tool output artifacts under the session directory", () => {
    const ctx = makeCtx();
    const store = new SessionToolArtifactStore();

    store.recordToolResult(ctx, {
      toolName: "bash",
      toolCallId: "call-1",
      input: { command: "python -m demo '{\"op\":\"ok\"}'" },
      content: [{ type: "text", text: "{\"ok\":true}\nEXIT=0\n" }],
      isError: false,
      details: undefined,
      type: "tool_result",
    } as any);

    const baseDir = store.getArtifactsBaseDir(ctx)!;
    const indexText = readFileSync(join(baseDir, "index.jsonl"), "utf8");
    expect(indexText).toContain("python -m demo");
    expect(indexText).toContain("call-1");
  });

  it("can search recent artifacts for relevant raw output excerpts", () => {
    const ctx = makeCtx();
    const store = new SessionToolArtifactStore();

    store.recordToolResult(ctx, {
      toolName: "bash",
      toolCallId: "call-2",
      input: { command: "python -m pet_polyglot '{\"op\":\"analyze_project_files\"}'" },
      content: [{ type: "text", text: '{\n  "language_counts": {"python": 1},\n  "warnings": []\n}\n' }],
      isError: false,
      details: undefined,
      type: "tool_result",
    } as any);

    const terms = deriveArtifactSearchTerms("verify language_counts and warnings");
    const excerpts = store.searchExcerpts(ctx, { terms });

    expect(excerpts.length).toBeGreaterThan(0);
    expect(excerpts[0]).toContain("language_counts");
    expect(excerpts[0]).toContain("warnings");
  });

  it("returns recent raw excerpts when no targeted search is provided", () => {
    const ctx = makeCtx();
    const store = new SessionToolArtifactStore();

    store.recordToolResult(ctx, {
      toolName: "bash",
      toolCallId: "call-3",
      input: { command: "python run_tests.py" },
      content: [{ type: "text", text: "TESTS: passed=10 total=10\n" }],
      isError: false,
      details: undefined,
      type: "tool_result",
    } as any);

    const excerpts = store.getRecentExcerpts(ctx, 1);
    expect(excerpts).toHaveLength(1);
    expect(excerpts[0]).toContain("python run_tests.py");
    expect(excerpts[0]).toContain("TESTS: passed=10 total=10");
  });
});
