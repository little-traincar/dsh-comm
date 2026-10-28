# dsh-comm

DSH 的内嵌通信调试台：**串口 / TCP 服务端 / TCP 客户端 / UDP** 四种链路，文本与 HEX 收发、编码切换、快捷输入、行尾设置、日志录制与导出、Host 侧定时/序列发送、自动回复，以及深色 / 浅色两套主题。UI 以右栏 tab 嵌在 DSH 里，也可以直接用独立网页打开。

链路、日志、定时器都在 Host 侧运行：关面板、切 tab、刷新页面不会断链，也不会停表。模型工具（`comm_*`）和调试台共用同一套链路，可以直接读写对端数据。

- **Host 侧运行**：链路、缓冲、定时器都在 DSH 进程里，浏览器只做轮询展示。
- **模型可直接操作**：`comm_list / comm_open / comm_read / comm_write / comm_tail / comm_timer / comm_serial` 等工具；`comm_write` 带 `expect` 时一次工具往返完成「发指令 → 看回应」。
- **串口 Windows 原生**：走 PowerShell + .NET `SerialPort`，不依赖 `serialport` 原生模块，免编译/免 ABI 问题。
- **右栏 + 独立网页**：同一套 UI 既能在 DSH 右栏 tab 中使用，也能通过 `/comm/ui?token=...` 单独打开。
- **数据在本机**：规则、串口参数、定时器、主题等按链路/本地保存；日志缓冲区在内存中，有硬上限。

## 本次更新

主题系统：

| 变更 | 说明 |
|---|---|
| 顶部主题开关 | 标题栏右上角（日志按钮左侧）新增 ☀ / ☾ 按钮，点击切换深色 / 浅色 |
| 深色主题 | 保持原有配色（默认主题），所有控件观感不变 |
| 浅色主题（新增） | 完整浅色配色：面板、输入框、下拉、按钮、分段控件、日志区、TX/RX 标签、滚动条、弹窗、toast、状态色全部适配 |
| 跟随 DSH | 没有手动切换过主题时，面板通过 `postMessage` 跟随 DSH 的深/浅色；手动切换后以开关为准，不再被 DSH 覆盖 |
| 选择记忆 | 主题选择存 `localStorage`，重开面板保持；独立网页默认深色，也可用 `?theme=light` / `?theme=dark` 临时指定 |

## 功能详细表格

