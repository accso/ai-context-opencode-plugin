import { createHash } from "node:crypto";
import { appendAgentHint, linkedReposHint } from "./agent-hint.js";
import {
  NATIVE_TOOL_HINTS,
  classifyNativeSearch,
  nudgeText,
} from "./search-nudge.js";
import { ensurePluginGitignore } from "../config/gitignore-writer.js";
import { installBundledSkills } from "../skills/skill-installer.js";
import { ensureConfigFile, resetReindexFlags as resetReindexFlagsDefault } from "../config/config-template.js";
import {
  defaultOsNotifyGate,
  createFileOsNotifyGate,
  notifyOs,
  type OsNotifyGate,
} from "../observability/os-notify.js";
import { createErrorLog } from "../observability/error-log.js";
import { createToolLog } from "../observability/tool-log.js";
import { createProblemReporter } from "../observability/problem-reporter.js";
import { createProgressNotifier } from "../observability/progress-notifier.js";
import {
  createMemoryGuard,
  type MemoryGuard,
} from "../indexing/memory-guard.js";
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "@opencode-ai/plugin";
import type { ToolDefinition } from "../tools/tool-def.js";
import { createSessionMemory } from "./session-memory.js";
import { createFindSymbolTool } from "../tools/find-symbol.js";
import { createSemanticSearchTool } from "../tools/semantic-search.js";
import { createTelemetryReportTool } from "../tools/telemetry-report.js";
import {
  createIndexScheduler,
  type IndexScheduler,
} from "../indexing/index-scheduler.js";
import {
  createTelemetryRecorder,
  type TelemetryRecorder,
} from "../telemetry/telemetry.js";
import { initOtelMetrics, resolveOtelSettings } from "../telemetry/otel-sdk.js";
import { deriveProjectKey, resolveDataDir } from "../storage/project-key.js";
import {
  createVectorStore as createVectorStoreDefault,
  type VectorStore,
  type VectorStoreOptions,
} from "../storage/vector-store.js";
import {
  createDocTreeStore as createDocTreeStoreDefault,
  type DocTreeStore,
  type DocTreeStoreOptions,
} from "../storage/doc-tree-store.js";
import * as projectRegistryDefault from "../storage/project-registry.js";
import type { ProjectInfo } from "../storage/project-registry.js";
import {
  createListProjectsTool,
  createDeleteProjectTool,
  type ProjectRegistryDeps,
} from "../tools/manage-projects.js";
import { createIndexStatusTool } from "../tools/index-status.js";
import { createRepoStructureTool } from "../tools/repo-structure.js";
import { createExportIndexTreeTool, writeIndexTree } from "../tools/export-index-tree.js";
import { createSearchDocsTool } from "../tools/search-docs.js";
import {
  searchDocTrees,
  type DocTreeSearchMode,
  type DocTreeSearchOptions,
  type DocTreeSearchResult,
} from "../search/doc-tree-search.js";
import {
  resolveBackupFilePath,
  importBackup as importBackupDefault,
  exportBackup as exportBackupDefault,
  resolveDocTreeBackupFilePath,
  importDocTreeBackup as importDocTreeBackupDefault,
  exportDocTreeBackup as exportDocTreeBackupDefault,
  resolveGraphBackupFilePath,
  importGraphBackup as importGraphBackupDefault,
  exportGraphBackup as exportGraphBackupDefault,
} from "../storage/backup.js";
import {
  createGraphStore as createGraphStoreDefault,
  type GraphStore,
  type GraphStoreOptions,
} from "../storage/graph-store.js";
import { createGraphIndexer } from "../indexing/graph/graph-indexer.js";
import { createAnalyzeImpactTool } from "../tools/analyze-impact.js";
import { createExportBackupTool } from "../tools/manage-backup.js";
import { createRescanTool } from "../tools/rescan.js";
import { createRescanTrigger, editedFiles, mayChangeFiles } from "../indexing/rescan-trigger.js";
import {
  readAllowlist,
  addAllowedRepo as addAllowedRepoDefault,
} from "../storage/repo-allowlist.js";
import { createAllowRepoTool } from "../tools/manage-allowlist.js";
import { isHeavyModeEnabled } from "../config/heavy-mode.js";
import { createSharedEmbedder } from "../worker/shared-embedder.js";
import { fileURLToPath } from "node:url";
import {
  createDefaultEmbedder,
  createDefaultReranker,
} from "../embedding/model-runtime.js";
import { EMBED_FORMAT_VERSION } from "../indexing/embed-input.js";
import {
  createDocSummaryProvider,
  createLlmSummarizer,
  DOC_SYSTEM_PROMPT,
  createSummaryProvider,
  SummaryLlmAuthError,
} from "../indexing/file-summary.js";
import { createIndexLease, type IndexLease } from "../indexing/index-lease.js";
import {
  createIndexer,
  createFsReadFile,
  createFsFingerprint,
} from "../indexing/indexing.js";
import { walkRepoFiles } from "../indexing/repo-walker.js";
import { createFileFilter } from "../indexing/file-filter.js";
import { buildIndexingNotice } from "../indexing/index-notice.js";
import { DEFAULT_MAX_EMBED_TOKENS } from "../embedding/embedder.js";
import {
  defaultRuntimeRegistry,
  type RuntimeRegistry,
} from "./runtime-registry.js";
import { createProgressTracker } from "../indexing/index-progress.js";
import {
  createStatusFileWriter,
  resolveStatusFilePath,
  type StatusFileWriter,
} from "../indexing/status-file.js";
import {
  loadConfigFile as loadConfigFileDefault,
  DEFAULT_SUMMARY_LLM,
  DEFAULT_SUMMARY_LLM_API_KEY_ENV,
  type AiContextConfigFile,
} from "../config/config-file.js";

// Conservative for code (~3 chars/token); the embedder's token cap is the actual memory guarantee.
const CHARS_PER_TOKEN_ESTIMATE = 3;
/** Whole-process RSS ceiling for indexing (opencode host included); steady state is well under 1.5 GB. */
export const DEFAULT_MAX_MEMORY_MB = 6144;
export const DEFAULT_EMBED_CONCURRENCY = 3;
/** Minimum gap between two idle-triggered full rescans. */
const IDLE_RESCAN_MIN_INTERVAL_MS = 30_000;
const WATCHER_DEBOUNCE_MS = 2000; // mirrors the old watcher container's debounce window

