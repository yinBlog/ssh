'use strict';

const { app, BrowserWindow, ipcMain, dialog, safeStorage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const { Client } = require('ssh2');
const logger = require('./lib/logger');
const { validateHostConfig, validateTunnelConfig } = require('./lib/validators');
const { parseSSHError, getUserFriendlyMessage } = require('./lib/error-handler');

// ---------------------------------------------------------------------------
// 连接前 TCP 预检:先确认目标 host:port 可达,避免把网络问题
// 误报成 ssh2 的 "Connection lost before handshake"
// ---------------------------------------------------------------------------
function tcpProbe(host, port, timeout = 6000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok, err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, err });
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true, null));
    socket.once('timeout', () => finish(false, `连接超时(>${timeout / 1000}s)`));
    socket.once('error', (e) => finish(false, e.message));
    try {
      socket.connect(port, host);
    } catch (e) {
      finish(false, e.message);
    }
  });
}

// ---------------------------------------------------------------------------
// 持久化:已保存的主机列表存在用户数据目录下的 hosts.json
// ---------------------------------------------------------------------------
const hostsFile = () => path.join(app.getPath('userData'), 'hosts.json');

// 敏感字段(密码 / 私钥口令)用操作系统级加密(Windows DPAPI)落盘,
// 以 "enc:" 前缀标记;系统不支持加密时回退明文(并尽量提示)。
function encField(v) {
  if (!v) return v;
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return `enc:${safeStorage.encryptString(v).toString('base64')}`;
    }
  } catch { /* 回退明文 */ }
  return v;
}

