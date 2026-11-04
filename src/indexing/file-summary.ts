/**
 * INDEX SHAPE: changing what this produces for existing files requires bumping
 * CODE_INDEX_VERSION / DOC_INDEX_VERSION in indexing.ts (ADR-0027).
 *
 * L1 file summaries: one extra chunk per multi-chunk file that describes the
 * file as a whole (ADR-0024). Deterministic by default (path, language,
 * symbols, leading comment); an OpenAI-compatible LLM can write it instead.
 * A failing LLM never blocks indexing: the deterministic text is used, and
 * after three consecutive failures the LLM is skipped for the rest of the run.
 */

import { DEFAULT_SUMMARY_LLM_API_KEY_ENV } from "../config/config-file.js";

export interface SummaryInput {
  relativePath: string;
  language: string;
  symbols: (string | undefined)[];
  content: string;
}

/** A summary that is only the deterministic fallback although an LLM was asked for. */
export interface FallbackSummary {
  text: string;
  fallback: boolean;
}

export type LlmSummarize = (input: { relativePath: string; content: string }) => Promise<string>;

const MAX_SYMBOLS = 40;
const MAX_LLM_CONTENT_CHARS = 12_000;
const MAX_FAILURES = 3;

const FILE_SYSTEM_PROMPT =
  "You summarize source files for a code search index. Answer in 2-3 plain sentences: the file's purpose, its main responsibilities and key names. No markdown, no preamble.";

export const DOC_SYSTEM_PROMPT =
  "You summarize documentation for a search index. Answer in 1-2 plain sentences: what the text covers and the key terms, decisions or names it mentions. No markdown, no preamble.";

function leadingComment(content: string): string | undefined {
  const lines = content.split("\n").slice(0, 40);
  const picked: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (picked.length === 0 && (line === "" || line === "/**" || line === "/*" || line.startsWith("#!"))) continue;
    const m = /^(?:\/\/+|\/?\*+\/?|#+|--|""")\s?(.*)$/.exec(line);
    if (!m) break;
    const text = m[1]!.replace(/\*\/$/, "").trim();
    if (text) picked.push(text);
    if (picked.length >= 3) break;
  }
  return picked.length > 0 ? picked.join(" ") : undefined;
}

export function buildDeterministicSummary(input: SummaryInput): string {
  const symbols = [...new Set(input.symbols.filter((s): s is string => !!s))].slice(0, MAX_SYMBOLS);
  const parts = [`File ${input.relativePath} (${input.language}).`];
  const comment = leadingComment(input.content);
  if (comment) parts.push(comment);
  if (symbols.length > 0) parts.push(`Defines: ${symbols.join(", ")}.`);
  return parts.join(" ");
}

/** The provider answered HTTP 401; the message tells the user how to fix it. */
export class SummaryLlmAuthError extends Error {
  override name = "SummaryLlmAuthError";
}

function authMessage(envName: string, keyWasSent: boolean): string {
  const fix = `Set it with: export ${envName}=<your key>  and restart opencode.`;
  return keyWasSent
    ? `Summary LLM answered 401: the API key in ${envName} was rejected. ${fix}`
    : `Summary LLM answered 401: API key not set. ${fix}`;
}

export interface LlmSummarizerOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Variable the user is told to set on HTTP 401. */
  apiKeyEnvName?: string;
  timeoutMs?: number;
  /** Replaces the code-oriented default prompt, e.g. for documentation. */
  systemPrompt?: string;
  fetch?: typeof fetch;
}

/**
 * True when a "summary" is really a tool call. Some OpenAI-compatible servers
 * (oMLX with a global MCP config) inject their tool list into every request, and
 * small models then answer with a JSON tool call instead of prose.
 */
export function looksLikeToolCall(text: string): boolean {
  if (/\b[A-Za-z0-9-]+__[A-Za-z0-9_-]+\b/.test(text) && /"(?:name|arguments)"\s*:/.test(text)) return true;
  const body = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  return /^\{\s*"name"\s*:/.test(body) && /"arguments"\s*:/.test(body);
}

export function createLlmSummarizer(options: LlmSummarizerOptions): LlmSummarize {
  const url = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const doFetch = options.fetch ?? fetch;
  // `tool_choice: "none"` keeps servers that inject global MCP tools from doing so.
  // Strict OpenAI rejects it without `tools` (HTTP 400): then retry once without and remember.
  let sendToolChoice = true;
  return async ({ relativePath, content }) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
    const post = () =>
      doFetch(url, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
        body: JSON.stringify({
          model: options.model,
          temperature: 0,
          max_tokens: 200,
          ...(sendToolChoice ? { tool_choice: "none" } : {}),
          messages: [
            {
              role: "system",
              content: options.systemPrompt ?? FILE_SYSTEM_PROMPT,
            },
            {
              role: "user",
              content: `${relativePath ? `File: ${relativePath}\n\n` : ""}${content.slice(0, MAX_LLM_CONTENT_CHARS)}`,
            },
          ],
        }),
      });
    let response = await post();
    if (response.status === 400 && sendToolChoice) {
      sendToolChoice = false;
      response = await post();
    }
    if (response.status === 401)
      throw new SummaryLlmAuthError(
        authMessage(options.apiKeyEnvName ?? DEFAULT_SUMMARY_LLM_API_KEY_ENV, !!options.apiKey),
      );
    if (!response.ok) throw new Error(`summary LLM answered HTTP ${response.status}`);
    const json = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const text = json.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("summary LLM returned an empty answer");
    if (looksLikeToolCall(text))
      throw new Error("summary LLM answered with a tool call instead of a summary (server injects tools?)");
    return text;
  };
}

export interface SummaryProviderOptions {
  llm?: LlmSummarize;
  onProblem?: (error: unknown) => void;
}

/** Resolves to a plain string, or a `FallbackSummary` when an LLM is configured but did not deliver. */
export function createSummaryProvider(
  options: SummaryProviderOptions,
): (input: SummaryInput) => Promise<string | FallbackSummary> {
  let failures = 0;
  return async (input) => {
    if (options.llm && failures < MAX_FAILURES) {
      try {
        const text = await options.llm({ relativePath: input.relativePath, content: input.content });
        failures = 0;
        return text;
      } catch (error) {
        failures++;
        options.onProblem?.(error);
      }
    }
    const text = buildDeterministicSummary(input);
    return options.llm ? { text, fallback: true } : text;
  };
}

export interface DocSummaryProviderOptions {
  llm?: LlmSummarize;
  onProblem?: (error: unknown) => void;
}

/** Summarizer for doc-tree nodes and whole documents; null (no summary) when the LLM is absent or failing. */
export function createDocSummaryProvider(
  options: DocSummaryProviderOptions,
): (text: string, kind: "node" | "document") => Promise<string | null> {
  let failures = 0;
  return async (text) => {
    if (!options.llm || failures >= MAX_FAILURES) return null;
    try {
      const summary = await options.llm({ relativePath: "", content: text });
      failures = 0;
      return summary;
    } catch (error) {
      failures++;
      options.onProblem?.(error);
      return null;
    }
  };
}
