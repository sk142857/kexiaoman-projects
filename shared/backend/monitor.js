/**
 * 系统服务监控模块
 * 每 15 分钟采集一次：服务器配置（CPU核/总内存/规格）、内存（heap/RSS/external）、CPU 使用率、句柄数等
 * 写入 service_monitor 表，并打印到云托管日志
 */
const os = require("os");
const fs = require("fs");
const { db } = require("./db");
const { nowSql } = require("./utils");

let _cpuLast = null;

/** 获取进程 CPU 使用率（%）—— 基于两次采样的差值，首次返回 null */
function getCpuPercent() {
  const usage = process.cpuUsage(); // { user, system } 微秒
  const now = Date.now();
  if (!_cpuLast) {
    _cpuLast = { usage, now };
    return null;
  }
  const deltaUser = usage.user - _cpuLast.usage.user;
  const deltaSys = usage.system - _cpuLast.usage.system;
  const deltaTime = (now - _cpuLast.now) * 1000; // 微秒
  _cpuLast = { usage, now };
  if (deltaTime <= 0) return 0;
  return Number((((deltaUser + deltaSys) / deltaTime) * 100).toFixed(2));
}

/** 生成监控主键：毫秒时间戳 + 2 位随机数（保证唯一） */
function genMonitorId() {
  const rand = String(Math.floor(Math.random() * 100)).padStart(2, "0");
  return `${Date.now()}${rand}`;
}

/** 读取云托管实例规格（环境变量，各平台命名不一，逐项探测） */
function getInstanceSpec() {
  const candidates = [
    "CLOUD_RUN_MEMORY", "CLOUD_RUN_CPU", "CLOUD_RUN_SERVICE_SPEC",
    "CONTAINER_MEMORY", "CONTAINER_CPU", "TCB_RUN_SPEC",
    "CLOUDBASE_RUN_SPEC", "CPU_LIMIT", "MEMORY_LIMIT",
  ];
  for (const key of candidates) {
    if (process.env[key]) {
      return `${key}=${process.env[key]}`;
    }
  }
  return "";
}

/** 获取容器内网 IP（eth0 非回环 IPv4；K8s Pod IP 通常在此） */
function getInternalIp() {
  try {
    const interfaces = os.networkInterfaces();
    const ips = [];
    Object.keys(interfaces).forEach(k => {
      (interfaces[k] || []).forEach(a => {
        if (a.family === "IPv4" && !a.internal) {
          ips.push(a.address);
        }
      });
    });
    // 优先 10.x/172.16-31.x/192.168.x（私网段），否则取第一个
    const pri = ips.find(ip => /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(ip));
    return pri || ips[0] || "";
  } catch (_) {
    return "";
  }
}

/** 安全读取文件内容，失败返回空串 */
function readFileSafe(path) {
  try {
    return fs.readFileSync(path, "utf8").trim();
  } catch (_) {
    return "";
  }
}

/**
 * 读取 cgroup 配置的容器 CPU 核数（支持 v1/v2）
 * - v2: /sys/fs/cgroup/cpu.max  内容 "quota period"（如 "250000 100000"）→ 0.25 核
 * - v1: /sys/fs/cgroup/cpu/cpu.cfs_quota_us 与 cpu.cfs_period_us
 * - 注意：os.cpus().length 读到的是宿主核数，容器限额必须看 cgroup
 */
function getCpuCores() {
  const v2 = readFileSafe("/sys/fs/cgroup/cpu.max");
  if (v2 && v2 !== "max") {
    const m = v2.match(/^(\d+)\s+(\d+)$/);
    if (m && Number(m[2]) > 0 && Number(m[1]) > 0) {
      return Number((Number(m[1]) / Number(m[2])).toFixed(2));
    }
  }
  const quota = readFileSafe("/sys/fs/cgroup/cpu/cpu.cfs_quota_us");
  const period = readFileSafe("/sys/fs/cgroup/cpu/cpu.cfs_period_us");
  if (quota && period && Number(quota) > 0 && Number(period) > 0) {
    return Number((Number(quota) / Number(period)).toFixed(2));
  }
  // 回退：无法读取 cgroup 时用宿主机核数
  return os.cpus().length;
}

