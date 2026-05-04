import { describe, expect, it } from "vitest";
import { parseDecision } from "../src/model-client.js";

describe("parseDecision — happy paths", () => {
  it("parses bare JSON with all four fields", () => {
    const out = parseDecision(
      `{"action":"steer","message":"focus on the migration","reasoning":"agent drifted","confidence":0.9}`,
    );
    expect(out).toEqual({
      action: "steer",
      message: "focus on the migration",
      reasoning: "agent drifted",
      confidence: 0.9,
    });
  });

  it("accepts all three valid action values", () => {
    for (const action of ["continue", "steer", "done"] as const) {
      const out = parseDecision(`{"action":"${action}","reasoning":"ok","confidence":0.5}`);
      expect(out.action).toBe(action);
    }
  });

  it("strips ```json fenced code blocks", () => {
    // Models often wrap responses in fences despite the system prompt asking
    // them not to. The parser MUST tolerate this or every fenced response
    // would fall through to safeContinue and the supervisor would silently
    // never intervene.
    const text = '```json\n{"action":"done","reasoning":"all green","confidence":0.95}\n```';
    expect(parseDecision(text)).toMatchObject({ action: "done", confidence: 0.95 });
  });

  it("strips bare ``` fenced code blocks (no language tag)", () => {
    const text = '```\n{"action":"steer","message":"x","reasoning":"y","confidence":0.7}\n```';
    expect(parseDecision(text)).toMatchObject({ action: "steer", message: "x" });
  });

  it("extracts JSON when the model wraps it in prose", () => {
    const text = 'Here is my decision: {"action":"continue","reasoning":"on track","confidence":0.6} -- end.';
    expect(parseDecision(text)).toMatchObject({ action: "continue", confidence: 0.6 });
  });

  it("trims whitespace around the message field", () => {
    // The supervisor sends `message` directly to the user via
    // pi.sendUserMessage. Leading whitespace shows up as a visible artifact
    // in the chat.
    const out = parseDecision(`{"action":"steer","message":"  do it now  \\n","reasoning":"r","confidence":0.5}`);
    expect(out.message).toBe("do it now");
  });
});

describe("parseDecision — defensive defaults for missing/invalid fields", () => {
  it("defaults confidence to 0.5 when missing", () => {
    expect(parseDecision(`{"action":"continue","reasoning":"ok"}`).confidence).toBe(0.5);
  });

  it("defaults reasoning to '' when missing", () => {
    expect(parseDecision(`{"action":"continue","confidence":0.8}`).reasoning).toBe("");
  });

  it("leaves message as undefined when not a string", () => {
    // Not "" — undefined. The caller distinguishes between "no message"
    // (skip the steer) and "empty message" (would inject a blank user turn).
    expect(parseDecision(`{"action":"steer","message":42,"reasoning":"r","confidence":0.5}`).message)
      .toBeUndefined();
  });

  it("leaves confidence at default when type is wrong (e.g. string)", () => {
    expect(parseDecision(`{"action":"continue","confidence":"high"}`).confidence).toBe(0.5);
  });
});

describe("parseDecision — failure modes return safeContinue (never crash)", () => {
  it("returns continue/0 on malformed JSON", () => {
    // Real-world: model emits truncated output or stray quote. The
    // contract is "the chat is never interrupted", so any parse failure
    // collapses to a no-op continue.
    const out = parseDecision("{not json");
    expect(out).toEqual({
      action: "continue",
      reasoning: "Failed to parse supervisor JSON decision",
      confidence: 0,
    });
  });

  it("returns continue/0 when action is not one of continue|steer|done", () => {
    const out = parseDecision(`{"action":"abort","reasoning":"x","confidence":0.9}`);
    expect(out).toEqual({
      action: "continue",
      reasoning: "Invalid action in supervisor response",
      confidence: 0,
    });
  });

  it("returns continue/0 when action is missing entirely", () => {
    expect(parseDecision(`{"reasoning":"x","confidence":0.9}`).action).toBe("continue");
  });

  it("returns continue/0 on completely empty input", () => {
    expect(parseDecision("").action).toBe("continue");
  });
});
