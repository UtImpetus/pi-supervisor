/**
 * SupervisorStateManager — manages in-memory supervisor state and session persistence.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Sensitivity, SensitivityConfig, SupervisorIntervention, SupervisorPreferences, SupervisorState } from "./types.js";

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

  start(outcome: string, provider: string, modelId: string, sensitivity: Sensitivity, sensitivityConfig?: SensitivityConfig): void {
    this.state = {
      active: true,
      outcome,
      provider,
      modelId,
      sensitivity,
      sensitivityConfig,
      interventions: [],
      startedAt: Date.now(),
      turnCount: 0,
    };
    this.preferences = {
      ...this.preferences,
      provider,
      modelId,
      sensitivity,
      sensitivityConfig,
    };
    this.persistPreferences();
    this.persistState();
  }

  stop(): void {
    if (!this.state) return;
    this.state.active = false;
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
