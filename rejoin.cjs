#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * rejoin.cjs - Pro Max (Termux/Android edition)
 * CommonJS, zero hard ESM deps. Node >= 16.
 *
 * Fix focus:
 *   1) Input queue + single readline (rl.question mất dòng khi pipe stdin)
 *   2) Cookie handling + AUTH(401)/RATE(429) classification + backoff
 *   3) Presence API rotation + rejoin loop
 *   4) Termux-aware launcher (am / termux-open) với thông báo lỗi rõ ràng
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { spawnSync } = require("child_process");

const VERSION = "3.0.0-promax";
const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, "config.json");
const TMP_DIR = path.join(ROOT, ".tmp");
const IS_TERMUX =
  !!process.env.TERMUX_VERSION ||
  (process.env.PREFIX || "").includes("com.termux");

/* ────────────────────────── utils: màu + box ────────────────────────── */

const NO_COLOR = !!process.env.NO_COLOR || !process.stdout.isTTY;
const c = (code) => (s) => (NO_COLOR ? String(s) : `\x1b[${code}m${s}\x1b[0m`);
const C = {
  dim: c("2"), bold: c("1"), red: c("31"), green: c("32"),
  yellow: c("33"), blue: c("34"), magenta: c("35"), cyan: c("36"),
};

const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
const visLen = (s) => [...stripAnsi(s)].length;

/** drawBox: thay thế boxen (boxen v6+ là ESM, require() sẽ nổ) */
function drawBox(input, opts = {}) {
  const { title = "", padding = 1, color = C.cyan } = opts;
  const lines = String(input).split("\n");
  const inner = Math.max(
    ...lines.map(visLen),
    visLen(title) + 2,
    10
  );
  const w = inner + padding * 2;
  const pad = " ".repeat(padding);
  const top = title
    ? `┌─ ${title} ${"─".repeat(Math.max(0, w - visLen(title) - 3))}┐`
    : `┌${"─".repeat(w)}┐`;
  const bot = `└${"─".repeat(w)}┘`;
  const body = lines.map(
    (l) => `│${pad}${l}${" ".repeat(Math.max(0, inner - visLen(l)))}${pad}│`
  );
  return [top, ...body, bot].map((l) => color(l)).join("\n");
}

const log = {
  info: (m) => console.log(`${C.blue("[i]")} ${m}`),
  ok: (m) => console.log(`${C.green("[✓]")} ${m}`),
  warn: (m) => console.log(`${C.yellow("[!]")} ${m}`),
  err: (m) => console.log(`${C.red("[x]")} ${m}`),
  dim: (m) => console.log(C.dim(`    ${m}`)),
};

