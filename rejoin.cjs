#!/usr/bin/env node
const { execSync, execFileSync, execFile, spawnSync, exec } = require("child_process");
function ensurePackages() {
  // boxen / screenshot-desktop không còn được dùng (không chạy được trên Android) -> bỏ để khởi động nhanh hơn.
  const requiredPackages = ["axios", "cli-table3", "figlet"];
  const optionalPackages = [];

  const installPkg = (spec, optional) => {
    const name = spec.split("@")[0] || spec;
    try {
      require.resolve(name);
      return;
    } catch { }

    console.log(`Đang cài package thiếu: ${spec}`);
    try {
      // Cài vào chính thư mục script để tránh lỗi khi chạy bằng su/root ở cwd khác
      execSync(`npm install --no-audit --no-fund ${spec}`, {
        stdio: "inherit",
        cwd: __dirname
      });
    } catch (e) {
      if (optional) {
        console.warn(`[!] Bỏ qua package tuỳ chọn ${spec}: ${e.message}`);
        return;
      }
      console.error(`Lỗi khi cài ${spec}:`, e.message);
      process.exit(1);
    }
  };

  requiredPackages.forEach((pkg) => installPkg(pkg, false));
  optionalPackages.forEach((pkg) => installPkg(pkg, true));
}
ensurePackages();

const TERMUX_BIN = "/data/data/com.termux/files/usr/bin";
if (process.env.PATH && !process.env.PATH.includes(TERMUX_BIN)) {
  process.env.PATH = `${TERMUX_BIN}:${process.env.PATH}`;
}

function ensureSystemDependencies() {
  try {
    execSync("command -v sqlite3", { stdio: "ignore" });
  } catch {
    const isRoot = execSync("id -u", { encoding: 'utf8' }).trim() === "0";

    if (isRoot) {
      console.warn("[-] Chưa tìm thấy sqlite3 và đang chạy dưới quyền Root.");
      console.warn("[-] Vui lòng khởi động lại tool ở chế độ người dùng thường để tự động cài đặt.");
      console.warn("[-] Hoặc cài thủ công bằng: pkg install sqlite");
      process.exit(1);
    } else {
      console.log("[-] Chưa tìm thấy sqlite3. Đang tự động cài đặt...");
      try {
        execSync("pkg install sqlite -y", { stdio: "inherit" });
        console.log("[+] Đã cài đặt sqlite3 thành công!");
      } catch (e) {
        console.error("[-] Lỗi khi cài đặt sqlite3. Vui lòng cài thủ công bằng lệnh: pkg install sqlite");
        process.exit(1);
      }
    }
  }
}
ensureSystemDependencies();

const axios = require("axios");
const readline = require("readline");
const fs = require("fs");
const path = require("path");
const os = require("os");
const Table = require("cli-table3");
const util = require("util");

/**
 * Thư mục lưu cấu hình NGOÀI repo.
 * Loader chạy `git reset --hard` + `git clean -fd` mỗi lần update, nên mọi file
 * config nằm trong repo đều bị xoá sạch -> user mất hết setting.
 * Đưa ra ~/.roblox-rejoin (override được bằng biến môi trường ROBLOX_REJOIN_HOME).
 */
const CONFIG_DIR = (() => {
  const envDir = process.env.ROBLOX_REJOIN_HOME;
  if (envDir && envDir.trim()) return path.resolve(envDir.trim());
  return path.join(os.homedir() || __dirname, ".roblox-rejoin");
})();

try {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
} catch (e) {
  console.error(`[-] Không tạo được thư mục config ${CONFIG_DIR}: ${e.message}`);
}

const CONFIG_FILENAMES = [
  "multi_configs.json",
  "webhook_config.json",
  "package_prefix_config.json",
  "activity_config.json",
  "autoexec_config.json",
  "launch_activity_cache.json",
];

/**
 * Chuyển config cũ sang CONFIG_DIR (chỉ chép file còn thiếu).
 * Nguồn cũ: thư mục repo (bản rất cũ) và ~/.roblox-rejoin theo HOME hiện tại — vì tiến trình root (su)
 * có thể từng dùng HOME khác, còn nay CONFIG_DIR được truyền cố định từ tiến trình cha.
 */
function migrateLegacyConfigs() {
  const sources = [
    { dir: __dirname, rename: true },
    { dir: path.join(os.homedir() || __dirname, ".roblox-rejoin"), rename: false },
  ].filter((s) => path.resolve(s.dir) !== path.resolve(CONFIG_DIR));

  for (const { dir, rename } of sources) {
    for (const name of CONFIG_FILENAMES) {
      const oldPath = path.join(dir, name);
      const newPath = path.join(CONFIG_DIR, name);
      try {
        if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
          fs.copyFileSync(oldPath, newPath);
          console.log(`[+] Đã chuyển config "${name}" sang ${CONFIG_DIR}`);
          if (rename) {
            try { fs.renameSync(oldPath, `${oldPath}.migrated`); } catch (_) { }
          }
        }
      } catch (e) {
        console.error(`[-] Không migrate được "${name}": ${e.message}`);
      }
    }
  }
}
migrateLegacyConfigs();

const cfgPath = (name) => path.join(CONFIG_DIR, name);

const CONFIG_PATH = cfgPath("multi_configs.json");
const WEBHOOK_CONFIG_PATH = cfgPath("webhook_config.json");
const PREFIX_CONFIG_PATH = cfgPath("package_prefix_config.json");
const ACTIVITY_CONFIG_PATH = cfgPath("activity_config.json");
const AUTOEXEC_CONFIG_PATH = cfgPath("autoexec_config.json");

const UI_CONFIG_PATH = cfgPath("ui_config.json");
const RUN_OPTIONS_PATH = cfgPath("run_options.json");

/**
 * Thư mục tạm RIÊNG TƯ (0700) nằm trong CONFIG_DIR: bản sao cookie DB, ảnh chụp màn hình,
 * script đang soạn... Trước đây các file này nằm ở /sdcard hoặc thư mục repo (ai cũng đọc được / bị git clean).
 */
const TMP_DIR = path.join(CONFIG_DIR, "tmp");
try { fs.mkdirSync(TMP_DIR, { recursive: true, mode: 0o700 }); } catch (_) { }

/** Dọn file tạm sót lại từ lần chạy trước (quá 1 giờ). */
function cleanTmpDir(maxAgeMs = 60 * 60 * 1000) {
  try {
    for (const name of fs.readdirSync(TMP_DIR)) {
      const p = path.join(TMP_DIR, name);
      try { if (Date.now() - fs.statSync(p).mtimeMs > maxAgeMs) fs.unlinkSync(p); } catch (_) { }
    }
  } catch (_) { }
}
cleanTmpDir();

const execFileAsync = util.promisify(execFile);

// Activity mặc định cố định, KHÔNG phụ thuộc prefix package.
const DEFAULT_ACTIVITY = "com.roblox.client.ActivityProtocolLaunch";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
// Giám sát trực tiếp vẽ lại mỗi N nhịp (1 nhịp = 1 giây) để hoạt ảnh và đồng hồ chạy mượt.
const LIVE_REFRESH_TICKS = 1;

// ---- Tham số vận hành ----
const HTTP_TIMEOUT = 15000;            // timeout cho MỌI request mạng (trước đây không có -> treo cả tool khi mạng chập chờn)
const LAUNCH_GRACE_MS = 75 * 1000;     // sau khi gửi lệnh mở game, chờ chừng này rồi mới đánh giá lại (tránh mở lại giữa lúc game đang load)
const LAUNCH_STAGGER_MS = 2000;        // giãn cách khi mở nhiều instance cùng lúc cho đỡ nặng máy
const COOKIE_REFRESH_MS = 3 * 60 * 1000;
const RECENT_GAMES_LIMIT = 5;           // số game "tài khoản hay chơi" hiển thị khi chọn game (trước đây là 10)
const USER_AGENT = "Mozilla/5.0 (Linux; Android 10; Termux)";

const IN_GAME_STATUSES = new Set(["Online [+]", "Trong game"]);
const ERROR_STATUSES = new Set(["Lỗi mạng", "Cookie hết hạn", "Lỗi mở game"]);
const isInGameStatus = (status) => IN_GAME_STATUSES.has(String(status || "").trim());

/** Bọc chuỗi an toàn cho shell (dùng khi bắt buộc đi qua `su -c "..."`). */
const shQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/**
 * Tạm chuyển hướng console.* vào một hàm sink (dùng cho màn giám sát trực tiếp:
 * log chen ngang sẽ làm vỡ khung hình, nên gom vào bảng NHẬT KÝ). Trả về hàm khôi phục.
 */
function captureConsole(sink) {
  const methods = ["log", "info", "warn", "error"];
  const saved = {};
  for (const m of methods) {
    saved[m] = console[m];
    console[m] = (...args) => {
      try { sink(m, util.format(...args)); } catch (_) { }
    };
  }
  return () => { for (const m of methods) console[m] = saved[m]; };
}

/** Escape chuỗi để nhúng an toàn vào RegExp. */
const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// figlet / screenshot-desktop là tuỳ chọn: thiếu thì dùng phông tích hợp / screencap, không được để crash tool.
let figlet = null;
try {
  figlet = require("figlet");
} catch (e) {
  console.warn(`[!] Không load được figlet, dùng tiêu đề dự phòng: ${e.message}`);
}

let screenshot = null;
try {
  screenshot = require("screenshot-desktop");
} catch (e) {
  screenshot = null;
}

class Utils {
  /** Ghi JSON theo kiểu atomic để tránh hỏng config khi app bị dừng giữa lúc ghi. */
  static writeJsonAtomic(filePath, value) {
    const tempPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  }

  static ensureRoot() {
    let uid = "";
    try {
      uid = execSync("id -u", { encoding: "utf8" }).trim();
    } catch (e) {
      console.error("Không kiểm tra được quyền hiện tại:", e.message);
      process.exit(1);
    }
    if (uid === "0") return;

    console.log("Cần quyền root, chuyển qua su...");
    // Truyền CONFIG_DIR sang tiến trình root để cả 2 phía luôn dùng chung 1 thư mục config
    // (dưới su, HOME có thể khác -> trước đây dễ "mất" cấu hình). Mọi tham số đều được bọc dấu nháy.
    const env = [["ROBLOX_REJOIN_HOME", CONFIG_DIR]];
    for (const key of ["TERM", "NO_COLOR", "FORCE_COLOR", "REJOIN_NO_ANIM"]) {
      if (process.env[key]) env.push([key, process.env[key]]);
    }
    const command = [
      ...env.map(([k, v]) => `${k}=${shQuote(v)}`),
      shQuote(process.execPath),
      shQuote(__filename),
      ...process.argv.slice(2).map(shQuote)
    ].join(" ");

    const result = spawnSync("su", ["-c", command], { stdio: "inherit" });
    if (result.error) {
      console.error("Không thể chạy với quyền root:", result.error.message);
      process.exit(1);
    }
    process.exit(typeof result.status === "number" ? result.status : 1);
  }

  /** "off" | "pending" | "on" | "failed" — để menu cảnh báo nếu wake lock không bật được. */
  static wakeLockState = "off";

  static enableWakeLock() {
    Utils.wakeLockState = "pending";
    exec("termux-wake-lock", (err) => {
      Utils.wakeLockState = err ? "failed" : "on";
    });
  }

  static disableWakeLock() {
    if (Utils.wakeLockState === "off") return;
    Utils.wakeLockState = "off";
    try {
      execSync("termux-wake-unlock", { stdio: "ignore", timeout: 5000 });
    } catch (_) { }
  }

  /**
   * Mở game bằng `am start`. Không đi qua shell (tránh injection), kiểm tra đầu vào,
   * thử `am` rồi `/system/bin/am`, và đọc cả nội dung "Error:" mà am vẫn trả exit code 0.
   * Trả về { ok, error? } — không in log, để màn giám sát tự ghi vào NHẬT KÝ.
   */
  static async launch(placeId, linkCode = null, packageName, jobId = null) {
    if (!/^[A-Za-z0-9_.]+$/.test(String(packageName || ""))) {
      return { ok: false, error: "Tên package không hợp lệ" };
    }
    if (!/^\d+$/.test(String(placeId || ""))) {
      return { ok: false, error: "Place ID không hợp lệ" };
    }
    if (linkCode && !/^[\w-]+$/.test(String(linkCode))) {
      return { ok: false, error: "Mã server VIP không hợp lệ" };
    }

    if (jobId && !/^[\w-]+$/.test(String(jobId))) {
      return { ok: false, error: "Job ID server không hợp lệ" };
    }

    // Server VIP (linkCode) được ưu tiên; ngược lại nếu có jobId thì vào đúng server công khai đó.
    let url = `roblox://placeID=${placeId}`;
    if (linkCode) url += `&linkCode=${linkCode}`;
    else if (jobId) url += `&gameInstanceId=${jobId}`;

    // Activity: dùng giá trị tùy chỉnh nếu hợp lệ, ngược lại luôn dùng mặc định cố định.
    let activity = Utils.loadActivityConfig();
    if (!activity || !/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(activity)) {
      activity = DEFAULT_ACTIVITY;
    }

    const args = [
      "start", "-n", `${packageName}/${activity}`,
      "-a", "android.intent.action.VIEW",
      "-d", url,
      "--activity-clear-top"
    ];

    let lastError = "không rõ nguyên nhân";
    for (const bin of ["am", "/system/bin/am"]) {
      try {
        const { stdout, stderr } = await execFileAsync(bin, args, { timeout: 20000, maxBuffer: 1024 * 1024 });
        const output = `${stdout || ""}\n${stderr || ""}`;
        const bad = output.split("\n").find((l) => /^\s*(Error|Exception|java\.lang\.)/i.test(l));
        if (bad) {
          lastError = bad.trim();
          continue;
        }
        return { ok: true };
      } catch (e) {
        // am fallback không tồn tại (ENOENT) thì giữ lại lỗi thật của lần thử trước.
        if (e.code === "ENOENT" && lastError !== "không rõ nguyên nhân") continue;
        lastError = String(e.message || e).split("\n")[0];
      }
    }
    return { ok: false, error: lastError };
  }

  static ask(rl, msg) {
    return new Promise((r) => rl.question(msg, r));
  }

  static saveMultiConfigs(configs) {
    try {
      Utils.writeJsonAtomic(CONFIG_PATH, configs);
      return true;
    } catch (e) {
      console.error(UIRenderer.message("error", `Không thể lưu cấu hình: ${e.message}`));
      return false;
    }
  }

