# Claude Code API 状态小监视器

一个面向 Windows + VS Code 的轻量本地透明代理。在终端中实时显示 Claude Code 请求的模型、进行状态、耗时、HTTP 状态码和输入/输出 token。

```text
Claude Code → 本地监视器（127.0.0.1:3456）→ 当前 API 服务
```

它会自动读取 `~/.claude/settings.json` 中由 CCswitch 或用户配置的 `ANTHROPIC_BASE_URL`，把该地址记为真实上游，再让 Claude Code 经过监视器。CCswitch 切换 API 后，监视器会自动跟随，无需手动编辑 URL。

## 隐私与缓存

- 不记录 API Key、提示词、工具结果或模型回复正文。
- 不修改请求正文、模型名、system prompt、messages、tools 或 `cache_control`，因此不会主动破坏服务端缓存命中。
- 只在内存中保留最近请求的模型、状态、耗时和 token 数字。
- `config.json` 已被 Git 忽略，不会上传个人上游地址。
- 不同服务商、不同模型之间的缓存本来就互不共享。

## 环境要求

- Windows 10/11
- VS Code
- Node.js 18 或更新版本
- 已能正常使用的 Claude Code

## 安装

1. 下载或克隆本仓库，并用 VS Code 打开仓库文件夹。
2. 在 VS Code 终端执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

3. 保持 CCswitch 已选中可用的 API，或确保 Claude Code 原本已经配置了可用的 `ANTHROPIC_BASE_URL`。

## 使用

在 VS Code 中按 `Ctrl+Shift+B`，终端会出现“API 监视器”。上方 Claude Code 界面发出请求后，终端会显示类似：

```text
#001 | deepseek-v4-pro | 请求中 | 34s | token: 120 in / 800 out
#001 | deepseek-v4-pro | 200    | 39s | token: 120 in / 965 out
```

按监视器终端中的 `Ctrl+C` 可以关闭。正常关闭时，监视器会自动恢复 Claude Code 直连当前 API，避免下次使用时出现本地连接失败。

监视器还会通过 Windows 任务计划程序启动一个不显示窗口的短期恢复守护进程。它不属于 VS Code 的终端进程树，因此即使使用终端垃圾桶强制结束整个任务，仍会在约一秒内把 Claude Code 恢复为直连最后一个真实 API；恢复完成后会注销临时任务并自行退出，不会长期驻留。如果 Windows 无法注册该保护，监视器会保持 Claude Code 直连而不冒险接管路由。

### 显示开关

先点击监视器终端使其获得键盘焦点，然后直接按键，无需按 Enter：

- `M`：暂停或恢复全部状态显示。关闭时请求仍会正常转发。
- `D`：单独隐藏或显示 DeepSeek Harness（DSH）的请求。
- `Ctrl+C`：关闭监视器并恢复 Claude Code 直连。

开关会保存在个人 `config.json` 中，下次启动继续沿用。DSH 的识别依据是它公开且固定的 `User-Agent: deepseek-harness/版本号`；工具不会读取提示词来猜测客户端。

## 切换 API

在 CCswitch 中正常切换即可。监视器检测到 `~/.claude/settings.json` 中的新 `ANTHROPIC_BASE_URL` 后，会：

1. 保存新地址为真实上游；
2. 保留 CCswitch 写入的 token、模型和其他配置；
3. 将 Claude Code 的入口重新接回本地监视器。

切换 API 或认证 token 后，Claude Code 扩展可能提示“扩展在磁盘上已被修改”。按提示重新加载 VS Code 窗口即可。

## 状态码含义

- `200`：请求成功。
- `401` / `403`：API Key 或账户权限问题。
- `429`：额度不足或请求频率受限。
- `500`：上游服务内部错误。
- `502`：监视器无法连接当前上游，通常是地址错误、网络故障或本地 API 网关未启动。

## 文件说明

- `monitor.js`：本地透明代理与终端面板。
- `guardian.js`：垃圾桶、崩溃或强制终止后的直连恢复保护。
- `start-monitor.ps1`：日常启动脚本。
- `setup.ps1`：首次生成本地 `config.json`。
- `.vscode/tasks.json`：`Ctrl+Shift+B` 一键启动任务。

本工具并非 Anthropic、DeepSeek 或 CCswitch 的官方产品。

## 许可证

[MIT License](LICENSE)
