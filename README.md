# dsh-acp

An ACP-only distribution of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): a DeepSeek agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com) over stdio, so any ACP-compatible TUI, GUI, or editor can drive it.

It keeps the agent loop, session persistence, model adapters, tool execution, and MCP support. Desktop, Web, experimental, website, and Python SDK packages are excluded.

中文说明见文末（[中文说明](#中文说明)）。

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
pnpm run typecheck        # compile all retained TypeScript projects
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

---

## 中文说明

dsh-acp 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 ACP-only 发行版：一个通过 stdio 使用 [Agent Client Protocol](https://agentclientprotocol.com)（JSON-RPC）通信的 DeepSeek agent，任何兼容 ACP 的 TUI、GUI 或编辑器都可以驱动它。保留 agent 循环、会话持久化、模型适配、工具执行与 MCP 支持；桌面、Web、实验性、网站与 Python SDK 包均已移除。

### 工作模型：进程，而不是守护服务

- 没有监听端口，也不需要长期后台运行。客户端（TUI/GUI）启动进程，通过 stdin/stdout 通话；客户端断开，进程即退出。一个客户端对应一个 agent 进程。
- stdout 只用于 ACP 协议流量，诊断信息走 stderr。
- 会话与附件保存在 `DSH_HOME`（容器镜像内为 `/data`），进程重建后通过 `session/list`、`session/resume` 恢复历史。
- 默认模型为 `deepseek-flash`（`deepseek-official` 路由），用 `DEEPSEEK_API_KEY` 提供密钥。

### 镜像在哪里

公开镜像发布在组织级 GitHub Packages（容器仓库），**匿名拉取、无需登录**：

- 包页面：https://github.com/orgs/kense-labs/packages/container/dsh-acp
- 拉取地址：`ghcr.io/kense-labs/dsh-acp:latest`

注意：在 dsh-acp 仓库主页的 Packages 区域看不到它，是因为包尚未关联到该仓库；上面的组织级包页面始终可用。

### 用 kbox 运行（推荐）

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

### 接入 TUI / GUI 客户端

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

### ACP 能力

基于 `@agentclientprotocol/sdk` 1.4.0：初始化与认证；`session/new`、`session/list`、`session/resume`、`session/close`；prompt、取消与流式 `session/update`；权限请求；模型与 reasoning-effort 配置；stdio 与 Streamable HTTP MCP 服务器。

### 本地开发

要求 Node.js 24.9+ 与 pnpm 12.6.0：

```sh
pnpm install
pnpm run build
export DEEPSEEK_API_KEY=你的密钥
pnpm start
```

其他命令：`pnpm test`（mock 模型的 ACP 协议测试）、`pnpm run typecheck`、`pnpm dsh --profile acp --dump-default-config`。

### 许可证

本仓库衍生自 DeepSeek Harness，保留 MIT 许可证与第三方声明，见 [LICENSE](LICENSE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。MIT 协议全文见上方英文 License 一节。
