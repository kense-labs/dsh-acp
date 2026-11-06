# dsh-acp

[English](README.md) | 简体中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 ACP-only 发行版：一个通过 stdio 使用 [Agent Client Protocol](https://agentclientprotocol.com)（JSON-RPC）通信的 DeepSeek agent，任何兼容 ACP 的 TUI、GUI 或编辑器都可以驱动它。

提供 agent 循环、会话持久化、模型适配、工具执行与 MCP 支持。

公开容器镜像：[`ghcr.io/kense-labs/dsh-acp`](https://github.com/orgs/kense-labs/packages/container/dsh-acp)，匿名拉取、无需登录。

## 工作模型：进程，而不是守护服务

没有监听端口，也不需要长期后台运行：

- 客户端（TUI/GUI）启动进程，通过 stdin/stdout 通话；客户端断开，进程即退出。一个客户端对应一个 agent 进程。
- stdout 只用于 ACP 协议流量，诊断信息走 stderr。
- 会话与附件保存在 `DSH_HOME`（容器镜像内为 `/data`），进程重建后通过 `session/list`、`session/resume` 恢复历史。
- 默认模型为 `deepseek-flash`（`deepseek-official` 路由），用 `DEEPSEEK_API_KEY` 提供密钥。

## 用 kbox 运行（推荐）

[kbox](https://github.com/kense-labs/kbox) 在隔离 MicroVM 中运行 agent。先从 [kense Releases](https://github.com/kense-labs/kense/releases/tag/kbox-v3.2.7) 安装 kbox，然后：

```sh
export DEEPSEEK_API_KEY=你的密钥

kbox run -i --rm \
  --memory 2g \
  -u root \
  -v dsh-acp-data:/data \
  -v "$PWD:/workspace" \
  -e DEEPSEEK_API_KEY \
  ghcr.io/kense-labs/dsh-acp:latest
```

- `-i`：把客户端 stdio 接入 agent，这就是全部"服务通道"。
- `--rm`：agent 退出后自动删除沙箱，客户端关闭即零残留。
- `-u root`：在 VM 内以 root 运行 agent，保证命名卷可写（`/data` 必须可写；该卷不属于镜像内的 `node` 用户）。
- `-v dsh-acp-data:/data`：命名卷持久化会话，下次启动可恢复。
- `-v "$PWD:/workspace"`：挂载当前项目，`session/new` 的 `cwd` 传 `/workspace`。
- `-e DEEPSEEK_API_KEY`：从宿主环境继承密钥，不进入镜像。
- 首次启动 VM 约需 20–25 秒，之后复用镜像缓存。生产部署建议用 digest 固定镜像版本。

## Hello world：发一条问候，收到模型真实回复

**方式一：直接运行仓库 `.sh` 脚本。** 脚本源码已发布在 GitHub：[dist/bench-pool-dsh-acp.sh](https://github.com/kense-labs/kbox/blob/main/dist/bench-pool-dsh-acp.sh)。在 kbox 源码目录执行（需要 Python 3；脚本使用默认 pool socket，并在结束后停止该池）：

```sh
DEEPSEEK_API_KEY=你的密钥 \
DSH_MODEL=deepseek-flash \
DSH_REASONING_EFFORT=low \
RUNS=1 sh dist/bench-pool-dsh-acp.sh
```

**方式二：复制完整内联命令。** 只需要 Bash、`jq` 和 kbox。它在独立临时 socket 上创建进程预热池，展示每个 ACP 请求，发送默认中文问候，打印模型真实回复，验证结果与退出码，最后清理临时池，不影响已有默认池：

```bash
DEEPSEEK_API_KEY=你的密钥 \
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

`DSH_MODEL` 支持 `deepseek-flash`、`deepseek-v4-pro` 等模型 ID，也支持精确的 `provider/model` 路由。`DSH_REASONING_EFFORT` 使用所选模型公布的思考强度；当前 DeepSeek 模型支持 `off`、`low`、`high`、`max`。`GREETING` 可覆盖默认问候。命令会在发送问候前，通过标准 ACP 配置接口设置并验证模型与思考强度。

## 接入 TUI / GUI 客户端

把 ACP 客户端的 agent 启动命令指向 kbox，例如：

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
  "env": { "DEEPSEEK_API_KEY": "你的密钥" }
}
```

客户端每次会话启动一个全新隔离 VM，断开后 VM 自动回收。

## 用 kbox 进程预热加速启动

进程预热由用户显式启用。在单独终端启动预热池，保持隔离 MicroVM 和已初始化的 dsh-acp 进程待命：

```sh
export DEEPSEEK_API_KEY=你的密钥

kbox pool start --deferred --prewarm \
  --image ghcr.io/kense-labs/dsh-acp:latest \
  --size 1 --max 2 --ttl 0 \
  -u root \
  -v dsh-acp-data:/data \
  -v "$PWD:/workspace" \
  -e DEEPSEEK_API_KEY

kbox pool status --json          # 等待 idle >= 1
kbox pool attach
```

`idle >= 1` 表示 VM、ACP 连接和模型能力解析均已 ready。`pool attach` 将客户端 stdin/stdout 双向转发给该进程，并返回真实退出码。每次接管消耗一个独立的 VM＋进程；断开后销毁该 VM，守护进程自动补池。未命中空闲实例时，需要等待新 VM 和进程完成初始化。

TUI/GUI 用户先启动预热池，再将客户端的 agent 命令配置为：

```json
{
  "command": "kbox",
  "args": ["pool", "attach"]
}
```

使用 `kbox pool stop` 停止守护进程及池内 VM。不需要后台池时，使用上文的 `kbox run -i --rm`。上文 Hello world 完整命令展示了每个 ACP 请求并验证真实模型回复。下方实测数据分别记录启动、initialize 与模型网络耗时。

2026-11-06 在 macOS arm64、kbox 3.2.7 环境实测。5 次使用 `deepseek-flash`＋`low` 的真实 DeepSeek 会话均返回文本、`end_turn` 和退出码 0。实测镜像 digest：`sha256:4237b8ac59d8ad1fb89ce065877fdd8d02f9114c17412cca8163d4276242fea5`。

| 指标 | 最小值 | 中位数 | 最大值 |
| --- | ---: | ---: | ---: |
| 完整 kbox CLI 启动到 initialize 响应 | 15.066 ms | 19.368 ms | 28.955 ms |
| initialize 请求 RTT | 13.822 ms | 17.642 ms | 27.502 ms |
| 守护进程内部接管（非完整启动） | 0.222 ms | 0.251 ms | 0.313 ms |
| 模型 prompt RTT（网络请求，非启动指标） | 676.883 ms | 1436.499 ms | 1676.068 ms |

守护进程内部接管低于 1 ms，不代表完整 CLI 启动或 initialize 为 1 ms。

## ACP 能力

基于 `@agentclientprotocol/sdk` 1.4.0：

- 初始化与认证
- `session/new`、`session/list`、`session/resume`、`session/close`
- prompt、取消与流式 `session/update` 通知
- 权限请求
- 模型与 reasoning-effort 配置
- stdio 与 Streamable HTTP MCP 服务器

## 本地开发

要求 Node.js 24.9+ 与 pnpm 12.6.0：

```sh
pnpm install
pnpm run build
export DEEPSEEK_API_KEY=你的密钥
pnpm start
```

其他命令：

```sh
pnpm test                 # mock 模型的 ACP 协议测试
pnpm run typecheck        # 编译 TypeScript 项目图
pnpm dsh --profile acp --dump-default-config
```

## 许可证

本仓库衍生自 DeepSeek Harness，保留 MIT 许可证与第三方声明，见 [LICENSE](LICENSE)（含 MIT 协议全文）与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
