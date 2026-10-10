#!/usr/bin/env node
"use strict";
/**
 * REJOIN LITE — bản rút gọn, tối ưu chạy lâu dài trên Android/Termux.
 *
 * Giữ nguyên logic rejoin của bản đầy đủ:
 *  - Hỏi presence (thẳng presence.roblox.com) -> so map (placeId / rootPlaceId / universe) -> mở game bằng `am start`
 *  - Lỗi mạng / hết hạn cookie KHÔNG làm mở lại game; sau khi mở game chờ 75s cho game load
 *  - Auto rejoin định kỳ (force-stop rồi mở lại), join server ít người, server VIP (linkCode)
 *  - Cookie 401 -> đọc lại cookie (tối đa 1 lần / 3 phút)
 *  - Chọn game: 5 game tài khoản hay chơi, hoặc nhập Place ID / link server
 *  - Giao diện giám sát làm mới mỗi 10 giây (R / đổi cỡ màn hình thì vẽ ngay)
 *
 * Tối ưu so với bản đầy đủ:
 *  - Không cần cài package nào (bỏ axios, cli-table3, figlet) -> khởi động nhanh, ít RAM
 *  - HTTP dùng https + keep-alive, giới hạn kích thước phản hồi
 *  - Vòng giám sát ngủ thẳng tới mốc việc kế tiếp thay vì thức dậy mỗi giây
 *  - Không dựng banner/gradient/bảng nặng mỗi khung; nhật ký giới hạn 12 dòng
 *  - Dùng chung thư mục config với bản đầy đủ (~/.roblox-rejoin) nên dùng lại được cấu hình cũ
 *  Đã lược bỏ: webhook, autoexec, quét world, theme/banner.
 */
const { execSync, execFileSync, execFile, spawnSync, exec } = require("child_process");
const https = require("https");
const readline = require("readline");
const fs = require("fs");
const path = require("path");
const os = require("os");
const util = require("util");
const crypto = require("crypto");

// ======================= HẰNG SỐ =======================
const HTTP_TIMEOUT = 15000;
const MAX_BODY = 2 * 1024 * 1024;
const LAUNCH_GRACE_MS = 75 * 1000;
const LAUNCH_STAGGER_MS = 2000;
const COOKIE_REFRESH_MS = 3 * 60 * 1000;
// --- Chống logout ---
// Nhịp quét tối thiểu: quét dày (15s) bằng cookie thật từ ngoài app dễ bị Roblox coi là bất thường -> thu hồi phiên.
const MIN_CHECK_SEC = 30;
// Khi bị 429 thì lùi thêm chừng này trước lần kiểm tra kế tiếp.
const RATE_LIMIT_BACKOFF_MS = 90 * 1000;
// Auto rejoin MẶC ĐỊNH KHÔNG force-stop: giết app lúc WebView đang ghi cookie có thể làm mất/hỏng cookie -> văng ra màn hình đăng nhập.
// Muốn quay lại kiểu dừng hẳn app thì chạy: REJOIN_HARD_STOP=1 node <file>
const HARD_STOP_ON_REJOIN = process.env.REJOIN_HARD_STOP === "1";
const LIVE_REFRESH_MS = 10 * 1000;
const RECENT_GAMES_LIMIT = 5;
const MAX_EVENTS = 12;
const USER_AGENT = "Mozilla/5.0 (Linux; Android 10; Termux)";
const DEFAULT_ACTIVITY = "com.roblox.client.ActivityProtocolLaunch";

const TERMUX_BIN = "/data/data/com.termux/files/usr/bin";
if (process.env.PATH && !process.env.PATH.includes(TERMUX_BIN)) {
  process.env.PATH = `${TERMUX_BIN}:${process.env.PATH}`;
}

// ======================= THƯ MỤC CONFIG (dùng chung với bản đầy đủ) =======================
const CONFIG_DIR = (() => {
  const envDir = process.env.ROBLOX_REJOIN_HOME;
  if (envDir && envDir.trim()) return path.resolve(envDir.trim());
  return path.join(os.homedir() || __dirname, ".roblox-rejoin");
})();
const TMP_DIR = path.join(CONFIG_DIR, "tmp");
try { fs.mkdirSync(TMP_DIR, { recursive: true, mode: 0o700 }); } catch (_) { }

const CONFIG_PATH = path.join(CONFIG_DIR, "multi_configs.json");
const PREFIX_PATH = path.join(CONFIG_DIR, "package_prefix_config.json");
const ACTIVITY_PATH = path.join(CONFIG_DIR, "activity_config.json");
const RUN_OPTIONS_PATH = path.join(CONFIG_DIR, "run_options.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const shQuote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const execFileAsync = util.promisify(execFile);

/** Ngủ có thể đánh thức sớm (phím R / đổi cỡ màn hình). */
let wakeFn = null;
function napFor(ms) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      if (wakeFn === done) wakeFn = null;
      resolve();
    };
    const t = setTimeout(done, ms);
    wakeFn = done;
  });
}
const wakeLoop = () => { if (wakeFn) wakeFn(); };

// ======================= GIAO DIỆN NHẸ =======================
const UI = (() => {
  const colorOn = () => process.env.NO_COLOR === undefined && (Boolean(process.stdout.isTTY) || Boolean(process.env.FORCE_COLOR));
  const codes = {
    accent: "1;38;5;87", violet: "1;38;5;147", good: "1;38;5;121", warn: "1;38;5;221",
    bad: "1;38;5;203", text: "38;5;255", dim: "38;5;245", border: "38;5;63", muted: "38;5;60"
  };
  const c = (tone, text) => (colorOn() ? `\x1b[${codes[tone] || tone}m${text}\x1b[0m` : String(text));
  const strip = (s) => String(s ?? "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const vlen = (s) => Array.from(strip(s)).length;
  const width = (max = 100) => Math.max(33, Math.min(max, (process.stdout.columns || 80) - 1));
  const fit = (s, w) => {
    if (w <= 0) return "";
    const a = Array.from(String(s ?? "").replace(/[\r\n\t]+/g, " "));
    return a.length <= w ? a.join("") : a.slice(0, w - 1).join("") + "…";
  };
  const padTo = (s, w) => s + " ".repeat(Math.max(0, w - vlen(s)));
  const split = (l, r, w) => l + " ".repeat(Math.max(1, w - vlen(l) - vlen(r))) + r;
  const box = (title, lines, w = width()) => {
    const inner = w - 4;
    const B = (t) => c("border", t);
    const head = title ? ` ${fit(title, w - 6)} ` : "";
    const top = "╭─" + head + "─".repeat(Math.max(0, w - 3 - vlen(head))) + "╮";
    const body = lines.map((l) => B("│") + " " + padTo(l, inner) + " " + B("│"));
    return [B(top), ...body, B("╰" + "─".repeat(w - 2) + "╯")].join("\n");
  };
  const wrap = (text, w) => {
    const out = [];
    for (const para of String(text ?? "").split(/\r?\n/)) {
      let line = "";
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const cand = line ? line + " " + word : word;
        if (Array.from(cand).length <= w) { line = cand; continue; }
        if (line) out.push(line);
        let chars = Array.from(word);
        while (chars.length > w) out.push(chars.splice(0, w).join(""));
        line = chars.join("");
      }
      out.push(line);
    }
    return out;
  };
  const card = (rows, title = "THÔNG TIN") => {
    const w = width();
    const inner = w - 4;
    const lw = Math.min(14, Math.max(6, ...rows.map(([l]) => vlen(l))));
    const lines = [];
    for (const [label, value, tone = "text"] of rows) {
      wrap(value ?? "-", Math.max(5, inner - lw - 3)).forEach((part, i) => {
        lines.push(c("dim", fit(i === 0 ? String(label).toUpperCase() : "", lw).padEnd(lw)) + c("muted", " │ ") + c(tone, part));
      });
    }
    return box(title, lines, w);
  };
  const msg = (type, text) => {
    const s = { success: ["good", "✓"], error: ["bad", "✕"], warning: ["warn", "!"], info: ["accent", "•"] }[type] || ["accent", "•"];
    return c(s[0], `  ${s[1]} `) + c("text", text);
  };
  const prompt = (label) => `\n${c("accent", "  ❯ ")}${c("text", label)}${c("violet", " : ")}`;
  const section = (title, sub = "") =>
    `\n  ${c("accent", "◆ ")}${c("accent", title)}` + (sub ? `\n${c("dim", "  " + sub)}` : "") + "\n" + c("muted", "─".repeat(width()));
  const options = (items) => {
    const w = width();
    const lines = [];
    items.forEach((it) => {
      lines.push(c(it.color || "accent", `[${it.key}]`) + " " + c("text", fit(it.label, w - 4 - vlen(String(it.key)) - 3)));
      if (it.desc) wrap(it.desc, w - 6).forEach((l) => lines.push(c("dim", "    " + l)));
    });
    return box("LỰA CHỌN", lines, w);
  };
  const clear = () => { if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H"); };
  const screen = (title, sub) => { clear(); console.log(c("accent", "\n  R E J O I N  L I T E")); console.log(section(title, sub)); };

  /** Vẽ khung hình tại chỗ (không xoá màn hình -> không nháy), cắt cho vừa chiều cao. */
  const paint = (frame) => {
    if (!process.stdout.isTTY) { process.stdout.write(frame + "\n"); return; }
    let lines = frame.split("\n");
    const rows = process.stdout.rows || 0;
    if (rows > 4 && lines.length > rows - 1) {
      const keep = rows - 2;
      const hidden = lines.length - keep;
      lines = lines.slice(0, keep);
      lines.push(c("dim", `  … còn ${hidden} dòng (thu nhỏ cỡ chữ hoặc xoay ngang)`));
    }
    process.stdout.write("\x1b[?25l\x1b[H" + lines.map((l) => l + "\x1b[K").join("\n") + "\n\x1b[J");
  };

  const spinner = (text) => {
    if (!process.stdout.isTTY) { console.log(msg("info", text)); return { stop() { } }; }
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let i = 0;
    const draw = () => process.stdout.write("\r\x1b[K" + c("accent", `  ${frames[i++ % frames.length]} `) + c("text", fit(text, width() - 6)));
    process.stdout.write("\x1b[?25l");
    draw();
    const timer = setInterval(draw, 120);
    return { stop() { clearInterval(timer); process.stdout.write("\r\x1b[K\x1b[?25h"); } };
  };
  return { c, strip, vlen, width, fit, padTo, split, box, card, msg, prompt, section, options, screen, paint, spinner, wrap, clear };
})();

const ask = (rl, q) => new Promise((r) => rl.question(q, r));

// ======================= HTTP NHẸ (https + keep-alive) =======================
const agent = new https.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: 12, maxFreeSockets: 4, timeout: 60000 });

