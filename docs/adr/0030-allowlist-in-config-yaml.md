# ADR-0030: Cross-repo allowlist lives in `ai-context.config.yaml`

## Status

Accepted (2026-10-19). Amends [ADR-0014](0014-project-config-file-precedence.md)
and [ADR-0026](0026-cross-repo-tools-and-parallel-indexing.md).

## Context

The allowlist of other indexed projects lived in a separate file,
`.opencode/ai-context/config/allowed-repos.json`, next to the generated
artifacts (status, backup). It is a human decision, not generated data, so it
was in the wrong place, and the project had two config locations and formats.
The file was separate because the tool writes it as JSON and the allowlist is
applied live, while the YAML is read once at startup.

## Decision

- The allowlist is the `allowed_repos` key (list of project names, no hash) of
  `.opencode/ai-context.config.yaml`.
- `ai_context_allow_repo` edits the key in place with the `yaml` document API:
  comments and other keys stay. A short comment above the key says the plugin
  writes it. Malformed YAML makes the write fail with an error instead of
  overwriting the file.
- The key is re-read from disk on every call (not part of the startup config),
  so changes still apply without a restart (ADR-0026).
- Rule of thumb: `.opencode/ai-context.config.yaml` holds what people decide;
  `.opencode/ai-context/` holds what the plugin generates.
- Migration: the first read imports a legacy
  `ai-context/config/allowed-repos.json` into the YAML and removes it (and the
  empty `config/` folder).

## Consequences

- One config file, no `config/` subfolder.
- An allowlist change shows up in the same diff as other settings; review it
  like any config change ([data boundary](../data-boundary.md)).
- A concurrent manual edit of the YAML and a plugin write can collide; the
  window is small because the list rarely changes.

## Alternatives considered

- Keep the JSON file and only flatten its path: smallest change, but leaves two
  config formats.
- Move the whole config into `.opencode/ai-context/`: mixes hand-edited config
  with generated and ignored files.
