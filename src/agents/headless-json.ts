import type { HeadlessBackend } from "./headless.js";

type JsonRecord = Record<string, unknown>;

const textItemTypes = new Set(["text", "input_text", "output_text"]);
const skippedItemTypes = new Set([
  "thinking",
  "reasoning",
  "redacted_thinking",
  "tool_use",
  "tool_result",
  "toolcall",
  "function_call",
  "function_call_output",
]);
const readToolNames = new Set(["read", "read_file", "open", "view", "cat"]);
const searchToolNames = new Set(["grep", "rg", "ripgrep", "search", "search_files", "codebase_search", "file_search"]);
const runToolNames = new Set(["bash", "shell", "run", "exec", "execute", "command", "run_command", "exec_command", "terminal"]);
const writeToolNames = new Set(["write", "write_file", "create_file"]);
const editToolNames = new Set(["edit", "edit_file", "replace", "patch", "apply_patch", "str_replace_editor"]);
const toolRecordTypes = new Set([
  "tool_use",
  "tool",
  "toolcall",
  "tool_call",
  "function_call",
  "functioncall",
  "function",
]);
const pathFields = ["path", "file_path", "filepath", "filePath", "relative_path"];
const queryFields = ["query", "pattern", "regex", "term", "search", "needle", "q", "expression"];
const commandFields = ["command", "cmd", "shell_command", "shellCommand", "script", "code"];
const toolNameFields = ["name", "tool_name", "toolName", "function", "function_name", "tool"];
const toolArgumentFields = ["arguments", "args", "input", "params", "parameters", "input_json", "payload"];

export interface ToolProgressEvent {
  readonly operation: "read" | "search" | "run" | "write" | "edit" | "tool";
  readonly text: string;
}

export class HeadlessJsonStream {
  private buffer = "";
  private readonly records: unknown[] = [];
  private readonly rawLines: string[] = [];

  push(text: string): unknown[] {
    this.buffer += text;
    const parsed: unknown[] = [];

    while (true) {
      const newlineIndex = this.buffer.search(/\r?\n/);
      if (newlineIndex === -1) {
        break;
      }

      const rawLine = this.buffer.slice(0, newlineIndex);
      const newlineLength = this.buffer[newlineIndex] === "\r" && this.buffer[newlineIndex + 1] === "\n" ? 2 : 1;
      this.buffer = this.buffer.slice(newlineIndex + newlineLength);
      const value = parseJsonLine(rawLine);
      if (value === undefined) {
        continue;
      }

      this.records.push(value);
      this.rawLines.push(rawLine.trim());
      parsed.push(value);
    }

    return parsed;
  }

  finish(): unknown[] {
    const rawLine = this.buffer;
    this.buffer = "";
    const value = parseJsonLine(rawLine);
    if (value === undefined) {
      return [];
    }

    this.records.push(value);
    this.rawLines.push(rawLine.trim());
    return [value];
  }

  trace(): string {
    return this.rawLines.length > 0 ? `${this.rawLines.join("\n")}\n` : "";
  }

  finalAnswer(backend: HeadlessBackend | undefined): string {
    if (backend === "gemini") {
      const geminiDeltaAnswer = finalGeminiDeltaAnswer(this.records);
      if (geminiDeltaAnswer) {
        return geminiDeltaAnswer;
      }
    }

    const candidates = this.records.flatMap((record) => collectCandidates(record, backend));
    return candidates.at(-1)?.trim() ?? "";
  }

  usage(): unknown {
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const usage = extractUsage(this.records[index]);
      if (usage !== undefined) {
        return usage;
      }
    }

    return undefined;
  }
}

export function extractFileReadPaths(value: unknown): string[] {
  return extractToolProgressEvents(value)
    .filter((event) => event.operation === "read")
    .map((event) => event.text.replace(/^read /, ""));
}

export function extractToolProgressEvents(value: unknown): ToolProgressEvent[] {
  const events: ToolProgressEvent[] = [];
  const seen = new Set<object>();

  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      for (const child of item) {
        visit(child);
      }
      return;
    }

    const record = asRecord(item);
    if (Object.keys(record).length === 0 || seen.has(record)) {
      return;
    }

    seen.add(record);
    const event = progressEventFromToolRecord(record);
    if (event) {
      events.push(event);
      return;
    }

    for (const child of Object.values(record)) {
      visit(child);
    }
  };

  visit(value);
  return events;
}

