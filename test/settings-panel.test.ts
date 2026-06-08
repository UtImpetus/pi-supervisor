import { describe, expect, it } from "vitest";
import { hasSettingsDraftChanges } from "../src/ui/settings-panel.js";

describe("hasSettingsDraftChanges", () => {
  it("returns false for an empty draft", () => {
    expect(hasSettingsDraftChanges({})).toBe(false);
  });

  it("treats debugPayloads as a real draft change", () => {
    expect(hasSettingsDraftChanges({ debugPayloads: true })).toBe(true);
    expect(hasSettingsDraftChanges({ debugPayloads: false })).toBe(true);
  });

  it("treats checklistEnabled as a real draft change", () => {
    expect(hasSettingsDraftChanges({ checklistEnabled: true })).toBe(true);
    expect(hasSettingsDraftChanges({ checklistEnabled: false })).toBe(true);
  });

  it("treats enabledPredefinedChecks as a real draft change", () => {
    expect(hasSettingsDraftChanges({ enabledPredefinedChecks: [] })).toBe(true);
    expect(hasSettingsDraftChanges({ enabledPredefinedChecks: ["docs-sync"] })).toBe(true);
  });

  it("treats outcome edits, checklist edits, and stat resets as real draft changes", () => {
    expect(hasSettingsDraftChanges({ outcome: "new goal" })).toBe(true);
    expect(hasSettingsDraftChanges({ checklistItems: [{ id: "check-1", title: "Check", description: "Desc", verificationPrompt: "Verify" }] })).toBe(true);
    expect(hasSettingsDraftChanges({ resetStats: true })).toBe(true);
  });

  it("still detects existing draft fields", () => {
    expect(hasSettingsDraftChanges({ widget: true })).toBe(true);
    expect(hasSettingsDraftChanges({ sensitivity: "high" })).toBe(true);
    expect(hasSettingsDraftChanges({ model: { provider: "anthropic", modelId: "claude" } })).toBe(true);
  });
});