/**
 * 读取 cgroup 配置的容器内存上限（MB，支持 v1/v2）
 * - v2: /sys/fs/cgroup/memory.max  内容为字节数或 "max"
 * - v1: /sys/fs/cgroup/memory/memory.limit_in_bytes（极大值视为无限制）
 * - 注意：os.totalmem() 读到的是宿主内存，容器限额必须看 cgroup
 */
function getMemTotalMb() {
  const v2 = readFileSafe("/sys/fs/cgroup/memory.max");
  if (v2 && v2 !== "max") {
    const bytes = Number(v2);
    if (bytes > 0 && bytes < 1024 * 1024 * 1024 * 1024) {
      return Math.round(bytes / 1024 / 1024);
    }
  }
  const v1 = readFileSafe("/sys/fs/cgroup/memory/memory.limit_in_bytes");
  if (v1) {
    const bytes = Number(v1);
    if (bytes > 0 && bytes < 1024 * 1024 * 1024 * 1024) {
      return Math.round(bytes / 1024 / 1024);
    }
  }
  // 回退：无法读取 cgroup 时用宿主机内存
  return Math.round(os.totalmem() / 1024 / 1024);
}

/** 采集一次监控数据并入库 + 打印日志 */
async function collect() {
  const mem = process.memoryUsage();
  const cpu = getCpuPercent();
  const instanceId = process.env.CLOUD_RUN_INSTANCE_ID
    || process.env.INSTANCE_ID
    || process.env.HOSTNAME
    || "unknown";
  const envId = process.env.CLOUDBASE_ENV_ID
    || process.env.TCB_ENV
    || process.env.CBR_ENV_ID
    || "";

  const metric = {
    monitor_id: genMonitorId(),
    env_id: envId,
    instance_id: String(instanceId),
    cpu_cores: getCpuCores(),
    mem_total_mb: getMemTotalMb(),
    instance_spec: getInstanceSpec(),
    internal_ip: getInternalIp(),
    zone_id: process.env.EKLET_META_ZONE || process.env.CBR_ZONE || "",
    cluster_id: process.env.EKLET_META_ID || process.env.CBR_CA_ID || "",
    node_version: process.version || "",
    heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
    heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
    rss_mb: Math.round(mem.rss / 1024 / 1024),
    external_mb: Math.round((mem.external || 0) / 1024 / 1024),
    cpu_percent: cpu == null ? 0 : cpu,
    uptime_min: Math.floor(process.uptime() / 60),
    active_handles: process._getActiveHandles ? process._getActiveHandles().length : -1,
    active_reqs: process._getActiveRequests ? process._getActiveRequests().length : -1,
    created_at: nowSql(),
  };

  // 控制台日志（云托管可检索）
  console.log(
    `[monitor] ${metric.created_at} | env=${metric.env_id} | inst=${metric.instance_id} | ip=${metric.internal_ip} | ` +
    `zone=${metric.zone_id} cluster=${metric.cluster_id} | spec=${metric.instance_spec || `${metric.cpu_cores}核/${metric.mem_total_mb}MB`} | ` +
    `rss=${metric.rss_mb}MB heap=${metric.heap_used_mb}/${metric.heap_total_mb}MB ext=${metric.external_mb}MB | ` +
    `cpu=${metric.cpu_percent}% | uptime=${metric.uptime_min}min | handles=${metric.active_handles} reqs=${metric.active_reqs}`
  );

  // 入库（失败不影响主服务）
  try {
    const { error } = await db.from("service_monitor").insert(metric);
    if (error) throw error;
  } catch (e) {
    console.error("[monitor] 入库失败", e.message);
  }
}

/** 启动监控定时器（每 15 分钟） */
function startMonitor(intervalMs = 15 * 60 * 1000) {
  // 启动时立即采集一次，之后每 15 分钟
  setTimeout(() => {
    collect();
  }, 3000);
  setInterval(() => {
    collect();
  }, intervalMs);
}

module.exports = { collect, startMonitor };
