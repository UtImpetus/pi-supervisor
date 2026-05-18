export type SuperviseLegacyAction =
  | { type: "settings" }
  | { type: "widget" }
  | { type: "debug"; arg: string }
  | { type: "stop" }
  | { type: "status" }
  | { type: "model"; spec: string }
  | { type: "sensitivity"; level: string }
  | { type: "start"; outcome: string };

export function parseLegacySuperviseInvocation(trimmed: string): SuperviseLegacyAction {
  if (!trimmed || trimmed === "settings") return { type: "settings" };
  if (trimmed === "widget") return { type: "widget" };
  if (trimmed === "stop") return { type: "stop" };
  if (trimmed === "status") return { type: "status" };
  if (trimmed === "model") return { type: "model", spec: "" };
  if (trimmed.startsWith("model ")) return { type: "model", spec: trimmed.slice(5).trim() };
  if (trimmed === "debug") return { type: "debug", arg: "" };
  if (trimmed.startsWith("debug ")) return { type: "debug", arg: trimmed.slice(5).trim() };
  if (trimmed.startsWith("sensitivity ")) return { type: "sensitivity", level: trimmed.slice(12).trim() };
  return { type: "start", outcome: trimmed };
}
