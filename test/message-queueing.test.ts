import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const analyzeMock = vi.fn();
const generateCompletionChecklistMock = vi.fn();
const reviewChecklistItemMock = vi.fn();

vi.mock("../src/engine.js", async () => {
  const actual = await vi.importActual<typeof import("../src/engine.js")>("../src/engine.js");
  return {
    ...actual,
    analyze: analyzeMock,
    generateCompletionChecklist: generateCompletionChecklistMock,
    reviewChecklistItem: reviewChecklistItemMock,
  };
});

function makePi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const events = new Map<string, any[]>();

  return {
    tools,
    commands,
    events,
    appendEntry: vi.fn(),
    registerCommand: vi.fn((name: string, command: any) => {
      commands.set(name, command);
    }),
    registerMessageRenderer: vi.fn(),
    on: vi.fn((eventName: string, handler: any) => {
      const handlers = events.get(eventName) ?? [];
      handlers.push(handler);
      events.set(eventName, handlers);
    }),
    setLabel: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn().mockResolvedValue(undefined),
    registerTool: vi.fn((tool: any) => {
      tools.set(tool.name, tool);
    }),
  } as any;
}

function makeCtx(cwd: string, overrides: Record<string, unknown> = {}) {
  return {
    cwd,
    hasUI: true,
    model: { provider: "openai", id: "gpt-5" },
    isIdle: () => false,
    hasPendingMessages: () => false,
    sessionManager: {
      getLeafId: () => null,
      getLabel: () => undefined,
      getBranch: () => [],
      getSessionDir: () => null,
      getSessionId: () => null,
    },
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
    ...overrides,
  } as any;
}

describe("supervisor message queueing", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    analyzeMock.mockReset();
    generateCompletionChecklistMock.mockReset();
    reviewChecklistItemMock.mockReset();
  });

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("queues agent_end steering as a follow-up message", async () => {
    const { default: initExtension } = await import("../src/index.js");
    const cwd = mkdtempSync(join(tmpdir(), "pi-supervisor-queue-"));
    tempDirs.push(cwd);
    mkdirSync(join(cwd, ".pi"));

    analyzeMock.mockResolvedValue({
      action: "steer",
      message: "Stay focused on the goal.",
      reasoning: "More work is required.",
      confidence: 1,
    });

    const pi = makePi();
    initExtension(pi);

    const ctx = makeCtx(cwd);
    const sessionStart = pi.events.get("session_start")?.[0];
    await sessionStart?.({ type: "session_start" }, ctx);
    const tool = pi.tools.get("start_supervision");
    await tool.execute("call-1", { outcome: "ship it", checklistEnabled: false }, undefined, undefined, ctx);

    const agentEnd = pi.events.get("agent_end")?.[0];
    await agentEnd?.({ type: "agent_end" }, ctx);

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendUserMessage).toHaveBeenCalledWith("Stay focused on the goal.", { deliverAs: "followUp" });
  });

  it("queues checklist steering as a follow-up message", async () => {
    const { default: initExtension } = await import("../src/index.js");
    const cwd = mkdtempSync(join(tmpdir(), "pi-supervisor-queue-"));
    tempDirs.push(cwd);
    mkdirSync(join(cwd, ".pi"));

    analyzeMock.mockResolvedValue({
      action: "done",
      reasoning: "Core task looks complete, run the checklist.",
      confidence: 1,
    });
    generateCompletionChecklistMock.mockResolvedValue([
      {
        id: "check-1",
        title: "Verify output",
        description: "Confirm the final output matches the goal.",
        verificationPrompt: "Show the verification output.",
      },
    ]);
    reviewChecklistItemMock.mockResolvedValue({
      status: "needs_work",
      message: "Show the verification output.",
      reasoning: "Missing evidence for the required verification.",
      confidence: 1,
    });

    const pi = makePi();
    initExtension(pi);

    const ctx = makeCtx(cwd);
    const sessionStart = pi.events.get("session_start")?.[0];
    await sessionStart?.({ type: "session_start" }, ctx);
    const tool = pi.tools.get("start_supervision");
    await tool.execute("call-1", { outcome: "ship it", checklistEnabled: true }, undefined, undefined, ctx);

    pi.sendUserMessage.mockClear();

    const agentEnd = pi.events.get("agent_end")?.[0];
    await agentEnd?.({ type: "agent_end" }, ctx);

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendUserMessage).toHaveBeenCalledWith("Show the verification output.", { deliverAs: "followUp" });
  });
});