/** `AI_CONTEXT_PLUGIN_ENABLED` (1/true, 0/false) wins over the config file; default is off. */
function isPluginEnabled(
  env: Record<string, string | undefined>,
  fromConfigFile: boolean | undefined,
): boolean {
  const raw = env.AI_CONTEXT_PLUGIN_ENABLED?.toLowerCase();
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return fromConfigFile === true;
}

export interface AiContextHooksDeps {
  /**
   * Host the hooks are built for. "v1" (OpenCode 1.x) has a native `lsp` tool, which the
   * plugin switches on and points the agent to; "v2" has none (ADR-0031). Default "v2".
   */
  host?: "v1" | "v2";
  scheduler?: IndexScheduler;
  reconcileOnStartup?: () => Promise<void>;
  /** Injectable for tests; one full rescan, resolving with the number of files found. Defaults to walk + index. */
  rescan?: () => Promise<number | undefined>;
  telemetry?: TelemetryRecorder;
  /** Current session's project root. Defaults to process.cwd(). */
  worktree?: string;
  /** The folder opencode was opened in; differs from `worktree` ("/") for non-git folders. */
  directory?: string;
  /**
   * Injectable for tests; defaults to loading the real
   * `.opencode/ai-context.config.yaml` from `worktree` (config-file.ts,
   * user-directed 2026-09-16). Passing this directly skips disk I/O in
   * tests and lets them exercise the config-file fallback precedence
   * without writing a real file.
   */
  configFile?: AiContextConfigFile;
  /** Injectable for tests; defaults to the real better-sqlite3-backed store. */
  createVectorStore?: (options: VectorStoreOptions) => VectorStore;
  /** Injectable for tests; defaults to the real better-sqlite3-backed doc-tree store (port-doc-tree-markdown). */
  createDocTreeStore?: (options: DocTreeStoreOptions) => DocTreeStore;
  /** Injectable for tests; defaults to the real fs-backed project-registry module. */
  projectRegistry?: ProjectRegistryDeps;
  /** Injectable for tests; defaults to the real lazy onnxruntime-node/tokenizers embedder (model-runtime.ts). */
  embedQuery?: (text: string) => Promise<number[]>;
  rerank?: (query: string, texts: string[]) => Promise<number[]>;
  /** Cross-process indexing lease; defaults to a lock file next to the project's database. */
  indexLease?: Pick<IndexLease, "run">;
  /** Injectable for tests; defaults to the same lazy embedder as embedQuery (shares its loaded model/session). */
  embedDocument?: (text: string) => Promise<number[]>;
  /** Injectable for tests; defaults to reading files off disk relative to `worktree` (indexing.ts). */
  readFile?: (relativePath: string) => Promise<string | null>;
  /**
   * Injectable for tests; defaults to file-filter.ts's real
   * extension-safelist + .gitignore filter built from `worktree`
   * (critical-review finding "repo-walker-ignore-filtering", plan.md).
   */
  shouldIndexFile?: (relativePath: string) => boolean;
  /** Injectable for tests; defaults to config-template.ts's in-place edit of the real config file. */
  resetReindexFlags?: (worktree: string, onError?: (error: unknown) => void) => boolean;
  /** Injectable for tests; defaults to the real repo-walker.ts implementation. */
  walkRepoFiles?: (
    worktree: string,
    options?: { exclude?: string[] },
  ) => Promise<string[]>;
  /** Injectable for tests; defaults to the real backup.ts implementation. */
  importBackup?: (store: VectorStore, filePath: string) => { count: number };
  /** Injectable for tests; defaults to the real backup.ts implementation. */
  exportBackup?: (store: VectorStore, filePath: string) => { count: number };
  /** Injectable for tests; defaults to the real backup.ts implementation (doc-tree-backup). */
  importDocTreeBackup?: (
    store: DocTreeStore,
    filePath: string,
  ) => { count: number };
  /** Injectable for tests; defaults to the real backup.ts implementation (doc-tree-backup). */
  exportDocTreeBackup?: (
    store: DocTreeStore,
    filePath: string,
  ) => { count: number };
  /** Injectable for tests; defaults to the real graph-store.ts implementation. */
  createGraphStore?: (options: GraphStoreOptions) => GraphStore;
  /** Injectable for tests; defaults to the real backup.ts implementation (graph backup). */
  importGraphBackup?: (
    store: GraphStore,
    filePath: string,
  ) => { count: number };
  /** Injectable for tests; defaults to the real backup.ts implementation (graph backup). */
  exportGraphBackup?: (
    store: GraphStore,
    filePath: string,
  ) => { count: number };
  /** Injectable for tests; defaults to the real repo-allowlist.ts implementation. */
  readAllowlist?: (worktree: string) => string[];
  /** Injectable for tests; defaults to the real repo-allowlist.ts implementation. */
  addAllowedRepo?: (
    worktree: string,
    name: string,
  ) => { added: boolean; keys: string[] };
  /**
   * Injectable for tests; defaults to `isHeavyModeEnabled()` (reads
   * `AI_CONTEXT_PLUGIN_HEAVY_MODE` from `process.env`). No longer gates
   * `analyze_impact` (always on, ADR-0006); kept as infrastructure for
   * future heavy-mode-only features.
   */
  heavyMode?: boolean;
  /** Injectable for tests; defaults to a writer for `.opencode/ai-context/index-status.json` in `worktree`. */
  statusWriter?: StatusFileWriter;
  /** Injectable for tests; defaults to the process-wide registry shared by all plugin instances. */
  runtimeRegistry?: RuntimeRegistry;
  /** Injectable for tests; defaults to writing the commented config template on first start. */
  /** Injectable for tests; defaults to installing bundled skills into <worktree>/.opencode/skills. */
  installSkills?: (worktree: string) => {
    installed: string[];
    problems: unknown[];
  };
  /** Injectable for tests; defaults to adding the status file to .opencode/.gitignore. */
  ensureGitignore?: (
    worktree: string,
    onError?: (error: unknown) => void,
  ) => unknown;
  ensureConfigFile?: (
    worktree: string,
    onError?: (error: unknown) => void,
  ) => unknown;
  /** Injectable for tests; defaults to a native OS notification. */
  osNotify?: (message: string) => void;
  /** Injectable for tests; defaults to the process-wide double-bootstrap gate. */
  osNotifyGate?: OsNotifyGate;
  /** Injectable for tests; defaults to a guard on `max_memory_mb`. */
  memoryGuard?: MemoryGuard;
}

