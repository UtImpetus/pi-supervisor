# Predefined checks supplement the bootstrap checklist

We introduced opt-in "predefined checks" — built-in process-hygiene items such as documentation sync, self-review, and code-smell cleanup — that users can enable individually via the settings panel. When enabled, these items are appended to the LLM-generated bootstrap checklist before the checklist gate runs.

## Why we did it this way

The existing bootstrap checklist is generated per-outcome by a supervisor LLM call. It excels at contract verification (exact CLI behaviour, schema shapes, invalid cases) but is blind to process hygiene: it won't remind the agent to update docs or run a final self-review unless the outcome explicitly mentions those things.

We considered four approaches:

1. **Supplemental** — merge predefined checks with bootstrap items. Chosen because it keeps the best of both worlds: outcome-specific contract checks plus consistent hygiene checks.
2. **Category templates** — let the bootstrap LLM draw from predefined families. Rejected because it adds indirection and the LLM already does a good job at contract checks.
3. **Post-completion checks** — run hygiene checks after the bootstrap gate passes. Rejected because it would require a second gate cycle, complicating the already-tricky idle-message delivery path.
4. **Replace bootstrap** — a fixed predefined checklist disables the LLM generator. Rejected because outcome-specific contract checks are the strongest feature of the checklist gate.

Merge order is **bootstrap first, predefined last**. This prevents the agent from polishing documentation for code whose core contract is still unproven.

## Settings UI

Predefined checks are exposed as individual toggles in the supervisor settings panel. They are saved to `.pi/supervisor-config.json` (like sensitivity and widget visibility) so selections persist across sessions.

We rejected an "all-or-nothing" bundle toggle because different tasks warrant different hygiene checks, and a per-check UI is only one additional row per check.

## Terminology

We call them "predefined checks" (not "templates" or "definition-of-done items") to emphasise that they are hardcoded, built-in, and optional. The existing LLM-generated items remain "bootstrap checklist items".
