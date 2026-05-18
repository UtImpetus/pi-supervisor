import { describe, expect, it } from "vitest";
import { parseLegacySuperviseInvocation } from "../src/command-routing.js";

describe("parseLegacySuperviseInvocation", () => {
  it("maps empty input and settings to settings", () => {
    expect(parseLegacySuperviseInvocation("")).toEqual({ type: "settings" });
    expect(parseLegacySuperviseInvocation("settings")).toEqual({ type: "settings" });
  });

  it("parses legacy subcommands with arguments", () => {
    expect(parseLegacySuperviseInvocation("model")).toEqual({ type: "model", spec: "" });
    expect(parseLegacySuperviseInvocation("model anthropic/claude-haiku")).toEqual({
      type: "model",
      spec: "anthropic/claude-haiku",
    });
    expect(parseLegacySuperviseInvocation("debug toggle")).toEqual({ type: "debug", arg: "toggle" });
    expect(parseLegacySuperviseInvocation("sensitivity high")).toEqual({ type: "sensitivity", level: "high" });
  });

  it("parses simple legacy subcommands", () => {
    expect(parseLegacySuperviseInvocation("widget")).toEqual({ type: "widget" });
    expect(parseLegacySuperviseInvocation("stop")).toEqual({ type: "stop" });
    expect(parseLegacySuperviseInvocation("status")).toEqual({ type: "status" });
  });

  it("treats all other input as a start outcome", () => {
    expect(parseLegacySuperviseInvocation("ship the feature")).toEqual({
      type: "start",
      outcome: "ship the feature",
    });
  });
});
