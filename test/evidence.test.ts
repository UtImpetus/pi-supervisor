import { describe, expect, it } from "vitest";
import {
  buildEvidenceItem,
  buildEvidenceNote,
  collectEvidenceFromBranch,
  createEvidenceSnapshot,
  findLastEvidenceNoteContent,
  loadEvidenceSnapshotFromBranch,
  SupervisorEvidenceTracker,
  summarizeEvidenceForPrompt,
} from "../src/evidence.js";

describe("buildEvidenceItem", () => {
  it("classifies bash test commands and keeps the command in the summary", () => {
    const item = buildEvidenceItem(
      "bash",
      { command: "python run_tests.py" },
      [{ type: "text", text: "TESTS: passed=52 total=52" }],
      false,
    );

    expect(item).not.toBeNull();
    expect(item?.category).toBe("tests");
    expect(item?.summary).toContain("python run_tests.py");
    expect(item?.summary).toContain("TESTS: passed=52 total=52");
  });

  it("classifies python import checks as import-surface verification", () => {
    const item = buildEvidenceItem(
      "bash",
      { command: "python -c \"from pet_polyglot import parse_js_window_assignment\"" },
      [{ type: "text", text: "ok" }],
      false,
    );

    expect(item?.category).toBe("imports");
  });
});

describe("collectEvidenceFromBranch", () => {
  it("reconstructs tool inputs from assistant toolCall blocks", () => {
    const branch = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_1",
              name: "bash",
              arguments: { command: "python -m pet_polyglot '{\"op\":\"simulate_editor\",\"args\":{}}'" },
            },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "bash",
          content: [{ type: "text", text: '{"cursor":0}' }],
          isError: false,
        },
      },
    ];

    const evidence = collectEvidenceFromBranch(branch);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.category).toBe("cli");
    expect(evidence[0]?.summary).toContain("python -m pet_polyglot");
  });
});

describe("evidence snapshots", () => {
  it("ignores persisted snapshots older than the requested supervision start timestamp", () => {
    const branch = [
      {
        type: "custom",
        customType: "supervisor-evidence",
        timestamp: "2026-01-01T00:00:00.000Z",
        data: { items: [{ toolName: "bash", category: "tests", summary: "old", isError: false }] },
      },
      {
        type: "custom",
        customType: "supervisor-evidence",
        timestamp: "2026-01-02T00:00:00.000Z",
        data: { items: [{ toolName: "bash", category: "cli", summary: "new", isError: false }] },
      },
    ];

    expect(loadEvidenceSnapshotFromBranch(branch, 12, Date.parse("2026-01-01T12:00:00.000Z"))).toEqual([
      { toolName: "bash", category: "cli", summary: "new", isError: false },
    ]);
  });

  it("hydrates only evidence at or after the requested supervision start timestamp", () => {
    const tracker = new SupervisorEvidenceTracker();
    const branch = [
      {
        type: "message",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_old", name: "bash", arguments: { command: "python run_tests.py" } }],
        },
      },
      {
        type: "message",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call_old",
          toolName: "bash",
          content: [{ type: "text", text: "TESTS: passed=52 total=52" }],
          isError: false,
        },
      },
      {
        type: "message",
        timestamp: "2026-01-02T00:00:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_new", name: "bash", arguments: { command: "python -m pet_polyglot '{}'" } }],
        },
      },
      {
        type: "message",
        timestamp: "2026-01-02T00:00:01.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call_new",
          toolName: "bash",
          content: [{ type: "text", text: '{"ok":true}' }],
          isError: false,
        },
      },
    ];

    tracker.hydrateFromSession(
      { sessionManager: { getBranch: () => branch } } as any,
      Date.parse("2026-01-01T12:00:00.000Z"),
    );

    expect(tracker.getRecent()).toHaveLength(1);
    expect(tracker.getRecent()[0]?.category).toBe("cli");
  });

  it("loads the latest persisted evidence snapshot from custom entries", () => {
    const branch = [
      { type: "custom", customType: "supervisor-evidence", data: { items: [{ toolName: "bash", category: "tests", summary: "old", isError: false }] } },
      { type: "custom", customType: "supervisor-evidence", data: { items: [{ toolName: "bash", category: "cli", summary: "new", isError: false }] } },
    ];

    expect(loadEvidenceSnapshotFromBranch(branch)).toEqual([
      { toolName: "bash", category: "cli", summary: "new", isError: false },
    ]);
  });

  it("hydrates from persisted snapshot plus branch evidence without duplicating items", () => {
    const tracker = new SupervisorEvidenceTracker();
    const item = buildEvidenceItem(
      "bash",
      { command: "python run_tests.py" },
      [{ type: "text", text: "TESTS: passed=52 total=52" }],
      false,
    )!;
    const branch = [
      { type: "custom", customType: "supervisor-evidence", data: createEvidenceSnapshot([item]) },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "python run_tests.py" } }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "bash",
          content: [{ type: "text", text: "TESTS: passed=52 total=52" }],
          isError: false,
        },
      },
    ];

    tracker.hydrateFromSession({ sessionManager: { getBranch: () => branch } } as any);
    expect(tracker.getRecent()).toEqual([item]);
  });
});

