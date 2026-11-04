---
apply: always
---

# Test-driven development for this plugin

Scope: any change under `src/` or `scripts/`. Reference: `docs/development.md`
(workflow, test conventions). All tests are unit tests in `test/unit/`
(`node:test` via tsx); there are no integration or e2e tiers and no Docker.

## 1. Red → green → refactor

For any behavior change (bug fix, new capability, refactor with an observable effect):

1. **Red**: write or update the test first. For a bug, reproduce it in a test
   and confirm it fails against the current code before fixing.
2. **Green**: implement the minimal change that makes it pass.
3. **Refactor**: clean up with the suite as safety net; re-run after each step.

Pure documentation/comment changes need no test. A new `config.yaml` key still
needs a test in `config-file.test.ts` (and `config-template.test.ts` if it is
in the template).

## 2. Commands

```bash
npm run typecheck                                              # tsc --noEmit
npm run test:unit                                              # full suite
node --import tsx --test test/unit/<name>.test.ts              # one file while iterating
```

A change is done when the new test failed before, passes after, and the **full**
`typecheck` + `test:unit` run is green. Run the full suite, not only the new
test, since neighbouring tests catch regressions.

## 3. Test conventions

- Name the test file after the module (`src/indexing/doc-tree-builder.ts` →
  `test/unit/doc-tree-builder.test.ts`).
- Stores use `:memory:` or temporary directories; embedders, workers, LLM
  `fetch` and notifiers are injected fakes. Never call a real model or server.
- `test:unit` already disables OS notifications, skill/project-file writing and
  the shared worker through env vars; don't rely on them being on.
- Tests that open timers or sockets must close them, or the run hangs.
- Changing tool names or descriptions requires updating
  `test/unit/tool-descriptions.test.ts`.

## 4. Don't hide a discovered bug

If a test reveals an unrelated pre-existing bug: don't silently adapt the
expectation and don't silently fix it (scope creep). Assert the current
behavior explicitly with a comment marking it a known gap, and list it under
"Known limitations" in `docs/status.md`.

## 5. Release

After code changes that should reach opencode, use the `plugin-release` skill
(typecheck, tests, build, install, restart).

## 6. Index-shape changes need a version bump

If a change alters what gets stored for an already indexed file (chunk
boundaries, chunk text, doc-tree structure or summaries), bump
`CODE_INDEX_VERSION` / `DOC_INDEX_VERSION` in `src/indexing/indexing.ts`, or
unchanged files keep the old shape (ADR-0027). If the embedded text or vector
format changes, bump `EMBED_FORMAT_VERSION` in `src/indexing/embed-input.ts`
instead (full re-index). Say in your summary which one you bumped.
