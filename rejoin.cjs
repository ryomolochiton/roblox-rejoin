#!/usr/bin/env node
'use strict';
/* ==========================================================================
 * MultiRejoinTool v2.0.0  --  rejoin.cjs (ban gop 1 file)
 *
 * Zero dependency: chi dung module chuan cua Node.js.
 * Khong can npm install. Khong co node_modules.
 * Duoi .cjs dam bao luon chay o che do CommonJS.
 *
 * Yeu cau : Node.js >= 16
 * Chay    : node rejoin.cjs
 * Tro giup: node rejoin.cjs --help
 *
 * Hai loi da xu ly san:
 *  1) boxen/chalk ban moi la ESM -> require() nem ERR_REQUIRE_ESM.
 *     Da bo hai package do, tu viet box.js va colors.js.
 *  2) readline "nuot" dong khi input den don dap (paste nhieu dong / pipe).
 *     Da thay bang hang doi dong trong utils/prompt.
 * ========================================================================== */

const __nodeRequire = require;
const __mods = {};
const __cache = {};

function __req(id) {
  if (Object.prototype.hasOwnProperty.call(__cache, id)) return __cache[id].exports;
  if (Object.prototype.hasOwnProperty.call(__mods, id)) {
    const m = { exports: {} };
    __cache[id] = m;
    __mods[id](m, m.exports, __req);
    return m.exports;
  }
  // Khong phai module noi bo -> module chuan cua Node (fs, path, https, crypto...)
  return __nodeRequire(id);
}

/* ---------- module: utils/colors ---------- */
__mods['utils/colors'] = function(module, exports, require) {
'use strict';

/**
 * Zero-dependency ANSI color helper.
 * Thay cho chalk/boxen (2 package đó bản mới là ESM -> require() sẽ crash).
 */

const FORCE = process.env.FORCE_COLOR === '1' || process.env.FORCE_COLOR === 'true';
const DISABLED = process.env.NO_COLOR !== undefined || process.env.FORCE_COLOR === '0';
const ENABLED = FORCE || (!DISABLED && Boolean(process.stdout && process.stdout.isTTY));

const CODES = {
  reset: [0, 0],
  bold: [1, 22],
  dim: [2, 22],
  italic: [3, 23],
  underline: [4, 24],
  inverse: [7, 27],

  black: [30, 39],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  magenta: [35, 39],
  cyan: [36, 39],
  white: [37, 39],
  gray: [90, 39],
  grey: [90, 39],

  brightRed: [91, 39],
  brightGreen: [92, 39],
  brightYellow: [93, 39],
  brightBlue: [94, 39],
  brightMagenta: [95, 39],
  brightCyan: [96, 39],
  brightWhite: [97, 39],

  bgBlack: [40, 49],
  bgRed: [41, 49],
  bgGreen: [42, 49],
  bgYellow: [43, 49],
  bgBlue: [44, 49],
  bgMagenta: [45, 49],
  bgCyan: [46, 49],
  bgWhite: [47, 49],
};

const colors = {};

for (const [name, [open, close]] of Object.entries(CODES)) {
  colors[name] = (input) => {
    const text = String(input);
    if (!ENABLED) return text;
    return `\u001b[${open}m${text}\u001b[${close}m`;
  };
}

const ANSI_RE = /\u001b\[[0-9;]*m/g;

/** Bỏ toàn bộ mã màu khỏi chuỗi. */
colors.strip = (input) => String(input).replace(ANSI_RE, '');

/**
 * Ước lượng bề rộng hiển thị (ký tự CJK / emoji chiếm 2 cột).
 * Cần cho việc căn khung box cho thẳng hàng.
 */
colors.width = (input) => {
  const text = colors.strip(input);
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === 0x200d) continue; // zero width joiner
    if (cp >= 0xfe00 && cp <= 0xfe0f) continue; // variation selectors
    if (cp < 32 || (cp >= 0x7f && cp <= 0x9f)) continue; // control chars
    width += isWide(cp) ? 2 : 1;
  }
  return width;
};

function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
};