function parseJsonLine(rawLine: string): unknown | undefined {
  const trimmed = rawLine.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeRole(value: unknown): string {
  const role = asString(value).trim().toLowerCase();
  return role === "model" || role === "gemini" ? "assistant" : role;
}

function extractText(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => extractText(item));
  }

  const record = asRecord(value);
  if (Object.keys(record).length === 0) {
    return [];
  }

  const itemType = asString(record.type).trim().toLowerCase();
  if (skippedItemTypes.has(itemType)) {
    return [];
  }

  if (textItemTypes.has(itemType)) {
    return extractText(record.text);
  }

  const directText = asString(record.text).trim();
  if (directText) {
    return [directText];
  }

  const parts = extractText(record.parts);
  if (parts.length > 0) {
    return parts;
  }

  const content = extractText(record.content);
  if (content.length > 0) {
    return content;
  }

  const nestedMessage = extractText(asRecord(record.message).content);
  return nestedMessage.length > 0 ? nestedMessage : [];
}

function joinText(value: unknown): string {
  return extractText(value).join("\n").trim();
}

function roleFromRecord(record: JsonRecord): string {
  const directRole = normalizeRole(record.role);
  if (directRole) {
    return directRole;
  }

  const messageRole = normalizeRole(asRecord(record.message).role);
  if (messageRole) {
    return messageRole;
  }

  const type = asString(record.type).trim().toLowerCase();
  return type === "assistant" || type === "model" || type === "gemini" ? "assistant" : "";
}

function candidateFromRecord(record: JsonRecord, backend: HeadlessBackend | undefined): string {
  const rowType = asString(record.type).trim().toLowerCase();
  const payload = asRecord(record.payload);
  if (rowType === "response_item" && Object.keys(payload).length > 0) {
    return candidateFromRecord(payload, backend);
  }

  const item = asRecord(record.item);
  if (rowType.startsWith("item.") && Object.keys(item).length > 0) {
    return candidateFromRecord(item, backend);
  }

  if (rowType === "agent_message") {
    const text = asString(record.text).trim();
    if (text) {
      return text;
    }
  }

  if (backend === "opencode" && rowType === "text") {
    const text = joinText(record.part || record.text);
    if (text) {
      return text;
    }
  }

  const message = asRecord(record.message);
  if (Object.keys(message).length > 0) {
    const messageRole = roleFromRecord(message) || roleFromRecord(record);
    if (messageRole === "assistant") {
      return joinText(message.content || message.parts || message.text || message);
    }
  }

  const role = roleFromRecord(record);
  if (role === "assistant" && !skippedItemTypes.has(rowType)) {
    const contentText = joinText(record.content || record.parts || record.text);
    if (contentText) {
      return contentText;
    }
  }

  if (backend === "gemini" && (rowType === "model" || rowType === "gemini")) {
    const contentText = joinText(record.content || record.parts || record.text);
    if (contentText) {
      return contentText;
    }
  }

  if ((backend === "codex" || backend === undefined) && role === "assistant" && rowType === "message") {
    const contentText = joinText(record.content);
    if (contentText) {
      return contentText;
    }
  }

  for (const field of ["result", "response", "final_message", "finalMessage", "final_answer", "finalAnswer", "output"]) {
    const text = asString(record[field]).trim();
    if (
      text &&
      (role === "assistant" ||
        rowType === "result" ||
        rowType === "final" ||
        rowType === "assistant" ||
        (backend === "gemini" && field === "response"))
    ) {
      return text;
    }
  }

  return "";
}

