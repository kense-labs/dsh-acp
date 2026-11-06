# dsh-acp

An ACP-only distribution of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): a DeepSeek agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com) over stdio, so any ACP-compatible TUI, GUI, or editor can drive it.

Includes the agent loop, session persistence, model adapters, tool execution, and MCP support.

English | [简体中文](README.zh-CN.md)

Public container image: [`ghcr.io/kense-labs/dsh-acp`](https://github.com/orgs/kense-labs/packages/container/dsh-acp) — anonymous pull, no registry login.

## How it works

dsh-acp is a **process, not a daemon**. There is no port to connect to and nothing to keep running:

- Your client (TUI/GUI) launches the process and talks JSON-RPC over stdin/stdout.
- stdout is reserved for ACP traffic; diagnostics go to stderr.
- The process exits when the client disconnects. One client, one agent process.
- Sessions and attachments live in `DSH_HOME` (`/data` in the container image), so history survives process restarts via `session/list` and `session/resume`.

The default model is `deepseek-flash` on the `deepseek-official` route. Set `DEEPSEEK_API_KEY` to authenticate.

## Run with kbox (recommended)

[kbox](https://github.com/kense-labs/kbox) runs the agent in an isolated MicroVM. The image is public on GitHub Container Registry — **no registry login required**.

Install kbox from the [kense releases](https://github.com/kense-labs/kense/releases/tag/kbox-v3.2.7), then:

```sh
export DEEPSEEK_API_KEY=your_key

kbox run -i --rm \
  --memory 2g \
  -v dsh-acp-data:/data \
  -v "$PWD:/workspace" \
  -e DEEPSEEK_API_KEY \
  ghcr.io/kense-labs/dsh-acp:latest
```

- `-i` connects your client's stdio to the agent — this is the whole "service".
- `--rm` removes the box when the agent exits: close the client and everything is cleaned up.
- `-v dsh-acp-data:/data` persists sessions across runs.
- `-v "$PWD:/workspace"` mounts your project; pass `/workspace` as `cwd` in `session/new`.
- `-e DEEPSEEK_API_KEY` inherits the key from your environment; it never enters the image.

For repeatable deployments, pin the image digest instead of `latest`.

## Integrate a TUI / GUI client

Point your ACP client's agent command at kbox. For example, as a generic client configuration:

```json
{
  "command": "kbox",
  "args": [
    "run", "-i", "--rm", "--memory", "2g",
    "-v", "dsh-acp-data:/data",
    "-v", "/path/to/project:/workspace",
    "-e", "DEEPSEEK_API_KEY",
    "ghcr.io/kense-labs/dsh-acp:latest"
  ],
  "env": { "DEEPSEEK_API_KEY": "your_key" }
}
```

The client spawns a fresh isolated VM per session and the VM disappears on disconnect. Expect roughly 20–25 s of VM startup on the first launch; subsequent launches reuse cached images.

## ACP surface

Implemented with `@agentclientprotocol/sdk` 1.4.0:

- initialization and authentication
- `session/new`, `session/list`, `session/resume`, `session/close`
- prompts, cancellation, and streaming `session/update` notifications
- permission requests
- model and reasoning-effort configuration
- stdio and Streamable HTTP MCP servers

## Run locally (development)

Requirements: Node.js 24.9 or newer and pnpm 12.6.0.

```sh
pnpm install
pnpm run build
export DEEPSEEK_API_KEY=your_key
pnpm start
```

Useful commands:

```sh
pnpm test                 # ACP protocol tests with an in-memory mock model
pnpm run typecheck        # compile the TypeScript project graph
pnpm dsh --profile acp --dump-default-config
```

## License

This repository is derived from DeepSeek Harness and retains its MIT license and third-party notices. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

```text
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
