# dsh-comm

DSH 的内嵌通信调试台：**串口 / TCP 服务端 / TCP 客户端 / UDP** 四模式，文本与 HEX 收发、编码切换、快捷输入、日志录制与导出。UI 以右栏 tab 的形式嵌在 DSH 里，不是独立网页。

## 本次更新（针对串口评测）

| 评测问题 | 现在的能力 |
|---|---|
| 串口只暴露波特率 | `comm_open` / UI 支持 **数据位 5–8、校验 N/E/O/M/S、停止位 1/1.5/2、流控 none/RTS-CTS/XON-XOFF、DTR/RTS 初始电平、断线自动重连**；参数按端口持久化。新增 `comm_serial` 可在运行时改参数、拉 DTR/RTS、做复位脉冲。 |
| 没有定时/序列发送 | **Host 侧定时器**：周期发送（可限次数）与多步序列（每步 `delayMs`，可循环/限轮次）。开在 Host，关掉面板、切 tab 都继续跑，重启后可按 `autostart` 恢复。模型用 `comm_timer`，UI 的「定时/序列…」同一套。 |
| 没有自动重连 | 串口拔插后自动重开；**端口号从 COM1 变成 COM7 也能按 USB 序列号 / VID+PID 找回**。有健康检查（3s ping），断线状态在 `comm_list` 的 `serial.reconnecting` 可见。 |
| 缓冲上限未知 | 双上限：`maxLogEntries`（默认 2000 条）+ `maxLogBytes`（默认 4 MiB/链路）。超限丢最旧条目，**丢弃条数/字节数计入 `dropped` / `droppedBytes`**，不会静默丢。压测数据见下。 |
| 交互延迟 2–5 秒 | 新增 **`comm_write` 的 `expect`**：发一条指令并等回应，**一次工具往返**完成「改寄存器→看反应」。TCP 回环实测平均 0.13 ms；真实串口只额外加设备响应时间。 |
| 自动回复是注入式提示 | 无规则时的 AI 转发改为 **去抖合并**（默认 300 ms 窗口，可配）：窗口内多条消息/重复内容合并成**一次**会话注入；并且默认**自动创建/复用专用会话「dsh-comm 自动回复」**，自动回复不再出现在你的主对话里。 |

> 版本号未改动，仍为当前发布版。真实 USB 转串口硬件在开发机上不可用，串口功能按 .NET `System.IO.Ports.SerialPort` 语义实现并用假桥做了协议/重连/参数/信号测试；第一次接真实设备时建议先用 7E1 或 2 停止位的小设备验证一下。

## 架构

```
dsh-comm
├─ lib/index.js          Host 半边
│   ├─ CommManager       串口 / TCP Server / TCP Client / UDP、定时器、日志缓冲
│   ├─ 模型工具          comm_list/open/close/read/write/serial/timer/peers/tail
│   ├─ /comm/ui          UI 页面
│   ├─ /comm/api/*       轮询 / 打开 / 串口控制 / 定时器 / 发送 / 端口
│   └─ index 注入        window.__DSH_COMM__ = { base, token }
├─ lib/serial-windows.js Windows 串口桥（Node 侧）
├─ lib/serial-host.ps1   PowerShell 侧 JSON 行协议
├─ lib/client.js         Client 半边
└─ lib/ui.html           控制台页面
```

- 链路状态、日志、定时器全部在 Host：关面板、切 tab、刷新页面不会断链，也不会停表。
- 浏览器只拿轮询 API，不直接碰 socket。
- 串口走 PowerShell 的 `System.IO.Ports.SerialPort`，避免 `serialport` 原生模块的 ABI/构建问题。
- 串口接收不用 `DataReceived` 事件（跨线程且按 15 ms 轮询会丢字节），改成主循环每 5 ms `BytesToRead` + `Read(byte[])`，字节直读，二进制/GBK 不会被编码破坏。
- UI iframe 与 DSH 页面同源，Cookie 自动带上；`/comm/*` 额外要求进程 token。

## 安装

前提：DSH `0.2.1-rc.2`（`0.2.0-rc.2` 也兼容）。

```bash
# 在插件目录
npm pack
# 得到 dsh-comm-<version>.tgz
dsh plugin --profile web add ./dsh-comm-<version>.tgz
# 重启 dsh web
dsh web
```

Desktop 版：在「设置 → 插件」里安装同一个 tarball（或让 DSH 从本地路径安装），然后重启应用。若桌面插件窗口只接受 npm 包名，可先把 tarball 放到本地并用 CLI 的 `plugin add` 安装到 web profile，再通过 `dsh web` 使用。

安装后打开右侧边栏的引导页，会看到「通信」入口；点开就是一个 tab。也可以直接从 DSH 页面地址打开：

```
http://127.0.0.1:<port>/comm/ui?token=<Host 启动日志里打印的 uiToken 或注入值>
```

> `/comm/ui` 的 token 是插件自己的进程 token，不是 DSH 的启动 token；它由 Host 注入到 `window.__DSH_COMM__`，正常从右栏进入即可，不需要手填。

