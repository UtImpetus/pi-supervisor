const SUPERVISOR_LABEL_PATTERN = /\s*\[sup:[^\]]+\]/g;

export type SupervisorCheckpointKind = "start" | "steer" | "done";

export function mergeSupervisorTreeLabel(existing: string | undefined, supervisorTag: string): string {
  const base = (existing ?? "").replace(SUPERVISOR_LABEL_PATTERN, "").trim();
  return base ? `${base} [${supervisorTag}]` : `[${supervisorTag}]`;
}

export function formatSupervisorCheckpointLabel(
  kind: SupervisorCheckpointKind,
  ordinal?: number,
): string {
  switch (kind) {
    case "start":
      return "sup:start";
    case "steer":
      return `sup:steer#${Math.max(ordinal ?? 1, 1)}`;
    case "done":
      return `sup:done#${Math.max(ordinal ?? 1, 1)}`;
  }
}
