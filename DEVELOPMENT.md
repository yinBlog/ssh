# SSH Studio 开发指南

## 环境要求

- **Node.js**: 18.0.0 或更高版本
- **npm**: 8.0.0 或更高版本
- **Git**: 用于版本控制

## 快速开始

### 1. 克隆项目

```bash
git clone https://github.com/yinBlog/ssh.git
cd ssh
```

### 2. 安装依赖

```bash
npm install
```

首次安装会下载 Electron，可能需要 5-10 分钟，取决于网络速度。

### 3. 启动开发模式

```bash
# 普通启动，自动打开开发者工具
npm start

# 或使用远程调试端口(便于外部工具连接)
npm run dev
```

## 构建与打包

### 开发构建

```bash
# 检查构建配置(不打包)
npm run pack
```

### 生产构建

```bash
# 为当前平台打包
npm run build

# 仅 Windows
npm run build:win

# 仅 macOS
npm run build:mac

# 仅 Linux
npm run build:linux

# 所有平台
npm run build:all
```

输出文件在 `dist/` 目录下。

## 功能特性

### 连接与会话

- **多标签终端**：基于 xterm.js,每个标签一个独立 SSH 会话;重连不影响标签与终端缓冲
- **密码 / 密钥认证**:支持 keyboard-interactive;敏感字段(密码 / 私钥口令)用操作系统级加密(Windows DPAPI)落盘
- **主机指纹校验(TOFU)**:首次连接记录指纹,变更时弹窗警告(防中间人)
- **跳板机 / ProxyJump**:先连 bastion 主机,再经其 `forwardOut` 打通内网目标;跳板凭据同样加密落盘
- **自动重连 + 心跳**:`keepaliveCountMax` 检测死连接;掉线后指数退避自动重连(2s→5s→10s→15s→30s,最多 10 次),带倒计时浮层;初次连接失败不会死循环重试

### 运维监控

- **底部状态栏**:实时响应延迟、CPU 负载、内存、磁盘、运行时长,带迷你占比条与阈值变色
- **资源监控看板**(📊):CPU 使用率/内存/Swap/网络吞吐(均含 sparkline 折线)、磁盘分区、Top 进程;按需轮询(2/3/5/10s)
- **实时远程日志**(📜):`tail -F` 流式跟踪,支持日志轮转跟随;关键字过滤+高亮、暂停/继续、自动换行、清空、error/warn 着色
- **阈值桌面通知**(🔔):CPU/内存/磁盘越过严重阈值时弹系统通知,边沿触发(进入危险才提醒一次,恢复后复位)

### 操作工具

- **批量命令广播**(📡):向多台已连接服务器同时下发命令(支持多行脚本)
- **SFTP 文件管理**(📁):浏览、上传、下载、新建文件夹、重命名、删除
- **端口转发 / 隧道**(🔀):本地转发(Local)与动态 SOCKS5 代理

## 项目结构

```
ssh/
├── src/
│   ├── main.js                # 主进程入口(连接编排、IPC、监控采集)
│   ├── preload.js             # 渲染进程安全桥接
│   ├── lib/
│   │   ├── logger.js          # 结构化日志模块
│   │   ├── error-handler.js   # 统一错误处理
│   │   └── validators.js      # 输入验证(主机/跳板/隧道)
│   └── renderer/
│       ├── index.html         # UI 结构
│       ├── styles.css         # 样式
│       └── renderer.js        # UI 逻辑
├── assets/                    # 应用图标、资源
├── .github/
│   └── workflows/             # GitHub Actions CI/CD
├── package.json               # 项目配置 & 构建脚本
├── DEVELOPMENT.md             # 本文件
└── README.md
```

## 代码规范

### JavaScript

- 使用 `'use strict'` 在文件顶部
- 使用 `const` 而非 `var`
- 使用箭头函数处理异步
- 异常必须捕获，避免未处理的 Promise rejection
- 缩进使用 2 个空格

### 命名约定

- **函数名**: camelCase (e.g., `createWindow`, `connectToHost`)
- **常量名**: UPPER_SNAKE_CASE (e.g., `STAT_CMD`, `DASH_CMD`)
- **类名**: PascalCase (e.g., `SSHConnection`, `Logger`)
- **私有方法**: 前缀下划线 (e.g., `_parseError`)

### 注释规范

```javascript
// 简单注释用双斜杠

/**
 * 函数说明文档
 * @param {Type} name - 参数描述
 * @returns {Type} 返回值描述
 */
function example(name) {
  // 实现
}
```

## IPC 通信

主进程与渲染进程通过 `window.sshBridge` 通信(定义在 `src/preload.js`)。

### 主要 IPC 通道

| 通道 | 方向 | 说明 |
| --- | --- | --- |
| `hosts:list/save/delete` | invoke | 主机配置增删查(含跳板机配置) |
| `settings:get/set` | invoke | 应用设置(采集间隔、通知开关等) |
| `ssh:connect` | invoke | 建立连接(支持 ProxyJump) |
| `ssh:data/resize/disconnect` | send | 终端输入 / 尺寸 / 断开 |
| `ssh:output/status/stats` | on | 终端输出 / 连接状态 / 状态栏指标 |
| `ssh:hostkey` ↔ `ssh:hostkey-reply` | on/send | 主机指纹确认(TOFU) |
| `monitor:snapshot` | invoke | 资源看板一次性富指标采集 |
| `log:start/stop` | invoke | 实时日志(tail -F)起止 |
| `log:data/end` | on | 日志流数据 / 结束 |
| `tunnel:list/add/remove` | invoke | 端口转发 / SOCKS5 隧道 |
| `sftp:list/download/upload/mkdir/delete/rename` | invoke | SFTP 文件操作 |
| `app:notify` | send | 触发桌面通知(阈值告警) |
| `win:minimize/maximize/close` | send | 自绘标题栏窗口控制 |