describe("evidence notes", () => {
  it("builds a concise visible note only when warnings exist", () => {
    const outcome = `Required public functions must be exposed from the package.\nPackage mode: python -m pet_polyglot '<json request>' must print compact JSON only.\nUnknown operations, malformed JSON, malformed arguments, or invalid data must exit non-zero.`;
    const snapshot = [{ role: "assistant" as const, content: "All 52 tests pass. All done." }];
    const note = buildEvidenceNote(outcome, snapshot, [
      buildEvidenceItem(
        "bash",
        { command: "python run_tests.py" },
        [{ type: "text", text: "TESTS: passed=52 total=52" }],
        false,
      )!,
    ], true);

    expect(note).not.toBeNull();
    expect(note?.content).toContain("Supervisor evidence:");
    expect(note?.details.warnings.length).toBeGreaterThan(0);
    expect(note?.details.evidence).toHaveLength(1);
  });

  it("returns null when no warnings exist", () => {
    const outcome = `Required public functions must be exposed from the package.\nPackage mode: python -m pet_polyglot '<json request>' must print compact JSON only.\nUnknown operations, malformed JSON, malformed arguments, or invalid data must exit non-zero.`;
    const snapshot = [{ role: "assistant" as const, content: "All tests pass and the CLI works end-to-end." }];
    const note = buildEvidenceNote(outcome, snapshot, [
      buildEvidenceItem("bash", { command: "python run_tests.py" }, [{ type: "text", text: "TESTS: passed=52 total=52" }], false)!,
      buildEvidenceItem("bash", { command: "python -c \"from pet_polyglot import parse_js_window_assignment\"" }, [{ type: "text", text: "ok" }], false)!,
      buildEvidenceItem("bash", { command: "python -m pet_polyglot '{\"op\":\"simulate_editor\",\"args\":{}}'" }, [{ type: "text", text: '{"cursor":0}' }], false)!,
      buildEvidenceItem("bash", { command: "python -m pet_polyglot 'not json' ; echo EXIT: 1" }, [{ type: "text", text: "Error: Invalid JSON\nEXIT: 1" }], false)!,
    ], true);

    expect(note).toBeNull();
  });

  it("finds the latest visible evidence note content in the branch", () => {
    const branch = [
      { type: "custom_message", customType: "supervisor-evidence-note", content: "old note" },
      { type: "custom_message", customType: "supervisor-evidence-note", content: "new note" },
    ];

    expect(findLastEvidenceNoteContent(branch)).toBe("new note");
  });
});

describe("summarizeEvidenceForPrompt", () => {
  it("warns when the outcome requires imports and invalid cases but evidence only shows tests", () => {
    const outcome = `Required public functions must be exposed from the package.\nPackage mode: python -m pet_polyglot '<json request>' must print compact JSON only.\nUnknown operations, malformed JSON, malformed arguments, or invalid data must exit non-zero.`;
    const snapshot = [
      { role: "assistant" as const, content: "All 52 tests pass. All done." },
    ];
    const evidence = [
      buildEvidenceItem(
        "bash",
        { command: "python run_tests.py" },
        [{ type: "text", text: "TESTS: passed=52 total=52" }],
        false,
      )!,
    ];

    const summary = summarizeEvidenceForPrompt(outcome, snapshot, evidence, true);

    expect(summary.lines).toHaveLength(1);
    expect(summary.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("CLI/entrypoint"),
        expect.stringContaining("import/export"),
        expect.stringContaining("negative-case"),
      ]),
    );
  });

  it("avoids warnings once matching evidence exists", () => {
    const outcome = `Required public functions must be exposed from the package.\nPackage mode: python -m pet_polyglot '<json request>' must print compact JSON only.\nUnknown operations, malformed JSON, malformed arguments, or invalid data must exit non-zero.`;
    const snapshot = [
      { role: "assistant" as const, content: "All tests pass and the CLI works end-to-end." },
    ];
    const evidence = [
      buildEvidenceItem(
        "bash",
        { command: "python run_tests.py" },
        [{ type: "text", text: "TESTS: passed=52 total=52" }],
        false,
      )!,
      buildEvidenceItem(
        "bash",
        { command: "python -c \"from pet_polyglot import parse_js_window_assignment\"" },
        [{ type: "text", text: "ok" }],
        false,
      )!,
      buildEvidenceItem(
        "bash",
        { command: "python -m pet_polyglot '{\"op\":\"simulate_editor\",\"args\":{}}'" },
        [{ type: "text", text: '{"cursor":0}' }],
        false,
      )!,
      buildEvidenceItem(
        "bash",
        { command: "python -m pet_polyglot 'not json' ; echo EXIT: 1" },
        [{ type: "text", text: "Error: Invalid JSON\nEXIT: 1" }],
        false,
      )!,
    ];

    const summary = summarizeEvidenceForPrompt(outcome, snapshot, evidence, true);
    expect(summary.warnings).toEqual([]);
  });
});
