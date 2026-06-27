'use strict';

/* global Terminal, FitAddon */

// xterm.js 通过全局变量暴露(见 index.html 的 <script> 顺序)
const { Terminal } = window;
const FitAddonCtor = window.FitAddon.FitAddon;

const api = window.sshBridge;

// 标签页:tabId -> tab。tab 里保存 term/界面引用、主机配置,以及当前底层会话 id。
// 重连时 sessionId 会变,但 tabId / 终端 / 界面保持不变。
const tabs = new Map();          // tabId -> tab
const sessionToTab = new Map();  // sessionId -> tab(用于把主进程事件路由到对应标签)
let tabSeq = 0;
let activeTab = null;            // 当前激活的 tabId

// 运维开关(持久化在 settings.json):自动重连、阈值桌面通知
let autoReconnectEnabled = true;
let notifyEnabled = false;

// ---------------------------------------------------------------------------
// 主机列表
// ---------------------------------------------------------------------------
const hostListEl = document.getElementById('host-list');

async function refreshHosts() {
  const hosts = await api.listHosts();
  hostListEl.innerHTML = '';
  if (hosts.length === 0) {
    const li = document.createElement('li');
    li.style.cssText = 'color:var(--muted);padding:10px;font-size:12px;text-align:center;';
    li.textContent = '还没有主机,点击右上角 ＋ 添加';
    hostListEl.appendChild(li);
    return;
  }
  for (const h of hosts) {
    const li = document.createElement('li');
    li.className = 'host-item';
    li.innerHTML = `
      <span class="name"></span>
      <span class="addr"></span>
      <span class="actions">
        <button data-act="edit">编辑</button>
        <button data-act="del">删除</button>
      </span>`;
    li.querySelector('.name').textContent = h.name || h.host;
    li.querySelector('.addr').textContent = `${h.username}@${h.host}:${h.port || 22}`;
    li.addEventListener('click', (e) => {
      if (e.target.dataset.act) return;
      connectHost(h);
    });
    li.querySelector('[data-act="edit"]').addEventListener('click', (e) => {
      e.stopPropagation();
      openModal(h);
    });
    li.querySelector('[data-act="del"]').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm(`删除主机「${h.name || h.host}」?`)) {
        await api.deleteHost(h.id);
        refreshHosts();
      }
    });
    hostListEl.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// 主机编辑弹窗
// ---------------------------------------------------------------------------
const modal = document.getElementById('modal');
const form = document.getElementById('host-form');

function setAuthMode(mode) {
  document.querySelectorAll('.auth-tab').forEach((t) =>
    t.classList.toggle('active', t.dataset.auth === mode)
  );
  document.querySelectorAll('.auth-pane').forEach((p) =>
    p.classList.toggle('hidden', p.dataset.pane !== mode)
  );
}

document.querySelectorAll('.auth-tab').forEach((t) =>
  t.addEventListener('click', () => setAuthMode(t.dataset.auth))
);

function openModal(host) {
  document.getElementById('modal-title').textContent = host ? '编辑主机' : '新增主机';
  document.getElementById('f-id').value = host?.id || '';
  document.getElementById('f-name').value = host?.name || '';
  document.getElementById('f-host').value = host?.host || '';
  document.getElementById('f-port').value = host?.port || 22;
  document.getElementById('f-username').value = host?.username || '';
  document.getElementById('f-password').value = host?.password || '';
  document.getElementById('f-keypath').value = host?.privateKeyPath || '';
  document.getElementById('f-passphrase').value = host?.passphrase || '';
  setAuthMode(host?.privateKeyPath ? 'key' : 'password');

  // 跳板机
  const j = host?.jump || {};
  const jumpOn = !!j.host;
  document.getElementById('f-jump-enabled').checked = jumpOn;
  document.getElementById('f-jump-host').value = j.host || '';
  document.getElementById('f-jump-port').value = j.port || 22;
  document.getElementById('f-jump-username').value = j.username || '';
  document.getElementById('f-jump-password').value = j.password || '';
  document.getElementById('f-jump-keypath').value = j.privateKeyPath || '';
  document.getElementById('f-jump-passphrase').value = j.passphrase || '';
  document.getElementById('jump-fields').classList.toggle('hidden', !jumpOn);

  modal.classList.remove('hidden');
  document.getElementById('f-host').focus();
}

// 跳板机开关:展开/收起字段
document.getElementById('f-jump-enabled').addEventListener('change', (e) => {
  document.getElementById('jump-fields').classList.toggle('hidden', !e.target.checked);
});

function closeModal() { modal.classList.add('hidden'); }

document.getElementById('btn-new').addEventListener('click', () => openModal(null));
document.getElementById('btn-cancel').addEventListener('click', closeModal);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const host = {
    id: document.getElementById('f-id').value || undefined,
    name: document.getElementById('f-name').value.trim(),
    host: document.getElementById('f-host').value.trim(),
    port: Number(document.getElementById('f-port').value) || 22,
    username: document.getElementById('f-username').value.trim(),
    password: document.getElementById('f-password').value,
    privateKeyPath: document.getElementById('f-keypath').value.trim(),
    passphrase: document.getElementById('f-passphrase').value,
  };
  // 跳板机(仅在启用时写入)
  if (document.getElementById('f-jump-enabled').checked) {
    host.jump = {
      host: document.getElementById('f-jump-host').value.trim(),
      port: Number(document.getElementById('f-jump-port').value) || 22,
      username: document.getElementById('f-jump-username').value.trim(),
      password: document.getElementById('f-jump-password').value,
      privateKeyPath: document.getElementById('f-jump-keypath').value.trim(),
      passphrase: document.getElementById('f-jump-passphrase').value,
    };
  }
  try {
    await api.saveHost(host);
    closeModal();
    refreshHosts();
  } catch (err) {
    alert(`保存失败:\n${cleanErr(err)}`);
  }
});

// ---------------------------------------------------------------------------
// 通用输入弹窗(复用 ask-modal):用于连接密码、新建文件夹、重命名等
// ---------------------------------------------------------------------------
const askModal = document.getElementById('ask-modal');

function promptModal({ title, label = '', value = '', password = false }) {
  return new Promise((resolve) => {
    document.getElementById('ask-title').textContent = title;
    const labelEl = document.getElementById('ask-label');
    const input = document.getElementById('ask-input');
    labelEl.childNodes[0].nodeValue = label;       // 改 label 文本(input 仍在其中)
    input.type = password ? 'password' : 'text';
    input.value = value;
    askModal.classList.remove('hidden');
    setTimeout(() => { input.focus(); input.select(); }, 0);

    const askForm = document.getElementById('ask-form');
    const cancelBtn = document.getElementById('ask-cancel');

    const done = (val) => {
      askModal.classList.add('hidden');
      askForm.removeEventListener('submit', onSubmit);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(val);
    };
    const onSubmit = (e) => { e.preventDefault(); done(input.value); };
    const onCancel = () => done(null);

    askForm.addEventListener('submit', onSubmit);
    cancelBtn.addEventListener('click', onCancel);
  });
}

const askPassword = (title) => promptModal({ title, label: '密码', password: true });

// ---------------------------------------------------------------------------
// 终端复制 / 粘贴
// ---------------------------------------------------------------------------
function termCopy(term) {
  const sel = term.getSelection();
  if (sel) api.clipboardWrite(sel);
}
function termPaste(tab) {
  if (!tab.sessionId) return;
  const text = api.clipboardRead();
  if (text) api.sendData(tab.sessionId, text);
}

