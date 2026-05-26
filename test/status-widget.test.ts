import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupervisorState } from "../src/types.js";
import { describePromptSource, setWidgetVisible, updateUI, type WidgetAction } from "../src/ui/status-widget.js";

// ── Helpers ────────────────────────────────────────────────────────────

/** Plain-text theme that strips ANSI/formatting — returns raw strings. */
const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const tempDirs: string[] = [];

function makeTempCwd(): string {
  const cwd = mkdtempSync(join(tmpdir(), "pi-supervisor-widget-"));
  tempDirs.push(cwd);
  return cwd;
}

function makeState(overrides: Partial<SupervisorState> = {}): SupervisorState {
  return {
    active: true,
    outcome: "Refactor auth module",
    provider: "anthropic",
    modelId: "claude-haiku-4-5",
    sensitivity: "medium",
    interventions: [],
    turnCount: 3,
    startedAt: Date.now(),
    ...overrides,
  } as SupervisorState;
}

/** Capture the widget render output as plain-text lines. */
function captureRender(
  state: SupervisorState | null,
  action: WidgetAction = { type: "watching" },
  width = 120,
  cwd = makeTempCwd(),
): string[] {
  let widgetResult: any = null;

  const ctx = {
    cwd,
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn((_id: string, factory: any) => {
        if (factory) widgetResult = factory(null, plainTheme);
      }),
    },
  } as any;

  setWidgetVisible(true);
  updateUI(ctx, state, action);

  if (!widgetResult) return [];
  return widgetResult.render(width);
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("status-widget", () => {
  beforeEach(() => {
    setWidgetVisible(true);
  });

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("renders two lines when active", () => {
    const lines = captureRender(makeState());
    expect(lines.length).toBe(2);
  });

  it("line 1 contains Supervising, version, and Goal", () => {
    const lines = captureRender(makeState());
    expect(lines[0]).toContain("Supervising");
    expect(lines[0]).toContain("v0.5.1");
    expect(lines[0]).toContain("Goal:");
    expect(lines[0]).toContain("Refactor auth module");
  });

  it("line 2 contains model, prompt label, sensitivity, and action", () => {
    const cwd = makeTempCwd();
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi", "SUPERVISOR.md"), "GENERIC PROMPT");

    const lines = captureRender(makeState(), { type: "watching" }, 120, cwd);
    expect(lines[1]).toContain("claude-haiku-4-5");
    expect(lines[1]).toContain("prompt: generic");
    expect(lines[1]).toContain("sensitivity: medium");
    expect(lines[1]).toContain("watching");
  });

  it("line 2 includes steer count when > 0", () => {
    const state = makeState({ interventions: ["steer 1", "steer 2"] });
    const lines = captureRender(state);
    expect(lines[1]).toContain("↗ 2");
  });

  it("line 2 omits steer count when 0", () => {
    const lines = captureRender(makeState());
    expect(lines[1]).not.toContain("↗");
  });

  it("shows bootstrapping action and pending check setup", () => {
    const state = makeState({
      completionChecklist: { status: "pending", count: 0, currentIndex: 0, summaryRequested: false, items: [] },
    });
    const action: WidgetAction = { type: "bootstrapping", frame: "⠙" };
    const lines = captureRender(state, action);
    expect(lines[1]).toContain("checks: setting up");
    expect(lines[1]).toContain("⠙ setting up checks");
  });

  it("shows analyzing action with turn number", () => {
    const action: WidgetAction = { type: "analyzing", turn: 4 };
    const lines = captureRender(makeState(), action);
    expect(lines[1]).toContain("⟳ turn 4");
  });

  it("shows analyzing action with thinking snippet", () => {
    const action: WidgetAction = {
      type: "analyzing",
      turn: 2,
      thinking: "Checking whether the refactor preserves semantics",
    };
    const lines = captureRender(makeState(), action);
    expect(lines[1]).toContain("thinking:");
    expect(lines[1]).toContain("Checking whether");
  });

  it("shows steering action", () => {
    const action: WidgetAction = { type: "steering", message: "Add error handling" };
    const lines = captureRender(makeState(), action);
    expect(lines[1]).toContain("Add error handling");
  });

  it("shows done action", () => {
    const action: WidgetAction = { type: "done" };
    const lines = captureRender(makeState(), action);
    expect(lines[1]).toContain("✓ done");
  });

  it("Goal is on line 1, not line 2", () => {
    const lines = captureRender(makeState());
    expect(lines[0]).toContain("Goal:");
    expect(lines[1]).not.toContain("Goal:");
  });

  it("model and sensitivity are on line 2, not line 1", () => {
    const lines = captureRender(makeState());
    expect(lines[0]).not.toContain("claude-haiku");
    expect(lines[0]).not.toContain("sensitivity");
    expect(lines[1]).toContain("claude-haiku");
    expect(lines[1]).toContain("sensitivity");
  });

  it("uses the bootstrapping spinner frame in the footer status", () => {
    const ctx = {
      cwd: makeTempCwd(),
      ui: {
        setStatus: vi.fn(),
        setWidget: vi.fn(),
      },
    } as any;

    updateUI(ctx, makeState(), { type: "bootstrapping", frame: "⠋", summary: "setting up checks…" });
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("supervisor", "⠋");
  });

  it("clears widget when state is null", () => {
    let widgetCleared = false;
    let statusCleared = false;
    const ctx = {
      cwd: makeTempCwd(),
      ui: {
        setStatus: vi.fn((_id: string, val: any) => { if (val === undefined) statusCleared = true; }),
        setWidget: vi.fn((_id: string, val: any) => { if (val === undefined) widgetCleared = true; }),
      },
    } as any;

    updateUI(ctx, null);
    expect(statusCleared).toBe(true);
    expect(widgetCleared).toBe(true);
  });

  it("clears widget when state is inactive", () => {
    let widgetCleared = false;
    const ctx = {
      cwd: makeTempCwd(),
      ui: {
        setStatus: vi.fn(),
        setWidget: vi.fn((_id: string, val: any) => { if (val === undefined) widgetCleared = true; }),
      },
    } as any;

    updateUI(ctx, { active: false } as SupervisorState);
    expect(widgetCleared).toBe(true);
  });

  it("hides widget content when widget is toggled off", () => {
    setWidgetVisible(false);
    let widgetCleared = false;
    const ctx = {
      cwd: makeTempCwd(),
      ui: {
        setStatus: vi.fn(),
        setWidget: vi.fn((_id: string, val: any) => { if (val === undefined) widgetCleared = true; }),
      },
    } as any;

    updateUI(ctx, makeState());
    expect(widgetCleared).toBe(true);
  });

  it("renders multiline goals on a single line", () => {
    const lines = captureRender(makeState({ outcome: "First line\nsecond line\r\nthird line" }));
    expect(lines[0]).toContain("First line second line third line");
    expect(lines[0]).not.toContain("\n");
    expect(lines[0]).not.toContain("\r");
  });

  it("truncates long goals", () => {
    const longGoal = "A".repeat(200);
    const lines = captureRender(makeState({ outcome: longGoal }));
    // Line 1 should be truncated to fit width (120)
    expect(lines[0].length).toBeLessThanOrEqual(120);
  });

  it("shows custom sensitivity with config details", () => {
    const state = makeState({
      sensitivity: "custom",
      sensitivityConfig: { checkInterval: 2, confidenceThreshold: 0.8, messageLimit: 10 },
    });
    const lines = captureRender(state);
    expect(lines[1]).toContain("custom");
    expect(lines[1]).toContain("⨍2");
    expect(lines[1]).toContain("≥0.8");
    expect(lines[1]).toContain("w10");
  });

  it("shows checklist progress when runtime checks are ready", () => {
    const state = makeState({
      completionChecklist: {
        status: "ready",
        count: 2,
        source: "bootstrap-llm",
        currentIndex: 1,
        summaryRequested: false,
        items: [
          { id: "imports", title: "Verify imports", description: "Public imports must work", verificationPrompt: "Check imports.", status: "passed", attempts: 1 },
          { id: "cli", title: "Verify CLI", description: "CLI output must match", verificationPrompt: "Check CLI.", status: "pending", attempts: 0 },
        ],
      },
    });
    const lines = captureRender(state);
    expect(lines[1]).toContain("checks: 1/2");
  });

  it("shows when the checklist is disabled", () => {
    const state = makeState({ checklistEnabled: false, completionChecklist: undefined });
    const lines = captureRender(state);
    expect(lines[1]).toContain("checks: off");
  });
});

describe("describePromptSource", () => {
  it("labels built-in model-specific prompts by prefix", () => {
    expect(describePromptSource("built-in:deepseek", "deepseek-v4-flash")).toBe("prompt: deepseek");
  });

  it("labels built-in fallback prompts as default", () => {
    expect(describePromptSource("built-in", "claude-haiku-4-5")).toBe("prompt: default");
  });

  it("labels model-specific prompt files as model", () => {
    expect(describePromptSource("/repo/.pi/deepseek-v4-flash-SUPERVISOR.md", "deepseek-v4-flash")).toBe("prompt: model");
  });

  it("labels generic prompt files as generic", () => {
    expect(describePromptSource("/repo/.pi/SUPERVISOR.md", "deepseek-v4-flash")).toBe("prompt: generic");
  });
});
