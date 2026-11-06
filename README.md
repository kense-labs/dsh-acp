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
  -u root \
  -v dsh-acp-data:/data \
  -v "$PWD:/workspace" \
  -e DEEPSEEK_API_KEY \
  ghcr.io/kense-labs/dsh-acp:latest
```

- `-i` connects your client's stdio to the agent — this is the whole "service".
- `--rm` removes the box when the agent exits: close the client and everything is cleaned up.
- `-u root` runs the agent as root inside the VM so it can write to the named volume (`/data` must be writable; the volume is not owned by the image's `node` user).
- `-v dsh-acp-data:/data` persists sessions across runs.
- `-v "$PWD:/workspace"` mounts your project; pass `/workspace` as `cwd` in `session/new`.
- `-e DEEPSEEK_API_KEY` inherits the key from your environment; it never enters the image.

For repeatable deployments, pin the image digest instead of `latest`.

## Hello world: send a greeting, get a live model reply

The repository ships a zero-dependency example that starts the VM, performs the ACP handshake, sends one greeting (customizable), and streams the model's reply:

```sh
git clone https://github.com/kense-labs/dsh-acp.git
cd dsh-acp
export DEEPSEEK_API_KEY=your_key
python3 examples/acp_hello.py
# or your own greeting: python3 examples/acp_hello.py "Say hello in English"
```

Example run (actual output, DeepSeek live API):

```text
Starting ghcr.io/kense-labs/dsh-acp:latest in kbox (first VM boot takes ~20 s)...
Connected: deepseek-harness-acp 0.0.1
You: 你好！请用一句话介绍你自己。
dsh-acp: 你好！我是 DeepSeek Harness 驱动的编码智能体，可以帮你阅读代码、编写与调试程序、执行命令，并通过网络检索资料来完成开发任务。
(stop: end_turn)
```

## Integrate a TUI / GUI client

Point your ACP client's agent command at kbox. For example, as a generic client configuration:

```json
{
  "command": "kbox",
  "args": [
    "run", "-i", "--rm", "--memory", "2g", "-u", "root",
    "-v", "dsh-acp-data:/data",
    "-v", "/path/to/project:/workspace",
    "-e", "DEEPSEEK_API_KEY",
    "ghcr.io/kense-labs/dsh-acp:latest"
  ],
  "env": { "DEEPSEEK_API_KEY": "your_key" }
}
```

The client spawns a fresh isolated VM per session and the VM disappears on disconnect. Expect roughly 20–25 s of VM startup on the first launch; subsequent launches reuse cached images.

## Faster startup with the kbox warm pool (one-shot commands)

For non-interactive commands, a kbox warm pool cuts startup from ~22 s (cold VM boot) to **0.19–0.26 s** measured on macOS arm64 (5 warm-pool hits running `dsh-acp --version`):

```sh
kbox pool start --deferred \
  --image ghcr.io/kense-labs/dsh-acp:latest --size 1 --max 2
kbox pool status --json          # wait until idle >= 1
kbox pool run --exec -- node /app/apps/cli/lib/bin.js --version
```

The pool accelerates one-shot commands only: `pool run` does not forward interactive stdin, so ACP client sessions must keep using `kbox run -i --rm` as shown above. A miss (no idle VM) costs the same as a cold boot.

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
