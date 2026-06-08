import { relative, resolve } from "node:path";

export type ConstraintKind = "forbid-path" | "allow-only-path" | "forbid-git";

export interface SupervisorHardConstraint {
  kind: ConstraintKind;
  pattern: string;
  source: string;
  createdAt: number;
}

export interface ToolBlockDecision {
  block: boolean;
  reason: string;
  steerMessage: string;
  violatedConstraint?: SupervisorHardConstraint;
}

const MAX_SOURCE_LEN = 160;
const PATH_FRAGMENT_RE = /(?:[A-Za-z]:[\\/])?(?:\.?\.?[\\/])?[\w@.+-]+(?:[\\/][\w@.+-]+)+(?:[\\/])?/g;
const DANGEROUS_GIT_RE = /\bgit\s+(?:stash|reset|clean|checkout\s+--|restore\b|switch\b|checkout\b|add\b|commit\b|push\b|pull\b|merge\b|rebase\b|rm\b|mv\b)/;

function normalizePathFragment(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function stripQuotes(value: string): string {
  const stripped = value.trim().replace(/^[`'"]+|[`'",;:)]+$/g, "");
  if (stripped.endsWith("/.")) return stripped.slice(0, -1);
  return stripped.endsWith(".") ? stripped.slice(0, -1) : stripped;
}

function uniqueConstraints(constraints: SupervisorHardConstraint[]): SupervisorHardConstraint[] {
  const seen = new Set<string>();
  const result: SupervisorHardConstraint[] = [];
  for (const constraint of constraints) {
    const key = `${constraint.kind}|${constraint.pattern}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(constraint);
  }
  return result;
}

function makeConstraint(kind: ConstraintKind, pattern: string, source: string, now: number): SupervisorHardConstraint {
  return {
    kind,
    pattern: normalizePathFragment(stripQuotes(pattern)),
    source: source.slice(0, MAX_SOURCE_LEN),
    createdAt: now,
  };
}

export function extractHardConstraints(text: string, now = Date.now()): SupervisorHardConstraint[] {
  const constraints: SupervisorHardConstraint[] = [];
  const source = text.trim();
  if (!source) return [];

  const lower = source.toLowerCase();
  if (/\bdo not\b|\bdon't\b|\bnever\b|\bstop\b|\bforbid/.test(lower)) {
    for (const match of source.matchAll(/(?:do not|don't|never|stop|forbid(?:den)?)(?:\s+\w+){0,4}\s+(?:touch|edit|modify|write(?:\s+to)?|change|open|read)\s+([`'"]?\S+(?:[\\/]\S*)?)/gi)) {
      const raw = match[1]?.trim();
      if (raw) constraints.push(makeConstraint("forbid-path", raw, source, now));
    }
  }

  for (const match of source.matchAll(/(?:only|exclusively)\s+(?:edit|touch|modify|change|work\s+in|work\s+on)\s+([`'"]?\S+(?:[\\/]\S*)?)/gi)) {
    const raw = match[1]?.trim();
    if (raw) constraints.push(makeConstraint("allow-only-path", raw, source, now));
  }

  if (/do not .*\bgit\s+(stash|checkout|reset|clean|restore)|don't .*\bgit\s+(stash|checkout|reset|clean|restore)|no more .*\bgit\s+(stash|checkout|reset|clean|restore)/i.test(source)) {
    constraints.push(makeConstraint("forbid-git", "git state mutation", source, now));
  }

  return uniqueConstraints(constraints).filter((constraint) => constraint.pattern.length > 0);
}

export function mergeHardConstraints(
  existing: SupervisorHardConstraint[] | undefined,
  incoming: SupervisorHardConstraint[],
): SupervisorHardConstraint[] {
  return uniqueConstraints([...(existing ?? []), ...incoming]).slice(-20);
}

function pathWithin(candidate: string, allowed: string, cwd: string): boolean {
  const absCandidate = resolve(cwd, candidate);
  const absAllowed = resolve(cwd, allowed);
  const rel = relative(absAllowed, absCandidate);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !rel.includes(`..${"/"}`));
}

function pathMatches(candidate: string, pattern: string, cwd: string): boolean {
  const normalizedCandidate = normalizePathFragment(candidate);
  const normalizedPattern = normalizePathFragment(pattern);
  if (normalizedCandidate.includes(normalizedPattern) || normalizedPattern.includes(normalizedCandidate)) return true;
  return pathWithin(candidate, pattern, cwd) || pathWithin(pattern, candidate, cwd);
}

function extractToolPaths(toolName: string, input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  if (typeof input.path === "string") paths.push(input.path);
  if (typeof input.cwd === "string") paths.push(input.cwd);
  if (Array.isArray(input.edits)) {
    // Built-in edit carries the target in input.path; no per-edit paths expected.
  }
  if (toolName === "bash" && typeof input.command === "string") {
    const matches = input.command.match(PATH_FRAGMENT_RE) ?? [];
    paths.push(...matches.map(stripQuotes));
  }
  return paths.map(normalizePathFragment).filter(Boolean);
}

function isMutatingTool(toolName: string): boolean {
  return toolName === "edit" || toolName === "write" || toolName === "bash";
}

export function evaluateToolCallAgainstConstraints(
  toolName: string,
  input: Record<string, unknown> | undefined,
  constraints: SupervisorHardConstraint[] | undefined,
  cwd: string,
): ToolBlockDecision | null {
  if (!input || !constraints || constraints.length === 0) return null;
  if (!isMutatingTool(toolName)) return null;

  const command = typeof input.command === "string" ? input.command : "";
  const paths = extractToolPaths(toolName, input);

  for (const constraint of constraints) {
    if (constraint.kind === "forbid-git" && toolName === "bash" && DANGEROUS_GIT_RE.test(command)) {
      const reason = `Blocked by supervisor hard constraint: user forbade git state mutation (${constraint.pattern}).`;
      return {
        block: true,
        reason,
        steerMessage: `${reason} Do not use git state/history/remote mutation commands. Continue with targeted file edits or ask the user for permission.`,
        violatedConstraint: constraint,
      };
    }

    if (constraint.kind === "forbid-path" && paths.some((path) => pathMatches(path, constraint.pattern, cwd))) {
      const reason = `Blocked by supervisor hard constraint: user forbade touching ${constraint.pattern}.`;
      return {
        block: true,
        reason,
        steerMessage: `${reason} Stop and continue without touching that path. Restate the active constraints and make the next change only in allowed files.`,
        violatedConstraint: constraint,
      };
    }

    if (constraint.kind === "allow-only-path" && paths.length > 0 && paths.some((path) => !pathWithin(path, constraint.pattern, cwd))) {
      const reason = `Blocked by supervisor hard constraint: user allowed edits only under ${constraint.pattern}.`;
      return {
        block: true,
        reason,
        steerMessage: `${reason} Stop broad changes. Work only inside ${constraint.pattern}, or ask the user to relax the constraint.`,
        violatedConstraint: constraint,
      };
    }
  }

  return null;
}

export function formatActiveConstraints(constraints: SupervisorHardConstraint[] | undefined): string {
  if (!constraints || constraints.length === 0) return "";
  const lines = constraints.map((constraint) => {
    const label = constraint.kind === "forbid-path"
      ? "Forbidden path"
      : constraint.kind === "allow-only-path"
        ? "Allowed edit scope"
        : "Forbidden command class";
    return `- ${label}: ${constraint.pattern}`;
  });
  return `ACTIVE SUPERVISOR HARD CONSTRAINTS:\n${lines.join("\n")}\nThese constraints override ordinary implementation ideas. If a needed action conflicts with them, ask the user before using tools.`;
}