function netError(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function rawRequest(method, url, { params, headers, body, timeout = HTTP_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(e); return; }
    if (params) for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const h = { "User-Agent": USER_AGENT, Accept: "application/json", ...(headers || {}) };
    if (payload) { h["Content-Type"] = "application/json"; h["Content-Length"] = payload.length; }

    let done = false;
    let timer = null;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
    const req = https.request(u, { method, headers: h, agent }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (d) => {
        size += d.length;
        if (size > MAX_BODY) { req.destroy(); finish(reject, netError("Phản hồi quá lớn", "EMSGSIZE")); return; }
        chunks.push(d);
      });
      res.on("end", () => {
        let data = null;
        const text = Buffer.concat(chunks).toString("utf8");
        if (text) { try { data = JSON.parse(text); } catch (_) { data = null; } }
        finish(resolve, { status: res.statusCode, headers: res.headers, data });
      });
      res.on("error", (e) => finish(reject, e));
    });
    timer = setTimeout(() => { req.destroy(); finish(reject, netError("Hết thời gian chờ", "ETIMEDOUT")); }, timeout);
    req.on("error", (e) => finish(reject, e));
    if (payload) req.write(payload);
    req.end();
  });
}

/** Socket keep-alive cũ có thể bị đóng ngầm (đổi mạng, ngủ máy) -> thử lại đúng 1 lần. */
async function request(method, url, opts) {
  try {
    return await rawRequest(method, url, opts);
  } catch (e) {
    if (["ECONNRESET", "EPIPE", "ECONNABORTED"].includes(e.code)) return rawRequest(method, url, opts);
    throw e;
  }
}

/** GET JSON, tự chờ & thử lại khi 429. Lỗi ném ra có .status. */
async function getJson(url, { params, headers, retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await request("GET", url, { params, headers });
    } catch (e) {
      const err = new Error(describeNetError(e));
      err.status = undefined;
      throw err;
    }
    if (res.status >= 200 && res.status < 300) return res.data;
    if (res.status === 429 && attempt < retries) {
      const ra = Number(res.headers["retry-after"]);
      await sleep(clamp((ra > 0 ? ra : 2 * (attempt + 1)) * 1000, 1000, 10000));
      continue;
    }
    const err = new Error(res.status === 429 ? "Roblox giới hạn tốc độ (429)" : `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
}

/** POST JSON, tự lấy X-CSRF-TOKEN từ phản hồi 403 rồi gửi lại 1 lần. holder.csrf giữ token. */
async function postCsrf(url, body, headers, holder = {}) {
  const send = () => request("POST", url, {
    body,
    headers: { ...headers, ...(holder.csrf ? { "X-CSRF-TOKEN": holder.csrf } : {}) }
  });
  let res = await send();
  const token = res.headers && res.headers["x-csrf-token"];
  if (res.status === 403 && token) {
    holder.csrf = token;
    res = await send();
  }
  return res;
}

function describeNetError(e) {
  if (!e) return "lỗi không rõ";
  if (e.code === "ETIMEDOUT" || e.code === "ECONNABORTED") return "Hết thời gian chờ";
  if (["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "ECONNRESET", "EHOSTUNREACH"].includes(e.code)) return "Mất kết nối mạng";
  return e.message || String(e);
}

// ======================= CONFIG =======================
function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return null; }
}

function loadConfigs() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  const parsed = readJson(CONFIG_PATH);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  try {
    const backup = `${CONFIG_PATH}.corrupt-${Date.now()}`;
    fs.renameSync(CONFIG_PATH, backup);
    console.error(`[-] multi_configs.json bị hỏng; đã giữ bản sao: ${path.basename(backup)}`);
  } catch (_) { }
  return {};
}
function saveConfigs(configs) {
  try { writeJsonAtomic(CONFIG_PATH, configs); return true; } catch (e) {
    console.error(`[-] Không thể lưu cấu hình: ${e.message}`);
    return false;
  }
}

const isValidPrefix = (p) => /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/.test(String(p || ""));
let prefixCache = null;
function loadPrefix() {
  if (prefixCache) return prefixCache;
  const cfg = readJson(PREFIX_PATH);
  prefixCache = cfg && isValidPrefix(cfg.prefix) ? cfg.prefix : "com.roblox";
  return prefixCache;
}
function savePrefix(prefix) {
  if (!isValidPrefix(prefix)) return false;
  try { writeJsonAtomic(PREFIX_PATH, { prefix }); prefixCache = null; return true; } catch (_) { return false; }
}

function loadRunOptions() {
  const base = { autoRejoinMin: 0, lowPop: false };
  const p = readJson(RUN_OPTIONS_PATH);
  if (!p || typeof p !== "object") return base;
  const min = Math.floor(Number(p.autoRejoinMin));
  return { autoRejoinMin: min >= 1 && min <= 1440 ? min : 0, lowPop: Boolean(p.lowPop) };
}
function saveRunOptions(o) { try { writeJsonAtomic(RUN_OPTIONS_PATH, o); } catch (_) { } }

let activityCache;
function getActivity() {
  if (activityCache === undefined) {
    const cfg = readJson(ACTIVITY_PATH);
    const a = cfg && cfg.activity;
    activityCache = a && /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(a) ? a : DEFAULT_ACTIVITY;
  }
  return activityCache;
}

const maskSensitive = (t) => {
  if (!t || t === "Unknown") return t;
  const s = String(t);
  return s.length <= 3 ? s : "*".repeat(s.length - 3) + s.slice(-3);
};

function packageLabel(name) {
  const p = loadPrefix();
  if (name === `${p}.client` || name === "com.roblox.client") return "Global";
  if (name === `${p}.client.vnggames` || name === "com.roblox.client.vnggames") return "VNG";
  return name;
}
function describePackage(name) {
  const p = loadPrefix();
  if (name === `${p}.client` || name === "com.roblox.client") return "Roblox Quốc tế";
  if (name === `${p}.client.vnggames` || name === "com.roblox.client.vnggames") return "Roblox VNG";
  return `Roblox Custom (${name})`;
}

// ======================= HỆ THỐNG ANDROID =======================
let wakeLockState = "off";
function enableWakeLock() {
  wakeLockState = "pending";
  exec("termux-wake-lock", (err) => { wakeLockState = err ? "failed" : "on"; });
}
function disableWakeLock() {
  if (wakeLockState === "off") return;
  wakeLockState = "off";
  try { execSync("termux-wake-unlock", { stdio: "ignore", timeout: 5000 }); } catch (_) { }
}

function ensureSystemDependencies() {
  try {
    execSync("command -v sqlite3", { stdio: "ignore" });
    return;
  } catch (_) { }
  const isRoot = execSync("id -u", { encoding: "utf8" }).trim() === "0";
  if (isRoot) {
    console.error("[-] Chưa có sqlite3. Chạy bằng user thường để tự cài, hoặc: pkg install sqlite");
    process.exit(1);
  }
  console.log("[-] Chưa có sqlite3. Đang cài...");
  try { execSync("pkg install sqlite -y", { stdio: "inherit" }); } catch (_) {
    console.error("[-] Cài sqlite3 thất bại. Hãy chạy: pkg install sqlite");
    process.exit(1);
  }
}

function ensureRoot() {
  let uid = "";
  try { uid = execSync("id -u", { encoding: "utf8" }).trim(); } catch (e) {
    console.error("Không kiểm tra được quyền hiện tại:", e.message);
    process.exit(1);
  }
  if (uid === "0") return;
  console.log("Cần quyền root, chuyển qua su...");
  const env = [["ROBLOX_REJOIN_HOME", CONFIG_DIR]];
  for (const key of ["TERM", "NO_COLOR", "FORCE_COLOR"]) if (process.env[key]) env.push([key, process.env[key]]);
  const command = [
    ...env.map(([k, v]) => `${k}=${shQuote(v)}`),
    shQuote(process.execPath), shQuote(__filename),
    ...process.argv.slice(2).map(shQuote)
  ].join(" ");
  const result = spawnSync("su", ["-c", command], { stdio: "inherit" });
  if (result.error) { console.error("Không thể chạy với quyền root:", result.error.message); process.exit(1); }
  process.exit(typeof result.status === "number" ? result.status : 1);
}

function cleanTmpDir(maxAgeMs = 60 * 60 * 1000) {
  try {
    for (const name of fs.readdirSync(TMP_DIR)) {
      const p = path.join(TMP_DIR, name);
      try { if (Date.now() - fs.statSync(p).mtimeMs > maxAgeMs) fs.unlinkSync(p); } catch (_) { }
    }
  } catch (_) { }
}

/** Mở game bằng `am start` (không qua shell). Trả về { ok, error? }. */
async function launchGame(placeId, linkCode, packageName, jobId = null) {
  if (!/^[A-Za-z0-9_.]+$/.test(String(packageName || ""))) return { ok: false, error: "Tên package không hợp lệ" };
  if (!/^\d+$/.test(String(placeId || ""))) return { ok: false, error: "Place ID không hợp lệ" };
  if (linkCode && !/^[\w-]+$/.test(String(linkCode))) return { ok: false, error: "Mã server VIP không hợp lệ" };
  if (jobId && !/^[\w-]+$/.test(String(jobId))) return { ok: false, error: "Job ID server không hợp lệ" };

  let url = `roblox://placeID=${placeId}`;
  if (linkCode) url += `&linkCode=${linkCode}`;
  else if (jobId) url += `&gameInstanceId=${jobId}`;

  const args = ["start", "-n", `${packageName}/${getActivity()}`, "-a", "android.intent.action.VIEW", "-d", url, "--activity-clear-top"];
  let lastError = "không rõ nguyên nhân";
  for (const bin of ["am", "/system/bin/am"]) {
    try {
      const { stdout, stderr } = await execFileAsync(bin, args, { timeout: 20000, maxBuffer: 256 * 1024 });
      const bad = `${stdout || ""}\n${stderr || ""}`.split("\n").find((l) => /^\s*(Error|Exception|java\.lang\.)/i.test(l));
      if (bad) { lastError = bad.trim(); continue; }
      return { ok: true };
    } catch (e) {
      if (e.code === "ENOENT" && lastError !== "không rõ nguyên nhân") continue;
      lastError = String(e.message || e).split("\n")[0];
    }
  }
  return { ok: false, error: lastError };
}

async function forceStop(packageName) {
  if (!/^[A-Za-z0-9_.]+$/.test(String(packageName || ""))) return false;
  for (const bin of ["am", "/system/bin/am"]) {
    try { await execFileAsync(bin, ["force-stop", packageName], { timeout: 15000 }); return true; } catch (_) { }
  }
  return false;
}

function detectRobloxPackages() {
  const prefix = loadPrefix();
  const methods = [
    "unset LD_PRELOAD LD_LIBRARY_PATH; pm list packages",
    "unset LD_PRELOAD LD_LIBRARY_PATH; cmd package list packages",
    "pm list packages",
    "su -c 'unset LD_PRELOAD LD_LIBRARY_PATH; pm list packages'"
  ];
  let result = "";
  for (const m of methods) {
    try {
      result = execSync(m, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: true, maxBuffer: 16 * 1024 * 1024 });
      if (result && result.includes("package:")) break;
    } catch (_) { }
  }
  const found = [];
  const re = new RegExp(`^package:(${escapeRegExp(prefix)}[^\\s]*)`);
  const all = [];
  for (const line of String(result).split("\n")) {
    if (!line.includes("package:")) continue;
    all.push(line.replace("package:", "").trim());
    const m = line.trim().match(re);
    if (m) found.push(m[1]);
  }
  if (!found.length && all.length) {
    console.log(UI.msg("warning", `Không package nào bắt đầu bằng "${prefix}". Gợi ý: ${all.slice(0, 3).join(", ")} — đổi prefix ở mục 4.`));
  }
  return found;
}