| 分类 | 功能 | 说明 |
|---|---|---|
| 链路 | 串口 | 数据位 5–8、校验 N/E/O/M/S、停止位 1/1.5/2、流控 none/RTS-CTS/XON-XOFF、DTR/RTS 初始电平、断线自动重连；参数按端口持久化；拔插后按 USB 序列号 / VID+PID 找回新 COM 号 |
| 链路 | TCP 服务端 | 指定绑定地址与端口，支持多客户端；`comm_peers` 查看客户端，`comm_write` 可指定 peer 或广播 |
| 链路 | TCP 客户端 | 主动连接远端；纯流视图（无帧/粘包解析） |
| 链路 | UDP | 指定本地绑定、远端地址与端口；收发原始数据报 |
| 收发 | 文本 / HEX | 文本按所选编码编解码；HEX 按字节解析，支持 `0x` 前缀、空格/逗号分隔 |
| 收发 | 编码 | UTF-8、GBK、GB18030、Big5、Shift-JIS、EUC-KR、Windows-1252，收发与日志展示共用 |
| 收发 | 行尾 | 文本发送可选 `CR+LF` / `LF` / `CR` / `无`（默认 CR+LF）；HEX 不追加 |
| 收发 | 快捷输入 | 按模式保存常用发送项，支持名称、内容、文本/HEX，一键发送 |
| 低延迟 | `write + expect` | 发送后在同一次工具调用里等待匹配回包，返回 `matched`、`waitedMs` 和窗口内 `entries`；支持 contains / 正则，TCP 回环实测平均 0.13 ms |
| 定时 | Host 侧定时器 | 周期发送（可限次数）与多步序列（每步 `delayMs`，可循环、限轮次）；关闭面板、切 tab 继续跑；支持保存、自动开始 |
| 日志 | 双上限缓冲 | 每条链路最多 2000 条 / 4 MiB 原始字节，超限丢最旧并计入 `dropped` / `droppedBytes`，不静默丢数据 |
| 日志 | 增量渲染 / 暂停 | 日志增量追加 DOM，2000 条裁剪时按视口锚点补偿滚动；「暂停」= Host 侧丢弃 RX 并计数（日志、自动回复停止，TX 与系统日志照常） |
| 日志 | 搜索 / 导出 / 录制 | 日志过滤、导出 `.log` / `.csv` / 接收原始字节 `.bin`；浏览器侧录制（内存）与清空 |
| 自动化 | 自动回复 | 有规则时按 contains / regex / HEX 匹配并自动回复（编码、延迟、回显抑制、冷却、频率上限）；无规则时可转 DSH 会话，由模型回复（去抖合并 + 专用会话 + 失效自愈） |
| 界面 | 主题 | 深色 / 浅色两套主题，顶部开关切换；未手动切换时跟随 DSH 主题 |
| 界面 | 状态与操作 | RX/TX 字节、编码、对端数、缓冲占用、暂停/录制状态；串口 DTR / RTS / 复位 DTR / 重连按钮 |
| 模型 | 工具面 | 9 个 `comm_*` 工具与 UI 共用 Host 状态；`comm_list` 返回链路、缓冲、丢弃、定时器、串口信号等完整快照 |
| 持久化 | 配置恢复 | 自动回复规则/开关、串口参数、定时器配置按链路 id 保存到 `comm-settings.json`；链路本身重启后需重新打开 |

## 安装

前提：DSH `0.2.1` 系列（实测`0.2.1-rc.2`、`0.2.1-rc.3`）。

### 方式一：从 GitHub 安装

```bash
dsh plugin --profile web add github:little-traincar/dsh-comm
```

### 方式二：从 npm 安装

```bash
dsh plugin --profile web add dsh-comm
```

Desktop 版：在「设置 → 插件」里安装，来源填 `github:little-traincar/dsh-comm` 或 `dsh-comm`，安装后**完全退出 DSH 再启动**。

> 插件在启动时加载 UI 与 Host 代码，**安装或更新后必须重启 DSH** 才会生效；只刷新页面不够。

安装后从右侧边栏进入「通信」tab 即可使用。也可以直接用独立网页打开：

```
http://127.0.0.1:<port>/comm/ui?token=<插件 uiToken>
```

`/comm/ui` 的 token 是插件自己的进程 token（不是 DSH 启动 token），由 Host 注入到 `window.__DSH_COMM__`，正常从右栏进入不需要手填；需要网页地址时向 Host 取一次即可。

## 使用

### 主题

- 标题栏右上角的 ☀ / ☾ 按钮切换深色 / 浅色，选择会被记住。
- 没有手动切换过时，面板跟随 DSH 的深/浅色主题；手动切换过之后以开关为准。
- 独立网页（`/comm/ui`）默认深色，点开关即可切换；也可以在 URL 上加 `?theme=light` 或 `?theme=dark` 临时指定。

### 串口

1. 选串口、波特率、数据位、校验、停止位、流控，按需勾 DTR / RTS / 断线重连，点「打开」。
2. 打开后状态栏出现 **DTR / RTS / 复位DTR / 重连**：DTR/RTS 点击切换电平；「复位DTR」把 DTR 拉低 100 ms 后恢复（很多模块靠这个复位）；「重连」手动重开。
3. 串口参数按端口路径保存，下次选中同一端口自动回填；也作为 `comm_open` 的缺省值。
4. 拔掉 USB 转串口：Host 会打出「串口断开」并自动重连；如果系统分配了新 COM 号，按之前记录的 USB 序列号 / VID+PID 找回，日志提示 `已重新连接 COMx`。
5. 需要 7E1 / 2 停止位 / RTS-CTS：在 `comm_open` 传 `parity:'even', dataBits:7, flowControl:'rtscts'`，或 UI 改完点「打开」，或已连接时用 `comm_serial` 的 `configure`（关闭并按新参数重开，链路 id 不变）。

