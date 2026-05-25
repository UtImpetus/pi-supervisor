import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";

const ARTIFACTS_DIR = "supervisor-artifacts";
const INDEX_FILE = "index.jsonl";
const MAX_INDEX_ENTRIES = 200;
const MAX_STORED_ARTIFACT_BYTES = 512 * 1024;
const HEAD_BYTES = 384 * 1024;
const TAIL_BYTES = MAX_STORED_ARTIFACT_BYTES - HEAD_BYTES;
const MAX_RECENT_ARTIFACTS = 6;
const MAX_RECENT_EXCERPT_CHARS = 700;
const MAX_SEARCH_RESULTS = 6;
const MAX_MATCHES_PER_ARTIFACT = 3;
const MATCH_CONTEXT_LINES = 1;
const OMITTED_MARKER = "\n\n... [omitted middle content] ...\n\n";
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "then", "from", "into", "must", "show", "check", "output",
  "verify", "exact", "using", "before", "after", "their", "there", "which", "when", "have", "will", "tool",
  "recent", "state", "items", "item", "required", "should", "could", "would", "about", "string", "value",
  "values", "return", "returns", "result", "results", "input", "inputs", "fields", "keys", "field", "line",
  "column", "index", "text", "body", "metadata", "json", "python", "compact", "stdout", "stderr",
]);

export interface ToolArtifactIndexEntry {
  artifactId: string;
  timestamp: number;
  toolName: string;
  toolCallId: string;
  isError: boolean;
  inputSummary: string;
  preview: string;
  relativePath: string;
  byteLength: number;
  truncated: boolean;
}

export interface ToolArtifactSearchOptions {
  terms?: string[];
  maxResults?: number;
}

function sanitizeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) || "artifact";
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text as string)
    .join("\n")
    .trim();
}

function summarizeInput(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "bash") return typeof input.command === "string" ? squash(input.command) : "(unknown command)";
  if (typeof input.path === "string") return input.path;
  if (typeof input.pattern === "string") return input.pattern;
  if (typeof input.cwd === "string") return input.cwd;
  const pairs = Object.entries(input).slice(0, 4).map(([key, value]) => `${key}=${typeof value === "string" ? truncate(squash(value), 80) : typeof value}`);
  return pairs.join(" ");
}

function trimStoredText(text: string): { text: string; truncated: boolean } {
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength <= MAX_STORED_ARTIFACT_BYTES) return { text, truncated: false };

  const head = Buffer.from(text, "utf8").subarray(0, HEAD_BYTES).toString("utf8");
  const tail = Buffer.from(text, "utf8").subarray(byteLength - TAIL_BYTES).toString("utf8");
  return {
    text: `${head}${OMITTED_MARKER}${tail}`,
    truncated: true,
  };
}

function getArtifactsBaseDir(ctx: Pick<ExtensionContext, "sessionManager">): string | null {
  const sessionDir = ctx.sessionManager.getSessionDir();
  const sessionId = ctx.sessionManager.getSessionId();
  if (!sessionDir || !sessionId) return null;
  return join(sessionDir, ARTIFACTS_DIR, sessionId);
}

function getIndexPath(baseDir: string): string {
  return join(baseDir, INDEX_FILE);
}

function isToolArtifactIndexEntry(value: unknown): value is ToolArtifactIndexEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.artifactId === "string" &&
    typeof entry.timestamp === "number" &&
    typeof entry.toolName === "string" &&
    typeof entry.toolCallId === "string" &&
    typeof entry.isError === "boolean" &&
    typeof entry.inputSummary === "string" &&
    typeof entry.preview === "string" &&
    typeof entry.relativePath === "string" &&
    typeof entry.byteLength === "number" &&
    typeof entry.truncated === "boolean"
  );
}

function loadIndex(baseDir: string): ToolArtifactIndexEntry[] {
  const indexPath = getIndexPath(baseDir);
  if (!existsSync(indexPath)) return [];
  const lines = readFileSync(indexPath, "utf8").split(/\r?\n/).filter(Boolean);
  const entries = lines
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return null;
      }
    })
    .filter(isToolArtifactIndexEntry);
  return entries.slice(-MAX_INDEX_ENTRIES);
}

function extractRelevantLines(text: string, loweredTerms: string[]): string[] {
  const lines = text.split(/\r?\n/);
  if (loweredTerms.length === 0) return lines.slice(0, 12);

  const selected = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i]?.toLowerCase() ?? "";
    if (!loweredTerms.some((term) => lower.includes(term))) continue;
    for (let offset = -MATCH_CONTEXT_LINES; offset <= MATCH_CONTEXT_LINES; offset++) {
      const index = i + offset;
      if (index >= 0 && index < lines.length) selected.add(index);
    }
    if (selected.size >= MAX_MATCHES_PER_ARTIFACT * (MATCH_CONTEXT_LINES * 2 + 1)) break;
  }

  return [...selected].sort((a, b) => a - b).map((index) => lines[index] ?? "");
}

function formatArtifactBlock(entry: ToolArtifactIndexEntry, excerpt: string): string {
  const header = `[${entry.toolName}${entry.isError ? " error" : ""}] ${truncate(entry.inputSummary, 120)}`;
  const suffix = entry.truncated ? " (truncated artifact cache)" : "";
  return `${header}${suffix}\n${truncate(excerpt, MAX_RECENT_EXCERPT_CHARS)}`.trim();
}

