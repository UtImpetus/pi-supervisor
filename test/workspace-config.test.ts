import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadWorkspaceConfig,
  loadWorkspaceModel,
  saveWorkspaceConfig,
  saveWorkspaceModel,
} from "../src/workspace-config.js";

describe("workspace-config", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-supervisor-wsconfig-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  describe("loadWorkspaceConfig", () => {
    it("returns null when .pi/supervisor-config.json does not exist", () => {
      expect(loadWorkspaceConfig(cwd)).toBeNull();
    });

    it("returns parsed config when fields are valid", () => {
      mkdirSync(join(cwd, ".pi"));
      writeFileSync(
        join(cwd, ".pi", "supervisor-config.json"),
        JSON.stringify({
          provider: "anthropic",
          modelId: "claude-haiku-4-5",
          sensitivity: "high",
          checklistEnabled: false,
          widgetVisible: false,
          debugPayloads: true,
        }),
      );

      expect(loadWorkspaceConfig(cwd)).toEqual({
        provider: "anthropic",
        modelId: "claude-haiku-4-5",
        sensitivity: "high",
        checklistEnabled: false,
        widgetVisible: false,
        debugPayloads: true,
      });
    });

    it("loads custom sensitivity with config", () => {
      mkdirSync(join(cwd, ".pi"));
      writeFileSync(
        join(cwd, ".pi", "supervisor-config.json"),
        JSON.stringify({
          sensitivity: "custom",
          sensitivityConfig: { checkInterval: 2, confidenceThreshold: 0.8, messageLimit: 10 },
        }),
      );

      expect(loadWorkspaceConfig(cwd)).toEqual({
        sensitivity: "custom",
        sensitivityConfig: { checkInterval: 2, confidenceThreshold: 0.8, messageLimit: 10 },
      });
    });

    it("drops invalid fields instead of crashing", () => {
      mkdirSync(join(cwd, ".pi"));
      writeFileSync(
        join(cwd, ".pi", "supervisor-config.json"),
        JSON.stringify({
          provider: "anthropic",
          modelId: 42,
          sensitivity: "extreme",
          widgetVisible: "sometimes",
        }),
      );

      expect(loadWorkspaceConfig(cwd)).toBeNull();
    });

    it("returns null on malformed JSON", () => {
      mkdirSync(join(cwd, ".pi"));
      writeFileSync(join(cwd, ".pi", "supervisor-config.json"), "{ not json");
      expect(loadWorkspaceConfig(cwd)).toBeNull();
    });

    it("loads enabledPredefinedChecks when valid", () => {
      mkdirSync(join(cwd, ".pi"));
      writeFileSync(
        join(cwd, ".pi", "supervisor-config.json"),
        JSON.stringify({
          sensitivity: "medium",
          enabledPredefinedChecks: ["docs-sync", "critical-review"],
        }),
      );

      expect(loadWorkspaceConfig(cwd)).toEqual({
        sensitivity: "medium",
        enabledPredefinedChecks: ["docs-sync", "critical-review"],
      });
    });

    it("filters invalid predefined check IDs", () => {
      mkdirSync(join(cwd, ".pi"));
      writeFileSync(
        join(cwd, ".pi", "supervisor-config.json"),
        JSON.stringify({
          enabledPredefinedChecks: ["docs-sync", "invalid", "code-smells", 42],
        }),
      );

      expect(loadWorkspaceConfig(cwd)).toEqual({
        enabledPredefinedChecks: ["docs-sync", "code-smells"],
      });
    });

    it("drops enabledPredefinedChecks when empty array", () => {
      mkdirSync(join(cwd, ".pi"));
      writeFileSync(
        join(cwd, ".pi", "supervisor-config.json"),
        JSON.stringify({
          sensitivity: "medium",
          enabledPredefinedChecks: [],
        }),
      );

      expect(loadWorkspaceConfig(cwd)).toEqual({
        sensitivity: "medium",
      });
    });
  });

  describe("loadWorkspaceModel", () => {
    it("returns only the model fields when present", () => {
      mkdirSync(join(cwd, ".pi"));
      writeFileSync(
        join(cwd, ".pi", "supervisor-config.json"),
        JSON.stringify({ provider: "openai", modelId: "gpt-5", sensitivity: "low" }),
      );

      expect(loadWorkspaceModel(cwd)).toEqual({ provider: "openai", modelId: "gpt-5" });
    });
  });

  describe("saveWorkspaceConfig", () => {
    it("returns false and does not create the file when .pi/ is missing", () => {
      expect(saveWorkspaceConfig(cwd, { provider: "anthropic", modelId: "claude-haiku-4-5" })).toBe(false);
      expect(existsSync(join(cwd, ".pi", "supervisor-config.json"))).toBe(false);
    });

    it("writes partial config when .pi/ exists", () => {
      mkdirSync(join(cwd, ".pi"));
      expect(saveWorkspaceConfig(cwd, { sensitivity: "medium", checklistEnabled: false, widgetVisible: false, debugPayloads: true })).toBe(true);

      const written = readFileSync(join(cwd, ".pi", "supervisor-config.json"), "utf-8");
      expect(JSON.parse(written)).toEqual({ sensitivity: "medium", checklistEnabled: false, widgetVisible: false, debugPayloads: true });
      expect(loadWorkspaceConfig(cwd)).toEqual({ sensitivity: "medium", checklistEnabled: false, widgetVisible: false, debugPayloads: true });
    });

    it("saves custom sensitivity config", () => {
      mkdirSync(join(cwd, ".pi"));
      const config = {
        sensitivity: "custom" as const,
        sensitivityConfig: { checkInterval: 2, confidenceThreshold: 0.8, messageLimit: 10 },
      };
      expect(saveWorkspaceConfig(cwd, config)).toBe(true);

      expect(loadWorkspaceConfig(cwd)).toEqual({
        sensitivity: "custom",
        sensitivityConfig: { checkInterval: 2, confidenceThreshold: 0.8, messageLimit: 10 },
      });
    });

    it("drops sensitivityConfig when sensitivity is not custom", () => {
      mkdirSync(join(cwd, ".pi"));
      const config = {
        sensitivity: "medium" as const,
        sensitivityConfig: { checkInterval: 3, confidenceThreshold: 0.9, messageLimit: 12 },
      };
      expect(saveWorkspaceConfig(cwd, config)).toBe(true);

      // sensitivityConfig should be stripped when sensitivity is medium
      expect(loadWorkspaceConfig(cwd)).toEqual({
        sensitivity: "medium",
      });
    });

    it("merges patches without losing other saved fields", () => {
      mkdirSync(join(cwd, ".pi"));
      expect(saveWorkspaceConfig(cwd, { provider: "openai", modelId: "gpt-5" })).toBe(true);
      expect(saveWorkspaceConfig(cwd, { sensitivity: "ultralight", checklistEnabled: false, widgetVisible: true, debugPayloads: true })).toBe(true);

      expect(loadWorkspaceConfig(cwd)).toEqual({
        provider: "openai",
        modelId: "gpt-5",
        sensitivity: "ultralight",
        checklistEnabled: false,
        widgetVisible: true,
        debugPayloads: true,
      });
    });

    it("saves enabledPredefinedChecks and filters empties", () => {
      mkdirSync(join(cwd, ".pi"));
      expect(saveWorkspaceConfig(cwd, { enabledPredefinedChecks: ["docs-sync", "code-smells"] })).toBe(true);

      const written = readFileSync(join(cwd, ".pi", "supervisor-config.json"), "utf-8");
      expect(JSON.parse(written)).toEqual({ enabledPredefinedChecks: ["docs-sync", "code-smells"] });

      // Empty array should be stripped
      expect(saveWorkspaceConfig(cwd, { enabledPredefinedChecks: [] })).toBe(true);
      const written2 = readFileSync(join(cwd, ".pi", "supervisor-config.json"), "utf-8");
      expect(JSON.parse(written2)).toEqual({});
    });

    it("strips enabledPredefinedChecks with invalid entries", () => {
      mkdirSync(join(cwd, ".pi"));
      writeFileSync(
        join(cwd, ".pi", "supervisor-config.json"),
        JSON.stringify({ enabledPredefinedChecks: ["docs-sync"] }),
      );

      expect(saveWorkspaceConfig(cwd, { enabledPredefinedChecks: ["bad-id"] })).toBe(true);
      const written = readFileSync(join(cwd, ".pi", "supervisor-config.json"), "utf-8");
      expect(JSON.parse(written)).toEqual({});
    });
  });

  describe("saveWorkspaceModel", () => {
    it("preserves non-model fields while updating the model", () => {
      mkdirSync(join(cwd, ".pi"));
      writeFileSync(
        join(cwd, ".pi", "supervisor-config.json"),
        JSON.stringify({ sensitivity: "low", checklistEnabled: true, widgetVisible: false }),
      );

      expect(saveWorkspaceModel(cwd, "anthropic", "claude-haiku-4-5")).toBe(true);
      expect(loadWorkspaceConfig(cwd)).toEqual({
        provider: "anthropic",
        modelId: "claude-haiku-4-5",
        sensitivity: "low",
        checklistEnabled: true,
        widgetVisible: false,
      });
    });
  });
});