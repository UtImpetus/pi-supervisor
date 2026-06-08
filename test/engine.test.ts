import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSnapshot,
  CHECKLIST_BOOTSTRAP_SYSTEM_PROMPT,
  CHECKLIST_REVIEW_SYSTEM_PROMPT,
  extractCompactionSummary,
  findBuiltinModelPrompt,
  formatChecklistForPrompt,
  loadSystemPrompt,
  mergePredefinedChecks,
  reviewChecklistItem,
} from "../src/engine.js";
import { PREDEFINED_CHECKS } from "../src/types.js";

// Build a minimal ExtensionContext that only exposes the bits engine.ts touches.
function makeCtx(branch: any[]): any {
  return { sessionManager: { getBranch: () => branch } };
}

describe("loadSystemPrompt", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-supervisor-engine-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("returns built-in prompt when no files exist and no modelId", () => {
    const { prompt, source } = loadSystemPrompt(cwd);
    expect(prompt).toContain("supervisor monitoring a coding AI assistant");
    expect(source).toBe("built-in");
  });

  it("returns built-in prompt when modelId has no matching files and no built-in match", () => {
    const { prompt, source } = loadSystemPrompt(cwd, "gpt-5-turbo");
    expect(prompt).toContain("supervisor monitoring a coding AI assistant");
    expect(source).toBe("built-in");
  });

  it("prefers .pi/SUPERVISOR.md over global and built-in", () => {
    mkdirSync(join(cwd, ".pi"));
    const projectPrompt = "PROJECT-SPECIFIC SUPERVISOR PROMPT";
    writeFileSync(join(cwd, ".pi", "SUPERVISOR.md"), `${projectPrompt}\n\n`);

    const { prompt, source } = loadSystemPrompt(cwd);
    expect(prompt).toBe(projectPrompt); // trim() applied
    expect(source).toBe(join(cwd, ".pi", "SUPERVISOR.md"));
  });

  it("prefers model-specific .pi/<modelId>-SUPERVISOR.md over generic .pi/SUPERVISOR.md", () => {
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi", "SUPERVISOR.md"), "GENERIC PROMPT");
    writeFileSync(join(cwd, ".pi", "deepseek-v4-flash-SUPERVISOR.md"), "DEEPSEEK-SPECIFIC PROMPT");

    const { prompt, source } = loadSystemPrompt(cwd, "deepseek-v4-flash");
    expect(prompt).toBe("DEEPSEEK-SPECIFIC PROMPT");
    expect(source).toBe(join(cwd, ".pi", "deepseek-v4-flash-SUPERVISOR.md"));
  });

  it("falls back to generic .pi/SUPERVISOR.md when modelId has no model-specific file", () => {
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi", "SUPERVISOR.md"), "GENERIC PROMPT");
    // No deepseek-v4-flash-SUPERVISOR.md exists

    const { prompt, source } = loadSystemPrompt(cwd, "deepseek-v4-flash");
    expect(prompt).toBe("GENERIC PROMPT");
    expect(source).toBe(join(cwd, ".pi", "SUPERVISOR.md"));
  });

  it("prefers project model-specific over global model-specific", () => {
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi", "deepseek-v4-flash-SUPERVISOR.md"), "PROJECT-MODEL-SPECIFIC");

    const { prompt, source } = loadSystemPrompt(cwd, "deepseek-v4-flash");
    expect(prompt).toBe("PROJECT-MODEL-SPECIFIC");
    expect(source).toBe(join(cwd, ".pi", "deepseek-v4-flash-SUPERVISOR.md"));
  });

  it("returns built-in model-specific prompt for deepseek models when no files exist", () => {
    const { prompt, source } = loadSystemPrompt(cwd, "deepseek-v4-flash");
    expect(prompt).toContain("DeepSeek");
    expect(source).toBe("built-in:deepseek");
  });

  it("returns built-in model-specific prompt for deepseek-chat (prefix match)", () => {
    const { prompt, source } = loadSystemPrompt(cwd, "deepseek-chat");
    expect(prompt).toContain("DeepSeek");
    expect(source).toBe("built-in:deepseek");
  });

  it("returns generic built-in for non-matching modelIds", () => {
    const { prompt, source } = loadSystemPrompt(cwd, "claude-haiku-4-5-20251001");
    expect(prompt).toContain("supervisor monitoring a coding AI assistant");
    expect(prompt).not.toContain("DeepSeek");
    expect(prompt).toContain("Prefer concrete tool evidence over assistant claims");
    expect(prompt).toContain("CLAIM / EVIDENCE WARNINGS");
    expect(source).toBe("built-in");
  });

  it("keeps strict contract verification in the DeepSeek-specific built-in prompt only", () => {
    const generic = loadSystemPrompt(cwd, "claude-haiku-4-5-20251001");
    const deepseek = loadSystemPrompt(cwd, "deepseek-v4-flash");

    expect(generic.prompt).not.toContain("SELF-TEST MIRRORING");
    expect(generic.prompt).not.toContain("public API surface");
    expect(generic.prompt).toContain("Prefer concrete tool evidence over assistant claims");
    expect(generic.prompt).toContain("Passing the agent's own tests is helpful but not sufficient");
    expect(deepseek.prompt).toContain("SELF-TEST MIRRORING");
    expect(deepseek.prompt).toContain("INVALID-INPUT LENIENCY");
    expect(deepseek.prompt).toContain("public API surface");
    expect(deepseek.prompt).toContain("real external input shape");
    expect(deepseek.prompt).toContain("tests alone does NOT prove the contract is satisfied");
    expect(deepseek.prompt).toContain("top-level output shape");
    expect(deepseek.prompt).toContain("representative exact-output checks across different risk classes");
    expect(deepseek.source).toBe("built-in:deepseek");
  });

  it("model-specific file takes priority over built-in model prompt", () => {
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi", "deepseek-v4-flash-SUPERVISOR.md"), "MY CUSTOM DEEPSEEK PROMPT");

    const { prompt, source } = loadSystemPrompt(cwd, "deepseek-v4-flash");
    expect(prompt).toBe("MY CUSTOM DEEPSEEK PROMPT");
    expect(source).toBe(join(cwd, ".pi", "deepseek-v4-flash-SUPERVISOR.md"));
  });

  it("generic file takes priority over built-in model prompt", () => {
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi", "SUPERVISOR.md"), "GENERIC CUSTOM PROMPT");

    const { prompt, source } = loadSystemPrompt(cwd, "deepseek-v4-flash");
    expect(prompt).toBe("GENERIC CUSTOM PROMPT");
    expect(source).toBe(join(cwd, ".pi", "SUPERVISOR.md"));
  });

  it("is case-insensitive for modelId in built-in prefix matching", () => {
    const { prompt, source } = loadSystemPrompt(cwd, "DeepSeek-V4-Flash");
    expect(prompt).toContain("DeepSeek");
    expect(source).toBe("built-in:deepseek");
  });

  it("returns generic built-in when modelId is undefined", () => {
    const { prompt, source } = loadSystemPrompt(cwd);
    expect(prompt).toContain("supervisor monitoring a coding AI assistant");
    expect(source).toBe("built-in");
  });
});