/** One popup per opened folder: bootstraps of the same folder dedup, a different folder notifies again. */
export function nonGitNoticeGateKey(directory: string | undefined): string {
  const hash = createHash("sha1")
    .update(directory ?? "")
    .digest("hex")
    .slice(0, 12);
  return `non-git-${hash}`;
}

/**
 * Converts a (possibly absolute) path from a watcher event to a worktree-relative
 * POSIX path; `null` for paths outside the worktree or the worktree itself.
 */
export function toWorktreeRelative(worktree: string, file: string): string | null {
  const rel = path.isAbsolute(file) ? path.relative(worktree, file) : path.normalize(file);
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return null;
  }
  return rel.split(path.sep).join("/");
}

/**
 * AiContextPlugin -- lightweight OpenCode plugin replacing the Docker-based
 * MCP server, LSP bridge, and standalone file watcher that used to live
 * under `.ai-context/` (see the session's plan.md for the full rationale
 * and the overlap analysis against OpenCode's native tools).
 *
 * Registers:
 *  - native tools: `semantic_search` (core differentiator -- hybrid
 *    semantic/keyword search, nothing native replaces it).
 *    `analyze_impact` is always registered (ADR-0006): it answers from a
 *    precomputed symbol/import/call graph (`graph-store.ts`, kept current
 *    by `indexing/graph/graph-indexer.ts`), and flags ambiguous edges so
 *    the agent confirms them with the native `lsp` tool.
 *    `heavyMode`/`isHeavyModeEnabled()` (see `heavy-mode.ts`) no longer
 *    gates it.
 *  - a `config` hook that enables OpenCode's built-in LSP servers (off by
 *    default) so the native `lsp` tool actually works, since this plugin
 *    relies on it instead of a custom lsp-bridge -- without overriding an
 *    explicit user opt-out or clobbering existing per-server overrides.
 *  - an `event` hook reacting to `file.watcher.updated` to drive
 *    incremental re-indexing. This is deliberately `file.watcher.updated`
 *    and not `file.edited`: only the former fires for changes made by ANY
 *    process (external editors, `git pull`, other tools), matching what
 *    the old always-on watcher container had to catch. `file.edited`
 *    only fires for edits the agent itself made through its own tools.
 *    Notifications are coalesced in-process via `createIndexScheduler`
 *    (mirroring the old watcher's ~2s debounce), and a startup
 *    delta-reconciliation pass runs once when the plugin initializes to
 *    catch changes made while OpenCode wasn't running.
 *
 * Deliberately absent: no SKILL.md and no MCP server. Tool descriptions
 * carry the workflow guidance directly (visible to the agent at
 * tool-listing time, no extra discovery round trip), and tools are
 * native/in-process instead of behind an Express/StreamableHTTP/Docker
 * transport.
 *
 * Indexing pipeline (see indexing.ts, chunker.ts, repo-walker.ts): file
 * content is chunked with the paragraph-based fallback chunker (the one
 * chunking strategy ported so far -- full per-language tree-sitter
 * coverage from `watcher/chunker.py` is a deferred follow-up), embedded
 * via `embedDocument`, and upserted into this project's `VectorStore`.
 * The startup reconciliation pass walks the whole worktree once (see
 * `repo-walker.ts`'s skip-list for node_modules/.git/dist/etc. and this
 * plugin's own `.opencode/` metadata); subsequent changes come from the
 * debounced `file.watcher.updated` scheduler above.
 *
 * Also registers:
 *  - `tool.execute.before`/`tool.execute.after` hooks feeding an
 *    in-process `TelemetryRecorder` -- these fire for EVERY tool call in
 *    the session (native `grep`/`glob`/`lsp` included, not just this
 *    plugin's own tools), giving automatic latency telemetry with no
 *    agent self-instrumentation, unlike the existing
 *    `.github/skills/benchmark/scripts/bench.js` wrap/start/stop CLI.
 *  - a `ai_context_telemetry_report` native tool exposing the recorder's current
 *    summary -- the closest equivalent to a monitoring "endpoint" a
 *    plugin (no HTTP server) can offer.
 *
 * Per-repo isolation (user-directed, 2026-09-14): each plugin instance
 * derives a project-scoped vector-store file path from the session's
 * `worktree` via `deriveProjectKey` and creates its OWN
 * `VectorStore` instance pointed at it -- mirroring `watcher/db.py`'s
 * existing "one Qdrant collection per project" physical separation
 * rather than a shared table with a row filter, so a query against one
 * project's store literally cannot return another project's chunks. The
 * store's file lives outside the worktree by construction (see
 * `project-key.ts`), so the plugin's own writes to it never trigger its
 * own `file.watcher.updated` re-indexing.
 *
 * Repo-local backup (user-directed, 2026-09-15): unlike the live store
 * above, a JSONL export of it lives INSIDE the worktree at
 * `.opencode/ai-context/backup/index.jsonl` (see `backup.ts`) so a team
 * can commit it and new clones get the index without re-indexing from
 * scratch. On startup, if the (per-project, per-machine) store is
 * empty but a committed backup file exists, it's auto-imported; a
 * native `ai_context_export_backup` tool lets the agent/user trigger a
 * fresh export on demand (e.g. right before committing).
 *
 * Cross-repo search allow-list (user-directed, 2026-09-15): a repo can
 * opt into also searching other already-indexed repos (e.g. a library/
 * dependency) via `allowed_repos` in `.opencode/ai-context.config.yaml`
 * (see `repo-allowlist.ts`), softening `multi-repo-isolation`'s
 * default-deny separation only where the user explicitly asks for it.
 * `semantic_search` opens each allowed key's store (resolved through
 * `projectRegistry.listProjects()`) and merges its results in, tagged
 * with that project's key. A native `ai_context_allow_repo` tool lets
 * the agent add an entry, but only after validating the given key
 * actually exists in the registry -- never a freeform/guessed name.
 */
/**
 * opencode only emits `file.watcher.updated` while its file watcher runs, and that
 * watcher is opt-in (`OPENCODE_EXPERIMENTAL_FILEWATCHER`). Switch it on, unless the
 * user disabled it explicitly. Best effort like the LSP flag: opencode may already
 * have read the flag, so the rescan fallback (rescan-trigger.ts) stays in place.
 */
