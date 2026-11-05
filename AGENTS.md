# dsh-acp

This is an ACP-only DeepSeek Harness distribution. Keep the runtime limited to the ACP profile and its dependency closure.

## Commands

- `pnpm install` — install workspace dependencies.
- `pnpm run build` — build native helpers, Typert artifacts, declarations, and runtime bundles.
- `pnpm test` — run the ACP protocol suite with a mock model.
- `pnpm run typecheck` — compile the retained TypeScript project graph.
- `pnpm start` — run the built ACP stdio server after a build.

Stdout is reserved for JSON-RPC. Do not add logging to stdout. Keep ACP wire changes in `packages/acp/acp` and cover them with focused tests in that package. Preserve the upstream MIT license and third-party notices.