  static loadMultiConfigs() {
    if (!fs.existsSync(CONFIG_PATH)) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      throw new Error("sai định dạng");
    } catch (e) {
      // Trước đây file hỏng bị âm thầm coi là rỗng rồi bị ghi đè -> mất sạch cấu hình.
      // Giờ dời sang file .corrupt-* để còn khôi phục thủ công được.
      try {
        const backup = `${CONFIG_PATH}.corrupt-${Date.now()}`;
        fs.renameSync(CONFIG_PATH, backup);
        console.error(`[-] multi_configs.json bị hỏng (${e.message}); đã giữ lại bản sao: ${path.basename(backup)}`);
      } catch (_) { }
      return {};
    }
  }

  static saveWebhookConfig(config) {
    try {
      Utils.writeJsonAtomic(WEBHOOK_CONFIG_PATH, config);
      return true;
    } catch (e) {
      console.error(UIRenderer.message("error", `Không thể lưu cấu hình webhook: ${e.message}`));
      return false;
    }
  }

  static loadWebhookConfig() {
    if (!fs.existsSync(WEBHOOK_CONFIG_PATH)) return null;
    try {
      const config = JSON.parse(fs.readFileSync(WEBHOOK_CONFIG_PATH, "utf8"));
      if (!config || typeof config !== "object") return null;
      if (typeof config.enabled === "undefined") config.enabled = true;
      return config;
    } catch {
      return null;
    }
  }

  static removeWebhookConfig() {
    try {
      if (fs.existsSync(WEBHOOK_CONFIG_PATH)) fs.unlinkSync(WEBHOOK_CONFIG_PATH);
      return true;
    } catch (e) {
      console.error(UIRenderer.message("error", `Không thể xóa cấu hình webhook: ${e.message}`));
      return false;
    }
  }

  /**
   * Chỉ nhận webhook Discord thật (https + đúng tên miền + đúng đường dẫn). Trước đây chỉ kiểm tra
   * chuỗi con "discord.com/api/webhooks/" nên một URL lạ chứa chuỗi đó vẫn lọt và nhận cả ảnh chụp màn hình.
   * Trả về URL chuẩn hóa, hoặc null nếu không hợp lệ.
   */
  static parseDiscordWebhook(input) {
    try {
      const u = new URL(String(input || "").trim());
      if (u.protocol !== "https:") return null;
      const hosts = ["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"];
      if (!hosts.includes(u.hostname.toLowerCase())) return null;
      if (!/^\/api(\/v\d+)?\/webhooks\/\d+\/[\w-]+\/?$/.test(u.pathname)) return null;
      return u.toString();
    } catch {
      return null;
    }
  }

  static webhookId(url) {
    const m = String(url || "").match(/\/webhooks\/(\d+)\//);
    return m ? m[1] : "unknown";
  }

  static isValidPrefix(prefix) {
    return /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/.test(String(prefix || ""));
  }

  static _prefixCache = null;

  static savePackagePrefixConfig(prefix) {
    try {
      if (!Utils.isValidPrefix(prefix)) throw new Error("prefix chỉ gồm chữ, số, dấu _ và dấu chấm");
      Utils.writeJsonAtomic(PREFIX_CONFIG_PATH, { prefix });
      Utils._prefixCache = null;
      return true;
    } catch (e) {
      console.error(UIRenderer.message("error", `Không thể lưu prefix: ${e.message}`));
      return false;
    }
  }

  /** Có cache 3 giây: packageLabel() được gọi mỗi giây cho từng instance, không cần đọc đĩa liên tục. */
  static loadPackagePrefixConfig() {
    const cached = Utils._prefixCache;
    if (cached && Date.now() - cached.at < 3000) return cached.value;
    let value = "com.roblox";
    try {
      if (fs.existsSync(PREFIX_CONFIG_PATH)) {
        const config = JSON.parse(fs.readFileSync(PREFIX_CONFIG_PATH, "utf8"));
        if (config && Utils.isValidPrefix(config.prefix)) value = config.prefix;
      }
    } catch (_) { }
    Utils._prefixCache = { value, at: Date.now() };
    return value;
  }

  /** Tùy chọn chọn ở bước "Chạy Rejoin" (nhớ lại lần chạy trước). autoRejoinMin: 0 = tắt. */
  static loadRunOptions() {
    const base = { autoRejoinMin: 0, lowPop: false };
    try {
      if (!fs.existsSync(RUN_OPTIONS_PATH)) return base;
      const parsed = JSON.parse(fs.readFileSync(RUN_OPTIONS_PATH, "utf8"));
      if (!parsed || typeof parsed !== "object") return base;
      const min = Math.floor(Number(parsed.autoRejoinMin));
      return {
        autoRejoinMin: min >= 1 && min <= 1440 ? min : 0,
        lowPop: Boolean(parsed.lowPop)
      };
    } catch {
      return base;
    }
  }

  static saveRunOptions(options) {
    try {
      Utils.writeJsonAtomic(RUN_OPTIONS_PATH, options);
      return true;
    } catch (e) {
      console.error(UIRenderer.message("error", `Không thể lưu tùy chọn chạy: ${e.message}`));
      return false;
    }
  }

  /** Dừng hẳn app Roblox của package (dùng cho auto rejoin định kỳ để vào lại sạch). */
  static async forceStop(packageName) {
    if (!/^[A-Za-z0-9_.]+$/.test(String(packageName || ""))) return false;
    for (const bin of ["am", "/system/bin/am"]) {
      try {
        await execFileAsync(bin, ["force-stop", packageName], { timeout: 15000 });
        return true;
      } catch (_) { }
    }
    return false;
  }

  static loadUiConfig() {
    const base = { theme: "midnight", font: "auto", anim: true };
    try {
      if (!fs.existsSync(UI_CONFIG_PATH)) return base;
      const parsed = JSON.parse(fs.readFileSync(UI_CONFIG_PATH, "utf8"));
      return parsed && typeof parsed === "object" ? { ...base, ...parsed } : base;
    } catch {
      return base;
    }
  }

  static saveUiConfig(config) {
    try {
      Utils.writeJsonAtomic(UI_CONFIG_PATH, config);
      return true;
    } catch (e) {
      console.error(UIRenderer.message("error", `Không thể lưu giao diện: ${e.message}`));
      return false;
    }
  }

  static saveActivityConfig(activity) {
    try {
      const config = { activity: activity };
      Utils.writeJsonAtomic(ACTIVITY_CONFIG_PATH, config);
      return true;
    } catch (e) {
      console.error(UIRenderer.message("error", `Không thể lưu activity: ${e.message}`));
      return false;
    }
  }

  static loadActivityConfig() {
    if (!fs.existsSync(ACTIVITY_CONFIG_PATH)) {

      return null;
    }
    try {
      const raw = fs.readFileSync(ACTIVITY_CONFIG_PATH);
      const config = JSON.parse(raw);
      return config.activity || null;
    } catch {
      return null;
    }
  }

  static async takeScreenshot() {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const isPng = (buf) =>
      Buffer.isBuffer(buf) && buf.length > 8 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;

    // Lỗi cũ: execSync mặc định chỉ nhận 1MB stdout, mà ảnh PNG cả màn hình điện thoại thường 1.5–5MB
    // -> ENOBUFS -> tính năng chụp ảnh gần như luôn rơi xuống file thông tin hệ thống. Nâng lên 64MB.
    const opts = { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, timeout: 20000 };
    const attempts = [
      () => execFileSync("screencap", ["-p"], opts),
      () => execFileSync("su", ["-c", "screencap -p"], opts),
    ];

    let lastError = null;
    for (const run of attempts) {
      try {
        const img = run();
        if (!isPng(img)) throw new Error("dữ liệu ảnh không hợp lệ");
        const filepath = path.join(TMP_DIR, `screenshot_${stamp}.png`);
        fs.writeFileSync(filepath, img, { mode: 0o600 });
        console.log(`[*] Đã chụp ảnh màn hình (${Math.round(img.length / 1024)} KB)`);
        return filepath;
      } catch (e) {
        lastError = e;
      }
    }
    console.error(`[-] Lỗi khi chụp ảnh với screencap: ${lastError ? lastError.message : "không rõ"}`);

    try {
      if (!screenshot) throw new Error("screenshot-desktop không khả dụng");
      const img = await screenshot();
      const filepath = path.join(TMP_DIR, `screenshot_${stamp}.png`);
      fs.writeFileSync(filepath, img, { mode: 0o600 });
      return filepath;
    } catch (_) {
      // Không chụp được -> gửi file thông tin hệ thống để báo cáo vẫn có thêm dữ liệu.
    }

    try {
      const filepath = path.join(TMP_DIR, `system_info_${stamp}.txt`);
      const mb = (v) => Math.round(v / 1024 / 1024);
      const content = [
        "=== SYSTEM INFORMATION ===",
        `Platform: ${os.platform()}`,
        `Architecture: ${os.arch()}`,
        `Node.js Version: ${process.version}`,
        `Uptime: ${Math.floor(os.uptime() / 3600)}h ${Math.floor((os.uptime() % 3600) / 60)}m`,
        `Total Memory: ${mb(os.totalmem())} MB`,
        `Free Memory: ${mb(os.freemem())} MB`,
        `CPU Cores: ${(os.cpus() || []).length}`,
        `Environment: ${process.env.TERMUX_VERSION ? "Termux" : "Other"}`,
        `Timestamp: ${new Date().toISOString()}`,
        "========================"
      ].join("\n");
      fs.writeFileSync(filepath, content, { mode: 0o600 });
      return filepath;
    } catch (e3) {
      console.error(`[-] Không thể tạo file thông tin: ${e3.message}`);
      return null;
    }
  }

  static deleteScreenshot(filepath) {
    // Chỉ xóa file tạm do chính tool tạo (thư mục tmp riêng, hoặc thư mục script của phiên bản cũ).
    try {
      const resolved = path.resolve(filepath || "");
      const dir = path.dirname(resolved);
      const allowedDir = dir === path.resolve(TMP_DIR) || dir === path.resolve(__dirname);
      const allowedName = /^(screenshot_|system_info_).+\.(png|txt)$/i.test(path.basename(resolved));
      if (allowedDir && allowedName && fs.existsSync(resolved)) {
        fs.unlinkSync(resolved);
      }
    } catch (e) {
      console.error(`[-] Lỗi khi dọn file tạm: ${e.message}`);
    }
  }

  /**
   * Gửi embed (kèm ảnh nếu có) tới webhook Discord. Ảnh PNG được nhúng thẳng vào embed
   * (attachment://...) thay vì đính kèm rời. Luôn dọn file tạm kể cả khi gửi lỗi.
   */
  static async sendWebhookEmbed(webhookUrl, embedData, screenshotPath = null) {
    const safeUrl = Utils.parseDiscordWebhook(webhookUrl);
    try {
      if (!safeUrl) {
        console.error("[-] URL webhook không hợp lệ, bỏ qua việc gửi.");
        return false;
      }

      const embed = { ...embedData };
      const payload = { username: "REJOIN TOOL", embeds: [embed] };
      const requestOpts = { timeout: 30000, maxBodyLength: Infinity, maxContentLength: Infinity };

      if (screenshotPath && fs.existsSync(screenshotPath)) {
        const fileName = path.basename(screenshotPath);
        const isPngFile = path.extname(fileName).toLowerCase() === ".png";
        if (isPngFile) embed.image = { url: `attachment://${fileName}` };

        const fileBuffer = fs.readFileSync(screenshotPath);
        const boundary = "----RejoinBoundary" + Math.random().toString(16).slice(2);
        const head =
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="payload_json"\r\n` +
          `Content-Type: application/json\r\n\r\n` +
          JSON.stringify(payload) + "\r\n" +
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="files[0]"; filename="${fileName}"\r\n` +
          `Content-Type: ${isPngFile ? "image/png" : "text/plain"}\r\n\r\n`;

        const multipartBody = Buffer.concat([
          Buffer.from(head, "utf8"),
          fileBuffer,
          Buffer.from(`\r\n--${boundary}--\r\n`, "utf8")
        ]);

        await axios.post(safeUrl, multipartBody, {
          ...requestOpts,
          headers: {
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Content-Length": multipartBody.length
          }
        });
      } else {
        await axios.post(safeUrl, payload, {
          ...requestOpts,
          headers: { "Content-Type": "application/json" }
        });
      }

      console.log("[+] Đã gửi webhook thành công!");
      return true;
    } catch (e) {
      const status = e.response && e.response.status ? ` (HTTP ${e.response.status})` : "";
      console.error(`[-] Lỗi khi gửi webhook${status}: ${e.message}`);
      return false;
    } finally {
      if (screenshotPath) Utils.deleteScreenshot(screenshotPath);
    }
  }

  /**
   * Tên hiển thị chuẩn cho 1 package.
   */
  static describePackage(packageName, prefix = null) {
    const p = prefix || Utils.loadPackagePrefixConfig();
    if (packageName === `${p}.client`) return "Roblox Quốc tế";
    if (packageName === `${p}.client.vnggames`) return "Roblox VNG";
    if (packageName === "com.roblox.client") return "Roblox Quốc tế";
    if (packageName === "com.roblox.client.vnggames") return "Roblox VNG";
    return `Roblox Custom (${packageName})`;
  }

  /**
   * Nhãn NGẮN dùng trong bảng/status ("Global" / "VNG" / tên package).
   * @param {string} packageName
   * @param {string} [suffix] khoảng trắng căn lề
   */
  static packageLabel(packageName, suffix = "") {
    const p = Utils.loadPackagePrefixConfig();
    if (packageName === `${p}.client` || packageName === "com.roblox.client") {
      return `Global${suffix}`;
    }
    if (packageName === `${p}.client.vnggames` || packageName === "com.roblox.client.vnggames") {
      return `VNG${suffix}`;
    }
    return packageName;
  }

  static detectAllRobloxPackages() {
    const packages = {};

    try {
      const prefix = this.loadPackagePrefixConfig();
      let result = "";

      // Danh sách các phương pháp gọi pm bền bỉ nhất trên Android/Termux
      const methods = [
        "unset LD_PRELOAD LD_LIBRARY_PATH; pm list packages",
        "unset LD_PRELOAD LD_LIBRARY_PATH; cmd package list packages",
        "unset LD_PRELOAD LD_LIBRARY_PATH; /system/bin/pm list packages",
        "pm list packages",
        "cmd package list packages",
        "su -c 'unset LD_PRELOAD LD_LIBRARY_PATH; pm list packages'"
      ];

      for (const method of methods) {
        try {
          result = execSync(method, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: true
          });
          if (result && result.includes('package:')) break;
        } catch (e) {
          continue;
        }
      }

      if (!result) {
        console.error(`[-] Mọi nỗ lực quét packages bằng pm/cmd đều thất bại.`);
        return packages;
      }

      const lines = result.split('\n');
      const packagePattern = new RegExp(`package:(${escapeRegExp(prefix)}[^\\s]*)`);

      let foundAny = false;
      let matchedCount = 0;

      lines.forEach(line => {
        if (!line.includes('package:')) return;
        foundAny = true;

        const match = line.match(packagePattern);
        if (match) {
          matchedCount++;
          const packageName = match[1];
          let displayName = packageName;

          if (packageName === `${prefix}.client`) {
            displayName = 'Roblox Quốc tế';
          } else if (packageName === `${prefix}.client.vnggames`) {
            displayName = 'Roblox VNG';
          } else {
            displayName = `Roblox Custom (${packageName})`;
          }

          packages[packageName] = {
            packageName,
            displayName
          };
        }
      });

      // Nếu tìm thấy packages nhưng không cái nào khớp prefix
      if (foundAny && matchedCount === 0) {
        console.log(`\x1b[33m[!] CẢNH BÁO: Tìm thấy packages hệ thống nhưng không cái nào bắt đầu bằng "${prefix}"\x1b[0m`);
        console.log(`[!] Có vẻ bạn đang dùng Roblox mod (ví dụ: vip.xxx).`);
        console.log(`[!] Vui lòng vào mục "4. Chỉnh prefix package" để đổi lại cho đúng.`);

        // Gợi ý 3 package đầu tiên tìm được để user biết prefix là gì
        const samples = lines
          .filter(l => l.includes('package:'))
          .slice(0, 3)
          .map(l => l.replace('package:', '').trim());
        if (samples.length > 0) {
          console.log(`[*] Gợi ý các package tìm thấy: \x1b[32m${samples.join(', ')}\x1b[0m`);
        }
      }
    } catch (e) {
      console.error(`[-] Lỗi nghiêm trọng khi quét packages: ${e.message}`);
    }

    return packages;
  }

  static validatePackageIntegrity(configs) {
    console.log(UIRenderer.renderSection("Kiểm tra hệ thống", "Đối chiếu package và cấu hình"));
    console.log(UIRenderer.message("info", "Đang quét và kiểm tra tính toàn vẹn..."));

    try {
      const systemPackages = this.detectAllRobloxPackages();
      const systemPackageNames = Object.keys(systemPackages);
      const configPackageNames = Object.keys(configs);

      if (configPackageNames.length === 0) {
        console.log(UIRenderer.infoCard([
          ["Trạng thái", "KHÔNG CÓ CẤU HÌNH", "1;31"],
          ["Khắc phục", "Chạy mục 2 để thiết lập package"]
        ], "KIỂM TRA THẤT BẠI"));
        return false;
      }

      if (systemPackageNames.length === 0) {
        console.log(UIRenderer.infoCard([
          ["Trạng thái", "KHÔNG TÌM THẤY ROBLOX", "1;31"],
          ["Khắc phục", "Cài ít nhất một ứng dụng Roblox"]
        ], "KIỂM TRA THẤT BẠI"));
        return false;
      }

      const missingPackages = configPackageNames.filter(pkg => !systemPackageNames.includes(pkg));
      const extraPackages = systemPackageNames.filter(pkg => !configPackageNames.includes(pkg));
      const incompleteRows = [];

      for (const [packageName, config] of Object.entries(configs)) {
        const missing = [];
        if (!config.username) missing.push("username");
        if (!config.userId) missing.push("userId");
        if (!config.placeId) missing.push("placeId");
        if (!config.delaySec) missing.push("delaySec");
        if (missing.length) incompleteRows.push([Utils.packageLabel(packageName), `Thiếu: ${missing.join(", ")}`, "1;31"]);
      }

      if (missingPackages.length) {
        console.log(UIRenderer.infoCard(missingPackages.map(pkg => [
          "Không tồn tại",
          pkg,
          "1;31"
        ]), "PACKAGE THIẾU"));
      }
      if (extraPackages.length) {
        console.log(UIRenderer.infoCard(extraPackages.map(pkg => [
          "Chưa cấu hình",
          Utils.describePackage(pkg),
          "1;33"
        ]), "PACKAGE PHÁT HIỆN THÊM"));
      }
      if (incompleteRows.length) {
        console.log(UIRenderer.infoCard(incompleteRows, "CẤU HÌNH CHƯA ĐẦY ĐỦ"));
      }

      const hasError = missingPackages.length > 0 || incompleteRows.length > 0;
      if (hasError) {
        console.log(UIRenderer.message("error", "Kiểm tra thất bại. Hãy chạy mục 2 hoặc mục 3 để sửa cấu hình."));
        return false;
      }

      const matchingPackages = configPackageNames.filter(pkg => systemPackageNames.includes(pkg));
      console.log(UIRenderer.infoCard([
        ["Khả dụng", `${matchingPackages.length}/${configPackageNames.length}`, "1;32"],
        ["Chưa cấu hình", String(extraPackages.length), extraPackages.length ? "1;33" : "2;37"],
        ["Kết quả", "SẴN SÀNG", "1;32"]
      ], "KIỂM TRA HOÀN TẤT"));
      return true;
    } catch (e) {
      console.error(UIRenderer.message("error", `Không thể kiểm tra hệ thống: ${e.message}`));
      return false;
    }
  }

  static getRobloxCookie(packageName) {
    console.log(`[*] [${Utils.packageLabel(packageName)}] Đang lấy cookie ROBLOSECURITY...`);

    if (!/^[A-Za-z0-9_.]+$/.test(String(packageName || ""))) {
      console.error(`[-] Tên package không hợp lệ: ${packageName}`);
      return null;
    }

    const srcDb = `/data/data/${packageName}/app_webview/Default/Cookies`;
    const stamp = `${process.pid}_${Date.now()}`;
    // Ưu tiên thư mục riêng tư (0700). /sdcard chỉ là phương án cuối vì mọi app đều đọc được ở đó.
    const candidates = [
      path.join(TMP_DIR, `ck_${stamp}.db`),
      `/sdcard/cookies_temp_${stamp}.db`
    ];

    const copyFile = (from, to) => {
      try {
        execFileSync("cp", [from, to], { stdio: "pipe" });
        return true;
      } catch {
        try {
          execFileSync("su", ["-c", `cp ${shQuote(from)} ${shQuote(to)}`], { stdio: "pipe" });
          return true;
        } catch {
          return false;
        }
      }
    };

    const created = [];
    let dbCopy = null;
    try {
      for (const target of candidates) {
        if (copyFile(srcDb, target)) {
          dbCopy = target;
          created.push(target);
          break;
        }
      }
      if (!dbCopy) {
        console.error(`[-] [${Utils.packageLabel(packageName)}] Không sao chép được database cookie (cần quyền root).`);
        return null;
      }
      try { fs.chmodSync(dbCopy, 0o600); } catch (_) { }

      // Sao chép kèm journal/wal (nếu có) để không bỏ sót dữ liệu chưa ghi hẳn vào file chính.
      for (const suffix of ["-journal", "-wal"]) {
        if (copyFile(`${srcDb}${suffix}`, `${dbCopy}${suffix}`)) created.push(`${dbCopy}${suffix}`);
      }

      let cookieValue;
      try {
        cookieValue = execFileSync(
          "sqlite3",
          [dbCopy, "SELECT value FROM cookies WHERE name = '.ROBLOSECURITY' LIMIT 1"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
        ).trim();
      } catch (err) {
        console.error(`[-] [${Utils.packageLabel(packageName)}] Lỗi khi query sqlite3: ${String(err.message).split("\n")[0]}`);
        return null;
      }

      if (!cookieValue) {
        console.error(`[-] [${Utils.packageLabel(packageName)}] Không tìm được cookie ROBLOSECURITY (đã đăng nhập chưa?).`);
        return null;
      }

      if (!cookieValue.startsWith("_")) cookieValue = "_" + cookieValue;
      return `.ROBLOSECURITY=${cookieValue}`;
    } catch (e) {
      console.error(`[-] [${Utils.packageLabel(packageName)}] Lỗi khi lấy cookie: ${e.message}`);
      return null;
    } finally {
      for (const file of created) {
        try {
          fs.unlinkSync(file);
        } catch {
          try { execFileSync("rm", ["-f", file], { stdio: "ignore" }); } catch (_) { }
        }
      }
    }
  }

  static maskSensitiveInfo(text) {
    if (!text || text === 'Unknown') return text;
    const str = text.toString();
    if (str.length <= 3) return str;
    return '*'.repeat(str.length - 3) + str.slice(-3);
  }

  static async openEditor(rl, initialContent = "") {
    let hasNano = false;
    try {
      execSync("command -v nano", { stdio: "ignore" });
      hasNano = true;
    } catch (_) { }

    if (hasNano) {
      const tempFile = path.join(TMP_DIR, `script_${Date.now()}.txt`);
      try {
        fs.writeFileSync(tempFile, initialContent, { mode: 0o600 });
        console.log(UIRenderer.infoCard([
          ["Trình soạn thảo", "Nano"],
          ["Thời gian mở", "Sau 3 giây"],
          ["Hướng dẫn", "Dán script, Ctrl+O lưu, Ctrl+X thoát"]
        ], "CHUẨN BỊ NHẬP SCRIPT"));
        await sleep(3000);

        console.log(UIRenderer.message("info", "Đang mở Nano Editor..."));
        const term = process.env.TERM && process.env.TERM !== "dumb" ? process.env.TERM : "xterm";
        execFileSync("nano", [tempFile], { stdio: "inherit", env: { ...process.env, TERM: term } });
        return fs.readFileSync(tempFile, "utf8");
      } catch (e) {
        console.log(UIRenderer.message("warning", `Nano gặp lỗi (${String(e.message).split("\n")[0]}); chuyển sang nhập thủ công.`));
      } finally {
        // Trước đây file tạm bị bỏ lại trong thư mục script nếu nano lỗi / không có.
        try { fs.unlinkSync(tempFile); } catch (_) { }
      }
    } else {
      console.log(UIRenderer.message("warning", "Nano không khả dụng; chuyển sang nhập thủ công."));
    }

    console.log(UIRenderer.infoCard([
      ["Kết thúc", "Gõ EXIT ở một dòng mới"],
      ["Nội dung cũ", initialContent ? "Đã nạp" : "Không có"]
    ], "NHẬP SCRIPT THỦ CÔNG"));

    let lines = [];
    if (initialContent) {
      console.log(UIRenderer.divider("Nội dung hiện tại"));
      console.log(initialContent);
      console.log(UIRenderer.divider());
      lines = initialContent.split("\n");
    }

    while (true) {
      const line = await Utils.ask(rl, "");
      if (line.trim() === "EXIT") break;
      lines.push(line);
    }
    return lines.join("\n");
  }
}

class GameLauncher {
  /** Trả về kết quả của Utils.launch ({ ok, error? }) để vòng giám sát ghi nhật ký đúng. */
  static async handleGameLaunch(shouldLaunch, placeId, linkCode, packageName, rejoinOnly = false, jobId = null) {
    if (!shouldLaunch) return { ok: false, skipped: true };
    return Utils.launch(placeId, linkCode, packageName, jobId);
  }
}

/** GET JSON thẳng tới Roblox (KHÔNG qua proxy), tự chờ & thử lại khi bị 429. Lỗi ném ra có .status. */
async function httpGetJson(url, { params, headers, retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await axios.get(url, {
        params,
        headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...(headers || {}) },
        timeout: HTTP_TIMEOUT,
      });
      return res.data;
    } catch (e) {
      const status = e.response && e.response.status;
      if (status === 429 && attempt < retries) {
        const retryAfter = Number(e.response.headers && e.response.headers["retry-after"]);
        await sleep(clamp((retryAfter > 0 ? retryAfter : 2 * (attempt + 1)) * 1000, 1000, 10000));
        continue;
      }
      const err = new Error(
        status === 429 ? "Roblox giới hạn tốc độ (429)"
          : status ? `HTTP ${status}`
            : e.code === "ECONNABORTED" || e.code === "ETIMEDOUT" ? "Hết thời gian chờ"
              : e.message
      );
      err.status = status;
      throw err;
    }
  }
}

/**
 * JOIN SERVER ÍT NGƯỜI (kiểu extension RoPro / Server Hop): quét danh sách server công khai của Place ID,
 * xếp tăng dần theo số người, chọn server vắng nhất còn chỗ rồi vào thẳng bằng gameInstanceId.
 * Mỗi tài khoản "giữ chỗ" 1 server (claimed) để nhiều instance không đổ vào cùng một server.
 */
class ServerFinder {
  static claimed = new Map(); // jobId -> thời điểm giữ chỗ
  static MAX_PAGES = 5;
  static CLAIM_TTL_MS = 10 * 60 * 1000;

  static _purge() {
    const now = Date.now();
    for (const [id, at] of ServerFinder.claimed) {
      if (now - at > ServerFinder.CLAIM_TTL_MS) ServerFinder.claimed.delete(id);
    }
  }