/** shQuote: bọc an toàn cho shell, chống command injection */
function shQuote(s) {
  const str = String(s);
  if (str === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(str)) return str;
  return "'" + str.replace(/'/g, `'\\''`) + "'";
}

/** atomicWrite: ghi tmp rồi rename -> không bao giờ để lại file hỏng */
function atomicWrite(file, data, mode = 0o600) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  const fd = fs.openSync(tmp, "w", mode);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ────────────────────────── config ────────────────────────── */

const DEFAULT_CONFIG = {
  cooldownSec: 90,
  maxRetries: 5,
  requestTimeoutMs: 12000,
  reloadCookieEachCycle: true,
  webhookEnabled: false,
  webhookUrl: "",
  userId: "",
  cookiePath: "",
  packages: {},
  autoexec: "",
};

const NUMERIC_KEYS = new Set([
  "cooldownSec", "maxRetries", "requestTimeoutMs",
]);
const BOOL_KEYS = new Set(["reloadCookieEachCycle", "webhookEnabled"]);

function loadConfig() {
  let cfg = { ...DEFAULT_CONFIG };
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      // merge, KHÔNG ghi đè key lạ của user
      cfg = { ...cfg, ...raw, packages: { ...(raw.packages || {}) } };
    } catch (e) {
      log.err(`config.json hỏng (${e.message}) → dùng mặc định, file cũ giữ nguyên.`);
    }
  }
  return cfg;
}

function saveConfig(cfg) {
  atomicWrite(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", 0o600);
}

function coerceValue(key, raw) {
  if (NUMERIC_KEYS.has(key)) {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`"${key}" phải là số`);
    return n;
  }
  if (BOOL_KEYS.has(key)) {
    if (/^(true|1|yes|y|on)$/i.test(raw)) return true;
    if (/^(false|0|no|n|off)$/i.test(raw)) return false;
    throw new Error(`"${key}" phải là true/false`);
  }
  return String(raw);
}

/* ────────── FIX #1: input queue dùng CHUNG một readline ────────── */
/**
 * Vấn đề gốc: rl.question() resolve trong microtask. Khi stdin là pipe,
 * mọi 'line' event phát gần như cùng lúc -> các dòng sau rơi vào khoảng
 * trống giữa hai lần question() và bị mất.
 * Giải pháp: một listener 'line' duy nhất, đẩy vào hàng đợi; ask() lấy từ
 * hàng đợi nếu đã có sẵn, ngược lại chờ.
 */
class InputQueue {
  constructor() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY === true,
    });
    this.buffer = [];
    this.waiters = [];
    this.closed = false;
    this.rl.on("line", (line) => {
      if (this.waiters.length) this.waiters.shift().resolve(line);
      else this.buffer.push(line);
    });
    this.rl.on("close", () => {
      this.closed = true;
      while (this.waiters.length) this.waiters.shift().resolve(null);
    });
  }
  /** @returns {Promise<string|null>} null = stdin đã đóng (EOF) */
  next() {
    if (this.buffer.length) return Promise.resolve(this.buffer.shift());
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push({ resolve }));
  }
  async ask(prompt) {
    if (prompt) process.stdout.write(prompt);
    const line = await this.next();
    if (line === null) {
      if (prompt) process.stdout.write("\n");
      return "";
    }
    return line.trim();
  }
  /** chờ Enter, nhưng có thể bị huỷ (dùng cho vòng lặp rejoin) */
  waitEnter() {
    let cancelled = false;
    const p = (async () => {
      const v = await this.next();
      return cancelled ? null : v;
    })();
    return { promise: p, cancel: () => { cancelled = true; } };
  }
  close() { try { this.rl.close(); } catch (_) {} }
}

/* ────────────────────────── HTTP + phân loại lỗi ────────────────────────── */

class HttpError extends Error {
  constructor(kind, status, message, retryAfterMs = 0) {
    super(message);
    this.kind = kind;           // AUTH | RATE | NET | HTTP | TIMEOUT
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function classify(status, headers, body) {
  if (status === 401 || status === 403) {
    return new HttpError("AUTH", status, "Cookie hết hạn hoặc không hợp lệ (401/403)");
  }
  if (status === 429) {
    const ra = Number(headers?.get?.("retry-after") || 0);
    return new HttpError(
      "RATE", status, "Bị giới hạn tốc độ (429)",
      Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0
    );
  }
  if (status >= 400) {
    return new HttpError("HTTP", status, `HTTP ${status}: ${String(body).slice(0, 200)}`);
  }
  return null;
}

async function httpJson(url, { method = "GET", headers = {}, body, timeoutMs = 12000 } = {}) {
  if (typeof fetch !== "function") {
    throw new HttpError("NET", 0,
      "Node của bạn không có fetch (cần Node >= 18). Trong Termux: pkg upgrade nodejs");
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { "User-Agent": `rejoin-promax/${VERSION}`, ...headers },
      body,
      signal: ctrl.signal,
    });
    const text = await res.text();
    const e = classify(res.status, res.headers, text);
    if (e) throw e;
    try { return { status: res.status, json: text ? JSON.parse(text) : null, text }; }
    catch (_) { return { status: res.status, json: null, text }; }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err.name === "AbortError") {
      throw new HttpError("TIMEOUT", 0, `Quá thời gian chờ ${timeoutMs}ms`);
    }
    throw new HttpError("NET", 0, `Lỗi mạng: ${err.message}`);
  } finally {
    clearTimeout(t);
  }
}

/** backoff luỹ thừa + jitter, tôn trọng Retry-After */
function backoffMs(attempt, err) {
  if (err && err.retryAfterMs > 0) return err.retryAfterMs;
  const base = Math.min(30000, 1000 * Math.pow(2, attempt));
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

/* ────────── FIX #2: cookie an toàn (copy .tmp, chmod 600, -wal/-shm) ────────── */

function defaultCookieCandidates() {
  const home = os.homedir();
  return [
    path.join(ROOT, "cookie.txt"),
    path.join(home, ".roblosecurity"),
    path.join(home, "storage", "shared", "cookie.txt"),
    path.join(home, "cookies.sqlite"),
  ];
}

/**
 * Trả về { value, cleanup }. Nếu nguồn là file DB (sqlite), copy vào .tmp
 * kèm -wal/-shm với chmod 600 rồi mới đọc. cleanup() luôn được gọi trong finally.
 */
function acquireCookie(cfg) {
  const explicit = cfg.cookiePath && cfg.cookiePath.trim();
  const envCookie = process.env.ROBLOSECURITY;
  const created = [];
  const cleanup = () => {
    for (const f of created) { try { fs.rmSync(f, { force: true }); } catch (_) {} }
    created.length = 0;
  };

  if (envCookie && envCookie.trim()) {
    return { value: envCookie.trim(), source: "$ROBLOSECURITY", cleanup };
  }

  const candidates = explicit ? [explicit] : defaultCookieCandidates();
  const src = candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } });
  if (!src) {
    cleanup();
    throw new HttpError("AUTH", 0,
      "Không tìm thấy cookie.\n" +
      "  • Đặt biến môi trường: export ROBLOSECURITY='_|WARNING...'\n" +
      `  • Hoặc tạo file: ${path.join(ROOT, "cookie.txt")}\n` +
      "  • Hoặc set cookiePath trong config.json");
  }

  fs.mkdirSync(TMP_DIR, { recursive: true, mode: 0o700 });
  const dst = path.join(TMP_DIR, `cookie.${process.pid}`);
  fs.copyFileSync(src, dst);
  fs.chmodSync(dst, 0o600);
  created.push(dst);
  // sqlite journal đi kèm
  for (const suf of ["-wal", "-shm"]) {
    if (fs.existsSync(src + suf)) {
      const d2 = dst + suf;
      fs.copyFileSync(src + suf, d2);
      fs.chmodSync(d2, 0o600);
      created.push(d2);
    }
  }

  let raw = fs.readFileSync(dst, "utf8");
  const m = raw.match(/_\|WARNING:[^\s"']+/);
  const value = (m ? m[0] : raw).trim();
  if (!value) { cleanup(); throw new HttpError("AUTH", 0, `File cookie rỗng: ${src}`); }
  return { value, source: src, cleanup };
}

/* ────────── FIX #3: presence API rotation + rejoin loop ────────── */

const PRESENCE_ENDPOINTS = [
  "https://presence.roblox.com/v1/presence/users",
  "https://presence.roproxy.com/v1/presence/users",
];
let presenceIdx = 0;

async function checkPresence(userIds, cookie, cfg) {
  const payload = JSON.stringify({ userIds: userIds.map(Number) });
  const headers = {
    "Content-Type": "application/json",
    Cookie: `.ROBLOSECURITY=${cookie}`,
  };
  const order = [
    PRESENCE_ENDPOINTS[presenceIdx % PRESENCE_ENDPOINTS.length],
    PRESENCE_ENDPOINTS[(presenceIdx + 1) % PRESENCE_ENDPOINTS.length],
  ];
  presenceIdx++;

  let lastErr;
  for (const url of order) {
    const t0 = Date.now();
    try {
      const r = await httpJson(url, {
        method: "POST", headers, body: payload,
        timeoutMs: cfg.requestTimeoutMs,
      });
      return { data: r.json, endpoint: url, ms: Date.now() - t0 };
    } catch (e) {
      lastErr = e;
      if (e.kind === "AUTH") throw e;       // đổi endpoint không cứu được 401
      log.dim(`${url} lỗi (${e.kind}) → thử endpoint kế tiếp`);
    }
  }
  throw lastErr;
}

/** kiểm tra song song nhiều user bằng Promise.all */
async function checkAllParallel(idGroups, cookie, cfg) {
  const results = await Promise.all(
    idGroups.map((g) =>
      checkPresence(g, cookie, cfg).then(
        (v) => ({ ok: true, ...v }),
        (e) => ({ ok: false, error: e })
      )
    )
  );
  return results;
}

const PRESENCE_TYPE = { 0: "Offline", 1: "Online (website)", 2: "Đang chơi", 3: "Studio", 4: "Vô hình" };

/* ────────── FIX #4: launcher Termux-aware, lỗi rõ ràng ────────── */

function hasBinary(bin) {
  const r = spawnSync("sh", ["-c", `command -v ${shQuote(bin)} >/dev/null 2>&1`]);
  return r.status === 0;
}

function launchPackage(pkg, placeId) {
  const deepLink = placeId
    ? `roblox://placeId=${encodeURIComponent(String(placeId))}`
    : null;

  if (!IS_TERMUX) {
    return {
      ok: false,
      reason:
        "Chỉ mở được app Roblox khi chạy trên Termux/Android.\n" +
        "  Trên Linux/WSL script vẫn theo dõi presence được, nhưng không tự mở game.",
    };
  }

  // ưu tiên am (Termux có sẵn qua /system/bin), fallback termux-open-url
  if (hasBinary("am")) {
    const args = deepLink
      ? `am start -a android.intent.action.VIEW -d ${shQuote(deepLink)} -n ${shQuote(pkg + "/com.roblox.client.ActivityProtocolLaunch")}`
      : `am start -n ${shQuote(pkg + "/com.roblox.client.ActivityProtocolLaunch")}`;
    const r = spawnSync("sh", ["-c", args], { encoding: "utf8" });
    if (r.error) {
      return { ok: false, reason: `Không chạy được "am": ${r.error.message}` };
    }
    if (r.status !== 0) {
      return {
        ok: false,
        reason:
          `"am" trả về mã ${r.status}.\n` +
          `  stderr: ${String(r.stderr || "").trim().slice(0, 300)}\n` +
          `  → Kiểm tra package "${pkg}" đã cài chưa: pm list packages | grep roblox`,
      };
    }
    return { ok: true, via: "am" };
  }

  if (deepLink && hasBinary("termux-open-url")) {
    const r = spawnSync("termux-open-url", [deepLink], { encoding: "utf8" });
    if (r.error) return { ok: false, reason: `termux-open-url lỗi: ${r.error.message}` };
    return { ok: true, via: "termux-open-url" };
  }

  return {
    ok: false,
    reason:
      "Không tìm thấy 'am' lẫn 'termux-open-url'.\n" +
      "  → pkg install termux-api  (và cài app Termux:API từ F-Droid)",
  };
}

/* ────────────────────────── webhook ────────────────────────── */

function validateWebhook(url) {
  let u;
  try { u = new URL(String(url)); } catch (_) { return "URL không hợp lệ"; }
  if (u.protocol !== "https:") return "Webhook phải dùng https";
  if (!/^(canary\.|ptb\.)?discord(app)?\.com$/.test(u.hostname))
    return `Host không được phép: ${u.hostname}`;
  if (!/^\/api\/webhooks\/\d+\/[\w-]+$/.test(u.pathname))
    return "Đường dẫn webhook Discord không đúng dạng /api/webhooks/<id>/<token>";
  return null;
}

async function sendWebhook(cfg, content) {
  if (!cfg.webhookEnabled) return { skipped: true };
  const bad = validateWebhook(cfg.webhookUrl);
  if (bad) { log.warn(`Webhook bị chặn: ${bad}`); return { skipped: true }; }
  try {
    await httpJson(cfg.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: String(content).slice(0, 1900) }),
      timeoutMs: cfg.requestTimeoutMs,
    });
    return { ok: true };
  } catch (e) {
    log.warn(`Gửi webhook thất bại (${e.kind} ${e.status}): ${e.message}`);
    return { ok: false };
  }
}