### 定时 / 序列发送

- UI：发送栏「定时」勾选 + 间隔，用当前输入内容周期发送；「定时/序列…」打开完整编辑（周期 / 序列、循环、次数、自动开始）。
- 模型：

```jsonc
// 每 100 ms 发一次轮询，无限次
comm_timer { "link": "serial:COM3", "action": "start",
             "kind": "periodic", "intervalMs": 100,
             "hex": "01 03 00 00 00 01", "repeat": 0 }

// 发 A → 等 50 ms → 发 B，只跑一轮
comm_timer { "link": "serial:COM3", "action": "start", "kind": "sequence",
             "loop": false,
             "steps": [
               { "delayMs": 0,  "text": "A\r\n" },
               { "delayMs": 50, "text": "B\r\n" }
             ] }
```

`action: "start"` = 保存并运行；`"stop"` 只停运行、保留定义；`"save"` 只保存；`"delete"` 删除保存。`autostart: true` 表示下次链路打开时自动开始。

### 写 + 等回应

```jsonc
comm_write { "link": "serial:COM3", "hex": "01 03 00 00 00 01",
             "expect": "01 03 02", "expectMode": "contains",
             "expectTimeoutMs": 500 }
```

返回里有 `matched`、`waitedMs` 和窗口内的 `entries`（text + hex），一次工具调用即可完成「发指令 + 看回应」。`expectMode: "regex"` 支持正则。

> 注意：匹配窗口包含本端 TX 条目，`expect` 用宽松字符串可能命中自己发出的数据；建议用回执专属前缀（如设备回复的命令字 / 帧头）或 HEX 匹配。超时情况下 `ok` 仍为 `true`，需检查 `matched` / `timedOut`。

### 日志 / 缓冲 / 暂停

- 日志区显示 RX/TX 字节、缓冲占用与累计丢弃量。默认每条链路 2000 条、4 MiB 原始字节，超限丢最旧条目并计数，不会无界吃内存。
- 清空日志只清历史，不清 RX/TX/丢弃计数。
- 缓冲上限前的历史都能 `comm_read` 读回；超出部分以 `dropped` / `droppedBytes` 明确报告。
- UI 日志增量追加：只追加新条目，裁剪旧行时按视口锚点补偿滚动位置；关闭「自动滚动」后不会自己跳动。
- 「暂停」= 暂停接收（Host 侧）：暂停期间 RX 丢弃并计数（`comm_list` 的 `paused` / `pausedDropped` / `pausedDroppedBytes` 可见），日志与自动回复停止；TX 和系统日志照常。恢复后从新数据继续，暂停期间的数据不会补回。

### 自动回复

- **有规则**：按 contains / regex / HEX 匹配收到的数据，按规则回复，规则按链路持久化。
- **无规则 + 已启用**：把消息转给 DSH 会话，由模型用 `comm_write` 回复。
  - 去抖合并：窗口内（默认 300 ms，UI 或 `/comm/api/auto` 的 `debounceMs` 可调）的多条消息合并成一次注入，重复内容标注「重复 N 次」。
  - **默认专用会话**：首次自动回复时自动创建（并改名）`dsh-comm 自动回复` 会话，之后复用；会话 id 存在 `comm-settings.json` 的 `aiReplySessionId`，丢失/删除后自动重建。自动回复不会出现在主对话里。
  - **失效自愈**：投递前确认绑定会话仍在（不存在/被删除/归档则清掉重建）；投递报「会话不存在」时重建并重试一次；投递成功后 `aiReplyLivenessMs`（默认 30s）内该链路无发送则记一次无响应，连续两次自动解除绑定。
  - `comm_list` 的 `aiReplySessionId` 显示当前绑定（`null` = 未绑定）。
  - 指定固定会话：config 里设 `aiReplySession: '<会话 id>'`；退回旧行为（转最近活跃会话）：设 `aiReplyDedicatedSession: false`。
  - 防回环：自己刚发出的数据在 `aiReplyEchoSuppressMs`（默认 300ms）内原样回来不触发；两次转发至少间隔 `aiReplyCooldownMs`（默认 500ms）；60s 内超过 `aiReplyMaxPerMinute`（默认 30）次暂停 30s 并记日志。会话 list/create/rename/prompt 都有超时。
  - DSH 会话注入只能以 user 消息形式入队，这是该方案的固有形态；专用会话 + 合并用于把干扰降到最低。

