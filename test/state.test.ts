import { describe, expect, it, vi } from "vitest";
import { SupervisorStateManager } from "../src/state.js";
import type { CompletionChecklistItem, SupervisorPreferences, SupervisorState } from "../src/types.js";

function makePi() {
  return {
    appendEntry: vi.fn(),
  } as any;
}

function makeCtxWithBranch(branch: any[]) {
  return {
    sessionManager: { getBranch: () => branch },
  } as any;
}

describe("SupervisorStateManager", () => {
  it("start() seeds full state, syncs preferences, and persists both", () => {
    const pi = makePi();
    const mgr = new SupervisorStateManager(pi);

    mgr.start("ship the feature", "anthropic", "claude-haiku-4-5", "high");

    expect(mgr.isActive()).toBe(true);
    expect(mgr.getState()).toMatchObject({
      active: true,
      outcome: "ship the feature",
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      sensitivity: "high",
      checklistEnabled: true,
      interventions: [],
      turnCount: 0,
      completionChecklist: {
        status: "pending",
        count: 0,
        currentIndex: 0,
        summaryRequested: false,
        items: [],
      },
    });
    expect(mgr.getState()?.startedAt).toBeGreaterThan(0);
    expect(mgr.getPreferences()).toEqual({
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      sensitivity: "high",
      checklistEnabled: true,
    });

    expect(pi.appendEntry).toHaveBeenCalledTimes(2);
    expect(pi.appendEntry).toHaveBeenNthCalledWith(1, "supervisor-preferences", expect.objectContaining({
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      sensitivity: "high",
    }));
    expect(pi.appendEntry).toHaveBeenNthCalledWith(2, "supervisor-state", expect.objectContaining({
      active: true,
      outcome: "ship the feature",
    }));
  });

  it("start() with custom sensitivity config stores sensitivityConfig", () => {
    const pi = makePi();
    const mgr = new SupervisorStateManager(pi);

    const customConfig = { checkInterval: 2, confidenceThreshold: 0.8, messageLimit: 10 };
    mgr.start("custom goal", "anthropic", "claude-haiku-4-5", "custom", customConfig);

    expect(mgr.getState()).toMatchObject({
      sensitivity: "custom",
      sensitivityConfig: customConfig,
    });
    expect(mgr.getPreferences()).toMatchObject({
      sensitivity: "custom",
      sensitivityConfig: customConfig,
      checklistEnabled: true,
    });
  });

  it("stop() flips active=false and persists state; subsequent stop() is a no-op when state is null", () => {
    const pi = makePi();
    const mgr = new SupervisorStateManager(pi);

    mgr.stop();
    expect(pi.appendEntry).not.toHaveBeenCalled();

    mgr.start("x", "anthropic", "m", "low");
    pi.appendEntry.mockClear();

    mgr.stop();
    expect(mgr.isActive()).toBe(false);
    expect(pi.appendEntry).toHaveBeenCalledTimes(1);
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "supervisor-state",
      expect.objectContaining({ active: false }),
    );
  });

  it("addIntervention appends and persists state only; ignored when no state", () => {
    const pi = makePi();
    const mgr = new SupervisorStateManager(pi);

    mgr.addIntervention({ turnCount: 1, message: "stay on track", reasoning: "drift", timestamp: 1 });
    expect(pi.appendEntry).not.toHaveBeenCalled();

    mgr.start("x", "anthropic", "m", "medium");
    pi.appendEntry.mockClear();

    mgr.addIntervention({ turnCount: 5, message: "redirect", reasoning: "off-topic", timestamp: 123 });
    expect(mgr.getState()?.interventions).toEqual([
      { turnCount: 5, message: "redirect", reasoning: "off-topic", timestamp: 123 },
    ]);
    expect(pi.appendEntry).toHaveBeenCalledTimes(1);
    expect(pi.appendEntry).toHaveBeenCalledWith("supervisor-state", expect.any(Object));
  });

  it("incrementTurnCount mutates in-memory only (not persisted)", () => {
    const pi = makePi();
    const mgr = new SupervisorStateManager(pi);
    mgr.start("x", "anthropic", "m", "medium");
    pi.appendEntry.mockClear();

    mgr.incrementTurnCount();
    mgr.incrementTurnCount();

    expect(mgr.getState()?.turnCount).toBe(2);
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("setModel and setSensitivity persist preferences even without state and sync state when present", () => {
    const pi = makePi();
    const mgr = new SupervisorStateManager(pi);

    mgr.setModel("openai", "gpt-5");
    mgr.setSensitivity("high");
    expect(mgr.getPreferences()).toEqual({
      provider: "openai",
      modelId: "gpt-5",
      sensitivity: "high",
    });
    expect(mgr.getState()).toBeNull();
    expect(pi.appendEntry).toHaveBeenCalledTimes(2);
    expect(pi.appendEntry).toHaveBeenNthCalledWith(1, "supervisor-preferences", expect.objectContaining({
      provider: "openai",
      modelId: "gpt-5",
    }));
    expect(pi.appendEntry).toHaveBeenNthCalledWith(2, "supervisor-preferences", expect.objectContaining({
      sensitivity: "high",
    }));

    mgr.start("x", "anthropic", "claude-haiku-4-5", "low");
    pi.appendEntry.mockClear();

    mgr.setModel("openai", "gpt-5");
    mgr.setSensitivity("high");

    expect(mgr.getState()).toMatchObject({
      provider: "openai",
      modelId: "gpt-5",
      sensitivity: "high",
    });
    expect(mgr.getPreferences()).toEqual({
      provider: "openai",
      modelId: "gpt-5",
      sensitivity: "high",
      sensitivityConfig: undefined,
      checklistEnabled: true,
    });
    expect(pi.appendEntry).toHaveBeenCalledTimes(4);
    expect(pi.appendEntry).toHaveBeenNthCalledWith(1, "supervisor-preferences", expect.objectContaining({
      provider: "openai",
      modelId: "gpt-5",
    }));
    expect(pi.appendEntry).toHaveBeenNthCalledWith(2, "supervisor-state", expect.objectContaining({
      provider: "openai",
      modelId: "gpt-5",
    }));
    expect(pi.appendEntry).toHaveBeenNthCalledWith(3, "supervisor-preferences", expect.objectContaining({
      sensitivity: "high",
    }));
    expect(pi.appendEntry).toHaveBeenNthCalledWith(4, "supervisor-state", expect.objectContaining({
      sensitivity: "high",
    }));
  });

  it("setSensitivity stores custom config in preferences and state", () => {
    const pi = makePi();
    const mgr = new SupervisorStateManager(pi);

    const customConfig = { checkInterval: 5, confidenceThreshold: 0.75, messageLimit: 8 };
    mgr.setSensitivity("custom", customConfig);

    expect(mgr.getPreferences()).toEqual({ sensitivity: "custom", sensitivityConfig: customConfig });
    expect(pi.appendEntry).toHaveBeenCalledTimes(1);

    // Now start supervision and change sensitivity
    mgr.start("goal", "anthropic", "claude-haiku", "medium");
    pi.appendEntry.mockClear();

    mgr.setSensitivity("custom", customConfig);
    expect(mgr.getState()?.sensitivity).toBe("custom");
    expect(mgr.getState()?.sensitivityConfig).toEqual(customConfig);
    expect(mgr.getPreferences().sensitivityConfig).toEqual(customConfig);
  });

  it("setPreferences stores additional defaults like widget visibility, checklist, and debug flags", () => {
    const pi = makePi();
    const mgr = new SupervisorStateManager(pi);

    mgr.setPreferences({ checklistEnabled: false, widgetVisible: false, debugPayloads: true });

    expect(mgr.getPreferences()).toEqual({ checklistEnabled: false, widgetVisible: false, debugPayloads: true });
    expect(pi.appendEntry).toHaveBeenCalledTimes(1);
    expect(pi.appendEntry).toHaveBeenCalledWith("supervisor-preferences", { checklistEnabled: false, widgetVisible: false, debugPayloads: true });
  });

  it("stores completion checklist and marks setup ready", () => {
    const pi = makePi();
    const mgr = new SupervisorStateManager(pi);
    mgr.start("goal", "anthropic", "model", "medium");
    pi.appendEntry.mockClear();

    const items: Array<Pick<CompletionChecklistItem, "id" | "title" | "description" | "verificationPrompt">> = [
      { id: "imports", title: "Verify imports", description: "Public imports must work", verificationPrompt: "Run the import check and fix any missing exports." },
      { id: "cli", title: "Verify CLI", description: "CLI output must match the contract", verificationPrompt: "Run representative CLI checks and fix any drift." },
    ];
    mgr.setCompletionChecklist(items);

    expect(mgr.getState()?.completionChecklist).toEqual({
      status: "ready",
      count: 2,
      source: "bootstrap-llm",
      currentIndex: 0,
      summaryRequested: false,
      items: [
        { ...items[0], status: "pending", attempts: 0 },
        { ...items[1], status: "pending", attempts: 0 },
      ],
    });
  });

  it("can mark checklist setup failed without stopping supervision", () => {
    const pi = makePi();
    const mgr = new SupervisorStateManager(pi);
    mgr.start("goal", "anthropic", "model", "medium");
    pi.appendEntry.mockClear();

    mgr.setChecklistSetup({ status: "failed", count: 0, source: "bootstrap-llm", error: "No checklist generated" });

    expect(mgr.isActive()).toBe(true);
    expect(mgr.getState()?.completionChecklist).toMatchObject({
      status: "failed",
      count: 0,
      source: "bootstrap-llm",
      error: "No checklist generated",
    });
  });

  it("advances checklist items and tracks summary-request state", () => {
    const pi = makePi();
    const mgr = new SupervisorStateManager(pi);
    mgr.start("goal", "anthropic", "model", "medium");
    mgr.setCompletionChecklist([
      { id: "imports", title: "Verify imports", description: "Public imports must work", verificationPrompt: "Check imports." },
      { id: "cli", title: "Verify CLI", description: "CLI output must match the contract", verificationPrompt: "Check CLI." },
    ]);
    pi.appendEntry.mockClear();

    mgr.incrementCurrentChecklistAttempt();
    expect(mgr.getState()?.completionChecklist?.items[0]?.attempts).toBe(1);

    mgr.markCurrentChecklistItemPassed();
    expect(mgr.getState()?.completionChecklist?.currentIndex).toBe(1);
    expect(mgr.getState()?.completionChecklist?.items[0]?.status).toBe("passed");

    mgr.setChecklistSummaryRequested(true);
    expect(mgr.getState()?.completionChecklist?.summaryRequested).toBe(true);
  });

  it("loadFromSession picks the most recent supervisor state and preferences independently", () => {
    const olderState: SupervisorState = {
      active: true, outcome: "old", provider: "anthropic", modelId: "m1",
      sensitivity: "low", interventions: [], startedAt: 1, turnCount: 0,
    };
    const newerState: SupervisorState = {
      active: false, outcome: "new", provider: "openai", modelId: "m2",
      sensitivity: "high", interventions: [], startedAt: 2, turnCount: 9,
    };
    const olderPreferences: SupervisorPreferences = {
      provider: "anthropic",
      modelId: "m1",
      sensitivity: "low",
      widgetVisible: true,
    };
    const newerPreferences: SupervisorPreferences = {
      provider: "openai",
      modelId: "m2",
      sensitivity: "high",
      widgetVisible: false,
    };

    const ctx = makeCtxWithBranch([
      { type: "custom", customType: "supervisor-preferences", data: olderPreferences },
      { type: "custom", customType: "supervisor-state", data: olderState },
      { type: "message", message: { role: "assistant", content: [] } },
      { type: "custom", customType: "supervisor-preferences", data: newerPreferences },
      { type: "custom", customType: "supervisor-state", data: newerState },
      { type: "custom", customType: "other-extension", data: { foo: 1 } },
    ]);

    const mgr = new SupervisorStateManager(makePi());
    mgr.loadFromSession(ctx);

    expect(mgr.getState()).toEqual(newerState);
    expect(mgr.getPreferences()).toEqual(newerPreferences);
    expect(mgr.isActive()).toBe(false);
  });

  it("loadFromSession resets missing state and preferences independently", () => {
    const prefsOnly: SupervisorPreferences = { sensitivity: "medium", checklistEnabled: false, widgetVisible: false };
    const ctx = makeCtxWithBranch([
      { type: "message", message: { role: "user", content: "hi" } },
      { type: "custom", customType: "supervisor-preferences", data: prefsOnly },
    ]);

    const mgr = new SupervisorStateManager(makePi());
    mgr.loadFromSession(ctx);

    expect(mgr.getState()).toBeNull();
    expect(mgr.getPreferences()).toEqual(prefsOnly);
  });

  it("loadFromSession restores custom sensitivity config", () => {
    const customConfig = { checkInterval: 2, confidenceThreshold: 0.8, messageLimit: 10 };
    const customState: SupervisorState = {
      active: true, outcome: "custom goal", provider: "anthropic", modelId: "m1",
      sensitivity: "custom", sensitivityConfig: customConfig,
      interventions: [], startedAt: 1, turnCount: 0,
    };
    const customPrefs: SupervisorPreferences = {
      sensitivity: "custom",
      sensitivityConfig: customConfig,
      checklistEnabled: false,
    };

    const ctx = makeCtxWithBranch([
      { type: "custom", customType: "supervisor-preferences", data: customPrefs },
      { type: "custom", customType: "supervisor-state", data: customState },
    ]);

    const mgr = new SupervisorStateManager(makePi());
    mgr.loadFromSession(ctx);

    expect(mgr.getState()?.sensitivity).toBe("custom");
    expect(mgr.getState()?.sensitivityConfig).toEqual(customConfig);
    expect(mgr.getPreferences().sensitivityConfig).toEqual(customConfig);
  });

  it("can disable the checklist for active and future supervision", () => {
    const pi = makePi();
    const mgr = new SupervisorStateManager(pi);

    mgr.start("goal", "anthropic", "model", "ultralight", undefined, false);
    expect(mgr.getState()?.checklistEnabled).toBe(false);
    expect(mgr.getState()?.completionChecklist).toBeUndefined();
    expect(mgr.getPreferences().checklistEnabled).toBe(false);

    pi.appendEntry.mockClear();
    mgr.setChecklistEnabled(true);

    expect(mgr.getState()?.checklistEnabled).toBe(true);
    expect(mgr.getState()?.completionChecklist).toEqual({
      status: "pending",
      count: 0,
      currentIndex: 0,
      summaryRequested: false,
      items: [],
    });
    expect(mgr.getPreferences().checklistEnabled).toBe(true);
    expect(pi.appendEntry).toHaveBeenCalledTimes(2);
  });

  it("can update the outcome without resetting runtime stats", () => {
    const pi = makePi();
    const mgr = new SupervisorStateManager(pi);

    mgr.start("goal", "anthropic", "model", "medium");
    mgr.incrementTurnCount();
    mgr.incrementTurnCount();
    mgr.addIntervention({ turnCount: 2, message: "stay focused", reasoning: "drift", timestamp: 1 });

    pi.appendEntry.mockClear();
    mgr.setOutcome("new goal");

    expect(mgr.getState()).toMatchObject({
      outcome: "new goal",
      turnCount: 2,
      interventions: [{ turnCount: 2, message: "stay focused", reasoning: "drift", timestamp: 1 }],
    });
    expect(pi.appendEntry).toHaveBeenCalledTimes(1);
  });

  it("can reset runtime stats while preserving a ready checklist", () => {
    const pi = makePi();
    const mgr = new SupervisorStateManager(pi);

    mgr.start("goal", "anthropic", "model", "medium");
    mgr.incrementTurnCount();
    mgr.incrementTurnCount();
    mgr.addIntervention({ turnCount: 2, message: "stay focused", reasoning: "drift", timestamp: 1 });
    mgr.setCompletionChecklist([
      { id: "check-1", title: "Check one", description: "First check", verificationPrompt: "Verify it." },
    ]);
    mgr.incrementCurrentChecklistAttempt();
    mgr.markCurrentChecklistItemPassed();

    pi.appendEntry.mockClear();
    mgr.resetRuntimeStats();

    expect(mgr.getState()).toMatchObject({
      outcome: "goal",
      interventions: [],
      turnCount: 0,
      completionChecklist: {
        status: "ready",
        count: 1,
        currentIndex: 0,
        summaryRequested: false,
        items: [{
          id: "check-1",
          title: "Check one",
          description: "First check",
          verificationPrompt: "Verify it.",
          status: "pending",
          attempts: 0,
        }],
      },
    });
    expect(mgr.getState()?.startedAt).toBeGreaterThan(0);
    expect(pi.appendEntry).toHaveBeenCalledTimes(1);
  });
});