/* ────────────────────────── figlet (optional) ────────────────────────── */

function figletVersion() {
  // KHÔNG require("figlet/package.json") - exports map chặn subpath
  try {
    const entry = require.resolve("figlet");
    let dir = path.dirname(entry);
    for (let i = 0; i < 5; i++) {
      const pj = path.join(dir, "package.json");
      if (fs.existsSync(pj)) {
        const v = JSON.parse(fs.readFileSync(pj, "utf8"));
        if (v.name === "figlet") return v.version;
      }
      dir = path.dirname(dir);
    }
  } catch (_) {}
  return null;
}

function banner() {
  const v = figletVersion();
  try {
    if (v) {
      const figlet = require("figlet");
      return figlet.textSync("REJOIN", { font: "Standard" });
    }
  } catch (_) {}
  return `R E J O I N   P R O   M A X`;
}

/* ────────────────────────── diagnostics ────────────────────────── */

async function diagnostics(cfg) {
  const rows = [];
  rows.push(["Node", process.version]);
  rows.push(["Nền tảng", `${process.platform}/${process.arch}${IS_TERMUX ? " (Termux)" : ""}`]);
  rows.push(["fetch", typeof fetch === "function" ? "có" : "KHÔNG (cần Node>=18)"]);
  rows.push(["figlet", figletVersion() || "chưa cài (không bắt buộc)"]);
  rows.push(["am", hasBinary("am") ? "có" : "không"]);
  rows.push(["termux-open-url", hasBinary("termux-open-url") ? "có" : "không"]);

  let cookie = null, cleanup = () => {};
  try {
    const acq = acquireCookie(cfg);
    cookie = acq.value; cleanup = acq.cleanup;
    rows.push(["Cookie", `OK (nguồn: ${acq.source})`]);
  } catch (e) {
    rows.push(["Cookie", `LỖI — ${e.message.split("\n")[0]}`]);
  }

  console.log(drawBox(rows.map(([k, v]) => `${k.padEnd(16)} ${v}`).join("\n"),
    { title: "Chẩn đoán" }));

  if (!cookie) {
    log.err("Không có cookie → bỏ qua kiểm tra presence (đây là lỗi cấu hình, không phải crash).");
    return;
  }
  try {
    const id = Number(cfg.userId) || 1;
    const r = await checkPresence([id], cookie, cfg);
    log.ok(`Presence OK qua ${r.endpoint} (${r.ms}ms)`);
  } catch (e) {
    log.err(`Presence lỗi [${e.kind}] ${e.message}`);
  } finally {
    cleanup();
  }
}