/** Cắt chuỗi theo bề rộng hiển thị, thêm "…" nếu bị cắt. */
colors.truncate = (input, max) => {
  const text = String(input);
  if (colors.width(text) <= max) return text;
  let out = '';
  let w = 0;
  for (const ch of colors.strip(text)) {
    const cw = colors.width(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
};

/** Đệm phải cho đủ bề rộng hiển thị. */
colors.padEnd = (input, target) => {
  const text = String(input);
  const pad = target - colors.width(text);
  return pad > 0 ? text + ' '.repeat(pad) : text;
};

/** Đệm trái cho đủ bề rộng hiển thị. */
colors.padStart = (input, target) => {
  const text = String(input);
  const pad = target - colors.width(text);
  return pad > 0 ? ' '.repeat(pad) + text : text;
};

colors.enabled = ENABLED;

module.exports = colors;

};

/* ---------- module: utils/box ---------- */
__mods['utils/box'] = function(module, exports, require) {
'use strict';

/**
 * Thay thế cho `boxen`.
 * Lý do tự viết: boxen >= 6 là ESM thuần, `require('boxen')` sẽ ném
 * ERR_REQUIRE_ESM và tool chết ngay lúc khởi động.
 */

const c = require('utils/colors');

const STYLES = {
  single: { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│', ml: '├', mr: '┤' },
  double: { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║', ml: '╠', mr: '╣' },
  round: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│', ml: '├', mr: '┤' },
  bold: { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃', ml: '┣', mr: '┫' },
  ascii: { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|', ml: '+', mr: '+' },
};

function terminalWidth() {
  return (process.stdout && process.stdout.columns) || 80;
}

/**
 * @param {string|string[]} content  Nội dung (chuỗi có \n hoặc mảng dòng)
 * @param {object} [opts]
 * @param {string} [opts.title]      Tiêu đề gắn trên viền
 * @param {string} [opts.style]      single | double | round | bold | ascii
 * @param {function} [opts.color]    Hàm tô màu viền, vd colors.cyan
 * @param {number} [opts.padding]    Đệm ngang, mặc định 1
 * @param {number} [opts.width]      Bề rộng cố định (tính cả viền)
 * @param {string} [opts.align]      left | center
 * @param {number[]} [opts.dividers] Chỉ số dòng cần chèn đường kẻ ngang phía trên
 */
function box(content, opts = {}) {
  const {
    title = '',
    style = 'round',
    color = (s) => s,
    padding = 1,
    align = 'left',
    dividers = [],
  } = opts;

  const s = STYLES[style] || STYLES.round;
  const lines = Array.isArray(content) ? content.slice() : String(content).split('\n');

  const maxAllowed = Math.max(20, terminalWidth() - 2);
  let inner = 0;
  for (const line of lines) inner = Math.max(inner, c.width(line));
  if (title) inner = Math.max(inner, c.width(title) + 2);

  inner += padding * 2;

  if (opts.width) inner = opts.width - 2;
  inner = Math.min(inner, maxAllowed - 2);

  const out = [];

  // Viền trên (có thể gắn tiêu đề)
  if (title) {
    const label = ` ${title} `;
    const labelW = c.width(label);
    const left = 1;
    const right = Math.max(0, inner - labelW - left);
    out.push(color(s.tl + s.h.repeat(left)) + c.bold(label) + color(s.h.repeat(right) + s.tr));
  } else {
    out.push(color(s.tl + s.h.repeat(inner) + s.tr));
  }

  // Nội dung
  lines.forEach((line, index) => {
    if (dividers.includes(index)) {
      out.push(color(s.ml + s.h.repeat(inner) + s.mr));
    }
    const text = c.truncate(line, inner - padding * 2);
    const free = inner - padding * 2 - c.width(text);
    let body;
    if (align === 'center') {
      const left = Math.floor(free / 2);
      body = ' '.repeat(padding + left) + text + ' '.repeat(inner - padding - left - c.width(text));
    } else {
      body = ' '.repeat(padding) + text + ' '.repeat(Math.max(0, free + padding));
    }
    out.push(color(s.v) + body + color(s.v));
  });

  out.push(color(s.bl + s.h.repeat(inner) + s.br));
  return out.join('\n');
}

/** Đường kẻ ngang chiếm hết bề rộng terminal. */
box.rule = (char = '─', color = (s) => s) => color(char.repeat(Math.max(10, terminalWidth() - 2)));

box.styles = Object.keys(STYLES);
box.terminalWidth = terminalWidth;

module.exports = box;

};

/* ---------- module: utils/prompt ---------- */
__mods['utils/prompt'] = function(module, exports, require) {
'use strict';

/**
 * Lớp đọc input dòng lệnh.
 *
 * LỖI ĐÃ SỬA: dùng readline.question() trực tiếp thì khi input đến dồn dập
 * (paste nhiều dòng, hoặc pipe từ file / echo) readline sẽ "nuốt" mất các dòng
 * sau vì chưa có consumer nào đang chờ tại thời điểm dòng đó tới.
 *
 * Cách xử lý: luôn lắng nghe sự kiện 'line' và đẩy vào HÀNG ĐỢI.
 *  - Nếu đã có người đang chờ  -> giao dòng ngay cho họ.
 *  - Nếu chưa                  -> cất vào buffer, ai hỏi sau thì lấy ra dùng.
 */

const readline = require('readline');
const c = require('utils/colors');

class Prompt {
  constructor(options = {}) {
    this.input = options.input || process.stdin;
    this.output = options.output || process.stdout;

    this.rl = readline.createInterface({
      input: this.input,
      output: this.output,
      terminal: Boolean(this.output.isTTY),
      historySize: 50,
    });

    /** @type {string[]} Các dòng đã nhận nhưng chưa ai lấy */
    this.buffer = [];
    /** @type {Array<{resolve: Function}>} Những chỗ đang chờ 1 dòng */
    this.waiters = [];

    this.closed = false;

    this.rl.on('line', (line) => {
      const value = line.replace(/\r$/, '');
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(value);
      else this.buffer.push(value);
    });

    this.rl.on('close', () => {
      this.closed = true;
      // Giải phóng tất cả người đang chờ bằng null (EOF) -> tool thoát êm,
      // không bị treo vô hạn khi stdin đóng.
      while (this.waiters.length) this.waiters.shift().resolve(null);
    });
  }

  /**
   * Đọc một dòng thô.
   * @returns {Promise<string|null>} null nghĩa là EOF / stdin đã đóng.
   */
  readLine() {
    if (this.buffer.length) return Promise.resolve(this.buffer.shift());
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push({ resolve }));
  }

  /**
   * Hỏi người dùng một câu.
   * @param {string} question
   * @param {object} [opts]
   * @param {string} [opts.default] Giá trị mặc định khi người dùng bấm Enter
   * @returns {Promise<string|null>}
   */
  async ask(question, opts = {}) {
    const suffix = opts.default !== undefined ? c.gray(` [${opts.default}]`) : '';
    this.output.write(`${c.cyan('?')} ${question}${suffix}${c.gray(' > ')}`);
    const answer = await this.readLine();
    if (answer === null) return null;
    const trimmed = answer.trim();
    if (!trimmed && opts.default !== undefined) return String(opts.default);
    return trimmed;
  }

  /** Hỏi câu có/không. Trả về boolean, hoặc null nếu EOF. */
  async confirm(question, defaultYes = false) {
    const hint = defaultYes ? 'Y/n' : 'y/N';
    const answer = await this.ask(`${question} ${c.gray(`(${hint})`)}`);
    if (answer === null) return null;
    if (!answer) return defaultYes;
    return /^(y|yes|c|co|có|ok|1|true)$/i.test(answer);
  }

  /**
   * Hỏi một số nguyên nằm trong khoảng cho phép, hỏi lại nếu sai.
   * @returns {Promise<number|null>}
   */
  async askNumber(question, { min = -Infinity, max = Infinity, default: def } = {}) {
    for (;;) {
      const raw = await this.ask(question, def !== undefined ? { default: def } : {});
      if (raw === null) return null;
      const value = Number(raw);
      if (Number.isFinite(value) && Number.isInteger(value) && value >= min && value <= max) {
        return value;
      }
      this.output.write(c.red(`  ✗ Nhập số nguyên từ ${min} đến ${max}.\n`));
    }
  }

  /**
   * Hỏi chọn 1 phương án trong danh sách (nhập số thứ tự).
   * @param {string} question
   * @param {Array<{label: string, value: any, hint?: string}>} choices
   * @returns {Promise<any|null>}
   */
  async select(question, choices) {
    this.output.write(`\n${c.bold(question)}\n`);
    choices.forEach((choice, i) => {
      const idx = c.cyan(String(i + 1).padStart(2, ' '));
      const hint = choice.hint ? c.gray(`  ${choice.hint}`) : '';
      this.output.write(`  ${idx}. ${choice.label}${hint}\n`);
    });
    const pick = await this.askNumber('Chọn', { min: 1, max: choices.length });
    if (pick === null) return null;
    return choices[pick - 1].value;
  }

  /** Chờ người dùng bấm Enter. */
  async pause(message = 'Bấm Enter để tiếp tục...') {
    this.output.write(c.gray(`\n${message}`));
    await this.readLine();
    this.output.write('\n');
  }

  close() {
    if (!this.closed) {
      this.closed = true;
      this.rl.close();
    }
  }
}

module.exports = Prompt;

};

/* ---------- module: utils/logger ---------- */
__mods['utils/logger'] = function(module, exports, require) {
'use strict';

const fs = require('fs');
const path = require('path');
const c = require('utils/colors');

const LEVELS = { debug: 10, info: 20, success: 20, warn: 30, error: 40, silent: 99 };

class Logger {
  /**
   * @param {object} [opts]
   * @param {string} [opts.level]    debug | info | warn | error | silent
   * @param {string} [opts.file]     Đường dẫn file log (tuỳ chọn)
   * @param {string} [opts.scope]    Nhãn hiện trước mỗi dòng
   */
  constructor(opts = {}) {
    this.level = LEVELS[opts.level] !== undefined ? LEVELS[opts.level] : LEVELS.info;
    this.file = opts.file || null;
    this.scope = opts.scope || '';
    this.history = [];
    this.maxHistory = opts.maxHistory || 500;

    if (this.file) {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
      } catch (_) {
        this.file = null;
      }
    }
  }

  child(scope) {
    const logger = new Logger({ level: 'info', file: this.file, scope });
    logger.level = this.level;
    logger.history = this.history;
    return logger;
  }

  static timestamp() {
    const d = new Date();
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  _write(levelName, symbol, colorFn, args) {
    if (LEVELS[levelName] < this.level) return;

    const time = Logger.timestamp();
    const message = args
      .map((a) => (typeof a === 'string' ? a : safeInspect(a)))
      .join(' ');

    const scopeTag = this.scope ? c.magenta(`[${this.scope}] `) : '';
    const line = `${c.gray(time)} ${colorFn(symbol)} ${scopeTag}${message}`;

    const stream = levelName === 'error' || levelName === 'warn' ? process.stderr : process.stdout;
    stream.write(line + '\n');

    this.history.push({ time, level: levelName, message: c.strip(message) });
    if (this.history.length > this.maxHistory) this.history.shift();

    if (this.file) {
      try {
        fs.appendFileSync(
          this.file,
          `[${new Date().toISOString()}] [${levelName.toUpperCase()}]${
            this.scope ? ` [${this.scope}]` : ''
          } ${c.strip(message)}\n`
        );
      } catch (_) {
        /* log ra file lỗi thì bỏ qua, không được làm chết tool */
      }
    }
  }

  debug(...a) { this._write('debug', '·', c.gray, a); }
  info(...a) { this._write('info', 'ℹ', c.cyan, a); }
  success(...a) { this._write('success', '✓', c.green, a); }
  warn(...a) { this._write('warn', '!', c.yellow, a); }
  error(...a) { this._write('error', '✗', c.red, a); }

  /** In dòng trống. */
  blank() { process.stdout.write('\n'); }

  /** Lấy N dòng log gần nhất (dùng cho UIRenderer). */
  tail(n = 10) {
    return this.history.slice(-n);
  }
}

function safeInspect(value) {
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

module.exports = Logger;
module.exports.LEVELS = LEVELS;

};

/* ---------- module: utils/http ---------- */
__mods['utils/http'] = function(module, exports, require) {
'use strict';

/**
 * HTTP client tối giản dựa trên module https có sẵn của Node.
 * Không dùng axios/node-fetch để giữ zero-dependency.
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

/**
 * @param {string} url
 * @param {object} [opts]
 * @param {string} [opts.method]    GET | POST | ...
 * @param {object} [opts.headers]
 * @param {string|Buffer} [opts.body]
 * @param {number} [opts.timeout]   ms, mặc định 15000
 * @param {number} [opts.retries]   số lần thử lại khi lỗi mạng / 5xx / 429
 * @returns {Promise<{status:number, headers:object, body:string, json:Function}>}
 */
function request(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null,
    timeout = 15000,
    retries = 0,
    retryDelay = 1000,
  } = opts;

  const attempt = (left) =>
    new Promise((resolve, reject) => {
      let target;
      try {
        target = new URL(url);
      } catch (err) {
        return reject(new Error(`URL không hợp lệ: ${url}`));
      }

      const lib = target.protocol === 'http:' ? http : https;
      const payload = body === null ? null : Buffer.isBuffer(body) ? body : Buffer.from(body);

      const req = lib.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (target.protocol === 'http:' ? 80 : 443),
          path: target.pathname + target.search,
          method,
          headers: {
            'User-Agent': 'MultiRejoinTool/2.0 (+node)',
            Accept: 'application/json, text/plain, */*',
            ...(payload ? { 'Content-Length': payload.length } : {}),
            ...headers,
          },
          timeout,
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const retryable = res.statusCode === 429 || res.statusCode >= 500;
            if (retryable && left > 0) {
              return setTimeout(
                () => attempt(left - 1).then(resolve, reject),
                retryDelay * (retries - left + 1)
              );
            }
            resolve({
              status: res.statusCode,
              ok: res.statusCode >= 200 && res.statusCode < 300,
              headers: res.headers,
              body: text,
              json() {
                try { return JSON.parse(text); } catch (_) { return null; }
              },
            });
          });
        }
      );

      req.on('timeout', () => req.destroy(new Error(`Hết thời gian chờ sau ${timeout}ms`)));
      req.on('error', (err) => {
        if (left > 0) {
          return setTimeout(
            () => attempt(left - 1).then(resolve, reject),
            retryDelay * (retries - left + 1)
          );
        }
        reject(err);
      });

      if (payload) req.write(payload);
      req.end();
    });

  return attempt(retries);
}

const getJSON = (url, opts = {}) => request(url, { ...opts, method: 'GET' });

const postJSON = (url, data, opts = {}) =>
  request(url, {
    ...opts,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: JSON.stringify(data),
  });

module.exports = { request, getJSON, postJSON };

};

/* ---------- module: core/Config ---------- */
__mods['core/Config'] = function(module, exports, require) {
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  version: 2,
  placeId: '',
  jobId: '',
  privateServerLink: '',
  rejoin: {
    enabled: true,
    intervalSeconds: 300,
    maxRetries: 5,
    retryDelaySeconds: 15,
    randomJitterSeconds: 10,
    stopOnFatal: true,
  },
  accounts: [],
  webhook: {
    enabled: false,
    url: '',
    username: 'MultiRejoinTool',
    avatarUrl: '',
    mentionOnError: '',
    events: {
      onStart: true,
      onRejoin: true,
      onError: true,
      onStop: true,
    },
  },
  screenshot: {
    enabled: false,
    directory: 'screenshots',
    onError: true,
    keepLast: 20,
  },
  autoexec: {
    enabled: false,
    directory: 'autoexec',
    scripts: [],
  },
  ui: {
    theme: 'round',
    color: true,
    refreshMs: 1000,
    showLogLines: 8,
  },
  logging: {
    level: 'info',
    file: 'logs/mrt.log',
  },
};

/** Deep merge: giá trị trong `override` ghi đè `base`, mảng thì thay nguyên cục. */
function merge(base, override) {
  if (Array.isArray(base)) return Array.isArray(override) ? override.slice() : base.slice();
  if (base === null || typeof base !== 'object') {
    return override === undefined ? base : override;
  }
  const out = {};
  for (const key of Object.keys(base)) {
    out[key] = merge(base[key], override ? override[key] : undefined);
  }
  // Giữ lại các khoá lạ do người dùng thêm tay
  if (override && typeof override === 'object' && !Array.isArray(override)) {
    for (const key of Object.keys(override)) {
      if (!(key in out)) out[key] = override[key];
    }
  }
  return out;
}

class Config {
  /** @param {string} filePath Đường dẫn file config JSON */
  constructor(filePath) {
    this.path = path.resolve(filePath);
    this.data = JSON.parse(JSON.stringify(DEFAULTS));
    this.loadedFromDisk = false;
    this.loadError = null;
  }

  static get defaults() {
    return JSON.parse(JSON.stringify(DEFAULTS));
  }

  load() {
    try {
      if (!fs.existsSync(this.path)) {
        this.loadedFromDisk = false;
        return this;
      }
      const raw = fs.readFileSync(this.path, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = merge(DEFAULTS, parsed);
      this.loadedFromDisk = true;
      this.loadError = null;
    } catch (err) {
      // Config hỏng -> KHÔNG crash, quay về mặc định và giữ lại lỗi để báo người dùng.
      this.loadError = err.message;
      this.data = JSON.parse(JSON.stringify(DEFAULTS));
      this.loadedFromDisk = false;
    }
    return this;
  }

  save() {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    // Ghi tạm rồi rename -> tránh hỏng file khi tool bị kill giữa chừng.
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, this.path);
    return this;
  }

  /** Lấy giá trị theo đường dẫn kiểu "webhook.events.onStart". */
  get(keyPath, fallback) {
    const parts = String(keyPath).split('.');
    let node = this.data;
    for (const part of parts) {
      if (node === null || typeof node !== 'object' || !(part in node)) return fallback;
      node = node[part];
    }
    return node === undefined ? fallback : node;
  }

