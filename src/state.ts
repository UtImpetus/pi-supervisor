/**
 * SupervisorStateManager — manages in-memory supervisor state and session persistence.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  CompletionChecklist,
  CompletionChecklistItem,
  Sensitivity,
  SensitivityConfig,
  SupervisorIntervention,
  SupervisorPreferences,
  SupervisorState,
} from "./types.js";

const STATE_ENTRY_TYPE = "supervisor-state";
const PREFERENCES_ENTRY_TYPE = "supervisor-preferences";

export const DEFAULT_PROVIDER = "anthropic";
export const DEFAULT_MODEL_ID = "claude-haiku-4-5-20251001";
export const DEFAULT_SENSITIVITY: Sensitivity = "medium";

export class SupervisorStateManager {
  private state: SupervisorState | null = null;
  private preferences: SupervisorPreferences = {};
  private pi: ExtensionAPI;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  start(
    outcome: string,
    provider: string,
    modelId: string,
    sensitivity: Sensitivity,
    sensitivityConfig?: SensitivityConfig,
    checklistEnabled = true,
  ): void {
    this.state = {
      active: true,
      outcome,
      provider,
      modelId,
      sensitivity,
      sensitivityConfig,
      checklistEnabled,
      pendingOutcomeUpdate: undefined,
      interventions: [],
      startedAt: Date.now(),
      turnCount: 0,
      completionChecklist: checklistEnabled
        ? {
            status: "pending",
            count: 0,
            currentIndex: 0,
            summaryRequested: false,
            items: [],
          }
        : undefined,
    };
    this.preferences = {
      ...this.preferences,
      provider,
      modelId,
      sensitivity,
      sensitivityConfig,
      checklistEnabled,
    };
    this.persistPreferences();
    this.persistState();
  }

  stop(): void {
    if (!this.state) return;
    this.state.active = false;
    this.state.pendingOutcomeUpdate = undefined;
    this.persistState();
  }

  isActive(): boolean {
    return this.state?.active === true;
  }

  getState(): SupervisorState | null {
    return this.state;
  }

  getPreferences(): SupervisorPreferences {
    return { ...this.preferences };
  }

  setPreferences(patch: SupervisorPreferences): void {
    this.preferences = {
      ...this.preferences,
      ...patch,
    };
    this.persistPreferences();
  }

  addIntervention(intervention: SupervisorIntervention): void {
    if (!this.state) return;
    this.state.interventions.push(intervention);
    this.persistState();
  }

  incrementTurnCount(): void {
    if (!this.state) return;
    this.state.turnCount++;
  }

  setCompletionChecklist(items: Array<Pick<CompletionChecklistItem, "id" | "title" | "description" | "verificationPrompt">>): void {
    if (!this.state) return;
    this.state.completionChecklist = {
      status: "ready",
      count: items.length,
      source: "bootstrap-llm",
      currentIndex: 0,
      summaryRequested: false,
      items: items.map((item) => ({ ...item, status: "pending", attempts: 0 })),
    };
    this.persistState();
  }

  setChecklistSetup(checklist: Pick<CompletionChecklist, "status" | "count" | "source" | "error">): void {
    if (!this.state) return;
    const current = this.state.completionChecklist ?? {
      status: "pending",
      count: 0,
      currentIndex: 0,
      summaryRequested: false,
      items: [],
    };
    this.state.completionChecklist = {
      ...current,
      ...checklist,
    };
    this.persistState();
  }

  markCurrentChecklistItemPassed(): void {
    if (!this.state?.completionChecklist) return;
    const checklist = this.state.completionChecklist;
    const item = checklist.items[checklist.currentIndex];
    if (!item) return;
    item.status = "passed";
    checklist.currentIndex = Math.min(checklist.currentIndex + 1, checklist.items.length);
    this.persistState();
  }

  incrementCurrentChecklistAttempt(): void {
    if (!this.state?.completionChecklist) return;
    const item = this.state.completionChecklist.items[this.state.completionChecklist.currentIndex];
    if (!item) return;
    item.attempts += 1;
    this.persistState();
  }

  setChecklistSummaryRequested(requested: boolean): void {
    if (!this.state?.completionChecklist) return;
    this.state.completionChecklist.summaryRequested = requested;
    this.persistState();
  }

  setModel(provider: string, modelId: string): void {
    this.preferences = {
      ...this.preferences,
      provider,
      modelId,
    };
    this.persistPreferences();

    if (!this.state) return;
    this.state.provider = provider;
    this.state.modelId = modelId;
    this.persistState();
  }

  setSensitivity(sensitivity: Sensitivity, sensitivityConfig?: SensitivityConfig): void {
    this.preferences = {
      ...this.preferences,
      sensitivity,
      sensitivityConfig,
    };
    this.persistPreferences();

    if (!this.state) return;
    this.state.sensitivity = sensitivity;
    this.state.sensitivityConfig = sensitivityConfig;
    this.persistState();
  }

  setChecklistEnabled(enabled: boolean): void {
    this.preferences = {
      ...this.preferences,
      checklistEnabled: enabled,
    };
    this.persistPreferences();

    if (!this.state) return;
    this.state.checklistEnabled = enabled;
    this.state.completionChecklist = enabled
      ? this.state.completionChecklist ?? {
          status: "pending",
          count: 0,
          currentIndex: 0,
          summaryRequested: false,
          items: [],
        }
      : undefined;
    this.persistState();
  }

  setOutcome(outcome: string): void {
    if (!this.state) return;
    this.state.outcome = outcome;
    this.state.pendingOutcomeUpdate = undefined;
    this.persistState();
  }

  queueOutcomeUpdate(outcome: string): void {
    if (!this.state) return;
    this.state.pendingOutcomeUpdate = { outcome, requestedAt: Date.now() };
    this.persistState();
  }

  consumePendingOutcomeUpdate(): string | null {
    if (!this.state?.pendingOutcomeUpdate) return null;
    const { outcome } = this.state.pendingOutcomeUpdate;
    this.state.pendingOutcomeUpdate = undefined;
    this.persistState();
    return outcome;
  }

  peekPendingOutcomeUpdate(): string | null {
    return this.state?.pendingOutcomeUpdate?.outcome ?? null;
  }

  resetChecklistProgress(preserveReadyItems = true): void {
    if (!this.state) return;
    if (this.state.checklistEnabled === false) {
      this.state.completionChecklist = undefined;
      this.persistState();
      return;
    }

    const checklist = this.state.completionChecklist;
    if (preserveReadyItems && checklist?.status === "ready" && checklist.items.length > 0) {
      this.state.completionChecklist = {
        ...checklist,
        currentIndex: 0,
        summaryRequested: false,
        items: checklist.items.map((item) => ({
          ...item,
          status: "pending",
          attempts: 0,
        })),
      };
      this.persistState();
      return;
    }

    this.state.completionChecklist = {
      status: "pending",
      count: 0,
      currentIndex: 0,
      summaryRequested: false,
      items: [],
    };
    this.persistState();
  }

  resetRuntimeStats(): void {
    if (!this.state) return;
    this.state.interventions = [];
    this.state.startedAt = Date.now();
    this.state.turnCount = 0;
    this.resetChecklistProgress(true);
  }

  /** Restore state/preferences from session entries (picks the most recent of each type). */
  loadFromSession(ctx: ExtensionContext): void {
    const entries = ctx.sessionManager.getBranch();
    let foundState = false;
    let foundPreferences = false;

    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type !== "custom") continue;

      const customEntry = entry as any;
      if (!foundState && customEntry.customType === STATE_ENTRY_TYPE) {
        this.state = customEntry.data as SupervisorState;
        foundState = true;
      }

      if (!foundPreferences && customEntry.customType === PREFERENCES_ENTRY_TYPE) {
        this.preferences = customEntry.data as SupervisorPreferences;
        foundPreferences = true;
      }

      if (foundState && foundPreferences) return;
    }

    if (!foundState) {
      this.state = null;
    }
    if (!foundPreferences) {
      this.preferences = {};
    }
  }

  private persistState(): void {
    if (!this.state) return;
    this.pi.appendEntry(STATE_ENTRY_TYPE, { ...this.state });
  }

  private persistPreferences(): void {
    this.pi.appendEntry(PREFERENCES_ENTRY_TYPE, { ...this.preferences });
  }
}