/* ────────────────────────── rejoin loop ────────────────────────── */

async function rejoinLoop(cfg, q) {
  const pkgs = Object.entries(cfg.packages || {});
  if (!pkgs.length) { log.err("Chưa có package nào. Vào menu 3 để thêm."); return; }

  log.info(`Bắt đầu vòng lặp — cooldown ${cfg.cooldownSec}s. Nhấn Enter để dừng.`);
  let stop = false;
  const waiter = q.waitEnter();
  waiter.promise.then((v) => { if (v !== null) { stop = true; log.warn("Đã nhận tín hiệu dừng…"); } });

  let cookieBox = null;
  let attempt = 0;
  try {
    while (!stop) {
      // nạp lại cookie mỗi chu kỳ nếu bật (cookie Roblox xoay khá thường xuyên)
      if (!cookieBox || cfg.reloadCookieEachCycle) {
        if (cookieBox) cookieBox.cleanup();
        try { cookieBox = acquireCookie(cfg); }
        catch (e) { log.err(e.message); break; }
      }

      const withId = pkgs.filter(([, v]) => v && v.userId);
      try {
        if (withId.length) {
          const groups = withId.map(([, v]) => [Number(v.userId)]);
          const results = await checkAllParallel(groups, cookieBox.value, cfg);
          for (let i = 0; i < results.length; i++) {
            const [pkg, meta] = withId[i];
            const r = results[i];
            if (!r.ok) { throw r.error; }
            const p = r.data?.userPresences?.[0];
            const type = p ? (PRESENCE_TYPE[p.userPresenceType] || "?") : "?";
            log.info(`${C.bold(pkg)} → ${type} ${C.dim(`(${r.ms}ms)`)}`);
            if (p && p.userPresenceType !== 2) {
              const res = launchPackage(pkg, meta.placeId);
              if (res.ok) {
                log.ok(`Đã gửi lệnh mở lại (${res.via})`);
                await sendWebhook(cfg, `Rejoin: ${pkg} (place ${meta.placeId || "?"})`);
              } else {
                log.err(res.reason);
              }
            }
          }
        } else {
          // fallback: không có userId → chỉ thử mở app
          for (const [pkg, meta] of pkgs) {
            const res = launchPackage(pkg, meta && meta.placeId);
            if (res.ok) log.ok(`Đã gửi lệnh mở ${pkg} (${res.via})`);
            else log.err(res.reason);
          }
        }
        attempt = 0;
      } catch (e) {
        attempt++;
        if (e.kind === "AUTH") {
          log.err("Cookie hết hạn → thử nạp lại ở chu kỳ sau.");
          if (cookieBox) { cookieBox.cleanup(); cookieBox = null; }
        } else if (e.kind === "RATE") {
          log.warn("Bị 429 — lùi thời gian chờ.");
        } else {
          log.err(`[${e.kind}] ${e.message}`);
        }
        if (attempt >= cfg.maxRetries) {
          log.err(`Đã thử ${attempt} lần liên tiếp thất bại → dừng vòng lặp.`);
          break;
        }
        const wait = backoffMs(attempt, e);
        log.dim(`Chờ ${Math.round(wait / 1000)}s rồi thử lại (lần ${attempt}/${cfg.maxRetries})`);
        await sleep(wait);
        continue;
      }

      // ngủ theo cooldown nhưng vẫn phản hồi nhanh khi user nhấn Enter
      const until = Date.now() + cfg.cooldownSec * 1000;
      while (!stop && Date.now() < until) await sleep(250);
    }
  } finally {
    waiter.cancel();
    if (cookieBox) cookieBox.cleanup();
    log.info("Đã thoát vòng lặp, dọn dẹp xong.");
  }
}

