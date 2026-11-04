---
name: plugin-release
description: >
  Use after changing code in ai-context-opencode-plugin: verifies (typecheck,
  unit tests), builds the single bundle and installs it into
  ~/.config/opencode/plugins, then tells the user to restart opencode.
---

# Build and install ai-context-opencode-plugin

Run from `ai-context-opencode-plugin/`. Stop at the first failing step and fix
it before continuing. Commits are made by the user.

1. `npm run typecheck`
2. `npm run test:unit` (a plugin test can flake once; rerun before debugging)
3. `npm run build` (writes `dist/accso-ai-context.js` and the worker script)
4. `./scripts/install-plugin.sh` (installs the bundle and worker, ensures runtime deps)
5. Verify: `ls -l dist/accso-ai-context.js ~/.config/opencode/plugins/accso-ai-context.js` shows a fresh timestamp.
6. Tell the user to restart opencode. An old shared worker keeps running until
   10 min idle; to replace it sooner, kill its PID (never use pkill).

Notes:
- Changing `EMBED_FORMAT_VERSION` triggers a full re-index on the next start; say so.
- Existing `.opencode/ai-context.config.yaml` files are never rewritten; new
  keys only appear in the template for new projects, defaults still apply.
