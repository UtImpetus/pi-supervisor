import type { ExtensionContext, ToolResultEvent } from "@mariozechner/pi-coding-agent";
import type { ConversationMessage } from "./types.js";

const SUPERVISOR_EVIDENCE_ENTRY_TYPE = "supervisor-evidence";
const SUPERVISOR_EVIDENCE_MESSAGE_TYPE = "supervisor-evidence-note";

export type EvidenceCategory =
  | "tests"
  | "cli"
  | "imports"
  | "invalid"
  | "mutation"
  | "read"
  | "search"
  | "other";

export interface LineCountEntry {
  path: string;
  count: number;
}

export interface SupervisorEvidenceItem {
  toolName: string;
  category: EvidenceCategory;
  summary: string;
  isError: boolean;
  wrapperKey?: "result" | "data" | "output";
  maxLineCount?: number;
  lineCounts?: LineCountEntry[];
  suspiciousSchemaKeys?: string[];
}

export interface EvidencePromptSummary {
  lines: string[];
  warnings: string[];
}

export interface SupervisorEvidenceNote {
  content: string;
  details: {
    warnings: string[];
    evidence: string[];
    agentIsIdle: boolean;
  };
}

const DEFAULT_MAX_EVIDENCE_ITEMS = 12;
const MAX_SUMMARY_LEN = 120;
const MAX_EXCERPT_LEN = 140;
const MAX_NOTE_WARNINGS = 3;
const MAX_NOTE_EVIDENCE = 4;
const MAX_NOTE_CONTENT = 220;
const TOP_LEVEL_WRAPPER_RE = /^\s*\{\s*"(result|data|output)"\s*:/;
const LINE_COUNT_RE = /^\s*(\d+)\s+(.+?)\s*$/gm;
const SUSPICIOUS_SCHEMA_KEY_RE = /"(cursor_line|cursor_col|cursor_idx|cursor_index|languages)"/g;

export interface SupervisorEvidenceSnapshot {
  items: SupervisorEvidenceItem[];
}


function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text as string)
    .join("\n")
    .trim();
}

