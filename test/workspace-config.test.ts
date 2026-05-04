import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadWorkspaceModel, saveWorkspaceModel } from "../src/workspace-config.js";

describe("workspace-config", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-supervisor-wsconfig-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  describe("loadWorkspaceModel", () => {
    it("returns null when .pi/supervisor-config.json does not exist", () => {
      expect(loadWorkspaceModel(cwd)).toBeNull();
    });

    it("returns parsed config when both fields are strings", () => {
      mkdirSync(join(cwd, ".pi"));
      writeFileSync(
        join(cwd, ".pi", "supervisor-config.json"),
        JSON.stringify({ provider: "anthropic", modelId: "claude-haiku-4-5" }),
      );
      expect(loadWorkspaceModel(cwd)).toEqual({
        provider: "anthropic",
        modelId: "claude-haiku-4-5",
      });
    });

    it("returns null when fields are not strings (drops garbage rather than crashing)", () => {
      mkdirSync(join(cwd, ".pi"));
      writeFileSync(
        join(cwd, ".pi", "supervisor-config.json"),
        JSON.stringify({ provider: 42, modelId: "x" }),
      );
      expect(loadWorkspaceModel(cwd)).toBeNull();
    });

    it("returns null on malformed JSON", () => {
      mkdirSync(join(cwd, ".pi"));
      writeFileSync(join(cwd, ".pi", "supervisor-config.json"), "{ not json");
      expect(loadWorkspaceModel(cwd)).toBeNull();
    });
  });

  describe("saveWorkspaceModel", () => {
    it("returns false and does not create the file when .pi/ is missing", () => {
      // Skipping is intentional: pi-supervisor only writes config when the
      // workspace is already pi-managed (has a .pi/ dir). Auto-creating it
      // would litter unrelated repos.
      expect(saveWorkspaceModel(cwd, "anthropic", "claude-haiku-4-5")).toBe(false);
      expect(existsSync(join(cwd, ".pi", "supervisor-config.json"))).toBe(false);
    });

    it("writes the config when .pi/ exists and round-trips through loadWorkspaceModel", () => {
      mkdirSync(join(cwd, ".pi"));
      expect(saveWorkspaceModel(cwd, "openai", "gpt-5")).toBe(true);

      const written = readFileSync(join(cwd, ".pi", "supervisor-config.json"), "utf-8");
      expect(JSON.parse(written)).toEqual({ provider: "openai", modelId: "gpt-5" });
      expect(loadWorkspaceModel(cwd)).toEqual({ provider: "openai", modelId: "gpt-5" });
    });

  });
});