/* ────────────────────────── menu ────────────────────────── */

const GAMES = {
  "1": { name: "Brookhaven RP", placeId: 4924922222 },
  "2": { name: "Blox Fruits", placeId: 2753915549 },
  "3": { name: "Pet Simulator 99", placeId: 8737899170 },
  "4": { name: "Adopt Me!", placeId: 920587237 },
};

async function chooseGame(q) {
  while (true) {
    console.log(drawBox(
      Object.entries(GAMES).map(([k, g]) => `${k}. ${g.name} ${C.dim(g.placeId)}`).join("\n") +
      "\n0. Nhập placeId thủ công / quay lại",
      { title: "Chọn game" }
    ));
    const a = await q.ask("> ");
    if (a === "0" || a === "") {
      const pid = await q.ask("placeId (bỏ trống để huỷ): ");
      if (!pid) return null;
      if (!/^\d+$/.test(pid)) { log.err("placeId phải là số."); continue; }
      return { name: `Custom ${pid}`, placeId: Number(pid) };
    }
    if (GAMES[a]) return GAMES[a];
    log.err("Lựa chọn không hợp lệ, thử lại.");
  }
}

async function setupPackages(cfg, q) {
  const pkg = await q.ask("Tên package (vd com.roblox.client): ");
  if (!pkg) return;
  if (!/^[a-zA-Z][\w.]*$/.test(pkg)) { log.err("Tên package không hợp lệ."); return; }
  const g = await chooseGame(q);
  if (!g) return;
  const uid = await q.ask("userId của tài khoản (bỏ trống nếu không dùng presence): ");
  if (uid && !/^\d+$/.test(uid)) { log.err("userId phải là số."); return; }
  // merge, không ghi đè các field cũ
  cfg.packages[pkg] = { ...(cfg.packages[pkg] || {}), placeId: g.placeId, game: g.name, ...(uid ? { userId: Number(uid) } : {}) };
  saveConfig(cfg);
  log.ok(`Đã lưu ${pkg} → ${g.name}`);
}

