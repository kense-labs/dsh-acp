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
  -v dsh-acp-data:/data \
  -v "$PWD:/workspace" \
  -e DEEPSEEK_API_KEY \
  ghcr.io/kense-labs/dsh-acp:latest
```

- `-i`：把客户端 stdio 接入 agent，这就是全部"服务通道"。
- `--rm`：agent 退出后自动删除沙箱，客户端关闭即零残留。
- `-v dsh-acp-data:/data`：命名卷持久化会话，下次启动可恢复。
- `-v "$PWD:/workspace"`：挂载当前项目，`session/new` 的 `cwd` 传 `/workspace`。
- `-e DEEPSEEK_API_KEY`：从宿主环境继承密钥，不进入镜像。
- 首次启动 VM 约需 20–25 秒，之后复用镜像缓存。生产部署建议用 digest 固定镜像版本。

## 接入 TUI / GUI 客户端

把 ACP 客户端的 agent 启动命令指向 kbox，例如：

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
  "env": { "DEEPSEEK_API_KEY": "你的密钥" }
}
```

客户端每次会话启动一个全新隔离 VM，断开后 VM 自动回收。

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