## 模型工具

| 工具 | 作用 |
|---|---|
| `comm_list` | 列出链路、打开状态、客户端、RX/TX、缓冲/丢弃、定时器状态、串口信号/重连状态 |
| `comm_open` | `type=serial(path,baudRate,dataBits,parity,stopBits,flowControl,dtr,rts,autoReconnect)` / `tcpServer` / `tcpClient` / `udp` |
| `comm_close` | 关闭链路 |
| `comm_peers` | TCP 服务端的客户端列表 |
| `comm_read` | 按游标读缓冲，返回 text + hex |
| `comm_write` | 发文本（带 encoding）或 HEX；带 `expect` 时同时等回应；TCP 服务端可指定 peer |
| `comm_serial` | 串口运行时控制：`signals` / `set` / `pulse` / `configure` / `reconnect` |
| `comm_timer` | Host 定时/序列发送：`start` / `stop` / `save` / `status` |
| `comm_tail` | 等某个字符串出现，适合等设备 `READY` |

## 配置

`cordis.patch.yml` 里：

```yaml
- id: dsh-comm
  config:
    maxLogEntries: 2000        # 每条链路保留的条数上限
    maxLogBytes: 4194304       # 每条链路保留的原始字节上限（4 MiB）
    maxReadEntries: 200        # 单次读取上限
    uiToken: ''                # 留空则每次启动随机生成
    aiReplySession: ''         # 想指定固定会话就填会话 id；留空 = 自动创建/复用专用会话
    aiReplyDedicatedSession: true  # true 自动创建「dsh-comm 自动回复」专用会话；false 退回最近活跃会话
    aiReplyDebounceMs: 300     # 无规则自动回复的合并窗口（0–5000）
    aiReplyEchoSuppressMs: 300 # 自己发出的数据在窗口内原样收到 = 回显，不触发自动回复
    aiReplyCooldownMs: 500     # 两次自动转发的最小间隔
    aiReplyMaxPerMinute: 30    # 60s 内自动转发上限，超过暂停 30s 防回环
    aiReplyTimeoutMs: 15000    # 会话 list/create/rename/prompt 的超时
    aiReplyLivenessMs: 30000   # 转发后多久没发送算一次无响应；连续两次重建专用会话
```

`comm_list` 的返回值经过无损 JSON 收敛，不会出现 `value is not lossless JSON`。

## 缓冲与压测

以下均为 Windows 本机、Node 24 下的**实际运行结果**：

| 场景 | 结果 |
|---|---|
| TCP 回环灌 20 MB，缓冲上限 4 MiB | 90 ms（~222 MB/s）；`rx` 精确 20971520 B；缓冲 4194304 B 封顶；`dropped` 282 条 / 16777270 B（明确计数） |
| 读路径完整性：8 MB 全量读回 | 55 ms；159 条；读回字节 SHA-256 与发送流一致（无损坏） |
| `writeAndWait` 回环请求/响应 n=200 | avg **0.13 ms**，p50 0 ms，p95 1 ms，max 7 ms |
| 小缓冲极限：4 MiB 灌入 256 KiB 上限 | 29 ms；缓冲 5 条 / 262144 B；丢弃 64 条 / 3932214 B |
| 假串口桥灌 8 MB，4 MiB 上限 | 6 ms；丢弃 257 条 / 4194331 B |