// ---------------------------------------------------------------------------
// 建立连接 + 创建终端标签
// ---------------------------------------------------------------------------
async function connectHost(host) {
  const cfg = { ...host };

  // 既无密码也无密钥 -> 弹窗询问密码
  if (!cfg.password && !cfg.privateKeyPath) {
    const pw = await askPassword(`连接 ${cfg.username}@${cfg.host} 的密码`);
    if (pw === null) return;
    cfg.password = pw;
  }

  document.getElementById('welcome').classList.add('hidden');

  const id = `t_${++tabSeq}`;

  // 创建终端
  const term = new Terminal({
    fontFamily: '"Cascadia Code", Consolas, monospace',
    fontSize: 14,
    cursorBlink: true,
    letterSpacing: 0.3,
    theme: {
      background: '#1b2132',
      foreground: '#e7eaf3',
      cursor: '#6c8cff',
      cursorAccent: '#1b2132',
      selectionBackground: 'rgba(108,140,255,.28)',
      black: '#1b2132', brightBlack: '#5c627a',
      blue: '#6c8cff', brightBlue: '#8aa3ff',
      cyan: '#57c9e4', brightCyan: '#7fd8ee',
      green: '#46d6a0', brightGreen: '#6ee2b6',
      red: '#ff6b8b', brightRed: '#ff8da5',
      yellow: '#f5c451', brightYellow: '#f7d07a',
      magenta: '#b292ff', brightMagenta: '#c5acff',
      white: '#e7eaf3', brightWhite: '#ffffff',
    },
  });
  const fit = new FitAddonCtor();
  term.loadAddon(fit);

  const paneEl = document.createElement('div');
  paneEl.className = 'term-pane';
  // 断线后用于显示「重新连接」按钮的浮层
  const overlay = document.createElement('div');
  overlay.className = 'reconnect-overlay hidden';
  paneEl.appendChild(overlay);
  document.getElementById('terminals').appendChild(paneEl);
  term.open(paneEl);
  fit.fit();

  // 标签
  const tabEl = document.createElement('div');
  tabEl.className = 'tab active';
  tabEl.innerHTML = `<span class="dot"></span><span class="label"></span><button class="close">✕</button>`;
  tabEl.querySelector('.label').textContent = host.name || host.host;
  document.getElementById('tabbar').appendChild(tabEl);

  // tab 保存稳定引用;cfg 为已解析(含弹窗输入的密码)的配置,供重连复用
  const tab = {
    id, host, cfg, term, fit, paneEl, tabEl, overlay, sessionId: null,
    state: 'connecting', stats: null, rtt: null, connectedAt: null, disconnectedAt: null,
    wasConnected: false, manualClose: false, reconnect: null, alarm: {},
  };
  tabs.set(id, tab);

  tabEl.addEventListener('click', (e) => {
    if (e.target.classList.contains('close')) return;
    activateTab(id);
  });
  tabEl.querySelector('.close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(id);
  });

  // 键盘输入 / 尺寸变化 -> 发往「当前」底层会话(重连后 sessionId 会更新)
  term.onData((data) => { if (tab.sessionId) api.sendData(tab.sessionId, data); });
  term.onResize(({ cols, rows }) => { if (tab.sessionId) api.resize(tab.sessionId, cols, rows); });

  // 复制 / 粘贴快捷键
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !e.ctrlKey) return true;
    if (e.shiftKey && e.code === 'KeyC') { e.preventDefault(); termCopy(term); return false; }
    if (e.shiftKey && e.code === 'KeyV') { e.preventDefault(); termPaste(tab); return false; }
    if (!e.shiftKey && e.code === 'KeyC') {
      const sel = term.getSelection();
      if (sel && sel.length) { e.preventDefault(); termCopy(term); term.clearSelection(); return false; }
      return true; // 无选区 -> 正常发送 ^C 中断
    }
    if (!e.shiftKey && e.code === 'KeyV') { e.preventDefault(); termPaste(tab); return false; }
    return true;
  });

  // 右键:有选区则复制,否则粘贴
  paneEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const sel = term.getSelection();
    if (sel && sel.length) { termCopy(term); term.clearSelection(); }
    else termPaste(tab);
  });

  activateTab(id);
  await openSession(tab);
}

// 为某个已存在的标签建立(或重建)底层 SSH 会话
async function openSession(tab) {
  // 清理上一段会话的路由映射
  if (tab.sessionId) sessionToTab.delete(tab.sessionId);

  cancelReconnectTimer(tab); // 保留重连周期计数(若处于自动重连中)
  tab.overlay.classList.add('hidden');
  tab.tabEl.classList.remove('connected', 'error');
  tab.state = 'connecting';
  tab.wasConnected = false;
  tab.stats = null;
  tab.rtt = null;
  if (activeTab === tab.id) renderStatusBar();
  const { cfg, term } = tab;
  term.writeln(`\x1b[36m正在连接 ${cfg.username}@${cfg.host}:${cfg.port || 22} ...\x1b[0m`);

  const { sessionId } = await api.connect({ ...cfg, cols: term.cols, rows: term.rows });
  tab.sessionId = sessionId;
  sessionToTab.set(sessionId, tab);
}

// ---- 自动重连(指数退避) ----
const RECONNECT_DELAYS = [2000, 5000, 10000, 15000, 30000];
const RECONNECT_MAX = 10;

// 只取消挂起的定时器,保留重连周期计数(attempts),用于"立即重连"与发起重连时
function cancelReconnectTimer(tab) {
  if (tab.reconnect) {
    clearTimeout(tab.reconnect.timer);
    clearInterval(tab.reconnect.countdownTimer);
  }
}
// 彻底结束重连周期(连接成功 / 用户停止 / 关闭标签 / 重试用尽)
function clearReconnect(tab) {
  cancelReconnectTimer(tab);
  tab.reconnect = null;
}

// 静态「重新连接」浮层(初次连接失败 / 自动重连用尽 / 用户停止自动)
function showReconnect(tab, reason) {
  clearReconnect(tab);
  tab.overlay.innerHTML = '';
  const msg = document.createElement('div');
  msg.className = 'rc-msg';
  msg.textContent = reason || '连接已断开';
  const btn = document.createElement('button');
  btn.className = 'rc-btn';
  btn.textContent = '↻ 重新连接';
  btn.addEventListener('click', () => { term_clear(tab); openSession(tab); });
  tab.overlay.appendChild(msg);
  tab.overlay.appendChild(btn);
  tab.overlay.classList.remove('hidden');
}

// 带倒计时的自动重连浮层
function renderReconnectOverlay(tab, reason, remain, attempt) {
  tab.overlay.innerHTML = '';
  const msg = document.createElement('div');
  msg.className = 'rc-msg';
  msg.textContent = reason || '连接已断开';
  const sub = document.createElement('div');
  sub.className = 'rc-sub';
  sub.innerHTML = `第 ${attempt}/${RECONNECT_MAX} 次自动重连 · <span class="rc-countdown">${Math.max(0, remain)}s</span> 后重试`;
  const now = document.createElement('button');
  now.className = 'rc-btn';
  now.textContent = '↻ 立即重连';
  now.addEventListener('click', () => { cancelReconnectTimer(tab); term_clear(tab); openSession(tab); });
  const stop = document.createElement('button');
  stop.className = 'rc-btn';
  stop.style.cssText = 'margin-left:8px;opacity:.8;';
  stop.textContent = '停止自动重连';
  stop.addEventListener('click', () => showReconnect(tab, '已停止自动重连'));
  tab.overlay.appendChild(msg);
  tab.overlay.appendChild(sub);
  const row = document.createElement('div');
  row.style.cssText = 'margin-top:10px;';
  row.appendChild(now);
  row.appendChild(stop);
  tab.overlay.appendChild(row);
  tab.overlay.classList.remove('hidden');
}