### 添加新的 IPC 接口步骤

#### 1. 主进程 (`src/main.js`)

```javascript
ipcMain.handle('feature:action', async (_e, arg) => {
  // 处理逻辑
  try {
    const result = await doSomething(arg);
    return { ok: true, data: result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
```

#### 2. 预加载脚本 (`src/preload.js`)

```javascript
contextBridge.exposeInMainWorld('sshBridge', {
  // 现有接口...
  featureAction: (arg) => ipcRenderer.invoke('feature:action', arg),
});
```

#### 3. 渲染进程 (`src/renderer/renderer.js`)

```javascript
const result = await window.sshBridge.featureAction(arg);
if (result.ok) {
  console.log('Success:', result.data);
} else {
  console.error('Error:', result.error);
}
```

## 关键实现说明

### 连接编排与跳板机 (`ssh:connect`)

- `buildAuth(ep, sessionId)` 为目标或跳板机构造 ssh2 连接参数,统一注入心跳(`keepaliveInterval` / `keepaliveCountMax`)与 TOFU 指纹校验
- 无跳板:TCP 预检目标 → 直连
- 有跳板:TCP 预检跳板机 → 连 bastion → `forwardOut` 到目标 → 用得到的 `sock` 连目标
- 会话对象(`sessions` Map)持有 `conn` / `jumpConn` / `stream` / `statsTimer` / `tunnels` / `logs`,断开时统一清理

### 监控采集

- `STAT_CMD`:轻量单行指标,驱动底部状态栏(随会话定时采集)
- `DASH_CMD`:分段富指标(CPU/内存/磁盘/网络/进程),供资源看板按需轮询;CPU 使用率与网络速率用「相邻两次快照差值」在渲染进程计算

### 自动重连(渲染进程)

- 仅在「曾连接成功后掉线」或「已处于重连周期」时自动重连,避免初次失败(认证/地址错)死循环
- `cancelReconnectTimer` 只取消挂起定时器并保留退避计数;`clearReconnect` 彻底结束周期(成功 / 用户停止 / 关闭标签 / 用尽)

## 模块说明

### `src/lib/logger.js` - 结构化日志

```javascript
const logger = require('./lib/logger');

logger.log('Connection established', { host: '192.168.1.1' });
logger.warn('High memory usage', { usage: '85%' });
logger.error('Connection failed', error);
logger.debug('Debug info', { details: '...' });
```

日志文件保存在用户数据目录的 `logs/` 文件夹，每天一个文件。

### `src/lib/error-handler.js` - 错误处理

```javascript
const { parseSSHError, getUserFriendlyMessage } = require('./lib/error-handler');

try {
  await conn.connect(config);
} catch (err) {
  const sshError = parseSSHError(err);
  const userMsg = getUserFriendlyMessage(sshError);
  console.error(userMsg);
}
```

### `src/lib/validators.js` - 输入验证

```javascript
const { validateHostConfig } = require('./lib/validators');

const result = validateHostConfig(hostConfig);
if (!result.valid) {
  result.errors.forEach(err => console.error(err));
}
```

## 调试技巧

### 开发者工具

- 启动时自动打开(未打包或 `DEBUG=1` 时)
- 按 **F12** 随时切换
- 在非终端区域按 F12 才能生效(因为终端会捕获按键)
- 使用 `console.log` 输出到控制台

### 远程调试

```bash
npm run dev  # 启动 --remote-debugging-port=9223
# 在 Chrome 中访问 chrome://inspect
```

### 查看日志

```bash
# Windows
%APPDATA%\ssh-connect-tool\logs

# macOS
~/Library/Application Support/ssh-connect-tool/logs

# Linux
~/.local/share/ssh-connect-tool/logs
```

## 测试

当前项目暂无自动化测试。建议后续集成：

```bash
# 单元测试（待集成）
npm test

# E2E 测试（待集成）
npm run test:e2e
```

## 常见问题

### Q: 编译失败 "Cannot find module 'ssh2'"

A: 运行 `npm rebuild` 重建原生模块。

```bash
npm rebuild
```

### Q: Windows 打包失败

A: 确保已安装 Visual Studio Build Tools 或类似工具，以支持原生模块编译。

或在 npm 中安装全局工具：

```bash
npm install --global windows-build-tools
```

### Q: 如何修改应用图标

A: 将 PNG/ICO 图片放在 `assets/` 目录，在 `package.json` 的 `build` 配置中指定路径。

### Q: 如何修改应用名称

A: 在 `package.json` 中修改 `name` 字段和 `build.productName`。

### Q: 如何查看所有可用命令

A: 运行 `npm run` 查看所有脚本。

## 贡献指南

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'feat: add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 开启 Pull Request

### 提交信息规范

使用 [Conventional Commits](https://www.conventionalcommits.org/) 格式：

```
feat: add new feature
fix: fix a bug
chore: update dependencies
docs: update documentation
refactor: refactor code
perf: improve performance
test: add tests
```

## 许可证

Apache License 2.0

## 联系方式

如有问题或建议，欢迎提交 Issue 或 PR。
