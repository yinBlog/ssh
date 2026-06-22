'use strict';

const { contextBridge, ipcRenderer, clipboard } = require('electron');

// 渲染进程通过 window.api 与主进程安全通信(不暴露完整 Node 能力)
contextBridge.exposeInMainWorld('sshBridge', {
  // 主机管理
  listHosts: () => ipcRenderer.invoke('hosts:list'),
  saveHost: (host) => ipcRenderer.invoke('hosts:save', host),
  deleteHost: (id) => ipcRenderer.invoke('hosts:delete', id),

  // 应用设置
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // 端口转发 / SSH 隧道
  tunnelList: (sessionId) => ipcRenderer.invoke('tunnel:list', { sessionId }),
  tunnelAdd: (cfg) => ipcRenderer.invoke('tunnel:add', cfg),
  tunnelRemove: (sessionId, id) => ipcRenderer.invoke('tunnel:remove', { sessionId, id }),

  // SFTP 文件管理
  sftpList: (sessionId, dir) => ipcRenderer.invoke('sftp:list', { sessionId, dir }),
  sftpDownload: (sessionId, remotePath, name) => ipcRenderer.invoke('sftp:download', { sessionId, remotePath, name }),
  sftpUpload: (sessionId, remoteDir) => ipcRenderer.invoke('sftp:upload', { sessionId, remoteDir }),
  sftpMkdir: (sessionId, dir, name) => ipcRenderer.invoke('sftp:mkdir', { sessionId, dir, name }),
  sftpDelete: (sessionId, target, isDir) => ipcRenderer.invoke('sftp:delete', { sessionId, target, isDir }),
  sftpRename: (sessionId, oldPath, newPath) => ipcRenderer.invoke('sftp:rename', { sessionId, oldPath, newPath }),

  // SSH 连接
  connect: (cfg) => ipcRenderer.invoke('ssh:connect', cfg),
  sendData: (sessionId, data) => ipcRenderer.send('ssh:data', { sessionId, data }),
  resize: (sessionId, cols, rows) => ipcRenderer.send('ssh:resize', { sessionId, cols, rows }),
  disconnect: (sessionId) => ipcRenderer.send('ssh:disconnect', { sessionId }),

  // 自绘标题栏窗口控制
  winMinimize: () => ipcRenderer.send('win:minimize'),
  winMaximize: () => ipcRenderer.send('win:maximize'),
  winClose: () => ipcRenderer.send('win:close'),
  onWinState: (cb) => ipcRenderer.on('win:state', (_e, payload) => cb(payload)),

  // 系统剪贴板(终端复制/粘贴)
  clipboardWrite: (text) => clipboard.writeText(text || ''),
  clipboardRead: () => clipboard.readText(),

  // 主进程 -> 渲染进程的事件
  onOutput: (cb) => ipcRenderer.on('ssh:output', (_e, payload) => cb(payload)),
  onStatus: (cb) => ipcRenderer.on('ssh:status', (_e, payload) => cb(payload)),
  onStats: (cb) => ipcRenderer.on('ssh:stats', (_e, payload) => cb(payload)),

  // 主机指纹确认
  onHostKey: (cb) => ipcRenderer.on('ssh:hostkey', (_e, payload) => cb(payload)),
  hostKeyReply: (reqId, accept) => ipcRenderer.send('ssh:hostkey-reply', { reqId, accept }),
});
