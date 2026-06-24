'use strict';

/** 自定义 SSH 错误基类 */
class SSHError extends Error {
  constructor(message, code = 'SSH_ERROR', details = {}) {
    super(message);
    this.name = 'SSHError';
    this.code = code;
    this.details = details;
    this.timestamp = new Date().toISOString();
  }
}

/** 网络相关错误 */
class NetworkError extends SSHError {
  constructor(message, details) {
    super(message, 'NETWORK_ERROR', details);
    this.name = 'NetworkError';
  }
}

/** 认证相关错误 */
class AuthenticationError extends SSHError {
  constructor(message, details) {
    super(message, 'AUTH_ERROR', details);
    this.name = 'AuthenticationError';
  }
}

/** 文件操作相关错误 */
class FileOperationError extends SSHError {
  constructor(message, details) {
    super(message, 'FILE_OP_ERROR', details);
    this.name = 'FileOperationError';
  }
}

/** SFTP 相关错误 */
class SFTPError extends SSHError {
  constructor(message, details) {
    super(message, 'SFTP_ERROR', details);
    this.name = 'SFTPError';
  }
}

/**
 * 解析 ssh2 / 系统原生错误并转换为带建议的自定义错误
 * @param {Error|string} err
 * @returns {SSHError}
 */
function parseSSHError(err) {
  if (!err) return new SSHError('发生未知错误');

  const message = err.message || String(err);
  const stamp = () => new Date().toISOString();

  if (message.includes('ECONNREFUSED') || message.includes('Connection refused')) {
    return new NetworkError('连接被拒绝 —— 目标主机不可达或 SSH 服务未运行', {
      originalMessage: message,
      suggestions: ['检查主机地址和端口是否正确', '确认目标主机的 SSH 服务已启动', '检查防火墙 / 云安全组是否放行 SSH 端口'],
      timestamp: stamp(),
    });
  }

  if (message.includes('ETIMEDOUT') || message.includes('timed out') || message.includes('before handshake')) {
    return new NetworkError('连接超时 / 握手前断开 —— 网络不稳定或被中途切断', {
      originalMessage: message,
      suggestions: ['检查网络连通性', '确认端口确实是 SSH 服务', '检查中间防火墙 / 代理'],
      timestamp: stamp(),
    });
  }

  if (message.includes('All configured authentication methods failed')) {
    return new AuthenticationError('所有认证方式均失败 —— 请检查凭据', {
      originalMessage: message,
      suggestions: ['检查用户名是否正确', '确认密码或私钥无误', '若用私钥,确认 passphrase(口令)正确'],
      timestamp: stamp(),
    });
  }

  if (message.includes('Unsupported key format') || message.includes('Cannot parse privateKey') || message.includes('Invalid key')) {
    return new AuthenticationError('私钥格式不支持或已损坏', {
      originalMessage: message,
      suggestions: ['确保私钥为 PEM 或 OpenSSH 格式', '尝试用 ssh-keygen 转换格式', '检查私钥文件是否完整'],
      timestamp: stamp(),
    });
  }

  if (message.includes('Permission denied')) {
    return new AuthenticationError('权限被拒绝 —— 无效的私钥或密码', {
      originalMessage: message,
      suggestions: ['核对登录凭证', '若用私钥,确认格式与对应公钥已部署', '检查私钥文件权限(通常需 600)'],
      timestamp: stamp(),
    });
  }

  if (message.includes('No such file') || message.includes('ENOENT')) {
    return new FileOperationError('文件或目录不存在', { originalMessage: message, timestamp: stamp() });
  }

  if (message.includes('SFTP') || message.includes('sftp')) {
    return new SFTPError('文件传输出错', { originalMessage: message, timestamp: stamp() });
  }

  return new SSHError(message, 'SSH_ERROR', { timestamp: stamp() });
}

/**
 * 生成面向用户的友好提示(含建议)
 * @param {Error} error
 * @returns {string}
 */
function getUserFriendlyMessage(error) {
  const e = error instanceof SSHError ? error : parseSSHError(error);
  const tip = e.details && e.details.suggestions ? `\n建议:${e.details.suggestions.join(';')}` : '';
  return `${e.message}${tip}`;
}

module.exports = {
  SSHError,
  NetworkError,
  AuthenticationError,
  FileOperationError,
  SFTPError,
  parseSSHError,
  getUserFriendlyMessage,
};