// 安排一次自动重连;超过上限则回退到手动浮层
function scheduleReconnect(tab, reason) {
  const r = tab.reconnect || { attempts: 0 };
  tab.reconnect = r;
  if (r.attempts >= RECONNECT_MAX) {
    showReconnect(tab, `${reason}(已重试 ${r.attempts} 次,自动重连停止)`);
    return;
  }
  r.attempts++;
  const delay = RECONNECT_DELAYS[Math.min(r.attempts - 1, RECONNECT_DELAYS.length - 1)];
  let remain = Math.ceil(delay / 1000);
  renderReconnectOverlay(tab, reason, remain, r.attempts);
  clearInterval(r.countdownTimer);
  r.countdownTimer = setInterval(() => {
    remain--;
    const cd = tab.overlay.querySelector('.rc-countdown');
    if (cd) cd.textContent = `${Math.max(0, remain)}s`;
    if (remain <= 0) clearInterval(r.countdownTimer);
  }, 1000);
  r.timer = setTimeout(() => {
    clearInterval(r.countdownTimer);
    term_clear(tab);
    openSession(tab);
  }, delay);
}

function term_clear(tab) {
  try { tab.term.reset(); } catch { /* ignore */ }
}

function activateTab(id) {
  activeTab = id;
  for (const [tid, t] of tabs) {
    const on = tid === id;
    t.tabEl.classList.toggle('active', on);
    t.paneEl.classList.toggle('active', on);
    if (on) {
      t.fit.fit();
      t.term.focus();
      if (t.sessionId) api.resize(t.sessionId, t.term.cols, t.term.rows);
    }
  }
  renderStatusBar();
}

function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  t.manualClose = true;
  clearReconnect(t);
  if (t.sessionId) {
    api.disconnect(t.sessionId);
    sessionToTab.delete(t.sessionId);
  }
  t.term.dispose();
  t.paneEl.remove();
  t.tabEl.remove();
  tabs.delete(id);

  if (activeTab === id) {
    const next = tabs.keys().next().value;
    if (next) activateTab(next);
    else {
      activeTab = null;
      document.getElementById('welcome').classList.remove('hidden');
      renderStatusBar();
    }
  }
}

// ---------------------------------------------------------------------------
// 主进程事件
// ---------------------------------------------------------------------------
api.onOutput(({ sessionId, data }) => {
  const t = sessionToTab.get(sessionId);
  if (t) t.term.write(data);
});

api.onStatus(({ sessionId, status, message }) => {
  const t = sessionToTab.get(sessionId);
  if (!t) return;
  t.tabEl.classList.remove('connected', 'error');
  if (status === 'connected') {
    t.tabEl.classList.add('connected');
    t.state = 'connected';
    t.connectedAt = Date.now();
    t.disconnectedAt = null;
    t.wasConnected = true;
    t.alarm = {};            // 重连成功后清空告警去抖状态
    clearReconnect(t);
  } else if (status === 'error' || status === 'closed') {
    t.state = status;
    t.disconnectedAt = Date.now();
    t.tabEl.classList.remove('connected');
    if (status === 'error') {
      t.tabEl.classList.add('error');
      t.term.writeln(`\r\n\x1b[31m✗ ${message}\x1b[0m`);
    } else {
      t.term.writeln(`\r\n\x1b[33m— ${message} —\x1b[0m`);
    }
    // 用户主动关闭不重连;曾连上过(掉线)或已处于重连周期才自动重连,
    // 否则视为初次连接失败,留手动重连
    if (!t.manualClose) {
      const reason = status === 'error' ? `连接出错:${message}` : (message || '连接已关闭');
      const inCycle = !!t.reconnect;
      if (autoReconnectEnabled && (t.wasConnected || inCycle)) scheduleReconnect(t, reason);
      else showReconnect(t, reason);
    }
  }
  if (activeTab === t.id) renderStatusBar();
});

// ---------------------------------------------------------------------------
// 底部状态栏:服务器指标 + 连接时长
// ---------------------------------------------------------------------------
const sb = {
  bar: document.getElementById('statusbar'),
  rtt: document.getElementById('st-rtt'),
  load: document.getElementById('st-load'),
  loadSub: document.getElementById('st-load-sub'),
  loadBar: document.getElementById('st-load-bar'),
  mem: document.getElementById('st-mem'),
  memSub: document.getElementById('st-mem-sub'),
  memBar: document.getElementById('st-mem-bar'),
  disk: document.getElementById('st-disk'),
  diskBar: document.getElementById('st-disk-bar'),
  up: document.getElementById('st-up'),
  dur: document.getElementById('st-dur'),
  stateText: document.querySelector('#statusbar .st-state-text'),
};

// 设置迷你占比条:宽度按百分比(0~100),颜色按告警级别
function setGauge(barEl, pct, lvl) {
  if (!barEl) return;
  const p = isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
  barEl.style.width = `${p}%`;
  barEl.classList.remove('warn', 'crit');
  if (lvl) barEl.classList.add(lvl);
}
// 解析 "used/total"(MB)-> { pct, used, total }
function memInfo(mem) {
  const m = /^(\d+)\/(\d+)$/.exec(String(mem));
  if (!m || !Number(m[2])) return null;
  const used = Number(m[1]);
  const total = Number(m[2]);
  return { pct: Math.round((used / total) * 100), used, total };
}

