import { describe, expect, it } from "vitest";
import { formatSupervisorCheckpointLabel, mergeSupervisorTreeLabel } from "../src/labels.js";

describe("formatSupervisorCheckpointLabel", () => {
  it("formats concise checkpoint tags", () => {
    expect(formatSupervisorCheckpointLabel("start")).toBe("sup:start");
    expect(formatSupervisorCheckpointLabel("steer", 3)).toBe("sup:steer#3");
    expect(formatSupervisorCheckpointLabel("done", 5)).toBe("sup:done#5");
  });

  it("clamps missing or invalid ordinals to 1", () => {
    expect(formatSupervisorCheckpointLabel("steer")).toBe("sup:steer#1");
    expect(formatSupervisorCheckpointLabel("done", 0)).toBe("sup:done#1");
  });
});

describe("mergeSupervisorTreeLabel", () => {
  it("creates a pure supervisor label when none exists", () => {
    expect(mergeSupervisorTreeLabel(undefined, "sup:start")).toBe("[sup:start]");
  });

  it("preserves existing user labels and appends the supervisor tag", () => {
    expect(mergeSupervisorTreeLabel("checkpoint-before-refactor", "sup:steer#2")).toBe(
      "checkpoint-before-refactor [sup:steer#2]",
    );
  });

  it("replaces an older supervisor suffix instead of stacking duplicates", () => {
    expect(mergeSupervisorTreeLabel("checkpoint [sup:start]", "sup:done#4")).toBe(
      "checkpoint [sup:done#4]",
    );
  });

  it("strips multiple stale supervisor tags before appending the latest one", () => {
    expect(mergeSupervisorTreeLabel("checkpoint [sup:start] [sup:steer#1]", "sup:steer#2")).toBe(
      "checkpoint [sup:steer#2]",
    );
  });
});
