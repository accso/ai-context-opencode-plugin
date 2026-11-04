/**
 * Steers the agent away from blind grep/glob exploration (ADR-0020, ADR-0031).
 *
 * The system-prompt hint alone is not enough: agents still start with
 * `glob **\/*.kt` or `grep "how is the retry handled"` when they do not know
 * the exact name. Two extra levers, both cheap and placed exactly where the
 * agent makes the mistake:
 *
 *  1. a short suffix on the NATIVE grep/glob tool descriptions (OpenCode 1.x
 *     `tool.definition`, 2.x `ctx.tool.transform`), seen on every request;
 *  2. a one-line note appended to the RESULT of a grep/glob call that looks
 *     exploratory, i.e. the moment the wrong tool was just used.
 *
 * Calls that look like a lookup of an exact, already known string are left alone:
 * that is what grep is for.
 */

/** Native tool ids whose description gets the suffix. */
export const NATIVE_SEARCH_TOOL_IDS = ["grep", "glob"] as const;

export const NATIVE_TOOL_HINTS: Record<(typeof NATIVE_SEARCH_TOOL_IDS)[number], string> = {
  glob:
    "Only for files whose NAME you already know. Do not list files by extension (e.g. `**/*.kt`) to explore: " +
    "use `repo_structure` for layout, `find_symbol` for a class/function name, `semantic_search` for a concept.",
  grep:
    "Only for an exact identifier or literal string you have already seen. If you do not know the exact wording " +
    "(\"where/how is X handled\"), call `semantic_search` FIRST; use `find_symbol` for a known name and " +
    "`search_docs` for Markdown. Do not grep by file extension to explore.",
};

export type NudgeKind = "extension-glob" | "exploratory-grep" | "empty-result";

const NUDGES: Record<NudgeKind, string> = {
  "extension-glob":
    "[ai-context] Listing files by extension is blind exploration. Use `repo_structure` (layout), " +
    "`find_symbol` (known name) or `semantic_search` (concept) instead.",
  "exploratory-grep":
    "[ai-context] This looks like a search for something whose exact wording you do not know. " +
    "`semantic_search` (concepts), `find_symbol` (names) and `search_docs` (Markdown) find it by meaning; try them before more grep.",
  "empty-result":
    "[ai-context] No match: the code may use different wording. Try `semantic_search` with a description of what it does.",
};

export function nudgeText(kind: NudgeKind): string {
  return NUDGES[kind];
}

/** `**\/*.kt`, `*.java`, `src/**\/*.{ts,tsx}`: only wildcards and an extension, no literal file name. */
export function isExtensionOnlyGlob(pattern: string): boolean {
  const last = pattern.split("/").pop() ?? pattern;
  return /^\*+\.(\w+|\{[\w,]+\})$/.test(last) || last === "*" || last === "**";
}

const IDENTIFIER = /^[A-Za-z_$][\w$.:#/\\-]*$/;

/**
 * Does a grep pattern look like a descriptive/guessing search rather than an exact token?
 * Natural-language phrases (3+ words), long alternations (3+ `|` branches) and
 * `.*` chains are exploratory; a single identifier or a short literal is not.
 */
export function isExploratoryGrep(pattern: string, literal = false): boolean {
  const p = pattern.trim();
  if (p.length === 0) return false;
  if (IDENTIFIER.test(p)) return false;
  if (!literal && p.split("|").filter((branch) => branch.trim().length > 0).length >= 3) return true;
  if (/(\.\*|\.\+).*(\.\*|\.\+)/.test(p)) return true;
  const words = p.split(/\s+/).filter((w) => /[A-Za-z]{2,}/.test(w));
  return words.length >= 3;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Which nudge (if any) applies to a finished native grep/glob call. */
export function classifyNativeSearch(tool: string, args: unknown, output: string): NudgeKind | null {
  const input = asRecord(args);
  const pattern = typeof input.pattern === "string" ? input.pattern : "";
  if (tool === "glob") {
    return pattern && isExtensionOnlyGlob(pattern) ? "extension-glob" : null;
  }
  if (tool === "grep") {
    if (isExploratoryGrep(pattern, input.literal === true)) return "exploratory-grep";
    const empty = output.trim().length === 0 || /^no (files|matches)/i.test(output.trim());
    // An exact-token miss is the classic "named differently" case worth one hint.
    if (empty && pattern.length > 0) return "empty-result";
  }
  return null;
}
