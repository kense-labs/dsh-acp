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

**Option 1: run the repository `.sh` script.** The source is available on GitHub: [dist/bench-pool-dsh-acp.sh](https://github.com/kense-labs/kbox/blob/main/dist/bench-pool-dsh-acp.sh). From a kbox source checkout, run (Python 3 required; the benchmark uses the default pool socket and stops that pool on exit):

```sh
DEEPSEEK_API_KEY=your_key \
DSH_MODEL=deepseek-flash \
DSH_REASONING_EFFORT=low \
RUNS=1 sh dist/bench-pool-dsh-acp.sh
```

**Option 2: copy the complete inline command.** This requires Bash, `jq`, and kbox. It creates a temporary process-prewarmed pool on a private socket, shows every ACP request, sends the default Chinese greeting, prints the live model reply, verifies the result and exit code, and cleans up without affecting an existing default pool:

```bash
DEEPSEEK_API_KEY=your_key \
DSH_MODEL=deepseek-flash \
DSH_REASONING_EFFORT=low \
bash <<'BASH'
set -euo pipefail

KBOX="${KBOX:-kbox}"
IMAGE="ghcr.io/kense-labs/dsh-acp:latest"
DSH_PROVIDER="${DSH_PROVIDER:-deepseek-official}"
DSH_MODEL="${DSH_MODEL:-deepseek-flash}"
DSH_REASONING_EFFORT="${DSH_REASONING_EFFORT:-low}"
GREETING="${GREETING:-你好！请用一句话介绍你自己。}"
: "${DEEPSEEK_API_KEY:?Set DEEPSEEK_API_KEY first}"
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
case "$DSH_MODEL" in
  */*) DSH_PROVIDER="${DSH_MODEL%%/*}"; DSH_MODEL="${DSH_MODEL#*/}" ;;
esac

WORK="$(mktemp -d "${TMPDIR:-/tmp}/dsh-acp-hello.XXXXXX")"
POOL_SOCKET="$WORK/pool.sock"
mkfifo "$WORK/acp.in" "$WORK/acp.out"
POOL_PID=""
ACP_PID=""
cleanup() {
  set +e
  exec 3>&- 2>/dev/null
  exec 4>&- 2>/dev/null
  [[ -z "$ACP_PID" ]] || kill "$ACP_PID" 2>/dev/null
  [[ -z "$ACP_PID" ]] || wait "$ACP_PID" 2>/dev/null
  "$KBOX" pool stop --socket "$POOL_SOCKET" >/dev/null 2>&1
  [[ -z "$POOL_PID" ]] || kill "$POOL_PID" 2>/dev/null
  [[ -z "$POOL_PID" ]] || wait "$POOL_PID" 2>/dev/null
  rm -rf -- "$WORK"
}
trap cleanup EXIT

"$KBOX" pool start --deferred --prewarm \
  --socket "$POOL_SOCKET" --image "$IMAGE" \
  --size 1 --max 1 -u root -e DEEPSEEK_API_KEY \
  >"$WORK/pool.log" 2>&1 &
POOL_PID=$!

READY=0
for ((attempt = 0; attempt < 90; attempt++)); do
  if "$KBOX" pool status --socket "$POOL_SOCKET" --json 2>/dev/null |
    jq -e '.[0].idle >= 1' >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 2
done
[[ "$READY" == 1 ]] || { echo "dsh-acp did not become ready" >&2; exit 1; }

exec 3<>"$WORK/acp.in"
exec 4<>"$WORK/acp.out"
"$KBOX" pool attach --socket "$POOL_SOCKET" <"$WORK/acp.in" >"$WORK/acp.out" 3>&- 4>&- &
ACP_PID=$!

RPC_RESPONSE=""
REPLY=""
rpc() {
  local id="$1" payload="$2" timeout="$3" line chunk
  printf '%s\n' "$payload" >&3
  while IFS= read -r -t "$timeout" -u 4 line; do
    [[ "$line" == \{* ]] || continue
    if jq -e --argjson id "$id" '.id? == $id' >/dev/null 2>&1 <<<"$line"; then
      if jq -e 'has("error")' >/dev/null 2>&1 <<<"$line"; then
        jq -r '.error.message // "ACP request failed"' >&2 <<<"$line"
        return 1
      fi
      RPC_RESPONSE="$line"
      return 0
    fi
    chunk="$(jq -rj 'select(.method? == "session/update") |
      .params.update | select(.sessionUpdate == "agent_message_chunk") |
      .content | select(.type == "text") | .text // empty' <<<"$line")"
    [[ -z "$chunk" ]] || { printf '%s' "$chunk"; REPLY="$REPLY$chunk"; }
  done
  echo "ACP request $id timed out or disconnected" >&2
  return 1
}

rpc 1 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}' 30
AGENT="$(jq -r '.result.agentInfo.name' <<<"$RPC_RESPONSE")"
rpc 2 "$(jq -nc '{jsonrpc:"2.0",id:2,method:"session/new",params:{cwd:"/workspace",mcpServers:[]}}')" 30
SESSION_ID="$(jq -r '.result.sessionId' <<<"$RPC_RESPONSE")"
MODEL_VALUE="$(jq -nc --arg provider "$DSH_PROVIDER" --arg model "$DSH_MODEL" '[$provider,$model]')"
rpc 3 "$(jq -nc --arg session "$SESSION_ID" --arg value "$MODEL_VALUE" \
  '{jsonrpc:"2.0",id:3,method:"session/set_config_option",params:{sessionId:$session,configId:"model",value:$value}}')" 30
jq -e --arg value "$MODEL_VALUE" \
  '[.result.configOptions[] | select(.id == "model" and .currentValue == $value)] | length == 1' \
  >/dev/null <<<"$RPC_RESPONSE"
rpc 4 "$(jq -nc --arg session "$SESSION_ID" --arg value "$DSH_REASONING_EFFORT" \
  '{jsonrpc:"2.0",id:4,method:"session/set_config_option",params:{sessionId:$session,configId:"reasoning_effort",value:$value}}')" 30
jq -e --arg value "$DSH_REASONING_EFFORT" \
  '[.result.configOptions[] | select(.id == "reasoning_effort" and .currentValue == $value)] | length == 1' \
  >/dev/null <<<"$RPC_RESPONSE"

printf 'Connected: %s\nModel: %s/%s (reasoning: %s)\nYou: %s\n%s: ' \
  "$AGENT" "$DSH_PROVIDER" "$DSH_MODEL" "$DSH_REASONING_EFFORT" "$GREETING" "$AGENT"
rpc 5 "$(jq -nc --arg session "$SESSION_ID" --arg text "$GREETING" \
  '{jsonrpc:"2.0",id:5,method:"session/prompt",params:{sessionId:$session,prompt:[{type:"text",text:$text}]}}')" 240
STOP_REASON="$(jq -r '.result.stopReason' <<<"$RPC_RESPONSE")"
[[ -n "$REPLY" && "$STOP_REASON" == "end_turn" ]] || { echo "invalid model response" >&2; exit 1; }
printf '\n(stop: %s)\n' "$STOP_REASON"
exec 3>&-
wait "$ACP_PID"
printf 'ACP exit code: 0\n'
BASH
```

`DSH_MODEL` accepts a model id such as `deepseek-flash` or `deepseek-v4-pro`, or an exact `provider/model` route. `DSH_REASONING_EFFORT` accepts an effort advertised by the selected model; current DeepSeek models support `off`, `low`, `high`, and `max`. `GREETING` overrides the default greeting. The command verifies the selected model and effort through standard ACP configuration before sending the prompt.

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

Use `kbox pool stop` to stop the daemon and its pooled VMs. Without a background pool, use `kbox run -i --rm` as shown above. The complete [Hello world command](#hello-world-send-a-greeting-get-a-live-model-reply) shows every ACP request and verifies a live model reply. The measurements below separately record startup and initialize timings apart from model network latency.

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
