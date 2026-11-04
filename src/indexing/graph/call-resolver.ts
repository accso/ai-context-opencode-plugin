import path from "node:path";

/**
 * Matches a call site against the symbols that could be its target, using
 * only name-level evidence (same file, imports, same directory, class or
 * module qualifier). Without type information a call like `repo.save()`
 * can't be pinned to one definition, so every result says how sure it is:
 * `ambiguous` means "confirm with the native `lsp` findReferences" and
 * `candidateCount` says how many definitions were still plausible.
 */

export interface CallCandidate {
  relativePath: string;
  name: string;
  kind: string;
  container?: string;
}

export interface CallSite {
  calleeName: string;
  qualifier?: string;
  /** `new` for constructors, `inject`/`decorator` for Angular type references, `jsx` for component tags. */
  kind?: string;
}

export interface CallResolutionContext {
  fromPath: string;
  /** Class/impl enclosing the caller; used for `this`/`self` calls. */
  callerContainer?: string;
  /** Every symbol named `calleeName` in the repo. */
  candidates: CallCandidate[];
  /** Files the caller's file imports (resolved). */
  importedFiles: ReadonlySet<string>;
}

export interface CallResolution {
  calleePath?: string;
  ambiguous: boolean;
  candidateCount?: number;
}

const CALLABLE_KINDS = new Set(["function", "method", "constructor", "macro"]);
const CLASS_LIKE_KINDS = new Set(["class", "struct", "record", "object"]);
const SELF_QUALIFIERS = new Set(["this", "self", "cls", "@"]);

const posix = path.posix;
const stemOf = (file: string) => file.slice(0, file.length - posix.extname(file).length);

function targetKey(c: CallCandidate, byPathOnly: boolean): string {
  return byPathOnly ? c.relativePath : `${c.relativePath}\u0000${c.container ?? ""}`;
}

function distinct(candidates: CallCandidate[], byPathOnly: boolean): CallCandidate[] {
  const seen = new Map<string, CallCandidate>();
  for (const c of candidates) if (!seen.has(targetKey(c, byPathOnly))) seen.set(targetKey(c, byPathOnly), c);
  return [...seen.values()];
}

export function resolveCall(call: CallSite, ctx: CallResolutionContext): CallResolution {
  const isNew = call.kind === "new";
  const isTypeRef = call.kind === "inject" || call.kind === "decorator";
  const named = ctx.candidates.filter((c) => c.name === call.calleeName && c.kind !== "selector");
  let pool = isNew || isTypeRef
    ? named.filter((c) => CLASS_LIKE_KINDS.has(c.kind) || c.kind === "constructor")
    : named.filter((c) => CALLABLE_KINDS.has(c.kind));
  if (pool.length === 0 && !isNew && !isTypeRef) pool = named.filter((c) => CLASS_LIKE_KINDS.has(c.kind));
  if (pool.length === 0 && isTypeRef) pool = named; // injection tokens, interfaces, constants
  pool = distinct(pool, isNew || isTypeRef);
  if (pool.length === 0) return { ambiguous: false };

  const narrow = (pred: (c: CallCandidate) => boolean): boolean => {
    const kept = pool.filter(pred);
    if (kept.length === 0) return false;
    pool = kept;
    return true;
  };
  const inImported = (c: CallCandidate) =>
    ctx.importedFiles.has(c.relativePath) ||
    [...ctx.importedFiles].some((f) => stemOf(f) === stemOf(c.relativePath)); // C header -> implementation pairing
  const sameDir = (c: CallCandidate) => posix.dirname(c.relativePath) === posix.dirname(ctx.fromPath);

  const qualifier = call.qualifier;
  const lastSegment = qualifier?.split(/[.:]+/).filter(Boolean).pop();
  let evidence = false;

  if (!qualifier) {
    evidence = narrow((c) => c.relativePath === ctx.fromPath) || narrow(inImported) || narrow(sameDir);
  } else if (SELF_QUALIFIERS.has(qualifier)) {
    evidence = narrow((c) => c.relativePath === ctx.fromPath);
    if (ctx.callerContainer && narrow((c) => c.container === ctx.callerContainer)) evidence = true;
  } else {
    evidence =
      narrow((c) => c.container === lastSegment) ||
      narrow((c) => stemOf(posix.basename(c.relativePath)) === lastSegment || posix.basename(posix.dirname(c.relativePath)) === lastSegment);
    // Import evidence only narrows a receiver of unknown type; it never makes the match certain.
    if (!evidence) narrow(inImported);
  }

  if (pool.length === 1) {
    return evidence
      ? { calleePath: pool[0]!.relativePath, ambiguous: false }
      : { calleePath: pool[0]!.relativePath, ambiguous: true, candidateCount: 1 };
  }
  return { ambiguous: true, candidateCount: pool.length };
}
