/**
 * pi-supervisor — A pi extension that supervises the chat and steers it toward a defined outcome.
 *
 * Commands:
 *   /supervise <outcome>          — start supervising
 *   /supervise stop               — stop supervision
 *   /supervise status             — show current status widget
 *   /supervise model              — open interactive model picker (pi-style)
 *   /supervise model <p/modelId>  — set model directly (scripting)
 *   /supervise sensitivity <low|medium|high|custom> — adjust steering sensitivity
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { analyze, loadSystemPrompt } from "./engine.js";
import { DEFAULT_MODEL_ID, DEFAULT_PROVIDER, DEFAULT_SENSITIVITY, SupervisorStateManager } from "./state.js";
import type { Sensitivity, SensitivityConfig, SteeringDecision } from "./types.js";
import { resolveSensitivityConfig, SENSITIVITY_PRESETS } from "./types.js";
import { pickModel } from "./ui/model-picker.js";
import { openSettings, type SettingsResult } from "./ui/settings-panel.js";
import { setWidgetVisible, toggleWidget, updateUI } from "./ui/status-widget.js";
import type { WorkspaceSupervisorConfig } from "./workspace-config.js";
import { loadWorkspaceConfig, saveWorkspaceConfig } from "./workspace-config.js";

/**
 * Extract partial reasoning text from the supervisor's streaming JSON response.
 * Works on incomplete JSON while the model is still generating.
 */
