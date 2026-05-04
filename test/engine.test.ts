import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSnapshot, extractCompactionSummary, loadSystemPrompt } from "../src/engine.js";

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

  it("prefers .pi/SUPERVISOR.md in the project over global / built-in", () => {
    mkdirSync(join(cwd, ".pi"));
    const projectPrompt = "PROJECT-SPECIFIC SUPERVISOR PROMPT";
    writeFileSync(join(cwd, ".pi", "SUPERVISOR.md"), `${projectPrompt}\n\n`);

    const { prompt, source } = loadSystemPrompt(cwd);
    expect(prompt).toBe(projectPrompt); // trim() applied
    expect(source).toBe(join(cwd, ".pi", "SUPERVISOR.md"));
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
