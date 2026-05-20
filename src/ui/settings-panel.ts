/**
 * settings-panel.ts — Interactive settings overlay for the supervisor.
 *
 * Uses pi-tui's SettingsList component to provide a navigable settings UI
 * with cycling values, submenu support (model picker), and explicit apply.
 *
 * When sensitivity is a preset, the sub-parameters show resolved values
 * but cycling them automatically switches to "custom".
 *
 * Opened via `/supervise` (no args) or `/supervise settings`.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { ModelSelectorComponent, SettingsManager } from "@mariozechner/pi-coding-agent";
import { type SettingItem, SettingsList, type SettingsListTheme } from "@mariozechner/pi-tui";
import type { Sensitivity, SensitivityConfig, SupervisorState } from "../types.js";
import { detectSensitivityPreset, resolveSensitivityConfig, SENSITIVITY_PRESETS } from "../types.js";

const SENSITIVITIES: Sensitivity[] = ["ultralight", "low", "medium", "high", "custom"];

const SENSITIVITY_DESCRIPTIONS: Record<Sensitivity, string> = {
  ultralight: "Very hands-off: end-of-run only, prefer done unless major work is missing",
  low: "Steer only when seriously off track (end of run only)",
  medium: "Steer on clear drift (end of run + every 3rd mid-run)",
  high: "Proactive steering (end of run + every mid-run)",
  custom: "Fine-tuned: adjust check interval, threshold, and window below",
};

const CHECK_INTERVAL_VALUES = ["0", "1", "2", "3", "4", "5"];
const CONFIDENCE_VALUES = ["0.70", "0.75", "0.80", "0.85", "0.90", "0.95"];
const MESSAGE_LIMIT_VALUES = ["4", "6", "8", "10", "12", "16", "20", "24"];

function formatCheckInterval(v: string): string {
  const n = Number(v);
  if (n === 0) return "off (end-of-run only)";
  if (n === 1) return "every turn";
  return `every ${n} turns`;
}

export interface SettingsDefaults {
  provider: string;
  modelId: string;
  sensitivity: Sensitivity;
  sensitivityConfig?: SensitivityConfig;
  checklistEnabled: boolean;
  widgetVisible: boolean;
  debugPayloads?: boolean;
}

export interface SettingsResult {
  model?: { provider: string; modelId: string };
  sensitivity?: Sensitivity;
  sensitivityConfig?: SensitivityConfig;
  checklistEnabled?: boolean;
  widget?: boolean;
  debugPayloads?: boolean;
  action?: "stop";
}

export function hasSettingsDraftChanges(draft: SettingsResult): boolean {
  return (
    draft.model !== undefined ||
    draft.sensitivity !== undefined ||
    draft.checklistEnabled !== undefined ||
    draft.widget !== undefined ||
    draft.debugPayloads !== undefined
  );
}

/**
 * Open the interactive settings panel.
 * Returns the changes the user explicitly applied, or null if cancelled.
 */
