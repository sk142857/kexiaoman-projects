/**
 * 日志模块
 * 按级别输出日志，生产环境可接入外部日志采集。
 */
const util = require('util');

function format(args) {
  return args.map((a) => {
    if (typeof a === 'string') return a;
    return util.inspect(a, { depth: 5, breakLength: 120 });
  }).join(' ');
}

function ts() {
  return new Date().toISOString();
}

const logger = {
  info(...args) {
    console.log(`[INFO] ${ts()} ${format(args)}`);
  },
  warn(...args) {
    console.warn(`[WARN] ${ts()} ${format(args)}`);
  },
  error(...args) {
    console.error(`[ERROR] ${ts()} ${format(args)}`);
  },
  debug(...args) {
    if (process.env.DEBUG) {
      console.log(`[DEBUG] ${ts()} ${format(args)}`);
    }
  }
};

module.exports = logger;
