# Development

```bash
npm install
npm run typecheck     # tsc --noEmit
npm run test:unit     # node:test via tsx, no build step
npm run build         # esbuild: plugin bundle + worker bundle in dist/
./scripts/install-plugin.sh
npm run licenses      # regenerate THIRD-PARTY-LICENSES.md after changing dependencies
npm run licenses:check # fail if it is out of date
npm run dump-ast      # inspect a tree-sitter AST while writing extractors
```

With [mise](https://mise.jdx.dev/), `mise.toml` wraps the same commands
(`mise run test`, `mise run typecheck`, `mise run setup`) with a pinned Node
version; `build`, `test`, `typecheck` and `setup` run `npm install` first, so a fresh checkout needs only `mise install && mise run setup`. It is self-contained so the package can be extracted to its own repo.

## Workflow

Test first: write or update the failing test, implement, then run
`npm run typecheck` and `npm run test:unit`. Keep steps small; one decision
that is hard to reverse gets an ADR in [adr/](adr/README.md).

## Testing

- All tests are unit tests in `test/unit/` (`node:test`); stores use temporary
  directories, embedders and workers are injected fakes.
- `test:unit` sets `AI_CONTEXT_OS_NOTIFICATIONS=0`, `AI_CONTEXT_INSTALL_SKILLS=0`,
  `AI_CONTEXT_PROJECT_FILES=0` and `AI_CONTEXT_SHARED_WORKER=0` so tests never
  pop up notifications, write project files or spawn a worker.
- Mock stores must provide `listFiles`, `getChunksPage`, `getIndexStatus`
  (and `countTrees`, `listPaths` for doc-tree stores).
- `test/unit/tool-descriptions.test.ts` locks the tool naming scheme and the
  essential description content.
- Tests that open timers or sockets must close them; a leaked handle hangs the
  run (the worker's idle timer once did).

## Conventions

- Prefer the code intelligence of the IDE; no new dependency without need.
- Changing how files are chunked, tree-indexed or summarized? Bump `CODE_INDEX_VERSION` /
  `DOC_INDEX_VERSION` (`src/indexing/indexing.ts`, [ADR-0027](adr/0027-self-healing-reindex.md));
  changing embedded text or vectors bumps `EMBED_FORMAT_VERSION` instead.
- Comments only where the code needs clarification.
- macOS caveats for scripts: no `timeout`, `sed -i` needs a backup suffix.