结论：

- 缓冲有硬上限，内存不随采集时长增长；丢的是最旧历史，丢多少有 `dropped` / `droppedBytes` 计数，不会静默。
- 从 socket / 串口桥到 Host 计数不丢字节（压测中 `rx` 与发送量逐字节相等）；实时消费请用 `comm_read` / `comm_tail` / `comm_write+expect`。
- 串口侧理论吞吐：PowerShell 主循环 5 ms 轮询 + 16 KiB 读缓冲，921600 波特（~92 KiB/s）时每 5 ms 约 460 B，余量很大；2 Mbaud（~200 KiB/s）约 1 KiB/5 ms，也够。再高需看 Windows 驱动缓冲。

## 本地测试

```bash
npm install
node test/smoke.mjs          # Host：假 ctx + 真实 HTTP/TCP/UDP
node test/client.mjs         # Client：假 ModuleLoader/React/ctx
node test/api-v2.mjs         # v2 HTTP API：timer/serial 守卫/write+expect/auto debounce/pause
node test/auto-reply.mjs     # 自动回复规则 + 持久化
node test/ai-dedicated.mjs   # 专用会话：自动创建/复用/持久化/失败兜底/旧模式
node test/serial-errors.mjs  # 串口写失败：超时/参数错误/断开/空内容 的提示与自动重连
node test/serial-bridge-rx.mjs # 串口桥 RX 回归（需真实/虚拟串口对，见下）
node test/host-features.mjs  # 串口参数/信号/脉冲/重连、定时/序列、缓冲、write+expect、暂停接收
node test/stress-buffer.mjs  # 缓冲/吞吐/延迟压测
node test/ui-features.mjs    # UI：jsdom + fake Host（串口参数、定时器、自动回复防抖、暂停、2000 条裁剪锚点）
node test/ui-host.mjs        # UI + 真实 v2 Host 端到端（jsdom，无需 DSH 进程）
node test/resilience.mjs     # 稳定性：回显抑制/冷却/频率上限/定时器异常隔离/会话服务卡死
```

以上测试脚本均已在 Windows 本机实际运行通过。串口桥 RX 回归需要一对串口（真实 USB 转串口短接 TX/RX，或虚拟串口对）：

```powershell
$env:DSH_COMM_RX_PORT='COM0'   # 插件打开的一端
$env:DSH_COMM_TX_PORT='COM10'  # 从这一端写入
node test/serial-bridge-rx.mjs
```

## 稳定性

- 所有定时器（`setTimeout` / `setInterval`）都 `unref` 且回调内部 `try/catch`：定时发送、序列、重连、健康检查里任何异常只会停掉对应链路并记一条系统日志，不会作为未捕获异常抛进 Host 进程。
- 所有 PowerShell 调用（端口枚举、串口操作）都有超时；`comm_list` / `/comm/api/ports` 不会永久挂起。
- **串口桥的 stdin 用原始标准输入流 `ReadAsync` 读取**，不再用 `Console.In.ReadLineAsync()`：后者在无控制台、stdin 被重定向的 PowerShell 5.1 里会同步阻塞，曾导致 RX 循环被饿死（表现为「能发不能收」）；`test/serial-bridge-rx.mjs` 是这条路径的回归测试。
- `comm_write` 的 `expect` 等待者在成功/超时后都会清理，不会随调用次数堆积。
- 日志渲染是增量追加 + 锚点补偿的确定性滚动，不依赖浏览器 `overflow-anchor`；2000 条上限裁剪不会让关闭自动滚动的视口跳动。
- 暂停接收在 Host 侧丢弃 RX，串口桥 / socket / UDP 仍在持续读取，不会把内核缓冲或串口 FIFO 顶爆。
- 自动回复有回显抑制、冷却、每分钟上限；会话 list/create/rename/prompt 都有超时，DSH 会话服务卡住时自动回复会失败并记日志，其它工具/接口不受影响。
- 内存：每链路日志 4 MiB / 2000 条硬上限；`write+expect` 等待者只在有并发请求时短暂存在；自动回复待处理消息最多 50 条。