function getEntryTimestampMs(entry: any): number | null {
  const ts = entry?.message?.timestamp ?? entry?.timestamp;
  if (typeof ts === "number") return Number.isFinite(ts) ? ts : null;
  if (typeof ts === "string") {
    const parsed = Date.parse(ts);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isEntryAtOrAfter(entry: any, sinceTimestamp?: number): boolean {
  if (sinceTimestamp === undefined) return true;
  const ts = getEntryTimestampMs(entry);
  return ts === null ? false : ts >= sinceTimestamp;
}

function detectTopLevelWrapper(text: string): "result" | "data" | "output" | null {
  const match = text.trim().match(TOP_LEVEL_WRAPPER_RE);
  const key = match?.[1];
  return key === "result" || key === "data" || key === "output" ? key : null;
}

function detectLineCountEvidence(
  command: string,
  text: string,
): { maxLineCount?: number; lineCounts?: LineCountEntry[] } {
  if (!/wc\s+-l|find\s+.+\.py/.test(command)) return {};

  LINE_COUNT_RE.lastIndex = 0;
  let match = LINE_COUNT_RE.exec(text);
  let maxLineCount = 0;
  const lineCounts: LineCountEntry[] = [];

  while (match !== null) {
    const count = Number(match[1]);
    const path = match[2]?.trim();
    if (Number.isFinite(count) && path && path.toLowerCase() !== "total") {
      maxLineCount = Math.max(maxLineCount, count);
      lineCounts.push({ path, count });
    }
    match = LINE_COUNT_RE.exec(text);
  }

  if (maxLineCount === 0) return {};
  return {
    maxLineCount,
    lineCounts: lineCounts.length > 0 ? lineCounts : undefined,
  };
}

function detectSuspiciousSchemaKeys(text: string): string[] {
  SUSPICIOUS_SCHEMA_KEY_RE.lastIndex = 0;
  const keys = new Set<string>();
  for (const match of text.matchAll(SUSPICIOUS_SCHEMA_KEY_RE)) {
    if (match[1]) keys.add(match[1]);
  }
  return [...keys];
}

function classifyBashCommand(command: string, excerpt: string): EvidenceCategory {
  const lower = `${command}\n${excerpt}`.toLowerCase();

  if (
    /(^|\s)(pytest|vitest|jest|cargo test|go test|npm test|pnpm test|yarn test|run_tests\.py|unittest|rspec|mix test)(\s|$)/.test(lower)
  ) {
    return "tests";
  }

  if (
    /python\s+-c\s+.*\bimport\b|python\s+-c\s+.*\bfrom\b.+\bimport\b|node\s+-e\s+.*\brequire\(|node\s+-e\s+.*\bimport\s|ruby\s+-e\s+.*\brequire\b/.test(lower)
  ) {
    return "imports";
  }

  if (
    /invalid|malformed|unknown|bogus|non-zero|exit\s*[:=]\s*1|should fail|expect.*fail|error case|bad timestamp|missing close/.test(lower)
  ) {
    return "invalid";
  }

  if (
    /python\s+-m\s+|node\s+|deno\s+run\s+|cargo\s+run\b|go\s+run\b|npm\s+run\b|pnpm\s+run\b|yarn\s+|\bcli\b|\bentrypoint\b/.test(lower)
  ) {
    return "cli";
  }

  return "other";
}

export function buildEvidenceItem(
  toolName: string,
  input: Record<string, unknown> | undefined,
  content: unknown,
  isError: boolean,
): SupervisorEvidenceItem | null {
  const excerpt = truncate(squash(extractText(content)), MAX_EXCERPT_LEN);

  if (toolName === "bash") {
    const command = typeof input?.command === "string" ? input.command : "(unknown command)";
    const rawText = extractText(content);
    const category = classifyBashCommand(command, excerpt);
    const wrapperKey = category === "cli" ? detectTopLevelWrapper(rawText) : null;
    const lineCountEvidence = detectLineCountEvidence(command, rawText);
    const suspiciousSchemaKeys = category === "cli" ? detectSuspiciousSchemaKeys(rawText) : [];
    return {
      toolName,
      category,
      isError,
      wrapperKey: wrapperKey ?? undefined,
      maxLineCount: lineCountEvidence.maxLineCount,
      lineCounts: lineCountEvidence.lineCounts,
      suspiciousSchemaKeys: suspiciousSchemaKeys.length > 0 ? suspiciousSchemaKeys : undefined,
      summary: `${isError ? "ERR" : "OK"} bash \`${truncate(squash(command), MAX_SUMMARY_LEN)}\`${excerpt ? ` → ${excerpt}` : ""}`,
    };
  }

  if (toolName === "read") {
    const path = typeof input?.path === "string" ? input.path : "(unknown path)";
    return {
      toolName,
      category: "read",
      isError,
      summary: `${isError ? "ERR" : "OK"} read ${truncate(path, MAX_SUMMARY_LEN)}`,
    };
  }

  if (toolName === "write") {
    const path = typeof input?.path === "string" ? input.path : "(unknown path)";
    return {
      toolName,
      category: "mutation",
      isError,
      summary: `${isError ? "ERR" : "OK"} write ${truncate(path, MAX_SUMMARY_LEN)}`,
    };
  }

  if (toolName === "edit") {
    const path = typeof input?.path === "string" ? input.path : "(unknown path)";
    const edits = Array.isArray(input?.edits) ? input.edits.length : undefined;
    return {
      toolName,
      category: "mutation",
      isError,
      summary: `${isError ? "ERR" : "OK"} edit ${truncate(path, MAX_SUMMARY_LEN)}${typeof edits === "number" ? ` (${edits} block${edits === 1 ? "" : "s"})` : ""}`,
    };
  }

  if (toolName === "grep" || toolName === "find" || toolName === "ls") {
    const path = typeof input?.path === "string" ? input.path : typeof input?.cwd === "string" ? input.cwd : undefined;
    const query = typeof input?.pattern === "string" ? input.pattern : typeof input?.command === "string" ? input.command : undefined;
    return {
      toolName,
      category: "search",
      isError,
      summary: `${isError ? "ERR" : "OK"} ${toolName}${path ? ` ${truncate(path, MAX_SUMMARY_LEN)}` : ""}${query ? ` → ${truncate(squash(query), MAX_SUMMARY_LEN)}` : excerpt ? ` → ${excerpt}` : ""}`,
    };
  }

  return {
    toolName,
    category: "other",
    isError,
    summary: `${isError ? "ERR" : "OK"} ${toolName}${excerpt ? ` → ${excerpt}` : ""}`,
  };
}

function isEvidenceCategory(value: unknown): value is EvidenceCategory {
  return value === "tests" || value === "cli" || value === "imports" || value === "invalid" || value === "mutation" || value === "read" || value === "search" || value === "other";
}

function isEvidenceItem(value: unknown): value is SupervisorEvidenceItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.toolName === "string" &&
    isEvidenceCategory(item.category) &&
    typeof item.summary === "string" &&
    typeof item.isError === "boolean" &&
    (item.wrapperKey === undefined || item.wrapperKey === "result" || item.wrapperKey === "data" || item.wrapperKey === "output") &&
    (item.maxLineCount === undefined || typeof item.maxLineCount === "number") &&
    (item.lineCounts === undefined || (Array.isArray(item.lineCounts) && item.lineCounts.every((value) => typeof value === "object" && value !== null && typeof (value as Record<string, unknown>).path === "string" && typeof (value as Record<string, unknown>).count === "number"))) &&
    (item.suspiciousSchemaKeys === undefined || (Array.isArray(item.suspiciousSchemaKeys) && item.suspiciousSchemaKeys.every((value) => typeof value === "string")))
  );
}

export function loadEvidenceSnapshotFromBranch(
  branch: any[],
  maxItems = DEFAULT_MAX_EVIDENCE_ITEMS,
  sinceTimestamp?: number,
): SupervisorEvidenceItem[] {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type !== "custom" || entry?.customType !== SUPERVISOR_EVIDENCE_ENTRY_TYPE) continue;
    if (!isEntryAtOrAfter(entry, sinceTimestamp)) continue;
    const data = entry.data as { items?: unknown } | undefined;
    if (!Array.isArray(data?.items)) continue;
    return data.items.filter(isEvidenceItem).slice(-maxItems);
  }
  return [];
}

