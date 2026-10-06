#!/usr/bin/env node
const { execSync, exec } = require("child_process");
function ensurePackages() {
  // boxen@6+ và screenshot-desktop không bắt buộc trên Android/Termux -> optional
  const requiredPackages = ["axios", "cli-table3", "figlet"];
  const optionalPackages = ["boxen@5.1.2", "screenshot-desktop"];

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

/** Chuyển config cũ (nằm trong repo) sang CONFIG_DIR, chạy 1 lần duy nhất. */
function migrateLegacyConfigs() {
  if (path.resolve(CONFIG_DIR) === path.resolve(__dirname)) return;
  for (const name of CONFIG_FILENAMES) {
    const oldPath = path.join(__dirname, name);
    const newPath = path.join(CONFIG_DIR, name);
    try {
      if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
        fs.copyFileSync(oldPath, newPath);
        console.log(`[+] Đã chuyển config "${name}" sang ${CONFIG_DIR}`);
        try { fs.renameSync(oldPath, `${oldPath}.migrated`); } catch (_) {}
      }
    } catch (e) {
      console.error(`[-] Không migrate được "${name}": ${e.message}`);
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

// Activity mặc định cố định, KHÔNG phụ thuộc prefix package.
const DEFAULT_ACTIVITY = "com.roblox.client.ActivityProtocolLaunch";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// figlet / boxen / screenshot-desktop là tuỳ chọn:
// boxen >= 6 là ESM-only nên require() sẽ ném ERR_REQUIRE_ESM,
// screenshot-desktop không hoạt động trên Android. Không được để crash tool.
let figlet = null;
try {
  figlet = require("figlet");
} catch (e) {
  console.warn(`[!] Không load được figlet, dùng tiêu đề dự phòng: ${e.message}`);
}

let boxen = null;
try {
  const _boxen = require("boxen");
  boxen = _boxen.default || _boxen;
  if (typeof boxen !== "function") boxen = null;
} catch (e) {
  boxen = null;
}
if (!boxen) {
  // Fallback tự vẽ khung, không phụ thuộc package ESM
  boxen = (content, opts = {}) => {
    const padding = typeof opts.padding === "number" ? opts.padding : 1;
    const lines = String(content).split("\n");
    const width = Math.max(...lines.map(l => l.length));
    const pad = " ".repeat(padding);
    const top = "╭" + "─".repeat(width + padding * 2) + "╮";
    const bottom = "╰" + "─".repeat(width + padding * 2) + "╯";
    const body = lines.map(l => {
      const space = " ".repeat(width - l.length);
      return opts.align === "center"
        ? "│" + pad + " ".repeat(Math.floor(space.length / 2)) + l + " ".repeat(Math.ceil(space.length / 2)) + pad + "│"
        : "│" + pad + l + space + pad + "│";
    });
    return [top, ...body, bottom].join("\n");
  };
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
    try {
      const uid = execSync("id -u").toString().trim();
      if (uid !== "0") {
        const node = execSync("which node").toString().trim();
        console.log("Cần quyền root, chuyển qua su...");
        execSync(`su -c "${node} ${__filename}"`, { stdio: "inherit" });
        process.exit(0);
      }
    } catch (e) {
      console.error("Không thể chạy với quyền root:", e.message);
      process.exit(1);
    }
  }

  static enableWakeLock() {
    try {
      exec("termux-wake-lock");
      console.log("Wake lock bật");
    } catch {
      console.warn("Không bật được wake lock");
    }
  }

  static disableWakeLock() {
    try {
      execSync("termux-wake-unlock", { stdio: "ignore", timeout: 5000 });
    } catch (_) { }
  }

  static async launch(placeId, linkCode = null, packageName) {
    const url = linkCode
      ? `roblox://placeID=${placeId}&linkCode=${linkCode}`
      : `roblox://placeID=${placeId}`;

    console.log(` [${packageName}] Đang mở: ${url}`);
    if (linkCode) console.log(` [${packageName}] Đã join bằng linkCode: ${linkCode}`);


    // Activity: dùng giá trị tùy chỉnh nếu có, ngược lại luôn dùng mặc định cố định
    // (không ghép theo prefix package nữa).
    let activity;
    const customActivity = this.loadActivityConfig();

    if (customActivity) {
      activity = customActivity;
      console.log(` [${packageName}] Sử dụng activity tùy chỉnh: ${activity}`);
    } else {
      activity = DEFAULT_ACTIVITY;
      console.log(` [${packageName}] Sử dụng activity mặc định: ${activity}`);
    }

    const command = `am start -n ${packageName}/${activity} -a android.intent.action.VIEW -d "${url}" --activity-clear-top`;

    try {
      execSync(command, { stdio: 'pipe' });
      console.log(`[+] [${packageName}] Launch command executed!`);
    } catch (e) {
      console.error(`[-] [${packageName}] Launch failed: ${e.message}`);
    }
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
      const raw = fs.readFileSync(CONFIG_PATH);
      return JSON.parse(raw);
    } catch {
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
      const raw = fs.readFileSync(WEBHOOK_CONFIG_PATH);
      const config = JSON.parse(raw);


      if (config && typeof config.enabled === 'undefined') {
        config.enabled = true;
      }

      return config;
    } catch {
      return null;
    }
  }

  static savePackagePrefixConfig(prefix) {
    try {
      const config = { prefix: prefix };
      Utils.writeJsonAtomic(PREFIX_CONFIG_PATH, config);
      return true;
    } catch (e) {
      console.error(UIRenderer.message("error", `Không thể lưu prefix: ${e.message}`));
      return false;
    }
  }

  static loadPackagePrefixConfig() {
    if (!fs.existsSync(PREFIX_CONFIG_PATH)) {

      return "com.roblox";
    }
    try {
      const raw = fs.readFileSync(PREFIX_CONFIG_PATH);
      const config = JSON.parse(raw);
      return config.prefix || "com.roblox";
    } catch {
      return "com.roblox";
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
    try {

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `screenshot_${timestamp}.png`;
      const filepath = path.join(__dirname, filename);


      const screencapCommand = `su -c "screencap -p"`;
      const imgBuffer = execSync(screencapCommand, { stdio: 'pipe' });

      fs.writeFileSync(filepath, imgBuffer);
      console.log(`[*] Đã chụp ảnh: ${filename}`);
      return filepath;
    } catch (e) {
      console.error(`[-] Lỗi khi chụp ảnh với screencap: ${e.message}`);


      try {
        if (!screenshot) throw new Error("screenshot-desktop không khả dụng");
        const img = await screenshot();
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `screenshot_${timestamp}.png`;
        const filepath = path.join(__dirname, filename);

        fs.writeFileSync(filepath, img);
        console.log(`[*] Đã chụp ảnh (fallback): ${filename}`);
        return filepath;
      } catch (e2) {
        console.log(`[-] Không thể chụp ảnh - Tạo file thông tin hệ thống`);

        try {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const filename = `system_info_${timestamp}.txt`;
          const filepath = path.join(__dirname, filename);


          const systemInfo = {
            platform: os.platform(),
            arch: os.arch(),
            nodeVersion: process.version,
            uptime: os.uptime(),
            totalMemory: os.totalmem(),
            freeMemory: os.freemem(),
            cpuCount: os.cpus().length,
            timestamp: new Date().toISOString(),
            environment: process.env.TERMUX_VERSION ? 'Termux' : 'Other'
          };

          const content = `=== SYSTEM INFORMATION ===
Platform: ${systemInfo.platform}
Architecture: ${systemInfo.arch}
Node.js Version: ${systemInfo.nodeVersion}
Uptime: ${Math.floor(systemInfo.uptime / 3600)}h ${Math.floor((systemInfo.uptime % 3600) / 60)}m
Total Memory: ${Math.round(systemInfo.totalMemory / 1024 / 1024)} MB
Free Memory: ${Math.round(systemInfo.freeMemory / 1024 / 1024)} MB
CPU Cores: ${systemInfo.cpuCount}
Environment: ${systemInfo.environment}
Timestamp: ${systemInfo.timestamp}
========================`;

          fs.writeFileSync(filepath, content);
          console.log(`[*] Đã tạo file thông tin hệ thống: ${filename}`);
          return filepath;
        } catch (e3) {
          console.error(`[-] Không thể tạo file thông tin: ${e3.message}`);
          return null;
        }
      }
    }
  }

  static deleteScreenshot(filepath) {
    // Chỉ xóa file tạm do chính tool tạo trong thư mục script.
    try {
      const resolved = path.resolve(filepath || "");
      const allowed = path.dirname(resolved) === path.resolve(__dirname)
        && /^(screenshot_|system_info_).+\.(png|txt)$/i.test(path.basename(resolved));
      if (allowed && fs.existsSync(resolved)) {
        fs.unlinkSync(resolved);
        console.log(`[-] Đã dọn file tạm: ${path.basename(resolved)}`);
      }
    } catch (e) {
      console.error(`[-] Lỗi khi dọn file tạm: ${e.message}`);
    }
  }

  static async sendWebhookEmbed(webhookUrl, embedData, screenshotPath = null) {
    try {
      const payload = {
        embeds: [embedData]
      };

      if (screenshotPath && fs.existsSync(screenshotPath)) {
        const screenshotBuffer = fs.readFileSync(screenshotPath);
        const fileExt = path.extname(screenshotPath).toLowerCase();
        const contentType = fileExt === '.png' ? 'image/png' : 'text/plain';
        const boundary = '----WebKitFormBoundary' + Math.random().toString(16).substr(2);

        let body = '';
        body += `--${boundary}\r\n`;
        body += `Content-Disposition: form-data; name="payload_json"\r\n`;
        body += `Content-Type: application/json\r\n\r\n`;
        body += JSON.stringify(payload) + '\r\n';
        body += `--${boundary}\r\n`;
        body += `Content-Disposition: form-data; name="file"; filename="${path.basename(screenshotPath)}"\r\n`;
        body += `Content-Type: ${contentType}\r\n\r\n`;

        const multipartBody = Buffer.concat([
          Buffer.from(body, 'utf8'),
          screenshotBuffer,
          Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
        ]);

        await axios.post(webhookUrl, multipartBody, {
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': multipartBody.length
          },
        });
      } else {

        await axios.post(webhookUrl, payload, {
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }

      console.log(`[+] Đã gửi webhook thành công!`);


      if (screenshotPath) {
        setTimeout(() => {
          this.deleteScreenshot(screenshotPath);
        }, 5000);
      }
    } catch (e) {
      console.error(`[-] Lỗi khi gửi webhook: ${e.message}`);
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
      const packagePattern = new RegExp(`package:(${prefix.replace(/\./g, '\\.')}[^\\s]*)`);

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
    console.log(`[*] [${packageName}] Đang lấy cookie ROBLOSECURITY...`);

    try {
      const cookiesPath = `/data/data/${packageName}/app_webview/Default/Cookies`;
      const sdcardPath = `/sdcard/cookies_temp_${Date.now()}.db`;


      try {
        execSync(`cp "${cookiesPath}" "${sdcardPath}"`);
      } catch {

        execSync(`su -c "cp '${cookiesPath}' '${sdcardPath}'"`);
      }


      let cookieValue;
      try {
        const result = execSync(`sqlite3 "${sdcardPath}" "SELECT value FROM cookies WHERE name = '.ROBLOSECURITY' LIMIT 1"`).toString().trim();

        if (!result) {
          console.error(`[-] [${packageName}] Không tìm được cookie ROBLOSECURITY trong database!`);
          try { execSync(`rm -f "${sdcardPath}"`); } catch { }
          return null;
        }

        cookieValue = result;
      } catch (err) {
        console.error(`[-] [${packageName}] Lỗi khi query sqlite3: ${err.message}`);
        try { execSync(`rm -f "${sdcardPath}"`); } catch { }
        return null;
      }


      try {
        execSync(`rm -f "${sdcardPath}"`);
      } catch { }


      if (!cookieValue.startsWith("_")) {
        cookieValue = "_" + cookieValue;
      }

      return `.ROBLOSECURITY=${cookieValue}`;

    } catch (e) {
      console.error(`[-] [${packageName}] Lỗi khi lấy cookie: ${e.message}`);
      return null;
    }
  }

  static maskSensitiveInfo(text) {
    if (!text || text === 'Unknown') return text;
    const str = text.toString();
    if (str.length <= 3) return str;
    return '*'.repeat(str.length - 3) + str.slice(-3);
  }

  static async openEditor(rl, initialContent = "") {
    try {
      const tempFile = path.join(__dirname, `temp_script_${Date.now()}.txt`);
      fs.writeFileSync(tempFile, initialContent);

      execSync('command -v nano', { stdio: 'ignore' });

      console.log(UIRenderer.infoCard([
        ["Trình soạn thảo", "Nano"],
        ["Thời gian mở", "Sau 5 giây"],
        ["Hướng dẫn", "Dán script, lưu và đóng Nano"]
      ], "CHUẨN BỊ NHẬP SCRIPT"));
      await new Promise(resolve => setTimeout(resolve, 5000));

      console.log(UIRenderer.message("info", "Đang mở Nano Editor..."));
      execSync(`export TERM=xterm && nano "${tempFile}"`, { stdio: 'inherit' });

      if (fs.existsSync(tempFile)) {
        const content = fs.readFileSync(tempFile, 'utf8');
        fs.unlinkSync(tempFile);
        return content;
      }
    } catch (e) {
      console.log(UIRenderer.message("warning", "Nano không khả dụng; chuyển sang nhập thủ công."));
      console.log(UIRenderer.infoCard([
        ["Kết thúc", "Gõ EXIT ở một dòng mới"],
        ["Nội dung cũ", initialContent ? "Đã nạp" : "Không có"]
      ], "NHẬP SCRIPT THỦ CÔNG"));

      let lines = [];
      if (initialContent) {
        console.log(UIRenderer.divider("Nội dung hiện tại"));
        console.log(initialContent);
        console.log(UIRenderer.divider());
        lines = initialContent.split('\n');
      }

      while (true) {
        const line = await Utils.ask(rl, "");
        if (line.trim() === "EXIT") break;
        lines.push(line);
      }
      return lines.join("\n");
    }
    return initialContent;
  }
}

class GameLauncher {
  static async handleGameLaunch(shouldLaunch, placeId, linkCode, packageName, rejoinOnly = false) {
    if (shouldLaunch) {
      console.log(` [${packageName}] Starting launch process...`);


      await Utils.launch(placeId, linkCode, packageName);

      console.log(`[+] [${packageName}] Launch process completed!`);
    }
  }
}

class RobloxUser {
  constructor(username, userId = null, cookie = null) {
    this.username = username;
    this.userId = userId;
    this.cookie = cookie;
  }

  async fetchAuthenticatedUser() {
    try {
      const res = await axios.get("https://users.roblox.com/v1/users/authenticated", {
        headers: {
          Cookie: this.cookie,
          "User-Agent": "Mozilla/5.0 (Linux; Android 10; Termux)",
          Accept: "application/json",
        },
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

  async getPresence() {
    try {
      const r = await axios.post(
        "https://presence.roproxy.com/v1/presence/users",
        { userIds: [this.userId] },
        {
          headers: {
            Cookie: this.cookie,
            "User-Agent": "Mozilla/5.0 (Linux; Android 10; Termux)",
            Accept: "application/json",
          },
        }
      );
      return r.data.userPresences?.[0];
    } catch {
      return null;
    }
  }
}

class GameSelector {
  constructor() {
    this.GAMES = {
      "1": ["126884695634066", "Grow-a-Garden"],
      "2": ["2753915549", "Blox-Fruits"],
      "3": ["6284583030", "Pet-Simulator-X"],
      "4": ["126244816328678", "DIG"],
      "5": ["116495829188952", "Dead-Rails-Alpha"],
      "6": ["8737602449", "PLS-DONATE"],
      "7": ["920587237", "Adopt Me!"],
      "8": ["79546208627805", "99 Night In The Forests"],
      "9": ["109983668079237", "Steal-a-Brainrot"],
      "10": ["127742093697776", "Plants-Vs-Brainrots"],
      "11": ["121864768012064", "Fish-It"],
      "12": ["16732694052", "Fisch"],
      "0": ["custom", "Tùy chỉnh"],
    };
  }

  async chooseGame(rl) {
    const maxKey = Math.max(...Object.keys(this.GAMES).map(Number));
    console.log(UIRenderer.renderSection("Chọn game", "Điểm đến Auto Rejoin"));
    console.log(UIRenderer.options([
      ...Object.entries(this.GAMES).filter(([key]) => key !== "0").map(([key, game]) => ({
        key,
        label: game[1],
        description: `Place ID: ${game[0]}`
      })),
      { key: "0", label: "Tùy chỉnh", description: "Nhập Place ID hoặc link private server", color: "1;35" }
    ]));

    const ans = (await Utils.ask(rl, UIRenderer.prompt(`Chọn game [0-${maxKey}]`))).trim();

    if (ans === "0") {
      console.log(UIRenderer.options([
        { key: "1", label: "Nhập Place ID", description: "Dùng ID game thủ công" },
        { key: "2", label: "Private Server", description: "Dán link redirect sau khi vào private server", color: "1;35" }
      ], { footer: "Chọn cách thêm game tùy chỉnh" }));
      const sub = (await Utils.ask(rl, UIRenderer.prompt("Lựa chọn [1-2]"))).trim();
      if (sub === "1") {
        const pid = (await Utils.ask(rl, UIRenderer.prompt("Place ID"))).trim();
        return { placeId: pid, name: "Tùy chỉnh", linkCode: null };
      }
      if (sub === "2") {
        console.log(UIRenderer.infoCard([
          ["Cách lấy", "Dán link redirect sau khi vào private server"],
          ["Ví dụ", "https://www.roblox.com/games/2753915549/Blox-Fruits?privateServerLinkCode=77455530946706396026289495938493"]
        ], "PRIVATE SERVER"));
        while (true) {
          const link = await Utils.ask(rl, UIRenderer.prompt("Dán link redirect đã chuyển hướng"));
          const m = link.match(/\/games\/(\d+)[^?]*\?[^=]*=([\w-]+)/);
          if (!m) {
            console.log(UIRenderer.message("error", "Link không hợp lệ!"));
            continue;
          }
          return {
            placeId: m[1],
            name: "Private Server",
            linkCode: m[2],
          };
        }
      }
      throw new Error(`[-] Không hợp lệ!`);
    }

    if (this.GAMES[ans]) {
      return {
        placeId: this.GAMES[ans][0],
        name: this.GAMES[ans][1],
        linkCode: null,
      };
    }

    throw new Error(`[-] Không hợp lệ!`);
  }
}

class StatusHandler {
  constructor() {
    this.hasLaunched = false;
    this.joinedAt = 0;
  }

  analyzePresence(presence, targetRootPlaceId) {
    const now = Date.now();

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


    if (!presence.rootPlaceId || presence.rootPlaceId.toString() !== targetRootPlaceId.toString()) {
      return {
        status: "Sai map",
        info: `User đang trong game nhưng sai rootPlaceId (${presence.rootPlaceId}). Đã rejoin đúng map! `,
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
    const prefix = heading ? "─" + heading : "";
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

  static renderTitle() {
    const width = this._width();
    const contentWidth = width - 4;
    const subtitle =
      width >= 60
        ? "ANDROID  /  MULTI INSTANCE  /  LIVE MONITOR"
        : "ANDROID / LIVE MONITOR";

    return "\n" + this._panel("CONTROL CENTER", [
      this.color("accent", this._center("R E J O I N", contentWidth)),
      this.color("violet", this._center(subtitle, contentWidth))
    ], width);
  }

  static renderSection(title, subtitle = "") {
    const width = this._width();
    const lines = [
      "",
      this.color("accent", `  ◆ ${String(title).toUpperCase()}`)
    ];
    if (subtitle) {
      lines.push(
        ...this._wrap(subtitle, width - 2).map((l) => this.color("dim", `  ${l}`))
      );
    }
    lines.push(this.color("muted", "─".repeat(width)));
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
      const badge = `[${item.key}]`;
      lines.push(
        this.color(item.color || accent, badge) +
        " " +
        this.color(
          "text",
          this.fit(item.label || "", Math.max(1, contentWidth - this._len(badge) - 1))
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
    return (
      this.color("accent", "━".repeat(filled)) +
      this.color("muted", "━".repeat(length - filled))
    );
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
  static renderMainMenu({ configCount, prefix, webhook, autoexec }) {
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
      ["0", "Thoát", "Dừng tool và tắt wake lock", "bad"]
    ];

    const meta = [
      ...this._wrap(
        `CẤU HÌNH: ${configCount}  /  ${configCount > 0 ? "ĐÃ THIẾT LẬP" : "CHƯA THIẾT LẬP"}`,
        contentWidth
      ).map((l) => this.color(configCount > 0 ? "good" : "warn", l)),
      ...this._wrap(`PREFIX: ${prefix || "com.roblox"}`, contentWidth)
        .map((l) => this.color("dim", l)),
      ...this._wrap(
        `WEBHOOK: ${webhook?.enabled ? "BẬT" : "TẮT"}  /  AUTOEXEC: ${autoexec?.executor || "TẮT"}`,
        contentWidth
      ).map((l) => this.color("violet", l))
    ];

    const cell = ([key, label, description, tone], w) => [
      ` ${this.color(tone, `[${key}]`)} ${this.color("text", this.fit(label, Math.max(1, w - 6)))} `,
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
    lines.push(this.color("dim", "  Nhập số để chọn • 0 / Q để thoát"));
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
    const v = String(status || "");
    if (v === "Online [+]" || v === "Trong game") return "good";
    if (v === "Offline" || v === "Sai map") return "bad";
    if (v === "Lỗi mạng") return "warn";
    if (v.includes("Khởi tạo") || v === "Đang xác nhận") return "accent";
    return "violet";
  }

  static statusColor(status) {
    return this.color(this._statusTone(status), String(status || "Không rõ"));
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

  static renderMultiInstanceTable(instances, startTime = null) {
    const width = this._width(118);
    const contentWidth = width - 4;
    const stats = this.getSystemStats();

    const inGame = instances.filter(
      (x) => x.status === "Online [+]" || x.status === "Trong game"
    ).length;
    const errors = instances.filter((x) => x.status === "Lỗi mạng").length;
    const rejoins = instances.reduce(
      (s, x) => s + (Number(x.rejoinCount) || 0),
      0
    );

    const uptime = startTime
      ? Math.max(0, Math.floor((Date.now() - startTime) / 1000))
      : 0;
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const s = uptime % 60;

    const summary = this._panel("SYSTEM / LIVE", [
      ...this._wrap(
        `CPU ${stats.cpuUsage}%  •  RAM ${stats.ramUsage}`,
        contentWidth
      ).map((l) => this.color("accent", l)),
      ...this._wrap(
        `REJOIN ${rejoins}  •  LỖI MẠNG ${errors}`,
        contentWidth
      ).map((l) => this.color(errors > 0 ? "warn" : "violet", l)),
      this.color("dim", `UPTIME ${h}h ${m}m ${s}s`),
      this.progressBar(
        inGame,
        instances.length,
        Math.min(18, Math.max(6, width - 26))
      ) + `  ${this.color("good", `${inGame}/${instances.length} trong game`)}`
    ], width);

    if (!instances.length) {
      return summary + "\n" + this.message("warning", "Chưa có instance đang chạy.");
    }

    // Màn hình hẹp: dùng thẻ thay vì bảng, tránh tràn cột.
    if (width < 96) {
      const cards = instances.map((instance, index) => {
        const config = instance.config || {};
        const username =
          config.username ||
          (instance.user && instance.user.username) ||
          "Unknown";
        return this.infoCard(
          [
            ["Package", Utils.packageLabel(instance.packageName), "accent"],
            ["Tài khoản", Utils.maskSensitiveInfo(username)],
            ["Trạng thái", instance.status || "Không rõ", this._statusTone(instance.status)],
            ["Thông tin", instance.info || "-", "dim"],
            ["Kiểm tra", this.formatCountdown(instance.countdownSeconds), "violet"],
            ["Cập nhật", this._clock(instance.lastCheck), "dim"],
            ["Rejoin", String(instance.rejoinCount || 0), "warn"]
          ],
          `INSTANCE ${String(index + 1).padStart(2, "0")}`
        );
      });
      return summary + "\n\n" + cards.join("\n\n");
    }

    const rows = instances.map((instance) => {
      const username =
        (instance.config && instance.config.username) ||
        (instance.user && instance.user.username) ||
        "Unknown";
      return [
        Utils.packageLabel(instance.packageName),
        Utils.maskSensitiveInfo(username),
        this.statusColor(instance.status),
        instance.info || "-",
        this._clock(instance.lastCheck),
        this.color("violet", this.formatCountdown(instance.countdownSeconds))
      ];
    });

    return (
      summary +
      "\n\n" +
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

    const choice = parseInt(await Utils.ask(rl, UIRenderer.prompt("Executor [1-4]"))) - 1;
    if (choice < 0 || choice >= executors.length) {
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
  }

  async start() {
    Utils.ensureRoot();
    Utils.enableWakeLock();

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    const actions = {
      "1": () => this.startAutoRejoin(rl),
      "2": () => this.setupPackages(rl),
      "3": () => this.editConfigs(rl),
      "4": () => this.configurePackagePrefix(rl),
      "5": () => this.configureActivity(rl),
      "6": () => this.setupWebhook(rl),
      "7": () => this.setupAutoexec(rl),
    };

    try {
      while (!this.isRunning) {
        console.clear();
        console.log(UIRenderer.renderTitle());
        console.log(UIRenderer.renderMainMenu({
          configCount: Object.keys(Utils.loadMultiConfigs()).length,
          prefix: Utils.loadPackagePrefixConfig(),
          webhook: Utils.loadWebhookConfig(),
          autoexec: new AutoexecManager().loadConfig(),
        }));

        const choice = (await Utils.ask(rl, UIRenderer.prompt("Chọn chức năng [0-7]"))).trim();
        if (choice === "0" || choice.toLowerCase() === "q") break;
        const action = actions[choice];
        if (!action) {
          console.log(UIRenderer.message("warning", "Lựa chọn không hợp lệ."));
          await sleep(900);
          continue;
        }

        try {
          await action();
        } catch (error) {
          console.error(`\n[-] Không thể hoàn tất: ${error.message}`);
        }

        // Không xóa thông báo ngay khi một chức năng kết thúc hoặc gặp lỗi.
        // Điều này đặc biệt hữu ích khi mục Rejoin không tạo được instance
        // (ví dụ: không đọc được cookie hoặc package không còn tồn tại).
        if (!this.isRunning) {
          await Utils.ask(rl, UIRenderer.prompt("Nhấn Enter để quay lại menu"));
        }
      }
    } finally {
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
      await new Promise(resolve => setTimeout(resolve, 2000));
      return;
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
        await sleep(900);
        return;
      }

      selectedPackages = [...new Map(indices.map(i => [packageList[i].packageName, packageList[i]])).values()];
      console.log(UIRenderer.selectionCard(
        selectedPackages.map((pkg) => pkg.packageInfo.displayName),
        "PACKAGE SẼ THIẾT LẬP"
      ));
    }


    const configs = {};
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
      const game = await selector.chooseGame(rl);

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

    console.log(UIRenderer.message("info", "Đang quay lại menu chính..."));
    await sleep(900);
    return;
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
        if (newPrefix.trim()) {
          break;
        }
        console.log(UIRenderer.message("error", "Prefix không được để trống."));
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

      selectedPackages = indices.map(i => packageList[i]);
      console.log(UIRenderer.selectionCard(selectedPackages.map((pkg) => Utils.packageLabel(pkg)), "PACKAGE SẼ CHẠY"));
    }

    console.log(UIRenderer.message("info", "Đang khởi tạo hệ thống multi-instance..."));
    await this.initializeSelectedInstances(selectedPackages, configs);
  }

  async initializeSelectedInstances(selectedPackages, configs) {
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
        rejoinCount: 0
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
      ["Webhook", webhookConfig && webhookConfig.enabled ? "ĐANG BẬT" : "ĐANG TẮT", webhookConfig && webhookConfig.enabled ? "1;32" : "2;37"],
      ["Autoexec", autoexecConfig ? autoexecConfig.executor : "ĐANG TẮT", autoexecConfig ? "1;32" : "2;37"],
      ["Khởi động", "Sau 3 giây"]
    ], "AUTO REJOIN"));
    await new Promise(resolve => setTimeout(resolve, 3000));

    this.isRunning = true;
    await this.runMultiInstanceLoop();
  }

  async runMultiInstanceLoop() {
    let renderCounter = 0;
    const webhookManager = new WebhookManager();
    const webhookConfig = Utils.loadWebhookConfig();

    let webhookCounter = 0;

    const autoexecManager = new AutoexecManager();
    const autoexecConfig = autoexecManager.loadConfig();
    let nextAutoexecCheck = Date.now() + 15 * 60 * 1000;

    while (this.isRunning) {
      const now = Date.now();

      if (autoexecConfig && now >= nextAutoexecCheck) {
        autoexecManager.checkAndFix(autoexecConfig);
        nextAutoexecCheck = now + 15 * 60 * 1000;
      }

      for (const instance of this.instances) {
        const { config, user, statusHandler } = instance;
        const delayMs = config.delaySec * 1000;

        const timeSinceLastCheck = now - instance.lastCheck;

        const timeLeft = Math.max(0, delayMs - timeSinceLastCheck);
        instance.countdownSeconds = Math.ceil(timeLeft / 1000);

        if (timeSinceLastCheck >= delayMs) {
          const presence = await user.getPresence();

          let presenceTypeDisplay = "Unknown";
          if (presence && presence.userPresenceType !== undefined) {
            presenceTypeDisplay = presence.userPresenceType.toString();
          }

          const analysis = statusHandler.analyzePresence(presence, config.placeId);

          if (analysis.shouldLaunch) {
            GameLauncher.handleGameLaunch(
              analysis.shouldLaunch,
              config.placeId,
              config.linkCode,
              config.packageName,
              true
            );
            statusHandler.updateJoinStatus(analysis.shouldLaunch);
            instance.rejoinCount = (instance.rejoinCount || 0) + 1;
          }

          instance.status = analysis.status;
          instance.info = analysis.info;
          instance.presenceType = presenceTypeDisplay;
          instance.lastCheck = now;
        }

        if (!instance.presenceType) {
          instance.presenceType = "Unknown";
        }
      }

      if (webhookConfig && webhookConfig.enabled && webhookCounter % (webhookConfig.intervalMinutes * 60) === 0 && webhookCounter > 0) {
        console.log(`\n Đang gửi webhook status...`);
        try {
          await webhookManager.sendStatusWebhook(this.instances, this.startTime);
        } catch (e) {
          console.error(`[-] Lỗi gửi webhook: ${e.message}`);
        }
      }

      if (renderCounter % 5 === 0) {
        console.clear();
        try {
          console.log(UIRenderer.renderTitle());
        } catch (e) {
          console.log(`
╭────────────────────────────╮
│        REJOIN TOOL         │
╰────────────────────────────╯`);
        }

        console.log(UIRenderer.renderSection("Giám sát trực tiếp", `${this.instances.length} instance đang hoạt động`));
        console.log(UIRenderer.renderMultiInstanceTable(this.instances, this.startTime));

        if (webhookConfig && webhookConfig.url) {
          const urlParts = webhookConfig.url.split('/');
          const webhookId = urlParts[urlParts.length - 2] || 'unknown';
          const statusText = webhookConfig.enabled
            ? UIRenderer.color("1;32", "BẬT")
            : UIRenderer.color("1;31", "TẮT");
          const nextWebhookText = webhookConfig.enabled
            ? (() => {
                const period = webhookConfig.intervalMinutes * 60;
                const nextWebhookIn = period - (webhookCounter % period);
                return `${Math.floor(nextWebhookIn / 60)}m ${nextWebhookIn % 60}s`;
              })()
            : "Đã tắt";
          console.log(UIRenderer.infoCard([
            ["Webhook ID", webhookId],
            ["Trạng thái", webhookConfig.enabled ? "ĐANG BẬT" : "ĐANG TẮT", webhookConfig.enabled ? "1;32" : "1;31"],
            ["Lần gửi tiếp", nextWebhookText],
            ["Chu kỳ", `${webhookConfig.intervalMinutes} phút`]
          ], "WEBHOOK"));
        }

        console.log(`\n${UIRenderer.color("2;37", "CTRL+C")}  ${UIRenderer.color("1;37", "Dừng chương trình an toàn")}`);
      }

      renderCounter++;
      webhookCounter++;
      await sleep(1000);
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
      if (webhookUrl.trim() && webhookUrl.includes('discord.com/api/webhooks/')) {
        break;
      }
      console.log(UIRenderer.message("error", "URL webhook không hợp lệ. Vui lòng nhập lại."));
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
      if (webhookUrl.includes('discord.com/api/webhooks/')) {
        break;
      }
      console.log(UIRenderer.message("error", "URL webhook không hợp lệ. Vui lòng nhập lại."));
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
      const saved = Utils.saveWebhookConfig(null);
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
    if (!this.webhookConfig || !this.webhookConfig.enabled) return;

    try {
      const stats = UIRenderer.getSystemStats();
      const uptimeMs = Date.now() - startTime;
      const hours = Math.floor(uptimeMs / (1000 * 60 * 60));
      const minutes = Math.floor((uptimeMs % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((uptimeMs % (1000 * 60)) / 1000);


      const activePackages = instances.filter(instance =>
        instance.status === "Online [+]" || instance.status.includes("Online")
      ).length;


      const packageList = instances.map(instance => {
        const packageDisplay = Utils.packageLabel(instance.packageName, ' ');
        return `${packageDisplay}: ${instance.status}`;
      }).join('\n');

      const embed = {
        title: "REJOIN TOOL Status Report",
        color: 0x00ff00,
        timestamp: new Date().toISOString(),
        fields: [
          {
            name: " CPU Usage",
            value: `${stats.cpuUsage}%`,
            inline: true
          },
          {
            name: " RAM Usage",
            value: stats.ramUsage,
            inline: true
          },
          {
            name: "⏱️ Uptime",
            value: `${hours}h ${minutes}m ${seconds}s`,
            inline: true
          },
          {
            name: " Active Instances",
            value: `${activePackages}/${instances.length}`,
            inline: true
          },
          {
            name: " Package Status",
            value: packageList.length > 1024 ? packageList.substring(0, 1021) + "..." : packageList,
            inline: false
          }
        ],
        footer: {
          text: "REJOIN TOOL"
        }
      };


      const screenshotPath = await Utils.takeScreenshot();


      await Utils.sendWebhookEmbed(this.webhookConfig.url, embed, screenshotPath);

    } catch (e) {
      console.error(`[-] Lỗi khi gửi webhook: ${e.message}`);
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
                  ["Cách lấy", "Dán link redirect sau khi vào private server"],
                  ["Ví dụ", "https://www.roblox.com/games/2753915549/Blox-Fruits?privateServerLinkCode=77455530946706396026289495938493"]
                ], "PRIVATE SERVER"));
                while (true) {
                  try {
                    const link = await Utils.ask(rl, UIRenderer.prompt("Dán link redirect đã chuyển hướng"));
                    const m = link.match(/\/games\/(\d+)[^?]*\?[^=]*=([\w-]+)/);
                    if (!m) {
                      console.log(UIRenderer.message("error", "Link không hợp lệ!"));
                      continue;
                    }
                    config.placeId = m[1];
                    config.gameName = "Private Server";
                    config.linkCode = m[2];
                    console.log(UIRenderer.infoCard([
                      ["Place ID", m[1], "1;36"],
                      ["Link code", "ĐÃ CẬP NHẬT"],
                      ["Kết quả", "ĐÃ CẬP NHẬT", "1;32"]
                    ], "PRIVATE SERVER"));
                    break;
                  } catch (error) {
                    console.log(UIRenderer.message("error", `Không thể xử lý link: ${error.message}`));
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


let shuttingDown = false;
function gracefulShutdown(signal = "SIGINT") {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n\n Đang dừng chương trình (${signal})...`);
  Utils.disableWakeLock();
  console.log(' Đã tắt wake lock. REJOIN TOOL đã dừng.');
  process.exit(0);
}
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