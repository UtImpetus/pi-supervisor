/**
 * Core types for the pi-supervisor extension.
 */

/** Sensitivity presets and custom. */
export type Sensitivity = "low" | "medium" | "high" | "custom";

/** Tunable parameters that the sensitivity presets map to. */
export interface SensitivityConfig {
  /** How many tool-call cycles between mid-run checks. 0 = off (end-of-run only). */
  checkInterval: number;
  /** Minimum confidence (0–1) required to steer mid-run. */
  confidenceThreshold: number;
  /** Number of recent messages to include in the supervisor prompt. */
  messageLimit: number;
}

export type SupervisorAction = "continue" | "steer" | "done";

/** A single intervention record */
export interface SupervisorIntervention {
  turnCount: number;
  message: string;
  reasoning: string;
  timestamp: number;
}

/** Named presets mapping sensitivity labels to their config values. */
export const SENSITIVITY_PRESETS: Record<Exclude<Sensitivity, "custom">, SensitivityConfig> = {
  low: {
    checkInterval: 0,
    confidenceThreshold: 1.0,
    messageLimit: 6,
  },
  medium: {
    checkInterval: 3,
    confidenceThreshold: 0.9,
    messageLimit: 12,
  },
  high: {
    checkInterval: 1,
    confidenceThreshold: 0.85,
    messageLimit: 20,
  },
};

/**
 * Resolve a sensitivity label + optional config into a concrete SensitivityConfig.
 * - For presets (low/medium/high), returns the preset config.
 * - For "custom", returns the provided config or falls back to medium.
 */
export function resolveSensitivityConfig(
  sensitivity: Sensitivity,
  config?: SensitivityConfig,
): SensitivityConfig {
  if (sensitivity === "custom") {
    return config ?? SENSITIVITY_PRESETS.medium;
  }
  return SENSITIVITY_PRESETS[sensitivity];
}

/**
 * Determine the effective sensitivity label from a config.
 * Returns the matching preset name, or "custom" if no preset matches.
 */
export function detectSensitivityPreset(config: SensitivityConfig): Exclude<Sensitivity, "custom"> | "custom" {
  for (const [name, preset] of Object.entries(SENSITIVITY_PRESETS)) {
    if (
      preset.checkInterval === config.checkInterval &&
      preset.confidenceThreshold === config.confidenceThreshold &&
      preset.messageLimit === config.messageLimit
    ) {
      return name as Exclude<Sensitivity, "custom">;
    }
  }
  return "custom";
}

/** Full supervisor state — persisted to session */
export interface SupervisorState {
  active: boolean;
  outcome: string;
  provider: string;          // e.g. "anthropic"
  modelId: string;           // e.g. "claude-haiku-4-5-20251001"
  sensitivity: Sensitivity;
  sensitivityConfig?: SensitivityConfig;  // present when "custom"
  interventions: SupervisorIntervention[];
  startedAt: number;
  turnCount: number;
}

/** Persisted supervisor defaults/preferences used when supervision is inactive. */
export interface SupervisorPreferences {
  provider?: string;
  modelId?: string;
  sensitivity?: Sensitivity;
  sensitivityConfig?: SensitivityConfig;
  widgetVisible?: boolean;
  debugPayloads?: boolean;
}

/** Decision returned by the supervisor LLM */
export interface SteeringDecision {
  action: SupervisorAction;
  message?: string;
  reasoning: string;
  confidence: number;
}

/** A simplified message for building the supervisor context */
export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}