export function collectEvidenceFromBranch(
  branch: any[],
  maxItems = DEFAULT_MAX_EVIDENCE_ITEMS,
  sinceTimestamp?: number,
): SupervisorEvidenceItem[] {
  const toolCalls = new Map<string, { name: string; input: Record<string, unknown> | undefined }>();
  const items: SupervisorEvidenceItem[] = [];

  for (const entry of branch) {
    if (!isEntryAtOrAfter(entry, sinceTimestamp)) continue;
    if (entry.type !== "message") continue;
    const msg = (entry as any).message;
    if (!msg) continue;

    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block?.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
          toolCalls.set(block.id, {
            name: block.name,
            input: typeof block.arguments === "object" && block.arguments !== null
              ? (block.arguments as Record<string, unknown>)
              : undefined,
          });
        }
      }
      continue;
    }

    if (msg.role === "toolResult") {
      const call = toolCalls.get(msg.toolCallId);
      const item = buildEvidenceItem(
        typeof msg.toolName === "string" ? msg.toolName : call?.name ?? "unknown",
        call?.input,
        msg.content,
        Boolean(msg.isError),
      );
      if (item) items.push(item);
    }
  }

  return items.slice(-maxItems);
}

function hasAssistantClaim(snapshot: ConversationMessage[], pattern: RegExp): boolean {
  return snapshot.some((message) => message.role === "assistant" && pattern.test(message.content.toLowerCase()));
}

function outcomeNeedsImportVerification(outcome: string): boolean {
  const lower = outcome.toLowerCase();
  return /public function|public functions|exports?|imports?|entry point|package mode|python -m|supported cli operations/.test(lower);
}

function outcomeNeedsCliVerification(outcome: string): boolean {
  const lower = outcome.toLowerCase();
  return /\bcli\b|python -m|entry point|request format|print compact json|single-file mode|package mode/.test(lower);
}

function outcomeNeedsInvalidVerification(outcome: string): boolean {
  const lower = outcome.toLowerCase();
  return /invalid|malformed|unknown operation|unknown operations|exit non-zero|fail cleanly/.test(lower);
}

function outcomeNeedsBroadOperationCoverage(outcome: string): boolean {
  const lower = outcome.toLowerCase();
  return /supported cli operations|required public functions|all seven|all 7|7 ops|7 operations|one positive request per operation/.test(lower);
}

function extractLineLimitFromOutcome(outcome: string): number | null {
  const match = outcome.match(/(\d+)\s+lines?/i);
  if (!match) return null;
  const limit = Number(match[1]);
  return Number.isFinite(limit) ? limit : null;
}

function shouldApplyLineLimitToPath(outcome: string, path: string): boolean {
  const lower = outcome.toLowerCase();
  if (/python file|python files|\.py/.test(lower)) return /\.py$/i.test(path);
  return true;
}

function outcomeMentionsCursorShape(outcome: string): boolean {
  const lower = outcome.toLowerCase();
  return /cursor index|line, column|dirty flag|saved text/.test(lower);
}