function fmtUptime(sec) {
  sec = Number(sec) || 0;
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}天${h}时`;
  if (h) return `${h}时${m}分`;
  return `${m}分`;
}

function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (n) => String(n).padStart(2, '0');
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return hh ? `${hh}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`;
}

function parseStats(raw) {
  if (!raw || raw[0] !== 'S') return null;
  const [, load, cores, mem, disk, up] = raw.split('|');
  return { load, cores, mem, disk, up };
}

// ---- 阈值告警 ----
function setLevel(el, lvl) {
  el.classList.remove('warn', 'crit');
  if (lvl) el.classList.add(lvl);
}
// 数值落在 [warnAt, critAt) 为 warn,>= critAt 为 crit
function level(v, warnAt, critAt) {
  if (!isFinite(v)) return null;
  if (v >= critAt) return 'crit';
  if (v >= warnAt) return 'warn';
  return null;
}
function parsePct(s) { return parseFloat(String(s).replace('%', '')); }
function pctLevel(pct, warnAt, critAt) { return level(pct, warnAt, critAt); }
function memLevel(mem) {
  // mem 形如 "used/total"(MB)
  const m = /^(\d+)\/(\d+)$/.exec(String(mem));
  if (!m) return null;
  const total = Number(m[2]);
  if (!total) return null;
  return level((Number(m[1]) / total) * 100, 75, 90);
}
function loadLevel(load, cores) {
  const l = parseFloat(load);
  const c = Number(cores) || 1;
  if (!isFinite(l)) return null;
  return level(l / c, 0.7, 1.0); // 每核负载:>=0.7 警告,>=1.0 严重
}

function renderStatusBar() {
  const t = activeTab ? tabs.get(activeTab) : null;
  if (!t) { sb.bar.classList.add('hidden'); return; }
  sb.bar.classList.remove('hidden', 'connected', 'error');

  if (t.state === 'connected') {
    sb.bar.classList.add('connected');
    sb.stateText.textContent = '已连接';
  } else if (t.state === 'error' || t.state === 'closed') {
    sb.bar.classList.add('error');
    sb.stateText.textContent = '已断开';
  } else {
    sb.stateText.textContent = '连接中';
  }

  sb.rtt.textContent = t.rtt == null ? '—' : `${t.rtt}ms`;
  setLevel(sb.rtt, t.rtt == null ? null : level(t.rtt, 300, 800));

  const s = t.stats;
  const on = t.state === 'connected' && s;

  // 负载:数值 + 核心数 + 每核占比条
  sb.load.textContent = s && s.load ? s.load : '—';
  sb.loadSub.textContent = s && s.cores ? `/${s.cores}核` : '';
  const loadLvl = on ? loadLevel(s.load, s.cores) : null;
  setLevel(sb.load, loadLvl);
  const loadPct = s && s.cores ? (parseFloat(s.load) / Number(s.cores)) * 100 : NaN;
  setGauge(sb.loadBar, on ? loadPct : 0, loadLvl);

  // 内存:百分比为主,MB 为辅 + 占比条
  const mi = s && s.mem ? memInfo(s.mem) : null;
  sb.mem.textContent = mi ? `${mi.pct}%` : '—';
  sb.memSub.textContent = mi ? `${mi.used}/${mi.total}MB` : '';
  const memLvl = on ? memLevel(s.mem) : null;
  setLevel(sb.mem, memLvl);
  setGauge(sb.memBar, on && mi ? mi.pct : 0, memLvl);

  // 磁盘:使用率 + 占比条
  sb.disk.textContent = s && s.disk ? s.disk : '—';
  const diskPct = s ? parsePct(s.disk) : NaN;
  const diskLvl = on ? pctLevel(diskPct, 80, 90) : null;
  setLevel(sb.disk, diskLvl);
  setGauge(sb.diskBar, on ? diskPct : 0, diskLvl);

  sb.up.textContent = s && s.up ? fmtUptime(s.up) : '—';

  if (t.connectedAt) {
    const end = t.state === 'connected' ? Date.now() : (t.disconnectedAt || Date.now());
    sb.dur.textContent = fmtDur(end - t.connectedAt);
  } else {
    sb.dur.textContent = '00:00';
  }
}

// 主机指纹确认(TOFU)
api.onHostKey(({ reqId, hostId, fingerprint, type }) => {
  const msg = type === 'changed'
    ? `⚠ 警告:主机 ${hostId} 的指纹已发生变化!\n\n新指纹:\n${fingerprint}\n\n这可能意味着中间人攻击,也可能是服务器重装/更换密钥。\n确认无误才继续接受?`
    : `首次连接 ${hostId}\n\n主机指纹(SHA256):\n${fingerprint}\n\n确认接受并记住该主机?`;
  api.hostKeyReply(reqId, confirm(msg));
});

// 服务器指标推送
api.onStats(({ sessionId, rtt, raw }) => {
  const t = sessionToTab.get(sessionId);
  if (!t) return;
  t.rtt = rtt;
  const parsed = parseStats(raw);
  if (parsed) t.stats = parsed;
  checkAlarms(t);
  if (activeTab === t.id) renderStatusBar();
});

// 阈值越界 -> 桌面通知(边沿触发:进入 crit 才提醒一次,恢复后复位)
function checkAlarms(tab) {
  if (!notifyEnabled || tab.state !== 'connected' || !tab.stats) return;
  const s = tab.stats;
  const name = (tab.host && tab.host.name) || tab.cfg.host;
  const checks = [
    ['load', loadLevel(s.load, s.cores) === 'crit', `CPU 负载过高:${s.load}${s.cores ? `(${s.cores}核)` : ''}`],
    ['mem', memLevel(s.mem) === 'crit', `内存即将耗尽:${s.mem} MB`],
    ['disk', pctLevel(parsePct(s.disk), 80, 90) === 'crit', `磁盘空间不足:根分区 ${s.disk}`],
  ];
  for (const [key, isCrit, text] of checks) {
    if (isCrit && !tab.alarm[key]) { api.notify(`⚠ ${name}`, text); tab.alarm[key] = true; }
    else if (!isCrit) tab.alarm[key] = false;
  }
}

// 每秒刷新「已连接时长」
setInterval(() => { if (activeTab) renderStatusBar(); }, 1000);

// 重新适配当前激活终端(放到 rAF,等布局稳定再测量,避免分数缩放下少算/切行)
let refitRaf = 0;
function refitActive() {
  if (refitRaf) cancelAnimationFrame(refitRaf);
  refitRaf = requestAnimationFrame(() => {
    refitRaf = 0;
    if (!activeTab) return;
    const t = tabs.get(activeTab);
    if (t) { t.fit.fit(); if (t.sessionId) api.resize(t.sessionId, t.term.cols, t.term.rows); }
  });
}

// 窗口大小变化时重新适配
window.addEventListener('resize', refitActive);

// 终端容器自身高度变化(状态栏换行、布局变动等)也重新适配,避免底部被遮
const ro = new ResizeObserver(() => refitActive());
ro.observe(document.getElementById('terminals'));

// ---------------------------------------------------------------------------
// 文件管理(SFTP)
// ---------------------------------------------------------------------------
const fmState = { sessionId: null, path: '' };
const fmModal = document.getElementById('fm-modal');
const fmBox = fmModal.querySelector('.fm-box');
let fmReqSeq = 0; // 请求令牌:只采用最新一次 list 的结果

function posixDirname(p) {
  if (!p || p === '/') return '/';
  const t = p.replace(/\/+$/, '');
  const i = t.lastIndexOf('/');
  return i <= 0 ? '/' : t.slice(0, i);
}
function posixJoin(dir, name) {
  return (dir.endsWith('/') ? dir : `${dir}/`) + name;
}
function fmtSize(b) {
  if (b == null) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${i === 0 ? n : n.toFixed(1)} ${u[i]}`;
}
function fmtMtime(sec) {
  if (!sec) return '';
  try { return new Date(sec * 1000).toLocaleString(); } catch { return ''; }
}
function fmStatus(msg, err = false) {
  const el = document.getElementById('fm-status');
  el.textContent = msg;
  el.classList.toggle('err', !!err);
}
function fmBtn(text, fn, cls) {
  const b = document.createElement('button');
  b.textContent = text;
  if (cls) b.classList.add(cls);
  b.addEventListener('click', fn);
  return b;
}

// 包装一次「会修改远端」的操作:统一显示加载态、禁止并发、自动收尾与报错
async function fmBusy(label, op) {
  if (fmBox.classList.contains('busy')) return; // 已有操作进行中,忽略重复触发
  fmBox.classList.add('loading', 'busy');
  fmStatus(label);
  try {
    await op();
  } catch (e) {
    fmStatus(`失败:${cleanErr(e)}`, true);
  } finally {
    fmBox.classList.remove('loading', 'busy');
  }
}