function finalGeminiDeltaAnswer(records: readonly unknown[]): string {
  const segments: string[] = [];
  let currentSegment = "";

  const flushSegment = (): void => {
    const trimmed = currentSegment.trim();
    if (trimmed) {
      segments.push(trimmed);
    }
    currentSegment = "";
  };

  for (const value of records) {
    const record = asRecord(value);
    if (Object.keys(record).length === 0) {
      continue;
    }

    if (isGeminiAssistantDelta(record)) {
      currentSegment += extractRawText(record.content || record.parts || record.text);
      continue;
    }

    if (isGeminiToolBoundary(record)) {
      flushSegment();
    }
  }

  flushSegment();
  return segments.at(-1) ?? "";
}

function isGeminiAssistantDelta(record: JsonRecord): boolean {
  return Boolean(record.delta) && roleFromRecord(record) === "assistant";
}

function isGeminiToolBoundary(record: JsonRecord): boolean {
  const rowType = asString(record.type).trim().toLowerCase();
  return rowType === "tool_use" ||
    rowType === "tool_result" ||
    rowType === "function_call" ||
    rowType === "function_response" ||
    normalizeRole(record.role) === "tool";
}

function extractRawText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => extractRawText(item)).join("");
  }

  const record = asRecord(value);
  if (Object.keys(record).length === 0) {
    return "";
  }

  return extractRawText(record.text || record.content || record.parts);
}

function collectCandidates(value: unknown, backend: HeadlessBackend | undefined): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectCandidates(item, backend));
  }

  const record = asRecord(value);
  if (Object.keys(record).length === 0) {
    return [];
  }

  const candidates: string[] = [];
  const candidate = candidateFromRecord(record, backend);
  if (candidate) {
    candidates.push(candidate);
  }

  const response = asRecord(record.response);
  for (const geminiCandidate of asArray(response.candidates)) {
    const contentText = joinText(asRecord(geminiCandidate).content);
    if (contentText) {
      candidates.push(contentText);
    }
  }

  for (const message of asArray(record.messages)) {
    candidates.push(...collectCandidates(message, backend));
  }

  return candidates;
}

function flattenRecords(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenRecords(item));
  }

  const record = asRecord(value);
  return Object.keys(record).length > 0 ? [record] : [];
}

function progressEventFromToolRecord(record: JsonRecord): ToolProgressEvent | null {
  const recordType = asString(record.type).trim().toLowerCase();
  if (recordType === "command_execution") {
    const command = sanitizeSummary(record.command);
    return command ? { operation: "run", text: `run ${command}` } : { operation: "tool", text: "tool command_execution" };
  }

  const toolName = toolNameFromRecord(record);
  if (!toolName || !isToolRecord(record, toolName)) {
    return null;
  }

  const args = toolArgsFromRecord(record);
  if (!readToolNames.has(toolName)) {
    if (searchToolNames.has(toolName)) {
      const query = valueFromFields(args, queryFields);
      return query ? { operation: "search", text: `search ${query}` } : { operation: "tool", text: `tool ${toolName}` };
    }

    if (runToolNames.has(toolName)) {
      const command = commandFromArgs(args);
      return command ? { operation: "run", text: `run ${command}` } : { operation: "tool", text: `tool ${toolName}` };
    }

    if (writeToolNames.has(toolName)) {
      const path = pathFromArgs(args);
      return path ? { operation: "write", text: `write ${path}` } : { operation: "tool", text: `tool ${toolName}` };
    }

    if (editToolNames.has(toolName)) {
      const path = pathFromArgs(args);
      return path ? { operation: "edit", text: `edit ${path}` } : { operation: "tool", text: `tool ${toolName}` };
    }

    return { operation: "tool", text: `tool ${toolName}` };
  }

  const path = pathFromArgs(args);
  return path ? { operation: "read", text: `read ${path}` } : { operation: "tool", text: `tool ${toolName}` };
}

function isToolRecord(record: JsonRecord, toolName: string): boolean {
  const type = asString(record.type).trim().toLowerCase();
  if (toolRecordTypes.has(type)) {
    return true;
  }

  if (asRecord(record.function).name !== undefined || asRecord(record.functionCall).name !== undefined) {
    return true;
  }

  if (toolName && Object.keys(toolArgsFromRecord(record)).length > 0) {
    return true;
  }

  return false;
}

