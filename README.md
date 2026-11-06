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

From a kbox source checkout, run one shell command to create a temporary process-prewarmed pool, complete the ACP handshake, send the default Chinese greeting, print the live model reply and metrics, and stop the pool:

```sh
DEEPSEEK_API_KEY=your_key \
DSH_MODEL=deepseek-flash \
DSH_REASONING_EFFORT=low \
RUNS=1 sh dist/bench-pool-dsh-acp.sh
```

`DSH_MODEL` accepts a model id such as `deepseek-flash` or `deepseek-v4-pro`, or an exact `provider/model` route. `DSH_REASONING_EFFORT` accepts an effort advertised by the selected model; the current DeepSeek models support `off`, `low`, `high`, and `max`. Omit either variable to use the configured default. The command verifies the selected model and effort through standard ACP configuration before sending the prompt.

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

## Faster startup with kbox process prewarming

Process prewarming is opt-in. Start the pool in a separate terminal to keep isolated MicroVMs and initialized dsh-acp processes ready:

```sh
export DEEPSEEK_API_KEY=your_key

kbox pool start --deferred --prewarm \
  --image ghcr.io/kense-labs/dsh-acp:latest \
  --size 1 --max 2 --ttl 0 \
  -u root \
  -v dsh-acp-data:/data \
  -v "$PWD:/workspace" \
  -e DEEPSEEK_API_KEY

kbox pool status --json          # wait until idle >= 1
kbox pool attach
```

`idle >= 1` means a VM, its ACP connection, and model capability resolution are ready. `pool attach` forwards the client's stdin/stdout to that process and returns its real exit code. Each attachment consumes a separate VM and process: disconnecting destroys that VM, and the daemon replenishes the pool. A miss waits for a new VM and process to initialize.

For a TUI/GUI, start the pool before launching the client and configure its agent command as:

```json
{
  "command": "kbox",
  "args": ["pool", "attach"]
}
```

Use `kbox pool stop` to stop the daemon and its pooled VMs. Without a background pool, use `kbox run -i --rm` as shown above. To exercise the full protocol and a live model reply, run this from a kbox source checkout while the pool is running:

```sh
DSH_MODEL=deepseek-flash DSH_REASONING_EFFORT=low \
REUSE_POOL=1 RUNS=5 sh dist/bench-pool-dsh-acp.sh
```

The benchmark sends a default Chinese greeting, performs `initialize → session/new → session/prompt`, and verifies model text, `stopReason`, and the exit code. It reports startup and initialize timings separately from model network latency.

Measured on macOS arm64 with kbox 3.2.7 on 2026-11-06. Five real DeepSeek sessions using `deepseek-flash` and `low` all returned text, `end_turn`, and exit code 0. Tested image digest: `sha256:4237b8ac59d8ad1fb89ce065877fdd8d02f9114c17412cca8163d4276242fea5`.

| Metric | Min | Median | Max |
| --- | ---: | ---: | ---: |
| Complete kbox CLI spawn → initialize response | 15.066 ms | 19.368 ms | 28.955 ms |
| `initialize` request RTT | 13.822 ms | 17.642 ms | 27.502 ms |
| Daemon-internal attach setup (not full startup) | 0.222 ms | 0.251 ms | 0.313 ms |
| Model prompt RTT (network, not startup) | 676.883 ms | 1436.499 ms | 1676.068 ms |

Sub-millisecond daemon handoff does not mean that complete CLI startup or `initialize` takes 1 ms.

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