async function removePackage(cfg, q) {
  const keys = Object.keys(cfg.packages || {});
  if (!keys.length) { log.warn("Chưa có package nào."); return; }
  console.log(drawBox(keys.map((k, i) => `${i + 1}. ${k}`).join("\n"), { title: "Xoá package" }));
  const a = await q.ask("Số thứ tự (0 = huỷ): ");
  const i = Number(a) - 1;
  if (!keys[i]) { log.warn("Huỷ."); return; }
  delete cfg.packages[keys[i]];
  saveConfig(cfg);
  log.ok(`Đã xoá ${keys[i]}`);
}

async function configEditor(cfg, q) {
  const editable = [...NUMERIC_KEYS, ...BOOL_KEYS, "userId", "cookiePath", "webhookUrl", "autoexec"];
  console.log(drawBox(editable.map((k) => `${k.padEnd(20)} = ${JSON.stringify(cfg[k])}`).join("\n"),
    { title: "Cấu hình" }));
  const key = await q.ask("Key cần sửa (bỏ trống = quay lại): ");
  if (!key) return;
  if (!editable.includes(key)) { log.err(`Key "${key}" không tồn tại.`); return; }
  const raw = await q.ask(`Giá trị mới cho ${key}: `);
  try {
    cfg[key] = coerceValue(key, raw);
    if (key === "webhookUrl" && raw) {
      const bad = validateWebhook(raw);
      if (bad) log.warn(`URL lưu rồi nhưng sẽ bị chặn khi gửi: ${bad}`);
    }
    saveConfig(cfg);
    log.ok(`${key} = ${JSON.stringify(cfg[key])}`);
  } catch (e) { log.err(e.message); }
}

