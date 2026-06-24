'use strict';

/**
 * 验证主机配置
 * @param {Object} host - 主机配置对象
 * @returns {Object} { valid: boolean, errors: string[] }
 */
function validateHostConfig(host) {
  const errors = [];

  if (!host.host || host.host.trim() === '') {
    errors.push('主机地址不能为空');
  } else if (!isValidHost(host.host)) {
    errors.push('主机地址格式无效(应为 IP 或域名)');
  }

  if (!host.port || !isValidPort(host.port)) {
    errors.push('端口号无效(应在 1-65535 之间)');
  }

  if (!host.username || host.username.trim() === '') {
    errors.push('用户名不能为空');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * 验证 IP 地址或域名
 * @param {string} str - 要验证的字符串
 * @returns {boolean}
 */
function isValidHost(str) {
  if (!str || typeof str !== 'string') return false;

  // IPv4 地址验证
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (ipv4Regex.test(str)) {
    return str.split('.').every((part) => {
      const num = parseInt(part, 10);
      return num >= 0 && num <= 255;
    });
  }

  // IPv6 地址简单检查
  if (str.includes(':')) {
    return /^[a-f0-9:]+$/i.test(str);
  }

  // 域名验证
  const domainRegex = /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z]{2,}$/;
  if (domainRegex.test(str)) return true;

  // 本地主机
  return str === 'localhost';
}

/**
 * 验证端口号
 * @param {number|string} port - 端口号
 * @returns {boolean}
 */
function isValidPort(port) {
  const portNum = Number(port);
  return Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535;
}

/**
 * 验证用户名
 * @param {string} username - 用户名
 * @returns {boolean}
 */
function isValidUsername(username) {
  return !!username && username.trim().length > 0 && username.length <= 64;
}

/**
 * 验证文件路径(基础检查)
 * @param {string} filePath - 文件路径
 * @returns {boolean}
 */
function isValidFilePath(filePath) {
  if (!filePath || filePath.trim() === '') return false;
  // Unix 绝对路径放行;否则禁止 Windows 文件名非法字符(忽略盘符冒号)
  return /^\/.+/.test(filePath) || !/[<>"|?*]/.test(filePath.replace(/^[a-zA-Z]:/, ''));
}

/**
 * 验证 SSH 私钥路径
 * @param {string} keyPath - 私钥路径
 * @returns {boolean}
 */
function isValidKeyPath(keyPath) {
  if (!keyPath || keyPath.trim() === '') return false;
  return isValidFilePath(keyPath);
}

/**
 * 验证隧道配置
 * @param {Object} tunnel - 隧道配置
 * @returns {Object} { valid: boolean, errors: string[] }
 */
function validateTunnelConfig(tunnel) {
  const errors = [];

  if (!tunnel.type || !['local', 'dynamic'].includes(tunnel.type)) {
    errors.push('隧道类型无效');
  }

  if (!isValidPort(tunnel.srcPort)) {
    errors.push('本地端口号无效(应在 1-65535 之间)');
  }

  if (tunnel.type === 'local') {
    if (!tunnel.dstHost || !isValidHost(tunnel.dstHost)) {
      errors.push('目标主机地址无效');
    }
    if (!isValidPort(tunnel.dstPort)) {
      errors.push('目标端口号无效');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

module.exports = {
  validateHostConfig,
  isValidHost,
  isValidPort,
  isValidUsername,
  isValidFilePath,
  isValidKeyPath,
  validateTunnelConfig,
};
