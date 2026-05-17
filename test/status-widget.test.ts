import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupervisorState } from "../src/types.js";
import { setWidgetVisible, updateUI, type WidgetAction } from "../src/ui/status-widget.js";

// ── Helpers ────────────────────────────────────────────────────────────

/** Plain-text theme that strips ANSI/formatting — returns raw strings. */
const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

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
): string[] {
  let widgetResult: any = null;

  const ctx = {
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

  it("renders two lines when active", () => {
    const lines = captureRender(makeState());
    expect(lines.length).toBe(2);
  });

  it("line 1 contains Supervising and Goal", () => {
    const lines = captureRender(makeState());
    expect(lines[0]).toContain("Supervising");
    expect(lines[0]).toContain("Goal:");
    expect(lines[0]).toContain("Refactor auth module");
  });

  it("line 2 contains model, sensitivity, and action", () => {
    const lines = captureRender(makeState());
    expect(lines[1]).toContain("claude-haiku-4-5");
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

  it("clears widget when state is null", () => {
    let widgetCleared = false;
    let statusCleared = false;
    const ctx = {
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
      ui: {
        setStatus: vi.fn(),
        setWidget: vi.fn((_id: string, val: any) => { if (val === undefined) widgetCleared = true; }),
      },
    } as any;

    updateUI(ctx, makeState());
    expect(widgetCleared).toBe(true);
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
});