'use strict';

const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

let lastCpuStats = null;
let lastSampleTime = 0;
let cachedSnapshot = null;
let monitorTimer = null;
let subscribersCount = 0;
let onDataCallback = null;

function parseProcStatLine(line) {
  const parts = line.trim().split(/\s+/);
  const name = parts[0];
  const nums = parts.slice(1).map(Number);
  const user = nums[0] || 0;
  const nice = nums[1] || 0;
  const system = nums[2] || 0;
  const idle = nums[3] || 0;
  const iowait = nums[4] || 0;
  const irq = nums[5] || 0;
  const softirq = nums[6] || 0;
  const steal = nums[7] || 0;

  const idleAll = idle + iowait;
  const systemAll = system + irq + softirq;
  const total = user + nice + systemAll + idleAll + steal;
  return { name, idle: idleAll, total };
}

function readLinuxCpu() {
  try {
    const content = fs.readFileSync('/proc/stat', 'utf8');
    const lines = content.split('\n');
    const stats = {};
    for (const line of lines) {
      if (line.startsWith('cpu')) {
        const parsed = parseProcStatLine(line);
        stats[parsed.name] = parsed;
      }
    }
    return stats;
  } catch {
    return null;
  }
}

function calculateCpuDelta(prev, curr) {
  if (!prev || !curr) return 0;
  const dTotal = curr.total - prev.total;
  const dIdle = curr.idle - prev.idle;
  if (dTotal <= 0) return 0;
  const pct = Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100));
  return Number(pct.toFixed(1));
}

function readLinuxMemory() {
  try {
    const content = fs.readFileSync('/proc/meminfo', 'utf8');
    const map = {};
    for (const line of content.split('\n')) {
      const match = line.match(/^([A-Za-z0-9_()]+):\s+(\d+)\s*kB/);
      if (match) {
        map[match[1]] = parseInt(match[2], 10) * 1024;
      }
    }
    const totalMem = map.MemTotal || 0;
    const availMem = map.MemAvailable != null ? map.MemAvailable : (map.MemFree || 0);
    const usedMem = Math.max(0, totalMem - availMem);
    const memPercent = totalMem > 0 ? Number(((usedMem / totalMem) * 100).toFixed(1)) : 0;

    const totalSwap = map.SwapTotal || 0;
    const freeSwap = map.SwapFree || 0;
    const usedSwap = Math.max(0, totalSwap - freeSwap);
    const swapPercent = totalSwap > 0 ? Number(((usedSwap / totalSwap) * 100).toFixed(1)) : 0;

    return {
      memory: {
        total: totalMem,
        used: usedMem,
        free: map.MemFree || 0,
        available: availMem,
        percent: memPercent
      },
      swap: {
        total: totalSwap,
        used: usedSwap,
        free: freeSwap,
        percent: swapPercent
      }
    };
  } catch {
    return null;
  }
}

function readOsCpu(cpus) {
  const stats = {};
  for (let i = 0; i < cpus.length; i++) {
    const cpu = cpus[i];
    const idle = cpu.times.idle;
    const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
    stats[`cpu${i}`] = { name: `cpu${i}`, idle, total };
  }
  const totalIdle = Object.values(stats).reduce((a, b) => a + b.idle, 0);
  const totalAll = Object.values(stats).reduce((a, b) => a + b.total, 0);
  stats.cpu = { name: 'cpu', idle: totalIdle, total: totalAll };
  return stats;
}

function fetchTopProcesses(topCount = 10) {
  return new Promise((resolve) => {
    if (process.platform === 'linux' || process.platform === 'darwin') {
      execFile('ps', ['-eo', 'pid,pcpu,pmem,comm', '--sort=-pcpu'], { timeout: 1500 }, (err, stdout) => {
        if (err || !stdout) {
          return resolve([]);
        }
        const lines = stdout.trim().split('\n').slice(1);
        const processes = [];
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length < 4) continue;
          const pid = parseInt(parts[0], 10);
          const cpu = parseFloat(parts[1]) || 0;
          const mem = parseFloat(parts[2]) || 0;
          const name = parts.slice(3).join(' ');
          if (!Number.isNaN(pid) && name) {
            processes.push({ pid, name, cpu, mem });
          }
          if (processes.length >= topCount) break;
        }
        resolve(processes);
      });
    } else {
      resolve([]);
    }
  });
}

async function getSystemInfo(options = {}) {
  const topCount = Math.max(1, Math.min(50, options.topCount || 10));
  const now = Date.now();
  const isLinux = process.platform === 'linux';

  let currentCpuStats = isLinux ? readLinuxCpu() : null;
  if (!currentCpuStats) {
    currentCpuStats = readOsCpu(os.cpus());
  }

  // If no previous stats, sample briefly to calculate deltas
  if (!lastCpuStats || (now - lastSampleTime > 15000)) {
    lastCpuStats = currentCpuStats;
    await new Promise((res) => setTimeout(res, 50));
    currentCpuStats = (isLinux ? readLinuxCpu() : null) || readOsCpu(os.cpus());
  }

  // Calculate CPU delta
  const overallCpu = calculateCpuDelta(lastCpuStats.cpu, currentCpuStats.cpu);
  const coreKeys = Object.keys(currentCpuStats).filter((k) => k !== 'cpu').sort((a, b) => {
    return parseInt(a.replace('cpu', ''), 10) - parseInt(b.replace('cpu', ''), 10);
  });
  const coresCpu = coreKeys.map((k) => calculateCpuDelta(lastCpuStats[k], currentCpuStats[k]));

  lastCpuStats = currentCpuStats;
  lastSampleTime = now;

  // Memory & Swap
  let memInfo = isLinux ? readLinuxMemory() : null;
  if (!memInfo) {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    const percent = total > 0 ? Number(((used / total) * 100).toFixed(1)) : 0;
    memInfo = {
      memory: { total, used, free, available: free, percent },
      swap: { total: 0, used: 0, free: 0, percent: 0 }
    };
  }

  // Top processes
  const processes = await fetchTopProcesses(topCount);

  const snapshot = {
    platform: process.platform,
    uptime: Math.floor(os.uptime()),
    loadAvg: os.loadavg().map((n) => Number(n.toFixed(2))),
    cpu: {
      overall: overallCpu,
      cores: coresCpu
    },
    memory: memInfo.memory,
    swap: memInfo.swap,
    processes
  };

  cachedSnapshot = snapshot;
  return snapshot;
}

function subscribe(callback) {
  subscribersCount++;
  onDataCallback = callback;
  if (!monitorTimer) {
    // Initial call
    getSystemInfo().then((info) => {
      if (onDataCallback) onDataCallback(info);
    }).catch(() => {});

    monitorTimer = setInterval(async () => {
      try {
        const info = await getSystemInfo();
        if (onDataCallback) onDataCallback(info);
      } catch {
        /* ignore polling errors */
      }
    }, 2000);
    monitorTimer.unref();
  }
}

function unsubscribe() {
  subscribersCount = Math.max(0, subscribersCount - 1);
  if (subscribersCount === 0 && monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
    onDataCallback = null;
  }
}

module.exports = {
  getSystemInfo,
  subscribe,
  unsubscribe,
  getCachedSnapshot: () => cachedSnapshot
};