function toolNameFromRecord(record: JsonRecord): string {
  for (const field of toolNameFields) {
    const name = asString(record[field]).trim().toLowerCase();
    if (name) {
      return name;
    }
  }

  const functionRecord = asRecord(record.function);
  const functionName = asString(functionRecord.name).trim().toLowerCase();
  if (functionName) {
    return functionName;
  }

  const functionCallRecord = asRecord(record.functionCall);
  return asString(functionCallRecord.name).trim().toLowerCase();
}

function toolArgsFromRecord(record: JsonRecord): JsonRecord {
  for (const field of toolArgumentFields) {
    const value = record[field];
    const parsed = typeof value === "string" ? parseJsonLine(value) : value;
    const args = asRecord(parsed);
    if (Object.keys(args).length > 0) {
      return args;
    }
  }

  const functionRecord = asRecord(record.function);
  const functionArgs = typeof functionRecord.arguments === "string"
    ? parseJsonLine(functionRecord.arguments)
    : functionRecord.arguments;
  const functionArgsRecord = asRecord(functionArgs);
  if (Object.keys(functionArgsRecord).length > 0) {
    return functionArgsRecord;
  }

  const functionCallRecord = asRecord(record.functionCall);
  const functionCallArgs = typeof functionCallRecord.args === "string"
    ? parseJsonLine(functionCallRecord.args)
    : functionCallRecord.args;
  return asRecord(functionCallArgs);
}

function isConfidentPath(path: string): boolean {
  return path.length > 0 && !path.includes("\n") && !path.includes("\0") && !/^\s*-/.test(path);
}

function pathFromArgs(args: JsonRecord): string {
  for (const field of pathFields) {
    const path = sanitizeSummary(args[field]);
    if (isConfidentPath(path)) {
      return path;
    }
  }

  return "";
}

function commandFromArgs(args: JsonRecord): string {
  for (const field of commandFields) {
    const command = sanitizeSummary(args[field]);
    if (command) {
      return command;
    }
  }

  return "";
}

function valueFromFields(args: JsonRecord, fields: readonly string[]): string {
  for (const field of fields) {
    const value = sanitizeSummary(args[field]);
    if (value) {
      return value;
    }
  }

  return "";
}

function sanitizeSummary(value: unknown): string {
  const raw = Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value.join(" ")
    : asString(value);
  const summary = raw.replace(/\s+/g, " ").trim();
  return summary.length > 120 ? `${summary.slice(0, 117)}...` : summary;
}

function extractUsage(value: unknown): unknown {
  for (const record of flattenRecords(value)) {
    const directUsage = normalizeUsage(record.usage);
    if (directUsage !== undefined) {
      return directUsage;
    }

    const messageUsage = normalizeUsage(asRecord(record.message).usage);
    if (messageUsage !== undefined) {
      return messageUsage;
    }
  }

  return undefined;
}

function normalizeUsage(value: unknown): unknown {
  const usage = asRecord(value);
  if (Object.keys(usage).length === 0) {
    return undefined;
  }

  const normalized: Record<string, unknown> = {};
  assignNumber(normalized, "inputTokens", usage.inputTokens ?? usage.input_tokens ?? usage.input);
  assignNumber(normalized, "cacheReadTokens", usage.cacheReadTokens ?? usage.cache_read_input_tokens ?? usage.cached_input_tokens ?? usage.cacheRead);
  assignNumber(normalized, "cacheWriteTokens", usage.cacheWriteTokens ?? usage.cache_creation_input_tokens ?? usage.cacheWrite);
  assignNumber(normalized, "outputTokens", usage.outputTokens ?? usage.output_tokens ?? usage.output);
  assignNumber(normalized, "reasoningOutputTokens", usage.reasoningOutputTokens ?? usage.reasoning_output_tokens);
  assignNumber(normalized, "totalTokens", usage.totalTokens ?? usage.total_tokens);

  for (const field of ["provider", "model", "pricingStatus", "cost"]) {
    if (usage[field] !== undefined) {
      normalized[field] = usage[field];
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : usage;
}

function assignNumber(target: Record<string, unknown>, field: string, value: unknown): void {
  const number = asNumber(value);
  if (number !== undefined) {
    target[field] = number;
  }
}
