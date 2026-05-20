/**
 * pi-supervisor — A pi extension that supervises the chat and steers it toward a defined outcome.
 *
 * Commands:
 *   /supervise <outcome>              — start supervising
 *   /supervise                        — open supervisor settings
 *   /supervise:settings               — open supervisor settings
 *   /supervise:status                 — show active supervisor status/settings
 *   /supervise:stop                   — stop supervision
 *   /supervise:model [p/modelId]      — pick or set the supervisor model
 *   /supervise:sensitivity <preset>   — adjust steering sensitivity
 *   /supervise:widget                 — toggle widget visibility
 *   /supervise:debug [status|on|off|toggle] — manage payload debug logging
 *   /supervise:lesson-learned [optional guidance] — derive project-specific supervisor lessons from the current branch session and preview a .pi/SUPERVISOR.md proposal
 *
 * Legacy compatibility forms like `/supervise stop` and `/supervise model ...`
 * are still supported.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { parseLegacySuperviseInvocation } from "./command-routing.js";
import { getSupervisorPayloadLogPath, type SupervisorPayloadDebugOptions } from "./debug.js";
import { analyze, buildSnapshot, generateCompletionChecklist, loadBuiltinSystemPrompt, loadSystemPrompt, reviewChecklistItem } from "./engine.js";
import {
  buildEvidenceNote,
  findLastEvidenceNoteContent,
  getEvidenceEntryType,
  getEvidenceMessageType,
  SupervisorEvidenceTracker,
  summarizeEvidenceForPrompt,
} from "./evidence.js";
import { formatSupervisorCheckpointLabel, mergeSupervisorTreeLabel } from "./labels.js";
import {
  generateSupervisorLessonsProposal,
  getProjectSupervisorPromptPath,
  loadExistingProjectSupervisorPrompt,
  normalizeLessonProposalText,
  persistProjectSupervisorPrompt,
} from "./lesson-learned.js";
import { DEFAULT_MODEL_ID, DEFAULT_PROVIDER, DEFAULT_SENSITIVITY, SupervisorStateManager } from "./state.js";
import { deriveArtifactSearchTerms, SessionToolArtifactStore } from "./tool-artifacts.js";
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
  const evidence = new SupervisorEvidenceTracker();
  const toolArtifacts = new SessionToolArtifactStore();
  let idleSteers = 0; // consecutive agent_end steers; reset on done/stop/new supervision
  let lastEvidenceNoteContent: string | null = null;

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
    const checklistEnabled = s?.active
      ? s.checklistEnabled !== false
      : preferences.checklistEnabled ?? workspaceConfig?.checklistEnabled ?? true;

    return {
      provider: s?.active
        ? s.provider
        : preferences.provider ?? workspaceConfig?.provider ?? sessionModel?.provider ?? DEFAULT_PROVIDER,
      modelId: s?.active
        ? s.modelId
        : preferences.modelId ?? workspaceConfig?.modelId ?? sessionModel?.id ?? DEFAULT_MODEL_ID,
      sensitivity,
      sensitivityConfig: resolveSensitivityConfig(sensitivity, sensitivityConfig),
      checklistEnabled,
      widgetVisible: preferences.widgetVisible ?? workspaceConfig?.widgetVisible ?? true,
      debugPayloads: preferences.debugPayloads ?? workspaceConfig?.debugPayloads ?? false,
    };
  };

  const getDebugOptions = (ctx: ExtensionContext): SupervisorPayloadDebugOptions | undefined => {
    const defaults = resolveSettingsDefaults(ctx);
    if (!defaults.debugPayloads) return undefined;
    return { enabled: true, logPath: getSupervisorPayloadLogPath(ctx.cwd) };
  };

  const notifyDebugStatus = (ctx: ExtensionContext, enabled: boolean, saved: boolean) => {
    const logPath = getSupervisorPayloadLogPath(ctx.cwd);
    ctx.ui.notify(
      `Supervisor payload debug logging ${enabled ? "enabled" : "disabled"}: ${logPath}` + (saved ? " · saved to .pi/" : ""),
      "info"
    );
  };

  const persistEvidenceSnapshot = () => {
    if (!state.isActive()) return;
    const snapshot = evidence.createSnapshot();
    if (snapshot.items.length === 0) return;
    pi.appendEntry(getEvidenceEntryType(), snapshot);
  };

  const resetRunEvidence = () => {
    evidence.reset();
    toolArtifacts.reset();
    lastEvidenceNoteContent = null;
  };

  const stopSupervision = () => {
    state.stop();
    idleSteers = 0;
    resetRunEvidence();
  };

  const labelCurrentLeaf = (ctx: ExtensionContext, tag: string) => {
    const leafId = ctx.sessionManager.getLeafId();
    if (!leafId) return;
    const existing = ctx.sessionManager.getLabel(leafId);
    pi.setLabel(leafId, mergeSupervisorTreeLabel(existing, tag));
  };

  const emitEvidenceNote = (
    note: ReturnType<typeof buildEvidenceNote>,
  ) => {
    if (!note) return;
    if (note.content === lastEvidenceNoteContent) return;
    lastEvidenceNoteContent = note.content;

    pi.sendMessage({
      customType: getEvidenceMessageType(),
      content: note.content,
      display: true,
      details: note.details,
    });
  };

  const restartActiveSupervision = async (ctx: ExtensionContext, outcome?: string): Promise<string> => {
    const activeState = state.getState();
    if (!activeState?.active) return "";

    state.restartRuntime(outcome);
    idleSteers = 0;
    resetRunEvidence();
    labelCurrentLeaf(ctx, formatSupervisorCheckpointLabel("start"));

    const restartedState = state.getState();
    if (!restartedState?.active) return "";
    return await bootstrapCompletionChecklist(ctx, restartedState.provider, restartedState.modelId, restartedState.outcome);
  };

  const applySettingsResult = async (ctx: ExtensionContext, result: SettingsResult | null) => {
    if (!result) return;

    const willRestartRuntime = Boolean(result.outcome !== undefined || result.resetStats);

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

    if (result.checklistEnabled !== undefined) {
      state.setChecklistEnabled(result.checklistEnabled);
      const saved = saveWorkspaceConfig(ctx.cwd, { checklistEnabled: result.checklistEnabled });
      if (result.checklistEnabled && state.isActive() && !willRestartRuntime) {
        const activeState = state.getState();
        if (activeState) {
          await bootstrapCompletionChecklist(ctx, activeState.provider, activeState.modelId, activeState.outcome);
        }
      }
      ctx.ui.notify(
        `Supervisor completion checklist ${result.checklistEnabled ? "enabled" : "disabled"}${state.isActive() ? "" : " (takes effect on next /supervise)"}` +
          (saved ? " · saved to .pi/" : ""),
        "info"
      );
    }

    if ((result.outcome !== undefined || result.resetStats) && state.isActive()) {
      const nextOutcome = result.outcome?.trim();
      const checkLabel = await restartActiveSupervision(ctx, nextOutcome && nextOutcome.length > 0 ? nextOutcome : undefined);
      if (nextOutcome && nextOutcome.length > 0) {
        ctx.ui.notify(
          `Supervisor outcome updated: "${nextOutcome.slice(0, 60)}${nextOutcome.length > 60 ? "…" : ""}"${checkLabel}`,
          "info"
        );
      } else if (result.resetStats) {
        ctx.ui.notify(`Supervisor runtime stats reset.${checkLabel}`, "info");
      }
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

    if (result.debugPayloads !== undefined) {
      state.setPreferences({ debugPayloads: result.debugPayloads });
      const saved = saveWorkspaceConfig(ctx.cwd, { debugPayloads: result.debugPayloads });
      notifyDebugStatus(ctx, result.debugPayloads, saved);
    }

    if (result.action === "stop" && state.isActive()) {
      stopSupervision();
      ctx.ui.notify("Supervisor stopped.", "info");
    }

    updateUI(ctx, state.getState());
  };

  pi.registerMessageRenderer(getEvidenceMessageType(), (message, { expanded }, theme) => {
    const details = (message.details ?? {}) as { warnings?: string[]; evidence?: string[]; agentIsIdle?: boolean };
    const warnings = Array.isArray(details.warnings) ? details.warnings : [];
    const evidenceLines = Array.isArray(details.evidence) ? details.evidence : [];

    let text = `${theme.fg("warning", "[SUPERVISOR EVIDENCE]")} ${message.content}`;
    if (expanded && warnings.length > 0) {
      text += `\n${theme.fg("dim", "Warnings:")}`;
      for (const warning of warnings) text += `\n${theme.fg("warning", `- ${warning}`)}`;
    }
    if (expanded && evidenceLines.length > 0) {
      text += `\n${theme.fg("dim", "Recent evidence:")}`;
      for (const line of evidenceLines) text += `\n${theme.fg("muted", `- ${line}`)}`;
    }
    if (expanded) {
      text += `\n${theme.fg("dim", `Context: ${details.agentIsIdle ? "idle check" : "mid-turn check"}`)}`;
    }

    const box = new Box(1, 1, (s) => theme.bg("customMessageBg", s));
    box.addChild(new Text(text, 0, 0));
    return box;
  });

  // ---- Session lifecycle: restore state ----

  const onSessionLoad = (ctx: ExtensionContext) => {
    state.loadFromSession(ctx);
    idleSteers = 0;

    const activeState = state.getState();
    if (activeState?.active) {
      evidence.hydrateFromSession(ctx, activeState.startedAt);
      toolArtifacts.hydrate(ctx);
      lastEvidenceNoteContent = findLastEvidenceNoteContent(ctx.sessionManager.getBranch(), activeState.startedAt);
    } else {
      resetRunEvidence();
    }

    setWidgetVisible(resolveSettingsDefaults(ctx).widgetVisible);
    updateUI(ctx, state.getState());
  };

  // session_start now fires for startup/reload/new/resume/fork (consolidated
  // in pi-coding-agent 0.72.x — previously separate session_switch/session_fork
  // events). session_tree remains a separate event for tree-view navigation.
  pi.on("session_start", async (_event, ctx) => onSessionLoad(ctx));
  pi.on("session_tree", async (_event, ctx) => onSessionLoad(ctx));

  pi.on("tool_result", async (event, ctx) => {
    if (!state.isActive()) return;
    evidence.recordToolResult(event);
    toolArtifacts.recordToolResult(ctx, event);
  });

  pi.on("session_compact", async () => {
    persistEvidenceSnapshot();
  });

  // ---- Mid-turn steering: ultralight, low, medium, high, and custom sensitivity ----
  // turn_end fires after each LLM sub-turn (tool-call cycle) while the agent is still running.
  // ultralight/low: no mid-run checks at all
  // medium:         check every 3rd tool cycle (turns 2, 5, 8, …), confidence >= 0.9
  // high:           check every tool cycle from turn 2, confidence >= 0.85
  // custom:         uses checkInterval and confidenceThreshold from config

  pi.on("turn_end", async (event, ctx) => {
    if (!state.isActive()) return;
    const s = state.getState()!;

    const config = resolveSensitivityConfig(s.sensitivity, s.sensitivityConfig);
    if (config.checkInterval === 0) return;
    if (event.turnIndex < 2) return;
    if ((event.turnIndex - 2) % config.checkInterval !== 0) return;

    let decision: SteeringDecision;
    try {
      decision = await analyze(
        ctx,
        s,
        false /* agent still working */,
        false /* can't stagnate mid-turn */,
        false /* no lenient completion mode mid-turn */,
        undefined,
        undefined,
        evidence.getRecent(),
        toolArtifacts.getRecentExcerpts(ctx, 2),
        getDebugOptions(ctx),
      );
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
      labelCurrentLeaf(ctx, formatSupervisorCheckpointLabel("steer", state.getState()?.interventions.length));
      updateUI(ctx, state.getState(), { type: "steering", message: decision.message });
      pi.sendUserMessage(decision.message, { deliverAs: "steer" });
    }
  });

  const runChecklistGate = async (ctx: ExtensionContext, s: NonNullable<ReturnType<typeof state.getState>>): Promise<"steer" | "summary" | "complete" | "skip"> => {
    if (s.checklistEnabled === false) return "skip";

    const checklist = state.getState()?.completionChecklist;
    if (!checklist || checklist.status !== "ready") return "skip";

    if (checklist.currentIndex >= checklist.items.length) {
      if (!checklist.summaryRequested) {
        state.setChecklistSummaryRequested(true);
        const message = "Completion checklist passed. Give a concise final summary of what was implemented and the validation evidence before we finish.";
        sendChecklistMessage(ctx, state.getState()!, message, "Checklist complete; request final summary.");
        return "summary";
      }
      return "complete";
    }

    const item = getCurrentChecklistItem();
    if (!item) return "skip";

    const snapshot = buildSnapshot(ctx, resolveSensitivityConfig(s.sensitivity, s.sensitivityConfig).messageLimit);
    const evidenceSummary = summarizeEvidenceForPrompt(s.outcome, snapshot, evidence.getRecent(), true);
    const artifactTerms = deriveArtifactSearchTerms(s.outcome, item.title, item.description, item.verificationPrompt, evidenceSummary.warnings.join("\n"));
    const rawArtifactExcerpts = toolArtifacts.searchExcerpts(ctx, { terms: artifactTerms, maxResults: 4 });
    const review = await reviewChecklistItem(
      ctx,
      s.provider,
      s.modelId,
      s.outcome,
      item,
      snapshot,
      evidenceSummary.lines,
      evidenceSummary.warnings,
      rawArtifactExcerpts,
      getDebugOptions(ctx),
    );

    if (review.status === "passed") {
      state.markCurrentChecklistItemPassed();
      const nextItem = getCurrentChecklistItem();
      if (!nextItem) {
        const updated = state.getState()!;
        if (!updated.completionChecklist?.summaryRequested) {
          state.setChecklistSummaryRequested(true);
          const message = "Completion checklist passed. Give a concise final summary of what was implemented and the validation evidence before we finish.";
          sendChecklistMessage(ctx, state.getState()!, message, "Checklist complete; request final summary.");
          return "summary";
        }
        return "complete";
      }

      const message = `Checklist check (${nextItem.title}): ${nextItem.verificationPrompt}`;
      sendChecklistMessage(ctx, state.getState()!, message, `Checklist item passed; moving to next check. ${review.reasoning}`.trim());
      return "steer";
    }

    state.incrementCurrentChecklistAttempt();
    const message = review.message?.trim() || `Checklist check (${item.title}): ${item.verificationPrompt}`;
    sendChecklistMessage(ctx, state.getState()!, message, review.reasoning || `Checklist item requires more verification: ${item.title}`);
    return "steer";
  };

  // ---- After each agent run: analyze + steer ----
  // agent_end fires once per user prompt, always with the agent idle and waiting for input.
  // This is the critical checkpoint for all sensitivity levels.

  pi.on("agent_end", async (_event, ctx) => {
    if (!state.isActive()) return;

    state.incrementTurnCount();
    const s = state.getState()!;
    const resolvedSensitivity = resolveSensitivityConfig(s.sensitivity, s.sensitivityConfig);

    // Stagnation: too many steers with no "done" → final lenient evaluation.
    // Ultralight always uses a more lenient end-of-run standard than low.
    const stagnating = idleSteers >= MAX_IDLE_STEERS;
    const lenientCompletionMode = stagnating || s.sensitivity === "ultralight";

    updateUI(ctx, s, { type: "analyzing", turn: s.turnCount });

    const decision = await analyze(
      ctx,
      s,
      true /* always idle at agent_end */,
      stagnating,
      lenientCompletionMode,
      undefined,
      (accumulated) => {
        const thinking = extractThinking(accumulated);
        updateUI(ctx, state.getState()!, { type: "analyzing", turn: s.turnCount, thinking });
      },
      evidence.getRecent(),
      toolArtifacts.getRecentExcerpts(ctx, 4),
      getDebugOptions(ctx),
    );

    if (decision.action === "steer" && decision.message) {
      idleSteers++;
      state.addIntervention({
        turnCount: s.turnCount,
        message: decision.message,
        reasoning: decision.reasoning,
        timestamp: Date.now(),
      });
      labelCurrentLeaf(ctx, formatSupervisorCheckpointLabel("steer", state.getState()?.interventions.length));
      const note = buildEvidenceNote(s.outcome, buildSnapshot(ctx, resolvedSensitivity.messageLimit), evidence.getRecent(), true);
      emitEvidenceNote(note);
      updateUI(ctx, state.getState(), { type: "steering", message: decision.message });
      pi.sendUserMessage(decision.message);
    } else if (decision.action === "done") {
      const checklistResult = await runChecklistGate(ctx, s);
      if (checklistResult === "steer" || checklistResult === "summary") {
        return;
      }

      idleSteers = 0;
      labelCurrentLeaf(ctx, formatSupervisorCheckpointLabel("done", s.turnCount));
      updateUI(ctx, state.getState(), { type: "done" });
      const suffix = stagnating ? ` (stopped after ${MAX_IDLE_STEERS} steering attempts — goal substantially achieved)` : "";
      ctx.ui.notify(`Supervisor: outcome achieved! "${s.outcome}"${suffix}`, "info");
      stopSupervision();
      updateUI(ctx, state.getState());
    } else {
      updateUI(ctx, state.getState(), { type: "watching" });
    }
  });

  // ---- /supervise commands ----

  const openSupervisorSettingsPanel = async (ctx: ExtensionContext) => {
    while (true) {
      const s = state.getState();
      const result = await openSettings(ctx, s, resolveSettingsDefaults(ctx));
      if (result === null) return;

      if (result.action === "editOutcome") {
        const activeState = state.getState();
        if (!activeState?.active) return;
        const edited = await ctx.ui.editor("Edit supervised outcome", activeState.outcome);
        if (edited === undefined) continue;
        const trimmed = edited.trim();
        if (!trimmed) {
          ctx.ui.notify("Outcome cannot be empty.", "warning");
          continue;
        }
        result.outcome = trimmed;
        delete result.action;
        await applySettingsResult(ctx, result);
        continue;
      }

      if (result.action === "resetStats") {
        await applySettingsResult(ctx, result);
        continue;
      }

      await applySettingsResult(ctx, result);
      return;
    }
  };

  const runWidgetCommand = (ctx: ExtensionContext) => {
    const visible = toggleWidget();
    state.setPreferences({ widgetVisible: visible });
    const saved = saveWorkspaceConfig(ctx.cwd, { widgetVisible: visible });
    updateUI(ctx, state.getState());
    ctx.ui.notify(`Supervisor widget ${visible ? "shown" : "hidden"}.` + (saved ? " · saved to .pi/" : ""), "info");
  };

  const runDebugCommand = (ctx: ExtensionContext, rawArg: string) => {
    const arg = rawArg.trim().toLowerCase();
    const current = resolveSettingsDefaults(ctx).debugPayloads;

    if (!arg || arg === "status") {
      notifyDebugStatus(ctx, current, false);
      return;
    }

    let enabled: boolean;
    if (arg === "on" || arg === "enable" || arg === "enabled") {
      enabled = true;
    } else if (arg === "off" || arg === "disable" || arg === "disabled") {
      enabled = false;
    } else if (arg === "toggle") {
      enabled = !current;
    } else {
      ctx.ui.notify("Usage: /supervise:debug [status|on|off|toggle]", "warning");
      return;
    }

    state.setPreferences({ debugPayloads: enabled });
    const saved = saveWorkspaceConfig(ctx.cwd, { debugPayloads: enabled });
    notifyDebugStatus(ctx, enabled, saved);
  };

  const runStopCommand = (ctx: ExtensionContext) => {
    if (!state.isActive()) {
      ctx.ui.notify("Supervisor is not active.", "warning");
      return;
    }
    stopSupervision();
    updateUI(ctx, state.getState());
    ctx.ui.notify("Supervisor stopped.", "info");
  };

  const runStatusCommand = async (ctx: ExtensionContext) => {
    const s = state.getState();
    if (!s) {
      ctx.ui.notify("No active supervision. Use /supervise <outcome> to start.", "info");
      return;
    }
    await openSupervisorSettingsPanel(ctx);
  };

  const runModelCommand = async (ctx: ExtensionContext, spec: string) => {
    const defaults = resolveSettingsDefaults(ctx);

    if (!spec) {
      const picked = await pickModel(ctx, defaults.provider, defaults.modelId);
      if (!picked) return;

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

    const slashIdx = spec.indexOf("/");
    const provider = slashIdx === -1 ? defaults.provider : spec.slice(0, slashIdx);
    const modelId = slashIdx === -1 ? spec : spec.slice(slashIdx + 1);

    state.setModel(provider, modelId);
    const saved = saveWorkspaceConfig(ctx.cwd, { provider, modelId });
    updateUI(ctx, state.getState());
    ctx.ui.notify(
      `Supervisor model set to ${provider}/${modelId}${state.isActive() ? "" : " (takes effect on next /supervise)"}` +
        (saved ? " · saved to .pi/" : ""),
      "info"
    );
  };

  const runSensitivityCommand = (ctx: ExtensionContext, rawLevel: string) => {
    const level = rawLevel.trim() as Sensitivity;
    if (level !== "ultralight" && level !== "low" && level !== "medium" && level !== "high" && level !== "custom") {
      ctx.ui.notify("Usage: /supervise:sensitivity <ultralight|low|medium|high|custom>", "warning");
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
  };

  const runLessonLearnedCommand = async (ctx: ExtensionContext, extraInstruction: string) => {
    const defaults = resolveSettingsDefaults(ctx);
    let provider = defaults.provider;
    let modelId = defaults.modelId;

    const apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
    if (!apiKey) {
      ctx.ui.notify(`No API key for "${provider}/${modelId}" — pick a model with an available key.`, "warning");
      const picked = await pickModel(ctx, provider, modelId);
      if (!picked) return;
      provider = picked.provider;
      modelId = picked.id;
    }

    const existingProjectPrompt = loadExistingProjectSupervisorPrompt(ctx.cwd);
    const basePrompt = loadBuiltinSystemPrompt(modelId).prompt;

    const proposal = await generateSupervisorLessonsProposal({
      ctx,
      provider,
      modelId,
      basePrompt,
      existingProjectPrompt,
      extraInstruction,
      debug: getDebugOptions(ctx),
    });

    if (proposal === null) {
      ctx.ui.notify("Failed to generate a supervisor lesson proposal.", "error");
      return;
    }

    const normalizedProposal = normalizeLessonProposalText(proposal);
    if (!normalizedProposal.trim()) {
      ctx.ui.notify("Generated supervisor lesson proposal was empty.", "warning");
      return;
    }

    const targetPath = getProjectSupervisorPromptPath(ctx.cwd);
    const edited = await ctx.ui.editor(`Review ${targetPath}`, normalizedProposal);
    if (edited === undefined) {
      ctx.ui.notify("Supervisor lesson proposal cancelled.", "info");
      return;
    }

    const finalText = edited.trim();
    if (!finalText) {
      ctx.ui.notify("Refusing to write an empty .pi/SUPERVISOR.md file.", "warning");
      return;
    }

    if (existingProjectPrompt !== null && existingProjectPrompt.trim() === finalText) {
      ctx.ui.notify(`No changes to ${targetPath}.`, "info");
      return;
    }

    persistProjectSupervisorPrompt(targetPath, finalText);
    ctx.ui.notify(`Updated ${targetPath} from current session lessons.`, "info");
  };

  const getChecklistLabel = (supervisorState: ReturnType<typeof state.getState>): string => {
    if (supervisorState?.checklistEnabled === false) return " | checks: off";
    const checklist = supervisorState?.completionChecklist;
    if (!checklist) return "";
    if (checklist.status === "failed") return " | checks: fallback";
    if (checklist.status === "pending") return " | checks: setting up";
    const passed = checklist.items.filter((item) => item.status === "passed").length;
    return ` | checks: ${passed}/${checklist.count}`;
  };

  const getCurrentChecklistItem = () => {
    const checklist = state.getState()?.completionChecklist;
    if (!checklist || checklist.status !== "ready") return null;
    return checklist.items[checklist.currentIndex] ?? null;
  };

  const sendChecklistMessage = (
    ctx: ExtensionContext,
    s: NonNullable<ReturnType<typeof state.getState>>,
    message: string,
    reasoning: string,
  ) => {
    idleSteers++;
    state.addIntervention({
      turnCount: s.turnCount,
      message,
      reasoning,
      timestamp: Date.now(),
    });
    labelCurrentLeaf(ctx, formatSupervisorCheckpointLabel("steer", state.getState()?.interventions.length));
    const resolvedSensitivity = resolveSensitivityConfig(s.sensitivity, s.sensitivityConfig);
    const note = buildEvidenceNote(s.outcome, buildSnapshot(ctx, resolvedSensitivity.messageLimit), evidence.getRecent(), true);
    emitEvidenceNote(note);
    updateUI(ctx, state.getState(), { type: "steering", message });
    pi.sendUserMessage(message);
  };

  const bootstrapCompletionChecklist = async (
    ctx: ExtensionContext,
    provider: string,
    modelId: string,
    outcome: string,
  ): Promise<string> => {
    if (state.getState()?.checklistEnabled === false) {
      updateUI(ctx, state.getState());
      return getChecklistLabel(state.getState());
    }

    const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
    let spinnerIndex = 0;
    const renderBootstrapping = () => {
      updateUI(ctx, state.getState(), {
        type: "bootstrapping",
        frame: spinnerFrames[spinnerIndex],
        summary: "setting up checks…",
      });
    };

    renderBootstrapping();
    const spinner = setInterval(() => {
      spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
      renderBootstrapping();
    }, 100);

    try {
      const checklistItems = await generateCompletionChecklist(ctx, provider, modelId, outcome, getDebugOptions(ctx));
      if (checklistItems.length > 0) {
        state.setCompletionChecklist(checklistItems);
        updateUI(ctx, state.getState());
        return getChecklistLabel(state.getState());
      }

      state.setChecklistSetup({ status: "failed", count: 0, source: "bootstrap-llm", error: "No checklist generated" });
      updateUI(ctx, state.getState());
      return getChecklistLabel(state.getState());
    } finally {
      clearInterval(spinner);
    }
  };

  const startSupervisionRun = async (ctx: ExtensionContext, outcome: string) => {
    const defaults = resolveSettingsDefaults(ctx);
    let provider = defaults.provider;
    let modelId = defaults.modelId;
    const sensitivity = defaults.sensitivity;

    const preferences = state.getPreferences();
    const workspaceConfig = loadWorkspaceConfig(ctx.cwd);
    const hasConfiguredModel = Boolean(preferences.provider && preferences.modelId) || Boolean(workspaceConfig?.provider && workspaceConfig?.modelId);
    if (!hasConfiguredModel) {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
      if (!apiKey) {
        ctx.ui.notify(`No API key for "${provider}/${modelId}" — pick a model with an available key.`, "warning");
        const picked = await pickModel(ctx, provider, modelId);
        if (!picked) return;
        provider = picked.provider;
        modelId = picked.id;
      }
    }

    const sensitivityConfig = resolveSensitivityConfig(sensitivity, defaults.sensitivityConfig);
    state.start(outcome, provider, modelId, sensitivity, sensitivityConfig, defaults.checklistEnabled);
    idleSteers = 0;
    resetRunEvidence();
    labelCurrentLeaf(ctx, formatSupervisorCheckpointLabel("start"));

    const checkLabel = await bootstrapCompletionChecklist(ctx, provider, modelId, outcome);

    const { source } = loadSystemPrompt(ctx.cwd, modelId);
    const promptLabel = source.startsWith("built-in") ? source.replace("built-in", "built-in prompt") : source.replace(ctx.cwd, ".");
    ctx.ui.notify(
      `Supervisor active: "${outcome.slice(0, 50)}${outcome.length > 50 ? "…" : ""}" | ${provider}/${modelId} | ${promptLabel}${checkLabel}`,
      "info"
    );
  };

  pi.registerCommand("supervise", {
    description: "Supervise the chat toward a desired outcome (/supervise <outcome>)",
    handler: async (args, ctx) => {
      const parsed = parseLegacySuperviseInvocation(args?.trim() ?? "");

      switch (parsed.type) {
        case "settings":
          await openSupervisorSettingsPanel(ctx);
          return;
        case "widget":
          runWidgetCommand(ctx);
          return;
        case "debug":
          runDebugCommand(ctx, parsed.arg);
          return;
        case "stop":
          runStopCommand(ctx);
          return;
        case "status":
          await runStatusCommand(ctx);
          return;
        case "model":
          await runModelCommand(ctx, parsed.spec);
          return;
        case "sensitivity":
          runSensitivityCommand(ctx, parsed.level);
          return;
        case "start":
          await startSupervisionRun(ctx, parsed.outcome);
          return;
      }
    },
  });

  pi.registerCommand("supervise:settings", {
    description: "Open supervisor settings",
    handler: async (_args, ctx) => {
      await openSupervisorSettingsPanel(ctx);
    },
  });

  pi.registerCommand("supervise:status", {
    description: "Show active supervisor status/settings",
    handler: async (_args, ctx) => {
      await runStatusCommand(ctx);
    },
  });

  pi.registerCommand("supervise:stop", {
    description: "Stop active supervision",
    handler: async (_args, ctx) => {
      runStopCommand(ctx);
    },
  });

  pi.registerCommand("supervise:model", {
    description: "Set or pick the supervisor model",
    handler: async (args, ctx) => {
      await runModelCommand(ctx, args?.trim() ?? "");
    },
  });

  pi.registerCommand("supervise:sensitivity", {
    description: "Set supervisor sensitivity",
    handler: async (args, ctx) => {
      runSensitivityCommand(ctx, args?.trim() ?? "");
    },
  });

  pi.registerCommand("supervise:widget", {
    description: "Toggle supervisor widget visibility",
    handler: async (_args, ctx) => {
      runWidgetCommand(ctx);
    },
  });

  pi.registerCommand("supervise:debug", {
    description: "Show or change supervisor payload debug logging",
    handler: async (args, ctx) => {
      runDebugCommand(ctx, args?.trim() ?? "");
    },
  });

  pi.registerCommand("supervise:lesson-learned", {
    description: "Extract project-specific supervisor lessons from the current branch session and preview a .pi/SUPERVISOR.md update",
    handler: async (args, ctx) => {
      await runLessonLearnedCommand(ctx, args?.trim() ?? "");
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
        Type.Literal("ultralight"),
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
        Type.Literal("custom"),
      ], {
        description:
          "How aggressively to steer. ultralight = prefer done unless major work is missing, " +
          "low = only when seriously off track, medium = on mild drift (default), " +
          "high = proactively + mid-turn checks, custom = manually tuned check interval/threshold/window.",
      })),
      sensitivityConfig: Type.Optional(Type.Object({
        checkInterval: Type.Number({ description: "Turns between mid-run checks (0 = off)" }),
        confidenceThreshold: Type.Number({ description: "Min confidence (0-1) to steer mid-run" }),
        messageLimit: Type.Number({ description: "Recent messages for supervisor context" }),
      }, {
        description: "Custom sensitivity parameters (only used when sensitivity=custom)",
      })),
      checklistEnabled: Type.Optional(Type.Boolean({
        description:
          "Whether to require the supervisor's completion checklist before finishing. Defaults to the saved setting (enabled by default).",
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
      const defaults = resolveSettingsDefaults(ctx);
      const sensitivity: Sensitivity = params.sensitivity ?? defaults.sensitivity;
      const resolvedConfig = params.sensitivityConfig
        ? { ...params.sensitivityConfig }
        : resolveSensitivityConfig(sensitivity);
      const checklistEnabled = params.checklistEnabled ?? defaults.checklistEnabled;

      // Resolve model: tool param → saved preferences/workspace config → active session model → built-in default
      let provider: string;
      let modelId: string;
      if (params.model) {
        const slash = params.model.indexOf("/");
        provider = slash === -1 ? DEFAULT_PROVIDER : params.model.slice(0, slash);
        modelId  = slash === -1 ? params.model     : params.model.slice(slash + 1);
      } else {
        provider = defaults.provider;
        modelId = defaults.modelId;
      }

      state.start(params.outcome, provider, modelId, sensitivity, resolvedConfig, checklistEnabled);
      idleSteers = 0;
      resetRunEvidence();
      labelCurrentLeaf(ctx, formatSupervisorCheckpointLabel("start"));

      const checkLabel = await bootstrapCompletionChecklist(ctx, provider, modelId, params.outcome);

      const { source } = loadSystemPrompt(ctx.cwd, modelId);
      const promptLabel = source.startsWith("built-in") ? source.replace("built-in", "built-in prompt") : source.replace(ctx.cwd, ".");

      // Notify the user so they're aware supervision was initiated by the model
      ctx.ui.notify(
        `Supervisor started by agent: "${params.outcome.slice(0, 60)}${params.outcome.length > 60 ? "…" : ""}" | ${provider}/${modelId} | sensitivity: ${sensitivity} | ${promptLabel}${checkLabel}`,
        "info"
      );

      return text(`Supervision active. Outcome: "${params.outcome}" | ${provider}/${modelId} | sensitivity: ${sensitivity}${checkLabel}`);
    },
  });
}
