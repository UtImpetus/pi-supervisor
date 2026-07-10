/**
 * Core types for the pi-supervisor extension.
 */

/** Sensitivity presets and custom. */
export type Sensitivity = "ultralight" | "low" | "medium" | "high" | "custom";

/** Built-in predefined check IDs that users can opt into via settings. */
export type PredefinedCheckId = "docs-sync" | "critical-review" | "code-smells";

/** A built-in, outcome-agnostic process-hygiene checklist item. */
export interface PredefinedCheck {
  id: PredefinedCheckId;
  title: string;
  description: string;
  verificationPrompt: string;
}

/** The canonical set of built-in predefined checks. */
export const PREDEFINED_CHECKS: readonly PredefinedCheck[] = [
  {
    id: "docs-sync",
    title: "Documentation updated",
    description:
      "Any user-facing changes, new APIs, or behavioral changes are reflected in README, docs, or inline comments.",
    verificationPrompt:
      "Verify that README, CHANGELOG, or relevant docs mention the changes you made. If you added or changed public APIs, confirm the documentation is accurate.",
  },
  {
    id: "critical-review",
    title: "Self-critique review",
    description:
      "Re-examine your changes for obvious errors, missed requirements, or regressions before finishing.",
    verificationPrompt:
      "Re-read the full diff of your changes. Check for typos, missed edge cases, unintended file modifications, and ensure the implementation matches the stated goal. Treat any unaddressed CLAIM / EVIDENCE WARNINGS in the prompt as proof that requirements are still unverified. If there are warnings about missing CLI verification, untested error cases, or unproven public API behavior, this item fails. List every warning that is still open and tell the agent to run the exact command or test that would resolve it.",
  },
  {
    id: "code-smells",
    title: "Code quality cleanup",
    description:
      "Remove obvious code smells introduced or left behind: dead code, duplicated logic, unclear names, missing error handling.",
    verificationPrompt:
      "Examine recent code and tool output for obvious quality issues: unused variables, duplicated logic, hardcoded values, unclear names, or missing error handling. Also check whether the agent added dead code during recent fixes. Be specific: cite filename and line number when you flag something. If you see any issue, return needs_work with the exact location and fix required.",
  },
];

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

export interface CompletionChecklistItem {
  id: string;
  title: string;
  description: string;
  verificationPrompt: string;
  status: "pending" | "passed" | "skipped";
  attempts: number;
}

export interface CompletionChecklist {
  status: "pending" | "ready" | "failed";
  count: number;
  source?: "bootstrap-llm";
  error?: string;
  currentIndex: number;
  summaryRequested: boolean;
  items: CompletionChecklistItem[];
}

export interface ChecklistReviewDecision {
  status: "passed" | "needs_work";
  message?: string;
  reasoning: string;
  confidence: number;
}

/** A single intervention record */
export interface SupervisorIntervention {
  turnCount: number;
  message: string;
  reasoning: string;
  timestamp: number;
}

/** Named presets mapping sensitivity labels to their config values. */
export const SENSITIVITY_PRESETS: Record<Exclude<Sensitivity, "custom">, SensitivityConfig> = {
  ultralight: {
    checkInterval: 0,
    confidenceThreshold: 1.0,
    messageLimit: 4,
  },
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
export interface SupervisorHardConstraint {
  kind: "forbid-path" | "allow-only-path" | "forbid-git";
  pattern: string;
  source: string;
  createdAt: number;
}

export interface SupervisorRecoveryState {
  blockedToolCalls: number;
  repeatedFailures: number;
  lastRecoveryAt?: number;
}

export interface SupervisorState {
  active: boolean;
  outcome: string;
  provider: string;          // e.g. "anthropic"
  modelId: string;           // e.g. "claude-haiku-4-5-20251001"
  sensitivity: Sensitivity;
  sensitivityConfig?: SensitivityConfig;  // present when "custom"
  checklistEnabled?: boolean;
  enabledPredefinedChecks?: PredefinedCheckId[];
  pendingOutcomeUpdate?: { outcome: string; requestedAt: number };
  interventions: SupervisorIntervention[];
  startedAt: number;
  turnCount: number;
  completionChecklist?: CompletionChecklist;
  hardConstraints?: SupervisorHardConstraint[];
  recovery?: SupervisorRecoveryState;
}

/** Persisted supervisor defaults/preferences used when supervision is inactive. */
export interface SupervisorPreferences {
  provider?: string;
  modelId?: string;
  sensitivity?: Sensitivity;
  sensitivityConfig?: SensitivityConfig;
  checklistEnabled?: boolean;
  enabledPredefinedChecks?: PredefinedCheckId[];
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