export function enableFileWatcher(env: NodeJS.ProcessEnv = process.env): void {
  const off = env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER;
  if (off && off !== "0" && off.toLowerCase() !== "false") return;
  env.OPENCODE_EXPERIMENTAL_FILEWATCHER ??= "true";
}

/**
 * The plugin core's host-neutral hook set. It has the shape of the OpenCode 1.x
 * hooks object (that is what the unit tests and the V1 `server()` entry use);
 * `v2-plugin.ts` maps every member onto the matching OpenCode 2.x API.
 */
export interface AiContextHooks {
  tool?: Record<string, ToolDefinition<any>>;
  "experimental.chat.system.transform"?: (
    input: unknown,
    output: { system: string[] },
  ) => Promise<void>;
  "experimental.session.compacting"?: (
    input: { sessionID: string },
    output: { context: string[] },
  ) => Promise<void>;
  /** OpenCode 1.x only: config mutation. Not used by the 2.x entry (no global config object there). */
  config?: (config: { lsp?: unknown; [key: string]: unknown }) => Promise<void>;
  event?: (input: {
    event: { type: string; properties?: any };
  }) => Promise<void>;
  /** Appends text to the description of a NATIVE tool (grep/glob steering, see search-nudge.ts). */
  "tool.definition"?: (
    input: { toolID: string },
    output: { description: string },
  ) => Promise<void>;
  "tool.execute.before"?: (
    input: { tool: string; sessionID: string; callID: string },
    output: { args: unknown },
  ) => Promise<void>;
  "tool.execute.after"?: (
    input: { tool: string; sessionID: string; callID: string; args?: unknown },
    output: { title?: string; output: string; metadata?: unknown },
  ) => Promise<void>;
}

