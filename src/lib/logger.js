'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class Logger {
  constructor() {
    this.ready = false;
  }

  // 延迟初始化:首次写日志时再解析路径,避免在 app ready 前访问 userData
  init() {
    if (this.ready) return;
    try {
      this.logsDir = path.join(app.getPath('userData'), 'logs');
      if (!fs.existsSync(this.logsDir)) fs.mkdirSync(this.logsDir, { recursive: true });
      const day = new Date().toISOString().split('T')[0];
      this.logFile = path.join(this.logsDir, `app-${day}.log`);
      this.ready = true;
    } catch {
      /* 文件日志不可用时,仅控制台输出 */
    }
  }

  format(level, message, data) {
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(data ? { data } : {}),
    });
  }

  writeLog(entry) {
    this.init();
    if (!this.logFile) return;
    try { fs.appendFileSync(this.logFile, `${entry}\n`); }
    catch (err) { console.error('Failed to write log:', err); }
  }

  log(message, data) {
    console.log(`[INFO] ${message}`, data || '');
    this.writeLog(this.format('INFO', message, data));
  }

  warn(message, data) {
    console.warn(`[WARN] ${message}`, data || '');
    this.writeLog(this.format('WARN', message, data));
  }

  error(message, error) {
    const data = error instanceof Error ? { message: error.message, stack: error.stack } : error;
    console.error(`[ERROR] ${message}`, data || '');
    this.writeLog(this.format('ERROR', message, data));
  }

  debug(message, data) {
    console.log(`[DEBUG] ${message}`, data || '');
    this.writeLog(this.format('DEBUG', message, data));
  }
}

module.exports = new Logger();
