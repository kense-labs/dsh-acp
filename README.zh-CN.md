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

仓库内置零依赖示例脚本：自动启动 VM、完成 ACP 握手、发送一条问候（可自定义），并流式打印模型回复：

```sh
git clone https://github.com/kense-labs/dsh-acp.git
cd dsh-acp
export DEEPSEEK_API_KEY=你的密钥
python3 examples/acp_hello.py
# 自定义问候：python3 examples/acp_hello.py "用英文打个招呼"
```

实际运行输出（DeepSeek 线上 API）：

```text
Starting ghcr.io/kense-labs/dsh-acp:latest in kbox (first VM boot takes ~20 s)...
Connected: deepseek-harness-acp 0.0.1
You: 你好！请用一句话介绍你自己。
dsh-acp: 你好！我是 DeepSeek Harness 驱动的编码智能体，可以帮你阅读代码、编写与调试程序、执行命令，并通过网络检索资料来完成开发任务。
(stop: end_turn)
```

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

## 用预热池加速启动（一次性命令）

对于非交互命令，kbox 预热池可将启动从冷启动约 22 秒降至 **0.19–0.26 秒**（macOS arm64 实测，5 次预热命中执行 `dsh-acp --version`）：

```sh
kbox pool start --deferred \
  --image ghcr.io/kense-labs/dsh-acp:latest --size 1 --max 2
kbox pool status --json          # 等待 idle >= 1
kbox pool run --exec -- node /app/apps/cli/lib/bin.js --version
```

预热池只加速一次性命令：`pool run` 不转发交互式 stdin，ACP 客户端会话仍需使用上文的 `kbox run -i --rm`。预热未命中（无空闲 VM）时耗时与冷启动相当。

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