function outcomeMentionsLanguageCounts(outcome: string): boolean {
  const lower = outcome.toLowerCase();
  return /language counts|discovered symbols|manifests/.test(lower);
}

export function summarizeEvidenceForPrompt(
  outcome: string,
  snapshot: ConversationMessage[],
  items: SupervisorEvidenceItem[],
  agentIsIdle: boolean,
): EvidencePromptSummary {
  const lines = items.slice(-6).map((item) => item.summary);
  const warnings: string[] = [];

  const categories = new Set(items.map((item) => item.category));
  const assistantClaimsTests = hasAssistantClaim(snapshot, /tests? pass|all .*tests? pass|passed\s+\d+\/?\d*\s+tests?|\b52\/52\b|\bverified\b/);
  const assistantClaimsCli = hasAssistantClaim(snapshot, /\bcli\b|end-to-end|all .*operations|all .*ops|entrypoint|entry point/);
  const assistantClaimsDone = hasAssistantClaim(snapshot, /\ball done\b|\bfinal state\b|\bcompleted\b|\bcomplete\b/);
  const cliEvidence = items.filter((item) => item.category === "cli");
  const wrappedCliOutputs = cliEvidence.filter((item) => item.wrapperKey !== undefined);
  const lineLimit = extractLineLimitFromOutcome(outcome);
  const overLimitLineEntries = lineLimit === null
    ? []
    : items
        .flatMap((item) => item.lineCounts ?? [])
        .filter((entry) => shouldApplyLineLimitToPath(outcome, entry.path) && entry.count > lineLimit);
  const cursorSchemaEvidence = cliEvidence.filter((item) =>
    item.suspiciousSchemaKeys?.some((key) => key === "cursor_line" || key === "cursor_col" || key === "cursor_idx" || key === "cursor_index"),
  );
  const analyzerSchemaEvidence = cliEvidence.filter((item) => item.suspiciousSchemaKeys?.includes("languages"));

  if ((assistantClaimsTests || assistantClaimsDone || agentIsIdle) && outcomeNeedsCliVerification(outcome)) {
    if (categories.has("tests") && !categories.has("cli")) {
      warnings.push("Recent evidence emphasizes tests, but no real CLI/entrypoint verification is visible.");
    } else if (assistantClaimsCli && !categories.has("cli")) {
      warnings.push("Assistant claims CLI or end-to-end verification, but recent tool evidence does not show a real CLI/entrypoint invocation.");
    }
  }

  if ((assistantClaimsCli || assistantClaimsDone || agentIsIdle) && wrappedCliOutputs.length > 0) {
    const keys = [...new Set(wrappedCliOutputs.map((item) => item.wrapperKey))].filter(Boolean).join(", ");
    warnings.push(`Recent CLI/stdout examples appear wrapped in a top-level ${keys || "result"} object. If the task expects a raw list/dict/string, valid compact JSON is NOT enough — the top-level output shape is still wrong.`);
  }

  if ((assistantClaimsCli || assistantClaimsDone || agentIsIdle) && outcomeNeedsBroadOperationCoverage(outcome) && cliEvidence.length > 0 && cliEvidence.length < 2) {
    warnings.push("Recent CLI verification does not yet show representative breadth across the required operation surface. Verify exact outputs on multiple representative operations, not just one successful invocation.");
  }

  if ((assistantClaimsTests || assistantClaimsDone || agentIsIdle) && lineLimit !== null && overLimitLineEntries.length > 0) {
    const worst = overLimitLineEntries.slice(0, 2).map((entry) => `${entry.path} (${entry.count})`).join(", ");
    warnings.push(`Recent line-count evidence shows one or more files over the ${lineLimit}-line limit${worst ? ` (${worst})` : ""}. The outcome is not done until every required file is within the limit.`);
  }

  if ((assistantClaimsCli || assistantClaimsDone || agentIsIdle) && outcomeMentionsCursorShape(outcome) && cursorSchemaEvidence.length > 0) {
    const keys = [...new Set(cursorSchemaEvidence.flatMap((item) => item.suspiciousSchemaKeys ?? []))]
      .filter((key) => key.startsWith("cursor_"))
      .join(", ");
    warnings.push(`Recent CLI/stdout examples use suspicious alternate cursor/state keys (${keys}). If the contract expects fields like cursor, line, and column, verify the exact external keys before saying "done".`);
  }

  if ((assistantClaimsCli || assistantClaimsDone || agentIsIdle) && outcomeMentionsLanguageCounts(outcome) && analyzerSchemaEvidence.length > 0) {
    warnings.push("Recent CLI/stdout examples use `languages` in the external summary. If the contract/examples expect `language_counts` or a differently grouped manifest shape, verify the exact external keys before saying \"done\".");
  }

  if ((assistantClaimsDone || agentIsIdle) && outcomeNeedsImportVerification(outcome) && !categories.has("imports")) {
    warnings.push("Outcome requires public exports/imports or package-surface verification, but no recent import/export check is visible.");
  }

  if ((assistantClaimsDone || assistantClaimsTests || agentIsIdle) && outcomeNeedsInvalidVerification(outcome) && !categories.has("invalid")) {
    warnings.push("Outcome requires malformed or invalid inputs to fail cleanly, but no recent negative-case verification is visible.");
  }

  const recentErrors = items.filter((item) => item.isError).slice(-2);
  if (agentIsIdle && recentErrors.length > 0) {
    warnings.push(`Recent tool errors occurred: ${recentErrors.map((item) => item.summary).join("; ")}`);
  }

  return { lines, warnings };
}