export function deriveArtifactSearchTerms(...texts: Array<string | undefined>): string[] {
  const weighted = new Map<string, number>();

  const add = (term: string, score: number) => {
    const normalized = term.trim().toLowerCase();
    if (normalized.length < 3) return;
    if (STOP_WORDS.has(normalized)) return;
    weighted.set(normalized, Math.max(score, weighted.get(normalized) ?? 0));
  };

  for (const text of texts) {
    if (!text) continue;

    for (const match of text.matchAll(/`([^`]{2,80})`/g)) {
      if (match[1]) add(match[1], 5);
    }

    for (const match of text.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) {
      const token = match[0];
      const score = token.includes("_") ? 4 : token.length >= 8 ? 3 : 1;
      add(token, score);
    }
  }

  return [...weighted.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, 12)
    .map(([term]) => term);
}

export class SessionToolArtifactStore {
  private entries: ToolArtifactIndexEntry[] = [];
  private loadedBaseDir: string | null = null;

  reset(): void {
    this.entries = [];
    this.loadedBaseDir = null;
  }

  hydrate(ctx: Pick<ExtensionContext, "sessionManager">): void {
    const baseDir = getArtifactsBaseDir(ctx);
    if (!baseDir) {
      this.reset();
      return;
    }
    this.entries = loadIndex(baseDir);
    this.loadedBaseDir = baseDir;
  }

  recordToolResult(ctx: Pick<ExtensionContext, "sessionManager">, event: ToolResultEvent): ToolArtifactIndexEntry | null {
    const baseDir = getArtifactsBaseDir(ctx);
    if (!baseDir) return null;
    mkdirSync(baseDir, { recursive: true });

    const rawText = extractText(event.content);
    const { text, truncated } = trimStoredText(rawText);
    const timestamp = Date.now();
    const artifactId = `${timestamp}-${sanitizeFilePart(event.toolName)}-${sanitizeFilePart(event.toolCallId)}`;
    const relativePath = `${artifactId}.txt`;
    writeFileSync(join(baseDir, relativePath), text, "utf8");

    const entry: ToolArtifactIndexEntry = {
      artifactId,
      timestamp,
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      isError: event.isError,
      inputSummary: summarizeInput(event.toolName, event.input),
      preview: truncate(squash(text), 220),
      relativePath,
      byteLength: Buffer.byteLength(rawText, "utf8"),
      truncated,
    };

    appendFileSync(getIndexPath(baseDir), `${JSON.stringify(entry)}\n`, "utf8");
    this.loadedBaseDir = baseDir;
    this.entries.push(entry);
    this.entries = this.entries.slice(-MAX_INDEX_ENTRIES);
    return entry;
  }

  getRecentExcerpts(ctx: Pick<ExtensionContext, "sessionManager">, maxArtifacts = 3): string[] {
    const baseDir = getArtifactsBaseDir(ctx);
    if (!baseDir) return [];
    if (this.loadedBaseDir !== baseDir) this.hydrate(ctx);

    return this.entries
      .slice(-Math.min(maxArtifacts, MAX_RECENT_ARTIFACTS))
      .reverse()
      .map((entry) => {
        const fullPath = join(baseDir, entry.relativePath);
        const text = existsSync(fullPath) ? readFileSync(fullPath, "utf8") : entry.preview;
        const excerpt = text.split(/\r?\n/).slice(0, 12).join("\n");
        return formatArtifactBlock(entry, excerpt);
      });
  }

  searchExcerpts(ctx: Pick<ExtensionContext, "sessionManager">, options: ToolArtifactSearchOptions): string[] {
    const baseDir = getArtifactsBaseDir(ctx);
    if (!baseDir) return [];
    if (this.loadedBaseDir !== baseDir) this.hydrate(ctx);

    const maxResults = options.maxResults ?? MAX_SEARCH_RESULTS;
    const loweredTerms = (options.terms ?? []).map((term) => term.toLowerCase());
    const results: string[] = [];

    for (const entry of [...this.entries].reverse()) {
      const fullPath = join(baseDir, entry.relativePath);
      if (!existsSync(fullPath)) continue;
      const text = readFileSync(fullPath, "utf8");
      const excerptLines = extractRelevantLines(text, loweredTerms);
      if (loweredTerms.length > 0 && excerptLines.length === 0) continue;
      const excerpt = excerptLines.length > 0 ? excerptLines.join("\n") : text.split(/\r?\n/).slice(0, 12).join("\n");
      results.push(formatArtifactBlock(entry, excerpt));
      if (results.length >= maxResults) break;
    }

    return results;
  }

  getArtifactsBaseDir(ctx: Pick<ExtensionContext, "sessionManager">): string | null {
    return getArtifactsBaseDir(ctx);
  }

  getIndexEntries(): ToolArtifactIndexEntry[] {
    return [...this.entries];
  }
}

export function getToolArtifactsDebugInfo(ctx: Pick<ExtensionContext, "sessionManager">): { baseDir: string | null; entries: ToolArtifactIndexEntry[] } {
  const baseDir = getArtifactsBaseDir(ctx);
  return {
    baseDir,
    entries: baseDir ? loadIndex(baseDir) : [],
  };
}