/** Đọc cookie .ROBLOSECURITY từ database WebView của package (cần root + sqlite3). */
function getRobloxCookie(packageName) {
  if (!/^[A-Za-z0-9_.]+$/.test(String(packageName || ""))) return null;
  const label = packageLabel(packageName);
  const src = `/data/data/${packageName}/app_webview/Default/Cookies`;
  const stamp = `${process.pid}_${Date.now()}`;
  const targets = [path.join(TMP_DIR, `ck_${stamp}.db`), `/sdcard/cookies_temp_${stamp}.db`];
  const copy = (from, to) => {
    try { execFileSync("cp", [from, to], { stdio: "pipe" }); return true; } catch (_) {
      try { execFileSync("su", ["-c", `cp ${shQuote(from)} ${shQuote(to)}`], { stdio: "pipe" }); return true; } catch (_) { return false; }
    }
  };
  const created = [];
  try {
    let db = null;
    for (const t of targets) {
      if (copy(src, t)) { db = t; created.push(t); break; }
    }
    if (!db) { console.error(`[-] [${label}] Không sao chép được database cookie (cần root).`); return null; }
    try { fs.chmodSync(db, 0o600); } catch (_) { }
    for (const suffix of ["-journal", "-wal"]) if (copy(`${src}${suffix}`, `${db}${suffix}`)) created.push(`${db}${suffix}`);

    let value;
    try {
      value = execFileSync("sqlite3", [db, "SELECT value FROM cookies WHERE name = '.ROBLOSECURITY' LIMIT 1"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 }).trim();
    } catch (e) {
      console.error(`[-] [${label}] Lỗi sqlite3: ${String(e.message).split("\n")[0]}`);
      return null;
    }
    if (!value) { console.error(`[-] [${label}] Không tìm thấy cookie (đã đăng nhập chưa?).`); return null; }
    if (!value.startsWith("_")) value = "_" + value;
    return `.ROBLOSECURITY=${value}`;
  } catch (e) {
    console.error(`[-] [${label}] Lỗi lấy cookie: ${e.message}`);
    return null;
  } finally {
    for (const f of created) {
      try { fs.unlinkSync(f); } catch (_) { try { execFileSync("rm", ["-f", f], { stdio: "ignore" }); } catch (_) { } }
    }
  }
}

// ======================= ROBLOX API =======================
class RobloxUser {
  constructor(username, userId = null, cookie = null) {
    this.username = username;
    this.userId = userId;
    this.cookie = cookie;
    this.csrf = null;
  }

  async fetchAuthenticatedUser() {
    try {
      const data = await getJson("https://users.roblox.com/v1/users/authenticated", { headers: { Cookie: this.cookie } });
      this.username = data.name;
      this.userId = data.id;
      return this.userId;
    } catch (e) {
      console.error(`[-] Lỗi xác thực người dùng: ${e.message}`);
      return null;
    }
  }

  /** Trả về { presence, error?, status? } — phân biệt "mạng lỗi" với "user offline". Cookie chỉ gửi tới roblox.com. */
  async checkPresence() {
    try {
      const res = await postCsrf(
        "https://presence.roblox.com/v1/presence/users",
        { userIds: [Number(this.userId)] },
        { Cookie: this.cookie },
        this
      );
      if (res.status === 401) return { presence: null, error: "Cookie không còn hiệu lực (401)", status: 401 };
      if (res.status === 429) return { presence: null, error: "Roblox giới hạn tốc độ (429)", status: 429 };
      if (res.status < 200 || res.status >= 300) return { presence: null, error: `HTTP ${res.status}`, status: res.status };
      const presence = res.data && res.data.userPresences && res.data.userPresences[0];
      if (!presence) return { presence: null, error: "Phản hồi không có dữ liệu presence" };
      return { presence, error: null };
    } catch (e) {
      return { presence: null, error: describeNetError(e) };
    }
  }
}

