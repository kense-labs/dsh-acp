# dsh-acp

An ACP-only distribution of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It keeps the agent loop, session persistence, model adapters, tool execution, MCP support, and the ACP stdio server; desktop, Web, experimental, website, and Python SDK packages are excluded.

The ACP implementation uses `@agentclientprotocol/sdk` 1.4.0 and supports initialization, authentication, session new/list/resume/close, prompts, cancellation, semantic session updates, permission requests, model and reasoning-effort configuration, and stdio or Streamable HTTP MCP servers.

## Run locally

Requirements: Node.js 24.9 or newer and pnpm 12.6.0.

```sh
pnpm install
pnpm run build
export DEEPSEEK_API_KEY=your_key
pnpm start
```

The process reads JSON-RPC messages from stdin and writes them to stdout. It exits when the client disconnects. Configure a different Harness home with `DSH_HOME`; the default model is `deepseek-v4-flash` on the `deepseek-official` route.

Useful commands:

```sh
pnpm test                 # ACP protocol tests with an in-memory mock model
pnpm run typecheck       # compile all retained TypeScript projects
pnpm dsh --profile acp --dump-default-config
```

## Container

```sh
docker build -f Containerfile -t dsh-acp .
docker run --rm -i \
  -e DEEPSEEK_API_KEY \
  -v dsh-acp-data:/data \
  -v "$PWD:/workspace" \
  dsh-acp
```

Mount the client workspace at `/workspace` and pass that absolute path as `cwd` in `session/new`. `/data` stores sessions and attachments. stdout is reserved for ACP traffic; diagnostics go to stderr.

## Upstream and license

This repository is derived from DeepSeek Harness and retains its MIT license and third-party notices. See `LICENSE` and `THIRD_PARTY_NOTICES.md`.
