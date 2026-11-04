# ADR-0010: Self-describing tool descriptions instead of a `SKILL.md` file

## Status

Accepted (simplify-skill-tool-delivery, 2026-09). Partly superseded by
[ADR-0020](0020-steer-agent-to-context-tools.md): descriptions remain the
main channel, but a system-prompt hint and a bundled `index-status` skill
were added.

## Context

OpenCode has a `skill` mechanism: a plugin can ship a `SKILL.md` file
that the agent discovers and loads via a `skill({name})` call before
using the capability it describes. An earlier iteration of this
plugin's design considered delivering workflow guidance (e.g. "prefer
`grep`/`glob` for exact identifier lookups; use `semantic_search` for
conceptual/fuzzy queries instead") via a `SKILL.md`.

OpenCode already surfaces every registered tool's `description` field
to the agent at tool-listing time, alongside every built-in tool
(`grep`, `glob`, `lsp`, etc.) -- the agent sees it "for free" as part of
normal tool discovery, before ever deciding whether to call anything.

## Decision

Carry the workflow guidance directly in each tool's `description`
string (e.g. `semantic_search`'s description explicitly says when to
prefer `grep`/`glob` instead), rather than via a separate `SKILL.md`
file and its associated discovery mechanism.

## Consequences

- No extra discovery round trip: a `SKILL.md`-based approach requires
  the agent to have already decided the skill is relevant enough to
  invoke `skill({name})` before it can read the guidance that would
  have helped it decide that in the first place. Description-embedded
  guidance is visible up front, at the same time every other tool's
  description is.
- Less indirection for maintainers too: the guidance lives right next
  to the tool definition it applies to (`src/tools/semantic-search.ts`
  etc.), not in a separate file that has to be kept in sync with the
  tool's actual behavior.
- This only applies to per-tool workflow guidance. It does not rule out
  a `SKILL.md`/skill mechanism for something that genuinely needs
  cross-tool, multi-step workflow orchestration guidance beyond what a
  single tool's description can carry -- this plugin simply hasn't
  needed that yet.

## Alternatives considered

- **A `SKILL.md` describing when/how to use `semantic_search` vs.
  native tools.** Rejected for the reason above: strictly adds
  indirection for a single-tool workflow hint that fits naturally in
  the tool's own description field.