  /** Đặt giá trị theo đường dẫn, tạo nhánh trung gian nếu thiếu. */
  set(keyPath, value) {
    const parts = String(keyPath).split('.');
    const last = parts.pop();
    let node = this.data;
    for (const part of parts) {
      if (node[part] === null || typeof node[part] !== 'object') node[part] = {};
      node = node[part];
    }
    node[last] = value;
    return this;
  }

  reset() {
    this.data = JSON.parse(JSON.stringify(DEFAULTS));
    return this;
  }

  /**
   * Kiểm tra config, trả về danh sách lỗi (rỗng = hợp lệ).
   * @returns {string[]}
   */
  validate() {
    const errors = [];
    const d = this.data;

    if (!d.placeId && !d.privateServerLink) {
      errors.push('Chưa đặt placeId hoặc privateServerLink.');
    }
    if (d.placeId && !/^\d+$/.test(String(d.placeId))) {
      errors.push('placeId phải là chuỗi số.');
    }
    if (!Array.isArray(d.accounts) || d.accounts.length === 0) {
      errors.push('Chưa có tài khoản nào (accounts rỗng).');
    }
    const interval = Number(d.rejoin.intervalSeconds);
    if (!Number.isFinite(interval) || interval < 10) {
      errors.push('rejoin.intervalSeconds phải >= 10.');
    }
    if (d.webhook.enabled && !/^https:\/\//i.test(d.webhook.url || '')) {
      errors.push('Webhook đang bật nhưng URL không hợp lệ (phải bắt đầu bằng https://).');
    }
    return errors;
  }
}

module.exports = Config;
module.exports.DEFAULTS = DEFAULTS;

};

/* ---------- module: core/CookieStore ---------- */
__mods['core/CookieStore'] = function(module, exports, require) {
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Lưu cookie (.ROBLOSECURITY) ở dạng mã hoá AES-256-GCM.
 * Khoá lấy từ biến môi trường MRT_KEY, nếu không có thì sinh khoá máy
 * và lưu vào .mrt-key (chmod 600).
 *
 * Lưu ý: đây là bảo vệ ở mức "không để lộ khi nhìn qua file", không phải
 * bảo mật chống kẻ tấn công đã chiếm được máy.
 */

const MAGIC = 'MRT1';

class CookieStore {
  constructor(filePath, keyPath) {
    this.path = path.resolve(filePath);
    this.keyPath = path.resolve(keyPath || path.join(path.dirname(this.path), '.mrt-key'));
    this.entries = new Map(); // alias -> cookie
  }

  _key() {
    if (process.env.MRT_KEY) {
      return crypto.createHash('sha256').update(process.env.MRT_KEY).digest();
    }
    try {
      if (fs.existsSync(this.keyPath)) {
        return Buffer.from(fs.readFileSync(this.keyPath, 'utf8').trim(), 'hex');
      }
    } catch (_) { /* rơi xuống nhánh tạo mới */ }

    const key = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(this.keyPath), { recursive: true });
    fs.writeFileSync(this.keyPath, key.toString('hex'), { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(this.keyPath, 0o600); } catch (_) { /* windows */ }
    return key;
  }

  _encrypt(plain) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this._key(), iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${MAGIC}.${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
  }

  _decrypt(payload) {
    const parts = String(payload).split('.');
    if (parts.length !== 4 || parts[0] !== MAGIC) {
      throw new Error('Định dạng cookie đã mã hoá không hợp lệ');
    }
    const [, iv, tag, data] = parts;
    const decipher = crypto.createDecipheriv('aes-256-gcm', this._key(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(data, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  load() {
    this.entries.clear();
    if (!fs.existsSync(this.path)) return this;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.path, 'utf8'));
    } catch (_) {
      return this;
    }
    for (const [alias, value] of Object.entries(raw || {})) {
      try {
        this.entries.set(alias, this._decrypt(value));
      } catch (_) {
        // Giải mã hỏng (đổi khoá / file lỗi) -> bỏ qua mục đó, không crash.
      }
    }
    return this;
  }

  save() {
    const out = {};
    for (const [alias, cookie] of this.entries) out[alias] = this._encrypt(cookie);
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.path);
    try { fs.chmodSync(this.path, 0o600); } catch (_) { /* windows */ }
    return this;
  }

  set(alias, cookie) {
    this.entries.set(alias, String(cookie).trim());
    return this;
  }

  get(alias) {
    return this.entries.get(alias) || null;
  }

  has(alias) {
    return this.entries.has(alias);
  }

  remove(alias) {
    return this.entries.delete(alias);
  }

  list() {
    return Array.from(this.entries.keys());
  }

  /** Che cookie khi in ra màn hình. */
  static mask(cookie) {
    if (!cookie) return '(trống)';
    const s = String(cookie);
    if (s.length <= 16) return '*'.repeat(s.length);
    return `${s.slice(0, 8)}${'*'.repeat(12)}${s.slice(-6)} (${s.length} ký tự)`;
  }

  /** Kiểm tra hình dạng cookie Roblox, KHÔNG gọi mạng. */
  static looksValid(cookie) {
    if (!cookie || typeof cookie !== 'string') return false;
    const s = cookie.trim();
    if (s.length < 100) return false;
    return s.includes('_|WARNING:-DO-NOT-SHARE-THIS.') || /^[A-Za-z0-9_\-|.:%+/=]+$/.test(s);
  }
}

module.exports = CookieStore;

};

/* ---------- module: core/RobloxUser ---------- */
__mods['core/RobloxUser'] = function(module, exports, require) {
'use strict';

const { request, getJSON } = require('utils/http');
const CookieStore = require('core/CookieStore');

/**
 * Đại diện cho một tài khoản Roblox trong tool.
 * Chỉ dùng các endpoint đọc công khai + endpoint xác thực chính chủ.
 */
class RobloxUser {
  /**
   * @param {object} opts
   * @param {string} opts.alias   Tên gợi nhớ do người dùng đặt
   * @param {string} [opts.cookie]
   * @param {object} [opts.logger]
   */
  constructor({ alias, cookie = '', logger = null }) {
    this.alias = alias;
    this.cookie = cookie;
    this.logger = logger;

    this.userId = null;
    this.username = null;
    this.displayName = null;
    this.verified = false;
    this.lastError = null;
    this.lastCheckedAt = null;
  }

  get headers() {
    return this.cookie ? { Cookie: `.ROBLOSECURITY=${this.cookie}` } : {};
  }

  get masked() {
    return CookieStore.mask(this.cookie);
  }

  /**
   * Xác thực cookie qua users.roblox.com/v1/users/authenticated.
   * @returns {Promise<boolean>}
   */
  async authenticate() {
    this.lastCheckedAt = new Date();
    if (!this.cookie) {
      this.lastError = 'Chưa có cookie';
      this.verified = false;
      return false;
    }
    try {
      const res = await request('https://users.roblox.com/v1/users/authenticated', {
        headers: this.headers,
        timeout: 12000,
        retries: 1,
      });
      if (res.status === 401) {
        this.lastError = 'Cookie hết hạn hoặc không hợp lệ (401)';
        this.verified = false;
        return false;
      }
      if (!res.ok) {
        this.lastError = `Roblox trả về HTTP ${res.status}`;
        this.verified = false;
        return false;
      }
      const data = res.json();
      if (!data || !data.id) {
        this.lastError = 'Phản hồi không đọc được';
        this.verified = false;
        return false;
      }
      this.userId = data.id;
      this.username = data.name;
      this.displayName = data.displayName || data.name;
      this.verified = true;
      this.lastError = null;
      return true;
    } catch (err) {
      this.lastError = err.message;
      this.verified = false;
      return false;
    }
  }

  /** Lấy thông tin hiển thị thêm (ngày tạo, mô tả). Không bắt buộc. */
  async fetchProfile() {
    if (!this.userId) return null;
    try {
      const res = await getJSON(`https://users.roblox.com/v1/users/${this.userId}`, { retries: 1 });
      return res.ok ? res.json() : null;
    } catch (_) {
      return null;
    }
  }

  /** Lấy trạng thái online / đang chơi game nào. Cần cookie hợp lệ. */
  async fetchPresence() {
    if (!this.userId || !this.cookie) return null;
    try {
      const res = await request('https://presence.roblox.com/v1/presence/users', {
        method: 'POST',
        headers: { ...this.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ userIds: [this.userId] }),
        timeout: 12000,
        retries: 1,
      });
      if (!res.ok) return null;
      const data = res.json();
      const entry = data && data.userPresences && data.userPresences[0];
      if (!entry) return null;
      return {
        type: ['Offline', 'Online', 'InGame', 'InStudio'][entry.userPresenceType] || 'Unknown',
        placeId: entry.placeId || null,
        gameId: entry.gameId || null,
        lastLocation: entry.lastLocation || '',
      };
    } catch (_) {
      return null;
    }
  }

  toJSON() {
    return {
      alias: this.alias,
      userId: this.userId,
      username: this.username,
      displayName: this.displayName,
      verified: this.verified,
      lastError: this.lastError,
    };
  }

  /** Dòng mô tả ngắn để in ra bảng. */
  summary() {
    if (this.verified) return `${this.displayName} (@${this.username}, id ${this.userId})`;
    return this.lastError ? `chưa xác thực — ${this.lastError}` : 'chưa xác thực';
  }
}

module.exports = RobloxUser;

};