async function fmLoad(dir) {
  const token = ++fmReqSeq;
  fmBox.classList.add('loading');
  fmStatus('加载中 …');
  try {
    const res = await api.sftpList(fmState.sessionId, dir);
    if (token !== fmReqSeq) return; // 期间又点了别处,丢弃这次过期结果
    fmState.path = res.path;
    document.getElementById('fm-path').value = res.path;
    fmRender(res.entries);
    fmStatus(`${res.entries.length} 项 · ${res.path}`);
  } catch (e) {
    if (token !== fmReqSeq) return;
    fmStatus(`错误:${cleanErr(e)}`, true);
  } finally {
    if (token === fmReqSeq) fmBox.classList.remove('loading'); // 仅最新请求负责收尾
  }
}

function fmRender(entries) {
  const ul = document.getElementById('fm-list');
  ul.innerHTML = '';
  entries.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
  for (const e of entries) {
    const li = document.createElement('li');
    li.className = 'fm-row';
    const icon = e.isDir ? '📁' : (e.isLink ? '🔗' : '📄');
    li.innerHTML =
      `<span class="c-name ${e.isDir ? 'dir' : ''}"><span>${icon}</span><span class="nm"></span></span>` +
      '<span class="c-size"></span><span class="c-time"></span><span class="c-act"></span>';
    li.querySelector('.nm').textContent = e.name;
    li.querySelector('.c-size').textContent = e.isDir ? '' : fmtSize(e.size);
    li.querySelector('.c-time').textContent = fmtMtime(e.mtime);

    const full = posixJoin(fmState.path, e.name);
    if (e.isDir) li.querySelector('.c-name').addEventListener('click', () => fmLoad(full));

    const act = li.querySelector('.c-act');
    if (!e.isDir) act.appendChild(fmBtn('下载', () => fmDownload(full, e.name)));
    act.appendChild(fmBtn('重命名', () => fmRename(full, e.name)));
    act.appendChild(fmBtn('删除', () => fmDelete(full, e.isDir), 'del'));
    ul.appendChild(li);
  }
}

function fmDownload(remotePath, name) {
  return fmBusy(`下载 ${name} …`, async () => {
    const r = await api.sftpDownload(fmState.sessionId, remotePath, name);
    fmStatus(r.canceled ? '已取消' : `已保存到 ${r.local}`);
  });
}

function fmUpload() {
  return fmBusy('上传中 …', async () => {
    const r = await api.sftpUpload(fmState.sessionId, fmState.path);
    if (r.canceled) { fmStatus('已取消'); return; }
    fmStatus(`已上传 ${r.count} 个文件`);
    await fmLoad(fmState.path);
  });
}

async function fmMkdir() {
  const name = await promptModal({ title: '新建文件夹', label: '文件夹名称' });
  if (!name) return;
  await fmBusy('创建中 …', async () => {
    await api.sftpMkdir(fmState.sessionId, fmState.path, name);
    await fmLoad(fmState.path);
  });
}

async function fmRename(oldPath, oldName) {
  const name = await promptModal({ title: '重命名', label: '新名称', value: oldName });
  if (!name || name === oldName) return;
  await fmBusy('重命名中 …', async () => {
    await api.sftpRename(fmState.sessionId, oldPath, posixJoin(fmState.path, name));
    await fmLoad(fmState.path);
  });
}

async function fmDelete(target, isDir) {
  if (!confirm(`确定删除「${target}」?${isDir ? '\n(仅能删除空目录)' : ''}`)) return;
  await fmBusy('删除中 …', async () => {
    await api.sftpDelete(fmState.sessionId, target, isDir);
    await fmLoad(fmState.path);
  });
}

// 去掉 Electron IPC 包裹的冗长前缀,只留服务器返回的核心错误
function cleanErr(e) {
  return String(e.message || e).replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '');
}

function openFM() {
  const t = activeTab ? tabs.get(activeTab) : null;
  if (!t || t.state !== 'connected' || !t.sessionId) {
    alert('请先连接到一台服务器,再打开文件管理。');
    return;
  }
  fmState.sessionId = t.sessionId;
  fmState.path = '';
  fmModal.classList.remove('hidden');
  fmLoad(''); // 空路径 -> 主进程解析为家目录
}

document.getElementById('open-fm').addEventListener('click', openFM);
document.getElementById('fm-close').addEventListener('click', () => fmModal.classList.add('hidden'));
document.getElementById('fm-up').addEventListener('click', () => fmLoad(posixDirname(fmState.path)));
document.getElementById('fm-refresh').addEventListener('click', () => fmLoad(fmState.path));
document.getElementById('fm-go').addEventListener('click', () => fmLoad(document.getElementById('fm-path').value.trim()));
document.getElementById('fm-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') fmLoad(e.target.value.trim()); });
document.getElementById('fm-mkdir').addEventListener('click', fmMkdir);
document.getElementById('fm-upload').addEventListener('click', fmUpload);

// ---------------------------------------------------------------------------
// 端口转发 / SSH 隧道
// ---------------------------------------------------------------------------
const tnState = { sessionId: null };
const tnModal = document.getElementById('tunnel-modal');
const tnType = document.getElementById('tn-type');

function tnStatus(msg, err = false) {
  const el = document.getElementById('tn-status');
  el.textContent = msg || '';
  el.classList.toggle('err', !!err);
}

function tnSyncFields() {
  // 动态 SOCKS 只需本地端口,隐藏目标主机/端口
  const dynamic = tnType.value === 'dynamic';
  document.querySelectorAll('#tunnel-modal .tn-dst, #tunnel-modal .tn-dport')
    .forEach((el) => el.classList.toggle('hidden', dynamic));
}

async function tnRefresh() {
  const list = await api.tunnelList(tnState.sessionId);
  const ul = document.getElementById('tn-list');
  ul.innerHTML = '';
  for (const t of list) {
    const li = document.createElement('li');
    li.className = 'tn-row';
    const badge = t.type === 'dynamic' ? 'SOCKS5' : '本地';
    const desc = t.type === 'dynamic'
      ? `127.0.0.1:${t.srcPort}  (浏览器代理)`
      : `127.0.0.1:${t.srcPort}  →  ${t.dstHost}:${t.dstPort}`;
    li.innerHTML = '<span class="tn-badge"></span><span class="tn-desc"></span><button class="tn-del">移除</button>';
    li.querySelector('.tn-badge').textContent = badge;
    li.querySelector('.tn-desc').textContent = desc;
    li.querySelector('.tn-del').addEventListener('click', async () => {
      await api.tunnelRemove(tnState.sessionId, t.id);
      tnRefresh();
    });
    ul.appendChild(li);
  }
}

async function tnAdd() {
  const type = tnType.value;
  const srcPort = Number(document.getElementById('tn-src').value);
  const dstHost = document.getElementById('tn-dhost').value.trim();
  const dstPort = Number(document.getElementById('tn-dport').value);
  if (!srcPort) { tnStatus('请填写本地端口', true); return; }
  if (type === 'local' && (!dstHost || !dstPort)) { tnStatus('本地转发需填写目标主机和端口', true); return; }
  tnStatus('正在创建 …');
  try {
    await api.tunnelAdd({ sessionId: tnState.sessionId, type, srcPort, dstHost, dstPort });
    tnStatus(type === 'dynamic'
      ? `已启动 SOCKS5 代理:127.0.0.1:${srcPort}`
      : `已建立转发:127.0.0.1:${srcPort} → ${dstHost}:${dstPort}`);
    document.getElementById('tn-src').value = '';
    document.getElementById('tn-dhost').value = '';
    document.getElementById('tn-dport').value = '';
    tnRefresh();
  } catch (e) {
    tnStatus(`创建失败:${cleanErr(e)}(端口可能被占用)`, true);
  }
}

