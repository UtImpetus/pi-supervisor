import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createAgentSessionMock, reloadMock } = vi.hoisted(() => ({
  createAgentSessionMock: vi.fn(),
  reloadMock: vi.fn(),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  createAgentSession: createAgentSessionMock,
  DefaultResourceLoader: class {
    constructor(_opts: any) {}
    reload = reloadMock;
  },
  getAgentDir: () => "/mock-agent-dir",
  SessionManager: {
    inMemory: () => ({ kind: "in-memory" }),
  },
}));

import { callSupervisorModel, parseDecision } from "../src/model-client.js";

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

function makeCtx() {
  return {
    cwd: "/repo",
    modelRegistry: {
      find: vi.fn(() => ({ provider: "anthropic", id: "claude-haiku-4-5" })),
    },
  } as any;
}

function makeSession(options: { deltas?: string[]; promptError?: Error } = {}) {
  const unsubscribe = vi.fn();
  return {
    abort: vi.fn(),
    dispose: vi.fn(),
    subscribe: vi.fn((callback: (event: any) => void) => {
      for (const delta of options.deltas ?? []) {
        callback({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta },
        });
      }
      return unsubscribe;
    }),
    prompt: options.promptError
      ? vi.fn(async () => { throw options.promptError; })
      : vi.fn(async () => undefined),
    unsubscribe,
  };
}

describe("callSupervisorModel — retries transient model call failures safely", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    reloadMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries once when session creation fails transiently", async () => {
    vi.useFakeTimers();
    const session = makeSession({
      deltas: [`{"action":"continue","reasoning":"ok","confidence":0.8}`],
    });

    createAgentSessionMock
      .mockRejectedValueOnce(new Error("temporary provider failure"))
      .mockResolvedValueOnce({ session });

    const promise = callSupervisorModel(makeCtx(), "anthropic", "claude-haiku-4-5", "system", "user");
    await vi.runAllTimersAsync();
    const out = await promise;

    expect(out).toMatchObject({ action: "continue", reasoning: "ok", confidence: 0.8 });
    expect(reloadMock).toHaveBeenCalledTimes(1);
    expect(createAgentSessionMock).toHaveBeenCalledTimes(2);
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(session.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("retries once when the prompt call fails and cleans up both attempts", async () => {
    vi.useFakeTimers();
    const failedSession = makeSession({ promptError: new Error("rate limited") });
    const successfulSession = makeSession({
      deltas: [`{"action":"done","reasoning":"recovered","confidence":0.9}`],
    });

    createAgentSessionMock
      .mockResolvedValueOnce({ session: failedSession })
      .mockResolvedValueOnce({ session: successfulSession });

    const promise = callSupervisorModel(makeCtx(), "anthropic", "claude-haiku-4-5", "system", "user");
    await vi.runAllTimersAsync();
    const out = await promise;

    expect(out).toMatchObject({ action: "done", reasoning: "recovered", confidence: 0.9 });
    expect(createAgentSessionMock).toHaveBeenCalledTimes(2);
    expect(failedSession.dispose).toHaveBeenCalledTimes(1);
    expect(failedSession.unsubscribe).toHaveBeenCalledTimes(1);
    expect(successfulSession.dispose).toHaveBeenCalledTimes(1);
    expect(successfulSession.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("does not retry after abort", async () => {
    const controller = new AbortController();
    const abortedSession = makeSession();
    abortedSession.prompt = vi.fn(async () => {
      controller.abort();
      throw new Error("aborted");
    });

    createAgentSessionMock.mockResolvedValueOnce({ session: abortedSession });

    const out = await callSupervisorModel(
      makeCtx(),
      "anthropic",
      "claude-haiku-4-5",
      "system",
      "user",
      controller.signal,
    );

    expect(out).toEqual({
      action: "continue",
      reasoning: "Model call failed",
      confidence: 0,
    });
    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
    expect(abortedSession.abort).toHaveBeenCalledTimes(1);
    expect(abortedSession.dispose).toHaveBeenCalledTimes(1);
    expect(abortedSession.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
