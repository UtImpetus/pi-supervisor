# pi-supervisor

A [pi](https://pi.dev) extension that supervises the coding agent and steers it toward a defined outcome. It observes every conversation turn, injects guiding messages when the agent drifts, and signals when the goal is reached — like a tech lead watching over a dev's shoulder.

> A supervisor as the intelligent overseer keeping the agent on track.

> **Status:** Early release.

<img height="298" alt="image" src="https://github.com/tintinweb/pi-supervisor/raw/master/media/screenshot.png" />



https://github.com/user-attachments/assets/f3b23662-6473-4ac3-82f7-c7f9b64fa7c7

## How It Works

```
/supervise Implement a secure JWT auth system with refresh tokens and full test coverage
```

Then start the conversation normally — the supervisor watches from outside without modifying the agent's context.

1. **After each run** — a separate supervisor LLM analyzes the conversation against the goal (all sensitivities)
2. **Mid-run, between tool calls** — also checks for drift on `medium`, `high`, and matching `custom` sensitivity and can steer the agent without waiting for it to finish
3. **On completion** — supervisor signals done and stops automatically

The supervisor is a pure outside observer. It runs in a separate in-memory pi session sharing only the API credentials and never touches the main agent's context window or system prompt.

## Install

```bash
pi install npm:pi-supervisor
```

Or load directly for development:

```bash
pi -e ~/projects/pi-supervisor/src/index.ts
```

## Commands

| Command | Description |
|---|---|
| `/supervise <outcome>` | Start supervising toward a desired outcome |
| `/supervise` or `/supervise:settings` | Open the interactive settings panel |
| `/supervise:status` | Show current state (opens settings panel if active) |
| `/supervise:stop` | Stop active supervision |
| `/supervise:widget` | Toggle the status widget on/off |
| `/supervise:model [provider/modelId]` | Open the interactive model picker or set supervisor model directly |
| `/supervise:sensitivity <ultralight\|low\|medium\|high\|custom>` | Adjust steering aggressiveness |
| `/supervise:debug [status\|on\|off\|toggle]` | Show or change supervisor payload debug logging |
| `/supervisor <new outcome>` | Update the active supervision outcome at runtime |
| `/supervise:lesson-learned [optional guidance]` | Derive project-specific supervisor lessons from the current branch session and preview a `.pi/SUPERVISOR.md` proposal |

Legacy compatibility forms like `/supervise stop`, `/supervise model ...`, and `/supervise sensitivity ...` are still supported.

### Examples

```
/supervise Refactor the auth module to use dependency injection and add 90% test coverage

/supervise:model
# Opens pi's model selector — pick any model with a configured API key

/supervise:sensitivity low
# Only steer when seriously off track

/supervisor Also verify that hello.txt has no trailing newline and is exactly 5 bytes
# If the agent is busy, queue the outcome update for the next idle checkpoint.
# The checklist is regenerated for the new outcome when the update applies.

/supervise:lesson-learned focus on repeated CLI verification gaps
# Builds a project-local .pi/SUPERVISOR.md proposal from the current branch session,
# opens it in an editor preview, and writes it only after you confirm/save.

/supervise:stop
```

The agent can also initiate supervision itself by calling the `start_supervision` tool — useful when it recognises a task needs goal tracking. Once active, supervision is locked: only the user can change or stop it.

## UI

### Settings Panel

Run `/supervise` (no args) or `/supervise:settings` to open the interactive settings panel:

- **Model** — shows current model; press Enter to browse all available models
- **Sensitivity** — cycle through `ultralight`/`low`/`medium`/`high`/`custom` with Enter or Space
  - When `custom` is selected, three sub-parameters appear:
    - **Check Interval** — turns between mid-run checks (0 = off)
    - **Confidence Threshold** — minimum confidence to steer mid-run
    - **Message Window** — recent messages for supervisor context
  - Changing any sub-parameter auto-switches to `custom`; matching a preset snaps back to its name
- **Completion Checklist** — enable/disable the mandatory completion checklist gate (enabled by default)
- **Widget** — toggle visibility
- **Outcome** (when active) — shows the current goal plus steer/turn stats
- **Edit Outcome** (when active) — edit the active outcome as a draft; it applies only after **Apply & Close**
- **Checklist** (when active) — shows the current or drafted checklist status
- **Edit Checklist** (when active) — edit the checklist as a draft; it applies only after **Apply & Close**
- **Regenerate Checklist** (when active) — build a fresh checklist draft from the current draft/live outcome; it applies only after **Apply & Close**
- **Reset Runtime Stats** (when active) — immediately reset steer/turn/checklist progress for the current supervision run
- **Stop** (when active) — stop supervision directly from the panel

Navigate with arrow keys.

- **Apply & Close** — save pending changes and close
- **Cancel** — discard pending changes and close
- **Escape** — discard pending changes and close

Model, sensitivity (including custom config), checklist preference, widget visibility, and payload-debug preference are remembered for the session. If the project already has a `.pi/` directory, they are also saved to `.pi/supervisor-config.json`.

### Live Widget

**Footer** (always visible while supervising):
```
🎯
```

**Widget** (two lines, updated live):
```
◉ Supervising · Goal: "Refactor auth module…"
claude-haiku · sensitivity: medium · ↗ 2 · ⟳ turn 4
```

For `custom` sensitivity, the widget shows a compact summary:
```
claude-haiku · sensitivity: custom (⨍2 ≥0.8 w10) · ↗ 2 · ⟳ turn 4
```

Where `⨍` = checkInterval, `≥` = confidenceThreshold, `w` = messageLimit.

While analyzing, the second line can also include a truncated `thinking: ...` snippet after the current status. Toggle the widget with `/supervise:widget`.

## Sensitivity Levels

| Level | When it checks | Confidence threshold | Steering style |
|---|---|---|---|
| `ultralight` | End of each run only | 1.0 | Most hands-off; prefer done unless major work is missing |
| `low` | End of each run only | 1.0 (only if seriously off track) | Minimal intervention |
| `medium` (default) | End of run + every 3rd tool cycle mid-run | ≥ 0.90 | On clear drift |
| `high` | End of run + every tool cycle mid-run | ≥ 0.85 | Proactively |
| `custom` | User-defined | User-defined | User-defined |

### Custom Sensitivity

When you need fine-grained control, select **custom** in the settings panel. This reveals three sub-parameters:

| Parameter | Description | Values |
|---|---|---|
| Check Interval | Turns between mid-run checks (0 = off, end-of-run only) | 0, 1, 2, 3, 4, 5 |
| Confidence Threshold | Minimum confidence (0–1) to steer mid-run | 0.70, 0.75, 0.80, 0.85, 0.90, 0.95 |
| Message Window | Number of recent messages for supervisor context | 4, 6, 8, 10, 12, 16, 20, 24 |

Adjusting any sub-parameter automatically switches the sensitivity label to **custom**. If your values happen to match a preset exactly, the label snaps back to that preset name.

Custom settings are also available via the `/supervise:sensitivity custom` command and the `start_supervision` tool.

### Completion Checklist

By default, each supervision run bootstraps a short completion checklist and requires it to pass before the supervisor can finish the task. You can disable that gate from the settings panel, via saved config, or with `start_supervision.checklistEnabled` when you want a lighter workflow.

When you change the active outcome from the settings panel and then press **Apply & Close**, the supervisor keeps its current turn/steer statistics but automatically rebuilds the checklist for the new outcome unless you have staged a manual checklist edit/draft. Manual checklist edits and regenerate actions are also staged until **Apply & Close**. `Reset Runtime Stats` is the separate immediate action when you want to zero the counters and restart checklist progress without changing the outcome.

**End-of-run** (`agent_end`): fires once per user prompt after the agent finishes and goes idle. The supervisor must decide `done`, `steer`, or `continue`.

**Mid-run** (`turn_end`): fires after each LLM tool-call cycle while the agent is still working. Steering is injected immediately (interrupting the current run) only when confidence exceeds the threshold. The agent has at least 2 sub-turns to settle before mid-run checks begin.

## Supervisor Model

The supervisor runs on a **separate model** — it can be a cheaper/faster model than the one doing the actual work.

**Resolution order:**
1. Previous session state (persists within a session)
2. `.pi/supervisor-config.json` in the project root (saved by `/supervise:model` and the settings panel when `.pi/` exists)
3. Active chat model (`ctx.model`) — so it works out of the box with no configuration
4. Built-in default: `anthropic/claude-haiku-4-5-20251001`

Change at any time with `/supervise:model` (interactive picker), `/supervise:model <provider/id>` (direct), or the settings panel. Model, sensitivity (including custom config), checklist preference, widget visibility, and payload-debug preference are saved to `.pi/supervisor-config.json` if the `.pi/` directory exists.

## Focus and Goal Discipline

The supervisor is a pure outside observer — it does not modify the agent's system prompt. Goal discipline is enforced entirely through steering messages when the agent drifts. If the agent asks an out-of-scope clarifying question, the supervisor redirects it back to the goal rather than answering.

## Stagnation Detection

If the supervisor sends **5 consecutive steering messages** without declaring the goal done, it switches to a lenient evaluation mode: if the goal is ≥80% achieved, it declares done rather than looping forever on minor improvements. The threshold is configurable via `MAX_IDLE_STEERS` in `src/index.ts`.

## Customizing the Supervisor: SUPERVISOR.md

The supervisor's reasoning is controlled by its **system prompt** — not the goal. The goal is always set at runtime via `/supervise <outcome>`. `SUPERVISOR.md` defines *how* the supervisor thinks: its rules, persona, and project-specific constraints.

**Discovery order** (model-specific files take priority over generic at each level):

| Priority | Location | Use for |
|---|---|---|
| 1 | `.pi/<modelId>-SUPERVISOR.md` | Project-local, model-specific rules |
| 2 | `.pi/SUPERVISOR.md` | Project-local, model-agnostic rules |
| 3 | `~/.pi/agent/<modelId>-SUPERVISOR.md` | Global, model-specific rules |
| 4 | `~/.pi/agent/SUPERVISOR.md` | Global, model-agnostic rules |
| 5 | Built-in model-specific prompt | Hardcoded per model prefix (e.g. `deepseek`)
| 6 | Built-in default template | Fallback |

The active source is shown when you run `/supervise <outcome>` or `/supervise:status`. Sources are reported as:
- A file path (e.g. `.pi/deepseek-v4-flash-SUPERVISOR.md`) for file-based prompts
- `built-in:deepseek` for built-in model-specific prompts
- `built-in` for the default fallback prompt

### Built-in system prompt

The default prompt the supervisor uses when no `SUPERVISOR.md` is found:

```
You are a supervisor monitoring a coding AI assistant conversation.
Your job: ensure the assistant fully achieves a specific outcome without needing the human to intervene.

═══ WHEN THE AGENT IS IDLE (finished its turn, waiting for user input) ═══
This is your most important moment. The agent has stopped and is waiting.
You MUST choose "done" or "steer". Never return "continue" when the agent is idle.

- "done"  → only when the outcome is completely and verifiably achieved.
- "steer" → everything else: incomplete work, partial progress, open questions, waiting for confirmation.

If the agent asked a clarifying question or needs a decision:
  FIRST check: is this question necessary to achieve the goal?
  - YES (directly blocks goal progress): answer with a sensible default and tell agent to proceed.
  - NO (out of scope, nice-to-have, unrelated feature): do NOT answer it. Redirect:
    "That's outside the scope of the goal. Focus on: [restate the specific missing piece]."
  DO NOT answer: passwords, credentials, secrets, anything requiring real user knowledge.

Your steer message speaks AS the user. Make it clear, direct, and actionable (1–3 sentences).
Do not ask the agent to verify its own work — tell it what to do next.

═══ WHEN THE AGENT IS ACTIVELY WORKING (mid-turn) ═══
Only intervene if it is clearly heading in the wrong direction.
Trust the agent to complete what it has started. Avoid interrupting productive work.

═══ STEERING RULES ═══
- Be specific: reference the outcome, missing pieces, or the question being answered.
- Never repeat a steering message that had no effect — escalate or change approach.
- A good steer answers the agent's question OR redirects to the missing piece of the outcome.
- If the agent is taking shortcuts to satisfy the goal without properly achieving it, always steer and remind it not to take shortcuts.

"done" CRITERIA: The core outcome is complete and functional. Minor polish, style tweaks, or
optional improvements do NOT block "done". Prefer stopping when the goal is substantially
achieved rather than looping forever chasing perfection.

Respond ONLY with valid JSON — no prose, no markdown fences.
Response schema (strict JSON):
{
  "action": "continue" | "steer" | "done",
  "message": "...",     // Required when action === "steer"
  "reasoning": "...",   // Brief internal reasoning
  "confidence": 0.85    // Float 0-1
}
```

### Model-specific SUPERVISOR.md

You can create prompt files that apply only when a specific model is supervising. The file naming convention uses the modelId as a prefix:

```
.deepseek-v4-flash-SUPERVISOR.md
claude-haiku-4-5-20251001-SUPERVISOR.md
gpt-4o-mini-SUPERVISOR.md
```

These are discovered in the same locations as `SUPERVISOR.md`:
- `.pi/deepseek-v4-flash-SUPERVISOR.md` — project-local, used only when the supervisor model is `deepseek-v4-flash`
- `~/.pi/agent/deepseek-v4-flash-SUPERVISOR.md` — global, used only for that model

Model-specific files take priority over the generic `SUPERVISOR.md` at each level. So if both `.pi/SUPERVISOR.md` and `.pi/deepseek-v4-flash-SUPERVISOR.md` exist, the model-specific file wins when using `deepseek-v4-flash`.

The modelId is matched exactly (the full model ID string from your provider, case-insensitive for built-in prefix matching). For example:
- `deepseek-v4-flash` → looks for `deepseek-v4-flash-SUPERVISOR.md`
- `claude-haiku-4-5-20251001` → looks for `claude-haiku-4-5-20251001-SUPERVISOR.md`

#### Built-in model prompts

The extension ships with built-in prompts for certain model families. These are matched by prefix (case-insensitive):

### Learning project-specific supervisor rules from a session

Use `/supervise:lesson-learned [optional guidance]` to derive a project-local supervisor prompt from the **current branch session**. The command now builds a structured lesson bundle before drafting the prompt. It:

1. reads the current branch session transcript,
2. extracts recorded supervisor interventions when present,
3. extracts visible supervisor evidence notes and key verification tool outputs,
4. proposes structured lesson candidates (including anti-lessons / "do not overfit this" guidance),
5. runs a critique pass over accepted candidates to catch overfit or weak lessons,
6. filters low-confidence, generic, duplicate, and clearly overfit candidates,
7. starts from the built-in supervisor prompt for the currently selected supervisor model,
8. generates a full `.pi/SUPERVISOR.md` proposal,
9. opens that proposal in an interactive editor preview,
10. writes `.pi/SUPERVISOR.md` only after you save/confirm the edited text.

This works even if supervision was never active in the session — the command can still infer lessons from the full branch behavior.

Use the optional trailing text to bias extraction toward a theme, for example:

```text
/supervise:lesson-learned focus on repeated exact-schema mistakes and missing CLI checks
```

The learned prompt is intended to capture:
- project-specific failure modes,
- project-specific verification checklist items,
- project-specific steering style/tactics,
- anti-lessons when the session shows a bad supervisory overreach,

while avoiding generic advice already covered by the built-in prompt.

The generated file lives at `.pi/SUPERVISOR.md`, which already participates in the normal prompt override discovery order described above.

The extension ships with built-in prompts for certain model families. These are matched by prefix (case-insensitive):

| Prefix | Models that match | What's different |
|---|---|---|
| `deepseek` | `deepseek-v4-flash`, `deepseek-chat`, etc. | Stricter "done" criteria for promised external surfaces and exact schemas, 6 DeepSeek-specific failure modes (return wrapping, missing external wiring, field naming, extra fields, case mismatches, return type violations), extra emphasis on strict JSON output |

Built-in model prompts are lower priority than any file-based `SUPERVISOR.md`. To override a built-in model prompt, create a generic or model-specific `SUPERVISOR.md` file.

### Writing a custom SUPERVISOR.md

You must preserve the JSON response schema. Everything else is up to you.

```markdown
You are a supervisor for a TypeScript project. Your priorities: type safety and test coverage.

Rules:
- Steer if the agent uses `any` types or skips tests for new code
- When steering, be direct: one sentence max, reference the specific file/function if possible
- "done" only when the new code has types and tests — not before
- Do not steer about code style, naming, or documentation

Response schema (strict JSON, required):
{
  "action": "continue" | "steer" | "done",
  "message": "...",
  "reasoning": "...",
  "confidence": 0.85
}
```

## Session Persistence

Supervision state (outcome, model, sensitivity, intervention history) is stored in the pi session file and restored automatically on restart, session switch, fork, and tree navigation.

## Project Structure

```
src/
  index.ts              # Extension entry point, event wiring, /supervise command, start_supervision tool
  types.ts              # SupervisorState, SteeringDecision, ConversationMessage, SensitivityConfig, presets & helpers
  state.ts              # SupervisorStateManager — in-memory state + session persistence
  engine.ts             # Snapshot building, SUPERVISOR.md loading (with model-specific discovery), prompt construction, analyze()
  model-client.ts       # One-shot supervisor LLM calls via pi's AgentSession API
  workspace-config.ts   # .pi/supervisor-config.json read/write for saved supervisor settings
  ui/
    status-widget.ts    # 🎯 footer badge + two-line widget with goal, settings, and live status (shows custom sensitivity details)
    model-picker.ts     # Interactive model picker using pi's ModelSelectorComponent
    settings-panel.ts   # Interactive settings overlay using pi-tui's SettingsList
```

## License

MIT — [tintinweb](https://github.com/tintinweb)
