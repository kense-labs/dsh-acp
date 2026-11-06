# `@deepseek-ai/dsh`

The `dsh` command launches the ACP-only DeepSeek Harness distribution.

```sh
dsh --profile acp
# shorthand
dsh acp
```

Both commands serve Agent Client Protocol JSON-RPC over stdin/stdout until the client disconnects. stdout is reserved for protocol traffic. Set `DEEPSEEK_API_KEY` before starting a turn and `DSH_HOME` to choose where sessions and attachments are stored.

## Launcher options

- `--patch <path>` applies an extra Cordis composition overlay; repeat the flag to apply several overlays in order.
- `--dump-config` prints the composed profile without starting it.
- `--dump-default-config` prints only the shipped bundle layers.
- `--dump-config-schema` prints declared plugin configuration schemas.
- `dsh plugin --profile acp <pnpm args>` manages additional packages in the ACP profile.

Run `pnpm run build` from the repository root before using the built CLI. `pnpm dsh --profile acp` runs the TypeScript entry during development, and `pnpm start` runs the built entry.

## kbox process-prewarm readiness

When `KBOX_PREWARM_READY=1`, the ACP server writes the exact `kbox-prewarm-ready-v1\n` marker to stderr after its stdio connection is mounted and model input capabilities have been resolved. The first `initialize` awaits that same capability-resolution operation instead of resolving model information again. stdout remains JSON-RPC only.

Start the public image with `kbox pool start --deferred --prewarm -e DEEPSEEK_API_KEY`, wait for `pool status --json` to report an idle instance, and connect with `kbox pool attach`. Each attachment owns one initialized process; disconnecting ends that process.