## 已知限制

- **串口仅 Windows**：走 PowerShell 桥；Linux/macOS 暂不支持（网络功能跨平台）。
- **虚拟串口兼容性**：HHD / Eltima 等虚拟串口只建单端、对端未打开，或端口是别名/共享/TCP/管道但没有后端时，写会报「参数错误」（Win32 `ERROR_INVALID_PARAMETER`）。这不是插件问题，纯 .NET `SerialPort.Write` 同样报错；建议使用成对的 com0com 端口或真实 USB 转串口。
- **真实硬件覆盖有限**：串口已用假桥覆盖参数/信号/重连/定时逻辑，并用真实 USB 转串口验证过 RX；`7E1`、`2 停止位`、`RTS-CTS / XON-XOFF`、复位脉冲等仍需按实际设备验证。
- **TCP 客户端没有自动重连**: TCP 是流视图，没有帧/粘包解析。
- **`expect` / `comm_tail` 不区分收发方向**：匹配窗口包含本端 TX 条目，宽松字符串可能命中自己发出的数据；请用回执专属前缀或 HEX。`comm_write` 超时仍返回 `ok: true`，要以 `matched` / `timedOut` 为准。
- **UDP 目标不会自动跟随**：设备修改 IP / 端口后，UDP 链路仍发往旧地址，不会报错；需要手动改链路远端或重新打开。
- **链路状态不持久**：重启 DSH / 插件后已打开的链路需要重新打开；`/comm/ui` 的 token 每次启动随机（除非配置 `uiToken`），旧网页标签会 401，需要刷新或重新取地址。
- **主题跟随边界**：手动切换过主题后不再跟随 DSH；独立网页读不到 DSH 主题，默认深色（可用开关或 `?theme=` 指定）。
- **日志与录制边界**：Host 每链路 2000 条 / 4 MiB 上限，超出丢最旧（有丢弃计数）；浏览器「录制」只在浏览器内存里。
- **自动回复（AI 模式）的固有形态**：回复以 user 消息注入专用会话；有去抖、冷却、回显抑制与每分钟上限（默认 30 次/分），待处理消息上限 50 条；依赖 DSH 会话服务。
- **远程访问**：`/comm/bootstrap` 仅允许 loopback；从其他机器直连 DSH 地址时拿不到插件 token，独立网页需要手动带 token URL，且 token 每次重启会变。插件本身不额外加鉴权层。
- **安装/更新后需重启 DSH**：UI 与 Host 代码在插件启动时加载，只刷新页面不会更新。
- **兼容性**：面向 DSH `0.2.1` 系列（`0.2.1-rc.2`、`0.2.1-rc.3` 实测），其他版本未验证。

## 安全提醒

- `tcpServer` 绑 `0.0.0.0` 会把端口开到局域网；UDP 同理。默认建议只绑 `127.0.0.1`。
- `/comm/ui` 和 `/comm/api/*` 用进程 token 保护，但 token 会出现在页面 URL 和 `window.__DSH_COMM__` 里，不要截图/外传。
- 日志可能含设备序列号、密钥、协议明文，导出前自己确认。
- 插件 Host 半边在 DSH 进程里运行，拥有和 DSH 相同的文件/网络权限，只安装可信来源的插件。

## 许可证

- 当前仓库使用 **Apache License 2.0**（见 `LICENSE` 与 `NOTICE`）。
- 自 **v0.1.9**起为 Apache-2.0；**v0.1.8 及更早** 的已发布版本为 MIT License。
- 已发布版本的授权不可撤回，旧版本继续按 MIT 有效。