/* ---------- module: core/GameSelector ---------- */
__mods['core/GameSelector'] = function(module, exports, require) {
'use strict';

const { getJSON } = require('utils/http');

/**
 * Xử lý mọi thứ liên quan tới "vào game nào":
 *  - phân tích link Roblox / private server
 *  - tra tên game từ placeId
 *  - dựng deep link roblox://
 */
class GameSelector {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.cache = new Map(); // placeId -> thông tin game
  }

  /**
   * Bóc placeId / jobId / linkCode từ một URL Roblox bất kỳ.
   * Hỗ trợ:
   *   https://www.roblox.com/games/1234567/Ten-Game
   *   https://www.roblox.com/games/1234567/X?privateServerLinkCode=abc
   *   https://www.roblox.com/share?code=...&type=Server
   * @returns {{placeId:string|null, jobId:string|null, linkCode:string|null}}
   */
  static parseLink(input) {
    const result = { placeId: null, jobId: null, linkCode: null };
    if (!input) return result;
    const text = String(input).trim();

    // Chỉ nhập số -> coi là placeId
    if (/^\d+$/.test(text)) {
      result.placeId = text;
      return result;
    }

    const place = text.match(/\/games\/(\d+)/);
    if (place) result.placeId = place[1];

    const code = text.match(/privateServerLinkCode=([A-Za-z0-9_-]+)/i);
    if (code) result.linkCode = code[1];

    const job = text.match(/[?&]gameInstanceId=([A-Za-z0-9-]+)/i);
    if (job) result.jobId = job[1];

    const share = text.match(/[?&]code=([A-Za-z0-9_-]+)/i);
    if (share && !result.linkCode) result.linkCode = share[1];

    return result;
  }

  /**
   * Lấy thông tin game công khai từ placeId.
   * @returns {Promise<{placeId:string,name:string,creator:string,playing:number|null}|null>}
   */
  async fetchGameInfo(placeId) {
    const id = String(placeId);
    if (this.cache.has(id)) return this.cache.get(id);

    try {
      const res = await getJSON(
        `https://games.roblox.com/v1/games/multiget-place-details?placeIds=${id}`,
        { retries: 1 }
      );
      let info = null;

      if (res.ok) {
        const list = res.json();
        if (Array.isArray(list) && list[0]) {
          info = {
            placeId: id,
            name: list[0].name,
            creator: list[0].builder || 'không rõ',
            universeId: list[0].universeId || null,
            playing: null,
          };
        }
      }

      // Endpoint trên cần cookie ở một số trường hợp -> phương án dự phòng.
      if (!info) {
        const alt = await getJSON(`https://apis.roblox.com/universes/v1/places/${id}/universe`, {
          retries: 1,
        });
        const universeId = alt.ok && alt.json() ? alt.json().universeId : null;
        if (universeId) {
          const g = await getJSON(`https://games.roblox.com/v1/games?universeIds=${universeId}`, {
            retries: 1,
          });
          const entry = g.ok && g.json() && g.json().data && g.json().data[0];
          if (entry) {
            info = {
              placeId: id,
              name: entry.name,
              creator: (entry.creator && entry.creator.name) || 'không rõ',
              universeId,
              playing: entry.playing != null ? entry.playing : null,
            };
          }
        }
      }

      if (info) this.cache.set(id, info);
      return info;
    } catch (err) {
      if (this.logger) this.logger.debug(`Không lấy được thông tin game ${id}: ${err.message}`);
      return null;
    }
  }

  /** Mục tiêu hiện tại theo config. */
  currentTarget() {
    const placeId = this.config.get('placeId', '');
    const jobId = this.config.get('jobId', '');
    const link = this.config.get('privateServerLink', '');
    return { placeId, jobId, link };
  }

  /**
   * Dựng deep link để mở Roblox client.
   * @returns {string|null}
   */
  buildLaunchUrl() {
    const { placeId, jobId, link } = this.currentTarget();

    if (link) {
      const parsed = GameSelector.parseLink(link);
      if (parsed.linkCode && (parsed.placeId || placeId)) {
        return `roblox://placeId=${parsed.placeId || placeId}&linkCode=${parsed.linkCode}`;
      }
      return link; // để hệ điều hành tự mở bằng trình duyệt
    }

    if (!placeId) return null;
    if (jobId) return `roblox://placeId=${placeId}&gameInstanceId=${jobId}`;
    return `roblox://placeId=${placeId}`;
  }

  /** Chuỗi mô tả mục tiêu để hiển thị. */
  describe(info) {
    const { placeId, jobId, link } = this.currentTarget();
    if (link) return `Private server (${link.slice(0, 48)}…)`;
    if (!placeId) return 'chưa đặt';
    const name = info && info.name ? info.name : `place ${placeId}`;
    return jobId ? `${name} · job ${jobId.slice(0, 8)}…` : name;
  }

  /** Đặt mục tiêu mới từ chuỗi người dùng nhập. Trả về mô tả kết quả. */
  applyInput(input) {
    const parsed = GameSelector.parseLink(input);
    if (!parsed.placeId && !parsed.linkCode) {
      return { ok: false, message: 'Không nhận ra placeId hay link private server.' };
    }
    if (parsed.placeId) this.config.set('placeId', parsed.placeId);
    if (parsed.jobId) this.config.set('jobId', parsed.jobId);
    if (parsed.linkCode) this.config.set('privateServerLink', String(input).trim());
    return { ok: true, message: 'Đã cập nhật mục tiêu.', parsed };
  }
}

module.exports = GameSelector;

};

/* ---------- module: core/StatusHandler ---------- */
__mods['core/StatusHandler'] = function(module, exports, require) {
'use strict';

/**
 * Máy trạng thái cho từng tài khoản trong vòng lặp rejoin.
 *
 * Sơ đồ chuyển trạng thái:
 *   idle -> launching -> joined -> waiting -> launching ...
 *   bất kỳ -> error -> (retry) launching | (quá số lần) fatal
 *   bất kỳ -> stopped
 */

const STATES = {
  IDLE: 'idle',
  LAUNCHING: 'launching',
  JOINED: 'joined',
  WAITING: 'waiting',
  ERROR: 'error',
  FATAL: 'fatal',
  STOPPED: 'stopped',
};

const LABELS = {
  idle: 'Chờ',
  launching: 'Đang vào',
  joined: 'Đã vào',
  waiting: 'Chờ lượt sau',
  error: 'Lỗi',
  fatal: 'Dừng hẳn',
  stopped: 'Đã dừng',
};

const ALLOWED = {
  idle: ['launching', 'stopped'],
  launching: ['joined', 'error', 'stopped'],
  joined: ['waiting', 'error', 'stopped'],
  waiting: ['launching', 'error', 'stopped'],
  error: ['launching', 'fatal', 'stopped', 'waiting'],
  fatal: ['stopped', 'launching'],
  stopped: ['idle', 'launching'],
};

class StatusHandler {
  /**
   * @param {object} opts
   * @param {string} opts.alias
   * @param {number} [opts.maxRetries]
   * @param {object} [opts.logger]
   * @param {Function} [opts.onChange] callback(alias, from, to, meta)
   */
  constructor({ alias, maxRetries = 5, logger = null, onChange = null }) {
    this.alias = alias;
    this.maxRetries = maxRetries;
    this.logger = logger;
    this.onChange = onChange;

    this.state = STATES.IDLE;
    this.previousState = null;
    this.retries = 0;
    this.rejoinCount = 0;
    this.errorCount = 0;
    this.lastError = null;
    this.startedAt = null;
    this.changedAt = Date.now();
    this.history = [];
  }

  static get STATES() { return STATES; }
  static label(state) { return LABELS[state] || state; }

  canTransition(next) {
    return (ALLOWED[this.state] || []).includes(next);
  }

  /**
   * Chuyển trạng thái. Trả về false nếu bước chuyển không hợp lệ.
   * @param {string} next
   * @param {object} [meta]
   */
  transition(next, meta = {}) {
    if (next === this.state) return true;
    if (!this.canTransition(next)) {
      if (this.logger) {
        this.logger.debug(`[${this.alias}] bỏ qua chuyển trạng thái ${this.state} -> ${next}`);
      }
      return false;
    }

    const from = this.state;
    this.previousState = from;
    this.state = next;
    this.changedAt = Date.now();
    this.history.push({ from, to: next, at: this.changedAt, meta });
    if (this.history.length > 100) this.history.shift();

    if (next === STATES.JOINED) {
      this.rejoinCount += 1;
      this.retries = 0;
      this.lastError = null;
      if (!this.startedAt) this.startedAt = Date.now();
    }
    if (next === STATES.ERROR) {
      this.errorCount += 1;
      this.retries += 1;
      this.lastError = meta.error || 'không rõ nguyên nhân';
    }
    if (next === STATES.STOPPED || next === STATES.FATAL) {
      this.startedAt = null;
    }

    if (this.onChange) {
      try { this.onChange(this.alias, from, next, meta); } catch (_) { /* callback lỗi thì kệ */ }
    }
    return true;
  }

  /**
   * Ghi nhận một lỗi. Tự chuyển sang FATAL nếu vượt maxRetries.
   * @returns {'retry'|'fatal'}
   */
  recordError(message) {
    this.transition(STATES.ERROR, { error: message });
    if (this.retries >= this.maxRetries) {
      this.transition(STATES.FATAL, { error: message });
      return 'fatal';
    }
    return 'retry';
  }

  reset() {
    this.state = STATES.IDLE;
    this.retries = 0;
    this.lastError = null;
    this.changedAt = Date.now();
    return this;
  }

  /** Thời gian ở trạng thái hiện tại (giây). */
  get elapsedSeconds() {
    return Math.floor((Date.now() - this.changedAt) / 1000);
  }

  get isActive() {
    return ![STATES.STOPPED, STATES.FATAL].includes(this.state);
  }

  snapshot() {
    return {
      alias: this.alias,
      state: this.state,
      label: StatusHandler.label(this.state),
      retries: this.retries,
      rejoinCount: this.rejoinCount,
      errorCount: this.errorCount,
      lastError: this.lastError,
      elapsedSeconds: this.elapsedSeconds,
    };
  }
}

// LƯU Ý: class đã có `static get STATES()` nên KHÔNG được gán
// `module.exports.STATES = ...` (sẽ ném TypeError vì thuộc tính chỉ có getter).
// Dùng defineProperty cho các thuộc tính phụ để an toàn.
module.exports = StatusHandler;
Object.defineProperty(module.exports, 'LABELS', {
  value: LABELS,
  enumerable: true,
});

};