function writeAutoexec(cfg) {
  if (!cfg.autoexec) { log.warn("autoexec rỗng."); return; }
  const target = path.join(ROOT, "autoexec.lua");
  // tách "\n" dạng literal thành xuống dòng thật
  const content = String(cfg.autoexec).replace(/\\n/g, "\n");
  atomicWrite(target, content.endsWith("\n") ? content : content + "\n", 0o644);
  log.ok(`Đã ghi ${target} (${content.split("\n").length} dòng)`);
}

async function menu(cfg, q) {
  console.log(C.magenta(banner()));
  console.log(C.dim(`  v${VERSION} • ${IS_TERMUX ? "Termux" : process.platform} • Node ${process.version}\n`));
  while (true) {
    console.log(drawBox([
      "1. Bắt đầu vòng lặp rejoin",
      "2. Chẩn đoán (diagnostics)",
      "3. Thêm package",
      "4. Xoá package",
      "5. Sửa cấu hình",
      `6. Webhook: ${cfg.webhookEnabled ? C.green("BẬT") : C.dim("TẮT")} (bật/tắt + gửi thử)`,
      "7. Ghi autoexec.lua",
      "0. Thoát",
    ].join("\n"), { title: "Menu" }));
    const a = await q.ask("Chọn > ");
    switch (a) {
      case "1": await rejoinLoop(cfg, q); break;
      case "2": await diagnostics(cfg); break;
      case "3": await setupPackages(cfg, q); break;
      case "4": await removePackage(cfg, q); break;
      case "5": await configEditor(cfg, q); break;
      case "6": {
        cfg.webhookEnabled = !cfg.webhookEnabled;
        saveConfig(cfg);
        log.ok(`Webhook → ${cfg.webhookEnabled ? "BẬT" : "TẮT"}`);
        if (cfg.webhookEnabled) {
          const r = await sendWebhook(cfg, "Test từ rejoin.cjs Pro Max");
          if (r.ok) log.ok("Gửi thử thành công.");
        }
        break;
      }
      case "7": writeAutoexec(cfg); break;
      case "0": case "": return;
      default: log.err("Lựa chọn không hợp lệ.");
    }
  }
}