  /** Trả về { ok, jobId, playing, maxPlayers, scanned } hoặc { ok:false, error }. */
  static async findLowest(placeId, { exclude = null } = {}) {
    if (!/^\d+$/.test(String(placeId || ""))) return { ok: false, error: "Place ID không hợp lệ" };
    ServerFinder._purge();

    let cursor = null;
    let scanned = 0;
    try {
      for (let page = 0; page < ServerFinder.MAX_PAGES; page++) {
        const params = { sortOrder: "Asc", excludeFullGames: true, limit: 100 };
        if (cursor) params.cursor = cursor;
        const data = await httpGetJson(`https://games.roblox.com/v1/games/${placeId}/servers/Public`, { params });
        const list = Array.isArray(data && data.data) ? data.data : [];
        scanned += list.length;

        const usable = list.filter((sv) =>
          sv && /^[\w-]+$/.test(String(sv.id || "")) &&
          Number(sv.playing) >= 1 && Number(sv.playing) < Number(sv.maxPlayers) &&
          sv.id !== exclude && !ServerFinder.claimed.has(sv.id)
        );
        if (usable.length) {
          const min = Math.min(...usable.map((sv) => Number(sv.playing)));
          const pool = usable.filter((sv) => Number(sv.playing) === min);
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

/** QUÉT WORLD: từ 1 game (Place ID / link / tên) liệt kê mọi place (map) cùng Place ID. */
class WorldScanner {
  static parsePlaceId(input) {
    const text = String(input || "").trim();
    if (/^\d{3,}$/.test(text)) return text;
    const m = text.match(/roblox\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?games\/(\d+)/i) || text.match(/[?&]placeId=(\d+)/i);
    return m ? m[1] : null;
  }

  static async universeOf(placeId) {
    const data = await httpGetJson(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`);
    if (!data || !data.universeId) throw new Error("Không tìm thấy game ứng với Place ID này");
    return String(data.universeId);
  }

  static _universeCache = new Map();

  /** universeId của 1 place, có cache (1 game có thể có nhiều world/place cùng universe). */
  static async universeOfCached(placeId) {
    const key = String(placeId);
    if (WorldScanner._universeCache.has(key)) return WorldScanner._universeCache.get(key);
    const id = await WorldScanner.universeOf(key);
    WorldScanner._universeCache.set(key, id);
    return id;
  }

  static async gameInfo(universeId) {
    try {
      const data = await httpGetJson("https://games.roblox.com/v1/games", { params: { universeIds: universeId } });
      const g = data && data.data && data.data[0];
      return g ? { name: g.name, rootPlaceId: g.rootPlaceId ? String(g.rootPlaceId) : null, playing: g.playing } : null;
    } catch (_) {
      return null;
    }
  }

  static async placesOf(universeId, cookie) {
    const url = `https://develop.roblox.com/v1/universes/${universeId}/places`;
    const out = [];
    let cursor = null;
    for (let page = 0; page < 10; page++) {
      const params = { limit: 100, sortOrder: "Asc" };
      if (cursor) params.cursor = cursor;
      let data;
      try {
        data = await httpGetJson(url, { params });
      } catch (e) {
        // Một số game chỉ trả danh sách khi có đăng nhập -> thử lại với cookie (chỉ gửi tới roblox.com).
        if ((e.status === 401 || e.status === 403) && cookie) data = await httpGetJson(url, { params, headers: { Cookie: cookie } });
        else throw e;
      }
      for (const p of (data && data.data) || []) out.push({ id: String(p.id), name: p.name || "(không tên)" });
      cursor = data && data.nextPageCursor;
      if (!cursor) break;
    }
    return out;
  }

  /** Tìm game theo tên. Trả về [{ universeId, placeId, name, playing }]. */
  static async search(keyword) {
    const seen = new Set();
    const results = [];
    const add = (universeId, placeId, name, playing) => {
      if (!universeId || !placeId || seen.has(String(universeId))) return;
      seen.add(String(universeId));
      results.push({ universeId: String(universeId), placeId: String(placeId), name: name || "(không tên)", playing });
    };

    try {
      const data = await httpGetJson("https://apis.roblox.com/search-api/omni-search", {
        params: { searchQuery: keyword, sessionId: require("crypto").randomUUID(), pageType: "all" },
      });
      for (const group of (data && data.searchResults) || []) {
        for (const c of group.contents || []) add(c.universeId, c.rootPlaceId, c.name, c.playerCount);
      }
    } catch (_) { }
    if (results.length) return results;

    const data = await httpGetJson("https://games.roblox.com/v1/games/list", { params: { keyword, maxRows: 10 } });
    for (const g of (data && data.games) || []) add(g.universeId, g.placeId, g.name, g.playerCount);
    return results;
  }
}

class RobloxUser {
  constructor(username, userId = null, cookie = null) {
    this.username = username;
    this.userId = userId;
    this.cookie = cookie;
    this.csrf = null;
  }

  async fetchAuthenticatedUser() {
    try {
      const res = await axios.get("https://users.roblox.com/v1/users/authenticated", {
        headers: {
          Cookie: this.cookie,
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
        timeout: HTTP_TIMEOUT,
      });

      const { name, id } = res.data;
      this.username = name;
      this.userId = id;
      console.log(`[+] Lấy info thành công cho ${name}!`);
      return this.userId;
    } catch (e) {
      console.error(`[-] Lỗi xác thực người dùng:`, e.message);
      return null;
    }
  }

  /**
   * Hỏi trạng thái online của tài khoản.
   * BẢO MẬT: trước đây cookie .ROBLOSECURITY bị gửi tới presence.roproxy.com (bên thứ ba) — chủ proxy
   * có thể ghi lại cookie và chiếm tài khoản. Giờ chỉ gọi thẳng presence.roblox.com (kèm X-CSRF-TOKEN).
   * Trả về { presence, error?, status?, authFailed? } — phân biệt rõ "mạng lỗi" với "user offline".
   */
  async checkPresence() {
    const url = "https://presence.roblox.com/v1/presence/users";
    const body = { userIds: [Number(this.userId)] };
    const headers = () => ({
      Cookie: this.cookie,
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(this.csrf ? { "X-CSRF-TOKEN": this.csrf } : {})
    });

    try {
      let res;
      try {
        res = await axios.post(url, body, { headers: headers(), timeout: HTTP_TIMEOUT });
      } catch (e) {
        const token = e.response && e.response.headers && e.response.headers["x-csrf-token"];
        if (e.response && e.response.status === 403 && token) {
          this.csrf = token;
          res = await axios.post(url, body, { headers: headers(), timeout: HTTP_TIMEOUT });
        } else {
          throw e;
        }
      }
      const presence = res.data && res.data.userPresences && res.data.userPresences[0];
      if (!presence) return { presence: null, error: "Phản hồi không có dữ liệu presence" };
      return { presence, error: null };
    } catch (e) {
      const status = e.response && e.response.status;
      let error;
      if (status === 401) error = "Cookie không còn hiệu lực (401)";
      else if (status === 429) error = "Roblox giới hạn tốc độ (429)";
      else if (status) error = `HTTP ${status}`;
      else if (e.code === "ECONNABORTED" || e.code === "ETIMEDOUT") error = "Hết thời gian chờ";
      else if (["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "ECONNRESET"].includes(e.code)) error = "Mất kết nối mạng";
      else error = e.message;
      return { presence: null, error, status };
    }
  }

  /** Giữ lại cho tương thích: chỉ trả về presence (hoặc null nếu lỗi). */
  async getPresence() {
    const result = await this.checkPresence();
    return result.presence || null;
  }
}

class GameSelector {
  async chooseGame(rl, cookie = null) {
    // Có cookie -> thử lấy danh sách game tài khoản hay chơi.
    // Lỗi / không có dữ liệu -> nhập Place ID hoặc link server thủ công.
    if (cookie) {
      // Warning của fetchRecentGames được gom lại, in sau khi spinner dừng để không bị vỡ dòng.
      const notes = [];
      const spin = UIRenderer.spinner("Đang lấy danh sách game tài khoản hay chơi...");
      let recent = [];
      try {
        recent = await GameSelector.fetchRecentGames(cookie, RECENT_GAMES_LIMIT, (line) => notes.push(line));
      } finally {
        spin.stop();
      }
      notes.forEach((line) => console.log(line));
      if (recent.length) {
        return this.chooseFromRecent(rl, recent, cookie);
      }
    }

    // Không có game gần đây (hoặc không lấy được) -> vào thẳng ô nhập Place ID / link server.
    console.log(UIRenderer.renderSection("Chọn game", "Nhập Place ID hoặc link server"));
    return this.chooseCustom(rl, cookie);
  }

  static customHint = "Nhập Place ID hoặc dán link server (cần ID map: dùng mục 8)";

  /** Menu game tài khoản hay chơi. Mục nhập Game ID / link server nằm ở số cuối. */
  async chooseFromRecent(rl, recent, cookie = null) {
    const customKey = String(recent.length + 1);
    console.log(UIRenderer.renderSection("Chọn game", "Game tài khoản này hay chơi"));
    console.log(UIRenderer.options([
      ...recent.map((game, index) => ({
        key: String(index + 1),
        label: game.name,
        description: `Place ID: ${game.placeId}`
      })),
      { key: customKey, label: "Game ID / Link server", description: GameSelector.customHint, color: "1;35" }
    ]));

    const ans = (await Utils.ask(rl, UIRenderer.prompt(`Chọn game [1-${customKey}]`))).trim();

    if (ans === customKey) return this.chooseCustom(rl, cookie);

    const picked = recent[parseInt(ans, 10) - 1];
    if (picked && /^\d+$/.test(ans)) {
      return { placeId: picked.placeId, name: picked.name, linkCode: null };
    }
    throw new Error(`[-] Không hợp lệ!`);
  }

  /**
   * Nhập Place ID hoặc link server. Nhận cả link đã chuyển hướng
   * (.../games/ID/Tên?privateServerLinkCode=...) lẫn link chưa chuyển hướng (.../share?code=...&type=Server).
   * Để trống rồi Enter để hủy.
   */
  async chooseCustom(rl, cookie = null) {
    console.log(UIRenderer.infoCard([
      ["Place ID", "Chỉ nhập số, ví dụ 2753915549"],
      ["Đã chuyển", "roblox.com/games/ID/Tên?privateServerLinkCode=..."],
      ["Chưa chuyển", "roblox.com/share?code=...&type=Server"],
      ["Hủy", "Để trống rồi Enter"]
    ], "GAME ID / LINK SERVER"));

    while (true) {
      const input = (await Utils.ask(rl, UIRenderer.prompt("Place ID hoặc link server"))).trim();
      if (!input) throw new Error("[-] Đã hủy chọn game.");

      const parsed = GameSelector.parseTarget(input);
      const spin = parsed && parsed.kind === "share"
        ? UIRenderer.spinner("Đang đổi link chưa chuyển hướng sang link server...")
        : null;
      try {
        const game = await GameSelector.resolveTarget(input, cookie);
        if (spin) spin.stop();
        console.log(UIRenderer.message(
          "success",
          `${game.name} • Place ID ${game.placeId}${game.linkCode ? " • server VIP" : ""}`
        ));
        return game;
      } catch (e) {
        if (spin) spin.stop();
        console.log(UIRenderer.message("error", e.message));
      }
    }
  }

  /**
   * Tách Place ID / link server từ chuỗi người dùng nhập. Hàm thuần, không gọi mạng.
   * kind: "place" | "private" (link đã chuyển hướng) | "share" (link chưa chuyển hướng)
   *       | "incomplete" (có mã server nhưng thiếu Place ID) | null (không nhận ra).
   */
  static parseTarget(input) {
    const text = String(input ?? "").trim().replace(/^[<"'\s]+|[>"'\s]+$/g, "");
    if (!text) return null;

    if (/^\d{3,}$/.test(text)) return { kind: "place", placeId: text, name: "Tùy chỉnh" };

    const pick = (re) => {
      const m = text.match(re);
      return m ? m[1] : null;
    };

    // Link chưa chuyển hướng: https://www.roblox.com/share?code=...&type=Server
    // (hoặc roblox://navigation/share_links?code=...&type=Server)
    const shareCode = pick(/[?&]code=([\w-]+)/i);
    if (shareCode && /[?&]type=server/i.test(text)) {
      return { kind: "share", shareCode };
    }

    const placeId = pick(/\/games\/(\d+)/i) || pick(/placeId=(\d+)/i);
    const linkCode = pick(/privateServerLinkCode=([\w-]+)/i) || pick(/[?&]linkCode=([\w-]+)/i);

    if (placeId && linkCode) {
      return { kind: "private", placeId, linkCode, name: "Private Server" };
    }
    if (linkCode) return { kind: "incomplete" };
    if (placeId) {
      let name = "Tùy chỉnh";
      const slug = pick(/\/games\/\d+\/([^/?#]+)/i);
      if (slug) {
        try { name = decodeURIComponent(slug); } catch (_) { name = slug; }
      }
      return { kind: "place", placeId, name };
    }
    return null;
  }

  /**
   * Đổi chuỗi nhập thành { placeId, name, linkCode }. Ném Error có nội dung hiển thị được cho người dùng.
   * cookie có thể là chuỗi hoặc hàm trả về chuỗi (chỉ đọc cookie khi thật sự cần đổi link chia sẻ).
   */
  static async resolveTarget(input, cookie = null) {
    const target = GameSelector.parseTarget(input);
    if (!target) {
      throw new Error("Không nhận ra Place ID hoặc link server. Nhập số Place ID, hoặc dán link .../games/ID/...?privateServerLinkCode=... hay .../share?code=...&type=Server.");
    }
    if (target.kind === "incomplete") {
      throw new Error("Link có mã server nhưng thiếu Place ID. Hãy dán đủ link .../games/ID/...?privateServerLinkCode=...");
    }
    if (target.kind === "share") {
      const value = typeof cookie === "function" ? cookie() : cookie;
      const info = await GameSelector.resolveShareLink(target.shareCode, value);
      return { placeId: info.placeId, name: "Private Server", linkCode: info.linkCode };
    }
    return {
      placeId: target.placeId,
      name: target.name,
      linkCode: target.kind === "private" ? target.linkCode : null
    };
  }

  /**
   * Link chưa chuyển hướng (share?code=...&type=Server) -> Place ID + mã server VIP.
   * Dùng API chia sẻ link của Roblox (không chính thức, cần cookie tài khoản); lỗi thì báo để người dùng dán link đã chuyển hướng.
   */
  static async resolveShareLink(shareCode, cookie) {
    if (!cookie) {
      throw new Error("Không đọc được cookie tài khoản nên chưa đổi được link này. Hãy dán link đã chuyển hướng (.../games/ID/...?privateServerLinkCode=...).");
    }
    const url = "https://apis.roblox.com/sharelinks/v1/resolve-link";
    const body = { linkId: shareCode, linkType: "Server" };
    const headers = {
      Cookie: cookie,
      "User-Agent": "Mozilla/5.0 (Linux; Android 10; Termux)",
      Accept: "application/json",
      "Content-Type": "application/json",
    };

    let res;
    try {
      try {
        res = await axios.post(url, body, { headers, timeout: 15000 });
      } catch (e) {
        // Roblox đòi X-CSRF-TOKEN: lấy token từ phản hồi 403 rồi thử lại 1 lần.
        const token = e.response && e.response.headers && e.response.headers["x-csrf-token"];
        if (e.response && e.response.status === 403 && token) {
          res = await axios.post(url, body, {
            headers: { ...headers, "X-CSRF-TOKEN": token },
            timeout: 15000
          });
        } else {
          throw e;
        }
      }
    } catch (e) {
      const status = e.response && e.response.status ? ` (HTTP ${e.response.status})` : "";
      throw new Error(`Không đổi được link chưa chuyển hướng${status}: ${e.message}. Hãy mở link trong trình duyệt rồi dán link đã chuyển hướng.`);
    }

    const data = res && res.data && res.data.privateServerInviteData;
    if (!data) throw new Error("Link này không phải link private server.");
    if (data.status && data.status !== "Valid") {
      throw new Error(`Link server không dùng được (trạng thái: ${data.status}).`);
    }
    if (!data.placeId || !data.linkCode) {
      throw new Error("Roblox không trả về đủ Place ID và mã server.");
    }
    return { placeId: String(data.placeId), linkCode: String(data.linkCode) };
  }

  /**
   * Lấy game tài khoản hay chơi (mục "Continue / Recently played" ở trang chủ Roblox).
   * API này không chính thức nên mọi lỗi đều trả về [] để tool chuyển sang nhập Place ID / link server thủ công.
   */
  static async fetchRecentGames(cookie, limit = RECENT_GAMES_LIMIT, log = (line) => console.log(line)) {
    const headers = {
      Cookie: cookie,
      "User-Agent": "Mozilla/5.0 (Linux; Android 10; Termux)",
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    const body = {
      pageType: "Home",
      sessionId: typeof require("crypto").randomUUID === "function"
        ? require("crypto").randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    };
    const url = "https://apis.roblox.com/discovery-api/omni-recommendation";

    try {
      let res;
      try {
        res = await axios.post(url, body, { headers, timeout: 15000 });
      } catch (e) {
        // Roblox có thể đòi X-CSRF-TOKEN: lấy token từ phản hồi 403 rồi thử lại 1 lần.
        const token = e.response && e.response.headers && e.response.headers["x-csrf-token"];
        if (e.response && e.response.status === 403 && token) {
          res = await axios.post(url, body, {
            headers: { ...headers, "X-CSRF-TOKEN": token },
            timeout: 15000
          });
        } else {
          throw e;
        }
      }

      const parsed = GameSelector.parseRecentGames(res.data, limit);
      let games = parsed.games;

      // Thiếu rootPlaceId trong dữ liệu trả về -> đổi universeId sang placeId.
      const missing = parsed.missingUniverseIds;
      if (missing.length) {
        try {
          const r = await axios.get("https://games.roblox.com/v1/games", {
            params: { universeIds: missing.join(",") },
            headers: { "User-Agent": headers["User-Agent"], Accept: "application/json" },
            timeout: 15000
          });
          for (const g of (r.data && r.data.data) || []) {
            if (g && g.rootPlaceId) {
              games.push({ placeId: String(g.rootPlaceId), name: g.name || `Game ${g.rootPlaceId}` });
            }
          }
        } catch (e) {
          log(UIRenderer.message("warning", `Không đổi được universeId sang placeId: ${e.message}`));
        }
      }

      const seen = new Set();
      games = games.filter((g) => {
        if (seen.has(g.placeId)) return false;
        seen.add(g.placeId);
        return true;
      }).slice(0, limit);

      if (!games.length) {
        const topics = parsed.topics.length ? parsed.topics.join(", ") : "không có";
        log(UIRenderer.message("warning", `Không thấy game gần đây của tài khoản (các mục Roblox trả về: ${topics}). Nhập Place ID hoặc link server thủ công.`));
      }
      return games;
    } catch (e) {
      const status = e.response && e.response.status ? ` (HTTP ${e.response.status})` : "";
      log(UIRenderer.message("warning", `Không lấy được game gần đây${status}: ${e.message}. Nhập Place ID hoặc link server thủ công.`));
      return [];
    }
  }

  /** Tách game từ phản hồi omni-recommendation. Hàm thuần, không gọi mạng. */
  static parseRecentGames(data, limit = RECENT_GAMES_LIMIT) {
    const out = { games: [], missingUniverseIds: [], topics: [] };
    const sorts = Array.isArray(data && data.sorts) ? data.sorts : [];
    const label = (s) => Object.entries(s || {})
      .filter(([k, v]) => k !== "recommendationList" && (typeof v === "string" || typeof v === "number"))
      .map(([, v]) => String(v))
      .join(" ");

    out.topics = sorts.map((s) => String((s && (s.topic || s.sortDisplayName || s.sortName || s.sortId)) || "?"));

    const wanted = /continue|recent|jump back|resume|tiếp tục|gần đây/i;
    const sort = sorts.find((s) => wanted.test(label(s)));
    if (!sort) return out;

    const list = Array.isArray(sort.recommendationList) ? sort.recommendationList : [];
    const metaGame = (data.contentMetadata && data.contentMetadata.Game) || {};

    for (const item of list) {
      if (!item || !item.contentId) continue;
      if (item.contentType && String(item.contentType).toLowerCase() !== "game") continue;
      if (out.games.length + out.missingUniverseIds.length >= limit) break;

      const id = String(item.contentId);
      const meta = metaGame[id];
      if (meta && meta.rootPlaceId) {
        out.games.push({ placeId: String(meta.rootPlaceId), name: meta.name || `Game ${meta.rootPlaceId}` });
      } else {
        out.missingUniverseIds.push(id);
      }
    }
    return out;
  }
}

class StatusHandler {
  constructor() {
    this.hasLaunched = false;
    this.joinedAt = 0;
    this.failStreak = 0;
  }

  /** Phân tích dữ liệu presence thuần (không xét lỗi mạng / thời gian chờ). */
  analyzePresence(presence, targetRootPlaceId, targetUniverseId = null) {
    if (!presence || presence.userPresenceType === undefined) {
      return {
        status: "Không rõ",
        info: "Không lấy được trạng thái hoặc thiếu rootPlaceId",
        shouldLaunch: true,
        rejoinOnly: true
      };
    }

    if (presence.userPresenceType === 0) {
      return {
        status: "Offline",
        info: "User offline! Tiến hành rejoin! ",
        shouldLaunch: true,
        rejoinOnly: true
      };
    }

    if (presence.userPresenceType === 1) {
      return {
        status: "Online nhưng không trong game",
        info: "User online nhưng không trong game.",
        shouldLaunch: true,
        rejoinOnly: true
      };
    }

    if (presence.userPresenceType !== 2) {
      return {
        status: "Không online",
        info: "User không trong game. Đã mở lại game!",
        shouldLaunch: true,
        rejoinOnly: true
      };
    }

    // Đang trong game. Roblox đôi khi không trả Place ID (cài đặt riêng tư) -> không thể so map;
    // trước đây bị coi là "Sai map" và mở lại game liên tục mỗi chu kỳ.
    const actual = presence.rootPlaceId ?? presence.placeId;
    if (actual === undefined || actual === null || actual === "") {
      return {
        status: "Trong game",
        info: "Đang trong game (Roblox không trả Place ID nên không so được map)",
        shouldLaunch: false,
        rejoinOnly: true
      };
    }

    // 1 game có nhiều world: đúng map nếu placeId/rootPlaceId khớp, HOẶC cùng universe với place mục tiêu.
    const target = String(targetRootPlaceId);
    const sameUniverse = targetUniverseId && presence.universeId &&
      String(presence.universeId) === String(targetUniverseId);
    const samePlace = [presence.placeId, presence.rootPlaceId].some((v) => v !== undefined && v !== null && String(v) === target);
    if (!samePlace && !sameUniverse) {
      return {
        status: "Sai map",
        info: `User đang trong game nhưng sai rootPlaceId (${actual}). Đã rejoin đúng map! `,
        shouldLaunch: true,
        rejoinOnly: true
      };
    }

    return {
      status: "Online [+]",
      info: "Đang ở đúng game",
      shouldLaunch: false,
      rejoinOnly: true
    };
  }

  /**
   * Quyết định cuối cùng cho 1 lần kiểm tra.
   *  - Lỗi mạng / lỗi xác thực: KHÔNG mở lại game (trước đây mọi lỗi mạng đều bị coi là offline -> đóng/mở lại game vô cớ).
   *  - Vừa mở game xong: chờ LAUNCH_GRACE_MS để game kịp load, tránh mở lại đè lên lần đang vào.
   */
  evaluate(check, targetPlaceId, now = Date.now(), targetUniverseId = null) {
    if (check && check.error) {
      this.failStreak++;
      const auth = check.status === 401;
      return {
        status: auth ? "Cookie hết hạn" : "Lỗi mạng",
        info: auth
          ? "Cookie không còn hiệu lực — đăng nhập lại Roblox trên package này"
          : `${check.error}; giữ nguyên game, thử lại sau`,
        shouldLaunch: false,
        rejoinOnly: true,
        failed: true
      };
    }
    this.failStreak = 0;

    const analysis = this.analyzePresence(check ? check.presence : null, targetPlaceId, targetUniverseId);
    if (analysis.shouldLaunch && this.hasLaunched && now - this.joinedAt < LAUNCH_GRACE_MS) {
      const left = Math.ceil((LAUNCH_GRACE_MS - (now - this.joinedAt)) / 1000);
      return {
        status: "Đang vào game",
        info: `Vừa gửi lệnh mở game, chờ ${left}s để game load rồi mới kiểm tra lại`,
        shouldLaunch: false,
        rejoinOnly: true
      };
    }
    return analysis;
  }

  updateJoinStatus(shouldLaunch) {
    if (shouldLaunch) {
      this.joinedAt = Date.now();
      this.hasLaunched = true;
    }
  }
}

/**
 * ================= GIAO DIỆN (MIDNIGHT CYAN) =================
 * Menu chính luôn chia 2 cột ngang. nội dung dài tự xuống dòng.
 * Màn hình hẹp (<96 cột): bảng giám sát / danh sách config tự chuyển thành thẻ.
 */
class UIRenderer {
  static palette = {
    accent: "1;38;5;87",
    violet: "1;38;5;147",
    blue: "1;38;5;75",
    good: "1;38;5;121",
    warn: "1;38;5;221",
    bad: "1;38;5;203",
    text: "38;5;255",
    dim: "38;5;245",
    border: "38;5;63",
    muted: "38;5;60"
  };

  // Map mã màu cũ (1;31, 1;32...) sang theme mới để mọi chỗ gọi cũ vẫn đồng bộ.
  static legacyColors = {
    "1;31": "bad",
    "1;32": "good",
    "1;33": "warn",
    "1;34": "blue",
    "1;35": "violet",
    "1;36": "accent",
    "1;37": "text",
    "2;37": "dim"
  };

  // Dải gradient banner / thanh tiến trình: cyan -> xanh -> tím nhạt (mã màu 256).
  static gradientStops = [87, 81, 75, 69, 105, 141, 147, 183];
  static spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  static themeName = "midnight";
  static uiFont = "auto";
  static animOn = true;

  // Mỗi theme gồm bảng màu 256 + dải gradient cho banner / thanh tiến trình.
  static themes = {
    midnight: {
      label: "Midnight Cyan",
      desc: "Xanh cyan → tím nhạt (mặc định)",
      palette: {
        accent: "1;38;5;87", violet: "1;38;5;147", blue: "1;38;5;75", good: "1;38;5;121",
        warn: "1;38;5;221", bad: "1;38;5;203", text: "38;5;255", dim: "38;5;245",
        border: "38;5;63", muted: "38;5;60"
      },
      stops: [87, 81, 75, 69, 105, 141, 147, 183]
    },
    aurora: {
      label: "Aurora",
      desc: "Xanh lá → ngọc → xanh dương, dịu mắt",
      palette: {
        accent: "1;38;5;86", violet: "1;38;5;115", blue: "1;38;5;79", good: "1;38;5;120",
        warn: "1;38;5;221", bad: "1;38;5;203", text: "38;5;255", dim: "38;5;245",
        border: "38;5;30", muted: "38;5;65"
      },
      stops: [120, 84, 49, 43, 37, 38, 74, 110]
    },
    sunset: {
      label: "Sunset",
      desc: "Vàng → cam → hồng → tím, ấm",
      palette: {
        accent: "1;38;5;215", violet: "1;38;5;218", blue: "1;38;5;180", good: "1;38;5;150",
        warn: "1;38;5;228", bad: "1;38;5;203", text: "38;5;255", dim: "38;5;245",
        border: "38;5;137", muted: "38;5;95"
      },
      stops: [229, 222, 216, 210, 204, 198, 169, 135]
    }
  };

  static applyTheme(name) {
    const key = this.themes[name] ? name : "midnight";
    this.themeName = key;
    this.palette = { ...this.themes[key].palette };
    this.gradientStops = [...this.themes[key].stops];
  }

  /** Áp cấu hình giao diện đã lưu (theme / phông chữ banner / hoạt ảnh). */
  static applyUiConfig(config = {}) {
    this.applyTheme(config.theme);
    this.uiFont = String(config.font || "auto");
    this.animOn = config.anim !== false;
    this._bannerCache.clear();
  }

  /** Dải màu minh họa của 1 theme (dùng ở màn chọn bảng màu). */
  static _swatch(key) {
    const t = this.themes[key];
    if (!t) return "";
    return t.stops.map((i) => this._fg(i, "━━")).join("");
  }

  // Chữ khối 5 hàng cho banner khi figlet không có hoặc terminal hẹp (REJOIN rộng 35 cột).
  static _blockFont = {
    R: ["████ ", "█   █", "████ ", "█  █ ", "█   █"],
    E: ["█████", "█    ", "████ ", "█    ", "█████"],
    J: ["  ███", "    █", "    █", "█   █", " ███ "],
    O: [" ███ ", "█   █", "█   █", "█   █", " ███ "],
    I: ["█████", "  █  ", "  █  ", "  █  ", "█████"],
    N: ["█   █", "██  █", "█ █ █", "█  ██", "█   █"]
  };

  // Phông 3 hàng (kiểu Calvin S) vẽ bằng ký tự khung đôi: chỉ rộng 15 cột nên vừa cả màn hình điện thoại hẹp / thấp.
  static _miniFont = {
    R: ["╦═╗", "╠╦╝", "╩╚═"],
    E: ["╔═╗", "║╣ ", "╚═╝"],
    J: [" ╦", " ║", "╚╝"],
    O: ["╔═╗", "║ ║", "╚═╝"],
    I: ["╦", "║", "╩"],
    N: ["╔╗╔", "║║║", "╝╚╝"]
  };

  // Phông figlet gợi ý (chỉ hiện trong menu nếu figlet thật sự có phông đó).
  static figletFonts = ["ANSI Shadow", "ANSI Regular", "Slant", "Big", "Standard", "Doom", "Calvin S", "Small"];

  static _bannerCache = new Map();

  static _colorOn() {
    return (
      process.env.NO_COLOR === undefined &&
      (Boolean(process.stdout.isTTY) || Boolean(process.env.FORCE_COLOR))
    );
  }

  /** Hoạt ảnh chỉ chạy trên terminal thật. Tắt bằng REJOIN_NO_ANIM=1. */
  static _motionOn() {
    return (
      this.animOn !== false &&
      Boolean(process.stdout.isTTY) &&
      process.env.NO_COLOR === undefined &&
      process.env.TERM !== "dumb" &&
      !process.env.REJOIN_NO_ANIM
    );
  }

  /** Số hàng tối đa dành cho banner: phần còn lại của màn hình phải đủ chỗ cho menu (~24 dòng). */
  static _bannerBudget() {
    return (process.stdout.rows || 0) - 24;
  }

  /** Màn hình đủ cao để hiện banner lớn (bàn phím ảo trên điện thoại thường làm màn thấp). */
  static _tall() {
    return this._banner(this._width() - 4, this._bannerBudget()).length > 0;
  }

  static _toneIndex(tone) {
    const key = this.legacyColors[tone] || tone;
    const code = this.palette[key] || key;
    const m = /38;5;(\d+)/.exec(String(code));
    return m ? Number(m[1]) : null;
  }

  static _fg(index, text, bold = true) {
    if (!this._colorOn()) return String(text);
    return `\x1b[${bold ? "1;" : ""}38;5;${index}m${text}\x1b[0m`;
  }

  static _gradAt(t) {
    const stops = this.gradientStops;
    return stops[Math.round(clamp(t, 0, 1) * (stops.length - 1))];
  }

  /**
   * Tô gradient theo cột. sweep = vị trí cột của vệt sáng đang quét (null = không quét);
   * row làm vệt sáng nghiêng nhẹ khi vẽ nhiều dòng.
   */
  static gradient(text, { sweep = null, row = 0 } = {}) {
    const chars = this._chars(text);
    if (!this._colorOn()) return chars.join("");
    const last = Math.max(1, chars.length - 1);
    let out = "";
    chars.forEach((ch, i) => {
      if (ch === " ") {
        out += ch;
        return;
      }
      let index = this._gradAt(i / last);
      if (sweep !== null) {
        const dist = Math.abs(i - (sweep - row * 2));
        if (dist <= 1) index = 231;
        else if (dist <= 3) index = 195;
      }
      out += `\x1b[1;38;5;${index}m${ch}\x1b[0m`;
    });
    return out;
  }

  /** Nhãn phím dạng chip nền màu: " 1 ". Không có màu thì quay về "[1]" (cùng độ rộng). */
  static _chip(key, tone = "accent") {
    const label = String(key);
    const index = this._toneIndex(tone);
    if (!this._colorOn() || index === null) return `[${label}]`;
    return `\x1b[1;38;5;16;48;5;${index}m ${label} \x1b[0m`;
  }

  /**
   * Vẽ lại cả khung hình tại chỗ (không xoá màn hình trước) nên không bị nháy.
   * fit=true: cắt bớt khung cho vừa chiều cao terminal — trước đây khung dài hơn màn hình làm nội dung
   * cuộn lên và dội hình chồng chéo mỗi giây (rất hay gặp trên điện thoại khi chạy nhiều instance).
   */
  static paint(frame, { hideCursor = false, fit = false } = {}) {
    if (!process.stdout.isTTY) {
      process.stdout.write(String(frame) + "\n");
      return;
    }
    let lines = String(frame).split("\n");
    const rows = process.stdout.rows || 0;
    if (fit && rows > 4 && lines.length > rows - 1) {
      const keep = rows - 2;
      const hidden = lines.length - keep;
      lines = lines.slice(0, keep);
      lines.push(this.color("dim", `  … còn ${hidden} dòng (thu nhỏ cỡ chữ hoặc xoay ngang để xem đủ)`));
    }
    const body = lines.map((line) => line + "\x1b[K").join("\n");
    process.stdout.write((hideCursor ? "\x1b[?25l" : "") + "\x1b[H" + body + "\n\x1b[J");
  }

  /** Spinner cho tác vụ chờ mạng. Ngoài terminal thật thì chỉ in 1 dòng thông tin. */
  static spinner(text) {
    if (!this._motionOn()) {
      console.log(this.message("info", text));
      return { update() {}, stop(finalMessage) { if (finalMessage) console.log(finalMessage); } };
    }
    let label = String(text);
    let i = 0;
    const draw = () => {
      const room = Math.max(10, this._width() - 6);
      process.stdout.write(
        "\r\x1b[K" +
        this.color("accent", `  ${this.spinnerFrames[i++ % this.spinnerFrames.length]} `) +
        this.color("text", this.fit(label, room).trimEnd())
      );
    };
    process.stdout.write("\x1b[?25l");
    draw();
    const timer = setInterval(draw, 80);
    return {
      update(next) { label = String(next); },
      stop(finalMessage) {
        clearInterval(timer);
        process.stdout.write("\r\x1b[K\x1b[?25h");
        if (finalMessage) console.log(finalMessage);
      }
    };
  }

  /** Ghép chữ REJOIN từ phông tích hợp ("block" 5 hàng, "mini" 3 hàng). */
  static _glyphRows(font) {
    const glyphs = font === "mini" ? this._miniFont : this._blockFont;
    const height = glyphs.R.length;
    const rows = Array.from({ length: height }, () => "");
    const gap = font === "mini" ? "" : " ";
    for (const ch of "REJOIN") {
      glyphs[ch].forEach((line, i) => {
        rows[i] += (rows[i] ? gap : "") + line;
      });
    }
    return rows;
  }

  /** Vẽ chữ REJOIN bằng 1 phông (tích hợp hoặc figlet). null nếu phông không dùng được. */
  static _renderFont(name) {
    if (name === "block" || name === "mini") return this._glyphRows(name);
    if (!figlet) return null;
    try {
      const out = figlet
        .textSync("REJOIN", { font: name })
        .split("\n")
        .map((l) => l.replace(/\s+$/, ""));
      while (out.length && !out[out.length - 1].trim()) out.pop();
      while (out.length && !out[0].trim()) out.shift();
      return out.length ? out : null;
    } catch (_) {
      return null; // thiếu phông
    }
  }

  /**
   * Banner chữ lớn theo phông người dùng chọn; không vừa (rộng/cao) thì tự lùi về phông nhỏ hơn:
   * <chọn> → ANSI Shadow → block → mini. Hẹp / thấp quá thì [] (dùng tiêu đề gọn).
   */
  static _banner(maxWidth, maxHeight = Infinity) {
    const font = this.uiFont || "auto";
    const key = `${font}|${maxWidth}|${maxHeight}`;
    if (this._bannerCache.has(key)) return this._bannerCache.get(key);

    const fits = (rows) =>
      Array.isArray(rows) && rows.length > 0 &&
      rows.length <= maxHeight &&
      Math.max(...rows.map((l) => this._len(l))) <= maxWidth;

    const chain = [...new Set([
      ...(font === "auto" ? [] : [font]),
      "ANSI Shadow", "block", "mini"
    ])];

    let rows = [];
    for (const name of chain) {
      const candidate = this._renderFont(name);
      if (fits(candidate)) {
        rows = candidate;
        break;
      }
    }
    this._bannerCache.set(key, rows);
    return rows;
  }

  /** Danh sách phông cho menu Giao diện, kèm kích thước thực tế của từng phông. */
  static fontChoices() {
    const budget = this._width() - 4;
    const describe = (rows) => {
      const w = Math.max(...rows.map((l) => this._len(l)));
      return `${rows.length} dòng • ${w} cột` + (w > budget ? " • quá rộng, sẽ tự dùng phông nhỏ hơn" : "");
    };
    const choices = [{ key: "auto", label: "Tự động", desc: "Chọn phông lớn nhất vừa màn hình" }];
    const add = (key, label) => {
      const rows = this._renderFont(key);
      if (rows) choices.push({ key, label, desc: describe(rows) });
    };
    add("block", "Khối (tích hợp)");
    add("mini", "Mini (tích hợp)");
    for (const name of this.figletFonts) add(name, name);
    return choices;
  }

  static color(code, text) {
    const value = String(text ?? "");
    if (
      process.env.NO_COLOR !== undefined ||
      (!process.stdout.isTTY && !process.env.FORCE_COLOR)
    ) {
      return value;
    }
    const key = this.legacyColors[code] || code;
    const tone = this.palette[key] || key;
    return `\x1b[${tone}m${value}\x1b[0m`;
  }

  static stripAnsi(text) {
    return String(text ?? "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  }

  static _chars(text) {
    return Array.from(this.stripAnsi(text).normalize("NFC"));
  }

  static _len(text) {
    return this._chars(text).length;
  }

  static _width(max = 94) {
    return Math.max(33, Math.min(max, (process.stdout.columns || 80) - 1));
  }

  static fit(text, width) {
    const size = Math.max(0, Math.floor(Number(width) || 0));
    if (!size) return "";
    const chars = this._chars(String(text ?? "").replace(/[\r\n\t]+/g, " "));
    if (chars.length <= size) {
      return chars.join("") + " ".repeat(size - chars.length);
    }
    return size === 1 ? "…" : chars.slice(0, size - 1).join("") + "…";
  }

  static _wrap(text, width) {
    const limit = Math.max(1, Math.floor(width));
    const paragraphs = this.stripAnsi(text)
      .normalize("NFC")
      .replace(/\t/g, " ")
      .split(/\r?\n/);
    const out = [];

    for (const paragraph of paragraphs) {
      const words = paragraph.trim().split(/\s+/).filter(Boolean);
      let line = "";

      if (!words.length) {
        out.push("");
        continue;
      }

      for (const word of words) {
        const candidate = line ? line + " " + word : word;
        if (this._len(candidate) <= limit) {
          line = candidate;
          continue;
        }
        if (line) {
          out.push(line);
          line = "";
        }
        const chars = this._chars(word);
        while (chars.length > limit) {
          out.push(chars.splice(0, limit).join(""));
        }
        line = chars.join("");
      }

      if (line) out.push(line);
    }

    return out.length ? out : [""];
  }

  static _center(text, width) {
    const value = this.fit(text, width).trimEnd();
    const left = Math.max(0, Math.floor((width - this._len(value)) / 2));
    return this.fit(" ".repeat(left) + value, width);
  }

  static _panel(title, lines, width = this._width()) {
    const inner = width - 2;
    const contentWidth = width - 4;
    const B = (text) => this.color("border", text);

    const heading = title ? this.fit(" " + title, inner - 2).trimEnd() : "";
    const prefix = heading ? "─" + heading + " " : "";
    const top = prefix + "─".repeat(Math.max(0, inner - this._len(prefix)));

    const body = lines.map((line) => {
      const value = String(line ?? "");
      return (
        B("│") + " " + value +
        " ".repeat(Math.max(0, contentWidth - this._len(value))) +
        " " + B("│")
      );
    });

    return [
      B("╭" + top + "╮"),
      ...body,
      B("╰" + "─".repeat(inner) + "╯")
    ].join("\n");
  }

  /**
   * Tiêu đề. big=true: banner chữ lớn (menu chính). Mặc định: bản gọn cho các màn con.
   * reveal / sweep / done chỉ dùng cho hoạt ảnh mở đầu.
   */
  static renderTitle({ big = false, reveal = Infinity, sweep = null, done = true, preview = false } = {}) {
    const width = this._width();
    const contentWidth = width - 4;
    const subtitle =
      width >= 60
        ? "ANDROID  /  MULTI INSTANCE  /  LIVE MONITOR"
        : "ANDROID / LIVE MONITOR";
    const subtitleLine = done
      ? this.color("violet", this._center(subtitle, contentWidth))
      : "";

    const rows = big ? this._banner(contentWidth, preview ? Infinity : this._bannerBudget()) : [];
    const lines = [];

    if (rows.length) {
      const bannerWidth = Math.max(...rows.map((l) => this._len(l)));
      const pad = " ".repeat(Math.max(0, Math.floor((contentWidth - bannerWidth) / 2)));
      rows.forEach((row, i) => {
        lines.push(i < reveal ? pad + this.gradient(row, { sweep, row: i }) : "");
      });
      lines.push(subtitleLine);
    } else {
      const word = "R E J O I N";
      const pad = " ".repeat(Math.max(0, Math.floor((contentWidth - word.length) / 2)));
      lines.push(pad + this.gradient(word, { sweep }));
      lines.push(subtitleLine);
    }

    return "\n" + this._panel("CONTROL CENTER", lines, width);
  }

  /** Hoạt ảnh mở đầu: banner hiện từng dòng rồi một vệt sáng quét qua. Chạy 1 lần khi mở tool. */
  static async intro() {
    if (!this._motionOn() || !this._tall()) return;
    const rows = this._banner(this._width() - 4, this._bannerBudget());
    const bannerWidth = Math.max(...rows.map((l) => this._len(l)));
    const sweepSteps = 10;
    process.stdout.write("\x1b[?25l");
    try {
      for (let step = 0; step < rows.length + sweepSteps; step++) {
        const reveal = Math.min(rows.length, step + 1);
        const sweep = step < rows.length
          ? null
          : ((step - rows.length) / (sweepSteps - 1)) * (bannerWidth + 8) - 4;
        this.paint(this.renderTitle({ big: true, reveal, sweep, done: reveal >= rows.length }));
        await sleep(45);
      }
    } finally {
      process.stdout.write("\x1b[?25h");
    }
  }

  static renderSection(title, subtitle = "") {
    const width = this._width();
    const lines = [
      "",
      "  " + this._fg(this.gradientStops[0], "◆ ") + this.gradient(String(title))
    ];
    if (subtitle) {
      lines.push(
        ...this._wrap(subtitle, width - 2).map((l) => this.color("dim", `  ${l}`))
      );
    }
    const lead = Math.min(8, width);
    lines.push(
      this._fg(this.gradientStops[2], "━".repeat(lead)) +
      this.color("muted", "─".repeat(width - lead))
    );
    return lines.join("\n");
  }

  static screen(title, subtitle = "") {
    console.clear();
    console.log(this.renderTitle());
    console.log(this.renderSection(title, subtitle));
  }

  static divider(label = "") {
    const width = this._width();
    const text = String(label).trim();
    if (!text) return this.color("muted", "─".repeat(width));
    const heading = `── ${text.toUpperCase()} `;
    return this.color(
      "muted",
      this.fit(heading + "─".repeat(Math.max(0, width - this._len(heading))), width)
    );
  }

  static prompt(label) {
    return `\n${this.color("accent", "  ❯ ")}${this.color("text", label)}${this.color("violet", " : ")}`;
  }

  static message(type, text) {
    const styles = {
      success: ["good", "✓", "THÀNH CÔNG"],
      error: ["bad", "✕", "LỖI"],
      warning: ["warn", "!", "CHÚ Ý"],
      info: ["accent", "•", "THÔNG TIN"]
    };
    const [tone, icon, label] = styles[type] || styles.info;
    return (
      this.color(tone, `  ${icon} ${label}`) +
      this.color("muted", "  │  ") +
      this.color("text", text)
    );
  }

  static infoCard(rows, title = "THÔNG TIN") {
    const width = this._width();
    const contentWidth = width - 4;
    const safeRows = Array.isArray(rows) ? rows : [];

    const longestLabel = Math.max(
      6,
      ...safeRows.map(([label]) => this._len(label))
    );
    const labelWidth = Math.min(
      longestLabel,
      16,
      Math.max(8, Math.floor((contentWidth - 3) / 3))
    );
    const valueWidth = contentWidth - labelWidth - 3;
    const lines = [];

    for (const [label, value, tone = "text"] of safeRows) {
      const parts = this._wrap(value ?? "-", valueWidth);
      parts.forEach((part, index) => {
        const heading = index === 0 ? String(label).toUpperCase() : "";
        lines.push(
          this.color("dim", this.fit(heading, labelWidth)) +
          this.color("muted", " │ ") +
          this.color(tone, this.fit(part, valueWidth))
        );
      });
    }

    return this._panel(title, lines, width);
  }

  static options(items, { footer = "Nhập số để lựa chọn", accent = "accent" } = {}) {
    const width = this._width();
    const contentWidth = width - 4;
    const lines = [];

    items.forEach((item, index) => {
      const badgeLen = this._len(String(item.key)) + 2;
      lines.push(
        this._chip(item.key, item.color || accent) +
        " " +
        this.color(
          "text",
          this.fit(item.label || "", Math.max(1, contentWidth - badgeLen - 1))
        )
      );
      if (item.description) {
        lines.push(
          ...this._wrap(item.description, contentWidth - 2).map(
            (l) => this.color("dim", `  ${l}`)
          )
        );
      }
      if (index < items.length - 1) {
        lines.push(this.color("muted", "─".repeat(contentWidth)));
      }
    });

    const panel = this._panel("LỰA CHỌN", lines, width);
    return footer ? panel + "\n" + this.color("dim", `  ${footer}`) : panel;
  }

  static selectionCard(items, title = "ĐÃ CHỌN") {
    if (!items || !items.length) {
      return this.message("warning", "Chưa có mục nào được chọn.");
    }
    return this.infoCard(
      items.map((item, index) => [
        String(index + 1).padStart(2, "0"),
        String(item),
        "good"
      ]),
      title
    );
  }

  static progressBar(value, total, size = 14) {
    const length = Math.max(1, Math.floor(size));
    const ratio = total > 0 ? clamp(value / total, 0, 1) : 0;
    const filled = Math.round(ratio * length);
    let bar = "";
    for (let i = 0; i < filled; i++) {
      bar += this._fg(this._gradAt(length > 1 ? i / (length - 1) : 0), "━");
    }
    // Phần chưa đầy dùng nét mảnh để vẫn phân biệt được khi terminal không có màu.
    return bar + this.color("muted", "─".repeat(length - filled));
  }

  static step(current, total, label) {
    const size = this._width() < 55 ? 8 : 16;
    return (
      this.color("violet", `  ${current}/${total}`) +
      this.progressBar(current, total, size) +
      `  ${this.color("text", label)}`
    );
  }

  /** MENU CHÍNH: LUÔN 2 CỘT NGANG (trái 1-4, phải 5-0). */
  static renderMainMenu({ configCount, prefix, webhook, autoexec, wakeOff = false }) {
    const width = this._width();
    const contentWidth = width - 4;
    const leftWidth = Math.floor((width - 3) / 2);
    const rightWidth = width - 3 - leftWidth;
    const showDesc = Math.min(leftWidth, rightWidth) >= 27;
    const B = (text) => this.color("border", text);

    const leftItems = [
      ["1", "Chạy Rejoin", "Theo dõi và tự vào lại game", "good"],
      ["2", "Thiết lập", "Quét và thêm tài khoản", "accent"],
      ["3", "Cấu hình", "Game, delay, private server", "blue"],
      ["4", "Prefix", "Tên package Roblox", "violet"]
    ];

    const rightItems = [
      ["5", "Activity", "Mặc định hoặc tùy chỉnh", "violet"],
      ["6", "Webhook", "Báo cáo trạng thái Discord", "accent"],
      ["7", "Autoexec", "Quản lý script executor", "warn"],
      ["8", "Quét world", "Lấy Place ID các map", "blue"]
    ];

    const cfgTone = configCount > 0 ? "good" : "warn";
    const labelOf = (text) => this.color("dim", this.fit(text, 9));
    const valueRoom = Math.max(1, contentWidth - 12);
    const webhookOn = Boolean(webhook?.enabled);
    const autoexecOn = Boolean(autoexec?.executor);
    const seg = (on, text) =>
      this.color(on ? "good" : "muted", "●") + " " +
      this.color(on ? "text" : "dim", this.fit(text, Math.max(1, contentWidth - 2)).trimEnd());
    const webhookText = `Webhook ${webhookOn ? "bật" : "tắt"}`;
    const autoexecText = `Autoexec ${autoexecOn ? autoexec.executor : "tắt"}`;
    const sideBySide =
      this._len(webhookText) + this._len(autoexecText) + 7 <= contentWidth;

    const meta = [
      this.color(cfgTone, "●") + " " + labelOf("Cấu hình") + " " +
        this.color(cfgTone, this.fit(
          configCount > 0 ? `${configCount} đã thiết lập` : "Chưa thiết lập",
          valueRoom
        ).trimEnd()),
      this.color("blue", "●") + " " + labelOf("Prefix") + " " +
        this.color("text", this.fit(prefix || "com.roblox", valueRoom).trimEnd()),
      ...(sideBySide
        ? [seg(webhookOn, webhookText) + "   " + seg(autoexecOn, autoexecText)]
        : [seg(webhookOn, webhookText), seg(autoexecOn, autoexecText)]),
      ...(wakeOff
        ? [this.color("warn", "!") + " " + this.color("warn", this.fit("Wake lock chưa bật — máy có thể ngủ làm tool dừng", Math.max(1, contentWidth - 2)).trimEnd())]
        : [])
    ];

    const cell = ([key, label, description, tone], w) => [
      ` ${this._chip(key, tone)} ${this.color("text", this.fit(label, Math.max(1, w - 6)))} `,
      this.color("dim", ` ${this.fit(description, Math.max(1, w - 2))} `)
    ];

    const ruleL = "─".repeat(leftWidth);
    const ruleR = "─".repeat(rightWidth);
    const lines = [
      this._panel("TỔNG QUAN", meta, width),
      "",
      B(`╭${ruleL}┬${ruleR}╮`)
    ];

    for (let i = 0; i < leftItems.length; i++) {
      const l = cell(leftItems[i], leftWidth);
      const r = cell(rightItems[i], rightWidth);
      lines.push(`${B("│")}${l[0]}${B("│")}${r[0]}${B("│")}`);
      if (showDesc) {
        lines.push(`${B("│")}${l[1]}${B("│")}${r[1]}${B("│")}`);
      }
      if (i < leftItems.length - 1) {
        lines.push(B(`├${ruleL}┼${ruleR}┤`));
      }
    }

    lines.push(B(`╰${ruleL}┴${ruleR}╯`));
    lines.push(this._chip("0", "bad") + this.color("dim", " Thoát (hoặc Q)") + this.color("muted", "  │  ") + this.color("dim", "Nhập số để chọn"));
    return lines.join("\n");
  }

  static _cpuSample = null;

  static getSystemStats() {
    let cpus = [];
    try {
      cpus = os.cpus() || [];
    } catch (_) { }

    const idle = cpus.reduce((s, c) => s + c.times.idle, 0);
    const total = cpus.reduce(
      (s, c) => s + Object.values(c.times).reduce((a, b) => a + b, 0),
      0
    );

    const now = Date.now();
    const prev = this._cpuSample;
    let usage = prev ? prev.usage : 0;

    if (!prev || now - prev.at >= 1000) {
      const dTotal = prev ? total - prev.total : total;
      const dIdle = prev ? idle - prev.idle : idle;
      if (dTotal > 0) {
        usage = clamp(100 * (1 - dIdle / dTotal), 0, 100);
      }
      this._cpuSample = { idle, total, usage, at: now };
    }

    const totalMem = os.totalmem();
    const usedMem = Math.max(0, totalMem - os.freemem());
    const gb = (v) => (v / (1024 ** 3)).toFixed(2);

    return {
      cpuUsage: usage.toFixed(1),
      ramUsage: `${gb(usedMem)} / ${gb(totalMem)} GB`
    };
  }

  static _statusTone(status) {
    const v = String(status || "").trim();
    if (v === "Online [+]" || v === "Trong game") return "good";
    if (v === "Offline" || v === "Sai map" || v === "Cookie hết hạn" || v === "Lỗi mở game") return "bad";
    if (v === "Lỗi mạng") return "warn";
    if (v.includes("Khởi tạo") || v === "Đang xác nhận" || v === "Đang vào game") return "accent";
    return "violet";
  }

  /** Chấm trạng thái: đang xử lý -> spinner, đang chạy -> nhịp tim, còn lại -> chấm đặc. */
  static _dot(status, frame = 0) {
    const tone = this._statusTone(status);
    if (tone === "accent") return this.spinnerFrames[frame % this.spinnerFrames.length];
    if (tone === "good") return frame % 4 === 3 ? "○" : "●";
    return "●";
  }

  static statusColor(status, frame = 0) {
    const text = String(status || "Không rõ");
    return this.color(this._statusTone(status), `${this._dot(status, frame)} ${text}`);
  }

  static formatCountdown(seconds) {
    const n = Number(seconds);
    const v = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
    if (v >= 3600) {
      return `${Math.floor(v / 3600)}h ${Math.floor((v % 3600) / 60)}m`;
    }
    if (v >= 60) {
      return `${Math.floor(v / 60)}m ${String(v % 60).padStart(2, "0")}s`;
    }
    return `${v}s`;
  }

  static _clock(ts) {
    if (!ts) return "--:--:--";
    const d = new Date(Number(ts));
    if (!Number.isFinite(d.getTime())) return "--:--:--";
    const p = (x) => String(x).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  static _table(head, rows, weights, width) {
    const budget = Math.max(30, width - 2 * (head.length + 1));
    let remaining = budget;
    const colWidths = weights.map((w, i) => {
      if (i === weights.length - 1) return Math.max(4, remaining);
      const size = Math.floor(budget * w);
      remaining -= size;
      return size;
    });

    const useColor =
      process.env.NO_COLOR === undefined &&
      (process.stdout.isTTY || Boolean(process.env.FORCE_COLOR));

    const table = new Table({
      head: head.map((h) => this.color("accent", h)),
      colWidths,
      wordWrap: true,
      chars: {
        top: "─", "top-mid": "┬", "top-left": "╭", "top-right": "╮",
        bottom: "─", "bottom-mid": "┴", "bottom-left": "╰", "bottom-right": "╯",
        left: "│", "left-mid": "├", mid: "─", "mid-mid": "┼",
        right: "│", "right-mid": "┤", middle: "│"
      },
      style: {
        head: [],
        border: useColor ? ["blue"] : [],
        "padding-left": 1,
        "padding-right": 1
      }
    });

    rows.forEach((row) => table.push(row));
    return table.toString();
  }

  /** Ghép 2 đoạn (trái / phải) vào cùng 1 dòng rộng `width` cột. */
  static _split(left, right, width) {
    const gap = Math.max(1, width - this._len(left) - this._len(right));
    return left + " ".repeat(gap) + right;
  }

  /** Tiêu đề 2 dòng cho màn giám sát (thay cho banner 9 dòng cũ, nhường chỗ cho dữ liệu). */
  static renderLiveHeader(frame = 0) {
    const width = this._width(118);
    const left = "  " + this._fg(this.gradientStops[0], "◆ ") + this.gradient("R E J O I N");
    const beat = this.color("good", frame % 4 === 3 ? "○" : "●");
    const right = this.color("dim", "LIVE ") + beat + this.color("dim", ` ${this._clock(Date.now())}  `);
    const lead = Math.min(8, width);
    const rule = this._fg(this.gradientStops[2], "━".repeat(lead)) + this.color("muted", "─".repeat(width - lead));
    return this._split(left, right, width) + "\n" + rule;
  }

  /** Bảng tổng quan 3 dòng: CPU/RAM, uptime/rejoin/lỗi, thanh tiến trình số instance trong game. */
  static _summaryPanel(instances, startTime, frame, width) {
    const inner = width - 4;
    const stats = this.getSystemStats();
    const inGame = instances.filter((x) => isInGameStatus(x.status)).length;
    const errors = instances.filter((x) => ERROR_STATUSES.has(String(x.status || "").trim())).length;
    const rejoins = instances.reduce((s, x) => s + (Number(x.rejoinCount) || 0), 0);

    const uptime = startTime ? Math.max(0, Math.floor((Date.now() - startTime) / 1000)) : 0;
    const p = (n) => String(n).padStart(2, "0");
    const up = `${p(Math.floor(uptime / 3600))}:${p(Math.floor((uptime % 3600) / 60))}:${p(uptime % 60)}`;

    const beat = this.color("good", frame % 4 === 3 ? "○" : "●");
    const row1 = `CPU ${stats.cpuUsage}%  •  RAM ${stats.ramUsage}`;
    const row2 = `UP ${up}  •  ↻ ${rejoins}  •  lỗi ${errors}`;
    const label = `${inGame}/${instances.length} trong game`;
    const size = clamp(inner - this._len(label) - 2, 4, 18);

    return this._panel("TỔNG QUAN", [
      ...this._wrap(row1, inner).map((l) => this.color("accent", l)),
      ...this._wrap(row2, inner - 2).map((l, i) =>
        (i === 0 ? beat + " " : "  ") + this.color(errors ? "warn" : "dim", l)),
      this.progressBar(inGame, instances.length, size) + "  " + this.color("good", label)
    ], width);
  }

  /** Mỗi instance 2 dòng: [chấm package user ... ↻n · đếm ngược] + [trạng thái — thông tin]. */
  static _instancePanel(instances, frame, width) {
    const inner = width - 4;
    const lines = [];

    instances.forEach((instance, index) => {
      const tone = this._statusTone(instance.status);
      const status = String(instance.status || "Không rõ").trim();
      const user = Utils.maskSensitiveInfo(
        (instance.config && instance.config.username) ||
        (instance.user && instance.user.username) || "Unknown"
      );
      const pkg = Utils.packageLabel(instance.packageName);
      const dot = this._dot(instance.status, frame);

      const meta = `↻${instance.rejoinCount || 0} · ${this.formatCountdown(instance.countdownSeconds)}`;
      const left = Math.max(6, inner - this._len(meta) - 1);
      const pkgW = clamp(Math.floor(left * 0.45), 4, 14);
      const userW = left - 2 - pkgW - 1;
      let head = this.color(tone, dot) + " " + this.color("accent", this.fit(pkg, pkgW).trimEnd());
      if (userW >= 3) head = this.color(tone, dot) + " " + this.color("accent", this.fit(pkg, pkgW)) + " " +
        this.color("dim", this.fit(user, userW).trimEnd());
      lines.push(this._split(head, this.color("violet", meta), inner));

      const room = inner - 2;
      const st = this.fit(status, Math.min(this._len(status), room)).trimEnd();
      const infoRoom = room - this._len(st) - 2;
      lines.push(
        "  " + this.color(tone, st) +
        (infoRoom >= 6 ? "  " + this.color("dim", this.fit(instance.info || "-", infoRoom).trimEnd()) : "")
      );

      if (index < instances.length - 1) lines.push(this.color("muted", "┄".repeat(inner)));
    });

    return this._panel(`INSTANCES ${instances.length}`, lines, width);
  }

  /** Nhật ký sự kiện (rejoin, đổi trạng thái, lỗi...) — thay cho log in chen vào khung hình. */
  static renderEventLog(events, maxLines) {
    const width = this._width(118);
    const inner = width - 4;
    const shown = (events || []).slice(-Math.max(1, maxLines));
    const icons = {
      error: ["bad", "✕"], warning: ["warn", "!"], success: ["good", "✓"], info: ["accent", "•"]
    };
    const lines = shown.map((ev) => {
      const [tone, icon] = icons[ev.level] || icons.info;
      return (
        this.color("dim", this._clock(ev.at)) + " " + this.color(tone, icon) + " " +
        this.color("text", this.fit(ev.text, Math.max(1, inner - 11)).trimEnd())
      );
    });
    return this._panel("NHẬT KÝ", lines, width);
  }

  static renderMultiInstanceTable(instances, startTime = null, frame = 0) {
    const width = this._width(118);
    const summary = this._summaryPanel(instances, startTime, frame, width);

    if (!instances.length) {
      return summary + "\n" + this.message("warning", "Chưa có instance đang chạy.");
    }

    // Màn hình hẹp: thẻ gọn 2 dòng/instance (trước đây mỗi instance 9 dòng, 3 instance là tràn màn hình).
    if (width < 96) {
      return summary + "\n" + this._instancePanel(instances, frame, width);
    }

    const rows = instances.map((instance) => {
      const username =
        (instance.config && instance.config.username) ||
        (instance.user && instance.user.username) ||
        "Unknown";
      return [
        Utils.packageLabel(instance.packageName),
        Utils.maskSensitiveInfo(username),
        this.statusColor(instance.status, frame),
        instance.info || "-",
        this._clock(instance.lastCheck),
        this.color("violet", this.formatCountdown(instance.countdownSeconds))
      ];
    });

    return (
      summary +
      "\n" +
      this._table(
        ["PACKAGE", "USER", "TRẠNG THÁI", "THÔNG TIN", "CẬP NHẬT", "QUÉT SAU"],
        rows,
        [0.18, 0.12, 0.19, 0.27, 0.13, 0.11],
        width
      )
    );
  }

  static displayConfiguredPackages(configs) {
    const entries = Object.entries(configs || {});
    const width = this._width(118);

    if (!entries.length) {
      return this.message("warning", "Chưa có cấu hình nào.");
    }

    if (width < 96) {
      return entries
        .map(([packageName, config], index) => {
          const c = config || {};
          return this.infoCard(
            [
              ["Package", Utils.packageLabel(packageName), "accent"],
              ["Tài khoản", Utils.maskSensitiveInfo(c.username || "Unknown")],
              ["Game", c.gameName || "Chưa đặt", "violet"],
              ["Place ID", c.placeId || "-", "dim"],
              ["Nhịp quét", c.delaySec ? `${c.delaySec} giây` : "Chưa đặt"],
              ["Server VIP", c.linkCode ? "ĐÃ CẤU HÌNH" : "KHÔNG", c.linkCode ? "good" : "dim"]
            ],
            `CẤU HÌNH ${String(index + 1).padStart(2, "0")}`
          );
        })
        .join("\n\n");
    }

    const rows = entries.map(([packageName, config], index) => {
      const c = config || {};
      return [
        String(index + 1).padStart(2, "0"),
        Utils.packageLabel(packageName),
        Utils.maskSensitiveInfo(c.username || "Unknown"),
        `${c.gameName || "Chưa đặt"}  (${c.placeId || "-"})`,
        c.delaySec ? `${c.delaySec}s` : "-",
        this.color(c.linkCode ? "good" : "dim", c.linkCode ? "CÓ" : "KHÔNG")
      ];
    });

    return this._table(
      ["#", "PACKAGE", "TÀI KHOẢN", "GAME / PLACE ID", "NHỊP QUÉT", "VIP"],
      rows,
      [0.05, 0.23, 0.17, 0.35, 0.10, 0.10],
      width
    );
  }
}

class AutoexecManager {
  constructor() {
    this.EXECUTORS = {
      "Delta": "/storage/emulated/0/Delta/Autoexecute/text.txt",
      "Ronix": "/storage/emulated/0/RonixExploit/autoexec/text.txt",
      "Codex": "/storage/emulated/0/Codex/Autoexec/text.txt",
      "Arceus X": "/storage/emulated/0/Arceus X/Autoexec/text.txt",
    };
  }

  loadConfig() {
    if (!fs.existsSync(AUTOEXEC_CONFIG_PATH)) return null;
    try {
      return JSON.parse(fs.readFileSync(AUTOEXEC_CONFIG_PATH, 'utf8'));
    } catch {
      return null;
    }
  }

  saveConfig(config) {
    try {
      Utils.writeJsonAtomic(AUTOEXEC_CONFIG_PATH, config);
      return true;
    } catch (e) {
      console.error(UIRenderer.message("error", `Không thể lưu cấu hình autoexec: ${e.message}`));
      return false;
    }
  }

  writeToExecutor(executorName, scriptContent) {
    const pathStr = this.EXECUTORS[executorName];
    if (!pathStr) return false;

    try {
      const dir = path.dirname(pathStr);
      if (!fs.existsSync(dir)) {
        try { fs.mkdirSync(dir, { recursive: true }); } catch { }
      }

      fs.writeFileSync(pathStr, scriptContent, 'utf8');
      console.log(`[+] Đã ghi script vào ${executorName}: ${pathStr}`);
      return true;
    } catch (e) {
      console.error(`[-] Lỗi khi ghi file autoexec: ${e.message}`);
      return false;
    }
  }

  async setup(rl) {
    UIRenderer.screen("Autoexec", "Quản lý script executor");

    const currentConfig = this.loadConfig();
    let currentScript = "";
    if (currentConfig) {
      console.log(UIRenderer.infoCard([
        ["Executor", currentConfig.executor, "1;32"],
        ["Đường dẫn", currentConfig.path || "Chưa xác định"],
        ["Script", currentConfig.script ? `${currentConfig.script.length} ký tự` : "Trống"]
      ], "CẤU HÌNH HIỆN TẠI"));
      currentScript = currentConfig.script || "";
    }

    const executors = Object.keys(this.EXECUTORS);
    console.log(UIRenderer.options(executors.map((ex, i) => ({
      key: i + 1,
      label: ex,
      description: this.EXECUTORS[ex]
    })), { footer: "Chọn executor muốn cấu hình", accent: "1;35" }));

    const choice = parseInt(await Utils.ask(rl, UIRenderer.prompt(`Executor [1-${executors.length}]`)), 10) - 1;
    if (!Number.isInteger(choice) || choice < 0 || choice >= executors.length) {
      console.log(UIRenderer.message("error", "Lựa chọn executor không hợp lệ."));
      return;
    }

    const selectedExecutor = executors[choice];

    console.log(`\n${UIRenderer.step(2, 3, "Nhập nội dung script")}`);
    console.log(UIRenderer.message("info", "Nano sẽ được mở; nếu không khả dụng, nhập EXIT ở dòng mới để kết thúc."));
    const script = await Utils.openEditor(rl, currentScript);

    if (!script || !script.trim()) {
      console.log(UIRenderer.message("error", "Script đang trống."));
      return;
    }

    console.log(UIRenderer.renderSection("Xem trước script", `${script.length} ký tự`));
    console.log(UIRenderer.infoCard([["Nội dung", script.substring(0, 200) + (script.length > 200 ? "..." : "")]], "PREVIEW"));
    console.log(UIRenderer.step(3, 3, "Xác nhận và lưu"));

    const confirm = await Utils.ask(rl, UIRenderer.prompt("Lưu script? [y/N]"));
    if (confirm.toLowerCase() !== 'y') {
      console.log(UIRenderer.message("warning", "Đã hủy lưu script."));
      return;
    }

    const config = {
      executor: selectedExecutor,
      script: script.trim(),
      path: this.EXECUTORS[selectedExecutor]
    };

    const configSaved = this.saveConfig(config);
    const scriptWritten = this.writeToExecutor(selectedExecutor, script.trim());

    const completed = configSaved && scriptWritten;
    console.log(UIRenderer.infoCard([
      ["Executor", selectedExecutor, completed ? "1;32" : "1;33"],
      ["Đường dẫn", this.EXECUTORS[selectedExecutor]],
      ["Cấu hình", configSaved ? "ĐÃ LƯU" : "THẤT BẠI", configSaved ? "1;32" : "1;31"],
      ["File script", scriptWritten ? "ĐÃ GHI" : "THẤT BẠI", scriptWritten ? "1;32" : "1;31"],
      ["Kết quả", completed ? "HOÀN TẤT" : "CHƯA HOÀN TẤT", completed ? "1;32" : "1;31"]
    ], completed ? "AUTOEXEC HOÀN TẤT" : "AUTOEXEC GẶP LỖI"));
    console.log(UIRenderer.message(
      completed ? "success" : "error",
      completed ? "Script đã sẵn sàng cho executor." : "Kiểm tra quyền truy cập bộ nhớ rồi thử lại."
    ));
    await sleep(completed ? 1500 : 2500);
  }

  checkAndFix(config) {
    if (!config || !config.path || !config.script) return;
    try {
      let currentContent = "";
      if (fs.existsSync(config.path)) {
        currentContent = fs.readFileSync(config.path, 'utf8');
      }

      if (currentContent.trim() !== config.script.trim()) {
        console.log(`\n[Autoexec] Phát hiện sai lệch script tại ${config.executor}. Đang khôi phục...`);
        const fixed = this.writeToExecutor(config.executor, config.script);
        if (fixed) {
          console.log(`[Autoexec] Đã khôi phục script thành công cho ${config.executor}!`);
        } else {
          console.log(`[Autoexec] Khôi phục thất bại cho ${config.executor}!`);
        }
      }
    } catch (e) {
      console.error(`\n[-] Lỗi check autoexec: ${e.message}`);
    }
  }
}

class MultiRejoinTool {
  constructor() {
    this.instances = [];
    this.isRunning = false;
    this.startTime = Date.now();
    this.notice = null;
    this.events = [];
    this.rlExpectedClose = false;
  }

  /** Thông báo 1 dòng hiện ở menu chính ngay sau khi một chức năng hoàn tất. */
  notify(type, text) {
    this.notice = { type, text };
  }

  async start() {
    Utils.ensureRoot();
    Utils.enableWakeLock();
    UIRenderer.applyUiConfig(Utils.loadUiConfig());

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // Trước đây Ctrl+C ở menu chỉ âm thầm đóng readline (không có handler) nên tool treo / không nhả wake lock.
    rl.on("SIGINT", () => gracefulShutdown("SIGINT"));
    rl.on("close", () => {
      if (!this.rlExpectedClose) gracefulShutdown("EOF");
    });

    const actions = {
      "1": () => this.startAutoRejoin(rl),
      "2": () => this.setupPackages(rl),
      "3": () => this.editConfigs(rl),
      "4": () => this.configurePackagePrefix(rl),
      "5": () => this.configureActivity(rl),
      "6": () => this.setupWebhook(rl),
      "7": () => this.setupAutoexec(rl),
      "8": () => this.scanWorlds(rl),
    };

    try {
      await UIRenderer.intro();
      while (!this.isRunning) {
        console.clear();
        console.log(UIRenderer.renderTitle({ big: UIRenderer._tall() }));
        if (this.notice) {
          console.log(UIRenderer.message(this.notice.type, this.notice.text));
          this.notice = null;
        }
        console.log(UIRenderer.renderMainMenu({
          configCount: Object.keys(Utils.loadMultiConfigs()).length,
          prefix: Utils.loadPackagePrefixConfig(),
          webhook: Utils.loadWebhookConfig(),
          autoexec: new AutoexecManager().loadConfig(),
          wakeOff: Utils.wakeLockState === "failed",
        }));

        const choice = (await Utils.ask(rl, UIRenderer.prompt("Chọn chức năng [0-8]"))).trim();
        if (choice === "0" || choice.toLowerCase() === "q") break;
        const action = actions[choice];
        if (!action) {
          console.log(UIRenderer.message("warning", "Lựa chọn không hợp lệ."));
          await sleep(900);
          continue;
        }

        // Quy ước: chức năng trả về false (hoặc ném lỗi) = có lỗi cần người dùng đọc.
        // Thành công thì tự quay lại menu, kết quả hiện thành 1 dòng thông báo ở menu.
        let needAck = false;
        try {
          const result = await action();
          if (result === false) needAck = true;
        } catch (error) {
          console.error(UIRenderer.message("error", `Không thể hoàn tất: ${error.message}`));
          needAck = true;
        }

        if (needAck && !this.isRunning) {
          await Utils.ask(rl, UIRenderer.prompt("Nhấn Enter để quay lại menu"));
        }
      }
    } finally {
      this.rlExpectedClose = true;
      rl.close();
      if (!this.isRunning) Utils.disableWakeLock();
    }
  }

  async setupPackages(rl) {
    UIRenderer.screen("Thiết lập package", "Quét và thêm tài khoản Roblox");
    console.log(UIRenderer.step(1, 4, "Đang quét package Roblox"));
    const packages = Utils.detectAllRobloxPackages();

    if (Object.keys(packages).length === 0) {
      console.log(UIRenderer.infoCard([
        ["Kết quả", "KHÔNG TÌM THẤY", "1;31"],
        ["Gợi ý", "Kiểm tra prefix ở mục 4"]
      ], "QUÉT PACKAGE"));
      return false;
    }

    const packageList = [];
    Object.values(packages).forEach((pkg, index) => {
      packageList.push({ packageName: Object.keys(packages)[index], packageInfo: pkg });
    });
    console.log(UIRenderer.step(2, 4, `Đã tìm thấy ${packageList.length} package`));
    console.log(UIRenderer.options([
      { key: "0", label: "Thiết lập tất cả", description: `${packageList.length} package đã tìm thấy`, color: "1;32" },
      ...packageList.map((pkg, index) => ({
        key: index + 1,
        label: pkg.packageInfo.displayName,
        description: pkg.packageName
      }))
    ], { footer: "Có thể nhập nhiều số, cách nhau bằng dấu cách" }));

    const choice = await Utils.ask(rl, UIRenderer.prompt("Chọn package"));
    let selectedPackages = [];

    if (choice.trim() === "0") {
      selectedPackages = packageList;
      console.log(UIRenderer.selectionCard(
        selectedPackages.map((pkg) => pkg.packageInfo.displayName),
        "PACKAGE SẼ THIẾT LẬP"
      ));
    } else {
      const indices = choice
        .trim()
        .split(/\s+/)
        .map(str => parseInt(str) - 1)
        .filter(i => i >= 0 && i < packageList.length);

      if (indices.length === 0) {
        console.log(UIRenderer.message("error", "Không có package hợp lệ được chọn."));
        return false;
      }

      selectedPackages = [...new Map(indices.map(i => [packageList[i].packageName, packageList[i]])).values()];
      console.log(UIRenderer.selectionCard(
        selectedPackages.map((pkg) => pkg.packageInfo.displayName),
        "PACKAGE SẼ THIẾT LẬP"
      ));
    }


    // Giữ lại cấu hình của các package KHÔNG được chọn lần này (trước đây bị ghi đè mất sạch).
    const configs = Utils.loadMultiConfigs();
    let configuredCount = 0;
    const skippedPackages = [];

    for (const { packageName, packageInfo } of selectedPackages) {
      UIRenderer.screen("Cấu hình tài khoản", packageInfo.displayName);
      console.log(UIRenderer.step(3, 4, "Xác thực và chọn game"));
      console.log(UIRenderer.infoCard([
        ["Tên", packageInfo.displayName, "1;36"],
        ["Package", packageName]
      ], "PACKAGE ĐANG XỬ LÝ"));

      const cookie = Utils.getRobloxCookie(packageName);
      if (!cookie) {
        console.log(UIRenderer.message("error", `Không lấy được cookie cho ${packageName}; đã bỏ qua.`));
        skippedPackages.push(packageInfo.displayName);
        continue;
      }

      const user = new RobloxUser(null, null, cookie);
      const userId = await user.fetchAuthenticatedUser();

      if (!userId) {
        console.log(UIRenderer.message("error", `Không xác thực được tài khoản của ${packageName}; đã bỏ qua.`));
        skippedPackages.push(packageInfo.displayName);
        continue;
      }

      console.log(UIRenderer.infoCard([
        ["Tài khoản", Utils.maskSensitiveInfo(user.username), "1;32"],
        ["User ID", Utils.maskSensitiveInfo(userId)]
      ], "XÁC THỰC THÀNH CÔNG"));

      const selector = new GameSelector();
      let game;
      try {
        game = await selector.chooseGame(rl, cookie);
      } catch (error) {
        // Hủy chọn game ở 1 package không được làm mất công cấu hình các package còn lại.
        const reason = String(error.message || error).replace(/^\[-\]\s*/, "");
        console.log(UIRenderer.message("warning", `${reason} — bỏ qua ${packageInfo.displayName}.`));
        skippedPackages.push(packageInfo.displayName);
        continue;
      }

      let delaySec;
      while (true) {
        const input = parseInt(await Utils.ask(rl, UIRenderer.prompt("Nhịp kiểm tra [15-120 giây]"))) || 1;
        if (input >= 15 && input <= 120) {
          delaySec = input;
          break;
        }
        console.log(UIRenderer.message("error", "Giá trị phải nằm trong khoảng 15-120 giây."));
      }

      configs[packageName] = {
        username: user.username,
        userId,
        placeId: game.placeId,
        gameName: game.name,
        linkCode: game.linkCode,
        delaySec,
        packageName
      };
      configuredCount++;

      console.log(UIRenderer.infoCard([
        ["Package", packageInfo.displayName],
        ["Game", game.name, "1;36"],
        ["Nhịp quét", `${delaySec} giây`],
        ["Kết quả", "ĐÃ CẤU HÌNH", "1;32"]
      ], "HOÀN TẤT TÀI KHOẢN"));
    }

    console.log(UIRenderer.step(4, 4, "Lưu cấu hình"));
    const saved = Utils.saveMultiConfigs(configs);
    console.log(UIRenderer.infoCard([
      ["Đã chọn", String(selectedPackages.length)],
      ["Thành công", String(configuredCount), configuredCount ? "1;32" : "1;31"],
      ["Bỏ qua", String(skippedPackages.length), skippedPackages.length ? "1;33" : "2;37"],
      ["Lưu file", saved ? "THÀNH CÔNG" : "THẤT BẠI", saved ? "1;32" : "1;31"]
    ], "KẾT QUẢ THIẾT LẬP"));
    if (skippedPackages.length) {
      console.log(UIRenderer.selectionCard(skippedPackages, "PACKAGE ĐÃ BỎ QUA"));
    }
    console.log(UIRenderer.message(
      saved && configuredCount > 0 ? "success" : "warning",
      saved && configuredCount > 0
        ? `Đã hoàn tất thiết lập ${configuredCount} package.`
        : "Không có package mới nào được cấu hình hoàn chỉnh."
    ));

    // Có package bị bỏ qua / lưu lỗi -> giữ màn hình để người dùng đọc (chờ Enter).
    if (!saved || configuredCount === 0 || skippedPackages.length > 0) return false;

    this.notify("success", `Đã thiết lập ${configuredCount} package.`);
    return true;
  }

  async editConfigs(rl) {
    const configs = Utils.loadMultiConfigs();

    if (Object.keys(configs).length === 0) {
      console.log(UIRenderer.infoCard([
        ["Trạng thái", "CHƯA CÓ CẤU HÌNH", "1;31"],
        ["Hướng dẫn", "Chạy mục 2: Thiết lập package"]
      ], "KHÔNG THỂ TIẾP TỤC"));
      await new Promise(resolve => setTimeout(resolve, 2000));
      return;
    }

    const configEditor = new ConfigEditor();
    const success = await configEditor.startEdit(rl);

    if (success) {
      console.log(UIRenderer.message("info", "Đang quay lại bảng điều khiển..."));
      await new Promise(resolve => setTimeout(resolve, 2000));
      return;
    } else {
      await new Promise(resolve => setTimeout(resolve, 2000));
      return;
    }
  }

  async setupWebhook(rl) {
    const webhookManager = new WebhookManager();
    await webhookManager.setupWebhook(rl);

    console.log(UIRenderer.message("info", "Đang quay lại bảng điều khiển..."));
    await sleep(900);
    return;
  }

  async setupAutoexec(rl) {
    const autoexecManager = new AutoexecManager();
    await autoexecManager.setup(rl);

    console.log(UIRenderer.message("info", "Đang quay lại bảng điều khiển..."));
    await sleep(900);
    return;
  }

  async configurePackagePrefix(rl) {
    UIRenderer.screen("Prefix package", "Nhận diện ứng dụng Roblox");

    const currentPrefix = Utils.loadPackagePrefixConfig();
    console.log(UIRenderer.infoCard([
      ["Hiện tại", currentPrefix, "1;32"],
      ["Mặc định", "com.roblox"],
      ["Chế độ", "Áp dụng cho quét package"]
    ], "TRẠNG THÁI PREFIX"));

    console.log(UIRenderer.options([
      { key: "1", label: "Thay đổi prefix", description: "Nhập prefix package thủ công" },
      { key: "2", label: "Đặt lại mặc định", description: "Khôi phục về com.roblox" },
      { key: "3", label: "Quay lại", description: "Trở về bảng điều khiển", color: "1;31" }
    ]));

    const choice = await Utils.ask(rl, UIRenderer.prompt("Lựa chọn [1-3]"));

    if (choice.trim() === "1") {
      console.log(UIRenderer.infoCard([
        ["Định dạng", "Tên package không có phần .client"],
        ["Ví dụ", "com.roblox hoặc com.robloxclone"]
      ], "NHẬP PREFIX THỦ CÔNG"));

      let newPrefix;
      while (true) {
        newPrefix = await Utils.ask(rl, UIRenderer.prompt("Prefix mới"));
        if (Utils.isValidPrefix(newPrefix.trim())) {
          break;
        }
        console.log(UIRenderer.message("error", "Prefix không hợp lệ: chỉ gồm chữ, số, dấu _ và dấu chấm (vd: com.roblox)."));
      }

      const saved = Utils.savePackagePrefixConfig(newPrefix.trim());
      console.log(UIRenderer.infoCard([
        ["Prefix cũ", currentPrefix],
        ["Prefix mới", newPrefix.trim(), saved ? "1;32" : "1;31"],
        ["Kết quả", saved ? "ĐÃ CẬP NHẬT" : "THẤT BẠI", saved ? "1;32" : "1;31"]
      ], "PREFIX PACKAGE"));

    } else if (choice.trim() === "2") {
      const saved = Utils.savePackagePrefixConfig("com.roblox");
      console.log(UIRenderer.infoCard([
        ["Prefix cũ", currentPrefix],
        ["Prefix mới", "com.roblox", saved ? "1;32" : "1;31"],
        ["Kết quả", saved ? "ĐÃ KHÔI PHỤC" : "THẤT BẠI", saved ? "1;32" : "1;31"]
      ], "PREFIX MẶC ĐỊNH"));

    } else if (choice.trim() === "3") {
      console.log(UIRenderer.message("info", "Đang quay lại bảng điều khiển..."));
      await new Promise(resolve => setTimeout(resolve, 2000));
      return;
    } else {
      console.log(UIRenderer.message("error", "Lựa chọn không hợp lệ."));
    }

    console.log(UIRenderer.message("info", "Đang quay lại bảng điều khiển..."));
    await sleep(900);
    return;
  }

  /**
   * MỤC 5 — ACTIVITY ROBLOX
   * Không còn chế độ tự dò / cache.
   * Chỉ có 2 chế độ: TÙY CHỈNH (nhập tay) hoặc MẶC ĐỊNH cố định.
   */
  async configureActivity(rl) {
    while (true) {
      const prefix = Utils.loadPackagePrefixConfig();
      const defaultActivity = DEFAULT_ACTIVITY;
      const customActivity = Utils.loadActivityConfig();
      const effective = customActivity || defaultActivity;

      UIRenderer.screen("Activity Roblox", "Thiết lập điểm khởi chạy");

      console.log(UIRenderer.infoCard([
        ["Chế độ", customActivity ? "TÙY CHỈNH" : "MẶC ĐỊNH", customActivity ? "1;33" : "1;32"],
        ["Prefix", prefix],
        ["Tự dò", "ĐÃ TẮT", "2;37"]
      ], "CẤU HÌNH HIỆN TẠI"));

      console.log(UIRenderer.message("info", `Activity đang dùng: ${effective}`));

      console.log(UIRenderer.options([
        { key: "1", label: "Thay đổi activity", description: "Nhập tên class activity thủ công", color: "1;36" },
        { key: "2", label: "Khôi phục mặc định", description: "Dùng com.roblox.client.ActivityProtocolLaunch", color: "1;32" },
        { key: "0", label: "Quay lại", description: "Trở về menu chính", color: "1;31" }
      ], { footer: "Không tự dò • Không dùng cache activity", accent: "1;35" }));

      const choice = (await Utils.ask(rl, UIRenderer.prompt("Lựa chọn [0-2]"))).trim();

      if (choice === "0" || choice.toLowerCase() === "q") {
        console.log(UIRenderer.message("info", "Đang quay lại bảng điều khiển..."));
        await sleep(900);
        return;
      }

      if (choice === "1") {
        console.log(UIRenderer.message("info", `Ví dụ: ${defaultActivity}`));
        let activity = "";
        while (true) {
          activity = (await Utils.ask(rl, UIRenderer.prompt("Activity mới"))).trim();
          if (activity) break;
          console.log(UIRenderer.message("error", "Activity không được để trống."));
        }
        // Chỉ nhận tên class Java đầy đủ (vd: com.roblox.client.ActivityProtocolLaunch)
        if (!/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(activity)) {
          console.log(UIRenderer.message("error", "Tên activity không hợp lệ. Nhập tên class đầy đủ, không có dấu / hoặc khoảng trắng."));
          await sleep(1600);
          continue;
        }
        const saved = Utils.saveActivityConfig(activity);
        console.log(UIRenderer.message(
          saved ? "success" : "error",
          saved ? `Đã lưu activity: ${activity}` : "Không thể lưu activity."
        ));
        await sleep(1400);
        continue;
      }

      if (choice === "2") {
        const saved = Utils.saveActivityConfig(null);
        console.log(UIRenderer.message(
          saved ? "success" : "error",
          saved ? `Đã khôi phục mặc định: ${defaultActivity}` : "Không thể khôi phục mặc định."
        ));
        await sleep(1400);
        continue;
      }

      console.log(UIRenderer.message("warning", "Lựa chọn không hợp lệ."));
      await sleep(900);
    }
  }

  /** MỤC 8 — QUÉT WORLD: liệt kê các map (place) của 1 game để lấy Place ID. */
  async scanWorlds(rl) {
    UIRenderer.screen("Quét world", "Lấy Place ID các map của một game");
    console.log(UIRenderer.infoCard([
      ["Nhập", "Place ID, link game hoặc tên game"],
      ["Kết quả", "Danh sách world kèm Place ID"],
      ["Dùng ID", "Dán ở mục 2 hoặc 3 (Game ID / Link server)"],
      ["Thoát", "Để trống rồi Enter"]
    ], "QUÉT WORLD"));

    let cookie;
    const getCookie = () => {
      if (cookie !== undefined) return cookie;
      cookie = null;
      try {
        const first = Object.keys(Utils.loadMultiConfigs())[0];
        if (first) cookie = Utils.getRobloxCookie(first) || null;
      } catch (_) { }
      return cookie;
    };

    while (true) {
      const input = (await Utils.ask(rl, UIRenderer.prompt("Place ID / link / tên game"))).trim();
      if (!input) return true;
      try {
        await this._scanWorldsFor(rl, input, getCookie);
      } catch (e) {
        console.log(UIRenderer.message("error", `Không quét được: ${e.message}`));
      }
    }
  }

  async _scanWorldsFor(rl, input, getCookie) {
    let universeId;
    let info = null;
    const placeId = WorldScanner.parsePlaceId(input);

    if (placeId) {
      const spin = UIRenderer.spinner("Đang tìm game theo Place ID...");
      try {
        universeId = await WorldScanner.universeOf(placeId);
        info = await WorldScanner.gameInfo(universeId);
      } finally {
        spin.stop();
      }
    } else {
      const spin = UIRenderer.spinner("Đang tìm game theo tên...");
      let found;
      try {
        found = await WorldScanner.search(input);
      } finally {
        spin.stop();
      }
      if (!found.length) throw new Error("Không tìm thấy game nào với từ khóa này");
      const shown = found.slice(0, 8);
      console.log(UIRenderer.options(
        shown.map((g, i) => ({
          key: i + 1,
          label: g.name,
          description: `Place ID ${g.placeId} • ${g.playing ?? "?"} đang chơi`
        })),
        { footer: "Nhập số để quét world, Enter để hủy" }
      ));
      const pick = parseInt(await Utils.ask(rl, UIRenderer.prompt("Chọn game")), 10) - 1;
      if (!(pick >= 0 && pick < shown.length)) {
        console.log(UIRenderer.message("info", "Đã hủy."));
        return;
      }
      universeId = shown[pick].universeId;
      info = { name: shown[pick].name, rootPlaceId: shown[pick].placeId };
    }

    const spin = UIRenderer.spinner("Đang quét danh sách world...");
    let places;
    let warning = null;
    try {
      try {
        places = await WorldScanner.placesOf(universeId, getCookie());
      } catch (e) {
        if (info && info.rootPlaceId) {
          places = [{ id: info.rootPlaceId, name: info.name || "Map chính" }];
          warning = `Không lấy được danh sách đầy đủ (${e.message}); chỉ hiện map chính.`;
        } else {
          throw e;
        }
      }
    } finally {
      spin.stop();
    }
    if (!places.length) throw new Error("Game này không có world nào để hiển thị");

    const root = info && info.rootPlaceId;
    const LIMIT = 40;
    console.log(UIRenderer.infoCard([
      ["Game", (info && info.name) || "Unknown", "1;36"],
      ["Universe", universeId],
      ["Số world", String(places.length), "1;32"]
    ], "KẾT QUẢ QUÉT WORLD"));
    console.log(UIRenderer.options(
      places.slice(0, LIMIT).map((p, i) => ({
        key: i + 1,
        label: p.name,
        description: `Place ID ${p.id}${p.id === root ? " • map chính" : ""}`
      })),
      { footer: places.length > LIMIT ? `Còn ${places.length - LIMIT} world nữa chưa hiển thị` : "Sao chép Place ID để dùng" }
    ));
    if (warning) console.log(UIRenderer.message("warning", warning));
  }

  /**
   * Tùy chọn khi chạy (hỏi ngay sau khi chọn package):
   *  - Auto rejoin mỗi X phút (0 = tắt, rejoin như bình thường)
   *  - Join server ít người (bỏ qua package dùng server VIP)
   */
  async askRunOptions(rl, selectedPackages, configs) {
    const saved = Utils.loadRunOptions();
    console.log(UIRenderer.infoCard([
      ["Auto rejoin", "Vào lại game mỗi X phút (0 = tắt)"],
      ["Sv ít người", "Quét server theo Place ID, vào server vắng nhất"]
    ], "TÙY CHỌN CHẠY"));

    let autoRejoinMin;
    while (true) {
      const raw = (await Utils.ask(rl, UIRenderer.prompt(`Auto rejoin mỗi X phút [0 = tắt, Enter = ${saved.autoRejoinMin}]`))).trim();
      if (raw === "") { autoRejoinMin = saved.autoRejoinMin; break; }
      const n = Number(raw);
      if (Number.isInteger(n) && n >= 0 && n <= 1440) { autoRejoinMin = n; break; }
      console.log(UIRenderer.message("error", "Nhập số phút nguyên từ 0 đến 1440 (0 = tắt)."));
    }

    const allVip = selectedPackages.every((pkg) => configs[pkg] && configs[pkg].linkCode);
    let lowPop = false;
    if (allVip) {
      console.log(UIRenderer.message("info", "Tất cả package đang dùng server VIP nên bỏ qua join server ít người."));
    } else {
      while (true) {
        const raw = (await Utils.ask(rl, UIRenderer.prompt(`Join server ít người? [y/n, Enter = ${saved.lowPop ? "y" : "n"}]`))).trim().toLowerCase();
        if (raw === "") { lowPop = saved.lowPop; break; }
        if (["y", "yes", "c", "co", "có"].includes(raw)) { lowPop = true; break; }
        if (["n", "no", "k", "khong", "không"].includes(raw)) { lowPop = false; break; }
        console.log(UIRenderer.message("error", "Nhập y hoặc n."));
      }
    }

    const options = { autoRejoinMin, lowPop };
    Utils.saveRunOptions(options);
    return options;
  }

  async startAutoRejoin(rl) {
    UIRenderer.screen("Khởi động Auto Rejoin", "Chọn instance cần chạy");
    const configs = Utils.loadMultiConfigs();

    if (Object.keys(configs).length === 0) {
      console.log(UIRenderer.infoCard([
        ["Trạng thái", "CHƯA CÓ CẤU HÌNH", "1;31"],
        ["Hướng dẫn", "Chạy mục 2: Thiết lập package"]
      ], "KHÔNG THỂ TIẾP TỤC"));
      await new Promise(resolve => setTimeout(resolve, 2000));
      return;
    }

    console.log(UIRenderer.message("info", "Kiểm tra toàn vẹn hệ thống..."));
    const isValid = Utils.validatePackageIntegrity(configs);

    if (!isValid) {
      console.log(UIRenderer.message("warning", "Quay lại menu chính sau 5 giây..."));
      await new Promise(resolve => setTimeout(resolve, 5000));
      return;
    }

    console.log(UIRenderer.renderSection("Danh sách cấu hình", `${Object.keys(configs).length} package sẵn sàng`));
    console.log(UIRenderer.displayConfiguredPackages(configs));

    const packageList = Object.keys(configs);
    console.log(UIRenderer.options([
      { key: "0", label: "Chạy tất cả package", description: `${packageList.length} instance đã cấu hình`, color: "1;32" },
      ...packageList.map((packageName, index) => {
        const config = configs[packageName];
        return {
          key: index + 1,
          label: Utils.packageLabel(packageName),
          description: `${Utils.maskSensitiveInfo(config.username)} • ${config.gameName || "Unknown"}`
        };
      })
    ], { footer: "Có thể chọn nhiều số, cách nhau bằng dấu cách" }));

    const choice = await Utils.ask(rl, UIRenderer.prompt("Chọn package cần chạy"));
    let selectedPackages = [];

    if (choice.trim() === "0") {
      selectedPackages = Object.keys(configs);
      console.log(UIRenderer.selectionCard(
        selectedPackages.map((pkg) => Utils.packageLabel(pkg)),
        "PACKAGE SẼ CHẠY"
      ));
    } else {
      const indices = choice
        .trim()
        .split(/\s+/)
        .map(str => parseInt(str) - 1)
        .filter(i => i >= 0 && i < packageList.length);

      if (indices.length === 0) {
        console.log(UIRenderer.message("error", "Lựa chọn không hợp lệ."));
        await new Promise(resolve => setTimeout(resolve, 1000));
        await this.startAutoRejoin(rl);
        return;
      }

      selectedPackages = [...new Set(indices.map(i => packageList[i]))];
      console.log(UIRenderer.selectionCard(selectedPackages.map((pkg) => Utils.packageLabel(pkg)), "PACKAGE SẼ CHẠY"));
    }

    const runOptions = await this.askRunOptions(rl, selectedPackages, configs);

    console.log(UIRenderer.message("info", "Đang khởi tạo hệ thống multi-instance..."));
    await this.initializeSelectedInstances(selectedPackages, configs, rl, runOptions);
  }

  async initializeSelectedInstances(selectedPackages, configs, rl, runOptions = { autoRejoinMin: 0, lowPop: false }) {
    this.runOptions = runOptions;
    const autoRejoinMs = (Number(runOptions.autoRejoinMin) || 0) * 60 * 1000;
    // Cho phép khởi chạy lại trong cùng process mà không nhân đôi instance cũ.
    this.instances = [];
    this.startTime = Date.now();

    for (const packageName of selectedPackages) {
      const config = configs[packageName];
      const cookie = Utils.getRobloxCookie(packageName);

      if (!cookie) {
        console.log(UIRenderer.message("error", `Không lấy được cookie cho ${packageName}, bỏ qua...`));
        continue;
      }

      const user = new RobloxUser(config.username, config.userId, cookie);
      const statusHandler = new StatusHandler();

      this.instances.push({
        packageName,
        user,
        config,
        statusHandler,
        status: "Khởi tạo... ",
        info: "Đang chuẩn bị...",
        countdown: "00s",
        lastCheck: 0,
        presenceType: "Unknown",
        // Chỉ để bảng giám sát hiển thị số lần rejoin
        rejoinCount: 0,
        autoRejoinMs,
        nextAutoRejoinAt: autoRejoinMs ? Date.now() + autoRejoinMs : 0,
        lowPop: Boolean(runOptions.lowPop) && !config.linkCode,
        lastJobId: null
      });
    }

    if (this.instances.length === 0) {
      console.log(UIRenderer.infoCard([
        ["Kết quả", "KHÔNG THỂ KHỞI ĐỘNG", "1;31"],
        ["Nguyên nhân", "Không lấy được cookie của package đã chọn"],
        ["Khắc phục", "Đăng nhập Roblox trên package đó rồi chạy lại"]
      ], "AUTO REJOIN THẤT BẠI"));
      return;
    }

    const webhookConfig = Utils.loadWebhookConfig();
    const autoexecConfig = new AutoexecManager().loadConfig();
    console.log(UIRenderer.infoCard([
      ["Instance", String(this.instances.length), "1;32"],
      ["Trạng thái", "SẴN SÀNG", "1;32"],
      ["Auto rejoin", autoRejoinMs ? `Mỗi ${runOptions.autoRejoinMin} phút` : "TẮT", autoRejoinMs ? "1;32" : "2;37"],
      ["Sv ít người", this.instances.some((i) => i.lowPop) ? "BẬT" : "TẮT", this.instances.some((i) => i.lowPop) ? "1;32" : "2;37"],
      ["Webhook", webhookConfig && webhookConfig.enabled ? "ĐANG BẬT" : "ĐANG TẮT", webhookConfig && webhookConfig.enabled ? "1;32" : "2;37"],
      ["Autoexec", autoexecConfig ? autoexecConfig.executor : "ĐANG TẮT", autoexecConfig ? "1;32" : "2;37"],
      ["Khởi động", "Sau 3 giây"]
    ], "AUTO REJOIN"));
    await new Promise(resolve => setTimeout(resolve, 3000));

    this.isRunning = true;
    await this.runMultiInstanceLoop(rl);
  }

  /** Ghi 1 dòng vào NHẬT KÝ của màn giám sát. */
  logEvent(level, text) {
    const clean = UIRenderer.stripAnsi(String(text)).replace(/\s+/g, " ").trim();
    if (!clean) return;
    this.events.push({ at: Date.now(), level, text: clean });
    if (this.events.length > 60) this.events.splice(0, this.events.length - 60);
  }

  /** Bắt mọi console.log/error chen ngang vào nhật ký thay vì in thẳng ra làm vỡ khung hình. */
  _captureLogs() {
    return captureConsole((method, text) => {
      let level = method === "error" ? "error" : method === "warn" ? "warning" : "info";
      if (/^\s*\[\+\]/.test(text)) level = "success";
      else if (/^\s*\[-\]/.test(text)) level = "error";
      this.logEvent(level, text.replace(/^\s*\[[+\-*!]\]\s*/, ""));
    });
  }

  /**
   * Phím tắt khi giám sát: Q / Ctrl+C = dừng an toàn, R = kiểm tra ngay.
   * Đóng readline để các phím gõ vào không bị in lên làm vỡ khung hình.
   */
  _bindLiveKeys(rl) {
    if (!process.stdin.isTTY) return () => { };
    this.rlExpectedClose = true;
    try { rl.close(); } catch (_) { }

    const onData = (buf) => {
      const s = String(buf);
      if (s.includes("\x03")) return gracefulShutdown("SIGINT");
      if (/q/i.test(s)) return gracefulShutdown("Q");
      if (/r/i.test(s)) {
        this.instances.forEach((i) => { i.lastCheck = 0; });
        this.logEvent("info", "Kiểm tra ngay theo yêu cầu (phím R)");
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

  /** Kiểm tra 1 instance; nếu cookie hết hạn thì thử đọc lại cookie mới (tối đa 1 lần / 3 phút). */
  async _checkInstance(instance) {
    let check = await instance.user.checkPresence();
    if (check.error && check.status === 401) {
      const now = Date.now();
      if (now - (instance.cookieRefreshAt || 0) >= COOKIE_REFRESH_MS) {
        instance.cookieRefreshAt = now;
        const fresh = Utils.getRobloxCookie(instance.packageName);
        if (fresh && fresh !== instance.user.cookie) {
          instance.user.cookie = fresh;
          instance.user.csrf = null;
          check = await instance.user.checkPresence();
        }
      }
    }
    return check;
  }

  /**
   * Mở game cho 1 instance. Nếu bật "sv ít người" thì quét server trước rồi vào đúng server đó
   * (quét lỗi thì vẫn vào server thường). forced = auto rejoin định kỳ: dừng hẳn app trước khi mở lại.
   */
  async _launchInstance(instance, { forced = false } = {}) {
    const { config, statusHandler } = instance;
    const label = Utils.packageLabel(instance.packageName);
    let jobId = null;
    let note = config.linkCode ? " (server VIP)" : "";

    if (instance.lowPop && !config.linkCode) {
      const found = await ServerFinder.findLowest(config.placeId, { exclude: instance.lastJobId });
      if (found.ok) {
        jobId = found.jobId;
        instance.lastJobId = jobId;
        note = ` (sv ít người ${found.playing}/${found.maxPlayers}, quét ${found.scanned})`;
      } else {
        this.logEvent("warning", `${label}: không tìm được server ít người (${found.error}) — vào server thường`);
      }
    }

    if (forced) {
      await Utils.forceStop(instance.packageName);
      await sleep(2000);
    }

    const result = await GameLauncher.handleGameLaunch(
      true, config.placeId, config.linkCode, config.packageName, true, jobId
    );
    if (result.ok) {
      statusHandler.updateJoinStatus(true);
      instance.rejoinCount = (instance.rejoinCount || 0) + 1;
      if (instance.autoRejoinMs) instance.nextAutoRejoinAt = Date.now() + instance.autoRejoinMs;
      if (forced) {
        instance.status = "Auto rejoin";
        instance.info = `Rejoin định kỳ mỗi ${this.runOptions.autoRejoinMin} phút`;
      }
      this.logEvent("success", `${label}: ${forced ? "auto rejoin" : "đã gửi lệnh mở game"}${note} — lần ${instance.rejoinCount}`);
    } else {
      instance.status = "Lỗi mở game";
      instance.info = result.error || "am start thất bại";
      // Auto rejoin lỗi: thử lại sau 1 phút thay vì chờ trọn chu kỳ.
      if (instance.autoRejoinMs) instance.nextAutoRejoinAt = Date.now() + 60 * 1000;
      this.logEvent("error", `${label}: mở game thất bại — ${instance.info}`);
    }
    return result;
  }

  /** Một nhịp giám sát: auto rejoin đến hạn, kiểm tra song song các instance đến hạn, rồi mở lại game tuần tự (giãn cách). */
  async _tick() {
    let launched = 0;

    // Auto rejoin định kỳ (autoRejoinMs = 0 là tắt -> rejoin như bình thường).
    for (const instance of this.instances) {
      if (instance.autoRejoinMs > 0 && !instance.checking && Date.now() >= instance.nextAutoRejoinAt) {
        if (launched++ > 0) await sleep(LAUNCH_STAGGER_MS);
        await this._launchInstance(instance, { forced: true });
        instance.lastCheck = Date.now();
      }
    }

    const now = Date.now();
    const due = [];
    for (const instance of this.instances) {
      const delayMs = Math.max(15, Number(instance.config.delaySec) || 30) * 1000;
      const since = now - instance.lastCheck;
      instance.countdownSeconds = Math.ceil(Math.max(0, delayMs - since) / 1000);
      if (since >= delayMs && !instance.checking) due.push(instance);
    }
    if (!due.length) return;

    // Trước đây kiểm tra lần lượt và không có timeout: 1 request treo là cả tool đứng hình.
    const results = await Promise.all(due.map(async (instance) => {
      instance.checking = true;
      try {
        return { instance, check: await this._checkInstance(instance) };
      } catch (e) {
        return { instance, check: { presence: null, error: e.message } };
      } finally {
        instance.checking = false;
      }
    }));

    for (const { instance, check } of results) {
      const { config, statusHandler } = instance;
      const label = Utils.packageLabel(instance.packageName);
      let targetUniverseId = instance.targetUniverseId || null;
      const pr = check && check.presence;
      if (!targetUniverseId && pr && pr.userPresenceType === 2 && config.placeId) {
        try {
          targetUniverseId = await WorldScanner.universeOfCached(config.placeId);
          instance.targetUniverseId = targetUniverseId;
        } catch (_) { /* không tra được universe -> so theo placeId như cũ */ }
      }
      const analysis = statusHandler.evaluate(check, config.placeId, Date.now(), targetUniverseId);
      const previous = String(instance.status || "").trim();

      instance.lastCheck = Date.now();
      instance.status = analysis.status;
      instance.info = analysis.info;
      instance.presenceType = check && check.presence && check.presence.userPresenceType !== undefined
        ? String(check.presence.userPresenceType)
        : "Unknown";

      if (previous !== analysis.status) {
        const tone = UIRenderer._statusTone(analysis.status);
        const level = tone === "good" ? "success" : tone === "bad" ? "error" : tone === "warn" ? "warning" : "info";
        const arrow = previous && !previous.includes("Khởi tạo") ? `${previous} → ` : "";
        this.logEvent(level, `${label}: ${arrow}${analysis.status}`);
      }

      if (analysis.shouldLaunch) {
        if (launched++ > 0) await sleep(LAUNCH_STAGGER_MS);
        await this._launchInstance(instance);
      }
    }
  }

  _buildLiveFrame({ frame, webhookConfig, webhookOn, nextWebhookAt }) {
    const rows = process.stdout.rows || 0;
    const parts = [
      UIRenderer.renderLiveHeader(frame),
      UIRenderer.renderMultiInstanceTable(this.instances, this.startTime, frame)
    ];

    const width = UIRenderer._width(118);
    if (webhookConfig && webhookConfig.url) {
      const left = Math.max(0, Math.ceil((nextWebhookAt - Date.now()) / 1000));
      const text = webhookOn
        ? `Webhook ${Utils.webhookId(webhookConfig.url)} • gửi tiếp sau ${UIRenderer.formatCountdown(left)}`
        : "Webhook đang tắt";
      parts.push(
        UIRenderer.color(webhookOn ? "good" : "muted", "●") + " " +
        UIRenderer.color("dim", UIRenderer.fit(text, Math.max(1, width - 2)).trimEnd())
      );
    }

    const auto = this.instances.filter((i) => i.autoRejoinMs > 0);
    if (auto.length || this.instances.some((i) => i.lowPop)) {
      const segs = [];
      if (auto.length) {
        const nextAt = Math.min(...auto.map((i) => i.nextAutoRejoinAt));
        const left = Math.max(0, Math.ceil((nextAt - Date.now()) / 1000));
        segs.push(`Auto rejoin ${this.runOptions.autoRejoinMin}p • kế tiếp ${UIRenderer.formatCountdown(left)}`);
      }
      if (this.instances.some((i) => i.lowPop)) segs.push("Sv ít người bật");
      parts.push(
        UIRenderer.color("good", "●") + " " +
        UIRenderer.color("dim", UIRenderer.fit(segs.join(" • "), Math.max(1, width - 2)).trimEnd())
      );
    }

    const used = parts.join("\n").split("\n").length;
    const room = rows ? clamp(rows - used - 4, 0, 8) : 4;
    if (room >= 3 && this.events.length) {
      parts.push(UIRenderer.renderEventLog(this.events, room - 2));
    }

    const keys = process.stdin.isTTY
      ? `${UIRenderer.color("text", "Q")} dừng   ${UIRenderer.color("text", "R")} kiểm tra ngay`
      : `${UIRenderer.color("text", "CTRL+C")} dừng`;
    parts.push(UIRenderer.color("dim", "  ") + keys);
    return parts.join("\n");
  }

  async runMultiInstanceLoop(rl) {
    const webhookManager = new WebhookManager();
    const webhookConfig = Utils.loadWebhookConfig();
    const webhookOn = Boolean(webhookConfig && webhookConfig.enabled && Utils.parseDiscordWebhook(webhookConfig.url));
    const intervalMin = Number(webhookConfig && webhookConfig.intervalMinutes);
    const webhookPeriod = (intervalMin >= 1 ? intervalMin : 30) * 60 * 1000;
    let nextWebhookAt = Date.now() + webhookPeriod;
    let webhookBusy = false;

    const autoexecManager = new AutoexecManager();
    const autoexecConfig = autoexecManager.loadConfig();
    let nextAutoexecCheck = Date.now() + 15 * 60 * 1000;

    this.events = [];
    const restoreConsole = this._captureLogs();
    const unbindKeys = this._bindLiveKeys(rl);
    let renderCounter = 0;

    try {
      this.logEvent("info", `Bắt đầu giám sát ${this.instances.length} instance`);

      while (this.isRunning) {
        const tickStart = Date.now();

        try {
          if (autoexecConfig && tickStart >= nextAutoexecCheck) {
            autoexecManager.checkAndFix(autoexecConfig);
            nextAutoexecCheck = tickStart + 15 * 60 * 1000;
          }

          await this._tick();

          // Lên lịch theo thời gian thật (trước đây đếm số vòng lặp nên bị lệch khi mỗi vòng chạy lâu hơn 1 giây),
          // và gửi nền để không chặn việc giám sát trong lúc chụp ảnh / tải lên.
          if (webhookOn && !webhookBusy && Date.now() >= nextWebhookAt) {
            nextWebhookAt = Date.now() + webhookPeriod;
            webhookBusy = true;
            this.logEvent("info", "Đang gửi báo cáo webhook...");
            webhookManager.sendStatusWebhook(this.instances, this.startTime)
              .catch((e) => this.logEvent("error", `Webhook: ${e.message}`))
              .finally(() => { webhookBusy = false; });
          }
        } catch (e) {
          this.logEvent("error", `Lỗi vòng giám sát: ${e.message}`);
        }

        // Ngoài terminal thật (ghi ra file / pipe) chỉ in 1 khung mỗi 30 giây cho đỡ spam.
        if (process.stdout.isTTY || renderCounter % 30 === 0) {
          let frame;
          try {
            frame = this._buildLiveFrame({ frame: renderCounter, webhookConfig, webhookOn, nextWebhookAt });
          } catch (e) {
            frame = "\n  R E J O I N\n  " + e.message;
          }
          UIRenderer.paint(frame, { hideCursor: true, fit: true });
        }

        renderCounter++;
        await sleep(Math.max(100, 1000 - (Date.now() - tickStart)));
      }
    } finally {
      restoreConsole();
      unbindKeys();
    }
  }
}

class WebhookManager {
  constructor() {
    this.webhookConfig = Utils.loadWebhookConfig();
  }

  async setupWebhook(rl) {
    UIRenderer.screen("Webhook Discord", "Báo cáo trạng thái tự động");

    if (this.webhookConfig) {
      const urlParts = this.webhookConfig.url.split('/');
      const webhookId = urlParts[urlParts.length - 2] || 'unknown';
      console.log(UIRenderer.infoCard([
        ["Webhook ID", webhookId],
        ["URL", "ĐÃ ẨN VÌ LÝ DO BẢO MẬT"],
        ["Chu kỳ", `${this.webhookConfig.intervalMinutes} phút`],
        ["Trạng thái", this.webhookConfig.enabled ? "ĐANG BẬT" : "ĐANG TẮT", this.webhookConfig.enabled ? "1;32" : "1;31"]
      ], "CẤU HÌNH HIỆN TẠI"));
      console.log(UIRenderer.options([
        { key: "1", label: "Chỉnh sửa webhook", description: "Cập nhật URL hoặc chu kỳ gửi" },
        { key: "2", label: "Bật / Tắt webhook", description: "Thay đổi trạng thái gửi báo cáo", color: "1;33" },
        { key: "3", label: "Xóa webhook", description: "Xóa cấu hình đã lưu", color: "1;31" },
        { key: "4", label: "Quay lại", description: "Trở về bảng điều khiển", color: "1;31" }
      ], { accent: "1;35" }));

      const choice = await Utils.ask(rl, UIRenderer.prompt("Lựa chọn [1-4]"));
      if (choice.trim() === "1") await this.editWebhook(rl);
      else if (choice.trim() === "2") await this.toggleWebhook(rl);
      else if (choice.trim() === "3") await this.deleteWebhook(rl);
      return;
    }

    console.log(UIRenderer.message("warning", "Chưa có cấu hình webhook."));
    console.log(UIRenderer.options([
      { key: "1", label: "Tạo webhook mới", description: "Thiết lập URL và chu kỳ gửi", color: "1;32" },
      { key: "2", label: "Quay lại", description: "Trở về bảng điều khiển", color: "1;31" }
    ], { accent: "1;35" }));
    const choice = await Utils.ask(rl, UIRenderer.prompt("Lựa chọn [1-2]"));
    if (choice.trim() === "1") await this.createWebhook(rl);
  }

  async createWebhook(rl) {
    console.log(UIRenderer.renderSection("Tạo webhook", "2 bước thiết lập"));
    console.log(UIRenderer.step(1, 2, "Nhập địa chỉ webhook Discord"));

    let webhookUrl;
    while (true) {
      webhookUrl = await Utils.ask(rl, UIRenderer.prompt("URL webhook Discord"));
      const safeUrl = Utils.parseDiscordWebhook(webhookUrl);
      if (safeUrl) {
        webhookUrl = safeUrl;
        break;
      }
      console.log(UIRenderer.message("error", "URL webhook không hợp lệ. Dạng đúng: https://discord.com/api/webhooks/ID/TOKEN"));
    }

    console.log(UIRenderer.step(2, 2, "Thiết lập chu kỳ báo cáo"));
    let intervalMinutes;
    while (true) {
      const input = await Utils.ask(rl, UIRenderer.prompt("Chu kỳ gửi [5-180 phút]"));
      intervalMinutes = parseInt(input);
      if (intervalMinutes >= 5 && intervalMinutes <= 180) {
        break;
      }
      console.log(UIRenderer.message("error", "Thời gian phải từ 5 đến 180 phút."));
    }

    this.webhookConfig = {
      url: webhookUrl.trim(),
      intervalMinutes: intervalMinutes,
      enabled: true
    };

    const saved = Utils.saveWebhookConfig(this.webhookConfig);
    console.log(UIRenderer.infoCard([
      ["Webhook ID", webhookUrl.trim().split('/').slice(-2, -1)[0] || "unknown"],
      ["Chu kỳ", `${intervalMinutes} phút`],
      ["Trạng thái", saved ? "ĐANG BẬT" : "CHƯA LƯU", saved ? "1;32" : "1;31"],
      ["Kết quả", saved ? "ĐÃ TẠO" : "THẤT BẠI", saved ? "1;32" : "1;31"]
    ], saved ? "WEBHOOK HOÀN TẤT" : "WEBHOOK GẶP LỖI"));
    console.log(UIRenderer.message(
      saved ? "success" : "error",
      saved ? "Webhook đã được tạo và bật." : "Không thể lưu webhook; cấu hình chưa được áp dụng."
    ));
    await sleep(saved ? 1500 : 2500);
  }

  async editWebhook(rl) {
    console.log(UIRenderer.renderSection("Chỉnh sửa webhook", "Giữ trống để dùng giá trị cũ"));

    let webhookUrl;
    while (true) {
      const urlParts = this.webhookConfig.url.split('/');
      const webhookId = urlParts[urlParts.length - 2] || 'unknown';
      console.log(UIRenderer.infoCard([
        ["Webhook ID", webhookId],
        ["URL", "ĐÃ ẨN VÌ LÝ DO BẢO MẬT"]
      ], "ĐỊA CHỈ HIỆN TẠI"));
      webhookUrl = await Utils.ask(rl, UIRenderer.prompt("URL mới [Enter = giữ nguyên]"));
      if (!webhookUrl.trim()) {
        webhookUrl = this.webhookConfig.url;
        break;
      }
      const safeUrl = Utils.parseDiscordWebhook(webhookUrl);
      if (safeUrl) {
        webhookUrl = safeUrl;
        break;
      }
      console.log(UIRenderer.message("error", "URL webhook không hợp lệ. Dạng đúng: https://discord.com/api/webhooks/ID/TOKEN"));
    }

    let intervalMinutes;
    while (true) {
      console.log(UIRenderer.message("info", `Chu kỳ hiện tại: ${this.webhookConfig.intervalMinutes} phút.`));
      const input = await Utils.ask(rl, UIRenderer.prompt("Chu kỳ mới [5-180, Enter = giữ nguyên]"));
      if (!input.trim()) {
        intervalMinutes = this.webhookConfig.intervalMinutes;
        break;
      }
      intervalMinutes = parseInt(input);
      if (intervalMinutes >= 5 && intervalMinutes <= 180) {
        break;
      }
      console.log(UIRenderer.message("error", "Thời gian phải từ 5 đến 180 phút."));
    }

    this.webhookConfig = {
      url: webhookUrl.trim(),
      intervalMinutes: intervalMinutes,
      enabled: this.webhookConfig.enabled
    };

    const saved = Utils.saveWebhookConfig(this.webhookConfig);
    console.log(UIRenderer.infoCard([
      ["Webhook ID", webhookUrl.trim().split('/').slice(-2, -1)[0] || "unknown"],
      ["Chu kỳ", `${intervalMinutes} phút`],
      ["Trạng thái", this.webhookConfig.enabled ? "ĐANG BẬT" : "ĐANG TẮT", this.webhookConfig.enabled ? "1;32" : "1;31"],
      ["Kết quả", saved ? "ĐÃ CẬP NHẬT" : "THẤT BẠI", saved ? "1;32" : "1;31"]
    ], saved ? "WEBHOOK ĐÃ CẬP NHẬT" : "WEBHOOK GẶP LỖI"));
    await sleep(saved ? 1500 : 2500);
  }

  async toggleWebhook(rl) {
    console.log(UIRenderer.renderSection("Trạng thái webhook", "Bật hoặc tắt báo cáo"));
    const urlParts = this.webhookConfig.url.split('/');
    const webhookId = urlParts[urlParts.length - 2] || 'unknown';
    console.log(UIRenderer.infoCard([
      ["Webhook ID", webhookId],
      ["Chu kỳ", `${this.webhookConfig.intervalMinutes} phút`],
      ["Trạng thái", this.webhookConfig.enabled ? "ĐANG BẬT" : "ĐANG TẮT", this.webhookConfig.enabled ? "1;32" : "1;31"]
    ], "XÁC NHẬN THAY ĐỔI"));

    const newStatus = !this.webhookConfig.enabled;
    const statusText = newStatus ? 'bật' : 'tắt';

    const confirm = await Utils.ask(rl, UIRenderer.prompt(`Xác nhận ${statusText} webhook? [y/N]`));

    if (confirm.toLowerCase() === 'y' || confirm.toLowerCase() === 'yes') {
      this.webhookConfig.enabled = newStatus;
      const saved = Utils.saveWebhookConfig(this.webhookConfig);
      if (!saved) this.webhookConfig.enabled = !newStatus;
      console.log(UIRenderer.infoCard([
        ["Webhook ID", webhookId],
        ["Trạng thái", saved ? (newStatus ? "ĐANG BẬT" : "ĐANG TẮT") : "KHÔNG ĐỔI", saved ? (newStatus ? "1;32" : "1;31") : "1;33"],
        ["Báo cáo", saved && newStatus ? "SẼ TỰ ĐỘNG GỬI" : "KHÔNG TỰ ĐỘNG GỬI"],
        ["Kết quả", saved ? "ĐÃ CẬP NHẬT" : "THẤT BẠI", saved ? "1;32" : "1;31"]
      ], "TRẠNG THÁI WEBHOOK"));
      await sleep(saved ? 1500 : 2500);
    } else {
      console.log(UIRenderer.message("warning", "Đã hủy thay đổi trạng thái webhook."));
      await sleep(1200);
    }
  }

  async deleteWebhook(rl) {
    console.log(UIRenderer.renderSection("Xóa webhook", "Thao tác cần xác nhận"));
    const urlParts = this.webhookConfig.url.split('/');
    const webhookId = urlParts[urlParts.length - 2] || 'unknown';
    console.log(UIRenderer.infoCard([
      ["Webhook ID", webhookId],
      ["Chu kỳ", `${this.webhookConfig.intervalMinutes} phút`],
      ["Cảnh báo", "Cấu hình này sẽ bị xóa", "1;31"]
    ], "WEBHOOK SẼ XÓA"));

    const confirm = await Utils.ask(rl, UIRenderer.prompt("Chắc chắn xóa webhook? [y/N]"));

    if (confirm.toLowerCase() === 'y' || confirm.toLowerCase() === 'yes') {
      const saved = Utils.removeWebhookConfig();
      if (saved) this.webhookConfig = null;
      console.log(UIRenderer.infoCard([
        ["Webhook ID", webhookId],
        ["Trạng thái", saved ? "ĐÃ XÓA" : "VẪN ĐƯỢC GIỮ", saved ? "1;32" : "1;31"],
        ["Báo cáo", saved ? "ĐÃ TẮT" : "KHÔNG THAY ĐỔI"]
      ], saved ? "XÓA WEBHOOK HOÀN TẤT" : "XÓA WEBHOOK THẤT BẠI"));
      await sleep(saved ? 1500 : 2500);
    } else {
      console.log(UIRenderer.message("warning", "Đã hủy xóa webhook."));
      await sleep(1200);
    }
  }

  async sendStatusWebhook(instances, startTime) {
    if (!this.webhookConfig || !this.webhookConfig.enabled) return false;

    try {
      const stats = UIRenderer.getSystemStats();
      const uptimeMs = Date.now() - startTime;
      const hours = Math.floor(uptimeMs / (1000 * 60 * 60));
      const minutes = Math.floor((uptimeMs % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((uptimeMs % (1000 * 60)) / 1000);

      // Trước đây dùng status.includes("Online") nên "Online nhưng không trong game" cũng bị tính là đang chạy.
      const total = instances.length;
      const active = instances.filter((i) => isInGameStatus(i.status)).length;
      const errors = instances.filter((i) => ERROR_STATUSES.has(String(i.status || "").trim())).length;
      const rejoins = instances.reduce((s, i) => s + (Number(i.rejoinCount) || 0), 0);

      const iconOf = (status) => {
        const tone = UIRenderer._statusTone(status);
        return tone === "good" ? "🟢" : tone === "bad" ? "🔴" : tone === "warn" ? "🟠" : tone === "accent" ? "🟡" : "⚪";
      };
      const packageList = instances.map((i) =>
        `${iconOf(i.status)} **${Utils.packageLabel(i.packageName)}** — ${String(i.status || "Không rõ").trim()} (↻${i.rejoinCount || 0})`
      ).join("\n") || "Chưa có instance";

      const color = total > 0 && active === total ? 0x2ecc71 : active === 0 ? 0xe74c3c : 0xf1c40f;

      const embed = {
        title: "🎮 REJOIN TOOL • Báo cáo trạng thái",
        description: total
          ? `**${active}/${total}** instance đang ở trong game` + (errors ? ` • ⚠️ ${errors} lỗi` : "")
          : "Chưa có instance nào đang chạy",
        color,
        timestamp: new Date().toISOString(),
        fields: [
          { name: "🖥️ CPU", value: `${stats.cpuUsage}%`, inline: true },
          { name: "💾 RAM", value: stats.ramUsage, inline: true },
          { name: "⏱️ Uptime", value: `${hours}h ${minutes}m ${seconds}s`, inline: true },
          { name: "🔁 Tổng rejoin", value: String(rejoins), inline: true },
          {
            name: "📦 Instances",
            value: packageList.length > 1024 ? packageList.substring(0, 1021) + "..." : packageList,
            inline: false
          }
        ],
        footer: { text: "REJOIN TOOL • báo cáo tự động" }
      };

      const screenshotPath = await Utils.takeScreenshot();
      // sendWebhookEmbed tự dọn file ảnh tạm kể cả khi gửi lỗi.
      return await Utils.sendWebhookEmbed(this.webhookConfig.url, embed, screenshotPath);
    } catch (e) {
      console.error(`[-] Lỗi khi gửi webhook: ${e.message}`);
      return false;
    }
  }
}

class ConfigEditor {
  constructor() {
    this.configs = Utils.loadMultiConfigs();
  }

  async startEdit(rl) {
    try {
      if (Object.keys(this.configs).length === 0) {
        console.log(UIRenderer.infoCard([
          ["Trạng thái", "CHƯA CÓ CẤU HÌNH", "1;31"],
          ["Hướng dẫn", "Chạy mục 2: Thiết lập package"]
        ], "KHÔNG THỂ CHỈNH SỬA"));
        await new Promise(resolve => setTimeout(resolve, 2000));
        return false;
      }

      UIRenderer.screen("Chỉnh sửa cấu hình", "Chọn tài khoản cần cập nhật");
      console.log(UIRenderer.renderSection("Danh sách hiện tại", `${Object.keys(this.configs).length} cấu hình`));
      console.log(this.renderConfigTable());

      const configList = Object.entries(this.configs).map(([packageName, config]) => ({ packageName, config }));
      if (configList.length === 0) {
        console.log(UIRenderer.message("error", "Không có cấu hình hợp lệ nào."));
        await new Promise(resolve => setTimeout(resolve, 2000));
        return false;
      }

      console.log(UIRenderer.options([
        { key: "0", label: "Sửa tất cả cấu hình", description: `${configList.length} tài khoản`, color: "1;32" },
        ...configList.map(({ packageName, config }, index) => ({
          key: index + 1,
          label: Utils.packageLabel(packageName),
          description: `${Utils.maskSensitiveInfo(config.username)} • ${config.gameName || "Unknown"}`
        }))
      ], { footer: "Có thể chọn nhiều số, cách nhau bằng dấu cách" }));

      const choice = await Utils.ask(rl, UIRenderer.prompt("Chọn cấu hình"));
      let selectedConfigs = [];

      if (choice.trim() === "0") {
        selectedConfigs = configList;
        console.log(UIRenderer.selectionCard(selectedConfigs.map((cfg) =>
          `${Utils.packageLabel(cfg.packageName)} • ${Utils.maskSensitiveInfo(cfg.config.username)}`
        ), "CẤU HÌNH SẼ SỬA"));
      } else {
        try {
          const indices = choice
            .trim()
            .split(/\s+/)
            .map(str => parseInt(str) - 1)
            .filter(i => i >= 0 && i < configList.length);

          if (indices.length === 0) {
            console.log(UIRenderer.message("error", "Lựa chọn không hợp lệ."));
            await sleep(900);
            return false;
          }

          selectedConfigs = [...new Map(indices.map(i => [configList[i].packageName, configList[i]])).values()];
          console.log(UIRenderer.selectionCard(selectedConfigs.map((cfg) =>
            `${Utils.packageLabel(cfg.packageName)} • ${Utils.maskSensitiveInfo(cfg.config.username)}`
          ), "CẤU HÌNH SẼ SỬA"));
        } catch (error) {
          console.log(`[-] Lỗi khi xử lý lựa chọn: ${error.message}`);
          await sleep(900);
          return false;
        }
      }


      for (const { packageName, config } of selectedConfigs) {
        try {
          const packageDisplay = Utils.packageLabel(packageName);
          UIRenderer.screen("Chỉnh sửa cấu hình", packageDisplay);
          console.log(UIRenderer.infoCard([
            ["Package", packageDisplay, "1;36"],
            ["Tài khoản", Utils.maskSensitiveInfo(config.username)],
            ["User ID", Utils.maskSensitiveInfo(config.userId)],
            ["Game", `${config.gameName || "Unknown"} (${config.placeId || "Unknown"})`],
            ["Nhịp quét", `${config.delaySec || "Unknown"} giây`],
            ["Server VIP", config.linkCode ? "ĐÃ CẤU HÌNH" : "KHÔNG", config.linkCode ? "1;32" : "2;37"]
          ], "CHI TIẾT CẤU HÌNH"));
          console.log(UIRenderer.options([
            { key: "1", label: "Thay đổi game", description: "Chọn game hoặc Place ID mới" },
            { key: "2", label: "Thay đổi nhịp quét", description: "Khoảng 15-120 giây" },
            { key: "3", label: "Thay đổi server VIP", description: "Cập nhật link private server", color: "1;35" },
            { key: "4", label: "Xóa cấu hình", description: "Loại tài khoản này khỏi danh sách", color: "1;31" },
            { key: "5", label: "Giữ nguyên", description: "Bỏ qua cấu hình này", color: "1;33" }
          ]));

          const editChoice = await Utils.ask(rl, UIRenderer.prompt("Lựa chọn [1-5]"));

          try {
            switch (editChoice.trim()) {
              case "1": {
                const selector = new GameSelector();
                const game = await selector.chooseGame(rl, Utils.getRobloxCookie(packageName));
                config.placeId = game.placeId;
                config.gameName = game.name;
                config.linkCode = game.linkCode;
                console.log(UIRenderer.infoCard([
                  ["Game", game.name, "1;32"],
                  ["Place ID", game.placeId],
                  ["Server VIP", game.linkCode ? "ĐÃ CẤU HÌNH" : "KHÔNG"],
                  ["Kết quả", "ĐÃ CẬP NHẬT", "1;32"]
                ], "CẬP NHẬT GAME"));
                break;
              }

              case "2": {
                let newDelay;
                while (true) {
                  try {
                    const input = await Utils.ask(rl, UIRenderer.prompt("Nhịp quét mới [15-120 giây]"));
                    const delayValue = parseInt(input) || 0;
                    if (delayValue >= 15 && delayValue <= 120) {
                      newDelay = delayValue;
                      break;
                    }
                    console.log(UIRenderer.message("error", "Giá trị phải nằm trong khoảng 15-120 giây."));
                  } catch (error) {
                    console.log(UIRenderer.message("error", "Không đọc được nhịp quét; vui lòng thử lại."));
                  }
                }
                config.delaySec = newDelay;
                console.log(UIRenderer.infoCard([
                  ["Package", packageDisplay],
                  ["Nhịp quét", `${newDelay} giây`, "1;32"],
                  ["Kết quả", "ĐÃ CẬP NHẬT", "1;32"]
                ], "CẬP NHẬT NHỊP QUÉT"));
                break;
              }

              case "3":
                console.log(UIRenderer.infoCard([
                  ["Đã chuyển", "roblox.com/games/ID/Tên?privateServerLinkCode=..."],
                  ["Chưa chuyển", "roblox.com/share?code=...&type=Server"],
                  ["Bỏ qua", "Để trống rồi Enter"]
                ], "PRIVATE SERVER"));
                while (true) {
                  try {
                    const link = (await Utils.ask(rl, UIRenderer.prompt("Dán link server"))).trim();
                    if (!link) {
                      console.log(UIRenderer.message("info", "Giữ nguyên server VIP hiện tại."));
                      break;
                    }
                    const parsed = GameSelector.parseTarget(link);
                    const spin = parsed && parsed.kind === "share"
                      ? UIRenderer.spinner("Đang đổi link chưa chuyển hướng sang link server...")
                      : null;
                    let game;
                    try {
                      game = await GameSelector.resolveTarget(link, () => Utils.getRobloxCookie(packageName));
                    } finally {
                      if (spin) spin.stop();
                    }
                    if (!game.linkCode) {
                      console.log(UIRenderer.message("error", "Đây là Place ID / link game thường, không có mã server VIP."));
                      continue;
                    }
                    config.placeId = game.placeId;
                    config.gameName = "Private Server";
                    config.linkCode = game.linkCode;
                    console.log(UIRenderer.infoCard([
                      ["Place ID", game.placeId, "1;36"],
                      ["Link code", "ĐÃ CẬP NHẬT"],
                      ["Kết quả", "ĐÃ CẬP NHẬT", "1;32"]
                    ], "PRIVATE SERVER"));
                    break;
                  } catch (error) {
                    console.log(UIRenderer.message("error", error.message));
                  }
                }
                break;

              case "4": {
                console.log(UIRenderer.message("warning", `Bạn sắp xóa cấu hình của ${packageDisplay}.`));
                const confirmDelete = (await Utils.ask(rl, UIRenderer.prompt("Xác nhận xóa? [y/N]"))).trim().toLowerCase();
                if (confirmDelete === "y" || confirmDelete === "yes") {
                  delete this.configs[packageName];
                  console.log(UIRenderer.infoCard([
                    ["Package", packageDisplay],
                    ["Kết quả", "ĐÃ XÓA CẤU HÌNH", "1;32"]
                  ], "XÓA CẤU HÌNH"));
                } else {
                  console.log(UIRenderer.message("warning", "Đã hủy xóa cấu hình."));
                }
                break;
              }

              case "5":
                console.log(UIRenderer.message("info", `Giữ nguyên cấu hình cho ${packageDisplay}.`));
                break;

              default:
                console.log(UIRenderer.message("error", "Lựa chọn không hợp lệ."));
                break;
            }
          } catch (error) {
            console.log(UIRenderer.message("error", `Không thể chỉnh sửa cấu hình: ${error.message}`));
          }
        } catch (error) {
          console.log(UIRenderer.message("error", `Không thể xử lý ${packageName}: ${error.message}`));
          continue;
        }
      }


      const saved = Utils.saveMultiConfigs(this.configs);
      console.log(UIRenderer.infoCard([
        ["Đã chọn", String(selectedConfigs.length)],
        ["Còn lại", String(Object.keys(this.configs).length)],
        ["Kết quả", saved ? "ĐÃ LƯU THAY ĐỔI" : "LƯU THẤT BẠI", saved ? "1;32" : "1;31"]
      ], saved ? "CHỈNH SỬA HOÀN TẤT" : "CHỈNH SỬA GẶP LỖI"));

      return saved;
    } catch (error) {
      console.log(`[-] Lỗi nghiêm trọng trong ConfigEditor: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      return false;
    }
  }

  renderConfigTable() {
    return UIRenderer.displayConfiguredPackages(this.configs);
  }
}


// Giữ console.log gốc: lúc giám sát trực tiếp console bị chuyển vào NHẬT KÝ, nhưng lời chào thoát vẫn phải hiện.
const rawLog = console.log.bind(console);
let shuttingDown = false;
function gracefulShutdown(signal = "SIGINT") {
  if (shuttingDown) return;
  shuttingDown = true;
  rawLog(`\n\n Đang dừng chương trình (${signal})...`);
  Utils.disableWakeLock();
  rawLog(' Đã tắt wake lock. REJOIN TOOL đã dừng.');
  process.exit(0);
}
// Luôn trả con trỏ về dù thoát bằng cách nào (spinner / giám sát trực tiếp có ẩn con trỏ).
process.on('exit', () => {
  if (process.stdout.isTTY) process.stdout.write('\x1b[?25h');
  try { if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false); } catch (_) { }
  Utils.disableWakeLock(); // luôn nhả wake lock dù thoát bằng cách nào (Ctrl+D, lỗi...)
});
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));


process.on('unhandledRejection', (reason) => {
  console.error(`[-] Lỗi bất đồng bộ: ${reason && reason.stack ? reason.stack : reason}`);
});
process.on('uncaughtException', (error) => {
  console.error(`[-] Lỗi không xử lý: ${error && error.stack ? error.stack : error}`);
  Utils.disableWakeLock();
  process.exitCode = 1;
});

(async () => {
  try {
    const tool = new MultiRejoinTool();
    await tool.start();
  } catch (error) {
    console.error(`[-] Tool dừng do lỗi: ${error && error.stack ? error.stack : error}`);
    Utils.disableWakeLock();
    process.exitCode = 1;
  }
})();