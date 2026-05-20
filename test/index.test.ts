import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import initExtension from "../src/index.js";

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
    sendUserMessage: vi.fn(),
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
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: {
      getLeafId: () => null,
      getLabel: () => undefined,
      getBranch: () => [],
    },
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
    ...overrides,
  } as any;
}

function findLastSupervisorState(pi: any) {
  const matches = pi.appendEntry.mock.calls.filter(([type]: [string]) => type === "supervisor-state");
  return matches.at(-1)?.[1];
}

describe("supervisor extension runtime behavior", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("uses saved sensitivity defaults when start_supervision omits sensitivity", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-supervisor-index-"));
    tempDirs.push(cwd);
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(
      join(cwd, ".pi", "supervisor-config.json"),
      JSON.stringify({ sensitivity: "ultralight", checklistEnabled: false })
    );

    const pi = makePi();
    initExtension(pi);
    const tool = pi.tools.get("start_supervision");

    const ctx = makeCtx(cwd);
    const result = await tool.execute("call-1", { outcome: "ship it" }, undefined, undefined, ctx);
    expect(result.content[0]?.text).toContain("sensitivity: ultralight");
    expect(result.content[0]?.text).toContain("checks: off");
  });

  it("queues a /supervisor outcome update while busy and applies it at the next agent_end", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-supervisor-index-"));
    tempDirs.push(cwd);
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(
      join(cwd, ".pi", "supervisor-config.json"),
      JSON.stringify({ sensitivity: "ultralight", checklistEnabled: false })
    );

    const pi = makePi();
    initExtension(pi);

    const ctx = makeCtx(cwd);
    const sessionStart = pi.events.get("session_start")?.[0];
    await sessionStart?.({ type: "session_start" }, ctx);

    const tool = pi.tools.get("start_supervision");
    await tool.execute("call-1", { outcome: "old goal" }, undefined, undefined, ctx);

    const supervisorCommand = pi.commands.get("supervisor");
    const busyCtx = makeCtx(cwd, {
      isIdle: () => false,
      ui: ctx.ui,
      sessionManager: ctx.sessionManager,
    });

    await supervisorCommand.handler("new goal", busyCtx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("queued"),
      "info",
    );
    expect(findLastSupervisorState(pi)).toMatchObject({
      outcome: "old goal",
      pendingOutcomeUpdate: { outcome: "new goal" },
    });

    const agentEnd = pi.events.get("agent_end")?.[0];
    await agentEnd?.({ type: "agent_end" }, ctx);

    expect(findLastSupervisorState(pi)).toMatchObject({
      outcome: "new goal",
      pendingOutcomeUpdate: undefined,
    });
  });

  it("applies /supervisor outcome updates immediately when idle", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-supervisor-index-"));
    tempDirs.push(cwd);
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(
      join(cwd, ".pi", "supervisor-config.json"),
      JSON.stringify({ sensitivity: "ultralight", checklistEnabled: false })
    );

    const pi = makePi();
    initExtension(pi);

    const ctx = makeCtx(cwd);
    const sessionStart = pi.events.get("session_start")?.[0];
    await sessionStart?.({ type: "session_start" }, ctx);

    const tool = pi.tools.get("start_supervision");
    await tool.execute("call-1", { outcome: "old goal" }, undefined, undefined, ctx);

    const supervisorCommand = pi.commands.get("supervisor");
    await supervisorCommand.handler("updated goal", ctx);

    expect(findLastSupervisorState(pi)).toMatchObject({
      outcome: "updated goal",
      pendingOutcomeUpdate: undefined,
    });
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('Supervisor outcome updated: "updated goal"'),
      "info",
    );
  });
});
