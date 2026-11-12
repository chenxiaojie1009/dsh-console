# 设备控制台（dsh-console）

[![GitHub](https://img.shields.io/badge/GitHub-dsh--console-181717?logo=github)](https://github.com/chenxiaojie1009/dsh-console)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-2ea44f)](https://github.com/topics/dsh-plugin)

DSH（DeepSeek Harness）插件：把 **串口调试** 和 **SSH 登录** 变成 DSH 里可看、可控的「设备控制台」。

面板路径：左侧边栏底部 →「设备控制台」。面板是左右分栏：**左边**是「告诉 DSH 你想做什么」的需求框和「待确认命令」，**右边**是实时终端（命令、中文注释、设备输出、输出解读）。需要改需求时点「暂停 DSH」，当前操作会立刻中断，改完点「继续」再让 DSH 按新要求执行。不想记命令也没关系：写清目的让 DSH 给命令，命令默认要你点「执行」才会发到设备。

## 功能

| 需求 | 实现 |
|---|---|
| ① 串口调试 / SSH | 面板两个标签页：串口（自动列出 COM 口、可选波特率）与 SSH（已配置主机一键带入，也可手动输入主机） |
| ② 连接标志 | 侧边栏「设备控制台」图标右上角绿点 = 已连接（琥珀色 = 已暂停）；面板顶部还有状态胶囊显示设备名 |
| ③ 看到命令行并注释 | DSH 每次执行命令都会在面板里显示 `› 命令   // 中文注释`；命令输出下面还会显示 `解读：……`，用中文说明输出含义（结论、数值、报错原因）；输出实时滚动 |
| ④ 账号密码由你输入 | SSH 密码只在本机面板输入，只存在内存里，不写入会话记录、不下发给模型；可选复用 DSH SSH 插件里已保存的密码 |
| ⑤ 修改需求可暂停 | 「暂停 DSH」按钮会中断 DSH 当前这一轮操作（cancel 当前会话 turn），命令执行也会立即返回 `paused`；点「继续」后按新需求继续 |
| ⑥ 可打包到其他 DSH | 产物是一份 npm 包（`.tgz`）+ 安装脚本；其他 DSH 上一条命令安装 |
| ⑦ 不用记命令 | 面板左侧写「我想做什么」→ 点「让 DSH 给出命令」→ **插件内模型直接生成命令（不经过聊天）**进入「待确认命令」→ 你点「执行」才真正发到设备，点「取消」则不执行；执行后插件内模型自动补输出解读。右上角「执行前确认」可关闭（关闭后命令直接执行） |

## 安装（本机或另一台 DSH）

### 方式 A：命令行安装（推荐）

```powershell
# 1. 解压 dsh-console-<version>.zip 到任意目录
# 2. 安装到目标 profile（默认桌面版 profile 名为 desktop）
dsh plugin --profile desktop add "file:G:\path\to\dsh-console-1.3.1.tgz"
# 3. 重启 DSH 桌面端
```

安装时 pnpm 会自动装好 `serialport` 与 `ssh2` 两个依赖。

### 方式 B：让 DSH 自己安装

把解压后的目录告诉 DSH，让它用插件管理器安装：

> 把 `G:\path\to\dsh-console` 这个本地插件包安装到当前 profile（install_bundle）。

> 注意：`install_bundle` 对本地目录是 pnpm link，**不会**安装该包的 dependencies；用这种方式装完后如果串口/SSH 不可用，请改用方式 A 的 tgz 安装。

### 方式 C：从 GitHub 安装

```powershell
dsh plugin --profile desktop add "https://github.com/chenxiaojie1009/dsh-console/releases/download/v1.3.1/dsh-console-1.3.1.tgz"
```

或从 [Releases](https://github.com/chenxiaojie1009/dsh-console/releases) 下载 tgz 后用方式 A 安装；源码安装：`dsh plugin --profile desktop add "github:chenxiaojie1009/dsh-console"`（需要本地编译 `serialport`，较慢）。

### 卸载

```powershell
dsh plugin --profile desktop remove dsh-console
```

## 使用流程

1. 打开左侧边栏底部「设备控制台」。
2. **串口**：选择 COM 口与波特率（默认 115200 8N1）→ 点「连接」。
3. **SSH**：选已配置主机（来自 DSH 的 `dsh-ssh.json`）或手动填主机/端口/用户名 → 输入密码 → 点「连接」。若该主机在 DSH 里存过密码，可勾选「使用已保存的密码」。
4. **不想记命令时（推荐）**：在面板左侧「告诉 DSH 你想做什么」里写目的，例如「看看 NAS 内存还剩多少」「查一下串口设备支持哪些命令」→ 点「让 DSH 给出命令」。
   - 这一步直接调用本机 DSH 配置的模型生成命令，**不经过聊天会话**，思考结果只出现在面板里；
   - 生成的命令进入左侧「待确认命令」，显示 `› 命令   // 注释`；
   - 点「执行」才会真正发到设备，点「取消」则丢弃；
   - 执行后插件会再调用模型，自动补一条输出「解读」；
   - 想跳过确认：取消勾选面板右上角「执行前确认」，之后命令直接执行。
5. 也可以回到对话直接说目标，例如：
   > 在串口设备上执行 help，然后告诉我支持哪些命令。

   DSH 会：
   - 调 `console_status` 看连接状态；
   - 串口未连接时调 `console_serial_connect` 自动连接；SSH 未连接时调 `console_ssh_connect`，面板弹出「DSH 请求连接 SSH」的等待条，你输入密码点连接即可；
   - 用 `console_exec` 提交命令（默认进入待确认区），你用面板点「执行」；
   - 每条命令执行完，用 `console_note` 给输出补中文「解读」；
   - 面板里同步出现 `› 命令   // 注释`、设备输出，以及输出下面的 `解读：……`。
6. 需要改需求：点面板右上角「暂停 DSH」。DSH 当前这一轮会被中断，命令等待也会立刻结束；你在对话或面板左侧说新的要求，点「继续」，DSH 再继续操作。
7. 需要手动干预：终端输入框可以直接给设备发命令（手打命令立即发送，不需要确认），`Ctrl+C` 按钮可中断设备上正在跑的程序，「清屏」只清面板记录。

> 同一时间只保持一个设备连接：从串口切到 SSH（或反过来）会先断开当前连接；面板顶部状态胶囊与侧边栏绿点反映的就是这个唯一连接。

## DSH 可用的工具（console_*）

| 工具 | 作用 |
|---|---|
| `console_status` | 连接状态、是否暂停、可用串口、已配置 SSH 主机、最近输出 |
| `console_serial_connect` | 连接串口（无密码；可自动选口，默认 115200 8N1） |
| `console_ssh_connect` | 请求用户在面板输入密码连接 SSH（模型不接触密码） |
| `console_exec` | 提交一条命令；「执行前确认」开启时只进入面板待确认区（`status=awaiting-confirmation`），用户点「执行」后才真正发送。`note` 必填，是命令旁的中文注释 |
| `console_note` | 给刚执行完的命令输出补一条中文「解读」，显示在面板对应输出下面；只做展示，不发送数据 |
| `console_send` | 发送原始输入（Ctrl+C、方向键、回车等，支持 `\r \n \x03` 转义） |
| `console_read` | 读取终端缓冲区（命令、注释、输出、输出解读） |
| `console_disconnect` | 断开当前连接 |

插件的系统提示词会告诉模型：每条命令都要写 `note`、每次执行完要用 `console_note` 解读输出、命令要等用户在面板确认执行、不要索要密码、收到 `paused` 必须停下等新指令。

## 安全说明

- 面板接口 `/api/device-console/*` 只接受 **本机回环** 请求（socket 地址 + Host 头 + 浏览器同源标记），局域网暴露的 DSH 不会被远程调用。
- SSH 密码只经浏览器 → 本机 host 进程内存 → ssh2 使用，不写入会话日志、不进模型上下文；面板刷新后需要重新输入。
- 设备输出会原样回传给模型，可能包含敏感信息，注意屏幕内容。
- 读取的已配置主机来自 `$DSH_HOME/dsh-ssh.json`（DSH SSH 插件），本插件只读不写。
- 面板里的「需求 → 命令建议」和「输出解读」会调用你 DSH 里配置的模型：需求文本、最近终端记录、命令与输出会作为请求内容发给模型（消耗 token）；不经过聊天会话，也不写入会话日志。需要完全离线时，改用聊天模式或在面板里手打命令。

## 目录结构

```
dsh-console/
├─ index.js              # host：引擎、路由、工具、提示词
├─ host/
│  ├─ hub.js             # 终端缓冲区 / 暂停 / 待连接请求
│  ├─ engine.js          # 连接、命令执行、暂停
│  ├─ serial.js          # serialport 适配（懒加载）
│  ├─ ssh.js             # ssh2 适配（懒加载）
│  ├─ ssh-hosts.js       # 读取 dsh-ssh.json 中的主机
│  ├─ routes.js          # /api/device-console 路由 + 回环校验
│  └─ tools.js           # console_* 工具
├─ client.js             # Web UI：侧边栏图标 + 设备控制台页面
├─ cordis.patch.yml      # 插件挂载行
├─ locale/{zh,en}.json   # 插件列表里的标题与说明
├─ icon.svg
├─ package.json
└─ README.md
```

## 环境要求

- DSH `>= 0.2.2-rc.1`（Web GUI / 桌面版）
- Node `>= 20`
- Windows 10/11（串口依赖 `serialport` 的预编译二进制；macOS/Linux 同样有预编译）
- 串口设备需要驱动装好并在系统中出现 COM 口

## 常见问题

- **看不到串口**：确认设备管理器里有 COM 口；面板点「刷新」；被其他程序（如串口助手）占用时无法打开。
- **串口模块报错**：说明 `serialport` 原生模块没装上，请用 tgz 方式重装（会安装 dependencies）。
- **SSH 连接失败**：检查主机/端口/用户名/密码；NAS 等设备可能禁用密码登录或需要二次验证。
- **DSH 没按注释执行**：确认对话里用自然语言说明要操作「设备 / 串口 / SSH」，插件提示词会让它调用 `console_*` 工具。
- **暂停后 DSH 还在动**：暂停会让正在等待的设备命令立刻返回 `paused`，并尽力取消当前 turn；模型收到 `paused` 后按提示词必须停下等新指令。极少数情况下它可能先说完一句话，不会再继续执行设备命令，直到点「继续」。
- **装上后 DSH 每次 console_exec 提醒「CC Safety Net 未检查该命令」**：这是 cc-safety-net 插件的防护提示。console_exec 执行的是串口/SSH 设备上的命令，不是本机 shell，可在普通（非 DSH 沙箱）PowerShell 里声明一次：
  ```powershell
  npx -y cc-safety-net rule tool add console_exec --no-cwd-arg
  ```
- **DSH 给出了命令但设备没反应**：默认开启「执行前确认」，命令会停在面板左侧「待确认命令」里——点「执行」才会发到设备，点「取消」丢弃；如果不想每次确认，取消勾选右上角「执行前确认」。
- **面板左侧「让 DSH 给出命令」没反应/报错**：这一步调用你 DSH 里配置的模型。若提示没有可用模型，请到 DSH「设置 → 模型」登录或选择一个模型；若提示模型调用失败，检查网络/账号额度后重试。命令迟迟不出现时，看面板底部是否有红色错误提示。
- **安装时报 `ERR_PNPM_IGNORED_BUILDS` / `@serialport/bindings-cpp` build 被拦截**：串口原生绑定需要放行一次安装脚本：
  ```powershell
  dsh plugin --profile desktop approve-builds
  ```
  （或把 `"@serialport/bindings-cpp": true` 加进 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds` 后重装。）
