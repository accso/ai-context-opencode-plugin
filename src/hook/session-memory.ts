/**
 * Remembers which code locations the context tools returned in a session so
 * the compaction summary can keep them. Without it the agent loses every
 * search result when the context is compacted and searches again.
 */

export interface SessionMemoryOptions {
  maxEntries?: number;
}

export interface SessionMemory {
  record(sessionID: string, tool: string, output: unknown): void;
  /** Text to add to the compaction context, or null when nothing was found. */
  compactionBlock(sessionID: string): string | null;
}

const MAX_SESSIONS = 50;

function entry(path: unknown, start: unknown, end: unknown, label: unknown): string | null {
  if (typeof path !== "string" || typeof start !== "number") return null;
  const lines = typeof end === "number" && end !== start ? `${start}-${end}` : `${start}`;
  return `${path}:${lines}${typeof label === "string" && label ? ` (${label})` : ""}`;
}

function extract(tool: string, data: unknown): string[] {
  const out: (string | null)[] = [];
  const obj = data as Record<string, unknown> | null;
  if (tool === "semantic_search" && Array.isArray(data)) {
    for (const r of data as Record<string, unknown>[])
      out.push(entry(r?.relativePath, r?.startLine, r?.endLine, r?.symbol));
  } else if (tool === "find_symbol" && Array.isArray(obj?.matches)) {
    for (const r of obj.matches as Record<string, unknown>[])
      out.push(entry(r?.path, r?.startLine, r?.endLine, r?.name));
  } else if (tool === "analyze_impact" && Array.isArray(obj?.definitions)) {
    for (const r of obj.definitions as Record<string, unknown>[])
      out.push(entry(r?.path, r?.startLine, r?.endLine, obj.symbol));
  }
  return out.filter((e): e is string => e !== null);
}

export function createSessionMemory(options: SessionMemoryOptions = {}): SessionMemory {
  const max = options.maxEntries ?? 20;
  const sessions = new Map<string, string[]>();
  return {
    record(sessionID, tool, output) {
      if (typeof output !== "string") return;
      let data: unknown;
      try {
        data = JSON.parse(output);
      } catch {
        return;
      }
      const found = extract(tool, data);
      if (found.length === 0) return;
      const list = sessions.get(sessionID) ?? [];
      for (const item of found) {
        const at = list.indexOf(item);
        if (at >= 0) list.splice(at, 1);
        list.push(item);
      }
      sessions.delete(sessionID);
      sessions.set(sessionID, list.slice(-max));
      while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
    },
    compactionBlock(sessionID) {
      const list = sessions.get(sessionID);
      if (!list || list.length === 0) return null;
      return [
        "Code locations found earlier in this session with the ai-context tools (newest last). Re-open them with `read` instead of searching again:",
        ...list.map((e) => `- ${e}`),
        "The tools semantic_search, find_symbol, analyze_impact, repo_structure and search_docs stay available after compaction.",
      ].join("\n");
    },
  };
}