function openTunnel() {
  const t = activeTab ? tabs.get(activeTab) : null;
  if (!t || t.state !== 'connected' || !t.sessionId) {
    alert('请先连接到一台服务器,再配置端口转发。');
    return;
  }
  tnState.sessionId = t.sessionId;
  tnStatus('');
  tnSyncFields();
  tnModal.classList.remove('hidden');
  tnRefresh();
}

document.getElementById('open-tunnel').addEventListener('click', openTunnel);
document.getElementById('tn-close').addEventListener('click', () => tnModal.classList.add('hidden'));
document.getElementById('tn-add').addEventListener('click', tnAdd);
tnType.addEventListener('change', tnSyncFields);

// ESC 关闭弹窗
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const dashEl = document.getElementById('dash-modal');
  const logEl = document.getElementById('log-modal');
  const bcEl = document.getElementById('bcast-modal');
  if (!bcEl.classList.contains('hidden')) bcEl.classList.add('hidden');
  else if (!dashEl.classList.contains('hidden')) closeDash();
  else if (!logEl.classList.contains('hidden')) closeLog();
  else if (!tnModal.classList.contains('hidden')) tnModal.classList.add('hidden');
  else if (!fmModal.classList.contains('hidden')) fmModal.classList.add('hidden');
  else closeModal();
});

// 采集间隔下拉:读取已保存值,变更时持久化并实时生效
const intervalSel = document.getElementById('st-interval');
intervalSel.addEventListener('change', () => {
  api.setSettings({ statsInterval: Number(intervalSel.value) });
});

// 自绘标题栏窗口控制
document.getElementById('tb-min').addEventListener('click', () => api.winMinimize());
document.getElementById('tb-max').addEventListener('click', () => api.winMaximize());
document.getElementById('tb-close').addEventListener('click', () => api.winClose());
api.onWinState(({ maximized }) => {
  const b = document.getElementById('tb-max');
  b.innerHTML = maximized ? '&#x2750;' : '&#x2610;';
  b.title = maximized ? '还原' : '最大化';
});

// ---------------------------------------------------------------------------
// 公共:取当前「已连接」标签;否则提示
// ---------------------------------------------------------------------------
function activeConnectedTab(actionLabel) {
  const t = activeTab ? tabs.get(activeTab) : null;
  if (!t || t.state !== 'connected' || !t.sessionId) {
    alert(`请先连接到一台服务器,再${actionLabel}。`);
    return null;
  }
  return t;
}

// ---------------------------------------------------------------------------
// 资源监控看板
// ---------------------------------------------------------------------------
const dashModal = document.getElementById('dash-modal');
const dashState = { sessionId: null, timer: null, intervalMs: 3000, prev: null, busy: false, hist: { cpu: [], net: [] } };
const HIST_MAX = 60;

function fmtMB(mb) {
  mb = Number(mb) || 0;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}