function dedupeEvidenceItems(items: SupervisorEvidenceItem[], maxItems: number): SupervisorEvidenceItem[] {
  const deduped: SupervisorEvidenceItem[] = [];
  const seen = new Set<string>();

  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    const key = `${item.toolName}|${item.category}|${item.summary}|${item.isError}|${item.wrapperKey ?? ""}|${item.maxLineCount ?? ""}|${(item.lineCounts ?? []).map((entry) => `${entry.path}:${entry.count}`).join(",")}|${(item.suspiciousSchemaKeys ?? []).join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  return deduped.reverse().slice(-maxItems);
}

export function buildEvidenceNote(
  outcome: string,
  snapshot: ConversationMessage[],
  items: SupervisorEvidenceItem[],
  agentIsIdle: boolean,
): SupervisorEvidenceNote | null {
  const summary = summarizeEvidenceForPrompt(outcome, snapshot, items, agentIsIdle);
  if (summary.warnings.length === 0) return null;

  const warnings = summary.warnings.slice(0, MAX_NOTE_WARNINGS);
  const evidence = summary.lines.slice(-MAX_NOTE_EVIDENCE);
  const content = truncate(`Supervisor evidence: ${warnings.join(" ")}`, MAX_NOTE_CONTENT);

  return {
    content,
    details: { warnings, evidence, agentIsIdle },
  };
}

export function findLastEvidenceNoteContent(branch: any[], sinceTimestamp?: number): string | null {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type !== "custom_message" || entry?.customType !== SUPERVISOR_EVIDENCE_MESSAGE_TYPE) continue;
    if (!isEntryAtOrAfter(entry, sinceTimestamp)) continue;
    const content = entry.content;
    if (typeof content === "string") return content;
    return extractText(content) || null;
  }
  return null;
}

export function createEvidenceSnapshot(items: SupervisorEvidenceItem[], maxItems = DEFAULT_MAX_EVIDENCE_ITEMS): SupervisorEvidenceSnapshot {
  return { items: dedupeEvidenceItems(items, maxItems) };
}

export function getEvidenceEntryType(): string {
  return SUPERVISOR_EVIDENCE_ENTRY_TYPE;
}

export function getEvidenceMessageType(): string {
  return SUPERVISOR_EVIDENCE_MESSAGE_TYPE;
}

export class SupervisorEvidenceTracker {
  private items: SupervisorEvidenceItem[] = [];

  constructor(private readonly maxItems = DEFAULT_MAX_EVIDENCE_ITEMS) {}

  reset(): void {
    this.items = [];
  }

  hydrateFromSession(ctx: Pick<ExtensionContext, "sessionManager">, sinceTimestamp?: number): void {
    const branch = ctx.sessionManager.getBranch();
    const persisted = loadEvidenceSnapshotFromBranch(branch, this.maxItems, sinceTimestamp);
    const branchItems = collectEvidenceFromBranch(branch, this.maxItems, sinceTimestamp);
    this.items = dedupeEvidenceItems([...persisted, ...branchItems], this.maxItems);
  }

  recordToolResult(event: ToolResultEvent): void {
    const item = buildEvidenceItem(event.toolName, event.input, event.content, event.isError);
    if (!item) return;
    this.items.push(item);
    this.items = dedupeEvidenceItems(this.items, this.maxItems);
  }

  createSnapshot(): SupervisorEvidenceSnapshot {
    return createEvidenceSnapshot(this.items, this.maxItems);
  }

  getRecent(): SupervisorEvidenceItem[] {
    return [...this.items];
  }
}
