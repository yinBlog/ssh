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
  modal.classList.remove('hidden');
  document.getElementById('f-host').focus();
}

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

  tab.overlay.classList.add('hidden');
  tab.tabEl.classList.remove('connected', 'error');
  tab.state = 'connecting';
  tab.stats = null;
  tab.rtt = null;
  if (activeTab === tab.id) renderStatusBar();
  const { cfg, term } = tab;
  term.writeln(`\x1b[36m正在连接 ${cfg.username}@${cfg.host}:${cfg.port || 22} ...\x1b[0m`);

  const { sessionId } = await api.connect({ ...cfg, cols: term.cols, rows: term.rows });
  tab.sessionId = sessionId;
  sessionToTab.set(sessionId, tab);
}

// 显示断线后的「重新连接」浮层
function showReconnect(tab, reason) {
  tab.overlay.innerHTML = '';
  const msg = document.createElement('div');
  msg.className = 'rc-msg';
  msg.textContent = reason || '连接已断开';
  const btn = document.createElement('button');
  btn.className = 'rc-btn';
  btn.textContent = '↻ 重新连接';
  btn.addEventListener('click', () => {
    term_clear(tab);
    openSession(tab);
  });
  tab.overlay.appendChild(msg);
  tab.overlay.appendChild(btn);
  tab.overlay.classList.remove('hidden');
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
  } else if (status === 'error') {
    t.tabEl.classList.add('error');
    t.state = 'error';
    t.disconnectedAt = Date.now();
    t.term.writeln(`\r\n\x1b[31m✗ ${message}\x1b[0m`);
    showReconnect(t, `连接出错:${message}`);
  } else if (status === 'closed') {
    t.state = 'closed';
    t.disconnectedAt = Date.now();
    t.term.writeln(`\r\n\x1b[33m— ${message} —\x1b[0m`);
    t.tabEl.classList.remove('connected');
    showReconnect(t, message || '连接已关闭');
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
  mem: document.getElementById('st-mem'),
  disk: document.getElementById('st-disk'),
  up: document.getElementById('st-up'),
  dur: document.getElementById('st-dur'),
  stateText: document.querySelector('#statusbar .st-state-text'),
};

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
  sb.load.textContent = s && s.load ? `${s.load}${s.cores ? ` (${s.cores}核)` : ''}` : '—';
  sb.mem.textContent = s && s.mem ? `${s.mem} MB` : '—';
  sb.disk.textContent = s && s.disk ? s.disk : '—';
  sb.up.textContent = s && s.up ? fmtUptime(s.up) : '—';

  // 阈值变色(仅在已连接且有数据时)
  const on = t.state === 'connected' && s;
  setLevel(sb.load, on ? loadLevel(s.load, s.cores) : null);
  setLevel(sb.mem, on ? memLevel(s.mem) : null);
  setLevel(sb.disk, on ? pctLevel(parsePct(s.disk), 80, 90) : null);

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
  if (activeTab === t.id) renderStatusBar();
});

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
  if (!tnModal.classList.contains('hidden')) tnModal.classList.add('hidden');
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

// 初始化
(async () => {
  const settings = await api.getSettings();
  intervalSel.value = String(settings.statsInterval ?? 5000);
  refreshHosts();
})();