/* ---------- module: core/WebhookManager ---------- */
__mods['core/WebhookManager'] = function(module, exports, require) {
'use strict';

const { request } = require('utils/http');

const COLORS = {
  info: 0x3498db,
  success: 0x2ecc71,
  warn: 0xf1c40f,
  error: 0xe74c3c,
  neutral: 0x95a5a6,
};

/**
 * Gửi thông báo lên Discord webhook.
 * Có hàng đợi + tôn trọng rate limit 429 (retry_after) để không bị Discord chặn.
 */
class WebhookManager {
  /**
   * @param {object} config  Nhánh `webhook` trong Config
   * @param {object} logger
   */
  constructor(config, logger) {
    this.config = config || {};
    this.logger = logger;
    this.queue = [];
    this.sending = false;
    this.sentCount = 0;
    this.failCount = 0;
  }

  get enabled() {
    return Boolean(this.config.enabled && this.config.url);
  }

  /** Kiểm tra loại sự kiện này có được bật không. */
  allows(event) {
    if (!this.enabled) return false;
    const events = this.config.events || {};
    return events[event] !== false;
  }

  /**
   * Đẩy một embed vào hàng đợi.
   * @param {object} opts
   * @param {string} opts.title
   * @param {string} [opts.description]
   * @param {Array<{name:string,value:string,inline?:boolean}>} [opts.fields]
   * @param {string} [opts.level] info|success|warn|error|neutral
   */
  send({ title, description = '', fields = [], level = 'info', footer = 'MultiRejoinTool' }) {
    if (!this.enabled) return;

    const embed = {
      title: String(title).slice(0, 256),
      description: String(description).slice(0, 4096),
      color: COLORS[level] || COLORS.info,
      timestamp: new Date().toISOString(),
      footer: { text: footer },
      fields: fields.slice(0, 25).map((f) => ({
        name: String(f.name).slice(0, 256),
        value: String(f.value).slice(0, 1024) || '\u200b',
        inline: Boolean(f.inline),
      })),
    };

    const payload = {
      username: this.config.username || 'MultiRejoinTool',
      embeds: [embed],
    };
    if (this.config.avatarUrl) payload.avatar_url = this.config.avatarUrl;
    if (level === 'error' && this.config.mentionOnError) {
      payload.content = this.config.mentionOnError;
    }

    this.queue.push(payload);
    this._drain();
  }

  async _drain() {
    if (this.sending) return;
    this.sending = true;

    while (this.queue.length) {
      const payload = this.queue.shift();
      try {
        const res = await request(this.config.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          timeout: 12000,
        });

        if (res.status === 429) {
          const data = res.json();
          const waitMs = Math.ceil(((data && data.retry_after) || 1) * 1000) + 250;
          this.queue.unshift(payload); // trả lại hàng đợi, thử lại sau
          await sleep(waitMs);
          continue;
        }

        if (res.ok || res.status === 204) {
          this.sentCount += 1;
        } else {
          this.failCount += 1;
          if (this.logger) this.logger.warn(`Webhook lỗi HTTP ${res.status}`);
        }
      } catch (err) {
        this.failCount += 1;
        // Webhook hỏng KHÔNG được làm chết vòng lặp rejoin.
        if (this.logger) this.logger.warn(`Không gửi được webhook: ${err.message}`);
      }
      await sleep(400); // giãn nhịp cho an toàn
    }

    this.sending = false;
  }

  /** Gửi thử để người dùng kiểm tra URL. Trả về true/false. */
  async test() {
    if (!this.config.url) return { ok: false, message: 'Chưa đặt URL webhook.' };
    try {
      const res = await request(this.config.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: this.config.username || 'MultiRejoinTool',
          embeds: [
            {
              title: '✅ Webhook hoạt động',
              description: 'Đây là tin nhắn thử từ MultiRejoinTool.',
              color: COLORS.success,
              timestamp: new Date().toISOString(),
            },
          ],
        }),
        timeout: 12000,
      });
      if (res.ok || res.status === 204) return { ok: true, message: 'Đã gửi tin nhắn thử.' };
      return { ok: false, message: `Discord trả về HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  /** Chờ hàng đợi rỗng (dùng khi thoát tool). */
  async flush(timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while ((this.queue.length || this.sending) && Date.now() < deadline) {
      await sleep(200);
    }
  }

  stats() {
    return { sent: this.sentCount, failed: this.failCount, pending: this.queue.length };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = WebhookManager;
module.exports.COLORS = COLORS;

};

/* ---------- module: core/ScreenshotManager ---------- */
__mods['core/ScreenshotManager'] = function(module, exports, require) {
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

/**
 * Chụp màn hình bằng công cụ có sẵn của hệ điều hành.
 * KHÔNG cài thêm package. Nếu không có công cụ nào -> báo lỗi mềm, tool vẫn chạy.
 *
 *  macOS   : screencapture
 *  Windows : PowerShell + System.Drawing
 *  Linux   : gnome-screenshot | scrot | import (ImageMagick) | spectacle
 */
class ScreenshotManager {
  constructor(config, logger) {
    this.config = config || {};
    this.logger = logger;
    this.dir = path.resolve(this.config.directory || 'screenshots');
    this.lastPath = null;
    this.count = 0;
  }

  get enabled() {
    return Boolean(this.config.enabled);
  }

  ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  filename(tag = 'shot') {
    const safe = String(tag).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(this.dir, `${stamp}_${safe}.png`);
  }

  /**
   * Chụp một tấm.
   * @param {string} tag Nhãn gắn vào tên file
   * @returns {Promise<{ok:boolean, file?:string, message?:string}>}
   */
  async capture(tag = 'shot') {
    if (!this.enabled) return { ok: false, message: 'Chức năng screenshot đang tắt.' };

    this.ensureDir();
    const target = this.filename(tag);
    const platform = process.platform;

    try {
      if (platform === 'darwin') {
        await run('screencapture', ['-x', target]);
      } else if (platform === 'win32') {
        await run('powershell', [
          '-NoProfile',
          '-Command',
          `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; ` +
            `$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; ` +
            `$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; ` +
            `$g=[System.Drawing.Graphics]::FromImage($bmp); ` +
            `$g.CopyFromScreen($b.X,$b.Y,0,0,$bmp.Size); ` +
            `$bmp.Save('${target.replace(/'/g, "''")}');`,
        ]);
      } else {
        const tool = await firstAvailable([
          ['gnome-screenshot', ['-f', target]],
          ['scrot', [target]],
          ['import', ['-window', 'root', target]],
          ['spectacle', ['-b', '-n', '-o', target]],
        ]);
        if (!tool) {
          return {
            ok: false,
            message: 'Không tìm thấy công cụ chụp màn hình (gnome-screenshot/scrot/import).',
          };
        }
        await run(tool[0], tool[1]);
      }

      if (!fs.existsSync(target)) {
        return { ok: false, message: 'Lệnh chạy xong nhưng không tạo được file.' };
      }

      this.lastPath = target;
      this.count += 1;
      this.prune();
      if (this.logger) this.logger.debug(`Đã lưu ảnh: ${target}`);
      return { ok: true, file: target };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  /** Xoá ảnh cũ, chỉ giữ lại N tấm gần nhất. */
  prune() {
    const keep = Number(this.config.keepLast) || 0;
    if (keep <= 0) return;
    try {
      const files = fs
        .readdirSync(this.dir)
        .filter((f) => f.endsWith('.png'))
        .map((f) => ({ f, t: fs.statSync(path.join(this.dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      for (const entry of files.slice(keep)) {
        fs.unlinkSync(path.join(this.dir, entry.f));
      }
    } catch (_) { /* dọn dẹp lỗi thì bỏ qua */ }
  }

  list() {
    try {
      return fs.readdirSync(this.dir).filter((f) => f.endsWith('.png')).sort().reverse();
    } catch (_) {
      return [];
    }
  }
}

function run(cmd, args, timeout = 20000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${cmd}: ${(stderr || err.message).trim()}`));
      resolve(String(stdout));
    });
  });
}

async function firstAvailable(candidates) {
  for (const candidate of candidates) {
    const exists = await new Promise((resolve) => {
      execFile('which', [candidate[0]], (err, stdout) => resolve(!err && Boolean(stdout.trim())));
    });
    if (exists) return candidate;
  }
  return null;
}

module.exports = ScreenshotManager;

};

/* ---------- module: core/AutoexecManager ---------- */
__mods['core/AutoexecManager'] = function(module, exports, require) {
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Quản lý thư mục autoexec: liệt kê, bật/tắt, xem, thêm, xoá script .lua/.txt.
 * Tool CHỈ quản lý file — không nhúng, không thực thi script.
 */
class AutoexecManager {
  constructor(config, logger) {
    this.config = config || {};
    this.logger = logger;
    this.dir = path.resolve(this.config.directory || 'autoexec');
  }

  get enabled() {
    return Boolean(this.config.enabled);
  }

  ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true });
    return this.dir;
  }

  /**
   * Quét thư mục.
   * @returns {Array<{name:string, file:string, size:number, enabled:boolean, modified:Date}>}
   */
  scan() {
    if (!fs.existsSync(this.dir)) return [];
    const allowed = new Set(['.lua', '.txt', '.luau']);
    const disabledList = new Set(this.config.disabled || []);

    return fs
      .readdirSync(this.dir)
      .filter((f) => allowed.has(path.extname(f).toLowerCase()))
      .map((f) => {
        const full = path.join(this.dir, f);
        const stat = fs.statSync(full);
        return {
          name: f,
          file: full,
          size: stat.size,
          modified: stat.mtime,
          enabled: !disabledList.has(f) && !f.startsWith('_'),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Đọc nội dung một script (giới hạn số dòng để không tràn màn hình). */
  read(name, maxLines = 60) {
    const full = this.resolve(name);
    if (!full) return null;
    const text = fs.readFileSync(full, 'utf8');
    const lines = text.split('\n');
    return {
      name,
      totalLines: lines.length,
      truncated: lines.length > maxLines,
      preview: lines.slice(0, maxLines).join('\n'),
    };
  }

  /** Đổi tên có/không có tiền tố "_" để bật/tắt script. */
  toggle(name) {
    const full = this.resolve(name);
    if (!full) return { ok: false, message: 'Không tìm thấy script.' };
    const base = path.basename(full);
    const dir = path.dirname(full);
    const next = base.startsWith('_') ? base.slice(1) : `_${base}`;
    try {
      fs.renameSync(full, path.join(dir, next));
      return { ok: true, message: `${base} -> ${next}`, enabled: !next.startsWith('_') };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  /** Tạo script mới từ nội dung nhập tay. */
  create(name, content) {
    this.ensureDir();
    let safe = String(name).replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!/\.(lua|luau|txt)$/i.test(safe)) safe += '.lua';
    const full = path.join(this.dir, safe);
    if (fs.existsSync(full)) return { ok: false, message: 'File đã tồn tại.' };
    fs.writeFileSync(full, String(content), 'utf8');
    return { ok: true, message: `Đã tạo ${safe}`, file: full };
  }

  /** Xoá script (chuyển sang .bak thay vì xoá hẳn cho an toàn). */
  remove(name) {
    const full = this.resolve(name);
    if (!full) return { ok: false, message: 'Không tìm thấy script.' };
    const backup = `${full}.bak`;
    try {
      fs.renameSync(full, backup);
      return { ok: true, message: `Đã chuyển thành ${path.basename(backup)}` };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  /** Tìm đường dẫn đầy đủ theo tên hoặc số thứ tự. */
  resolve(nameOrIndex) {
    const items = this.scan();
    if (/^\d+$/.test(String(nameOrIndex))) {
      const item = items[Number(nameOrIndex) - 1];
      return item ? item.file : null;
    }
    const found = items.find(
      (i) => i.name === nameOrIndex || i.name.replace(/^_/, '') === nameOrIndex
    );
    return found ? found.file : null;
  }

  stats() {
    const items = this.scan();
    return {
      total: items.length,
      enabled: items.filter((i) => i.enabled).length,
      directory: this.dir,
    };
  }
}

module.exports = AutoexecManager;

};

/* ---------- module: ui/UIRenderer ---------- */
__mods['ui/UIRenderer'] = function(module, exports, require) {
'use strict';

const c = require('utils/colors');
const box = require('utils/box');
const StatusHandler = require('core/StatusHandler');

const STATE_COLOR = {
  idle: c.gray,
  launching: c.cyan,
  joined: c.green,
  waiting: c.blue,
  error: c.yellow,
  fatal: c.red,
  stopped: c.gray,
};

const STATE_ICON = {
  idle: '○',
  launching: '◐',
  joined: '●',
  waiting: '◔',
  error: '▲',
  fatal: '✗',
  stopped: '■',
};

/** Vẽ toàn bộ giao diện CLI. */
class UIRenderer {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.theme = (config && config.get && config.get('ui.theme')) || 'round';
  }

  clear() {
    if (process.stdout.isTTY) process.stdout.write('\u001b[2J\u001b[H');
  }

  banner(version = '2.0.0') {
    const art = [
      '███╗   ███╗██████╗ ████████╗',
      '████╗ ████║██╔══██╗╚══██╔══╝',
      '██╔████╔██║██████╔╝   ██║   ',
      '██║╚██╔╝██║██╔══██╗   ██║   ',
      '██║ ╚═╝ ██║██║  ██║   ██║   ',
      '╚═╝     ╚═╝╚═╝  ╚═╝   ╚═╝   ',
    ];
    const lines = art.map((l) => c.cyan(l));
    lines.push('');
    lines.push(c.bold('Multi Rejoin Tool') + c.gray(`  v${version}`));
    lines.push(c.gray('Zero dependency · CommonJS · Node >= 16'));
    return box(lines, { style: this.theme, color: c.cyan, align: 'center', padding: 2 });
  }

  /** Khối tóm tắt cấu hình hiện tại. */
  overview({ target, accounts, rejoin, webhook, screenshot, autoexec }) {
    const on = (v) => (v ? c.green('BẬT') : c.gray('TẮT'));
    const lines = [
      `${c.gray('Mục tiêu   :')} ${c.white(target || 'chưa đặt')}`,
      `${c.gray('Tài khoản  :')} ${c.white(`${accounts.verified}/${accounts.total} đã xác thực`)}`,
      `${c.gray('Chu kỳ     :')} ${c.white(`${rejoin.intervalSeconds}s`)}${c.gray(
        `  · thử lại tối đa ${rejoin.maxRetries}`
      )}`,
      `${c.gray('Webhook    :')} ${on(webhook)}`,
      `${c.gray('Screenshot :')} ${on(screenshot)}`,
      `${c.gray('Autoexec   :')} ${on(autoexec)}`,
    ];
    return box(lines, { title: 'Cấu hình', style: this.theme, color: c.blue });
  }

  /** Bảng trạng thái các tài khoản khi đang chạy. */
  statusTable(snapshots) {
    if (!snapshots.length) {
      return box([c.gray('Chưa có tài khoản nào.')], { title: 'Trạng thái', style: this.theme });
    }

    const wAlias = Math.max(10, ...snapshots.map((s) => c.width(s.alias)));
    const header =
      c.gray(c.padEnd('TÀI KHOẢN', wAlias)) +
      c.gray('  ') +
      c.gray(c.padEnd('TRẠNG THÁI', 14)) +
      c.gray(c.padStart('LẦN VÀO', 9)) +
      c.gray(c.padStart('LỖI', 6)) +
      c.gray('  THỜI GIAN');

    const rows = snapshots.map((s) => {
      const color = STATE_COLOR[s.state] || c.white;
      const icon = STATE_ICON[s.state] || '·';
      return (
        c.white(c.padEnd(s.alias, wAlias)) +
        '  ' +
        color(c.padEnd(`${icon} ${s.label}`, 14)) +
        c.white(c.padStart(String(s.rejoinCount), 9)) +
        (s.errorCount ? c.yellow : c.gray)(c.padStart(String(s.errorCount), 6)) +
        c.gray(`  ${formatDuration(s.elapsedSeconds)}`)
      );
    });

    return box([header, ...rows], {
      title: 'Trạng thái',
      style: this.theme,
      color: c.cyan,
      dividers: [1],
    });
  }

  /** Khối log gần nhất. */
  logPanel(entries) {
    const lines = entries.length
      ? entries.map((e) => `${c.gray(e.time)} ${levelColor(e.level)(e.message)}`)
      : [c.gray('(chưa có log)')];
    return box(lines, { title: 'Nhật ký', style: this.theme, color: c.gray });
  }

  /** Menu chính. */
  mainMenu(items) {
    const lines = items.map((item, i) => {
      if (item.separator) return c.gray('─'.repeat(30));
      const key = c.cyan(String(item.key ?? i + 1).padStart(2, ' '));
      const hint = item.hint ? c.gray(`  — ${item.hint}`) : '';
      return `${key}. ${c.white(item.label)}${hint}`;
    });
    return box(lines, { title: 'Menu chính', style: this.theme, color: c.magenta });
  }

  /** Bảng kết quả tổng kết khi dừng. */
  summary(stats) {
    const lines = [
      `${c.gray('Tổng lượt rejoin :')} ${c.green(stats.totalRejoins)}`,
      `${c.gray('Tổng lỗi         :')} ${stats.totalErrors ? c.yellow(stats.totalErrors) : c.green(0)}`,
      `${c.gray('Thời gian chạy   :')} ${c.white(formatDuration(stats.uptimeSeconds))}`,
      `${c.gray('Webhook đã gửi   :')} ${c.white(stats.webhookSent)}`,
    ];
    return box(lines, { title: 'Tổng kết', style: this.theme, color: c.green });
  }

  info(msg) { process.stdout.write(`${c.cyan('ℹ')} ${msg}\n`); }
  ok(msg) { process.stdout.write(`${c.green('✓')} ${msg}\n`); }
  warn(msg) { process.stdout.write(`${c.yellow('!')} ${msg}\n`); }
  fail(msg) { process.stdout.write(`${c.red('✗')} ${msg}\n`); }
  blank() { process.stdout.write('\n'); }
  print(text) { process.stdout.write(`${text}\n`); }
}

function levelColor(level) {
  return { error: c.red, warn: c.yellow, success: c.green, debug: c.gray }[level] || c.white;
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m ${sec}s`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

module.exports = UIRenderer;
module.exports.formatDuration = formatDuration;
module.exports.STATE_COLOR = STATE_COLOR;
module.exports.STATES = StatusHandler.STATES;

};

/* ---------- module: ui/ConfigEditor ---------- */
__mods['ui/ConfigEditor'] = function(module, exports, require) {
'use strict';

const c = require('utils/colors');
const CookieStore = require('core/CookieStore');
const GameSelector = require('core/GameSelector');

/**
 * Menu chỉnh sửa cấu hình tương tác.
 * Mọi thay đổi đều ghi xuống đĩa ngay để không mất khi tool bị kill.
 */
class ConfigEditor {
  /**
   * @param {object} deps
   * @param {import('../core/Config')} deps.config
   * @param {import('../core/CookieStore')} deps.cookies
   * @param {import('../utils/prompt')} deps.prompt
   * @param {import('./UIRenderer')} deps.ui
   * @param {object} deps.logger
   */
  constructor({ config, cookies, prompt, ui, logger }) {
    this.config = config;
    this.cookies = cookies;
    this.prompt = prompt;
    this.ui = ui;
    this.logger = logger;
  }

  /** Vòng lặp menu cấu hình. Trả về khi người dùng chọn Quay lại / EOF. */
  async run() {
    for (;;) {
      this.ui.blank();
      this.ui.print(
        this.ui.mainMenu([
          { key: 1, label: 'Mục tiêu game', hint: 'placeId / jobId / private server' },
          { key: 2, label: 'Quản lý tài khoản', hint: 'thêm, xoá, xác thực cookie' },
          { key: 3, label: 'Thiết lập rejoin', hint: 'chu kỳ, số lần thử lại' },
          { key: 4, label: 'Webhook Discord', hint: 'bật/tắt, URL, gửi thử' },
          { key: 5, label: 'Screenshot' },
          { key: 6, label: 'Autoexec' },
          { key: 7, label: 'Giao diện & nhật ký' },
          { key: 8, label: c.yellow('Đặt lại toàn bộ về mặc định') },
          { key: 0, label: c.gray('Quay lại') },
        ])
      );

      const choice = await this.prompt.ask('Chọn mục');
      if (choice === null || choice === '0') return;

      switch (choice) {
        case '1': await this.editTarget(); break;
        case '2': await this.editAccounts(); break;
        case '3': await this.editRejoin(); break;
        case '4': await this.editWebhook(); break;
        case '5': await this.editScreenshot(); break;
        case '6': await this.editAutoexec(); break;
        case '7': await this.editUI(); break;
        case '8': await this.resetAll(); break;
        default: this.ui.warn('Lựa chọn không hợp lệ.');
      }
    }
  }

  _save() {
    try {
      this.config.save();
      this.ui.ok('Đã lưu cấu hình.');
    } catch (err) {
      this.ui.fail(`Không lưu được: ${err.message}`);
    }
  }

  async editTarget() {
    const current = this.config.get('placeId') || '(chưa đặt)';
    this.ui.info(`placeId hiện tại: ${c.white(current)}`);
    this.ui.info('Có thể dán nguyên link Roblox, hoặc chỉ nhập số placeId.');

    const input = await this.prompt.ask('Link hoặc placeId (Enter để bỏ qua)');
    if (input === null) return;
    if (input) {
      const selector = new GameSelector(this.config, this.logger);
      const result = selector.applyInput(input);
      result.ok ? this.ui.ok(result.message) : this.ui.fail(result.message);
    }

    const job = await this.prompt.ask('jobId cụ thể (Enter = bỏ trống)', {
      default: this.config.get('jobId') || '',
    });
    if (job !== null) this.config.set('jobId', job.trim());

    this._save();
  }

  async editAccounts() {
    for (;;) {
      const accounts = this.config.get('accounts', []);
      this.ui.blank();
      if (!accounts.length) {
        this.ui.warn('Chưa có tài khoản nào.');
      } else {
        accounts.forEach((acc, i) => {
          const cookie = this.cookies.get(acc.alias);
          const state = cookie ? c.green('có cookie') : c.red('thiếu cookie');
          this.ui.print(`  ${c.cyan(String(i + 1).padStart(2))}. ${c.white(acc.alias)}  ${state}`);
        });
      }

      const action = await this.prompt.select('Tài khoản', [
        { label: 'Thêm tài khoản', value: 'add' },
        { label: 'Xoá tài khoản', value: 'del' },
        { label: 'Cập nhật cookie', value: 'cookie' },
        { label: c.gray('Quay lại'), value: 'back' },
      ]);
      if (action === null || action === 'back') return;

      if (action === 'add') {
        const alias = await this.prompt.ask('Tên gợi nhớ (vd: main, alt1)');
        if (!alias) continue;
        if (accounts.some((a) => a.alias === alias)) {
          this.ui.fail('Tên này đã tồn tại.');
          continue;
        }
        const cookie = await this.prompt.ask('Dán .ROBLOSECURITY (Enter = thêm sau)');
        accounts.push({ alias, enabled: true });
        this.config.set('accounts', accounts);
        if (cookie) {
          if (!CookieStore.looksValid(cookie)) {
            this.ui.warn('Cookie trông không giống định dạng chuẩn — vẫn lưu, nhớ kiểm tra lại.');
          }
          this.cookies.set(alias, cookie).save();
          this.ui.ok(`Đã lưu cookie (${CookieStore.mask(cookie)})`);
        }
        this._save();
      }

      if (action === 'del') {
        const idx = await this.prompt.askNumber('Số thứ tự cần xoá', { min: 1, max: accounts.length });
        if (idx === null) continue;
        const [removed] = accounts.splice(idx - 1, 1);
        this.config.set('accounts', accounts);
        this.cookies.remove(removed.alias);
        this.cookies.save();
        this._save();
        this.ui.ok(`Đã xoá ${removed.alias}.`);
      }

      if (action === 'cookie') {
        const idx = await this.prompt.askNumber('Số thứ tự cần cập nhật', {
          min: 1,
          max: accounts.length,
        });
        if (idx === null) continue;
        const alias = accounts[idx - 1].alias;
        const cookie = await this.prompt.ask(`Cookie mới cho ${alias}`);
        if (!cookie) continue;
        this.cookies.set(alias, cookie).save();
        this.ui.ok(`Đã cập nhật (${CookieStore.mask(cookie)})`);
      }
    }
  }

  async editRejoin() {
    const r = this.config.get('rejoin');
    const interval = await this.prompt.askNumber('Chu kỳ rejoin (giây, >= 10)', {
      min: 10,
      max: 86400,
      default: r.intervalSeconds,
    });
    if (interval !== null) this.config.set('rejoin.intervalSeconds', interval);

    const retries = await this.prompt.askNumber('Số lần thử lại tối đa', {
      min: 0,
      max: 50,
      default: r.maxRetries,
    });
    if (retries !== null) this.config.set('rejoin.maxRetries', retries);

    const delay = await this.prompt.askNumber('Chờ bao lâu trước khi thử lại (giây)', {
      min: 1,
      max: 600,
      default: r.retryDelaySeconds,
    });
    if (delay !== null) this.config.set('rejoin.retryDelaySeconds', delay);

    const jitter = await this.prompt.askNumber('Độ lệch ngẫu nhiên (giây, 0 = tắt)', {
      min: 0,
      max: 120,
      default: r.randomJitterSeconds,
    });
    if (jitter !== null) this.config.set('rejoin.randomJitterSeconds', jitter);

    this._save();
  }

  async editWebhook() {
    const enabled = await this.prompt.confirm('Bật webhook Discord?', this.config.get('webhook.enabled'));
    if (enabled === null) return;
    this.config.set('webhook.enabled', enabled);

    if (enabled) {
      const url = await this.prompt.ask('URL webhook', {
        default: this.config.get('webhook.url') || '',
      });
      if (url !== null) this.config.set('webhook.url', url.trim());

      const name = await this.prompt.ask('Tên hiển thị', {
        default: this.config.get('webhook.username'),
      });
      if (name !== null) this.config.set('webhook.username', name);

      const mention = await this.prompt.ask('Tag khi có lỗi (vd <@123>, Enter = bỏ)', {
        default: this.config.get('webhook.mentionOnError') || '',
      });
      if (mention !== null) this.config.set('webhook.mentionOnError', mention.trim());
    }

    this._save();

    if (enabled && this.config.get('webhook.url')) {
      const wantTest = await this.prompt.confirm('Gửi tin nhắn thử ngay?', true);
      if (wantTest) {
        const WebhookManager = require('core/WebhookManager');
        const wm = new WebhookManager(this.config.get('webhook'), this.logger);
        const result = await wm.test();
        result.ok ? this.ui.ok(result.message) : this.ui.fail(result.message);
      }
    }
  }

  async editScreenshot() {
    const enabled = await this.prompt.confirm(
      'Bật chụp màn hình?',
      this.config.get('screenshot.enabled')
    );
    if (enabled === null) return;
    this.config.set('screenshot.enabled', enabled);

    if (enabled) {
      const dir = await this.prompt.ask('Thư mục lưu ảnh', {
        default: this.config.get('screenshot.directory'),
      });
      if (dir !== null) this.config.set('screenshot.directory', dir.trim());

      const onError = await this.prompt.confirm(
        'Tự chụp khi gặp lỗi?',
        this.config.get('screenshot.onError')
      );
      if (onError !== null) this.config.set('screenshot.onError', onError);

      const keep = await this.prompt.askNumber('Giữ lại bao nhiêu ảnh gần nhất', {
        min: 1,
        max: 500,
        default: this.config.get('screenshot.keepLast'),
      });
      if (keep !== null) this.config.set('screenshot.keepLast', keep);
    }
    this._save();
  }

  async editAutoexec() {
    const enabled = await this.prompt.confirm(
      'Bật quản lý autoexec?',
      this.config.get('autoexec.enabled')
    );
    if (enabled === null) return;
    this.config.set('autoexec.enabled', enabled);

    if (enabled) {
      const dir = await this.prompt.ask('Thư mục autoexec', {
        default: this.config.get('autoexec.directory'),
      });
      if (dir !== null) this.config.set('autoexec.directory', dir.trim());
    }
    this._save();
  }

  async editUI() {
    const box = require('utils/box');
    const theme = await this.prompt.select(
      'Kiểu khung',
      box.styles.map((s) => ({ label: s, value: s }))
    );
    if (theme !== null) this.config.set('ui.theme', theme);

    const level = await this.prompt.select('Mức log', [
      { label: 'debug', value: 'debug', hint: 'chi tiết nhất' },
      { label: 'info', value: 'info', hint: 'mặc định' },
      { label: 'warn', value: 'warn' },
      { label: 'error', value: 'error' },
    ]);
    if (level !== null) this.config.set('logging.level', level);

    this._save();
  }

  async resetAll() {
    const sure = await this.prompt.confirm(
      c.yellow('Xoá toàn bộ cấu hình và quay về mặc định?'),
      false
    );
    if (!sure) {
      this.ui.info('Đã huỷ.');
      return;
    }
    const alsoCookies = await this.prompt.confirm('Xoá luôn cookie đã lưu?', false);
    this.config.reset();
    if (alsoCookies) {
      for (const alias of this.cookies.list()) this.cookies.remove(alias);
      this.cookies.save();
    }
    this._save();
    this.ui.ok('Đã đặt lại.');
  }
}

module.exports = ConfigEditor;

};

/* ---------- module: MultiRejoinTool ---------- */
__mods['MultiRejoinTool'] = function(module, exports, require) {
'use strict';

const path = require('path');
const { execFile } = require('child_process');

const c = require('utils/colors');
const Prompt = require('utils/prompt');
const Logger = require('utils/logger');
const Config = require('core/Config');
const CookieStore = require('core/CookieStore');
const RobloxUser = require('core/RobloxUser');
const GameSelector = require('core/GameSelector');
const StatusHandler = require('core/StatusHandler');
const WebhookManager = require('core/WebhookManager');
const ScreenshotManager = require('core/ScreenshotManager');
const AutoexecManager = require('core/AutoexecManager');
const UIRenderer = require('ui/UIRenderer');
const ConfigEditor = require('ui/ConfigEditor');

const VERSION = '2.0.0';
const STATES = StatusHandler.STATES;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class MultiRejoinTool {
  /** @param {object} [opts] @param {string} [opts.dataDir] */
  constructor(opts = {}) {
    this.dataDir = path.resolve(opts.dataDir || process.cwd());

    this.config = new Config(path.join(this.dataDir, 'config.json')).load();
    this.cookies = new CookieStore(path.join(this.dataDir, 'cookies.enc.json')).load();

    this.logger = new Logger({
      level: this.config.get('logging.level', 'info'),
      file: path.join(this.dataDir, this.config.get('logging.file', 'logs/mrt.log')),
    });

    this.ui = new UIRenderer(this.config, this.logger);
    this.prompt = new Prompt();

    this.selector = new GameSelector(this.config, this.logger);
    this.webhook = new WebhookManager(this.config.get('webhook'), this.logger);
    this.screenshot = new ScreenshotManager(this.config.get('screenshot'), this.logger);
    this.autoexec = new AutoexecManager(this.config.get('autoexec'), this.logger);

    /** @type {Map<string, {user: RobloxUser, status: StatusHandler}>} */
    this.accounts = new Map();

    this.running = false;
    this.stopRequested = false;
    this.startedAt = null;
    this.exiting = false;

    this._installSignalHandlers();
  }

  _installSignalHandlers() {
    const onSignal = () => {
      if (this.running) {
        this.stopRequested = true;
        this.ui.blank();
        this.ui.warn('Đã nhận tín hiệu dừng — đang kết thúc vòng lặp...');
      } else if (!this.exiting) {
        this.shutdown(0);
      }
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    process.on('unhandledRejection', (err) => {
      this.logger.error(`Promise chưa bắt lỗi: ${(err && err.message) || err}`);
    });
    process.on('uncaughtException', (err) => {
      this.logger.error(`Lỗi không bắt được: ${err.stack || err.message}`);
      this.shutdown(1);
    });
  }

  /** Nạp danh sách tài khoản từ config + cookie store. */
  loadAccounts() {
    this.accounts.clear();
    const list = this.config.get('accounts', []);
    const maxRetries = this.config.get('rejoin.maxRetries', 5);

    for (const entry of list) {
      if (entry.enabled === false) continue;
      const user = new RobloxUser({
        alias: entry.alias,
        cookie: this.cookies.get(entry.alias) || '',
        logger: this.logger,
      });
      const status = new StatusHandler({
        alias: entry.alias,
        maxRetries,
        logger: this.logger,
        onChange: (alias, from, to, meta) => this._onStateChange(alias, from, to, meta),
      });
      this.accounts.set(entry.alias, { user, status });
    }
    return this.accounts.size;
  }

  _onStateChange(alias, from, to, meta) {
    this.logger.debug(`[${alias}] ${from} -> ${to}`);
    if (to === STATES.JOINED && this.webhook.allows('onRejoin')) {
      this.webhook.send({
        title: '🔁 Đã rejoin',
        level: 'success',
        fields: [
          { name: 'Tài khoản', value: alias, inline: true },
          { name: 'Mục tiêu', value: this.selector.describe(), inline: true },
        ],
      });
    }
    if (to === STATES.FATAL && this.webhook.allows('onError')) {
      this.webhook.send({
        title: '⛔ Tài khoản dừng hẳn',
        level: 'error',
        description: meta.error || 'Vượt quá số lần thử lại.',
        fields: [{ name: 'Tài khoản', value: alias, inline: true }],
      });
    }
  }

  /** Xác thực toàn bộ cookie (chạy song song). */
  async verifyAll() {
    if (!this.accounts.size) {
      this.ui.warn('Chưa có tài khoản nào để xác thực.');
      return { total: 0, verified: 0 };
    }
    this.ui.info('Đang xác thực cookie...');
    const jobs = Array.from(this.accounts.values()).map(async ({ user }) => {
      const ok = await user.authenticate();
      if (ok) this.ui.ok(`${c.white(user.alias)} → ${user.summary()}`);
      else this.ui.fail(`${c.white(user.alias)} → ${user.lastError}`);
      return ok;
    });
    const results = await Promise.all(jobs);
    return { total: results.length, verified: results.filter(Boolean).length };
  }

  /** Mở Roblox client bằng deep link (không tự động hoá thao tác trong game). */
  async launch(alias) {
    const url = this.selector.buildLaunchUrl();
    if (!url) throw new Error('Chưa cấu hình mục tiêu (placeId / private server).');

    const platform = process.platform;
    const [cmd, args] =
      platform === 'darwin'
        ? ['open', [url]]
        : platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];

    await new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout: 15000, windowsHide: true }, (err) => {
        if (err) return reject(new Error(`Không mở được Roblox: ${err.message}`));
        resolve();
      });
    });
    this.logger.debug(`[${alias}] đã gọi ${cmd} với ${url}`);
  }

  /** Một lượt rejoin cho một tài khoản. */
  async rejoinOnce(alias) {
    const entry = this.accounts.get(alias);
    if (!entry) return;
    const { status } = entry;

    status.transition(STATES.LAUNCHING);
    try {
      await this.launch(alias);
      await sleep(1500);
      status.transition(STATES.JOINED);
    } catch (err) {
      const verdict = status.recordError(err.message);
      this.logger.error(`[${alias}] ${err.message}`);

      if (this.screenshot.enabled && this.config.get('screenshot.onError')) {
        const shot = await this.screenshot.capture(`error_${alias}`);
        if (shot.ok) this.logger.info(`Đã lưu ảnh lỗi: ${shot.file}`);
      }

      if (verdict === 'retry') {
        const wait = this.config.get('rejoin.retryDelaySeconds', 15);
        this.logger.warn(
          `[${alias}] thử lại sau ${wait}s (lần ${status.retries}/${status.maxRetries})`
        );
        await this.interruptibleSleep(wait * 1000);
      }
    }
  }

  /** Sleep nhưng thoát sớm khi người dùng yêu cầu dừng. */
  async interruptibleSleep(ms) {
    const step = 250;
    let waited = 0;
    while (waited < ms && !this.stopRequested) {
      await sleep(Math.min(step, ms - waited));
      waited += step;
    }
  }

  /** VÒNG LẶP REJOIN CHÍNH. */
  async runLoop() {
    const errors = this.config.validate();
    if (errors.length) {
      this.ui.blank();
      errors.forEach((e) => this.ui.fail(e));
      this.ui.info('Vào mục "Cấu hình" để sửa trước khi chạy.');
      await this.prompt.pause();
      return;
    }

    this.loadAccounts();
    const verify = await this.verifyAll();
    if (!verify.verified) {
      this.ui.fail('Không có tài khoản nào xác thực thành công. Dừng lại.');
      await this.prompt.pause();
      return;
    }

    this.running = true;
    this.stopRequested = false;
    this.startedAt = Date.now();

    const info = await this.selector.fetchGameInfo(this.config.get('placeId'));
    const target = this.selector.describe(info);

    if (this.webhook.allows('onStart')) {
      this.webhook.send({
        title: '▶️ Bắt đầu chạy',
        level: 'info',
        fields: [
          { name: 'Mục tiêu', value: target, inline: true },
          { name: 'Tài khoản', value: String(verify.verified), inline: true },
          {
            name: 'Chu kỳ',
            value: `${this.config.get('rejoin.intervalSeconds')}s`,
            inline: true,
          },
        ],
      });
    }

    this.ui.blank();
    this.ui.ok(`Đang chạy — mục tiêu: ${c.white(target)}`);
    this.ui.info(`Bấm ${c.cyan('Ctrl+C')} để dừng.`);
    this.ui.blank();

    const interval = this.config.get('rejoin.intervalSeconds', 300) * 1000;
    const jitterMax = this.config.get('rejoin.randomJitterSeconds', 0) * 1000;

    while (!this.stopRequested) {
      for (const [alias, { status }] of this.accounts) {
        if (this.stopRequested) break;
        if (!status.isActive) continue;
        await this.rejoinOnce(alias);
      }

      const stillActive = Array.from(this.accounts.values()).some((a) => a.status.isActive);
      if (!stillActive) {
        this.ui.fail('Mọi tài khoản đều đã dừng. Kết thúc vòng lặp.');
        break;
      }
      if (this.stopRequested) break;

      for (const [, entry] of this.accounts) {
        if (entry.status.state === STATES.JOINED) entry.status.transition(STATES.WAITING);
      }

      this.render();
      const jitter = jitterMax ? Math.floor(Math.random() * jitterMax) : 0;
      const wait = interval + jitter;
      this.ui.info(`Chờ ${Math.round(wait / 1000)}s trước lượt tiếp theo...`);
      await this.interruptibleSleep(wait);
    }

    this.running = false;
    await this.finishRun();
  }

  /** Vẽ lại bảng trạng thái. */
  render() {
    const snapshots = Array.from(this.accounts.values()).map((a) => a.status.snapshot());
    this.ui.blank();
    this.ui.print(this.ui.statusTable(snapshots));
  }

  async finishRun() {
    const totals = Array.from(this.accounts.values()).reduce(
      (acc, a) => {
        acc.totalRejoins += a.status.rejoinCount;
        acc.totalErrors += a.status.errorCount;
        return acc;
      },
      { totalRejoins: 0, totalErrors: 0 }
    );

    const uptimeSeconds = this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0;

    if (this.webhook.allows('onStop')) {
      this.webhook.send({
        title: '⏹️ Đã dừng',
        level: 'neutral',
        fields: [
          { name: 'Tổng rejoin', value: String(totals.totalRejoins), inline: true },
          { name: 'Tổng lỗi', value: String(totals.totalErrors), inline: true },
          { name: 'Thời gian', value: UIRenderer.formatDuration(uptimeSeconds), inline: true },
        ],
      });
    }
    await this.webhook.flush(5000);

    this.ui.blank();
    this.ui.print(
      this.ui.summary({
        ...totals,
        uptimeSeconds,
        webhookSent: this.webhook.stats().sent,
      })
    );
    await this.prompt.pause();
  }

  /** Màn hình tổng quan trước menu. */
  renderHome() {
    this.ui.clear();
    this.ui.print(this.ui.banner(VERSION));

    const accounts = this.config.get('accounts', []);
    const verified = Array.from(this.accounts.values()).filter((a) => a.user.verified).length;

    this.ui.print(
      this.ui.overview({
        target: this.selector.describe(),
        accounts: { total: accounts.length, verified },
        rejoin: this.config.get('rejoin'),
        webhook: this.config.get('webhook.enabled'),
        screenshot: this.config.get('screenshot.enabled'),
        autoexec: this.config.get('autoexec.enabled'),
      })
    );

    if (this.config.loadError) {
      this.ui.warn(`config.json lỗi (${this.config.loadError}) — đang dùng giá trị mặc định.`);
    }
  }

  /** MENU CHÍNH — vòng lặp cho tới khi người dùng thoát hoặc EOF. */
  async menuLoop() {
    this.loadAccounts();

    for (;;) {
      this.renderHome();
      this.ui.print(
        this.ui.mainMenu([
          { key: 1, label: c.green('Bắt đầu rejoin'), hint: 'chạy vòng lặp' },
          { key: 2, label: 'Xác thực tài khoản', hint: 'kiểm tra cookie' },
          { key: 3, label: 'Cấu hình', hint: 'sửa mọi thiết lập' },
          { key: 4, label: 'Xem autoexec' },
          { key: 5, label: 'Chụp màn hình ngay' },
          { key: 6, label: 'Xem nhật ký gần đây' },
          { key: 0, label: c.gray('Thoát') },
        ])
      );

      const choice = await this.prompt.ask('Chọn');
      // EOF (pipe hết dữ liệu / Ctrl+D) -> thoát êm, KHÔNG treo.
      if (choice === null) {
        this.ui.blank();
        this.ui.info('Đã nhận EOF — thoát.');
        return;
      }

      switch (choice) {
        case '1':
          await this.runLoop();
          break;
        case '2':
          this.loadAccounts();
          await this.verifyAll();
          await this.prompt.pause();
          break;
        case '3': {
          const editor = new ConfigEditor({
            config: this.config,
            cookies: this.cookies,
            prompt: this.prompt,
            ui: this.ui,
            logger: this.logger,
          });
          await editor.run();
          // Nạp lại các manager theo config mới
          this.webhook = new WebhookManager(this.config.get('webhook'), this.logger);
          this.screenshot = new ScreenshotManager(this.config.get('screenshot'), this.logger);
          this.autoexec = new AutoexecManager(this.config.get('autoexec'), this.logger);
          this.loadAccounts();
          break;
        }
        case '4': {
          const items = this.autoexec.scan();
          this.ui.blank();
          if (!items.length) {
            this.ui.warn(`Không có script nào trong ${this.autoexec.dir}`);
          } else {
            items.forEach((item, i) => {
              const flag = item.enabled ? c.green('bật') : c.gray('tắt');
              this.ui.print(
                `  ${c.cyan(String(i + 1).padStart(2))}. ${c.white(item.name)}  ${flag}  ${c.gray(
                  `${item.size} B`
                )}`
              );
            });
          }
          await this.prompt.pause();
          break;
        }
        case '5': {
          const result = await this.screenshot.capture('manual');
          result.ok ? this.ui.ok(`Đã lưu: ${result.file}`) : this.ui.fail(result.message);
          await this.prompt.pause();
          break;
        }
        case '6': {
          this.ui.blank();
          this.ui.print(this.ui.logPanel(this.logger.tail(15)));
          await this.prompt.pause();
          break;
        }
        case '0':
          return;
        default:
          this.ui.warn('Lựa chọn không hợp lệ.');
          await sleep(700);
      }
    }
  }

  async start() {
    try {
      await this.menuLoop();
    } catch (err) {
      this.logger.error(err.stack || err.message);
    } finally {
      await this.shutdown(0);
    }
  }

  async shutdown(code = 0) {
    if (this.exiting) return;
    this.exiting = true;
    try {
      await this.webhook.flush(3000);
      this.config.save();
    } catch (_) { /* thoát thì bỏ qua lỗi lưu */ }
    this.prompt.close();
    this.ui.blank();
    this.ui.print(c.gray('Tạm biệt 👋'));
    process.exit(code);
  }
}

module.exports = MultiRejoinTool;
module.exports.VERSION = VERSION;

};

