import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SupervisorPayloadDebugOptions {
  enabled: boolean;
  logPath: string;
}

export function getSupervisorPayloadLogPath(cwd: string): string {
  return join(cwd, ".pi", "supervisor-payload.log");
}

function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, current) => {
    if (typeof current === "bigint") return current.toString();
    if (typeof current === "function") return `[Function ${current.name || "anonymous"}]`;
    if (current instanceof Error) {
      return {
        name: current.name,
        message: current.message,
        stack: current.stack,
      };
    }
    if (typeof current === "object" && current !== null) {
      if (seen.has(current)) return "[Circular]";
      seen.add(current);
    }
    return current;
  }) ?? "null";
}

export function appendSupervisorPayloadLog(logPath: string, record: unknown): boolean {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${safeJsonStringify(record)}\n`, "utf-8");
    return true;
  } catch {
    return false;
  }
}