const universeCache = new Map();
async function universeOfCached(placeId) {
  const key = String(placeId);
  if (universeCache.has(key)) return universeCache.get(key);
  const data = await getJson(`https://apis.roblox.com/universes/v1/places/${key}/universe`);
  if (!data || !data.universeId) throw new Error("Không tìm thấy universe");
  const id = String(data.universeId);
  universeCache.set(key, id);
  return id;
}

/** Join server ít người: quét server công khai, chọn server vắng nhất còn chỗ, giữ chỗ để các instance không đổ chung 1 server. */
class ServerFinder {
  static claimed = new Map();
  static MAX_PAGES = 5;
  static CLAIM_TTL_MS = 10 * 60 * 1000;

  static _purge() {
    const now = Date.now();
    for (const [id, at] of ServerFinder.claimed) if (now - at > ServerFinder.CLAIM_TTL_MS) ServerFinder.claimed.delete(id);
  }

  static async findLowest(placeId, { exclude = null } = {}) {
    if (!/^\d+$/.test(String(placeId || ""))) return { ok: false, error: "Place ID không hợp lệ" };
    ServerFinder._purge();
    let cursor = null;
    let scanned = 0;
    try {
      for (let page = 0; page < ServerFinder.MAX_PAGES; page++) {
        const params = { sortOrder: "Asc", excludeFullGames: true, limit: 100 };
        if (cursor) params.cursor = cursor;
        const data = await getJson(`https://games.roblox.com/v1/games/${placeId}/servers/Public`, { params });
        const list = Array.isArray(data && data.data) ? data.data : [];
        scanned += list.length;

        let min = Infinity;
        let pool = [];
        for (const sv of list) {
          if (!sv || !/^[\w-]+$/.test(String(sv.id || ""))) continue;
          const playing = Number(sv.playing);
          if (!(playing >= 1 && playing < Number(sv.maxPlayers))) continue;
          if (sv.id === exclude || ServerFinder.claimed.has(sv.id)) continue;
          if (playing < min) { min = playing; pool = [sv]; } else if (playing === min) pool.push(sv);
        }
        if (pool.length) {
          const pick = pool[Math.floor(Math.random() * pool.length)];
          ServerFinder.claimed.set(pick.id, Date.now());
          return { ok: true, jobId: String(pick.id), playing: Number(pick.playing), maxPlayers: Number(pick.maxPlayers), scanned };
        }
        cursor = data && data.nextPageCursor;
        if (!cursor) break;
        await sleep(400);
      }
      return { ok: false, error: scanned ? "không có server phù hợp" : "game không có server công khai" };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}

// ======================= CHỌN GAME =======================
class GameSelector {
  async chooseGame(rl, cookie) {
    if (cookie) {
      const notes = [];
      const spin = UI.spinner("Đang lấy danh sách game tài khoản hay chơi...");
      let recent = [];
      try { recent = await GameSelector.fetchRecentGames(cookie, RECENT_GAMES_LIMIT, (l) => notes.push(l)); } finally { spin.stop(); }
      notes.forEach((l) => console.log(l));
      if (recent.length) return this.chooseFromRecent(rl, recent, cookie);
    }
    console.log(UI.section("Chọn game", "Nhập Place ID hoặc link server"));
    return this.chooseCustom(rl, cookie);
  }

  async chooseFromRecent(rl, recent, cookie) {
    const customKey = String(recent.length + 1);
    console.log(UI.section("Chọn game", "Game tài khoản này hay chơi"));
    console.log(UI.options([
      ...recent.map((g, i) => ({ key: String(i + 1), label: g.name, desc: `Place ID: ${g.placeId}` })),
      { key: customKey, label: "Game ID / Link server", desc: "Nhập Place ID hoặc dán link server", color: "violet" }
    ]));
    const ans = (await ask(rl, UI.prompt(`Chọn game [1-${customKey}]`))).trim();
    if (ans === customKey) return this.chooseCustom(rl, cookie);
    const picked = /^\d+$/.test(ans) ? recent[parseInt(ans, 10) - 1] : null;
    if (picked) return { placeId: picked.placeId, name: picked.name, linkCode: null };
    throw new Error("Lựa chọn không hợp lệ!");
  }

  async chooseCustom(rl, cookie) {
    console.log(UI.card([
      ["Place ID", "Chỉ nhập số, ví dụ 2753915549"],
      ["Đã chuyển", "roblox.com/games/ID/Tên?privateServerLinkCode=..."],
      ["Chưa chuyển", "roblox.com/share?code=...&type=Server"],
      ["Hủy", "Để trống rồi Enter"]
    ], "GAME ID / LINK SERVER"));
    while (true) {
      const input = (await ask(rl, UI.prompt("Place ID hoặc link server"))).trim();
      if (!input) throw new Error("Đã hủy chọn game.");
      const parsed = GameSelector.parseTarget(input);
      const spin = parsed && parsed.kind === "share" ? UI.spinner("Đang đổi link chưa chuyển hướng...") : null;
      try {
        const game = await GameSelector.resolveTarget(input, cookie);
        if (spin) spin.stop();
        console.log(UI.msg("success", `${game.name} • Place ID ${game.placeId}${game.linkCode ? " • server VIP" : ""}`));
        return game;
      } catch (e) {
        if (spin) spin.stop();
        console.log(UI.msg("error", e.message));
      }
    }
  }

  static parseTarget(input) {
    const text = String(input ?? "").trim().replace(/^[<"'\s]+|[>"'\s]+$/g, "");
    if (!text) return null;
    if (/^\d{3,}$/.test(text)) return { kind: "place", placeId: text, name: "Tùy chỉnh" };
    const pick = (re) => { const m = text.match(re); return m ? m[1] : null; };

    const shareCode = pick(/[?&]code=([\w-]+)/i);
    if (shareCode && /[?&]type=server/i.test(text)) return { kind: "share", shareCode };

    const placeId = pick(/\/games\/(\d+)/i) || pick(/placeId=(\d+)/i);
    const linkCode = pick(/privateServerLinkCode=([\w-]+)/i) || pick(/[?&]linkCode=([\w-]+)/i);
    if (placeId && linkCode) return { kind: "private", placeId, linkCode, name: "Private Server" };
    if (linkCode) return { kind: "incomplete" };
    if (placeId) {
      let name = "Tùy chỉnh";
      const slug = pick(/\/games\/\d+\/([^/?#]+)/i);
      if (slug) { try { name = decodeURIComponent(slug); } catch (_) { name = slug; } }
      return { kind: "place", placeId, name };
    }
    return null;
  }

  static async resolveTarget(input, cookie = null) {
    const target = GameSelector.parseTarget(input);
    if (!target) throw new Error("Không nhận ra Place ID hoặc link server.");
    if (target.kind === "incomplete") throw new Error("Link có mã server nhưng thiếu Place ID. Hãy dán đủ link .../games/ID/...?privateServerLinkCode=...");
    if (target.kind === "share") {
      const value = typeof cookie === "function" ? cookie() : cookie;
      const info = await GameSelector.resolveShareLink(target.shareCode, value);
      return { placeId: info.placeId, name: "Private Server", linkCode: info.linkCode };
    }
    return { placeId: target.placeId, name: target.name, linkCode: target.kind === "private" ? target.linkCode : null };
  }

  static async resolveShareLink(shareCode, cookie) {
    if (!cookie) throw new Error("Không có cookie nên chưa đổi được link này. Hãy dán link đã chuyển hướng.");
    let res;
    try {
      res = await postCsrf("https://apis.roblox.com/sharelinks/v1/resolve-link", { linkId: shareCode, linkType: "Server" }, { Cookie: cookie });
    } catch (e) {
      throw new Error(`Không đổi được link: ${describeNetError(e)}. Hãy dán link đã chuyển hướng.`);
    }
    if (res.status < 200 || res.status >= 300) throw new Error(`Không đổi được link (HTTP ${res.status}). Hãy dán link đã chuyển hướng.`);
    const data = res.data && res.data.privateServerInviteData;
    if (!data) throw new Error("Link này không phải link private server.");
    if (data.status && data.status !== "Valid") throw new Error(`Link server không dùng được (trạng thái: ${data.status}).`);
    if (!data.placeId || !data.linkCode) throw new Error("Roblox không trả về đủ Place ID và mã server.");
    return { placeId: String(data.placeId), linkCode: String(data.linkCode) };
  }

  /** Game tài khoản hay chơi (mục Continue/Recent ở trang chủ Roblox). Lỗi -> [] để chuyển sang nhập tay. */
  static async fetchRecentGames(cookie, limit = RECENT_GAMES_LIMIT, log = (l) => console.log(l)) {
    try {
      const res = await postCsrf(
        "https://apis.roblox.com/discovery-api/omni-recommendation",
        { pageType: "Home", sessionId: crypto.randomUUID() },
        { Cookie: cookie }
      );
      if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);

      const parsed = GameSelector.parseRecentGames(res.data, limit);
      let games = parsed.games;
      if (parsed.missingUniverseIds.length) {
        try {
          const r = await getJson("https://games.roblox.com/v1/games", { params: { universeIds: parsed.missingUniverseIds.join(",") } });
          for (const g of (r && r.data) || []) {
            if (g && g.rootPlaceId) games.push({ placeId: String(g.rootPlaceId), name: g.name || `Game ${g.rootPlaceId}` });
          }
        } catch (e) {
          log(UI.msg("warning", `Không đổi được universeId sang placeId: ${e.message}`));
        }
      }
      const seen = new Set();
      games = games.filter((g) => (seen.has(g.placeId) ? false : (seen.add(g.placeId), true))).slice(0, limit);
      if (!games.length) log(UI.msg("warning", "Không thấy game gần đây của tài khoản. Nhập Place ID hoặc link server thủ công."));
      return games;
    } catch (e) {
      log(UI.msg("warning", `Không lấy được game gần đây: ${describeNetError(e)}. Nhập Place ID hoặc link server thủ công.`));
      return [];
    }
  }

  static parseRecentGames(data, limit = RECENT_GAMES_LIMIT) {
    const out = { games: [], missingUniverseIds: [], topics: [] };
    const sorts = Array.isArray(data && data.sorts) ? data.sorts : [];
    const label = (s) => Object.entries(s || {})
      .filter(([k, v]) => k !== "recommendationList" && (typeof v === "string" || typeof v === "number"))
      .map(([, v]) => String(v)).join(" ");
    out.topics = sorts.map((s) => String((s && (s.topic || s.sortDisplayName || s.sortName || s.sortId)) || "?"));

    const sort = sorts.find((s) => /continue|recent|jump back|resume|tiếp tục|gần đây/i.test(label(s)));
    if (!sort) return out;
    const list = Array.isArray(sort.recommendationList) ? sort.recommendationList : [];
    const metaGame = (data.contentMetadata && data.contentMetadata.Game) || {};
    for (const item of list) {
      if (!item || !item.contentId) continue;
      if (item.contentType && String(item.contentType).toLowerCase() !== "game") continue;
      if (out.games.length + out.missingUniverseIds.length >= limit) break;
      const id = String(item.contentId);
      const meta = metaGame[id];
      if (meta && meta.rootPlaceId) out.games.push({ placeId: String(meta.rootPlaceId), name: meta.name || `Game ${meta.rootPlaceId}` });
      else out.missingUniverseIds.push(id);
    }
    return out;
  }
}

// ======================= LOGIC REJOIN (giữ nguyên) =======================
class StatusHandler {
  constructor() {
    this.hasLaunched = false;
    this.joinedAt = 0;
    this.failStreak = 0;
  }

  analyzePresence(presence, targetRootPlaceId, targetUniverseId = null) {
    if (!presence || presence.userPresenceType === undefined) {
      return { status: "Không rõ", info: "Không lấy được trạng thái", shouldLaunch: true };
    }
    if (presence.userPresenceType === 0) {
      return { status: "Offline", info: "User offline! Tiến hành rejoin!", shouldLaunch: true };
    }
    if (presence.userPresenceType === 1) {
      return { status: "Online nhưng không trong game", info: "User online nhưng không trong game.", shouldLaunch: true };
    }
    if (presence.userPresenceType !== 2) {
      return { status: "Không online", info: "User không trong game. Đã mở lại game!", shouldLaunch: true };
    }

    // Roblox đôi khi không trả Place ID (riêng tư) -> không so được map, không rejoin liên tục.
    const actual = presence.rootPlaceId ?? presence.placeId;
    if (actual === undefined || actual === null || actual === "") {
      return { status: "Trong game", info: "Đang trong game (không có Place ID để so map)", shouldLaunch: false };
    }

    // Đúng map nếu placeId/rootPlaceId khớp, HOẶC cùng universe với place mục tiêu.
    const target = String(targetRootPlaceId);
    const sameUniverse = targetUniverseId && presence.universeId && String(presence.universeId) === String(targetUniverseId);
    const samePlace = [presence.placeId, presence.rootPlaceId].some((v) => v !== undefined && v !== null && String(v) === target);
    if (!samePlace && !sameUniverse) {
      return { status: "Sai map", info: `Đang ở sai map (${actual}). Đã rejoin đúng map!`, shouldLaunch: true };
    }
    return { status: "Online [+]", info: "Đang ở đúng game", shouldLaunch: false };
  }

  /** Lỗi mạng / xác thực: KHÔNG mở lại game. Vừa mở game: chờ LAUNCH_GRACE_MS cho game kịp load. */
  evaluate(check, targetPlaceId, now = Date.now(), targetUniverseId = null) {
    if (check && check.error) {
      this.failStreak++;
      const auth = check.status === 401;
      return {
        status: auth ? "Cookie hết hạn" : "Lỗi mạng",
        info: auth ? "Cookie không còn hiệu lực — đăng nhập lại Roblox trên package này" : `${check.error}; giữ nguyên game, thử lại sau`,
        shouldLaunch: false,
        failed: true
      };
    }
    this.failStreak = 0;
    const analysis = this.analyzePresence(check ? check.presence : null, targetPlaceId, targetUniverseId);
    if (analysis.shouldLaunch && this.hasLaunched && now - this.joinedAt < LAUNCH_GRACE_MS) {
      const left = Math.ceil((LAUNCH_GRACE_MS - (now - this.joinedAt)) / 1000);
      return { status: "Đang vào game", info: `Vừa gửi lệnh mở game, chờ ${left}s để game load`, shouldLaunch: false };
    }
    return analysis;
  }

  updateJoinStatus(shouldLaunch) {
    if (shouldLaunch) { this.joinedAt = Date.now(); this.hasLaunched = true; }
  }
}

const IN_GAME = new Set(["Online [+]", "Trong game"]);
const ERROR_STATUS = new Set(["Lỗi mạng", "Cookie hết hạn", "Lỗi mở game"]);
function statusTone(status) {
  const v = String(status || "").trim();
  if (IN_GAME.has(v)) return "good";
  if (["Offline", "Sai map", "Cookie hết hạn", "Lỗi mở game"].includes(v)) return "bad";
  if (v === "Lỗi mạng") return "warn";
  if (v.includes("Khởi tạo") || v === "Đang vào game") return "accent";
  return "violet";
}
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function fmtCountdown(sec) {
  const v = Math.max(0, Math.floor(Number(sec) || 0));
  if (v >= 3600) return `${Math.floor(v / 3600)}h ${Math.floor((v % 3600) / 60)}m`;
  if (v >= 60) return `${Math.floor(v / 60)}m ${String(v % 60).padStart(2, "0")}s`;
  return `${v}s`;
}
const pad2 = (n) => String(n).padStart(2, "0");
const clock = (ts) => { const d = new Date(ts); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };

// ======================= CÔNG CỤ CHÍNH =======================
class RejoinLite {
  constructor() {
    this.instances = [];
    this.events = [];
    this.running = false;
    this.startTime = Date.now();
    this.runOptions = { autoRejoinMin: 0, lowPop: false };
    this.repaint = false;
    this.rlExpectedClose = false;
    this.notice = null;
  }

  logEvent(level, text) {
    const clean = UI.strip(String(text)).replace(/\s+/g, " ").trim();
    if (!clean) return;
    this.events.push({ at: Date.now(), level, text: clean });
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
  }

  // ---------- MENU ----------
  async start() {
    ensureRoot();
    ensureSystemDependencies();
    cleanTmpDir();
    enableWakeLock();

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on("SIGINT", () => gracefulShutdown("SIGINT"));
    rl.on("close", () => { if (!this.rlExpectedClose) gracefulShutdown("EOF"); });

    const actions = {
      "1": () => this.startAutoRejoin(rl),
      "2": () => this.setupPackages(rl),
      "3": () => this.editConfigs(rl),
      "4": () => this.configurePrefix(rl)
    };

    try {
      while (!this.running) {
        UI.clear();
        const configs = loadConfigs();
        console.log(UI.c("accent", "\n  R E J O I N  L I T E") + UI.c("dim", "  — Android / multi instance"));
        if (this.notice) { console.log(UI.msg(this.notice.type, this.notice.text)); this.notice = null; }
        console.log(UI.card([
          ["Cấu hình", `${Object.keys(configs).length} package`, Object.keys(configs).length ? "good" : "warn"],
          ["Prefix", loadPrefix()],
          ["Wake lock", wakeLockState === "failed" ? "KHÔNG BẬT ĐƯỢC (cài Termux:API)" : "BẬT", wakeLockState === "failed" ? "warn" : "good"]
        ], "TRẠNG THÁI"));
        console.log(UI.options([
          { key: "1", label: "Chạy Auto Rejoin", desc: "Giám sát và tự vào lại game", color: "good" },
          { key: "2", label: "Thiết lập package", desc: "Quét package, chọn game, nhịp kiểm tra" },
          { key: "3", label: "Sửa / xoá cấu hình" },
          { key: "4", label: "Chỉnh prefix package", desc: "Dùng khi chạy Roblox mod" },
          { key: "0", label: "Thoát", color: "bad" }
        ]));

        const choice = (await ask(rl, UI.prompt("Chọn chức năng [0-4]"))).trim();
        if (choice === "0" || choice.toLowerCase() === "q") break;
        const action = actions[choice];
        if (!action) { console.log(UI.msg("warning", "Lựa chọn không hợp lệ.")); await sleep(800); continue; }

        let needAck = false;
        try {
          if ((await action()) === false) needAck = true;
        } catch (e) {
          console.error(UI.msg("error", `Không thể hoàn tất: ${e.message}`));
          needAck = true;
        }
        if (needAck && !this.running) await ask(rl, UI.prompt("Nhấn Enter để quay lại menu"));
      }
    } finally {
      this.rlExpectedClose = true;
      rl.close();
      if (!this.running) disableWakeLock();
    }
  }

  async setupPackages(rl) {
    UI.screen("Thiết lập package", "Quét và thêm tài khoản Roblox");
    const packages = detectRobloxPackages();
    if (!packages.length) {
      console.log(UI.card([["Kết quả", "KHÔNG TÌM THẤY", "bad"], ["Gợi ý", "Kiểm tra prefix ở mục 4"]], "QUÉT PACKAGE"));
      return false;
    }
    console.log(UI.options([
      { key: "0", label: "Thiết lập tất cả", desc: `${packages.length} package`, color: "good" },
      ...packages.map((p, i) => ({ key: i + 1, label: describePackage(p), desc: p }))
    ]));
    console.log(UI.c("dim", "  Có thể nhập nhiều số, cách nhau bằng dấu cách"));

    const choice = (await ask(rl, UI.prompt("Chọn package"))).trim();
    const selected = choice === "0"
      ? packages
      : [...new Set(choice.split(/\s+/).map((s) => parseInt(s, 10) - 1).filter((i) => i >= 0 && i < packages.length).map((i) => packages[i]))];
    if (!selected.length) { console.log(UI.msg("error", "Không có package hợp lệ được chọn.")); return false; }

    const configs = loadConfigs();
    let ok = 0;
    const skipped = [];
    for (const packageName of selected) {
      UI.screen("Cấu hình tài khoản", describePackage(packageName));
      const cookie = getRobloxCookie(packageName);
      if (!cookie) { skipped.push(packageName); continue; }
      const user = new RobloxUser(null, null, cookie);
      const userId = await user.fetchAuthenticatedUser();
      if (!userId) { console.log(UI.msg("error", "Không xác thực được tài khoản.")); skipped.push(packageName); continue; }
      console.log(UI.msg("success", `Tài khoản ${maskSensitive(user.username)} (ID ${maskSensitive(userId)})`));

      let game;
      try { game = await new GameSelector().chooseGame(rl, cookie); } catch (e) {
        console.log(UI.msg("warning", `${e.message} — bỏ qua ${describePackage(packageName)}.`));
        skipped.push(packageName);
        continue;
      }
      const delaySec = await this.askDelay(rl);
      configs[packageName] = { username: user.username, userId, placeId: game.placeId, gameName: game.name, linkCode: game.linkCode, delaySec, packageName };
      ok++;
      console.log(UI.msg("success", `${describePackage(packageName)} • ${game.name} • quét mỗi ${delaySec}s`));
    }

    const saved = saveConfigs(configs);
    console.log(UI.card([
      ["Thành công", String(ok), ok ? "good" : "bad"],
      ["Bỏ qua", String(skipped.length), skipped.length ? "warn" : "dim"],
      ["Lưu file", saved ? "THÀNH CÔNG" : "THẤT BẠI", saved ? "good" : "bad"]
    ], "KẾT QUẢ THIẾT LẬP"));
    if (!saved || !ok || skipped.length) return false;
    this.notice = { type: "success", text: `Đã thiết lập ${ok} package.` };
    return true;
  }

  async askDelay(rl) {
    while (true) {
      const n = parseInt(await ask(rl, UI.prompt("Nhịp kiểm tra [30-120 giây]")), 10) || 0;
      if (n >= MIN_CHECK_SEC && n <= 120) return n;
      console.log(UI.msg("error", "Giá trị phải nằm trong khoảng 30-120 giây."));
    }
  }

  async editConfigs(rl) {
    while (true) {
      const configs = loadConfigs();
      const names = Object.keys(configs);
      UI.screen("Sửa / xoá cấu hình");
      if (!names.length) { console.log(UI.msg("warning", "Chưa có cấu hình. Chạy mục 2 trước.")); return false; }
      console.log(UI.options([
        ...names.map((n, i) => {
          const c = configs[n];
          return { key: i + 1, label: `${packageLabel(n)} • ${maskSensitive(c.username)}`, desc: `${c.gameName || "?"} (${c.placeId}) • ${c.delaySec}s${c.linkCode ? " • VIP" : ""}` };
        }),
        { key: "0", label: "Quay lại", color: "bad" }
      ]));
      const idx = parseInt((await ask(rl, UI.prompt("Chọn cấu hình"))).trim(), 10);
      if (!idx) return true;
      const name = names[idx - 1];
      if (!name) { console.log(UI.msg("warning", "Lựa chọn không hợp lệ.")); await sleep(700); continue; }

      console.log(UI.options([
        { key: "1", label: "Đổi game" }, { key: "2", label: "Đổi nhịp kiểm tra" }, { key: "3", label: "Xoá cấu hình này", color: "bad" }, { key: "0", label: "Quay lại" }
      ]));
      const act = (await ask(rl, UI.prompt("Chọn"))).trim();
      try {
        if (act === "1") {
          const cookie = getRobloxCookie(name);
          const game = await new GameSelector().chooseGame(rl, cookie);
          Object.assign(configs[name], { placeId: game.placeId, gameName: game.name, linkCode: game.linkCode });
          saveConfigs(configs);
        } else if (act === "2") {
          configs[name].delaySec = await this.askDelay(rl);
          saveConfigs(configs);
        } else if (act === "3") {
          delete configs[name];
          saveConfigs(configs);
        }
      } catch (e) {
        console.log(UI.msg("warning", e.message));
        await sleep(1200);
      }
    }
  }

  async configurePrefix(rl) {
    UI.screen("Prefix package", `Hiện tại: ${loadPrefix()}`);
    const v = (await ask(rl, UI.prompt("Prefix mới (Enter = giữ nguyên, ví dụ com.roblox)"))).trim();
    if (!v) return true;
    if (!savePrefix(v)) { console.log(UI.msg("error", "Prefix chỉ gồm chữ, số, dấu _ và dấu chấm.")); return false; }
    this.notice = { type: "success", text: `Đã đổi prefix thành ${v}` };
    return true;
  }

  // ---------- KHỞI ĐỘNG GIÁM SÁT ----------
  async askRunOptions(rl, selected, configs) {
    const saved = loadRunOptions();
    let autoRejoinMin;
    while (true) {
      const raw = (await ask(rl, UI.prompt(`Auto rejoin mỗi X phút [0 = tắt, Enter = ${saved.autoRejoinMin}]`))).trim();
      if (raw === "") { autoRejoinMin = saved.autoRejoinMin; break; }
      const n = Number(raw);
      if (Number.isInteger(n) && n >= 0 && n <= 1440) { autoRejoinMin = n; break; }
      console.log(UI.msg("error", "Nhập số phút nguyên từ 0 đến 1440 (0 = tắt)."));
    }
    let lowPop = false;
    if (selected.every((p) => configs[p] && configs[p].linkCode)) {
      console.log(UI.msg("info", "Tất cả package dùng server VIP nên bỏ qua join server ít người."));
    } else {
      while (true) {
        const raw = (await ask(rl, UI.prompt(`Join server ít người? [y/n, Enter = ${saved.lowPop ? "y" : "n"}]`))).trim().toLowerCase();
        if (raw === "") { lowPop = saved.lowPop; break; }
        if (["y", "yes", "c", "co", "có"].includes(raw)) { lowPop = true; break; }
        if (["n", "no", "k", "khong", "không"].includes(raw)) { lowPop = false; break; }
        console.log(UI.msg("error", "Nhập y hoặc n."));
      }
    }
    const options = { autoRejoinMin, lowPop };
    saveRunOptions(options);
    return options;
  }

  async startAutoRejoin(rl) {
    UI.screen("Khởi động Auto Rejoin", "Chọn instance cần chạy");
    const configs = loadConfigs();
    const names = Object.keys(configs).filter((n) => {
      const c = configs[n];
      return c && c.userId && c.placeId && c.delaySec;
    });
    if (!names.length) {
      console.log(UI.card([["Trạng thái", "CHƯA CÓ CẤU HÌNH HỢP LỆ", "bad"], ["Hướng dẫn", "Chạy mục 2: Thiết lập package"]], "KHÔNG THỂ TIẾP TỤC"));
      return false;
    }
    const installed = new Set(detectRobloxPackages());
    const missing = names.filter((n) => !installed.has(n));
    if (missing.length) console.log(UI.msg("warning", `Package chưa cài / sai prefix: ${missing.map(packageLabel).join(", ")}`));
    const usable = names.filter((n) => installed.has(n));
    if (!usable.length) return false;

    console.log(UI.options([
      { key: "0", label: "Chạy tất cả package", desc: `${usable.length} instance`, color: "good" },
      ...usable.map((n, i) => ({ key: i + 1, label: packageLabel(n), desc: `${maskSensitive(configs[n].username)} • ${configs[n].gameName || "?"}` }))
    ]));
    console.log(UI.c("dim", "  Có thể chọn nhiều số, cách nhau bằng dấu cách"));
    const choice = (await ask(rl, UI.prompt("Chọn package cần chạy"))).trim();
    const selected = choice === "0"
      ? usable
      : [...new Set(choice.split(/\s+/).map((s) => parseInt(s, 10) - 1).filter((i) => i >= 0 && i < usable.length).map((i) => usable[i]))];
    if (!selected.length) { console.log(UI.msg("error", "Lựa chọn không hợp lệ.")); return false; }

    const options = await this.askRunOptions(rl, selected, configs);
    return this.initInstances(selected, configs, rl, options);
  }

  async initInstances(selected, configs, rl, options) {
    this.runOptions = options;
    const autoRejoinMs = (Number(options.autoRejoinMin) || 0) * 60 * 1000;
    this.instances = [];
    this.startTime = Date.now();

    for (const packageName of selected) {
      const config = configs[packageName];
      const cookie = getRobloxCookie(packageName);
      if (!cookie) { console.log(UI.msg("error", `Không lấy được cookie cho ${packageName}, bỏ qua...`)); continue; }
      this.instances.push({
        packageName,
        label: packageLabel(packageName),
        userMasked: maskSensitive(config.username),
        user: new RobloxUser(config.username, config.userId, cookie),
        config,
        delayMs: Math.max(MIN_CHECK_SEC, Number(config.delaySec) || 30) * 1000,
        statusHandler: new StatusHandler(),
        status: "Khởi tạo...",
        info: "Đang chuẩn bị...",
        nextCheckAt: 0,
        rejoinCount: 0,
        autoRejoinMs,
        nextAutoRejoinAt: autoRejoinMs ? Date.now() + autoRejoinMs : 0,
        lowPop: Boolean(options.lowPop) && !config.linkCode,
        lastJobId: null,
        cookieRefreshAt: 0,
        targetUniverseId: null
      });
    }
    if (!this.instances.length) {
      console.log(UI.card([["Kết quả", "KHÔNG THỂ KHỞI ĐỘNG", "bad"], ["Khắc phục", "Đăng nhập Roblox trên package đó rồi chạy lại"]], "AUTO REJOIN THẤT BẠI"));
      return false;
    }
    console.log(UI.msg("success", `Khởi động ${this.instances.length} instance — bắt đầu sau 2 giây...`));
    await sleep(2000);
    this.running = true;
    await this.runLoop(rl);
    return true;
  }

  // ---------- PHÍM TẮT ----------
  bindLiveKeys(rl) {
    if (!process.stdin.isTTY) return () => { };
    this.rlExpectedClose = true;
    try { rl.close(); } catch (_) { }
    const onData = (buf) => {
      const s = String(buf);
      if (s.includes("\x03")) return gracefulShutdown("SIGINT");
      if (/q/i.test(s)) return gracefulShutdown("Q");
      if (/r/i.test(s)) {
        for (const i of this.instances) i.nextCheckAt = 0;
        this.logEvent("info", "Kiểm tra ngay theo yêu cầu (phím R)");
        this.repaint = true;
        wakeLoop();
      }
    };
    try { process.stdin.setRawMode(true); } catch (_) { }
    process.stdin.resume();
    process.stdin.on("data", onData);
    return () => {
      process.stdin.off("data", onData);
      try { process.stdin.setRawMode(false); } catch (_) { }
      process.stdin.pause();
    };
  }

  // ---------- LOGIC GIÁM SÁT ----------
  /** Kiểm tra 1 instance; cookie 401 thì đọc lại cookie (tối đa 1 lần / 3 phút). */
  async checkInstance(inst) {
    let check = await inst.user.checkPresence();
    if (check.error && check.status === 401) {
      const now = Date.now();
      if (now - inst.cookieRefreshAt >= COOKIE_REFRESH_MS) {
        inst.cookieRefreshAt = now;
        const fresh = getRobloxCookie(inst.packageName);
        if (fresh && fresh !== inst.user.cookie) {
          inst.user.cookie = fresh;
          inst.user.csrf = null;
          check = await inst.user.checkPresence();
        }
      }
    }
    return check;
  }

  /** Mở game cho 1 instance (sv ít người nếu bật; forced = auto rejoin: dừng hẳn app trước). */
  async launchInstance(inst, { forced = false } = {}) {
    const { config, statusHandler, label } = inst;
    let jobId = null;
    let note = config.linkCode ? " (server VIP)" : "";

    if (inst.lowPop && !config.linkCode) {
      const found = await ServerFinder.findLowest(config.placeId, { exclude: inst.lastJobId });
      if (found.ok) {
        jobId = found.jobId;
        inst.lastJobId = jobId;
        note = ` (sv ít người ${found.playing}/${found.maxPlayers}, quét ${found.scanned})`;
      } else {
        this.logEvent("warning", `${label}: không tìm được server ít người (${found.error}) — vào server thường`);
      }
    }
    if (forced && HARD_STOP_ON_REJOIN) {
      await forceStop(inst.packageName);
      await sleep(2000);
    }

    const result = await launchGame(config.placeId, config.linkCode, config.packageName, jobId);
    if (result.ok) {
      statusHandler.updateJoinStatus(true);
      inst.rejoinCount++;
      if (inst.autoRejoinMs) inst.nextAutoRejoinAt = Date.now() + inst.autoRejoinMs;
      if (forced) { inst.status = "Auto rejoin"; inst.info = `Rejoin định kỳ mỗi ${this.runOptions.autoRejoinMin} phút`; }
      this.logEvent("success", `${label}: ${forced ? "auto rejoin" : "đã gửi lệnh mở game"}${note} — lần ${inst.rejoinCount}`);
    } else {
      inst.status = "Lỗi mở game";
      inst.info = result.error || "am start thất bại";
      if (inst.autoRejoinMs) inst.nextAutoRejoinAt = Date.now() + 60 * 1000;
      this.logEvent("error", `${label}: mở game thất bại — ${inst.info}`);
    }
    return result;
  }

  async tick() {
    let launched = 0;

    for (const inst of this.instances) {
      if (inst.autoRejoinMs > 0 && Date.now() >= inst.nextAutoRejoinAt) {
        if (launched++ > 0) await sleep(LAUNCH_STAGGER_MS);
        await this.launchInstance(inst, { forced: true });
        inst.nextCheckAt = Date.now() + inst.delayMs;
      }
    }

    const now = Date.now();
    const due = this.instances.filter((i) => now >= i.nextCheckAt);
    if (!due.length) return;

    // Kiểm tra song song (mỗi request có timeout riêng nên không thể treo cả vòng).
    const results = await Promise.all(due.map(async (inst) => {
      try { return { inst, check: await this.checkInstance(inst) }; } catch (e) {
        return { inst, check: { presence: null, error: describeNetError(e) } };
      }
    }));

    for (const { inst, check } of results) {
      const { config, statusHandler, label } = inst;
      const pr = check && check.presence;
      if (!inst.targetUniverseId && pr && pr.userPresenceType === 2 && config.placeId) {
        try { inst.targetUniverseId = await universeOfCached(config.placeId); } catch (_) { /* so theo placeId */ }
      }
      const analysis = statusHandler.evaluate(check, config.placeId, Date.now(), inst.targetUniverseId);
      const previous = String(inst.status || "").trim();

      inst.nextCheckAt = Date.now() + inst.delayMs + (check && check.status === 429 ? RATE_LIMIT_BACKOFF_MS : 0);
      inst.status = analysis.status;
      inst.info = analysis.info;

      if (previous !== analysis.status) {
        const tone = statusTone(analysis.status);
        const level = tone === "good" ? "success" : tone === "bad" ? "error" : tone === "warn" ? "warning" : "info";
        const arrow = previous && !previous.includes("Khởi tạo") ? `${previous} → ` : "";
        this.logEvent(level, `${label}: ${arrow}${analysis.status}`);
      }
      if (analysis.shouldLaunch) {
        if (launched++ > 0) await sleep(LAUNCH_STAGGER_MS);
        await this.launchInstance(inst);
      }
    }
  }

  // ---------- GIAO DIỆN GIÁM SÁT (vẽ mỗi 10 giây) ----------
  buildFrame(paintCount) {
    const w = UI.width(110);
    const inner = w - 4;
    const now = Date.now();
    const beat = UI.c("good", paintCount % 4 === 3 ? "○" : "●");
    const lines = [];

    const inGame = this.instances.filter((i) => IN_GAME.has(String(i.status).trim())).length;
    const errors = this.instances.filter((i) => ERROR_STATUS.has(String(i.status).trim())).length;
    const rejoins = this.instances.reduce((s, i) => s + i.rejoinCount, 0);
    const up = Math.max(0, Math.floor((now - this.startTime) / 1000));
    const gb = (v) => (v / 1073741824).toFixed(1);
    const total = os.totalmem();

    lines.push(UI.split("  " + UI.c("accent", "◆ R E J O I N  L I T E"), UI.c("dim", "LIVE ") + beat + UI.c("dim", ` ${clock(now)}  `), w));
    lines.push(UI.c("muted", "─".repeat(w)));

    const summary = [
      UI.c("accent", UI.fit(`RAM ${gb(total - os.freemem())}/${gb(total)}GB • bot ${(process.memoryUsage().rss / 1048576).toFixed(0)}MB`, inner)),
      beat + " " + UI.c(errors ? "warn" : "dim", UI.fit(`UP ${pad2(Math.floor(up / 3600))}:${pad2(Math.floor((up % 3600) / 60))}:${pad2(up % 60)} • ↻ ${rejoins} • lỗi ${errors} • ${inGame}/${this.instances.length} trong game`, inner - 2))
    ];
    lines.push(UI.box("TỔNG QUAN", summary, w));

    const rows = [];
    this.instances.forEach((inst, idx) => {
      const tone = statusTone(inst.status);
      const status = String(inst.status || "Không rõ").trim();
      const dot = tone === "accent" ? SPIN[paintCount % SPIN.length] : tone === "good" && paintCount % 4 === 3 ? "○" : "●";
      const meta = `↻${inst.rejoinCount} · ${fmtCountdown((inst.nextCheckAt - now) / 1000)}`;
      const leftW = Math.max(6, inner - UI.vlen(meta) - 1);
      rows.push(UI.split(
        UI.c(tone, dot) + " " + UI.c("accent", UI.fit(`${inst.label} ${inst.userMasked}`, leftW - 2)),
        UI.c("violet", meta), inner));
      const room = inner - 2;
      const st = UI.fit(status, Math.min(status.length, room));
      const infoRoom = room - UI.vlen(st) - 2;
      rows.push("  " + UI.c(tone, st) + (infoRoom >= 6 ? "  " + UI.c("dim", UI.fit(inst.info || "-", infoRoom)) : ""));
      if (idx < this.instances.length - 1) rows.push(UI.c("muted", "┄".repeat(inner)));
    });
    lines.push(UI.box(`INSTANCES ${this.instances.length}`, rows, w));

    const segs = [];
    const auto = this.instances.filter((i) => i.autoRejoinMs > 0);
    if (auto.length) {
      const next = Math.min(...auto.map((i) => i.nextAutoRejoinAt));
      segs.push(`Auto rejoin ${this.runOptions.autoRejoinMin}p • kế tiếp ${fmtCountdown((next - now) / 1000)}`);
    }
    if (this.instances.some((i) => i.lowPop)) segs.push("Sv ít người bật");
    if (segs.length) lines.push(UI.c("good", "●") + " " + UI.c("dim", UI.fit(segs.join(" • "), w - 2)));

    const used = lines.join("\n").split("\n").length;
    const rowsAvail = process.stdout.rows || 0;
    const room = rowsAvail ? clamp(rowsAvail - used - 4, 0, 8) : 4;
    if (room >= 3 && this.events.length) {
      const icons = { error: ["bad", "✕"], warning: ["warn", "!"], success: ["good", "✓"], info: ["accent", "•"] };
      const evLines = this.events.slice(-(room - 2)).map((ev) => {
        const [tone, icon] = icons[ev.level] || icons.info;
        return UI.c("dim", clock(ev.at)) + " " + UI.c(tone, icon) + " " + UI.c("text", UI.fit(ev.text, Math.max(1, inner - 11)));
      });
      lines.push(UI.box("NHẬT KÝ", evLines, w));
    }

    lines.push("  " + (process.stdin.isTTY
      ? `${UI.c("text", "Q")} dừng   ${UI.c("text", "R")} kiểm tra ngay   ${UI.c("dim", "làm mới 10s")}`
      : `${UI.c("text", "CTRL+C")} dừng`));
    return lines.join("\n");
  }

  async runLoop(rl) {
    this.events = [];
    this.repaint = false;
    const restoreConsole = captureConsole((method, text) => {
      let level = method === "error" ? "error" : method === "warn" ? "warning" : "info";
      if (/^\s*\[\+\]/.test(text)) level = "success";
      else if (/^\s*\[-\]/.test(text)) level = "error";
      this.logEvent(level, text.replace(/^\s*\[[+\-*!]\]\s*/, ""));
    });
    const unbindKeys = this.bindLiveKeys(rl);
    const onResize = () => { this.repaint = true; wakeLoop(); };
    if (process.stdout.isTTY) process.stdout.on("resize", onResize);

    const paintEvery = process.stdout.isTTY ? LIVE_REFRESH_MS : 60 * 1000;
    let paintCount = 0;
    let lastPaintAt = 0;
    if (process.stdout.isTTY) process.stdout.write("\x1b[2J");

    try {
      this.logEvent("info", `Bắt đầu giám sát ${this.instances.length} instance`);
      while (this.running) {
        try { await this.tick(); } catch (e) { this.logEvent("error", `Lỗi vòng giám sát: ${e.message}`); }

        const now = Date.now();
        if (this.repaint || now - lastPaintAt >= paintEvery - 250) {
          this.repaint = false;
          lastPaintAt = now;
          let frame;
          try { frame = this.buildFrame(paintCount++); } catch (e) { frame = `\n  R E J O I N\n  ${e.message}`; }
          UI.paint(frame);
        }

        // Ngủ thẳng tới mốc việc kế tiếp (kiểm tra / auto rejoin / vẽ lại) — không thức dậy mỗi giây.
        let next = lastPaintAt + paintEvery;
        for (const i of this.instances) {
          if (i.nextCheckAt < next) next = i.nextCheckAt;
          if (i.autoRejoinMs && i.nextAutoRejoinAt < next) next = i.nextAutoRejoinAt;
        }
        await napFor(clamp(next - Date.now(), 250, paintEvery));
      }
    } finally {
      if (process.stdout.isTTY) process.stdout.off("resize", onResize);
      restoreConsole();
      unbindKeys();
    }
  }
}

/** Chuyển console.* vào sink để log chen ngang không làm vỡ khung hình. Trả về hàm khôi phục. */
function captureConsole(sink) {
  const methods = ["log", "info", "warn", "error"];
  const saved = {};
  for (const m of methods) {
    saved[m] = console[m];
    console[m] = (...args) => { try { sink(m, util.format(...args)); } catch (_) { } };
  }
  return () => { for (const m of methods) console[m] = saved[m]; };
}

// ======================= THOÁT AN TOÀN =======================
const rawLog = console.log.bind(console);
let shuttingDown = false;
function gracefulShutdown(signal = "SIGINT") {
  if (shuttingDown) return;
  shuttingDown = true;
  rawLog(`\n\n Đang dừng chương trình (${signal})...`);
  disableWakeLock();
  rawLog(" Đã tắt wake lock. REJOIN LITE đã dừng.");
  process.exit(0);
}

function main() {
  process.on("exit", () => {
    if (process.stdout.isTTY) process.stdout.write("\x1b[?25h");
    try { if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false); } catch (_) { }
    disableWakeLock();
  });
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("unhandledRejection", (r) => console.error(`[-] Lỗi bất đồng bộ: ${r && r.stack ? r.stack : r}`));
  process.on("uncaughtException", (e) => console.error(`[-] Lỗi không xử lý: ${e && e.stack ? e.stack : e}`));

  new RejoinLite().start().catch((e) => {
    console.error(`[-] Tool dừng do lỗi: ${e && e.stack ? e.stack : e}`);
    disableWakeLock();
    process.exitCode = 1;
  });
}

if (require.main === module) main();
else module.exports = { StatusHandler, GameSelector, RobloxUser, ServerFinder, RejoinLite, UI, fmtCountdown, statusTone };