describe("formatChecklistForPrompt", () => {
  it("formats a compact completion checklist for the supervisor prompt", () => {
    const section = formatChecklistForPrompt([
      {
        id: "imports",
        title: "Verify public imports",
        description: "Required public functions must be importable from the package surface.",
        verificationPrompt: "Run the import check and fix any missing exports before finishing.",
        status: "pending",
        attempts: 0,
      },
      {
        id: "cli-shape",
        title: "Verify CLI output shape",
        description: "CLI stdout must match the external contract exactly.",
        verificationPrompt: "Run representative CLI calls and compare raw stdout to the required shape.",
        status: "passed",
        attempts: 1,
      },
    ]);

    expect(section).toContain("COMPLETION CHECKLIST");
    expect(section).toContain("Verify public imports");
    expect(section).toContain("[pending]");
    expect(section).toContain("[passed]");
  });
});

describe("mergePredefinedChecks", () => {
  it("returns bootstrap items unchanged when no predefined checks are enabled", () => {
    const bootstrap = [
      { id: "a", title: "A", description: "Desc A", verificationPrompt: "Verify A.", status: "pending" as const, attempts: 0 },
      { id: "b", title: "B", description: "Desc B", verificationPrompt: "Verify B.", status: "pending" as const, attempts: 0 },
    ];
    expect(mergePredefinedChecks(bootstrap, undefined)).toEqual(bootstrap);
    expect(mergePredefinedChecks(bootstrap, undefined)).not.toBe(bootstrap);
    expect(mergePredefinedChecks(bootstrap, [])).toEqual(bootstrap);
    expect(mergePredefinedChecks(bootstrap, [])).not.toBe(bootstrap);
  });

  it("appends a single enabled predefined check", () => {
    const bootstrap = [{ id: "a", title: "A", description: "Desc A", verificationPrompt: "Verify A.", status: "pending" as const, attempts: 0 }];
    const result = mergePredefinedChecks(bootstrap, ["docs-sync"]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(bootstrap[0]);
    expect(result[1]).toMatchObject({
      id: "docs-sync",
      title: "Documentation updated",
      status: "pending",
      attempts: 0,
    });
  });

  it("appends multiple enabled predefined checks in order", () => {
    const bootstrap = [{ id: "a", title: "A", description: "Desc A", verificationPrompt: "Verify A.", status: "pending" as const, attempts: 0 }];
    const result = mergePredefinedChecks(bootstrap, ["docs-sync", "code-smells"]);
    expect(result).toHaveLength(3);
    expect(result[1].id).toBe("docs-sync");
    expect(result[2].id).toBe("code-smells");
  });

  it("ignores unknown predefined check IDs", () => {
    const bootstrap = [{ id: "a", title: "A", description: "Desc A", verificationPrompt: "Verify A.", status: "pending" as const, attempts: 0 }];
    const result = mergePredefinedChecks(bootstrap, ["docs-sync", "unknown-id" as any, "critical-review"]);
    expect(result).toHaveLength(3);
    expect(result.map((i) => i.id)).toEqual(["a", "docs-sync", "critical-review"]);
  });

  it("returns only predefined checks when bootstrap is empty", () => {
    const result = mergePredefinedChecks([], ["docs-sync"]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("docs-sync");
  });
});

describe("checklist prompts", () => {
  it("steers checklist generation toward high-risk semantic checks", () => {
    expect(CHECKLIST_BOOTSTRAP_SYSTEM_PROMPT).toContain("Generate 3 to 20 checklist items");
    expect(CHECKLIST_BOOTSTRAP_SYSTEM_PROMPT).toContain("Choose the highest-risk externally visible contract checks");
    expect(CHECKLIST_BOOTSTRAP_SYSTEM_PROMPT).toContain("Do NOT waste checklist slots on shallow checks");
    expect(CHECKLIST_BOOTSTRAP_SYSTEM_PROMPT).toContain("stateful editors, simulators");
    expect(CHECKLIST_BOOTSTRAP_SYSTEM_PROMPT).toContain("Only demand exact key names/schema when they are explicit");
    expect(CHECKLIST_BOOTSTRAP_SYSTEM_PROMPT).toContain("feeds, posts, replies, timestamps");
    expect(CHECKLIST_BOOTSTRAP_SYSTEM_PROMPT).toContain("ANSI/terminal rendering");
    expect(CHECKLIST_BOOTSTRAP_SYSTEM_PROMPT).toContain("operation-specific invalid behavior");
    expect(CHECKLIST_BOOTSTRAP_SYSTEM_PROMPT).toContain("event keys like `action` versus `type`");
    expect(CHECKLIST_BOOTSTRAP_SYSTEM_PROMPT).toContain("newly added failing test is discovered");
  });

  it("requires exact evidence for checklist review instead of shallow proof", () => {
    expect(CHECKLIST_REVIEW_SYSTEM_PROMPT).toContain("Assistant claims, summary tables, and self-authored tests are not sufficient");
    expect(CHECKLIST_REVIEW_SYSTEM_PROMPT).toContain("Function existence, minimal-argument smoke checks, and rough return-type checks are NOT enough");
    expect(CHECKLIST_REVIEW_SYSTEM_PROMPT).toContain("schema drift");
    expect(CHECKLIST_REVIEW_SYSTEM_PROMPT).toContain("cursor_index vs cursor");
    expect(CHECKLIST_REVIEW_SYSTEM_PROMPT).toContain("user-example `action` fields versus implementation `type` fields");
    expect(CHECKLIST_REVIEW_SYSTEM_PROMPT).toContain("Do NOT invent exact field names from ambiguous prose alone");
    expect(CHECKLIST_REVIEW_SYSTEM_PROMPT).toContain("track cursor index, line, column");
    expect(CHECKLIST_REVIEW_SYSTEM_PROMPT).toContain("ask for raw output verification instead of prescribing invented keys");
    expect(CHECKLIST_REVIEW_SYSTEM_PROMPT).toContain("not only generic malformed JSON / unknown-op checks");
    expect(CHECKLIST_REVIEW_SYSTEM_PROMPT).toContain("raw stdout/stderr, and exit code");
    expect(CHECKLIST_REVIEW_SYSTEM_PROMPT).toContain("syntax/quoting/tool error");
  });

  it("preserves diff review guidance for the critical-review predefined check", () => {
    const criticalReview = PREDEFINED_CHECKS.find((check) => check.id === "critical-review");

    expect(criticalReview?.verificationPrompt).toContain("Re-read the full diff of your changes");
    expect(criticalReview?.verificationPrompt).toContain("CLAIM / EVIDENCE WARNINGS");
  });

  it("deterministically fails critical-review when claim/evidence warnings remain", async () => {
    const review = await reviewChecklistItem(
      makeCtx([]),
      "unused-provider",
      "unused-model",
      "Add a public CLI",
      {
        id: "critical-review",
        title: "Self-critique review",
        description: "Re-examine changes.",
        verificationPrompt: "Review warnings.",
        status: "pending",
        attempts: 0,
      },
      [],
      [],
      ["Recent evidence emphasizes tests, but no real CLI/entrypoint verification is visible."],
    );

    expect(review.status).toBe("needs_work");
    expect(review.confidence).toBe(1);
    expect(review.message).toContain("CLAIM / EVIDENCE WARNINGS");
    expect(review.message).toContain("no real CLI/entrypoint verification");
  });
});

describe("findBuiltinModelPrompt", () => {
  it("matches deepseek prefix (deepseek-v4-flash)", () => {
    const prompt = findBuiltinModelPrompt("deepseek-v4-flash");
    expect(prompt).not.toBeNull();
    expect(prompt).toContain("DeepSeek");
  });

  it("matches deepseek prefix (deepseek-chat)", () => {
    const prompt = findBuiltinModelPrompt("deepseek-chat");
    expect(prompt).not.toBeNull();
    expect(prompt).toContain("DeepSeek");
  });

  it("is case-insensitive", () => {
    const prompt = findBuiltinModelPrompt("DeepSeek-V4");
    expect(prompt).not.toBeNull();
    expect(prompt).toContain("DeepSeek");
  });

  it("returns null for unknown model", () => {
    expect(findBuiltinModelPrompt("gpt-5-turbo")).toBeNull();
    expect(findBuiltinModelPrompt("claude-haiku-4-5-20251001")).toBeNull();
  });
});

describe("buildSnapshot", () => {
  it("ignores non-message entries (custom, compaction, branch_summary)", () => {
    // The supervisor only cares about user/assistant exchanges. Custom
    // extension entries (including its own `supervisor-state` records) and
    // compaction markers must be filtered or the snapshot would leak
    // internal session machinery into the supervisor prompt.
    const branch = [
      { type: "custom", customType: "supervisor-state", data: {} },
      { type: "compaction", summary: "earlier history" },
      { type: "branch_summary", summary: "fork point" },
      { type: "message", message: { role: "user", content: "hello" } },
    ];
    expect(buildSnapshot(makeCtx(branch), 10)).toEqual([
      { role: "user", content: "hello" },
    ]);
  });

  it("extracts text from string-content user messages and from assistant block arrays", () => {
    // pi messages can carry content as either a plain string (legacy/user)
    // or a block-array (assistant, with mixed text/tool_use blocks). Both
    // shapes must produce the same ConversationMessage.content shape.
    const branch = [
      { type: "message", message: { role: "user", content: "string-form" } },
      {
        type: "message",
        message: {
          role: "user",
          content: [
            { type: "text", text: "block-form" },
            { type: "image", source: {} }, // non-text block — must be dropped
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "line A" },
            { type: "tool_use", name: "bash", input: {} }, // non-text — dropped
            { type: "text", text: "line B" },
          ],
        },
      },
    ];

    expect(buildSnapshot(makeCtx(branch), 10)).toEqual([
      { role: "user", content: "string-form" },
      { role: "user", content: "block-form" },
      { role: "assistant", content: "line A\nline B" },
    ]);
  });

  it("drops messages with empty content (so the supervisor never sees blank turns)", () => {
    // An assistant message that is entirely tool_use blocks has no extracted
    // text. Pushing a `{role: "assistant", content: ""}` would waste a slot
    // in the size-limited snapshot.
    const branch = [
      { type: "message", message: { role: "user", content: "real" } },
      { type: "message", message: { role: "assistant", content: [{ type: "tool_use", name: "x" }] } },
      { type: "message", message: { role: "user", content: "" } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "reply" }] } },
    ];
    expect(buildSnapshot(makeCtx(branch), 10)).toEqual([
      { role: "user", content: "real" },
      { role: "assistant", content: "reply" },
    ]);
  });

  it("skips entries whose .message field is missing", () => {
    const branch = [
      { type: "message" }, // no message field
      { type: "message", message: null },
      { type: "message", message: { role: "user", content: "kept" } },
    ];
    expect(buildSnapshot(makeCtx(branch), 10)).toEqual([
      { role: "user", content: "kept" },
    ]);
  });

  it("returns the LAST `limit` messages (recency window), not the first", () => {
    // This is the property that drives sensitivity behavior: low=6,
    // medium=12, high=20. The supervisor must always see the freshest
    // context, never an old prefix.
    const branch = Array.from({ length: 8 }, (_, i) => ({
      type: "message",
      message: { role: i % 2 === 0 ? "user" : "assistant", content: i % 2 === 0 ? `u${i}` : [{ type: "text", text: `a${i}` }] },
    }));

    const out = buildSnapshot(makeCtx(branch), 3);
    expect(out).toHaveLength(3);
    expect(out.map((m) => m.content)).toEqual(["a5", "u6", "a7"]);
  });
});

