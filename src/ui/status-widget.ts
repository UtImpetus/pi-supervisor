/**
 * Supervisor UI — footer status indicator and widget.
 *
 * Footer: 🎯 emoji badge.
 * Widget line 1: ◉ Supervising · Goal: "…"
 * Widget line 2: model · prompt source · sensitivity · steers · action/status
 *
 * Toggle visibility with toggleWidget().
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { loadSystemPrompt } from "../engine.js";
import type { SupervisorState } from "../types.js";
import { resolveSensitivityConfig } from "../types.js";
import { SUPERVISOR_VERSION_LABEL } from "../version.js";

const WIDGET_ID = "supervisor";
const STATUS_ID = "supervisor";

const MAX_OUTCOME_DISPLAY = 48;
const MAX_STEER_DISPLAY = 50;
const MAX_THINKING_DISPLAY = 80;
const SETUP_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

let _widgetVisible = true;

export function setWidgetVisible(visible: boolean): void {
  _widgetVisible = visible;
}

/** Toggle the widget on/off. Returns the new visibility state. */
export function toggleWidget(): boolean {
  _widgetVisible = !_widgetVisible;
  return _widgetVisible;
}

export function isWidgetVisible(): boolean {
  return _widgetVisible;
}

export type WidgetAction =
  | { type: "watching" }
  | { type: "bootstrapping"; summary?: string; frame?: string }
  | { type: "analyzing"; turn: number; thinking?: string }
  | { type: "steering"; message: string }
  | { type: "done" };

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

export function describePromptSource(source: string, modelId: string): string {
  if (source.startsWith("built-in:")) {
    return `prompt: ${source.slice("built-in:".length)}`;
  }
  if (source === "built-in") {
    return "prompt: default";
  }
  if (source.endsWith(`${modelId}-SUPERVISOR.md`)) {
    return "prompt: model";
  }
  return "prompt: generic";
}

/**
 * Update footer + widget. Call this every time state or action changes.
 * Clears both when state is null or inactive.
 */
export function updateUI(
  ctx: ExtensionContext,
  state: SupervisorState | null,
  action: WidgetAction = { type: "watching" }
): void {
  if (!state?.active) {
    ctx.ui.setStatus(STATUS_ID, undefined);
    ctx.ui.setWidget(WIDGET_ID, undefined);
    return;
  }

  const statusText = action.type === "bootstrapping"
    ? action.frame ?? SETUP_SPINNER_FRAMES[0]
    : "🎯";
  ctx.ui.setStatus(STATUS_ID, statusText);

  if (!_widgetVisible) {
    ctx.ui.setWidget(WIDGET_ID, undefined);
    return;
  }

  const { source: promptSource } = loadSystemPrompt(ctx.cwd, state.modelId);
  const snap = {
    outcome: state.outcome,
    modelId: state.modelId,
    promptLabel: describePromptSource(promptSource, state.modelId),
    sensitivity: state.sensitivity,
    sensitivityConfig: resolveSensitivityConfig(state.sensitivity, state.sensitivityConfig),
    interventions: [...state.interventions],
    completionChecklist: state.completionChecklist,
  };
  const snapAction = action;

  ctx.ui.setWidget(WIDGET_ID, (_tui, theme) => {
    const steerCount = snap.interventions.length;

    // Header: ◉ Supervising · vX
    const header = `${theme.fg("accent", "◉")} ${theme.fg("accent", "Supervising")} ${theme.fg("dim", SUPERVISOR_VERSION_LABEL)}`;
    // Goal label + value
    const goalLabel = theme.fg("dim", "Goal:");
    const goalText  = theme.fg("muted", `"${truncate(snap.outcome, MAX_OUTCOME_DISPLAY)}"`);
    const goal      = `${goalLabel} ${goalText}`;
    // Model
    const model = theme.fg("dim", snap.modelId);
    const prompt = theme.fg("dim", snap.promptLabel);
    // Sensitivity
    const sensitivityLabel = snap.sensitivity === "custom"
      ? `custom (⨍${snap.sensitivityConfig.checkInterval} ≥${snap.sensitivityConfig.confidenceThreshold} w${snap.sensitivityConfig.messageLimit})`
      : snap.sensitivity;
    const sensitivity = theme.fg("dim", `sensitivity: ${sensitivityLabel}`);
    // Steer count
    const steers = steerCount > 0 ? theme.fg("dim", `↗ ${steerCount}`) : "";
    const checklist = snap.completionChecklist;
    const passedChecks = checklist?.items.filter((item) => item.status === "passed").length ?? 0;
    const checks = checklist?.status === "pending"
      ? theme.fg("dim", "checks: setting up")
      : checklist?.status === "failed"
        ? theme.fg("dim", "checks: fallback")
        : checklist?.status === "ready"
          ? theme.fg("dim", `checks: ${passedChecks}/${checklist.count}`)
          : "";

    // Current action
    let actionStr: string;
    let thinking = "";
    switch (snapAction.type) {
      case "watching":
        actionStr = theme.fg("dim", "watching");
        break;
      case "bootstrapping": {
        const summary = snapAction.summary ? truncate(snapAction.summary, MAX_STEER_DISPLAY) : "setting up checks…";
        const label = snapAction.frame ? `${snapAction.frame} ${summary}` : summary;
        actionStr = theme.fg("warning", label);
        break;
      }
      case "analyzing":
        actionStr = theme.fg("warning", `⟳ turn ${snapAction.turn}`);
        thinking  = snapAction.thinking ?? "";
        break;
      case "steering":
        actionStr = theme.fg("warning", `↗ "${truncate(snapAction.message, MAX_STEER_DISPLAY)}"`);
        break;
      case "done":
        actionStr = theme.fg("accent", "✓ done");
        break;
    }

    const sep = theme.fg("dim", " · ");
    const line1 = [header, goal].join(sep);
    const thinkingStr = thinking ? theme.fg("dim", `thinking: ${truncate(thinking, MAX_THINKING_DISPLAY)}`) : "";
    const line2 = [model, prompt, sensitivity, checks, steers, actionStr, thinkingStr].filter(Boolean).join(sep);

    return {
      render: (width: number) => [
        truncateToWidth(line1, width),
        truncateToWidth(line2, width),
      ],
      invalidate: () => {},
    };
  });
}