## 使用

### 串口

1. 选串口、波特率、数据位、校验、停止位、流控，按需勾 DTR / RTS / 断线重连，点「打开」。
2. 打开后状态栏会出现 **DTR / RTS / 复位DTR / 重连**：DTR/RTS 点击切换电平；「复位DTR」把 DTR 拉低 100 ms 后恢复（很多模块靠这个复位）；「重连」手动重开。
3. 串口参数会按端口路径保存，下次选中同一端口自动回填；也提供给 `comm_open` 作为缺省值。
4. 拔掉 USB 转串口：Host 会打出「串口断开」，自动重连；如果系统分配了新 COM 号，按之前记录的 USB 序列号/VID+PID 找回，日志里提示 `已重新连接 COMx`。
5. 想换 7E1 / 2 停止位 / RTS-CTS：在 `comm_open` 传 `parity:'even', dataBits:7, flowControl:'rtscts'`，或 UI 里改完点「打开」，或在已连接时用 `comm_serial` 的 `configure`（会关闭并按新参数重开，链路 id 不变）。

### 定时 / 序列发送（Host 侧）

- UI：发送栏「定时」勾选 + 间隔，直接用当前输入内容周期发送；「定时/序列…」打开完整编辑（周期/序列、循环、次数、自动开始）。
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

### 写 + 等回应（低延迟请求/响应）

```jsonc
comm_write { "link": "serial:COM3", "hex": "01 03 00 00 00 01",
             "expect": "01 03 02", "expectMode": "contains",
             "expectTimeoutMs": 500 }
```

返回里有 `matched`、`waitedMs` 和窗口内收到的 `entries`（text + hex）。这样一次工具调用就能完成「发指令 + 看回应」，不用 `comm_write` 后再 `comm_read` 多等一轮模型往返。`expectMode: "regex"` 支持正则。

### 日志 / 缓冲

- 日志区显示 RX/TX 字节、当前缓冲占用与累计丢弃量。默认每条链路最多保留 2000 条、4 MiB 原始字节，超限丢最旧条目并计数，不会无界吃内存。
- 清空日志只清历史，不清 RX/TX/丢弃计数。
- 缓冲达到上限前的历史都能 `comm_read` 读回；超过上限的部分会以 `dropped` / `droppedBytes` 明确告诉你丢了多少。

### 自动回复

