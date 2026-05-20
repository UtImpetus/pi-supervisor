import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import initExtension from "../src/index.js";

function makePi() {
  const tools = new Map<string, any>();

  return {
    tools,
    appendEntry: vi.fn(),
    registerCommand: vi.fn(),
    registerMessageRenderer: vi.fn(),
    on: vi.fn(),
    setLabel: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    registerTool: vi.fn((tool: any) => {
      tools.set(tool.name, tool);
    }),
  } as any;
}

describe("start_supervision tool", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("uses saved sensitivity defaults when sensitivity is omitted", async () => {
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

    const ctx = {
      cwd,
      model: { provider: "openai", id: "gpt-5" },
      sessionManager: {
        getLeafId: () => null,
      },
      ui: {
        notify: vi.fn(),
        setStatus: vi.fn(),
        setWidget: vi.fn(),
      },
    } as any;

    const result = await tool.execute("call-1", { outcome: "ship it" }, undefined, undefined, ctx);
    expect(result.content[0]?.text).toContain('sensitivity: ultralight');
    expect(result.content[0]?.text).toContain('checks: off');
  });
});