function extractThinking(accumulated: string): string {
  // Find the "reasoning" key and capture content after the opening quote
  const keyIdx = accumulated.indexOf('"reasoning"');
  if (keyIdx === -1) return "";
  const after = accumulated.slice(keyIdx + '"reasoning"'.length);
  const openMatch = after.match(/^\s*:\s*"/);
  if (!openMatch) return "";
  const content = after.slice(openMatch[0].length);
  // If the closing quote has arrived, take only what's inside; otherwise take all (streaming)
  const closeIdx = content.search(/(?<!\\)"/);
  const raw = closeIdx === -1 ? content : content.slice(0, closeIdx);
  return raw.replace(/\\n/g, " ").replace(/\\"/g, '"').trim();
}

// After this many consecutive idle-state steers with no "done", run a lenient final evaluation.
const MAX_IDLE_STEERS = 5;

export default function (pi: ExtensionAPI) {
  const state = new SupervisorStateManager(pi);
  let idleSteers = 0; // consecutive agent_end steers; reset on done/stop/new supervision

  const resolveSettingsDefaults = (ctx: ExtensionContext) => {
    const s = state.getState();
    const preferences = state.getPreferences();
    const workspaceConfig = loadWorkspaceConfig(ctx.cwd);
    const sessionModel = ctx.model;
    const sensitivity: Sensitivity = s?.active
      ? s.sensitivity
      : preferences.sensitivity ?? workspaceConfig?.sensitivity ?? DEFAULT_SENSITIVITY;
    const sensitivityConfig: SensitivityConfig | undefined = s?.active
      ? s.sensitivityConfig
      : preferences.sensitivityConfig ?? workspaceConfig?.sensitivityConfig ?? undefined;

    return {
      provider: s?.active
        ? s.provider
        : preferences.provider ?? workspaceConfig?.provider ?? sessionModel?.provider ?? DEFAULT_PROVIDER,
      modelId: s?.active
        ? s.modelId
        : preferences.modelId ?? workspaceConfig?.modelId ?? sessionModel?.id ?? DEFAULT_MODEL_ID,
      sensitivity,
      sensitivityConfig: resolveSensitivityConfig(sensitivity, sensitivityConfig),
      widgetVisible: preferences.widgetVisible ?? workspaceConfig?.widgetVisible ?? true,
    };
  };

  const applySettingsResult = (ctx: ExtensionContext, result: SettingsResult | null) => {
    if (!result) return;

    if (result.model) {
      const { provider, modelId } = result.model;
      state.setModel(provider, modelId);
      const saved = saveWorkspaceConfig(ctx.cwd, { provider, modelId });
      ctx.ui.notify(
        `Supervisor model set to ${provider}/${modelId}${state.isActive() ? "" : " (takes effect on next /supervise)"}` +
          (saved ? " · saved to .pi/" : ""),
        "info"
      );
    }

    if (result.sensitivity) {
      state.setSensitivity(result.sensitivity, result.sensitivityConfig);
      const configPatch: WorkspaceSupervisorConfig = { sensitivity: result.sensitivity };
      if (result.sensitivityConfig) configPatch.sensitivityConfig = result.sensitivityConfig;
      const saved = saveWorkspaceConfig(ctx.cwd, configPatch);
      ctx.ui.notify(
        `Supervisor sensitivity set to "${result.sensitivity}"${state.isActive() ? "" : " (takes effect on next /supervise)"}` +
          (saved ? " · saved to .pi/" : ""),
        "info"
      );
    }

    if (result.widget !== undefined) {
      setWidgetVisible(result.widget);
      state.setPreferences({ widgetVisible: result.widget });
      const saved = saveWorkspaceConfig(ctx.cwd, { widgetVisible: result.widget });
      ctx.ui.notify(
        `Supervisor widget ${result.widget ? "shown" : "hidden"}.` + (saved ? " · saved to .pi/" : ""),
        "info"
      );
    }

    if (result.action === "stop" && state.isActive()) {
      state.stop();
      idleSteers = 0;
      ctx.ui.notify("Supervisor stopped.", "info");
    }

    updateUI(ctx, state.getState());
  };

  // ---- Session lifecycle: restore state ----

  const onSessionLoad = (ctx: ExtensionContext) => {
    state.loadFromSession(ctx);
    setWidgetVisible(resolveSettingsDefaults(ctx).widgetVisible);
    updateUI(ctx, state.getState());
  };

  // session_start now fires for startup/reload/new/resume/fork (consolidated
  // in pi-coding-agent 0.72.x — previously separate session_switch/session_fork
  // events). session_tree remains a separate event for tree-view navigation.
  pi.on("session_start", async (_event, ctx) => onSessionLoad(ctx));
  pi.on("session_tree", async (_event, ctx) => onSessionLoad(ctx));

  // ---- Mid-turn steering: medium, high, and custom sensitivity ----
  // turn_end fires after each LLM sub-turn (tool-call cycle) while the agent is still running.
  // low:    no mid-run checks at all
  // medium: check every 3rd tool cycle (turns 2, 5, 8, …), confidence >= 0.9
  // high:   check every tool cycle from turn 2, confidence >= 0.85
  // custom: uses checkInterval and confidenceThreshold from config

  pi.on("turn_end", async (event, ctx) => {
    if (!state.isActive()) return;
    const s = state.getState()!;

    const config = resolveSensitivityConfig(s.sensitivity, s.sensitivityConfig);
    if (config.checkInterval === 0) return;
    if (event.turnIndex < 2) return;
    if ((event.turnIndex - 2) % config.checkInterval !== 0) return;

    let decision: SteeringDecision;
    try {
      decision = await analyze(ctx, s, false /* agent still working */, false /* can't stagnate mid-turn */);
    } catch {
      return;
    }

    // Apply the configured confidence threshold
    if (decision.action === "steer" && decision.message && decision.confidence >= config.confidenceThreshold) {
      state.addIntervention({
        turnCount: s.turnCount,
        message: decision.message,
        reasoning: decision.reasoning,
        timestamp: Date.now(),
      });
      updateUI(ctx, state.getState(), { type: "steering", message: decision.message });
      pi.sendUserMessage(decision.message, { deliverAs: "steer" });
    }
  });

  // ---- After each agent run: analyze + steer ----
  // agent_end fires once per user prompt, always with the agent idle and waiting for input.
  // This is the critical checkpoint for all sensitivity levels.

  pi.on("agent_end", async (_event, ctx) => {
    if (!state.isActive()) return;

    state.incrementTurnCount();
    const s = state.getState()!;

    // Stagnation: too many steers with no "done" → final lenient evaluation
    const stagnating = idleSteers >= MAX_IDLE_STEERS;

    updateUI(ctx, s, { type: "analyzing", turn: s.turnCount });

    const decision = await analyze(ctx, s, true /* always idle at agent_end */, stagnating, undefined, (accumulated) => {
      const thinking = extractThinking(accumulated);
      updateUI(ctx, state.getState()!, { type: "analyzing", turn: s.turnCount, thinking });
    });

    if (decision.action === "steer" && decision.message) {
      idleSteers++;
      state.addIntervention({
        turnCount: s.turnCount,
        message: decision.message,
        reasoning: decision.reasoning,
        timestamp: Date.now(),
      });
      updateUI(ctx, state.getState(), { type: "steering", message: decision.message });
      pi.sendUserMessage(decision.message);
    } else if (decision.action === "done") {
      idleSteers = 0;
      updateUI(ctx, state.getState(), { type: "done" });
      const suffix = stagnating ? ` (stopped after ${MAX_IDLE_STEERS} steering attempts — goal substantially achieved)` : "";
      ctx.ui.notify(`Supervisor: outcome achieved! "${s.outcome}"${suffix}`, "info");
      state.stop();
      updateUI(ctx, state.getState());
    } else {
      updateUI(ctx, state.getState(), { type: "watching" });
    }
  });

  // ---- /supervise command ----

  pi.registerCommand("supervise", {
    description: "Supervise the chat toward a desired outcome (/supervise <outcome>)",
    handler: async (args, ctx) => {
      const trimmed = args?.trim() ?? "";

      // --- subcommands ---

      if (trimmed === "widget") {
        const visible = toggleWidget();
        state.setPreferences({ widgetVisible: visible });
        const saved = saveWorkspaceConfig(ctx.cwd, { widgetVisible: visible });
        updateUI(ctx, state.getState());
        ctx.ui.notify(`Supervisor widget ${visible ? "shown" : "hidden"}.` + (saved ? " · saved to .pi/" : ""), "info");
        return;
      }

      if (trimmed === "stop") {
        if (!state.isActive()) {
          ctx.ui.notify("Supervisor is not active.", "warning");
          return;
        }
        state.stop();
        idleSteers = 0;
        updateUI(ctx, state.getState());
        ctx.ui.notify("Supervisor stopped.", "info");
        return;
      }

      if (trimmed === "status") {
        const s = state.getState();
        if (!s) {
          ctx.ui.notify("No active supervision. Use /supervise <outcome> to start.", "info");
          return;
        }
        const result = await openSettings(ctx, s, resolveSettingsDefaults(ctx));
        applySettingsResult(ctx, result);
        return;
      }

      if (trimmed === "model" || trimmed.startsWith("model ")) {
        const spec = trimmed.slice(5).trim(); // "" when no args
        const defaults = resolveSettingsDefaults(ctx);

        if (!spec) {
          // No args → open the interactive pi-style model picker
          const picked = await pickModel(ctx, defaults.provider, defaults.modelId);
          if (!picked) return; // user cancelled

          const provider = picked.provider;
          const modelId = picked.id;

          state.setModel(provider, modelId);
          const saved = saveWorkspaceConfig(ctx.cwd, { provider, modelId });
          updateUI(ctx, state.getState());
          ctx.ui.notify(
            `Supervisor model set to ${provider}/${modelId}${state.isActive() ? "" : " (takes effect on next /supervise)"}` +
              (saved ? " · saved to .pi/" : ""),
            "info"
          );
          return;
        }

        // Args provided → direct assignment (for scripting)
        const slashIdx = spec.indexOf("/");
        let provider: string;
        let modelId: string;
        if (slashIdx === -1) {
          provider = defaults.provider;
          modelId = spec;
        } else {
          provider = spec.slice(0, slashIdx);
          modelId = spec.slice(slashIdx + 1);
        }

        state.setModel(provider, modelId);
        const saved = saveWorkspaceConfig(ctx.cwd, { provider, modelId });
        updateUI(ctx, state.getState());
        ctx.ui.notify(
          `Supervisor model set to ${provider}/${modelId}${state.isActive() ? "" : " (takes effect on next /supervise)"}` +
            (saved ? " · saved to .pi/" : ""),
          "info"
        );
        return;
      }

      if (trimmed.startsWith("sensitivity ")) {
        const level = trimmed.slice(12).trim() as Sensitivity;
        if (level !== "low" && level !== "medium" && level !== "high" && level !== "custom") {
          ctx.ui.notify("Usage: /supervise sensitivity <low|medium|high|custom>", "warning");
          return;
        }
        state.setSensitivity(level, level === "custom" ? SENSITIVITY_PRESETS.medium : undefined);
        const saved = saveWorkspaceConfig(ctx.cwd, { sensitivity: level });
        updateUI(ctx, state.getState());
        ctx.ui.notify(
          `Supervisor sensitivity set to "${level}"${state.isActive() ? "" : " (takes effect on next /supervise)"}` +
            (saved ? " · saved to .pi/" : ""),
          "info"
        );
        return;
      }

      // --- interactive settings panel ---

      if (!trimmed || trimmed === "settings") {
        const s = state.getState();
        const result = await openSettings(ctx, s, resolveSettingsDefaults(ctx));
        applySettingsResult(ctx, result);
        return;
      }

      // Resolve settings: session preferences → workspace config → active session model → built-in defaults
      const defaults = resolveSettingsDefaults(ctx);
      let provider = defaults.provider;
      let modelId = defaults.modelId;
      const sensitivity = defaults.sensitivity;

      // Only prompt for a model if none has been configured yet
      const preferences = state.getPreferences();
      const workspaceConfig = loadWorkspaceConfig(ctx.cwd);
      const hasConfiguredModel = Boolean(preferences.provider && preferences.modelId) || Boolean(workspaceConfig?.provider && workspaceConfig?.modelId);
      if (!hasConfiguredModel) {
        const apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
        if (!apiKey) {
          ctx.ui.notify(`No API key for "${provider}/${modelId}" — pick a model with an available key.`, "warning");
          const picked = await pickModel(ctx, provider, modelId);
          if (!picked) return; // user cancelled
          provider = picked.provider;
          modelId = picked.id;
        }
      }

      const sensitivityConfig = resolveSensitivityConfig(sensitivity, defaults.sensitivityConfig);
      state.start(trimmed, provider, modelId, sensitivity, sensitivityConfig);
      idleSteers = 0;
      updateUI(ctx, state.getState());

      const { source } = loadSystemPrompt(ctx.cwd);
      const promptLabel = source === "built-in" ? "built-in prompt" : source.replace(ctx.cwd, ".");
      ctx.ui.notify(
        `Supervisor active: "${trimmed.slice(0, 50)}${trimmed.length > 50 ? "…" : ""}" | ${provider}/${modelId} | ${promptLabel}`,
        "info"
      );
    },
  });

  // ---- Tool: model can initiate supervision but never modify an active session ----

  pi.registerTool({
    name: "start_supervision",
    label: "Start Supervision",
    description:
      "Activate the supervisor to track the conversation toward a specific outcome. " +
      "The supervisor will observe every turn and steer the agent if it drifts. " +
      "Once supervision is active it is locked — only the user can change or stop it.",
    parameters: Type.Object({
      outcome: Type.String({
        description:
          "The desired end-state to supervise toward. Be specific and measurable " +
          "(e.g. 'Implement JWT auth with refresh tokens and full test coverage').",
      }),
      sensitivity: Type.Optional(Type.Union([
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
        Type.Literal("custom"),
      ], {
        description:
          "How aggressively to steer. low = only when seriously off track, " +
          "medium = on mild drift (default), high = proactively + mid-turn checks, " +
          "custom = manually tuned check interval/threshold/window.",
      })),
      sensitivityConfig: Type.Optional(Type.Object({
        checkInterval: Type.Number({ description: "Turns between mid-run checks (0 = off)" }),
        confidenceThreshold: Type.Number({ description: "Min confidence (0-1) to steer mid-run" }),
        messageLimit: Type.Number({ description: "Recent messages for supervisor context" }),
      }, {
        description: "Custom sensitivity parameters (only used when sensitivity=custom)",
      })),
      model: Type.Optional(Type.String({
        description:
          "Supervisor model as 'provider/modelId' (e.g. 'anthropic/claude-haiku-4-5-20251001'). " +
          "Defaults to workspace config, then the active chat model.",
      })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const text = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], details: undefined });

      // Guard: supervision already active — model cannot modify it
      if (state.isActive()) {
        const s = state.getState()!;
        return text(
          `Supervision is already active and cannot be changed by the model.\n` +
          `Active outcome: "${s.outcome}"\n` +
          `Only the user can stop or modify supervision via /supervise.`
        );
      }

      // Resolve sensitivity
      const sensitivity: Sensitivity = params.sensitivity ?? DEFAULT_SENSITIVITY;
      const resolvedConfig = params.sensitivityConfig
        ? { ...params.sensitivityConfig }
        : resolveSensitivityConfig(sensitivity);

      // Resolve model: tool param → saved preferences/workspace config → active session model → built-in default
      let provider: string;
      let modelId: string;
      if (params.model) {
        const slash = params.model.indexOf("/");
        provider = slash === -1 ? DEFAULT_PROVIDER : params.model.slice(0, slash);
        modelId  = slash === -1 ? params.model     : params.model.slice(slash + 1);
      } else {
        const defaults = resolveSettingsDefaults(ctx);
        provider = defaults.provider;
        modelId = defaults.modelId;
      }

      state.start(params.outcome, provider, modelId, sensitivity, resolvedConfig);
      idleSteers = 0;
      updateUI(ctx, state.getState());

      const { source } = loadSystemPrompt(ctx.cwd);
      const promptLabel = source === "built-in" ? "built-in prompt" : ".pi/SUPERVISOR.md";

      // Notify the user so they're aware supervision was initiated by the model
      ctx.ui.notify(
        `Supervisor started by agent: "${params.outcome.slice(0, 60)}${params.outcome.length > 60 ? "…" : ""}" | ${provider}/${modelId} | sensitivity: ${sensitivity} | ${promptLabel}`,
        "info"
      );

      return text(`Supervision active. Outcome: "${params.outcome}" | ${provider}/${modelId} | sensitivity: ${sensitivity}`);
    },
  });
}