export async function createAiContextHooks(
  deps: AiContextHooksDeps = {},
): Promise<AiContextHooks> {
  let telemetry = deps.telemetry ?? createTelemetryRecorder();

  const worktree = deps.worktree ?? process.cwd();
  const isV1 = deps.host === "v1";
  // opencode reports worktree "/" for a folder that is not a git repository;
  // writing `.opencode/` there fails (read-only root) and indexing would
  // scan the whole disk, so stay inert instead.
  if (path.resolve(worktree) === path.parse(path.resolve(worktree)).root) {
    const gate =
      deps.osNotifyGate ??
      createFileOsNotifyGate({
        key: nonGitNoticeGateKey(deps.directory),
        windowMs: 15_000,
      });
    if (
      (process.env.AI_CONTEXT_OS_NOTIFICATIONS !== "0" ||
        deps.osNotify !== undefined) &&
      gate.shouldNotify()
    ) {
      (deps.osNotify ?? notifyOs)(
        "Current folder is not a git repository - no indexing started.",
      );
    }
    return {};
  }
  // Project-level config file (`.opencode/ai-context.config.yaml`,
  // user-directed 2026-09-16): loaded once per session and threaded
  // through as the last-resort fallback for data_dir/model_cache_dir/
  // embed_dims/heavy_mode -- explicit options and env vars still win,
  // see each consuming resolve*/isHeavyModeEnabled function's own
  // precedence contract (config-file.ts, model-runtime.ts, heavy-mode.ts,
  // project-key.ts).
  // Native OS popups reach the user under every frontend, incl. ACP (observability.md).
  // `osNotificationsEnabled` is only known once the config is loaded, so problems
  // found while loading it are popped up unless the env switch is off.
  let osNotificationsEnabled = true;
  const osNotify =
    deps.osNotify ??
    ((message: string) => {
      if (process.env.AI_CONTEXT_OS_NOTIFICATIONS !== "0") notifyOs(message);
    });
  const errorLog = createErrorLog({
    filePath: path.join(worktree, ".opencode", "ai-context", "error.log.md"),
  });
  const problems = createProblemReporter({
    record: (context, error) => errorLog.record(context, error),
    notify: (message) => {
      if (osNotificationsEnabled) osNotify(message);
    },
    // injected notifier = test: keep the dedup state private
    seen: deps.osNotify ? new Map() : undefined,
  });
  if (!deps.configFile) {
    (deps.ensureConfigFile ?? ensureConfigFile)(worktree, (error) =>
      problems.report(
        "Could not create .opencode/ai-context.config.yaml",
        error,
      ),
    );
  }
  const configFile =
    deps.configFile ??
    loadConfigFileDefault(worktree, undefined, (message) =>
      problems.report("Config", message),
    );
  // Opt-in per repository: a missing key or a malformed file keeps the plugin off.
  if (!isPluginEnabled(process.env, configFile.enabled)) return {};
  errorLog.activate();
  // Opt-in OTLP metrics export; never fails or slows the plugin (see otel-sdk.ts).
  let otelShutdown: (() => Promise<void>) | undefined;
  if (!deps.telemetry) {
    try {
      const settings = resolveOtelSettings(path.basename(path.resolve(worktree)), configFile);
      if (settings.enabled) {
        const handle = initOtelMetrics({
          endpoint: settings.endpoint,
          flushMs: settings.flushMs,
          project: settings.project,
        });
        telemetry = createTelemetryRecorder({
          meter: handle.meter,
          project: settings.project,
          includeSessionId: settings.includeSessionId,
        });
        otelShutdown = handle.shutdown;
        process.once("beforeExit", () => void otelShutdown?.());
      }
    } catch (error) {
      console.error(`[ai-context] OTel metrics disabled: ${(error as Error).message}`);
    }
  }
  const toolLog = configFile.toolLog
    ? createToolLog({
        filePath: path.join(worktree, ".opencode", "ai-context", "tool.log.md"),
        fullResponses: configFile.toolLogFullResponses ?? false,
      })
    : undefined;
  if (process.env.AI_CONTEXT_PROJECT_FILES !== "0" || deps.ensureGitignore) {
    (deps.ensureGitignore ?? ensurePluginGitignore)(worktree, (error) =>
      problems.report("Could not update .opencode/.gitignore", error),
    );
  }
  osNotificationsEnabled = configFile.osNotifications ?? true;
  if (configFile.installSkills ?? true) {
    const install =
      deps.installSkills ??
      ((root: string) =>
        process.env.AI_CONTEXT_INSTALL_SKILLS === "0"
          ? { installed: [], problems: [] }
          : installBundledSkills(root));
    const { problems: skillProblems } = install(worktree);
    for (const error of skillProblems)
      problems.report("Could not install bundled skill", error);
  }
  // Indexing progress (ADR-0018): the tracker is the single source of truth,
  // mirrored to a status file the user can read from any frontend.
  const statusFilePath = resolveStatusFilePath(worktree);
  const indexTreeDeps = {
    filePath: path.join(path.dirname(statusFilePath), "index-tree.md"),
    worktree,
    listFiles: () => vectorStore.listFiles(),
    getIndexStatus: () => vectorStore.getIndexStatus(),
    getSkipped: () => progress.snapshot().failures.map((f) => `${f.file}: ${f.error}`),
  };
  const progressNotifier = createProgressNotifier({
    notify: (message) => {
      if (osNotificationsEnabled) osNotify(message);
    },
  });
  const statusWriter =
    deps.statusWriter ??
    createStatusFileWriter({
      filePath: statusFilePath,
      onError: (error) =>
        problems.report("Cannot write index-status.json", error),
    });
  // opencode bootstraps the plugin twice per session: share tracker, model
  // session, startup pass and batch serialisation per worktree (runtime-registry.ts).
  const runtime = (deps.runtimeRegistry ?? defaultRuntimeRegistry).get(
    worktree,
    () => ({
      progress: createProgressTracker({
        onFileFailed: (file, message) => errorLog.record(`Indexing failed: ${file}`, message),
        onChange: (snapshot) => {
          statusWriter.write(snapshot);
          progressNotifier(snapshot);
        },
      }),
    }),
  );
  const progress = runtime.progress;
  if (
    osNotificationsEnabled &&
    (deps.osNotifyGate ?? defaultOsNotifyGate).shouldNotify()
  ) {
    osNotify(`AI Context plugin started for ${path.basename(worktree)}.`);
  }
  const getIndexingNotice = () => buildIndexingNotice(progress.snapshot());
  const { dbPath } = deriveProjectKey(worktree, {
    fileDataDir: configFile.dataDir,
  });
  const createVectorStoreFn =
    deps.createVectorStore ?? createVectorStoreDefault;
  const vectorStore = createVectorStoreFn({
    path: dbPath,
    embedFormat: EMBED_FORMAT_VERSION,
  });
  // Doc-tree store lives alongside the vector store (same per-project
  // directory, same "outside the worktree" isolation guarantee from
  // project-key.ts) but in its own file -- trees and chunks are never
  // both populated for the same file (see indexing.ts's tree-vs-chunk
  // gate), so keeping them in separate stores avoids a shared schema.
  const createDocTreeStoreFn =
    deps.createDocTreeStore ?? createDocTreeStoreDefault;
  const docTreeDbPath = path.join(path.dirname(dbPath), "doc-trees.sqlite");
  const docTreeStore = createDocTreeStoreFn({ path: docTreeDbPath });
  // Lazily created (see model-runtime.ts:createLazyEmbedder) -- the
  // real onnxruntime-node session + tokenizer are only downloaded/loaded
  // on the FIRST semantic_search/indexing call, not here at hook-creation
  // time, and then reused for the life of this hooks instance. Shared
  // between embedQuery and embedDocument so indexing and searching don't
  // each load their own copy of the model. Created per-session (not a
  // module-level singleton) so `configFile.modelCacheDir`/
  // `configFile.embedDims` -- which can differ per worktree -- are
  // actually honored; safe since embedder creation itself stays cheap
  // and lazy (no test asserts singleton identity across sessions).
  const embedConcurrency =
    configFile.embedConcurrency ?? DEFAULT_EMBED_CONCURRENCY;
  const defaultEmbedder =
    deps.embedQuery && deps.embedDocument
      ? undefined
      : runtime.sharedEmbedder(() => {
          const embedOptions = {
            fileCacheDir: configFile.modelCacheDir,
            fileDims: configFile.embedDims,
            threads: configFile.embedThreads,
            maxTokens: configFile.embedMaxTokens,
          };
          const inProcess = () => {
            const embedder = createDefaultEmbedder({
              ...embedOptions,
              onModelLoading: (loading) => progress.setModelLoading(loading),
              onModelError: (error) =>
                problems.report("Embedding model could not be loaded", error),
            });
            const reranker = createDefaultReranker({
              fileCacheDir: configFile.modelCacheDir,
              threads: configFile.embedThreads,
              onModelError: (error) =>
                problems.report("Reranker model could not be loaded", error),
            });
            return { ...embedder, rerank: reranker.rerank };
          };
          return (
            createSharedEmbedder({
              dataDir: resolveDataDir({ fileDataDir: configFile.dataDir }),
              pluginDir: path.dirname(fileURLToPath(import.meta.url)),
              sharedWorker: configFile.sharedWorker,
              maxMemoryMb: configFile.maxMemoryMb,
              concurrency: embedConcurrency,
              embed: embedOptions,
              fallback: inProcess,
              onFallback: (error) =>
                problems.report(
                  "Shared embedding worker unavailable, embedding inside opencode",
                  error,
                ),
              onModelLoading: (loading) => progress.setModelLoading(loading),
              onWorkerError: (message) =>
                problems.report("Embedding worker error", new Error(message)),
            }) ?? inProcess()
          );
        });
  const embedQuery = deps.embedQuery ?? defaultEmbedder!.embedQuery;
  const embedDocument = deps.embedDocument ?? defaultEmbedder!.embedDocument;
  const rerank =
    configFile.reranker === false
      ? undefined
      : (deps.rerank ??
        (
          defaultEmbedder as
            | { rerank?: (q: string, t: string[]) => Promise<number[]> }
            | undefined
        )?.rerank);
  const readFile =
    deps.readFile ??
    createFsReadFile(worktree, { maxBytes: configFile.maxFileBytes });
  const walkRepoFilesFn = deps.walkRepoFiles ?? walkRepoFiles;
  const projectRegistry = deps.projectRegistry ?? projectRegistryDefault;
  const createGraphStoreFn = deps.createGraphStore ?? createGraphStoreDefault;
  const graphStore = createGraphStoreFn({
    path: path.join(path.dirname(dbPath), "graph.sqlite"),
  });
  const importGraphBackup = deps.importGraphBackup ?? importGraphBackupDefault;
  const exportGraphBackup = deps.exportGraphBackup ?? exportGraphBackupDefault;
  const graphBackupFilePath = resolveGraphBackupFilePath(worktree);
  const importBackup = deps.importBackup ?? importBackupDefault;
  const exportBackup = deps.exportBackup ?? exportBackupDefault;
  const importDocTreeBackup =
    deps.importDocTreeBackup ?? importDocTreeBackupDefault;
  const exportDocTreeBackup =
    deps.exportDocTreeBackup ?? exportDocTreeBackupDefault;
  const addAllowedRepo = deps.addAllowedRepo ?? addAllowedRepoDefault;
  const backupFilePath = resolveBackupFilePath(worktree);
  const docTreeBackupFilePath = resolveDocTreeBackupFilePath(worktree);
  const heavyMode =
    deps.heavyMode ?? isHeavyModeEnabled(process.env, configFile.heavyMode);

  // Document-side indexing pipeline: chunk -> embedDocument -> vectorStore
  // (see indexing.ts). Feeds both the debounced `file.watcher.updated`
  // scheduler below and the one-off startup reconciliation pass.
  const summaryLlm =
    configFile.summaryLlm === false
      ? undefined
      : (configFile.summaryLlm ?? DEFAULT_SUMMARY_LLM);
  const summaryApiKeyEnv =
    summaryLlm?.apiKeyEnv ?? DEFAULT_SUMMARY_LLM_API_KEY_ENV;
  const summarizeFile =
    configFile.fileSummaries === false
      ? undefined
      : createSummaryProvider({
          llm: summaryLlm
            ? createLlmSummarizer({
                baseUrl: summaryLlm.baseUrl,
                model: summaryLlm.model,
                apiKey: process.env[summaryApiKeyEnv],
                apiKeyEnvName: summaryApiKeyEnv,
                timeoutMs: summaryLlm.timeoutMs,
              })
            : undefined,
          onProblem: (error) => {
            if (error instanceof SummaryLlmAuthError)
              progress.addNotice(error.message);
            problems.report(
              "File summary LLM failed, using deterministic summaries",
              error,
            );
          },
        });
  const summarizeDoc = summaryLlm
    ? createDocSummaryProvider({
        llm: createLlmSummarizer({
          baseUrl: summaryLlm.baseUrl,
          model: summaryLlm.model,
          apiKey: process.env[summaryApiKeyEnv],
          apiKeyEnvName: summaryApiKeyEnv,
          timeoutMs: summaryLlm.timeoutMs,
          systemPrompt: DOC_SYSTEM_PROMPT,
        }),
        onProblem: (error) => {
          if (error instanceof SummaryLlmAuthError)
              progress.addNotice(error.message);
          problems.report(
            "Doc summary LLM failed, indexing docs without summaries",
            error,
          );
        },
      })
    : undefined;
  const indexLease =
    deps.indexLease ??
    createIndexLease({
      filePath: path.join(path.dirname(dbPath), "index.lock"),
    });
  const indexer = createIndexer({
    vectorStore,
    fileConcurrency: embedConcurrency,
    summarizeFile,
    summaryLlmConfigured: !!summaryLlm,
    summarize: summarizeDoc,
    fingerprint: createFsFingerprint(worktree),
    embedDocument,
    readFile,
    docTreeStore,
    shouldIndexFile:
      deps.shouldIndexFile ??
      createFileFilter(worktree, { exclude: configFile.exclude }),
    graphIndexer: createGraphIndexer({ store: graphStore }),
    progress,
    memoryGuard:
      deps.memoryGuard ??
      createMemoryGuard({
        limitMb: configFile.maxMemoryMb ?? DEFAULT_MAX_MEMORY_MB,
      }),
    maxChunkChars:
      (configFile.embedMaxTokens ?? DEFAULT_MAX_EMBED_TOKENS) *
      CHARS_PER_TOKEN_ESTIMATE,
  });

  enableFileWatcher();
  const scheduler =
    deps.scheduler ??
    createIndexScheduler({
      debounceMs: WATCHER_DEBOUNCE_MS,
      indexFiles: (batch) =>
        runtime.exclusive(() =>
          indexLease.run(async () => {
            await indexer.indexFiles(batch);
          }),
        ),
    });
  const reconcileOnStartup =
    deps.reconcileOnStartup ??
    (() =>
      runtime.reconcileOnce(async () => {
        // Full-repo walk (see repo-walker.ts) treating every file as an
        // "add" -- catches changes made while OpenCode wasn't running
        // (e.g. a `git pull` between sessions). Runs once per plugin
        // startup; incremental changes afterward come from
        // `file.watcher.updated` via the debounced scheduler above.
        // Swallow errors (e.g. worktree missing/unreadable) rather than
        // letting a startup reconciliation failure take down the whole
        // plugin -- semantic_search/other tools should still register.
        try {
          progress.setPhase("scanning");
          const files = await walkRepoFilesFn(worktree, {
            exclude: configFile.exclude,
          });
          // Files indexed earlier but gone (or now excluded): drop them.
          const present = new Set(files);
          const stale = [
            ...new Set([
              ...vectorStore.listFiles().map((f) => f.relativePath),
              ...docTreeStore.listPaths(),
            ]),
          ].filter((file) => !present.has(file));
          // Another opencode process may hold the lease; wait, then only
          // the files it did not finish are left (fingerprints skip the rest).
          const reindex = {
            chunks: configFile.reindexChunks === true,
            summaries: configFile.reindexSummaries === true,
          };
          const forced = reindex.chunks || reindex.summaries;
          const result = await runtime.exclusive(() =>
            indexLease.run(() =>
              indexer.indexFiles(
                [
                  ...stale.map((file) => ({ file, event: "unlink" as const })),
                  ...files.map((file) => ({ file, event: "add" as const })),
                ],
                forced ? { reindex } : undefined,
              ),
            ),
          );
          if (result?.complete) {
            try {
              writeIndexTree(indexTreeDeps);
            } catch (error) {
              problems.report("Cannot write index-tree.md", error);
            }
          }
          // Only a finished run counts; otherwise the flags stay on and it runs again next start.
          if (forced && result?.complete) {
            (deps.resetReindexFlags ?? resetReindexFlagsDefault)(
              worktree,
              (error) => problems.report("Could not reset the reindex flags in ai-context.config.yaml", error),
            );
          }
        } catch (error) {
          progress.fail(error);
          errorLog.record("Startup reconciliation failed", error);
          console.error(
            "[ai-context-opencode-plugin] startup reconciliation failed:",
            error,
          );
        }
      }));

  // Fallback for a silent opencode file watcher (see rescan-trigger.ts): walk the
  // worktree again and index what changed. Fingerprints skip unchanged files.
  const watcherStats = { events: 0, lastEventAt: null as string | null };
  const rescanTrigger = createRescanTrigger({
    onError: (error) => problems.report("Rescan failed", error),
    run:
      deps.rescan ??
      (async () => {
        const files = await walkRepoFilesFn(worktree, { exclude: configFile.exclude });
        const present = new Set(files);
        const stale = [
          ...new Set([
            ...vectorStore.listFiles().map((f) => f.relativePath),
            ...docTreeStore.listPaths(),
          ]),
        ].filter((file) => !present.has(file));
        await runtime.exclusive(() =>
          indexLease.run(async () => {
            await indexer.indexFiles([
              ...stale.map((file) => ({ file, event: "unlink" as const })),
              ...files.map((file) => ({ file, event: "add" as const })),
            ]);
          }),
        );
        return files.length;
      }),
  });

  // Repo-local backup, restore side: only import if this machine's
  // store is genuinely empty -- never overwrite live local data with
  // a (possibly stale) committed backup. Doc trees are restored the
  // same way, independently (a repo can have chunks but no tree-
  // indexed docs, or vice versa -- see doc-tree-backup, plan.md).
  const restore = (what: string, run: () => unknown) => {
    try {
      run();
    } catch (error) {
      problems.report(`Backup restore failed (${what})`, error);
    }
  };
  // Count only: getAllChunks() would parse every stored vector into memory on each start.
  if (vectorStore.getIndexStatus().chunkCount === 0) {
    restore("chunks", () => importBackup(vectorStore, backupFilePath));
  }
  if (docTreeStore.countTrees() === 0) {
    restore("doc trees", () =>
      importDocTreeBackup(docTreeStore, docTreeBackupFilePath),
    );
  }

  if (graphStore.listFiles().length === 0) {
    restore("graph", () => importGraphBackup(graphStore, graphBackupFilePath));
  }

  // Cross-repo search allow-list: resolve each allowed key to its
  // actual store path via the project registry (not the allow-list
  // file itself, which only stores keys) -- entries for repos that
  // were since deleted are silently skipped rather than erroring.
  const readAllowedNames = deps.readAllowlist ?? readAllowlist;
  const allowedNames = new Set(readAllowedNames(worktree));
  const knownProjects = projectRegistry.listProjects();
  const crossRepoStores: { key: string; store: VectorStore }[] = [];
  const crossRepoGraphs: { key: string; store: GraphStore }[] = [];
  const crossRepoDocs: {
    key: string;
    searchDocTrees: (
      query: string,
      mode: DocTreeSearchMode,
      limit: number,
      options?: DocTreeSearchOptions,
    ) => DocTreeSearchResult[];
    listPaths: () => string[];
  }[] = [];
  // Cross-repo entries are addressed by project NAME (key without hash).
  // If several clones share a name, the most recently updated one wins.
  const newestByName = (projects: ProjectInfo[], name: string) =>
    projects
      .filter((p) => p.name === name)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  const openCrossRepo = (project: { name: string; dbPath: string }) => {
    if (crossRepoStores.some((s) => s.key === project.name)) return;
    try {
      crossRepoStores.push({
        key: project.name,
        store: createVectorStoreFn({ path: project.dbPath }),
      });
    } catch (error) {
      problems.report(`Could not open allowed repo ${project.name}`, error);
      return;
    }
    const graphPath = path.join(path.dirname(project.dbPath), "graph.sqlite");
    try {
      // never create an empty graph DB inside another project's folder
      if (fs.existsSync(graphPath))
        crossRepoGraphs.push({
          key: project.name,
          store: createGraphStoreFn({ path: graphPath }),
        });
    } catch {
      // symbol lookup in that repo is optional
    }
    const docsPath = path.join(
      path.dirname(project.dbPath),
      "doc-trees.sqlite",
    );
    try {
      if (fs.existsSync(docsPath)) {
        const docStore = createDocTreeStoreFn({ path: docsPath });
        crossRepoDocs.push({
          key: project.name,
          searchDocTrees: (query, mode, limit, options) =>
            searchDocTrees(docStore, query, mode, limit, options),
          listPaths: () => docStore.listPaths(),
        });
      }
    } catch {
      // doc search in that repo is optional
    }
  };
  for (const name of allowedNames) {
    const project = newestByName(knownProjects, name);
    if (project) openCrossRepo(project);
  }

  // Startup delta-reconciliation pass -- runs once, here, because hooks
  // only fire while OpenCode is actually running (replaces the old
  // always-on watcher container, not the reconciliation logic itself).
  // Deliberately not awaited: the first run embeds every file of the repo
  // and can take minutes, and OpenCode (ACP clients especially) waits for
  // this factory before answering `initialize`. Tools are usable straight
  // away and fill with results as indexing progresses.
  reconcileOnStartup().catch((error) => {
    console.error(
      "[ai-context-opencode-plugin] startup reconciliation failed:",
      error,
    );
  });

  const sessionMemory = createSessionMemory();
  return {
    tool: {
      semantic_search: createSemanticSearchTool({
        vectorStore,
        embedQuery,
        rerank,
        crossRepoStores,
        getIndexingNotice,
      }),
      repo_structure: createRepoStructureTool({
        listFiles: () => vectorStore.listFiles(),
        listDocPaths: () => docTreeStore.listPaths(),
        crossRepoDocPaths: crossRepoDocs,
        crossRepoStores,
        getIndexingNotice,
      }),
      analyze_impact: createAnalyzeImpactTool({
        lsp: isV1,
        graphStore,
        crossRepoGraphs,
        getIndexingNotice,
      }),
      find_symbol: createFindSymbolTool({
        lsp: isV1,
        graphStore,
        crossRepoGraphs,
        getIndexingNotice,
      }),
      ai_context_export_index_tree: createExportIndexTreeTool(indexTreeDeps),
      ai_context_telemetry_report: createTelemetryReportTool(telemetry),
      ai_context_list_projects: createListProjectsTool(projectRegistry),
      ai_context_delete_project: createDeleteProjectTool(projectRegistry),
      index_status: createIndexStatusTool({
        getIndexStatus: () => vectorStore.getIndexStatus(),
        getRecentChanges: (limit) => vectorStore.getRecentChanges(limit),
        getProgress: () => progress.snapshot(),
        statusFilePath,
        getWatcher: () => ({
          eventsReceived: watcherStats.events,
          lastEventAt: watcherStats.lastEventAt,
          rescan: rescanTrigger.stats(),
        }),
      }),
      search_docs: createSearchDocsTool({
        searchDocTrees: (query, mode, limit, options) =>
          searchDocTrees(docTreeStore, query, mode, limit, options),
        crossRepoDocs,
        getIndexingNotice,
      }),
      ai_context_rescan: createRescanTool({ trigger: rescanTrigger }),
      ai_context_export_backup: createExportBackupTool({
        vectorStore,
        backupFilePath,
        exportBackup,
        docTreeStore,
        docTreeBackupFilePath,
        exportDocTreeBackup,
        graphStore,
        graphBackupFilePath,
        exportGraphBackup,
      }),
      ai_context_allow_repo: createAllowRepoTool({
        worktree,
        listProjects: () => projectRegistry.listProjects(),
        addAllowedRepo: (wt, name) => {
          const result = addAllowedRepo(wt, name);
          const project = newestByName(projectRegistry.listProjects(), name);
          if (project) openCrossRepo(project);
          return result;
        },
      }),
    },
    "experimental.chat.system.transform": async (_input, output) => {
      if (!(configFile.agentHint ?? true)) return;
      appendAgentHint(output.system, { lsp: isV1, codeMode: deps.host === "v2" });
      let linked: string | undefined;
      try {
        linked = linkedReposHint(readAllowedNames(worktree));
      } catch {
        // unreadable allow-list: skip the block, the static hint still applies
      }
      if (linked && !output.system.includes(linked)) output.system.push(linked);
    },
    "experimental.session.compacting": async (input, output) => {
      if (configFile.agentHint === false) return;
      const block = sessionMemory.compactionBlock(input.sessionID);
      if (block) output.context.push(block);
    },
    // OpenCode 1.x only (2.x has no global config object, always watches files
    // and runs no language servers: ADR-0031, docs/lsp-roadmap.md).
    config: async (config) => {
      enableFileWatcher();
      if (!isV1) return;
      // Enable 1.x's built-in LSP servers (off by default: `lsp` undefined means
      // disabled) because the agent is pointed at the native `lsp` tool. Never
      // override an explicit `lsp: false`, never clobber per-server overrides.
      if (config.lsp === false) return;
      if (config.lsp === undefined) config.lsp = {};
      // The `lsp` tool is gated by OPENCODE_EXPERIMENTAL_LSP_TOOL, read when the
      // tool registry is built -- possibly before plugins load, so best effort;
      // export it in the environment that starts opencode (README).
      process.env.OPENCODE_EXPERIMENTAL_LSP_TOOL ??= "true";
    },
    "tool.definition": async (input, output) => {
      if (!(configFile.agentHint ?? true)) return;
      const hint = (NATIVE_TOOL_HINTS as Record<string, string | undefined>)[input.toolID];
      if (hint && !output.description.includes(hint)) output.description += `\n\n${hint}`;
    },
    event: async ({ event }) => {
      if ((event.type as string) === "server.instance.disposed") {
        await otelShutdown?.();
        otelShutdown = undefined;
        return;
      }
      if (event.type === "session.idle") {
        // Catches changes made outside the agent (IDE, git, other tools) while a
        // session was running; a walk is cheap (fingerprints), but not every turn.
        const last = rescanTrigger.stats().lastRunAt;
        if (!last || Date.now() - Date.parse(last) > IDLE_RESCAN_MIN_INTERVAL_MS) {
          rescanTrigger.notify("session.idle");
        }
        return;
      }
      if (event.type !== "file.watcher.updated") return;
      watcherStats.events++;
      watcherStats.lastEventAt = new Date().toISOString();
      // opencode reports ABSOLUTE paths; the index, the filters (`ignore`
      // throws on absolute paths) and the walker all use worktree-relative
      // POSIX paths.
      const relative = toWorktreeRelative(worktree, event.properties.file);
      if (relative === null) return; // outside the worktree
      scheduler.notify(relative, event.properties.event);
    },
    "tool.execute.before": async (input, output) => {
      toolLog?.request({
        tool: input.tool,
        sessionID: input.sessionID,
        callID: input.callID,
        args: output.args,
      });
      telemetry.recordStart({
        tool: input.tool,
        sessionID: input.sessionID,
        callID: input.callID,
        args: output.args,
      });
    },
    "tool.execute.after": async (input, output) => {
      toolLog?.response({
        tool: input.tool,
        sessionID: input.sessionID,
        callID: input.callID,
        output: output.output,
      });
      telemetry.recordEnd({
        tool: input.tool,
        sessionID: input.sessionID,
        callID: input.callID,
        output: output.output,
      });
      sessionMemory.record(input.sessionID, input.tool, output.output);
      if (mayChangeFiles(input.tool)) {
        // Known files (edit/write/patch): index just those; unknown (shell, IDE tools): full rescan.
        const edited = editedFiles(input.tool, input.args);
        if (edited) {
          for (const { file, event } of edited) {
            const relative = toWorktreeRelative(worktree, file);
            if (relative !== null) scheduler.notify(relative, event);
          }
        } else {
          rescanTrigger.notify(input.tool);
        }
      }
      if (configFile.agentHint ?? true) {
        const kind = classifyNativeSearch(input.tool, input.args, output.output);
        if (kind) output.output = `${output.output}\n\n${nudgeText(kind)}`;
      }
    },
  };
}

/** OpenCode 1.x plugin function (`server()` of the entry). */
export const AiContextPlugin: Plugin = async (input) =>
  (await createAiContextHooks({
    worktree: input.worktree,
    directory: input.directory,
    host: "v1",
  })) as Awaited<ReturnType<Plugin>>;

export default AiContextPlugin;
