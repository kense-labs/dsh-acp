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