/* ────────────────────────── selftest ────────────────────────── */

async function selftest() {
  let pass = 0, fail = 0;
  const t = (name, fn) => {
    try { const r = fn(); if (r === false) throw new Error("assert false");
      console.log(`${C.green("PASS")} ${name}`); pass++; }
    catch (e) { console.log(`${C.red("FAIL")} ${name} — ${e.message}`); fail++; }
  };

  t("drawBox có viền cân", () => {
    const b = stripAnsi(drawBox("abc\nlonger line", { title: "T" })).split("\n");
    return new Set(b.map((l) => [...l].length)).size === 1;
  });
  t("shQuote roundtrip qua shell", () => {
    const evil = `a'b"c $(rm -rf /) \`x\` ;`;
    const r = spawnSync("sh", ["-c", `printf %s ${shQuote(evil)}`], { encoding: "utf8" });
    return r.stdout === evil;
  });
  t("atomicWrite + đọc lại", () => {
    const f = path.join(TMP_DIR, "t.json");
    atomicWrite(f, JSON.stringify({ a: 1 }));
    const ok = JSON.parse(fs.readFileSync(f, "utf8")).a === 1;
    fs.rmSync(f, { force: true });
    return ok;
  });
  t("coerceValue ép kiểu số/bool + báo lỗi", () => {
    if (coerceValue("cooldownSec", "77") !== 77) return false;
    if (coerceValue("webhookEnabled", "yes") !== true) return false;
    try { coerceValue("cooldownSec", "abc"); return false; } catch (_) { return true; }
  });
  t("validateWebhook chặn URL giả", () =>
    validateWebhook("http://evil.com/x") !== null &&
    validateWebhook("https://discord.com/api/webhooks/123/abcDEF-_") === null);
  t("classify 401→AUTH, 429→RATE", () =>
    classify(401, null, "").kind === "AUTH" && classify(429, null, "").kind === "RATE");
  t("backoff tôn trọng Retry-After", () =>
    backoffMs(1, new HttpError("RATE", 429, "x", 5000)) === 5000);
  t("GAMES hợp lệ", () =>
    Object.values(GAMES).every((g) => g.name && Number.isInteger(g.placeId)));
  t("figletVersion không ném lỗi", () => { figletVersion(); return true; });
  t("launchPackage báo lỗi rõ khi không phải Termux", () => {
    const r = launchPackage("com.roblox.client", 1);
    return IS_TERMUX ? true : (r.ok === false && /Termux/.test(r.reason));
  });

  // input queue: mô phỏng nhiều dòng đến cùng lúc
  await new Promise((resolve) => {
    const q = Object.create(InputQueue.prototype);
    q.buffer = ["a", "b", "c"]; q.waiters = []; q.closed = true;
    Promise.all([q.next(), q.next(), q.next(), q.next()]).then((v) => {
      t("InputQueue không mất dòng khi pipe", () =>
        JSON.stringify(v) === JSON.stringify(["a", "b", "c", null]));
      resolve();
    });
  });

  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exitCode = fail ? 1 : 0;
}

/* ────────────────────────── entry ────────────────────────── */

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--version")) { console.log(VERSION); return; }
  if (argv.includes("--selftest")) { await selftest(); return; }

  const cfg = loadConfig();
  if (argv.includes("--diagnostics")) { await diagnostics(cfg); return; }

  const q = new InputQueue();
  try {
    if (argv.includes("--loop")) await rejoinLoop(cfg, q);
    else await menu(cfg, q);
  } finally {
    q.close();
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
  }
}

process.on("unhandledRejection", (e) => {
  log.err(`Lỗi chưa bắt: ${e && e.message ? e.message : e}`);
  process.exit(1);
});
process.on("SIGINT", () => { console.log("\n"); log.warn("Ctrl+C — thoát."); process.exit(0); });

main().catch((e) => { log.err(e.stack || e.message); process.exit(1); });
