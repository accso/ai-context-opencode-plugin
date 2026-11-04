import type { TelemetryEntry } from "./telemetry.js";

/** Tools of this plugin that replace blind searching. */
const CONTEXT_TOOLS = new Set([
  "semantic_search",
  "repo_structure",
  "analyze_impact",
  "search_docs",
  "find_symbol",
]);
/** Native tools an agent falls back to when searching by hand. */
const NATIVE_SEARCH_TOOLS = new Set(["grep", "glob", "list", "ls"]);

export interface SessionAdoption {
  sessionID: string;
  contextCalls: number;
  nativeSearchCalls: number;
  /** contextCalls / (contextCalls + nativeSearchCalls); null without any search call. */
  contextShare: number | null;
}

export interface Adoption extends Omit<SessionAdoption, "sessionID"> {
  contextByTool: Record<string, number>;
  bySession: SessionAdoption[];
}

function share(context: number, native: number): number | null {
  const total = context + native;
  return total === 0 ? null : context / total;
}

/** How often the agent used the context tools instead of grep/glob (ADR-0020). */
export function computeAdoption(entries: TelemetryEntry[]): Adoption {
  const contextByTool: Record<string, number> = {};
  const sessions = new Map<string, { context: number; native: number }>();
  let context = 0;
  let native = 0;

  for (const entry of entries) {
    const isContext = CONTEXT_TOOLS.has(entry.tool);
    const isNative = NATIVE_SEARCH_TOOLS.has(entry.tool);
    if (!isContext && !isNative) continue;
    const session = sessions.get(entry.sessionID) ?? { context: 0, native: 0 };
    if (isContext) {
      context++;
      session.context++;
      contextByTool[entry.tool] = (contextByTool[entry.tool] ?? 0) + 1;
    } else {
      native++;
      session.native++;
    }
    sessions.set(entry.sessionID, session);
  }

  return {
    contextCalls: context,
    nativeSearchCalls: native,
    contextShare: share(context, native),
    contextByTool: Object.fromEntries(
      Object.entries(contextByTool).sort(([a], [b]) => a.localeCompare(b)),
    ),
    bySession: [...sessions.entries()].map(([sessionID, s]) => ({
      sessionID,
      contextCalls: s.context,
      nativeSearchCalls: s.native,
      contextShare: share(s.context, s.native),
    })),
  };
}