function decField(v) {
  if (typeof v === 'string' && v.startsWith('enc:')) {
    try { return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64')); }
    catch { return ''; }
  }
  return v;
}

function loadHosts() {
  try {
    const arr = JSON.parse(fs.readFileSync(hostsFile(), 'utf8'));
    return arr.map((h) => ({
      ...h,
      password: decField(h.password),
      passphrase: decField(h.passphrase),
      // 跳板机凭据同样解密
      jump: h.jump && h.jump.host
        ? { ...h.jump, password: decField(h.jump.password), passphrase: decField(h.jump.passphrase) }
        : undefined,
    }));
  } catch {
    return [];
  }
}

function saveHosts(hosts) {
  const enc = hosts.map((h) => {
    const out = { ...h, password: encField(h.password), passphrase: encField(h.passphrase) };
    // 仅在启用(填了跳板地址)时持久化跳板配置,凭据加密
    if (h.jump && h.jump.host) {
      out.jump = { ...h.jump, password: encField(h.jump.password), passphrase: encField(h.jump.passphrase) };
    } else {
      delete out.jump;
    }
    return out;
  });
  fs.writeFileSync(hostsFile(), JSON.stringify(enc, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// 主机指纹校验(known_hosts,TOFU):首次连接记录指纹,变更时警告
// ---------------------------------------------------------------------------
const knownHostsFile = () => path.join(app.getPath('userData'), 'known_hosts.json');

function loadKnownHosts() {
  try { return JSON.parse(fs.readFileSync(knownHostsFile(), 'utf8')); }
  catch { return {}; }
}
function saveKnownHosts(map) {
  fs.writeFileSync(knownHostsFile(), JSON.stringify(map, null, 2), 'utf8');
}
function fingerprintOf(keyBuf) {
  return `SHA256:${crypto.createHash('sha256').update(keyBuf).digest('base64').replace(/=+$/, '')}`;
}

// 主机指纹需要用户确认时,向渲染进程发起询问并等待回应
let hostKeySeq = 0;
const hostKeyResolvers = new Map();
function askHostKey(payload) {
  return new Promise((resolve) => {
    const reqId = `hk_${++hostKeySeq}`;
    hostKeyResolvers.set(reqId, resolve);
    send('ssh:hostkey', { reqId, ...payload });
  });
}
ipcMain.on('ssh:hostkey-reply', (_e, { reqId, accept }) => {
  const r = hostKeyResolvers.get(reqId);
  if (r) { hostKeyResolvers.delete(reqId); r(!!accept); }
});

// 采集服务器指标的命令(Linux),输出单行:S|负载|核数|已用/总内存MB|磁盘%|运行秒数
// 非 Linux/受限 shell 上会得到空字段,不会报错。
const STAT_CMD =
  "LOAD=$(awk '{print $1}' /proc/loadavg 2>/dev/null); " +
  "CORES=$(nproc 2>/dev/null); " +
  "MEM=$(free -m 2>/dev/null | awk 'NR==2{printf \"%d/%d\",$3,$2}'); " +
  "DISK=$(df -P / 2>/dev/null | awk 'NR==2{print $5}'); " +
  "UP=$(awk '{print int($1)}' /proc/uptime 2>/dev/null); " +
  "printf 'S|%s|%s|%s|%s|%s\\n' \"$LOAD\" \"$CORES\" \"$MEM\" \"$DISK\" \"$UP\"";

// 资源监控看板用的「富指标」一次性采集脚本(Linux)。输出分段文本,
// 由渲染进程解析。CPU 使用率与网络速率用「相邻两次快照差值」在前端计算,
// 因此这里只给原始累计值(/proc/stat 的 total/idle、/proc/net/dev 的 rx/tx)。
const DASH_CMD = [
  "echo '==CPU=='",
  "awk '/^cpu /{idle=$5+$6; tot=0; for(i=2;i<=NF;i++)tot+=$i; print tot\" \"idle}' /proc/stat 2>/dev/null",
  "nproc 2>/dev/null",
  "awk '{print $1\" \"$2\" \"$3}' /proc/loadavg 2>/dev/null",
  "echo '==MEM=='",
  "free -m 2>/dev/null | awk 'NR==2{print $3\"|\"$2} NR==3{print $3\"|\"$2}'",
  "echo '==DISK=='",
  "df -P -h -x tmpfs -x devtmpfs -x overlay 2>/dev/null | awk 'NR>1{print $5\" \"$3\" \"$2\" \"$6}'",
  "echo '==NET=='",
  "sed 's/:/ /' /proc/net/dev 2>/dev/null | awk 'NR>2 && $1!=\"lo\"{rx+=$2; tx+=$10} END{print rx\"|\"tx}'",
  "echo '==PROC=='",
  "ps -eo pid,pcpu,pmem,comm --sort=-pcpu 2>/dev/null | awk 'NR>1 && NR<=9{print $1\" \"$2\" \"$3\" \"$4}'",
  "echo '==UP=='",
  "awk '{print int($1)}' /proc/uptime 2>/dev/null",
  "echo '==END=='",
].join('; ');

// 把任意路径安全包进单引号(转义内部单引号),用于拼接远端 shell 命令
function shQuote(p) {
  return `'${String(p).replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// 应用设置(settings.json):目前包含指标采集间隔(毫秒,0 = 关闭)
// ---------------------------------------------------------------------------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    return { statsInterval: 5000, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch {
    return { statsInterval: 5000 };
  }
}

function saveSettings(s) {
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2), 'utf8');
}

let statsIntervalMs = 5000; // 启动后由 loadSettings 覆盖

// ---------------------------------------------------------------------------
// 活动会话表:sessionId -> { conn, stream, statsTimer, pollStats }
// ---------------------------------------------------------------------------
const sessions = new Map();
let sessionSeq = 0;

// 间隔变更后,对所有活动会话重新装载采集定时器
function rearmAllStats() {
  for (const s of sessions.values()) {
    if (s.statsTimer) clearInterval(s.statsTimer);
    s.statsTimer = statsIntervalMs > 0 && s.pollStats
      ? setInterval(s.pollStats, statsIntervalMs)
      : null;
  }
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 800,
    minHeight: 500,
    title: 'SSH Studio',
    frame: false,            // 无边框:使用自绘标题栏与窗口按钮
    backgroundColor: '#0b0e16',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // 仅开发模式(未打包)或显式 DEBUG=1 时自动打开开发者工具
  if (!app.isPackaged || process.env.DEBUG === '1') {
    mainWindow.webContents.openDevTools();
  }

  // F12 随时开关开发者工具(注意:终端获焦时按键会先被 xterm 捕获,
  // 可点一下界面非终端区域再按,或直接用菜单 视图→切换开发者工具)
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      mainWindow.webContents.toggleDevTools();
    }
  });

  // 把最大化状态同步给渲染进程,用于切换「最大化/还原」图标
  const emitWinState = () => send('win:state', { maximized: mainWindow.isMaximized() });
  mainWindow.on('maximize', emitWinState);
  mainWindow.on('unmaximize', emitWinState);
}

// 自绘标题栏的窗口控制
ipcMain.on('win:minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('win:maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('win:close', () => mainWindow && mainWindow.close());

// 阈值告警等的桌面通知(由渲染进程在指标越界时触发)
ipcMain.on('app:notify', (_e, { title, body }) => {
  try {
    if (Notification.isSupported()) {
      const n = new Notification({ title: title || 'SSH Studio', body: body || '' });
      n.on('click', () => { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); } });
      n.show();
    }
  } catch { /* ignore */ }
});

app.whenReady().then(() => {
  statsIntervalMs = loadSettings().statsInterval || 5000;
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // 关闭所有 SSH 会话(含跳板机连接)
  for (const { conn, jumpConn } of sessions.values()) {
    try { conn.end(); } catch { /* ignore */ }
    try { if (jumpConn) jumpConn.end(); } catch { /* ignore */ }
  }
  sessions.clear();
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// IPC:主机管理
// ---------------------------------------------------------------------------
ipcMain.handle('hosts:list', () => loadHosts());

ipcMain.handle('hosts:save', (_e, host) => {
  const v = validateHostConfig(host);
  if (!v.valid) {
    logger.warn('主机配置校验失败', { errors: v.errors });
    throw new Error(v.errors.join(';'));
  }
  const hosts = loadHosts();
  if (host.id) {
    const idx = hosts.findIndex((h) => h.id === host.id);
    if (idx >= 0) hosts[idx] = host;
    else hosts.push(host);
  } else {
    host.id = `h_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
    hosts.push(host);
  }
  saveHosts(hosts);
  return hosts;
});

ipcMain.handle('hosts:delete', (_e, id) => {
  const hosts = loadHosts().filter((h) => h.id !== id);
  saveHosts(hosts);
  return hosts;
});

// 设置:读取 / 更新(更新采集间隔后立即对所有会话生效并持久化)
ipcMain.handle('settings:get', () => loadSettings());

ipcMain.handle('settings:set', (_e, patch) => {
  const s = { ...loadSettings(), ...patch };
  if (typeof s.statsInterval === 'number') {
    statsIntervalMs = s.statsInterval;
    rearmAllStats();
  }
  saveSettings(s);
  return s;
});

// ---------------------------------------------------------------------------
// IPC:SSH 连接
// ---------------------------------------------------------------------------
function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// 为某个端点(目标主机或跳板机)构造 ssh2 连接参数。包含心跳与 TOFU 指纹校验。
// 读取私钥失败会抛出,由调用方捕获并提示。
function buildAuth(ep, sessionId) {
  const port = Number(ep.port) || 22;
  const auth = {
    host: ep.host,
    port,
    username: ep.username,
    readyTimeout: 20000,
    keepaliveInterval: 15000,
    keepaliveCountMax: 3, // 心跳:连续 3 次无响应(~45s)判定掉线 -> 触发自动重连
    hostVerifier: (key, verify) => {
      const fp = fingerprintOf(key);
      const hostId = `${ep.host}:${port}`;
      const known = loadKnownHosts();
      if (known[hostId] === fp) return verify(true);
      askHostKey({ sessionId, hostId, fingerprint: fp, type: known[hostId] ? 'changed' : 'new' })
        .then((accept) => {
          if (accept) { known[hostId] = fp; saveKnownHosts(known); verify(true); }
          else verify(false);
        });
    },
  };
  if (ep.privateKeyPath) {
    auth.privateKey = fs.readFileSync(ep.privateKeyPath);
    if (ep.passphrase) auth.passphrase = ep.passphrase;
  }
  if (ep.password) auth.password = ep.password;
  return auth;
}

ipcMain.handle('ssh:connect', async (_e, cfg) => {
  const sessionId = `s_${++sessionSeq}`;
  const port = Number(cfg.port) || 22;
  const useJump = !!(cfg.jump && cfg.jump.host);
  logger.log('SSH 连接发起', { sessionId, host: cfg.host, port, username: cfg.username, viaJump: useJump ? cfg.jump.host : null });

  // 连接前 TCP 预检:有跳板机时改测跳板机(目标通常不可直达)
  const probeHost = useJump ? cfg.jump.host : cfg.host;
  const probePort = useJump ? (Number(cfg.jump.port) || 22) : port;
  const probe = await tcpProbe(probeHost, probePort);
  if (!probe.ok) {
    logger.warn('TCP 预检失败', { host: probeHost, port: probePort, err: probe.err });
    const what = useJump ? `跳板机 ${probeHost}:${probePort}` : `${probeHost}:${probePort}`;
    setImmediate(() =>
      send('ssh:status', {
        sessionId,
        status: 'error',
        message: `无法连接到 ${what} —— ${probe.err}。请检查地址/端口是否正确、目标是否开机、以及防火墙或云安全组是否放行。`,
      })
    );
    return { sessionId };
  }

  const conn = new Client();
  let jumpConn = null; // 跳板机连接(若启用),随会话一起清理

  // 构造目标认证参数(读取私钥失败立即报错)
  let auth;
  try {
    auth = buildAuth({ ...cfg, port }, sessionId);
  } catch (err) {
    logger.error('读取私钥失败', err);
    setImmediate(() =>
      send('ssh:status', { sessionId, status: 'error', message: `读取私钥失败: ${err.message}` })
    );
    return { sessionId };
  }

  // 支持需要 keyboard-interactive 的服务器(用密码应答)
  if (cfg.password) {
    auth.tryKeyboard = true;
    conn.on('keyboard-interactive', (_name, _instr, _lang, _prompts, finish) => {
      finish([cfg.password]);
    });
  }

  conn.on('ready', () => {
    logger.log('SSH 已连接', { sessionId, host: cfg.host, port, username: cfg.username });
    send('ssh:status', { sessionId, status: 'connected', message: '连接成功' });
    conn.shell({ term: 'xterm-256color', cols: cfg.cols || 80, rows: cfg.rows || 24 }, (err, stream) => {
      if (err) {
        send('ssh:status', { sessionId, status: 'error', message: `打开 shell 失败: ${err.message}` });
        try { conn.end(); } catch { /* ignore */ }
        return;
      }
      // 每 5 秒采集一次服务器指标(独立 exec 通道,不干扰交互终端)
      let polling = false;
      const pollStats = () => {
        if (polling) return;
        polling = true;
        const started = Date.now();
        conn.exec(STAT_CMD, (exErr, ch) => {
          if (exErr) { polling = false; return; }
          let out = '';
          ch.on('data', (d) => { out += d.toString(); });
          ch.stderr.on('data', () => { /* 忽略 */ });
          ch.on('close', () => {
            polling = false;
            send('ssh:stats', { sessionId, rtt: Date.now() - started, raw: out.trim() });
          });
        });
      };
      const statsTimer = statsIntervalMs > 0 ? setInterval(pollStats, statsIntervalMs) : null;
      setTimeout(pollStats, 400); // 连上后立刻来一次(即使采集关闭也给一次快照)

      sessions.set(sessionId, { conn, jumpConn, stream, statsTimer, pollStats, tunnels: new Map(), logs: new Map() });

      stream.on('data', (data) => send('ssh:output', { sessionId, data: data.toString('utf8') }));
      stream.stderr.on('data', (data) => send('ssh:output', { sessionId, data: data.toString('utf8') }));
      stream.on('close', () => {
        clearInterval(statsTimer);
        closeTunnels(sessions.get(sessionId));
        closeLogs(sessions.get(sessionId));
        logger.log('SSH 会话关闭', { sessionId });
        send('ssh:status', { sessionId, status: 'closed', message: '会话已关闭' });
        try { conn.end(); } catch { /* ignore */ }
        try { if (jumpConn) jumpConn.end(); } catch { /* ignore */ }
        sessions.delete(sessionId);
      });
    });
  });

  conn.on('error', (err) => {
    const friendly = getUserFriendlyMessage(parseSSHError(err));
    logger.error('SSH 连接错误', err);
    send('ssh:status', { sessionId, status: 'error', message: friendly });
    try { if (jumpConn) jumpConn.end(); } catch { /* ignore */ }
    sessions.delete(sessionId);
  });

  conn.on('end', () => send('ssh:status', { sessionId, status: 'closed', message: '连接结束' }));

  // 实际发起连接:无跳板直连;有跳板先连 bastion,再经其 forwardOut 到目标
  const connectTarget = (sock) => {
    if (sock) auth.sock = sock;
    try {
      conn.connect(auth);
    } catch (err) {
      setImmediate(() => send('ssh:status', { sessionId, status: 'error', message: err.message }));
    }
  };

  if (!useJump) {
    connectTarget(null);
    return { sessionId };
  }

  // ---- 跳板机(ProxyJump)----
  jumpConn = new Client();
  let jumpAuth;
  try {
    jumpAuth = buildAuth(cfg.jump, sessionId);
  } catch (err) {
    setImmediate(() =>
      send('ssh:status', { sessionId, status: 'error', message: `读取跳板机私钥失败: ${err.message}` })
    );
    return { sessionId };
  }
  if (cfg.jump.password) {
    jumpAuth.tryKeyboard = true;
    jumpConn.on('keyboard-interactive', (_n, _i, _l, _p, finish) => finish([cfg.jump.password]));
  }
  jumpConn.on('ready', () => {
    logger.log('跳板机已连接', { sessionId, jump: cfg.jump.host });
    jumpConn.forwardOut('127.0.0.1', 0, cfg.host, port, (err, stream) => {
      if (err) {
        send('ssh:status', { sessionId, status: 'error', message: `跳板机无法连通目标 ${cfg.host}:${port}: ${err.message}` });
        try { jumpConn.end(); } catch { /* ignore */ }
        return;
      }
      connectTarget(stream);
    });
  });
  jumpConn.on('error', (err) => {
    const friendly = getUserFriendlyMessage(parseSSHError(err));
    logger.error('跳板机连接错误', err);
    send('ssh:status', { sessionId, status: 'error', message: `跳板机连接失败:${friendly}` });
    sessions.delete(sessionId);
  });
  try {
    jumpConn.connect(jumpAuth);
  } catch (err) {
    setImmediate(() => send('ssh:status', { sessionId, status: 'error', message: `跳板机连接失败:${err.message}` }));
  }

  return { sessionId };
});

ipcMain.on('ssh:data', (_e, { sessionId, data }) => {
  const s = sessions.get(sessionId);
  if (s && s.stream) s.stream.write(data);
});

ipcMain.on('ssh:resize', (_e, { sessionId, cols, rows }) => {
  const s = sessions.get(sessionId);
  if (s && s.stream) {
    try { s.stream.setWindow(rows, cols, 0, 0); } catch { /* ignore */ }
  }
});

ipcMain.on('ssh:disconnect', (_e, { sessionId }) => {
  const s = sessions.get(sessionId);
  if (s) {
    if (s.statsTimer) clearInterval(s.statsTimer);
    closeTunnels(s);
    closeLogs(s);
    try { s.conn.end(); } catch { /* ignore */ }
    try { if (s.jumpConn) s.jumpConn.end(); } catch { /* ignore */ }
    sessions.delete(sessionId);
  }
});

// ---------------------------------------------------------------------------
// IPC:端口转发 / SSH 隧道(本地转发 + 动态 SOCKS5 代理)
// ---------------------------------------------------------------------------
let tunnelSeq = 0;

function closeTunnels(s) {
  if (!s || !s.tunnels) return;
  for (const t of s.tunnels.values()) {
    if (t.server) { try { t.server.close(); } catch { /* ignore */ } }
  }
  s.tunnels.clear();
}

// 关闭某会话上所有实时日志(tail -F)通道
function closeLogs(s) {
  if (!s || !s.logs) return;
  for (const ch of s.logs.values()) {
    try { ch.signal('KILL'); } catch { /* ignore */ }
    try { ch.close(); } catch { /* ignore */ }
  }
  s.logs.clear();
}

// SOCKS5(仅 CONNECT,支持 IPv4 / 域名),把请求经 SSH forwardOut 出去
function handleSocks(conn, sock) {
  sock.once('data', (greet) => {
    if (greet[0] !== 0x05) return sock.destroy();
    sock.write(Buffer.from([0x05, 0x00])); // 无需认证
    sock.once('data', (req) => {
      if (req[0] !== 0x05 || req[1] !== 0x01) return sock.end(Buffer.from([0x05, 0x07, 0, 1, 0, 0, 0, 0, 0, 0]));
      const atyp = req[3];
      let host;
      let off;
      if (atyp === 0x01) { host = `${req[4]}.${req[5]}.${req[6]}.${req[7]}`; off = 8; }
      else if (atyp === 0x03) { const len = req[4]; host = req.slice(5, 5 + len).toString(); off = 5 + len; }
      else return sock.end(Buffer.from([0x05, 0x08, 0, 1, 0, 0, 0, 0, 0, 0]));
      const dport = req.readUInt16BE(off);
      conn.forwardOut('127.0.0.1', 0, host, dport, (err, stream) => {
        if (err) return sock.end(Buffer.from([0x05, 0x05, 0, 1, 0, 0, 0, 0, 0, 0]));
        sock.write(Buffer.from([0x05, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]));
        sock.pipe(stream); stream.pipe(sock);
        sock.on('error', () => stream.end());
        stream.on('error', () => sock.destroy());
      });
    });
  });
}

ipcMain.handle('tunnel:list', (_e, { sessionId }) => {
  const s = sessions.get(sessionId);
  if (!s) return [];
  return [...s.tunnels.values()].map((t) => ({ id: t.id, type: t.type, srcPort: t.srcPort, dstHost: t.dstHost, dstPort: t.dstPort }));
});

ipcMain.handle('tunnel:add', async (_e, { sessionId, type, srcPort, dstHost, dstPort }) => {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('会话不存在或已断开');
  const v = validateTunnelConfig({ type, srcPort, dstHost, dstPort });
  if (!v.valid) throw new Error(v.errors.join(';'));
  const t = { id: `tn_${++tunnelSeq}`, type, srcPort: Number(srcPort), dstHost, dstPort: Number(dstPort), server: null };

  await new Promise((resolve, reject) => {
    const server = net.createServer((sock) => {
      if (type === 'dynamic') return handleSocks(s.conn, sock);
      // local:把本地连接经 SSH 转发到 dstHost:dstPort
      s.conn.forwardOut(sock.remoteAddress || '127.0.0.1', sock.remotePort || 0, t.dstHost, t.dstPort, (err, stream) => {
        if (err) { sock.destroy(); return; }
        sock.pipe(stream); stream.pipe(sock);
        sock.on('error', () => stream.end());
        stream.on('error', () => sock.destroy());
      });
    });
    server.on('error', reject);
    server.listen(t.srcPort, '127.0.0.1', () => { t.server = server; resolve(); });
  });

  s.tunnels.set(t.id, t);
  logger.log('隧道已建立', { type: t.type, srcPort: t.srcPort, dstHost: t.dstHost, dstPort: t.dstPort });
  return { ok: true, id: t.id };
});

ipcMain.handle('tunnel:remove', (_e, { sessionId, id }) => {
  const s = sessions.get(sessionId);
  if (!s) return { ok: false };
  const t = s.tunnels.get(id);
  if (t) { if (t.server) { try { t.server.close(); } catch { /* ignore */ } } s.tunnels.delete(id); }
  return { ok: true };
});

// ---------------------------------------------------------------------------
// IPC:资源监控看板(按需采集一次富指标,渲染进程自行轮询)
// ---------------------------------------------------------------------------
ipcMain.handle('monitor:snapshot', (_e, { sessionId }) => {
  return new Promise((resolve, reject) => {
    const s = sessions.get(sessionId);
    if (!s) return reject(new Error('会话不存在或已断开'));
    const started = Date.now();
    s.conn.exec(DASH_CMD, (err, ch) => {
      if (err) return reject(err);
      let out = '';
      ch.on('data', (d) => { out += d.toString(); });
      ch.stderr.on('data', () => { /* 忽略 */ });
      ch.on('close', () => resolve({ raw: out, rtt: Date.now() - started, at: Date.now() }));
    });
  });
});

// ---------------------------------------------------------------------------
// IPC:实时远程日志(tail -F),按 logId 流式推送到渲染进程
// ---------------------------------------------------------------------------
let logSeq = 0;

ipcMain.handle('log:start', (_e, { sessionId, path: logPath, lines }) => {
  return new Promise((resolve, reject) => {
    const s = sessions.get(sessionId);
    if (!s) return reject(new Error('会话不存在或已断开'));
    if (!logPath) return reject(new Error('请提供日志文件路径'));
    const n = Math.min(Math.max(Number(lines) || 200, 0), 5000);
    const logId = `lg_${++logSeq}`;
    // -F:文件被轮转(logrotate)后自动跟随新文件;退出码非 0 也只是流结束
    const cmd = `tail -n ${n} -F ${shQuote(logPath)}`;
    s.conn.exec(cmd, { pty: false }, (err, ch) => {
      if (err) return reject(err);
      s.logs.set(logId, ch);
      ch.on('data', (d) => send('log:data', { sessionId, logId, data: d.toString('utf8') }));
      ch.stderr.on('data', (d) => send('log:data', { sessionId, logId, data: d.toString('utf8'), stderr: true }));
      ch.on('close', () => {
        s.logs.delete(logId);
        send('log:end', { sessionId, logId });
      });
      logger.log('实时日志开始', { sessionId, logId, path: logPath, lines: n });
      resolve({ logId });
    });
  });
});

ipcMain.handle('log:stop', (_e, { sessionId, logId }) => {
  const s = sessions.get(sessionId);
  if (!s) return { ok: false };
  const ch = s.logs.get(logId);
  if (ch) {
    try { ch.signal('KILL'); } catch { /* ignore */ }
    try { ch.close(); } catch { /* ignore */ }
    s.logs.delete(logId);
  }
  return { ok: true };
});

// ---------------------------------------------------------------------------
// IPC:SFTP 文件管理(复用已建立的 SSH 连接)
// ---------------------------------------------------------------------------
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

// 懒创建并复用每个会话的 SFTP 通道
function getSftp(sessionId) {
  return new Promise((resolve, reject) => {
    const s = sessions.get(sessionId);
    if (!s) return reject(new Error('会话不存在或已断开'));
    if (s.sftp) return resolve(s.sftp);
    s.conn.sftp((err, sftp) => {
      if (err) return reject(err);
      s.sftp = sftp;
      sftp.on('close', () => { s.sftp = null; });
      resolve(sftp);
    });
  });
}

const pcall = (fn) => new Promise((resolve, reject) => fn((err, res) => (err ? reject(err) : resolve(res))));

ipcMain.handle('sftp:list', async (_e, { sessionId, dir }) => {
  const sftp = await getSftp(sessionId);
  // dir 为空时取用户家目录(realpath('.'))
  const target = dir && dir.length ? dir : '.';
  const abs = await pcall((cb) => sftp.realpath(target, cb));
  const list = await pcall((cb) => sftp.readdir(abs, cb));
  const entries = list
    .map((it) => {
      const a = it.attrs;
      const mode = a.mode || 0;
      const isDir = typeof a.isDirectory === 'function' ? a.isDirectory() : (mode & S_IFMT) === S_IFDIR;
      const isLink = typeof a.isSymbolicLink === 'function' ? a.isSymbolicLink() : (mode & S_IFMT) === S_IFLNK;
      return { name: it.filename, size: a.size, mtime: a.mtime, isDir, isLink };
    })
    .filter((e) => e.name !== '.' && e.name !== '..');
  return { path: abs, entries };
});

ipcMain.handle('sftp:download', async (_e, { sessionId, remotePath, name }) => {
  const sftp = await getSftp(sessionId);
  const res = await dialog.showSaveDialog(mainWindow, { defaultPath: name || 'download' });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  await pcall((cb) => sftp.fastGet(remotePath, res.filePath, cb));
  return { ok: true, local: res.filePath };
});

ipcMain.handle('sftp:upload', async (_e, { sessionId, remoteDir }) => {
  const sftp = await getSftp(sessionId);
  const res = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'] });
  if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
  for (const f of res.filePaths) {
    const remote = path.posix.join(remoteDir, path.basename(f));
    await pcall((cb) => sftp.fastPut(f, remote, cb));
  }
  return { ok: true, count: res.filePaths.length };
});

ipcMain.handle('sftp:mkdir', async (_e, { sessionId, dir, name }) => {
  const sftp = await getSftp(sessionId);
  await pcall((cb) => sftp.mkdir(path.posix.join(dir, name), cb));
  return { ok: true };
});

ipcMain.handle('sftp:delete', async (_e, { sessionId, target, isDir }) => {
  const sftp = await getSftp(sessionId);
  await pcall((cb) => (isDir ? sftp.rmdir(target, cb) : sftp.unlink(target, cb)));
  return { ok: true };
});

ipcMain.handle('sftp:rename', async (_e, { sessionId, oldPath, newPath }) => {
  const sftp = await getSftp(sessionId);
  await pcall((cb) => sftp.rename(oldPath, newPath, cb));
  return { ok: true };
});
