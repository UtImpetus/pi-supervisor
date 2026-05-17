/**
 * Workspace-level supervisor config — persists settings to .pi/supervisor-config.json.
 * Only written when the .pi/ directory already exists.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Sensitivity, SensitivityConfig } from "./types.js";

const PI_DIR = ".pi";
const CONFIG_FILE = "supervisor-config.json";

export interface WorkspaceModelConfig {
  provider: string;
  modelId: string;
}

export interface WorkspaceSupervisorConfig {
  provider?: string;
  modelId?: string;
  sensitivity?: Sensitivity;
  sensitivityConfig?: SensitivityConfig;
  widgetVisible?: boolean;
}

function isSensitivity(value: unknown): value is Sensitivity {
  return value === "low" || value === "medium" || value === "high" || value === "custom";
}

function isSensitivityConfig(value: unknown): value is SensitivityConfig {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.checkInterval === "number" &&
    typeof v.confidenceThreshold === "number" &&
    typeof v.messageLimit === "number"
  );
}

/** Read config from <cwd>/.pi/supervisor-config.json. Returns null if absent or unreadable. */
export function loadWorkspaceConfig(cwd: string): WorkspaceSupervisorConfig | null {
  const configPath = join(cwd, PI_DIR, CONFIG_FILE);
  if (!existsSync(configPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
    const config: WorkspaceSupervisorConfig = {};

    if (typeof parsed.provider === "string" && typeof parsed.modelId === "string") {
      config.provider = parsed.provider;
      config.modelId = parsed.modelId;
    }

    if (isSensitivity(parsed.sensitivity)) {
      config.sensitivity = parsed.sensitivity;
    }

    if (isSensitivityConfig(parsed.sensitivityConfig)) {
      config.sensitivityConfig = parsed.sensitivityConfig;
    }

    if (typeof parsed.widgetVisible === "boolean") {
      config.widgetVisible = parsed.widgetVisible;
    }

    return Object.keys(config).length > 0 ? config : null;
  } catch {}
  return null;
}

/** Read model config from <cwd>/.pi/supervisor-config.json. Returns null if model fields are absent. */
export function loadWorkspaceModel(cwd: string): WorkspaceModelConfig | null {
  const config = loadWorkspaceConfig(cwd);
  if (config?.provider && config?.modelId) {
    return { provider: config.provider, modelId: config.modelId };
  }
  return null;
}

/**
 * Merge and write config to <cwd>/.pi/supervisor-config.json.
 * Silently skips if the .pi/ directory does not exist.
 * Returns true when the file was written.
 */
export function saveWorkspaceConfig(cwd: string, patch: WorkspaceSupervisorConfig): boolean {
  const piDir = join(cwd, PI_DIR);
  if (!existsSync(piDir)) return false;
  try {
    const merged: WorkspaceSupervisorConfig = {
      ...(loadWorkspaceConfig(cwd) ?? {}),
      ...patch,
    };

    if (typeof merged.provider !== "string" || typeof merged.modelId !== "string") {
      delete merged.provider;
      delete merged.modelId;
    }

    if (!isSensitivity(merged.sensitivity)) {
      delete merged.sensitivity;
    }

    if (merged.sensitivity !== "custom") {
      delete merged.sensitivityConfig;
    } else if (!isSensitivityConfig(merged.sensitivityConfig)) {
      delete merged.sensitivityConfig;
    }

    if (typeof merged.widgetVisible !== "boolean") {
      delete merged.widgetVisible;
    }

    writeFileSync(
      join(cwd, PI_DIR, CONFIG_FILE),
      JSON.stringify(merged, null, 2) + "\n",
      "utf-8"
    );
    return true;
  } catch {
    return false;
  }
}

/** Write model config to <cwd>/.pi/supervisor-config.json while preserving other settings. */
export function saveWorkspaceModel(cwd: string, provider: string, modelId: string): boolean {
  return saveWorkspaceConfig(cwd, { provider, modelId });
}