export async function openSettings(
  ctx: ExtensionContext,
  state: SupervisorState | null,
  defaults: SettingsDefaults,
): Promise<SettingsResult | null> {
  const currentProvider = state?.provider ?? defaults.provider;
  const currentModelId = state?.modelId ?? defaults.modelId;
  const currentSensitivity = state?.sensitivity ?? defaults.sensitivity;
  const currentConfig = resolveSensitivityConfig(currentSensitivity, state?.sensitivityConfig ?? defaults.sensitivityConfig);
  const currentChecklistEnabled = state?.checklistEnabled ?? defaults.checklistEnabled;
  const currentWidgetVisible = defaults.widgetVisible;
  const currentDebugPayloads = defaults.debugPayloads ?? false;
  const isActive = state?.active === true;

  // Mutable draft state
  let draftSensitivity: Sensitivity = currentSensitivity;
  let draftConfig: SensitivityConfig = { ...currentConfig };
  let draftSensitivityConfig: SensitivityConfig | undefined = currentSensitivity === "custom" ? { ...currentConfig } : undefined;

  const draft: SettingsResult = {};

  return ctx.ui.custom<SettingsResult | null>((tui, theme, _kb, done) => {
    const submit = (action?: "stop") => {
      if (action) draft.action = action;
      if (hasSettingsDraftChanges(draft) || action) {
        done({ ...draft });
      } else {
        done({});
      }
    };

    const makeModelSubmenu = (currentValue: string, submenuDone: (selected?: string) => void) => {
      const [prov, mid] = currentValue.includes("/")
        ? [currentValue.split("/")[0], currentValue.split("/").slice(1).join("/")]
        : [currentProvider, currentValue];
      const currentModel = ctx.modelRegistry.find(prov, mid);
      const settingsManager = SettingsManager.inMemory();
      const component = new ModelSelectorComponent(
        tui,
        currentModel,
        settingsManager,
        ctx.modelRegistry,
        [],
        (model) => {
          draft.model = { provider: model.provider, modelId: model.id };
          submenuDone(`${model.provider}/${model.id}`);
        },
        () => submenuDone(),
      );
      component.focused = true;
      return component;
    };

    // Resolve the effective config for sub-param display
    const effectiveConfig = (): SensitivityConfig => {
      if (draft.sensitivity && draft.sensitivity !== "custom") {
        return SENSITIVITY_PRESETS[draft.sensitivity];
      }
      if (draft.sensitivity === "custom" || draftSensitivity === "custom") {
        return draftConfig;
      }
      return currentConfig;
    };

    const items: SettingItem[] = [
      {
        id: "model",
        label: "Model",
        description: "Supervisor LLM model (Enter to browse)",
        currentValue: `${currentProvider}/${currentModelId}`,
        submenu: makeModelSubmenu,
      },
      {
        id: "sensitivity",
        label: "Sensitivity",
        description: SENSITIVITY_DESCRIPTIONS[draftSensitivity],
        currentValue: draftSensitivity,
        values: [...SENSITIVITIES],
      },
      {
        id: "checkInterval",
        label: "  Check Interval",
        description: "How many turns between mid-run checks (0 = off, end-of-run only)",
        currentValue: formatCheckInterval(String(effectiveConfig().checkInterval)),
        values: CHECK_INTERVAL_VALUES,
      },
      {
        id: "confidenceThreshold",
        label: "  Confidence Threshold",
        description: "Minimum confidence (0–1) to steer mid-run",
        currentValue: String(effectiveConfig().confidenceThreshold),
        values: CONFIDENCE_VALUES,
      },
      {
        id: "messageLimit",
        label: "  Message Window",
        description: "Number of recent messages included in supervisor context",
        currentValue: String(effectiveConfig().messageLimit),
        values: MESSAGE_LIMIT_VALUES,
      },
      {
        id: "checklistEnabled",
        label: "Completion Checklist",
        description: "Require the supervisor's completion checklist before finishing",
        currentValue: currentChecklistEnabled ? "enabled" : "disabled",
        values: ["enabled", "disabled"],
      },
      {
        id: "widget",
        label: "Widget",
        description: "Show/hide the supervisor widget in the footer",
        currentValue: currentWidgetVisible ? "visible" : "hidden",
        values: ["visible", "hidden"],
      },
      {
        id: "debugPayloads",
        label: "Payload Debug",
        description: "Log supervisor model prompts/payloads to .pi/supervisor-payload.log",
        currentValue: currentDebugPayloads ? "enabled" : "disabled",
        values: ["enabled", "disabled"],
      },
    ];

    if (isActive) {
      items.push({
        id: "outcome",
        label: "Outcome",
        description: `Steers: ${state!.interventions.length} · Turns: ${state!.turnCount}`,
        currentValue: `"${state!.outcome.length > 60 ? state!.outcome.slice(0, 59) + "…" : state!.outcome}"`,
      });
    }

    items.push({
      id: "apply",
      label: "Apply & Close",
      description: "Save pending changes and close the settings panel",
      currentValue: "",
      values: ["apply"],
    });
    items.push({
      id: "cancel",
      label: "Cancel",
      description: "Discard pending changes and close the settings panel",
      currentValue: "",
      values: ["discard"],
    });

    if (isActive) {
      items.push({
        id: "stop",
        label: "Stop Supervision",
        description: "Stop the active supervisor and close the settings panel",
        currentValue: "",
        values: ["confirm"],
      });
    }

    const settingsTheme: SettingsListTheme = {
      label: (text, selected) => selected ? theme.bold(theme.fg("accent", text)) : theme.fg("dim", text),
      value: (text, selected) => selected ? theme.fg("accent", text) : theme.fg("muted", text),
      description: (text) => theme.fg("dim", text),
      cursor: theme.fg("accent", "❯"),
      hint: (text) => theme.fg("dim", text),
    };

    const settingsList = new SettingsList(
      items,
      12,
      settingsTheme,
      (id, newValue) => {
        if (id === "sensitivity") {
          const newSens = newValue as Sensitivity;
          draftSensitivity = newSens;
          draft.sensitivity = newSens;
          if (newSens === "custom") {
            draftConfig = { ...effectiveConfig() };
            draftSensitivityConfig = { ...draftConfig };
            draft.sensitivityConfig = draftSensitivityConfig;
          } else {
            draftConfig = { ...SENSITIVITY_PRESETS[newSens] };
            draftSensitivityConfig = undefined;
            draft.sensitivityConfig = undefined;
          }
          // Update sub-param displays to reflect the preset values
          settingsList.updateValue("sensitivity", newSens);
          settingsList.updateValue("checkInterval", formatCheckInterval(String(draftConfig.checkInterval)));
          settingsList.updateValue("confidenceThreshold", String(draftConfig.confidenceThreshold));
          settingsList.updateValue("messageLimit", String(draftConfig.messageLimit));
          settingsList.invalidate();
        } else if (id === "checkInterval") {
          draftConfig.checkInterval = Number(newValue);
          draftSensitivityConfig = { ...draftConfig };
          const detected = detectSensitivityPreset(draftConfig);
          if (detected !== "custom") {
            draftSensitivity = detected;
            draftSensitivityConfig = undefined;
          } else {
            draftSensitivity = "custom";
          }
          draft.sensitivity = draftSensitivity;
          draft.sensitivityConfig = draftSensitivityConfig;
          settingsList.updateValue("sensitivity", draftSensitivity);
          settingsList.updateValue("checkInterval", formatCheckInterval(newValue));
          settingsList.invalidate();
        } else if (id === "confidenceThreshold") {
          draftConfig.confidenceThreshold = Number(newValue);
          draftSensitivityConfig = { ...draftConfig };
          const detected = detectSensitivityPreset(draftConfig);
          if (detected !== "custom") {
            draftSensitivity = detected;
            draftSensitivityConfig = undefined;
          } else {
            draftSensitivity = "custom";
          }
          draft.sensitivity = draftSensitivity;
          draft.sensitivityConfig = draftSensitivityConfig;
          settingsList.updateValue("sensitivity", draftSensitivity);
          settingsList.updateValue("confidenceThreshold", newValue);
          settingsList.invalidate();
        } else if (id === "messageLimit") {
          draftConfig.messageLimit = Number(newValue);
          draftSensitivityConfig = { ...draftConfig };
          const detected = detectSensitivityPreset(draftConfig);
          if (detected !== "custom") {
            draftSensitivity = detected;
            draftSensitivityConfig = undefined;
          } else {
            draftSensitivity = "custom";
          }
          draft.sensitivity = draftSensitivity;
          draft.sensitivityConfig = draftSensitivityConfig;
          settingsList.updateValue("sensitivity", draftSensitivity);
          settingsList.updateValue("messageLimit", newValue);
          settingsList.invalidate();
        } else if (id === "checklistEnabled") {
          draft.checklistEnabled = newValue === "enabled";
        } else if (id === "widget") {
          draft.widget = newValue === "visible";
        } else if (id === "debugPayloads") {
          draft.debugPayloads = newValue === "enabled";
        } else if (id === "apply" && newValue === "apply") {
          submit();
        } else if (id === "cancel" && newValue === "discard") {
          done(null);
        } else if (id === "stop" && newValue === "confirm") {
          submit("stop");
        }
      },
      () => done(null),
    );

    return {
      render: (width: number) => {
        const lines: string[] = [];
        const title = isActive
          ? `${theme.fg("accent", "◉")} ${theme.bold("Supervisor Settings")} ${theme.fg("dim", "(active)")}`
          : `${theme.fg("dim", "○")} ${theme.bold("Supervisor Settings")}`;
        lines.push(title);
        lines.push(theme.fg("dim", "─".repeat(Math.min(40, width))));
        lines.push(theme.fg("dim", "Draft changes are only saved when you choose Apply & Close. Cancel or Esc discards."));
        lines.push("");
        lines.push(...settingsList.render(width));
        return lines;
      },
      invalidate: () => settingsList.invalidate(),
      handleInput: (data: string) => {
        settingsList.handleInput(data);
        tui.requestRender();
      },
    };
  });
}