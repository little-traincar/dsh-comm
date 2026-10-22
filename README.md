# dsh-comm

DSH 的内嵌通信调试台：**串口 / TCP 服务端 / TCP 客户端 / UDP** 四模式，文本与 HEX 收发、编码切换、快捷输入、日志录制与导出。UI 以右栏 tab 的形式嵌在 DSH 里，不是独立网页。

## 架构

```
dsh-comm
├─ lib/index.js          Host 半边
│   ├─ LinkManager       串口 / TCP Server / TCP Client / UDP
│   ├─ 模型工具          comm_list/open/close/read/write/peers/tail
│   ├─ /comm/ui          UI 页面
│   ├─ /comm/api/*       轮询 / 打开 / 关闭 / 发送 / 端口
│   └─ index 注入        window.__DSH_COMM__ = { base, token }
├─ lib/serial-windows.js Windows 串口桥
├─ lib/serial-host.ps1   PowerShell 端 JSON 行协议
├─ lib/client.js         Client 半边
└─ lib/ui.html           控制台页面
```

- 链路状态全部在 Host，关闭面板/切换 tab/刷新页面不会断链；
- 浏览器只拿轮询 API，不直接碰 socket；
- 串口走 PowerShell 的 `System.IO.Ports.SerialPort`，避免 `serialport` 原生模块的 ABI/构建问题；
- UI iframe 与 DSH 页面同源，Cookie 自动带上；`/comm/*` 额外要求进程 token。

## 安装

前提：DSH `0.2.1-rc.2`（`0.2.0-rc.2` 也兼容）。

```bash
# 在插件目录
npm pack
# 得到 dsh-comm-0.1.0.tgz
dsh plugin --profile web add ./dsh-comm-0.1.0.tgz
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

1. 选模式：串口 / TCP 服务 / TCP 客户端 / UDP；
2. 填参数，点「打开 / 监听 / 连接」；
3. 日志区看收发；工具栏切 **文本 / HEX**、选择 **编码**、时间戳、自动滚动、暂停、过滤；
4. 快捷输入默认是模板，点「✎ 编辑」可增删改（每项独立选择文本/HEX），保存在浏览器 `localStorage`；
5. 右上角下载图标：开始录制、导出 `.log` / `.csv` / 接收原始 `.bin`；
6. 日志区滚上去看历史时自动暂停跟随，右下角「↓ 最新」回到底部。

### 模型工具

| 工具 | 作用 |
|---|---|
| `comm_list` | 列出链路、打开状态、客户端、RX/TX 字节 |
| `comm_open` | `type=serial/tcpServer/tcpClient/udp` + 对应参数 |
| `comm_close` | 关闭链路 |
| `comm_peers` | TCP 服务端的客户端列表 |
| `comm_read` | 按游标读缓冲，返回 text + hex |
| `comm_write` | 发文本（带 encoding）或 HEX；TCP 服务端可指定 peer |
| `comm_tail` | 等某个字符串出现（带超时），适合等设备 `READY` |

## 配置

`cordis.patch.yml` 里：

```yaml
- id: dsh-comm
  config:
    maxLogEntries: 2000   # 每链路保留的条数
    maxReadEntries: 200   # 单次读取上限
    uiToken: ''           # 留空则每次启动随机生成
```

## 本地测试

```bash
npm install
node test/smoke.mjs       # Host：假 ctx + 真实 HTTP/TCP/UDP
node test/client.mjs      # Client：假 ModuleLoader/React/ctx
```

需要真实 DSH 的 UI 测试：

```bash
# 隔离的 DSH_HOME，避免影响现有 Desktop
npx @deepseek-ai/dsh@0.2.1-rc.2 web --no-open --port 3999
# 另开一个终端，把启动日志里的 token 传给：
node test/ui-live.mjs <插件 token>
```

## 已知限制（v1）

- **串口仅 Windows**：走 PowerShell 桥；Linux/macOS 暂不支持（网络功能跨平台）；
- 串口 DTR/RTS/流控未暴露（后续加）；
- TCP 客户端无自动重连、无心跳；
- TCP 是流视图，还没有帧/粘包解析；
- 日志录制在浏览器侧（面板关掉就停），Host 侧持久化日志是下一版；
- 公网/远程访问依赖 DSH 自己的部署方式，本插件不额外加鉴权层，只靠进程 token + 同源 Cookie。

## 安全提醒

- `tcpServer` 绑 `0.0.0.0` 会把端口开到局域网；UDP 同理。默认建议只绑 `127.0.0.1`；
- `/comm/ui` 和 `/comm/api/*` 用进程 token 保护，但 token 会出现在页面 URL 和 `window.__DSH_COMM__` 里，不要截图/外传；
- 日志可能含设备序列号、密钥、协议明文，导出前自己确认；
- 插件 Host 半边在 DSH 进程里运行，拥有和 DSH 相同的文件/网络权限，只安装可信来源的插件。