describe("extractCompactionSummary", () => {
  it("returns null when no compaction or branch_summary entries exist", () => {
    const branch = [
      { type: "message", message: { role: "user", content: "hi" } },
      { type: "custom", customType: "supervisor-state", data: {} },
    ];
    expect(extractCompactionSummary(makeCtx(branch))).toBeNull();
  });

  it("returns the summary from a compaction entry", () => {
    expect(
      extractCompactionSummary(makeCtx([{ type: "compaction", summary: "early history" }])),
    ).toBe("early history");
  });

  it("treats branch_summary the same as compaction (both are session-rewrite markers)", () => {
    expect(
      extractCompactionSummary(makeCtx([{ type: "branch_summary", summary: "fork point" }])),
    ).toBe("fork point");
  });

  it("most recent summary wins when multiple exist (last-write semantics)", () => {
    // The supervisor's prompt must reflect the *current* compacted view of
    // history. If the loop returned the FIRST match instead of the last,
    // a session compacted twice would surface stale context.
    const branch = [
      { type: "compaction", summary: "first" },
      { type: "message", message: { role: "user", content: "x" } },
      { type: "branch_summary", summary: "second" },
      { type: "message", message: { role: "user", content: "y" } },
      { type: "compaction", summary: "third" },
    ];
    expect(extractCompactionSummary(makeCtx(branch))).toBe("third");
  });

  it("ignores compaction entries with non-string summary fields (defensive)", () => {
    // Older sessions may have written a different shape; the type-guard
    // prevents the supervisor prompt from rendering "[object Object]".
    const branch = [
      { type: "compaction", summary: "real summary" },
      { type: "compaction", summary: { nested: "wrong shape" } },
    ];
    expect(extractCompactionSummary(makeCtx(branch))).toBe("real summary");
  });
});