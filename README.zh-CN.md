# codex-multi-model-router

把 DeepSeek、任意 OpenAI 兼容中继、以及配额通道的模型，塞进 Codex **自带的模型菜单**，
和原本的 GPT 模型并排，并且**在同一个任务里随时切换，不用重启、不丢当前对话**。

[English](README.md) | 中文

Codex 从目录文件读取模型列表，并把所有请求发给唯一一个 provider。
这个项目在本地跑一个小服务充当那个 provider，它持有各家的真实密钥，
再按选中的模型把请求转发到对应上游。对 Codex 来说，它只是一个"模型很多"的 provider。

    ┌──────────────┐   model slug   ┌────────────────────┐
    │  Codex app   │ ─────────────▶ │  127.0.0.1:18763   │
    │  model menu  │ ◀───────────── │  local router      │
    └──────────────┘    SSE 流      └─────────┬──────────┘
                                             │
                                             ├─▶ ChatGPT / Codex 后端（你的套餐）
                                             ├─▶ DeepSeek API（自己的 key）
                                             ├─▶ 任意 OpenAI 兼容中继
                                             └─▶ CodeBuddy / WorkBuddy（便宜额度）

## 为什么做这个

重点不是"模型更多"，而是**切模型不丢手上的活**。

没有它的时候，想换个模型就得改 `config.toml` 再重启 Codex，
正在生成的回答会被打断；而且根本没法在一个任务中途换模型。
有了它，模型菜单直接点，任务还开着。

第二个理由是省钱。便宜模型在很多任务上完全够用，
当它只差一次点击的时候，你才会真的去用。

## 装它需要什么

- Windows（密钥存储和启动脚本依赖 Windows）
- Node.js 18+
- Codex 桌面版及其自带的 `codex` CLI（实测 CLI `0.155.x`）

## 快速开始

```powershell
# 1. 把 provider 配置放到路由期望的位置
Copy-Item .\examples\deepseek-models.json  $env:USERPROFILE\.codex\
Copy-Item .\examples\relay-models.json     $env:USERPROFILE\.codex\
Copy-Item .\examples\workbuddy-models.json $env:USERPROFILE\.codex\

# 2. 存 DeepSeek 密钥（隐藏输入，DPAPI 加密）
.\scripts\Set-DeepSeekApiKey.ps1

# 3. 把守护进程注册成计划任务
.\install\Register-RouterTask.ps1

# 4. 让 Codex 指向路由
#    把 examples\config.toml.snippet 追加到 $env:USERPROFILE\.codex\config.toml

# 5. 启动
.\scripts\start-codex.cmd
```

路由跑在计划任务的守护进程下，不在应用里，所以关掉 Codex 它照样在跑。
改了路由文件会被自动发现：启动器比对运行中文件的指纹，有变化就重启路由。
`start-codex.cmd restart` 是给**应用需要重连**时用的——它会关掉应用
（连同残留的 `codex.exe` / 桥接子进程）再重新打开。

## 真正要紧的部分：别把应用弄坏

一旦 `config.toml` 里写了 `model_provider = 'codex_router'`，
所有模型请求都会打到 `127.0.0.1:18763`。
如果那个进程没起来，**Codex 就无法和任何模型通信**，
而且你没法从应用内部修——因为你想求助的那个东西，正是坏掉的那个。

这不是假设，是这个项目花时间最多的地方。为此做的防护：

| 防护 | 防的是什么 |
|---|---|
| 守护进程，路由退出就重启 | 崩溃后端口变成死的 |
| 启动器**先**验证 `/health` 再开应用 | 把应用启动进一个坏状态 |
| 清理占着端口的僵尸进程 | `EADDRINUSE` 导致新实例起不来 |
| 路由起不来时自动切回内置 provider | 被锁在门外 |
| `Use-OfficialProvider.ps1` 逃生脚本 | 随时手动恢复 |
| 启动时修复指向死端口的 `config.toml` | 第三方切换工具改写你的配置 |
| 每次启动重建模型目录 | 菜单悄悄停止更新新模型 |

细节见 [docs/lessons-learned.md](docs/lessons-learned.md)（英文）。
里面把 11 个坑写成了具体案例，
包括一个**从没成功运行过一次的逃生脚本**——正因为没人跑过它。

## 目录结构

    src/
      router.js                 本地 provider：路由 + Responses API 转发
      workbuddy-adapter.js      Responses API <-> chat/completions 双向翻译
      sync-model-catalog.js     重建 Codex 读的模型目录
      paths.js                  所有路径，从 CODEX_HOME 解析
    scripts/
      _common.ps1               共享路径与工具函数
      Start-ModelRouter.ps1     守护进程（计划任务跑这个）
      Activate-ModelRouter.ps1  健康检查 / 重启 / 修复 / 回退
      Sync-ModelCatalog.ps1     只重建模型菜单，不重启任何东西
      Start-Codex-WithModels.ps1 启动器，含完全重启
      Use-OfficialProvider.ps1  逃生：切回内置 provider
      Set-*.ps1, Save-*.ps1     密钥录入
      start-codex.cmd           可双击的包装
    install/                    计划任务注册
    examples/                   provider 配置模板 + config.toml 片段
    docs/                       架构、经验教训、排错（英文）

所有路径都从 `CODEX_HOME`（或 `CODEX_ROUTER_HOME`，或 `~/.codex`）解析，
没有任何地方硬编码用户名或机器路径。

## 加一个新 provider

按难度分三种：

1. **OpenAI 兼容中继** —— 往 `relay-models.json` 加一条，不用改代码。
2. **别的配额通道** —— 抄 `workbuddy-adapter.js`，它是一份完整的
   "两种流式协议互转"范例。
3. **自有协议的 provider** —— 在 `router.js` 里加分支。

见 [docs/adding-a-provider.md](docs/adding-a-provider.md)（英文）。

## 如实说明的限制

- **只支持 Windows。** DPAPI 和启动脚本是 Windows 专有的；Node 路由本身可移植，
  但密钥处理不是。
- **是对接，不是官方 API。** Codex 侧的行为是观测出来的，一次 Codex 更新就可能
  改掉协议。这正是守护进程记录 CLI 版本、版本变了就重启、以及保留回退路径的原因。
- **WorkBuddy 适配器对接的是特定厂商端点**，可能随时变动。它既是实际在用的东西，
  也是给"协议互转"当范例的，属于最不稳定的部分。
- **与 OpenAI、DeepSeek、腾讯均无关联。** 模型名和端点归各自所有方。
  自备密钥，并自行遵守各家的服务条款。

## 许可

MIT，见 [LICENSE](LICENSE)。