- **有规则**：按 contains / regex / HEX 匹配收到的数据，按规则回复（可设编码、延迟、回发送者或广播），规则按链路持久化。
- **无规则 + 已启用**：方案 A —— 把消息转给 DSH 会话，由模型用 `comm_write` 回复。
  - 去抖合并：窗口内（默认 300 ms，UI 或 `/comm/api/auto` 的 `debounceMs` 可调）的多条消息合并成一次注入，重复内容会标注「重复 N 次」。
  - **默认专用会话**：首次自动回复时自动创建（并改名）`dsh-comm 自动回复` 会话，之后一直复用；会话 id 存在 `comm-settings.json` 的 `aiReplySessionId`，丢了/删了会自动重建。这样自动回复不会出现在你正在聊的主对话里，在左侧会话列表能看到它，也可以点进去看它回了什么。
  - 想指定固定会话：插件 config 里设 `aiReplySession: '<会话 id>'`（优先于自动创建）。
  - 想退回旧行为（转给最近活跃的会话）：设 `aiReplyDedicatedSession: false`。
  - 防回环：自己刚发出的数据在 `aiReplyEchoSuppressMs`（默认 300ms）内原样回来（串口回显/TCP 回环/设备 echo）不会触发自动回复；两次转发至少间隔 `aiReplyCooldownMs`（默认 500ms）；60s 内超过 `aiReplyMaxPerMinute`（默认 30）次会暂停 30s 并记系统日志。会话 list/create/rename/prompt 都有超时，DSH 会话服务卡住也不会把自动回复永久挂住。
  - DSH 的会话注入只能以 user 消息形式入队，这是方案 A 的固有形态；专用会话 + 合并是把它对主对话的干扰降到最低的方式。会话创建失败时会退回最近会话并记系统日志；没有可用会话/转发失败时只记系统日志，不会乱回数据。

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
| `comm_tail` | 等某个字符串出现（带超时），适合等设备 `READY` |

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
```

## 缓冲与压测

`node test/stress-buffer.mjs`（Windows 本机，Node 24，TCP 回环 / 假串口桥，无真实串口硬件）：

| 场景 | 结果 |
|---|---|
| TCP 回环灌 20 MB，缓冲上限 4 MiB | 90 ms（~222 MB/s）；`rx` 精确 20971520 B；缓冲 4194304 B 封顶；`dropped` 282 条 / 16777270 B（明确计数） |
| 读路径完整性：8 MB 全量读回 | 55 ms；159 条；读回字节 SHA-256 与发送流一致（无损坏） |
| `writeAndWait` 回环请求/响应 n=200 | avg **0.13 ms**，p50 0 ms，p95 1 ms，max 7 ms |
| 小缓冲极限：4 MiB 灌入 256 KiB 上限 | 29 ms；缓冲 5 条 / 262144 B；丢弃 64 条 / 3932214 B |
| 假串口桥灌 8 MB，4 MiB 上限 | 6 ms；丢弃 257 条 / 4194331 B |

结论：
- 缓冲有硬上限，内存不会随采集时长增长；丢的是最旧历史，丢多少有 `dropped`/`droppedBytes` 计数，不会静默。
- 从 socket/串口桥到 Host 计数不丢字节（压测里 `rx` 与发送量逐字节相等）；实时消费请用 `comm_read`/`comm_tail`/`comm_write+expect`。
- 串口侧理论吞吐：PowerShell 主循环 5 ms 轮询 + 16 KiB 读缓冲，921600 波特（~92 KiB/s）时每 5 ms 约 460 B，余量很大；2 Mbaud（~200 KiB/s）约 1 KiB/5 ms，也够。再高需看 Windows 驱动缓冲。

## 本地测试

```bash
npm install
node test/smoke.mjs          # Host：假 ctx + 真实 HTTP/TCP/UDP
node test/client.mjs         # Client：假 ModuleLoader/React/ctx
node test/api-v2.mjs         # v2 HTTP API：timer/serial 守卫/write+expect/auto debounce
node test/auto-reply.mjs     # 自动回复规则 + 持久化
node test/ai-dedicated.mjs   # 专用会话：自动创建/复用/持久化/失败兜底/旧模式
node test/host-features.mjs  # 串口参数/信号/脉冲/重连、定时/序列、缓冲、write+expect
node test/stress-buffer.mjs  # 缓冲/吞吐/延迟压测
node test/ui-features.mjs    # UI：jsdom + fake Host（串口参数、定时器、自动回复防抖）
node test/ui-host.mjs        # UI + 真实 v2 Host 端到端（jsdom，无需 DSH 进程）
node test/resilience.mjs     # 稳定性：回显抑制/冷却/频率上限/定时器异常隔离/会话服务卡死
```

需要真实 DSH 的 UI 测试：

```bash
# 隔离的 DSH_HOME，避免影响当前 Desktop
npx @deepseek-ai/dsh@0.2.1-rc.2 web --no-open --port 3999
# 另开一个终端，把启动日志里的 token 传进去
node test/ui-live.mjs <插件 token>
```

本次改动已在真实 DSH `0.2.1-rc.2`（隔离 profile + 链接安装）上验证：`/comm/bootstrap`、`/comm/ui`、TCP 打开/收发/清空、`write+expect`、Host 定时器、自动回复 debounce、`/serial` 守卫均通过，启动日志无插件报错。

## 稳定性

- 所有定时器（`setTimeout`/`setInterval`）都 `unref` 且回调内部 `try/catch`：定时发送/序列/重连/健康检查里任何异常只会停掉对应链路并记一条系统日志，不会作为未捕获异常抛进 Host 进程。
- 所有 PowerShell 调用（端口枚举、串口操作）都有超时；`comm_list` / `/comm/api/ports` 不会永久挂起。
- `comm_write` 的 `expect` 等待者在成功/超时后都会清理，不会随调用次数堆积。
- 自动回复有回显抑制、500ms 冷却、每分钟 30 次上限；会话 `list/create/rename/prompt` 都有超时，DSH 会话服务卡住时自动回复会失败并记日志，其它工具/接口不受影响。
- 内存：每链路日志 4 MiB / 2000 条硬上限；`write+expect` 等待者只在有并发请求时短暂存在；自动回复待处理消息最多 50 条。

## 已知限制

- **串口仅 Windows**：走 PowerShell 桥；Linux/macOS 暂不支持（网络功能跨平台）。
- 串口功能已用假桥覆盖参数/信号/重连/定时逻辑，但开发机没有真实 USB 转串口设备，**真实硬件行为尚未逐项验证**；第一次接设备建议先用小设备验证 7E1/2 停止位/流控/复位脉冲。
- TCP 客户端没有自动重连（串口有）；TCP 是流视图，还没有帧/粘包解析。
- 浏览器侧「录制日志」仍只在浏览器内存里；Host 侧日志缓冲是有限的（见上）。
- 公网/远程访问依赖 DSH 自己的部署方式，本插件不额外加鉴权层，只靠进程 token + 同源 Cookie。
- 安装完点击立即启用可能提示无法启用，重启 DSH 后即可正常使用。

## 安全提醒

- `tcpServer` 绑 `0.0.0.0` 会把端口开到局域网；UDP 同理。默认建议只绑 `127.0.0.1`。
- `/comm/ui` 和 `/comm/api/*` 用进程 token 保护，但 token 会出现在页面 URL 和 `window.__DSH_COMM__` 里，不要截图/外传。
- 日志可能含设备序列号、密钥、协议明文，导出前自己确认。
- 插件 Host 半边在 DSH 进程里运行，拥有和 DSH 相同的文件/网络权限，只安装可信来源的插件。