function fmtRate(bps) {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bps;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${u[i]}/s`;
}

// 解析 DASH_CMD 的分段输出
function parseDash(raw) {
  const r = { cpu: null, cores: null, load: '', mem: null, swap: null, disks: [], net: null, procs: [], up: null };
  let sec = '';
  let cpuLine = 0;
  let memLine = 0;
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    if (s.startsWith('==') && s.endsWith('==')) { sec = s.slice(2, -2); cpuLine = 0; memLine = 0; continue; }
    if (sec === 'CPU') {
      cpuLine++;
      if (cpuLine === 1) { const [tot, idle] = s.split(/\s+/).map(Number); r.cpu = { tot, idle }; }
      else if (cpuLine === 2) r.cores = Number(s);
      else if (cpuLine === 3) r.load = s;
    } else if (sec === 'MEM') {
      memLine++;
      const [used, total] = s.split('|').map(Number);
      if (memLine === 1) r.mem = { used, total };
      else if (memLine === 2) r.swap = { used, total };
    } else if (sec === 'DISK') {
      const [use, used, size, ...rest] = s.split(/\s+/);
      r.disks.push({ pct: parseFloat(use), used, size, mount: rest.join(' ') });
    } else if (sec === 'NET') {
      const [rx, tx] = s.split('|').map(Number);
      r.net = { rx, tx };
    } else if (sec === 'PROC') {
      const [pid, cpu, mem, ...cmd] = s.split(/\s+/);
      r.procs.push({ pid, cpu: parseFloat(cpu), mem: parseFloat(mem), cmd: cmd.join(' ') });
    } else if (sec === 'UP') {
      r.up = Number(s);
    }
  }
  return r;
}

function drawSpark(canvas, data, color, fixedMax) {
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.clientWidth || 300;
  const ch = canvas.clientHeight || 46;
  canvas.width = cw * dpr;
  canvas.height = ch * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cw, ch);
  if (data.length < 2) return;
  const max = fixedMax || Math.max(...data, 1);
  const n = data.length;
  const pts = data.map((v, i) => [(i / (n - 1)) * cw, ch - (Math.min(v, max) / max) * (ch - 4) - 2]);
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.lineTo(cw, ch);
  ctx.lineTo(0, ch);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, ch);
  g.addColorStop(0, `${color}44`);
  g.addColorStop(1, `${color}00`);
  ctx.fillStyle = g;
  ctx.fill();
}

function barLevelClass(pct, warnAt, critAt) {
  if (pct >= critAt) return 'crit';
  if (pct >= warnAt) return 'warn';
  return '';
}

function renderDash(d, at, rtt) {
  document.getElementById('dash-rtt').textContent = rtt == null ? '—' : `${rtt}ms`;
  document.getElementById('dash-up').textContent = d.up ? fmtUptime(d.up) : '—';

  // CPU 使用率:与上次快照求差(首帧无前值则显示「计算中」)
  const prev = dashState.prev;
  let cpuPct = null;
  if (d.cpu && prev && prev.cpu) {
    const dTot = d.cpu.tot - prev.cpu.tot;
    const dIdle = d.cpu.idle - prev.cpu.idle;
    if (dTot > 0) cpuPct = Math.max(0, Math.min(100, (1 - dIdle / dTot) * 100));
  }
  document.getElementById('d-cpu-val').textContent = cpuPct == null ? '计算中…' : `${cpuPct.toFixed(0)}%`;
  document.getElementById('d-cpu-cores').textContent = d.cores ? `${d.cores} 核` : '';
  document.getElementById('d-cpu-load').textContent = d.load ? `负载 ${d.load}` : '';
  if (cpuPct != null) {
    dashState.hist.cpu.push(cpuPct);
    if (dashState.hist.cpu.length > HIST_MAX) dashState.hist.cpu.shift();
    drawSpark(document.getElementById('d-cpu-spark'), dashState.hist.cpu, '#6c8cff', 100);
  }

  // 内存 / Swap
  if (d.mem && d.mem.total) {
    const pct = Math.round((d.mem.used / d.mem.total) * 100);
    document.getElementById('d-mem-val').textContent = `${pct}% · ${fmtMB(d.mem.used)}/${fmtMB(d.mem.total)}`;
    const bar = document.getElementById('d-mem-bar');
    bar.style.width = `${pct}%`;
    bar.className = barLevelClass(pct, 75, 90);
  }
  if (d.swap) {
    const sbar = document.getElementById('d-swap-bar');
    if (d.swap.total) {
      const pct = Math.round((d.swap.used / d.swap.total) * 100);
      document.getElementById('d-swap-val').textContent = `${pct}% · ${fmtMB(d.swap.used)}/${fmtMB(d.swap.total)}`;
      sbar.style.width = `${pct}%`;
      sbar.className = barLevelClass(pct, 50, 80);
    } else {
      document.getElementById('d-swap-val').textContent = '无';
      sbar.style.width = '0%';
      sbar.className = '';
    }
  }

  // 网络速率:字节累计差 / 时间差
  if (d.net && prev && prev.net && prev.at) {
    const dt = (at - prev.at) / 1000;
    if (dt > 0) {
      const rxR = Math.max(0, (d.net.rx - prev.net.rx) / dt);
      const txR = Math.max(0, (d.net.tx - prev.net.tx) / dt);
      document.getElementById('d-net-val').textContent = `↓${fmtRate(rxR)} ↑${fmtRate(txR)}`;
      document.getElementById('d-net-rx').textContent = `↓ ${fmtRate(rxR)}`;
      document.getElementById('d-net-tx').textContent = `↑ ${fmtRate(txR)}`;
      dashState.hist.net.push(rxR + txR);
      if (dashState.hist.net.length > HIST_MAX) dashState.hist.net.shift();
      drawSpark(document.getElementById('d-net-spark'), dashState.hist.net, '#57c9e4');
    }
  }

  // 磁盘分区
  const dl = document.getElementById('d-disk-list');
  dl.innerHTML = '';
  document.getElementById('d-disk-n').textContent = `${d.disks.length} 个`;
  for (const dk of d.disks) {
    const pct = isFinite(dk.pct) ? dk.pct : 0;
    const li = document.createElement('li');
    li.className = 'disk-row';
    li.innerHTML = '<span class="dk-mount"></span><div class="bar"><i></i></div><span class="dk-size"></span>';
    const mt = li.querySelector('.dk-mount');
    mt.textContent = dk.mount;
    mt.title = dk.mount;
    const bi = li.querySelector('.bar > i');
    bi.style.width = `${pct}%`;
    bi.className = barLevelClass(pct, 80, 90);
    li.querySelector('.dk-size').textContent = `${pct}% · ${dk.used}/${dk.size}`;
    dl.appendChild(li);
  }

  // Top 进程
  const pl = document.getElementById('d-proc-list');
  pl.innerHTML = '';
  for (const p of d.procs) {
    const li = document.createElement('li');
    li.className = 'proc-row';
    li.innerHTML = '<span class="pr-pid"></span><span class="pr-cmd"></span><span class="pr-cpu"></span><span class="pr-mem"></span>';
    li.querySelector('.pr-pid').textContent = p.pid;
    const cmd = li.querySelector('.pr-cmd');
    cmd.textContent = p.cmd;
    cmd.title = p.cmd;
    const cpuEl = li.querySelector('.pr-cpu');
    cpuEl.textContent = `${p.cpu.toFixed(1)}%`;
    cpuEl.className = `pr-cpu ${barLevelClass(p.cpu, 50, 80)}`;
    li.querySelector('.pr-mem').textContent = `${p.mem.toFixed(1)}%`;
    pl.appendChild(li);
  }

  dashState.prev = { cpu: d.cpu, net: d.net, at };
}

async function dashPoll() {
  if (dashState.busy || !dashState.sessionId) return;
  dashState.busy = true;
  try {
    const { raw, rtt, at } = await api.monitorSnapshot(dashState.sessionId);
    const d = parseDash(raw);
    renderDash(d, at, rtt);
    document.getElementById('dash-status').textContent =
      `已更新 · ${new Date(at).toLocaleTimeString()}`;
  } catch (e) {
    document.getElementById('dash-status').textContent = `采集失败:${cleanErr(e)}`;
  } finally {
    dashState.busy = false;
  }
}

function dashArm() {
  if (dashState.timer) clearInterval(dashState.timer);
  dashState.timer = setInterval(dashPoll, dashState.intervalMs);
}

function openDash() {
  const t = activeConnectedTab('打开资源看板');
  if (!t) return;
  dashState.sessionId = t.sessionId;
  dashState.prev = null;
  dashState.hist = { cpu: [], net: [] };
  document.getElementById('dash-host').textContent = `${t.cfg.username}@${t.cfg.host}`;
  document.getElementById('dash-status').textContent = '采集中 …';
  dashModal.classList.remove('hidden');
  dashPoll();
  dashArm();
}

function closeDash() {
  if (dashState.timer) { clearInterval(dashState.timer); dashState.timer = null; }
  dashModal.classList.add('hidden');
}

document.getElementById('open-dash').addEventListener('click', openDash);
document.getElementById('dash-close').addEventListener('click', closeDash);
document.getElementById('dash-interval').addEventListener('change', (e) => {
  dashState.intervalMs = Number(e.target.value);
  dashArm();
});

// ---------------------------------------------------------------------------
// 实时远程日志(tail -F)
// ---------------------------------------------------------------------------
const logModal = document.getElementById('log-modal');
const logViewEl = document.getElementById('log-view');
const logState = {
  sessionId: null, logId: null, paused: false, wrap: true,
  filter: '', count: 0, partial: '', pending: '',
};
const LOG_MAX_LINES = 5000;

function logStatus(msg, err = false) {
  const el = document.getElementById('log-status');
  el.textContent = msg;
  el.classList.toggle('err', !!err);
}

function escHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function highlightHtml(raw, filter) {
  const safe = escHtml(raw);
  if (!filter) return safe;
  try {
    return safe.replace(new RegExp(escRe(escHtml(filter)), 'gi'), (m) => `<span class="hl">${m}</span>`);
  } catch { return safe; }
}

// 按当前过滤词决定某行是否可见 + 是否高亮
function applyFilterToLine(el) {
  const raw = el.dataset.raw || '';
  const f = logState.filter;
  if (!f) { el.classList.remove('hide'); el.textContent = raw; return; }
  if (raw.toLowerCase().includes(f.toLowerCase())) {
    el.classList.remove('hide');
    el.innerHTML = highlightHtml(raw, f);
  } else {
    el.classList.add('hide');
    el.textContent = raw;
  }
}

function logAddLine(text, kind) {
  const el = document.createElement('span');
  el.className = 'ln';
  el.dataset.raw = text;
  if (kind) el.classList.add(kind);
  else if (/\b(error|err|fail|failed|fatal|critical|panic|denied|exception)\b/i.test(text)) el.classList.add('err');
  else if (/\b(warn|warning)\b/i.test(text)) el.classList.add('warn');
  applyFilterToLine(el);
  logViewEl.appendChild(el);
  logState.count++;

  // 行数上限:从顶部裁剪
  while (logViewEl.childElementCount > LOG_MAX_LINES) {
    logViewEl.removeChild(logViewEl.firstChild);
    logState.count--;
  }
  document.getElementById('log-count').textContent = `${logState.count} 行`;
}

function logAppend(text, stderr) {
  const full = logState.partial + text;
  const parts = full.split('\n');
  logState.partial = parts.pop();
  for (const line of parts) logAddLine(line.replace(/\r$/, ''), stderr ? 'err' : null);
  if (!logState.paused) {
    logViewEl.scrollTop = logViewEl.scrollHeight;
  }
}

function logSys(text) {
  const el = document.createElement('span');
  el.className = 'ln sys';
  el.dataset.raw = text;
  el.textContent = `— ${text} —`;
  logViewEl.appendChild(el);
  logViewEl.scrollTop = logViewEl.scrollHeight;
}

api.onLogData(({ logId, data, stderr }) => {
  if (logId !== logState.logId) return;
  if (logState.paused) {
    logState.pending += data;
    // 暂停时缓冲也设上限,避免无限增长
    if (logState.pending.length > 2_000_000) logState.pending = logState.pending.slice(-1_000_000);
    return;
  }
  logAppend(data, stderr);
});

api.onLogEnd(({ logId }) => {
  if (logId !== logState.logId) return;
  logSys('日志流已结束');
  logState.logId = null;
  setLogRunning(false);
});

function setLogRunning(on) {
  document.getElementById('log-start').classList.toggle('hidden', on);
  document.getElementById('log-stop').classList.toggle('hidden', !on);
}

async function logStartFn() {
  const t = activeConnectedTab('查看实时日志');
  if (!t) return;
  const path = document.getElementById('log-path').value.trim();
  if (!path) { logStatus('请先填写日志文件路径', true); return; }
  if (logState.logId) await logStopFn();
  logViewEl.innerHTML = '';
  logState.count = 0;
  logState.partial = '';
  logState.pending = '';
  logState.sessionId = t.sessionId;
  document.getElementById('log-count').textContent = '0 行';
  logStatus(`正在跟踪 ${path} …`);
  try {
    const { logId } = await api.logStart(t.sessionId, path, 200);
    logState.logId = logId;
    setLogRunning(true);
    logSys(`开始跟踪 ${path}`);
    logStatus(`正在实时跟踪:${path}`);
  } catch (e) {
    logStatus(`启动失败:${cleanErr(e)}`, true);
  }
}

async function logStopFn() {
  if (logState.logId && logState.sessionId) {
    try { await api.logStop(logState.sessionId, logState.logId); } catch { /* ignore */ }
  }
  if (logState.logId) logSys('已停止跟踪');
  logState.logId = null;
  setLogRunning(false);
  logStatus('已停止。');
}

function openLog() {
  const t = activeConnectedTab('查看实时日志');
  if (!t) return;
  logState.sessionId = t.sessionId;
  logModal.classList.remove('hidden');
  setLogRunning(!!logState.logId);
  setTimeout(() => document.getElementById('log-path').focus(), 0);
}

function closeLog() {
  // 关闭弹窗即停止后台 tail,避免无谓占用连接
  if (logState.logId) logStopFn();
  logModal.classList.add('hidden');
}

document.getElementById('open-log').addEventListener('click', openLog);
document.getElementById('log-close').addEventListener('click', closeLog);
document.getElementById('log-start').addEventListener('click', logStartFn);
document.getElementById('log-stop').addEventListener('click', logStopFn);
document.getElementById('log-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') logStartFn(); });
document.getElementById('log-preset').addEventListener('change', (e) => {
  if (e.target.value) { document.getElementById('log-path').value = e.target.value; e.target.value = ''; }
});
document.getElementById('log-filter').addEventListener('input', (e) => {
  logState.filter = e.target.value;
  for (const el of logViewEl.children) {
    if (!el.classList.contains('sys')) applyFilterToLine(el);
  }
});
document.getElementById('log-pause').addEventListener('click', (e) => {
  logState.paused = !logState.paused;
  e.target.classList.toggle('active', logState.paused);
  e.target.textContent = logState.paused ? '▶ 继续' : '⏸ 暂停';
  if (!logState.paused && logState.pending) {
    const buf = logState.pending;
    logState.pending = '';
    logAppend(buf);
  }
});
document.getElementById('log-wrap').addEventListener('click', (e) => {
  logState.wrap = !logState.wrap;
  logViewEl.classList.toggle('wrap', logState.wrap);
  e.target.classList.toggle('active', logState.wrap);
});
document.getElementById('log-clear').addEventListener('click', () => {
  logViewEl.innerHTML = '';
  logState.count = 0;
  document.getElementById('log-count').textContent = '0 行';
});

// ---------------------------------------------------------------------------
// 批量命令广播
// ---------------------------------------------------------------------------
const bcastModal = document.getElementById('bcast-modal');

function openBcast() {
  const ul = document.getElementById('bc-targets');
  ul.innerHTML = '';
  let n = 0;
  for (const [, t] of tabs) {
    if (t.state !== 'connected' || !t.sessionId) continue;
    n++;
    const li = document.createElement('li');
    li.innerHTML = '<input type="checkbox" checked /><span class="bc-name"></span><span class="bc-st">已连接</span>';
    li.querySelector('.bc-name').textContent =
      `${t.cfg.username}@${t.cfg.host}${t.host && t.host.name ? ` (${t.host.name})` : ''}`;
    li.dataset.tabId = t.id;
    li.addEventListener('click', (e) => {
      if (e.target.tagName !== 'INPUT') { const cb = li.querySelector('input'); cb.checked = !cb.checked; }
    });
    ul.appendChild(li);
  }
  document.getElementById('bc-status').textContent = n ? `共 ${n} 台已连接,默认全选` : '';
  bcastModal.classList.remove('hidden');
  setTimeout(() => document.getElementById('bc-cmd').focus(), 0);
}

function bcastSend() {
  const ul = document.getElementById('bc-targets');
  const cmd = document.getElementById('bc-cmd').value;
  if (!cmd.trim()) { document.getElementById('bc-status').textContent = '请输入要发送的命令'; return; }
  const enter = document.getElementById('bc-enter').checked;
  const payload = enter ? (cmd.endsWith('\n') ? cmd : `${cmd}\n`) : cmd;
  let sent = 0;
  for (const li of ul.children) {
    const cb = li.querySelector('input');
    if (!cb || !cb.checked) continue;
    const t = tabs.get(li.dataset.tabId);
    if (t && t.sessionId && t.state === 'connected') { api.sendData(t.sessionId, payload); sent++; }
  }
  document.getElementById('bc-status').textContent = sent ? `✓ 已发送到 ${sent} 台服务器` : '未选择任何目标';
}

document.getElementById('open-bcast').addEventListener('click', openBcast);
document.getElementById('bc-close').addEventListener('click', () => bcastModal.classList.add('hidden'));
document.getElementById('bc-send').addEventListener('click', bcastSend);

// ---------------------------------------------------------------------------
// 阈值桌面通知开关
// ---------------------------------------------------------------------------
const notifyBtn = document.getElementById('st-notify');
function renderNotifyBtn() {
  notifyBtn.classList.toggle('active', notifyEnabled);
  notifyBtn.classList.toggle('off', !notifyEnabled);
  notifyBtn.title = notifyEnabled ? '阈值桌面通知:开(点击关闭)' : '阈值桌面通知:关(点击开启)';
}
notifyBtn.addEventListener('click', () => {
  notifyEnabled = !notifyEnabled;
  renderNotifyBtn();
  api.setSettings({ notifyEnabled });
  if (notifyEnabled) api.notify('SSH Studio', '阈值告警已开启:CPU / 内存 / 磁盘越限时将弹桌面通知。');
});

// 初始化
(async () => {
  const settings = await api.getSettings();
  intervalSel.value = String(settings.statsInterval ?? 5000);
  autoReconnectEnabled = settings.autoReconnect !== false; // 默认开启
  notifyEnabled = !!settings.notifyEnabled;                // 默认关闭
  renderNotifyBtn();
  refreshHosts();
})();