/* ---------- ENTRY POINT ---------- */

/**
 * MultiRejoinTool — entry point.
 *
 * Chạy:  node rejoin.cjs
 * Tuỳ chọn:
 *   --data-dir <path>   Thư mục chứa config.json / cookies / logs (mặc định: thư mục hiện tại)
 *   --version           In phiên bản
 *   --help              Trợ giúp
 */

const MultiRejoinTool = __req('MultiRejoinTool');
const { VERSION } = MultiRejoinTool;

function parseArgs(argv) {
  const args = { dataDir: process.cwd() };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--data-dir' || arg === '-d') {
      args.dataDir = argv[++i] || process.cwd();
    } else if (arg === '--version' || arg === '-v') {
      args.version = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write(
    [
      `MultiRejoinTool v${VERSION}`,
      '',
      'Cách dùng:',
      '  node rejoin.cjs [tuỳ chọn]',
      '',
      'Tuỳ chọn:',
      '  -d, --data-dir <path>   Thư mục dữ liệu (config.json, cookies, logs)',
      '  -v, --version           In phiên bản',
      '  -h, --help              Hiện trợ giúp',
      '',
      'Biến môi trường:',
      '  MRT_KEY      Khoá mã hoá cookie (nếu không có sẽ tự sinh vào .mrt-key)',
      '  NO_COLOR     Tắt màu',
      '  FORCE_COLOR  Ép bật màu (=1) kể cả khi không phải TTY',
      '',
    ].join('\n')
  );
}

function checkNodeVersion() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 16) {
    process.stderr.write(
      `Cần Node.js >= 16, bạn đang dùng ${process.versions.node}.\n`
    );
    process.exit(1);
  }
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (args.help) {
    printHelp();
    return;
  }

  checkNodeVersion();

  const tool = new MultiRejoinTool({ dataDir: args.dataDir });
  await tool.start();
}

main().catch((err) => {
  process.stderr.write(`Lỗi nghiêm trọng: ${err.stack || err.message}\n`);
  process.exit(1);
});
