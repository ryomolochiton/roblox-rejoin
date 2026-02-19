#!/usr/bin/env node
const { execSync, exec } = require("child_process");
function ensurePackages() {
  const requiredPackages = ["axios", "cli-table3", "figlet", "boxen", "screenshot-desktop"];

  requiredPackages.forEach((pkg) => {
    try {
      require.resolve(pkg);
    } catch {
      console.log(`Đang cài package thiếu: ${pkg}`);
      try {
        execSync(`npm install ${pkg}`, { stdio: "inherit" });
      } catch (e) {
        console.error(`Lỗi khi cài ${pkg}:`, e.message);
        process.exit(1);
      }
    }
  });
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
const CONFIG_PATH = path.join(__dirname, "multi_configs.json");
const WEBHOOK_CONFIG_PATH = path.join(__dirname, "webhook_config.json");
const PREFIX_CONFIG_PATH = path.join(__dirname, "package_prefix_config.json");
const ACTIVITY_CONFIG_PATH = path.join(__dirname, "activity_config.json");
const AUTOEXEC_CONFIG_PATH = path.join(__dirname, "autoexec_config.json");
const util = require("util");
const figlet = require("figlet");
const _boxen = require("boxen");
const boxen = _boxen.default || _boxen;
const screenshot = require("screenshot-desktop");

class Utils {
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




  static async launch(placeId, linkCode = null, packageName) {
    const url = linkCode
      ? `roblox://placeID=${placeId}&linkCode=${linkCode}`
      : `roblox://placeID=${placeId}`;

    console.log(` [${packageName}] Đang mở: ${url}`);
    if (linkCode) console.log(` [${packageName}] Đã join bằng linkCode: ${linkCode}`);


    let activity;
    const prefix = this.loadPackagePrefixConfig();
    const customActivity = this.loadActivityConfig();


    if (customActivity) {
      activity = customActivity;
      console.log(` [${packageName}] Sử dụng activity tùy chỉnh: ${activity}`);
    } else {

      if (packageName.startsWith(`${prefix}.client.`)) {


        activity = `${prefix}.client.ActivityProtocolLaunch`;
      } else if (packageName === `${prefix}.client`) {

        activity = `${prefix}.client.ActivityProtocolLaunch`;
      } else {

        activity = `${prefix}.client.ActivityProtocolLaunch`;
      }
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
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(configs, null, 2));
      console.log(`[+] Đã lưu multi configs tại ${CONFIG_PATH}`);
    } catch (e) {
      console.error(`[-] Không thể lưu configs: ${e.message}`);
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
      fs.writeFileSync(WEBHOOK_CONFIG_PATH, JSON.stringify(config, null, 2));
      console.log(`[+] Đã lưu webhook config tại ${WEBHOOK_CONFIG_PATH}`);
    } catch (e) {
      console.error(`[-] Không thể lưu webhook config: ${e.message}`);
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
      fs.writeFileSync(PREFIX_CONFIG_PATH, JSON.stringify(config, null, 2));
      console.log(`[+] Đã lưu prefix package: ${prefix}`);
    } catch (e) {
      console.error(`[-] Không thể lưu prefix config: ${e.message}`);
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
      fs.writeFileSync(ACTIVITY_CONFIG_PATH, JSON.stringify(config, null, 2));
      console.log(`[+] Đã lưu activity: ${activity}`);
    } catch (e) {
      console.error(`[-] Không thể lưu activity config: ${e.message}`);
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
    try {
      if (fs.existsSync(filepath)) {
        fs.unlinkSync(filepath);
        console.log(`[-] Đã xóa ảnh: ${path.basename(filepath)}`);
      }
    } catch (e) {
      console.error(`[-] Lỗi khi xóa ảnh: ${e.message}`);
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
    console.log("[*] Đang kiểm tra toàn vẹn packages...");

    try {

      const systemPackages = this.detectAllRobloxPackages();
      const systemPackageNames = Object.keys(systemPackages);


      const configPackageNames = Object.keys(configs);

      if (configPackageNames.length === 0) {
        console.log("[-] Không có config nào trong file JSON!");
        console.log("[-] Vui lòng chạy setup packages để tạo config.");
        return false;
      }

      if (systemPackageNames.length === 0) {
        console.log("[-] Không tìm thấy package Roblox nào trong hệ thống!");
        console.log("[-] Vui lòng cài đặt ít nhất một app Roblox.");
        return false;
      }


      const missingPackages = configPackageNames.filter(pkg => !systemPackageNames.includes(pkg));


      const extraPackages = systemPackageNames.filter(pkg => !configPackageNames.includes(pkg));

      let hasError = false;

      if (missingPackages.length > 0) {
        console.log("\n[-] PACKAGES THIẾU - Có trong config nhưng không có trong hệ thống:");
        missingPackages.forEach(pkg => {
          const displayName = systemPackages[pkg]?.displayName || pkg;
          console.log(`  [-] ${displayName} (${pkg})`);
        });
        console.log("[-] Giải pháp: Cài đặt lại packages này hoặc xóa khỏi config.");
        hasError = true;
      }

      if (extraPackages.length > 0) {
        console.log("\n[-] PACKAGES DƯ - Có trong hệ thống nhưng không có trong config:");
        extraPackages.forEach(pkg => {
          const displayName = systemPackages[pkg]?.displayName || pkg;
          console.log(`  [-] ${displayName} (${pkg})`);
        });
        console.log("[-] Giải pháp: Thêm vào config bằng cách chạy setup packages hoặc bỏ qua.");
      }


      for (const [packageName, config] of Object.entries(configs)) {
        if (!config.username || !config.userId || !config.placeId || !config.delaySec) {
          console.log(`\n[-] CONFIG KHÔNG ĐẦY ĐỦ cho ${packageName}:`);
          if (!config.username) console.log("  [-] Thiếu username");
          if (!config.userId) console.log("  [-] Thiếu userId");
          if (!config.placeId) console.log("  [-] Thiếu placeId");
          if (!config.delaySec) console.log("  [-] Thiếu delaySec");
          console.log("[-] Giải pháp: Chạy lại setup packages hoặc sửa config.");
          hasError = true;
        }
      }

      if (hasError) {
        console.log("\n[-] KIỂM TRA TOÀN VẸN THẤT BẠI!");
        console.log("[-] Không thể chạy auto rejoin khi có lỗi toàn vẹn.");
        return false;
      }

      const matchingPackages = configPackageNames.filter(pkg => systemPackageNames.includes(pkg));
      console.log(`[+] Kiểm tra toàn vẹn thành công!`);
      console.log(`[+] Có ${matchingPackages.length}/${configPackageNames.length} packages khả dụng`);

      if (extraPackages.length > 0) {
        console.log(`[+] Có ${extraPackages.length} packages dư (không ảnh hưởng đến hoạt động)`);
      }

      return true;

    } catch (e) {
      console.error(`[-] Lỗi khi kiểm tra toàn vẹn: ${e.message}`);
      console.log("[-] Vui lòng kiểm tra lại hệ thống và config file.");
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

  static async curlPastebinVisits() {
    try {

      const res = await axios.get("https://pastebin.com/Q9yk1GNq", {
        timeout: 5000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      const html = res.data;

      const match = html.match(/<div class="visits"[^>]*>\s*([\d,.]+)\s*<\/div>/);
      if (match && match[1]) {
        return match[1].replace(/,/g, '');
      }
      return null;
    } catch (e) {

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

      console.log("\nChuyển hướng sang Nano Editor sau 5 giây...");
      console.log("Vui lòng chuẩn bị copy script để dán vào.");
      await new Promise(resolve => setTimeout(resolve, 5000));

      console.log("Opening nano editor...");
      execSync(`export TERM=xterm && nano "${tempFile}"`, { stdio: 'inherit' });

      if (fs.existsSync(tempFile)) {
        const content = fs.readFileSync(tempFile, 'utf8');
        fs.unlinkSync(tempFile);
        return content;
      }
    } catch (e) {
      console.log("[-] Nano không khả dụng, chuyển sang chế độ nhập thủ công.");
      console.log("[-] Nhập script của bạn (Gõ 'EXIT' ở dòng mới để kết thúc):");

      let lines = [];
      if (initialContent) {
        console.log("--- Nội dung hiện tại ---");
        console.log(initialContent);
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
      "4": ["1537690962", "Bee-Swarm-Simulator"],
      "5": ["16146832113", "Anime-Vanguards"],
      "0": ["custom", "Tùy chỉnh"],
    };
  }

  async chooseGame(rl) {
    console.log(`\n[*] Chọn game:`);
    for (let k in this.GAMES) {
      console.log(`${k}. ${this.GAMES[k][1]} (${this.GAMES[k][0]})`);
    }

    const ans = (await Utils.ask(rl, "Nhập số: ")).trim();

    if (ans === "0") {
      const sub = (await Utils.ask(rl, "0.1 ID thủ công | 0.2 Link private redirect: ")).trim();
      if (sub === "1") {
        const pid = (await Utils.ask(rl, "Nhập Place ID: ")).trim();
        return { placeId: pid, name: "Tùy chỉnh", linkCode: null };
      }
      if (sub === "2") {
        console.log("\n Dán link redirect sau khi vào private server.");
        console.log("VD: https://www.roblox.com/games/2753915549/Blox-Fruits?privateServerLinkCode=77455530946706396026289495938493");
        while (true) {
          const link = await Utils.ask(rl, "\nDán link redirect đã chuyển hướng: ");
          const m = link.match(/\/games\/(\d+)[^?]*\?[^=]*=([\w-]+)/);
          if (!m) {
            console.log(`[-] Link không hợp lệ!`);
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
        status: "Online (Web/App)",
        info: "Phát hiện user đang online nhưng chưa vào game. Đang tiến hành khởi chạy...",
        shouldLaunch: true,
        rejoinOnly: false // Nên để false nếu bạn muốn nó thực sự mở game mới thay vì chỉ "rejoin"
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

class UIRenderer {
  static getSystemStats() {
    const cpus = os.cpus();
    const idle = cpus.reduce((acc, cpu) => acc + cpu.times.idle, 0);
    const total = cpus.reduce((acc, cpu) => {
      return acc + cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle;
    }, 0);

    const cpuUsage = (100 - (idle / total) * 100).toFixed(1);

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    const totalGB = (totalMem / (1024 ** 3)).toFixed(2);
    const usedGB = (usedMem / (1024 ** 3)).toFixed(2);

    return {
      cpuUsage,
      ramUsage: `${usedGB}GB/${totalGB}GB`
    };
  }


  static _ansiColorChar(ch, rgb) {
    const [r, g, b] = rgb;
    return `\x1b[38;2;${Math.round(r)};${Math.round(g)};${Math.round(b)}m${ch}\x1b[0m`;
  }

  static _lerp(a, b, t) {
    return a + (b - a) * Math.max(0, Math.min(1, t));
  }

  static _applyMultiColorGradient(text, colors) {
    if (text.length <= 1) {
      return text.split('').map(c => this._ansiColorChar(c, colors[0])).join('');
    }

    const out = [];
    const numColors = colors.length;
    const n = text.length;

    text.split('').forEach((ch, idx) => {
      const segmentIdx = (idx / (n - 1)) * (numColors - 1);
      const segmentStart = Math.floor(segmentIdx);
      const segmentEnd = Math.min(segmentStart + 1, numColors - 1);

      const t = segmentIdx - segmentStart;
      const leftRgb = colors[segmentStart];
      const rightRgb = colors[segmentEnd];

      const r = this._lerp(leftRgb[0], rightRgb[0], t);
      const g = this._lerp(leftRgb[1], rightRgb[1], t);
      const b = this._lerp(leftRgb[2], rightRgb[2], t);

      out.push(this._ansiColorChar(ch, [r, g, b]));
    });

    return out.join('');
  }

  static renderTitle() {
    const fallbackTitle = `
 ╔══════════════════════════════════════╗
 ║       RYOMOLOCHITON REJOIN           ║
 ║    Bản quyền thuộc về RYOMOLOCHITON  ║
 ╚══════════════════════════════════════╝`;
    try {
const titleText = figlet.textSync("RYOMOLOCHITON REJOIN", {
    font: "Small",
    horizontalLayout: "fitted",
    verticalLayout: "fitted"
});
const content = titleText + "\nBản quyền thuộc về RYOMOLOCHITON";

      const rawBox = boxen(content, {
        padding: 1,
        borderStyle: "round",
        align: "center",

      });

      const rainbowColors = [
        [255, 0, 0],
        [255, 127, 0],
        [255, 255, 0],
        [0, 255, 0],
        [0, 0, 255],
        [75, 0, 130],
        [148, 0, 211]
      ];

      return rawBox.split('\n').map(line =>
        this._applyMultiColorGradient(line, rainbowColors)
      ).join('\n');

    } catch (e) {
      return fallbackTitle;
    }
  }

  static calculateOptimalColumnWidths() {
    const terminalWidth = process.stdout.columns || 120;
    const availableWidth = terminalWidth - 10;

    const minWidths = {
      package: 15,
      user: 8,
      status: 8,
      info: 15,
      time: 8,
      delay: 6
    };

    const totalMinWidth = Object.values(minWidths).reduce((sum, width) => sum + width, 0);

    if (availableWidth <= totalMinWidth) {
      return {
        package: 14,
        user: 6,
        status: 6,
        info: 12,
        time: 6,
        delay: 4
      };
    }

    const extraSpace = availableWidth - totalMinWidth;

    return {
      package: minWidths.package + Math.floor(extraSpace * 0.28),
      user: minWidths.user + Math.floor(extraSpace * 0.18),
      status: minWidths.status + Math.floor(extraSpace * 0.12),
      info: minWidths.info + Math.floor(extraSpace * 0.3),
      time: minWidths.time + Math.floor(extraSpace * 0.06),
      delay: minWidths.delay + Math.floor(extraSpace * 0.06)
    };
  }

  static renderMultiInstanceTable(instances, startTime = null) {
    const stats = this.getSystemStats();
    const colWidths = this.calculateOptimalColumnWidths();


    let uptimeText = "";
    if (startTime) {
      const uptimeMs = Date.now() - startTime;
      const hours = Math.floor(uptimeMs / (1000 * 60 * 60));
      const minutes = Math.floor((uptimeMs % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((uptimeMs % (1000 * 60)) / 1000);
      uptimeText = ` | Uptime: ${hours}h ${minutes}m ${seconds}s`;
    }

    const cpuRamLine = `CPU: ${stats.cpuUsage}% | RAM: ${stats.ramUsage} | Instances: ${instances.length}${uptimeText}`;

    const table = new Table({
      head: ["Package", "User", "Status", "Info", "Time", "Delay"],
      colWidths: [
        colWidths.package,
        colWidths.user,
        colWidths.status,
        colWidths.info,
        colWidths.time,
        colWidths.delay
      ],
      wordWrap: true,
      style: {
        head: ["cyan"],
        border: ["gray"]
      }
    });

    instances.forEach(instance => {
      let packageDisplay;
      const prefix = Utils.loadPackagePrefixConfig();
      if (instance.packageName === `${prefix}.client`) {
        packageDisplay = 'Global';
      } else if (instance.packageName === `${prefix}.client.vnggames`) {
        packageDisplay = 'VNG';
      } else {
        packageDisplay = instance.packageName;
      }

      const rawUsername = instance.config.username || instance.user.username || 'Unknown';
      const username = Utils.maskSensitiveInfo(rawUsername);

      const delaySeconds = Number(instance.countdownSeconds) || 0;

      table.push([
        packageDisplay,
        username,
        instance.status,
        instance.info,
        new Date().toLocaleTimeString(),
        this.formatCountdown(delaySeconds)
      ]);
    });

    return `${cpuRamLine}\n${table.toString()}`;
  }

  static formatCountdown(seconds) {
    return seconds >= 60
      ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
      : `${seconds}s`;
  }

  static displayConfiguredPackages(configs) {
    const colWidths = this.calculateOptimalColumnWidths();

    const table = new Table({
      head: ["STT", "Package", "Username", "Game", "Delay"],
      colWidths: [5, 20, 15, 20, 8],
      style: {
        head: ["cyan"],
        border: ["gray"]
      }
    });

    let index = 1;
    for (const [packageName, config] of Object.entries(configs)) {
      let packageDisplay;
      const prefix = Utils.loadPackagePrefixConfig();
      if (packageName === `${prefix}.client`) {
        packageDisplay = 'Global';
      } else if (packageName === `${prefix}.client.vnggames`) {
        packageDisplay = 'VNG';
      } else {
        packageDisplay = packageName;
      }


      const maskedUsername = Utils.maskSensitiveInfo(config.username);

      table.push([
        index.toString(),
        packageDisplay,
        maskedUsername,
        config.gameName || 'Unknown',
        `${config.delaySec}s`
      ]);
      index++;
    }

    return table.toString();
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
      fs.writeFileSync(AUTOEXEC_CONFIG_PATH, JSON.stringify(config, null, 2));
      console.log("[+] Đã lưu cấu hình autoexec.");
    } catch (e) {
      console.error(`[-] Báo lỗi lưu config: ${e.message}`);
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
    console.clear();
    console.log(UIRenderer.renderTitle());
    console.log("\n Cấu hình Autoexec");

    const currentConfig = this.loadConfig();
    let currentScript = "";
    if (currentConfig) {
      console.log(`\n Executor hiện tại: ${currentConfig.executor}`);
      currentScript = currentConfig.script || "";
    }

    console.log("\nChọn Executor:");
    const executors = Object.keys(this.EXECUTORS);
    executors.forEach((ex, i) => {
      console.log(`${i + 1}. ${ex}`);
    });

    const choice = parseInt(await Utils.ask(rl, "\nNhập số (1-4): ")) - 1;
    if (choice < 0 || choice >= executors.length) {
      console.log("[-] Lựa chọn không hợp lệ!");
      return;
    }

    const selectedExecutor = executors[choice];

    console.log("\nDán script của bạn dưới đây (Sử dụng Nano hoặc nhập EXIT để kết thúc):");
    const script = await Utils.openEditor(rl, currentScript);

    if (!script || !script.trim()) {
      console.log("[-] Script trống!");
      return;
    }

    console.log("\n--- Preview Script ---");
    console.log(script.substring(0, 200) + (script.length > 200 ? "..." : ""));
    console.log("----------------------");

    const confirm = await Utils.ask(rl, "Lưu script này? (y/n): ");
    if (confirm.toLowerCase() !== 'y') {
      console.log("[-] Đã hủy.");
      return;
    }

    const config = {
      executor: selectedExecutor,
      script: script.trim(),
      path: this.EXECUTORS[selectedExecutor]
    };

    this.saveConfig(config);
    this.writeToExecutor(selectedExecutor, script.trim());

    console.log("\n[+] Setup Autoexec thành công!");
    await new Promise(r => setTimeout(r, 2000));
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
    try {
      Utils.ensureRoot();
      Utils.enableWakeLock();

      console.clear();
      let visitCount = null;
      try {
        visitCount = await Utils.curlPastebinVisits();
      } catch (e) {

        visitCount = null;
      }

      try {
        console.log(UIRenderer.renderTitle());
      } catch (e) {
        console.log(`
╔══════════════════════════════════════╗
║           RYOMOLOCHITON REJOIN                ║
║    Bản quyền thuộc về The ryomolochiton  ║
╚══════════════════════════════════════╝`);
      }

      const goldGradient = [[255, 255, 0], [255, 215, 0]];

      if (visitCount) {
        console.log(`\nTổng lượt chạy: ${visitCount}`);
        console.log(`discord.gg/37VJXk9hH4`);
      }

      console.log("\n" + UIRenderer._applyMultiColorGradient("Rejoin Tool", goldGradient));
      console.log(UIRenderer._applyMultiColorGradient("1. Bắt đầu auto rejoin", goldGradient));
      console.log(UIRenderer._applyMultiColorGradient("2. Setup packages", goldGradient));
      console.log(UIRenderer._applyMultiColorGradient("3. Chỉnh sửa config", goldGradient));
      console.log(UIRenderer._applyMultiColorGradient("4. Chỉnh prefix package Roblox", goldGradient));
      console.log(UIRenderer._applyMultiColorGradient("5. Chỉnh activity Roblox", goldGradient));
      console.log(UIRenderer._applyMultiColorGradient("6. Cấu hình webhook", goldGradient));
      console.log(UIRenderer._applyMultiColorGradient("7. Cấu hình Autoexec", goldGradient));

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const choice = await Utils.ask(rl, "\nChọn option (1-7): ");

      try {
        if (choice.trim() === "1") {
          await this.startAutoRejoin(rl);
          rl.close();
        } else if (choice.trim() === "2") {
          await this.setupPackages(rl);
          rl.close();
        } else if (choice.trim() === "3") {
          await this.editConfigs(rl);
          rl.close();
        } else if (choice.trim() === "4") {
          await this.configurePackagePrefix(rl);
          rl.close();
        } else if (choice.trim() === "5") {
          await this.configureActivity(rl);
          rl.close();
        } else if (choice.trim() === "6") {
          await this.setupWebhook(rl);
          rl.close();
        } else if (choice.trim() === "7") {
          await this.setupAutoexec(rl);
          rl.close();
        } else {
          console.log("[-] Lựa chọn không hợp lệ!");
          rl.close();

          await new Promise(resolve => setTimeout(resolve, 1000));
          await this.start();
        }
      } catch (error) {
        console.log(`[-] Lỗi khi xử lý lựa chọn: ${error.message}`);
        rl.close();
        await new Promise(resolve => setTimeout(resolve, 2000));
        await this.start();
      }
    } catch (error) {
      console.log(`[-] Lỗi nghiêm trọng trong start: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, 3000));
      await this.start();
    }
  }

  async setupPackages(rl) {
    console.log("\n Đang quét tất cả packages Roblox...");
    const packages = Utils.detectAllRobloxPackages();

    if (Object.keys(packages).length === 0) {
      console.log("[-] Không tìm thấy package Roblox nào!");
      await new Promise(resolve => setTimeout(resolve, 2000));
      await this.start();
      return;
    }

    console.log("\n Tìm thấy các packages:");
    console.log("0.  Setup tất cả packages");
    const packageList = [];
    Object.values(packages).forEach((pkg, index) => {
      console.log(`${index + 1}. ${pkg.displayName} (${pkg.packageName})`);
      packageList.push({ packageName: Object.keys(packages)[index], packageInfo: pkg });
    });

    const choice = await Utils.ask(rl, "\nChọn packages để setup (0 để setup tất cả, hoặc số cách nhau bởi khoảng trắng): ");
    let selectedPackages = [];

    if (choice.trim() === "0") {
      selectedPackages = packageList;
      console.log(" Sẽ setup tất cả packages!");
    } else {
      const indices = choice
        .trim()
        .split(/\s+/)
        .map(str => parseInt(str) - 1)
        .filter(i => i >= 0 && i < packageList.length);

      if (indices.length === 0) {
        console.log("[-] Lựa chọn không hợp lệ!");
        await new Promise(resolve => setTimeout(resolve, 1000));
        await this.setupPackages(rl);
        return;
      }

      selectedPackages = indices.map(i => packageList[i]);
      console.log(` Sẽ setup các packages:`);
      selectedPackages.forEach((pkg, i) => {
        console.log(`  - ${i + 1}. ${pkg.packageInfo.displayName}`);
      });
    }


    const configs = {};

    for (const { packageName, packageInfo } of selectedPackages) {
      console.clear();
      console.log(UIRenderer.renderTitle());
      console.log(`\n Cấu hình cho ${packageInfo.displayName}`);

      const cookie = Utils.getRobloxCookie(packageName);
      if (!cookie) {
        console.log(`[-] Không lấy được cookie cho ${packageName}, bỏ qua...`);
        continue;
      }

      const user = new RobloxUser(null, null, cookie);
      const userId = await user.fetchAuthenticatedUser();

      if (!userId) {
        console.log(`[-] Không lấy được user info cho ${packageName}, bỏ qua...`);
        continue;
      }

      console.log(` Username: ${Utils.maskSensitiveInfo(user.username)}`);
      console.log(` User ID: ${Utils.maskSensitiveInfo(userId)}`);

      const selector = new GameSelector();
      const game = await selector.chooseGame(rl);

      let delaySec;
      while (true) {
        const input = parseInt(await Utils.ask(rl, " Delay check (giây, 15-120): ")) || 1;
        if (input >= 15 && input <= 120) {
          delaySec = input;
          break;
        }
        console.log("[-] Giá trị không hợp lệ! Vui lòng nhập lại.");
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

      console.log(`[+] Đã cấu hình xong cho ${packageInfo.displayName}!`);
    }

    Utils.saveMultiConfigs(configs);
    console.log("\n[+] Setup hoàn tất!");


    console.log("\n Đang quay lại menu chính...");
    await new Promise(resolve => setTimeout(resolve, 2000));
    await this.start();
  }

  async editConfigs(rl) {
    const configs = Utils.loadMultiConfigs();

    if (Object.keys(configs).length === 0) {
      console.log("[-] Chưa có config nào! Vui lòng chạy setup packages trước.");
      await new Promise(resolve => setTimeout(resolve, 2000));
      await this.start();
      return;
    }



    const configEditor = new ConfigEditor();
    const success = await configEditor.startEdit(rl);

    if (success) {

      console.log("\n Đang quay lại menu chính...");
      await new Promise(resolve => setTimeout(resolve, 2000));
      await this.start();
    } else {

      await new Promise(resolve => setTimeout(resolve, 2000));
      await this.start();
    }
  }

  async setupWebhook(rl) {
    const webhookManager = new WebhookManager();
    await webhookManager.setupWebhook(rl);


    console.log("\n Đang quay lại menu chính...");
    await new Promise(resolve => setTimeout(resolve, 2000));
    await this.start();
  }

  async setupAutoexec(rl) {
    const autoexecManager = new AutoexecManager();
    await autoexecManager.setup(rl);

    console.log("\n Đang quay lại menu chính...");
    await new Promise(resolve => setTimeout(resolve, 2000));
    await this.start();
  }

  async configurePackagePrefix(rl) {
    console.clear();
    console.log(UIRenderer.renderTitle());
    console.log("\n Cấu hình Prefix Package Roblox");


    const currentPrefix = Utils.loadPackagePrefixConfig();
    console.log(`\n Prefix hiện tại: ${currentPrefix}`);

    console.log("\n Chọn hành động:");
    console.log("1. ✏️ Thay đổi prefix");
    console.log("2.  Đặt lại về mặc định (com.roblox)");
    console.log("3. ⏭️ Quay lại menu chính");

    const choice = await Utils.ask(rl, "\nNhập lựa chọn (1-3): ");

    if (choice.trim() === "1") {
      console.log("\n✏️ Thay đổi prefix package Roblox");
      console.log("Ví dụ: com.roblox, con.roblx, com.robloxclone, etc.");

      let newPrefix;
      while (true) {
        newPrefix = await Utils.ask(rl, "Nhập prefix mới: ");
        if (newPrefix.trim()) {
          break;
        }
        console.log("[-] Prefix không được để trống!");
      }

      Utils.savePackagePrefixConfig(newPrefix.trim());
      console.log(`[+] Đã cập nhật prefix thành: ${newPrefix.trim()}`);

    } else if (choice.trim() === "2") {
      Utils.savePackagePrefixConfig("com.roblox");
      console.log("[+] Đã đặt lại prefix về mặc định: com.roblox");

    } else if (choice.trim() === "3") {

      console.log("\n Đang quay lại menu chính...");
      await new Promise(resolve => setTimeout(resolve, 2000));
      await this.start();
      return;
    } else {
      console.log("[-] Lựa chọn không hợp lệ!");
    }


    console.log("\n Đang quay lại menu chính...");
    await new Promise(resolve => setTimeout(resolve, 2000));
    await this.start();
  }

  async configureActivity(rl) {
    console.clear();
    console.log(UIRenderer.renderTitle());
    console.log("\n Cấu hình Activity Roblox");


    const currentActivity = Utils.loadActivityConfig();
    const currentPrefix = Utils.loadPackagePrefixConfig();

    if (currentActivity) {
      console.log(`\n Activity tùy chỉnh hiện tại: ${currentActivity}`);
      console.log(`⚠️  Đang sử dụng activity tùy chỉnh thay vì activity mặc định!`);
    } else {
      console.log(`\n Activity hiện tại: Sử dụng activity mặc định (${currentPrefix}.client.ActivityProtocolLaunch)`);
    }

    console.log("\n Chọn hành động:");
    console.log("1. ✏️ Thay đổi activity");
    console.log("2.  Đặt lại về activity mặc định");
    console.log("3. ⏭️ Quay lại menu chính");

    const choice = await Utils.ask(rl, "\nNhập lựa chọn (1-3): ");

    if (choice.trim() === "1") {
      console.log("\n✏️ Thay đổi activity Roblox");
      console.log(`Ví dụ: ${currentPrefix}.client.ActivityProtocolLaunch`);
      console.log(`        ${currentPrefix}.client.vnggames.ActivityProtocolLaunch`);
      console.log(`        com.roblox.client.ActivityProtocolLaunch`);
      console.log("\n⚠️  Lưu ý: Activity phải khớp với package name để hoạt động đúng!");

      let newActivity;
      while (true) {
        newActivity = await Utils.ask(rl, "Nhập activity mới: ");
        if (newActivity.trim()) {
          break;
        }
        console.log("[-] Activity không được để trống!");
      }

      Utils.saveActivityConfig(newActivity.trim());
      console.log(`[+] Đã cập nhật activity thành: ${newActivity.trim()}`);
      console.log(`⚠️  Activity tùy chỉnh sẽ được sử dụng cho tất cả packages!`);

    } else if (choice.trim() === "2") {
      if (currentActivity) {
        Utils.saveActivityConfig(null);
        console.log("[+] Đã đặt lại về activity mặc định!");
        console.log(` Activity mặc định: ${currentPrefix}.client.ActivityProtocolLaunch`);
      } else {
        console.log("ℹ️ Đã đang sử dụng activity mặc định!");
      }

    } else if (choice.trim() === "3") {

      console.log("\n Đang quay lại menu chính...");
      await new Promise(resolve => setTimeout(resolve, 2000));
      await this.start();
      return;
    } else {
      console.log("[-] Lựa chọn không hợp lệ!");
    }


    console.log("\n Đang quay lại menu chính...");
    await new Promise(resolve => setTimeout(resolve, 2000));
    await this.start();
  }



  async startAutoRejoin(rl) {
    const configs = Utils.loadMultiConfigs();

    if (Object.keys(configs).length === 0) {
      console.log("[-] Chưa có config nào! Vui lòng chạy setup packages trước.");
      await new Promise(resolve => setTimeout(resolve, 2000));
      await this.start();
      return;
    }


    console.log("\n Kiểm tra toàn vẹn hệ thống...");
    const isValid = Utils.validatePackageIntegrity(configs);

    if (!isValid) {
      console.log("\n Quay lại menu chính sau 5 giây...");
      await new Promise(resolve => setTimeout(resolve, 5000));
      await this.start();
      return;
    }



    console.log("\n Danh sách packages đã cấu hình:");
    console.log(UIRenderer.displayConfiguredPackages(configs));

    console.log("\n Chọn packages để chạy:");
    console.log("0.  Chạy tất cả packages");

    let index = 1;
    const packageList = [];
    for (const [packageName, config] of Object.entries(configs)) {
      let packageDisplay;
      const prefix = Utils.loadPackagePrefixConfig();
      if (packageName === `${prefix}.client`) {
        packageDisplay = 'Global ';
      } else if (packageName === `${prefix}.client.vnggames`) {
        packageDisplay = 'VNG ';
      } else {
        packageDisplay = packageName;
      }


      const maskedUsername = Utils.maskSensitiveInfo(config.username);

      console.log(`${index}. ${packageDisplay} (${maskedUsername})`);
      packageList.push(packageName);
      index++;
    }

    const choice = await Utils.ask(rl, "\nNhập lựa chọn (0 để chạy tất cả, hoặc số cách nhau bởi khoảng trắng): ");
    let selectedPackages = [];

    if (choice.trim() === "0") {
      selectedPackages = Object.keys(configs);
      console.log(" Sẽ chạy tất cả packages!");
    } else {
      const indices = choice
        .trim()
        .split(/\s+/)
        .map(str => parseInt(str) - 1)
        .filter(i => i >= 0 && i < packageList.length);

      if (indices.length === 0) {
        console.log("[-] Lựa chọn không hợp lệ!");
        await new Promise(resolve => setTimeout(resolve, 1000));
        await this.startAutoRejoin(rl);
        return;
      }

      selectedPackages = indices.map(i => packageList[i]);
      console.log(` Sẽ chạy các packages:`);
      selectedPackages.forEach((pkg, i) => {
        console.log(`  - ${i + 1}. ${pkg}`);
      });
    }

    console.log("\n Khởi tạo multi-instance rejoin...");
    await this.initializeSelectedInstances(selectedPackages, configs);
  }

  async initializeSelectedInstances(selectedPackages, configs) {

    for (const packageName of selectedPackages) {
      const config = configs[packageName];
      const cookie = Utils.getRobloxCookie(packageName);

      if (!cookie) {
        console.log(`[-] Không lấy được cookie cho ${packageName}, bỏ qua...`);
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
        presenceType: "Unknown"
      });
    }

    if (this.instances.length === 0) {
      console.log("[-] Không có instance nào khả dụng!");
      return;
    }

    console.log(`[+] Đã khởi tạo ${this.instances.length} instances!`);
    console.log(" Bắt đầu auto rejoin trong 3 giây...");
    await new Promise(resolve => setTimeout(resolve, 3000));

    this.isRunning = true;
    await this.runMultiInstanceLoop();
  }

  async runMultiInstanceLoop() {
    let renderCounter = 0;
    let webhookCounter = 0;
    const webhookManager = new WebhookManager();
    const webhookConfig = Utils.loadWebhookConfig();

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
        await webhookManager.sendStatusWebhook(this.instances, this.startTime);
      }

      if (renderCounter % 5 === 0) {
        console.clear();
        try {
          console.log(UIRenderer.renderTitle());
        } catch (e) {
          console.log(`
╔══════════════════════════════════════╗
║           RYOMOLOCHITON REJOIN           ║
║    Bản quyền thuộc về The ryomolochiton  ║
╚══════════════════════════════════════╝`);
        }

        console.log(UIRenderer.renderMultiInstanceTable(this.instances, this.startTime));

        if (this.instances.length > 0) {
          console.log("\n Debug (Instance 1):");
          console.log(`Package: ${this.instances[0].packageName}`);
          console.log(`Last Check: ${new Date(this.instances[0].lastCheck).toLocaleTimeString()}`);
        }


        if (webhookConfig) {
          const urlParts = webhookConfig.url.split('/');
          const webhookId = urlParts[urlParts.length - 2] || 'unknown';
          const statusText = webhookConfig.enabled ? '[+] Đã bật' : '[-] Đã tắt';
          console.log(`\n Webhook Status: ID ${webhookId} - ${statusText} - [ĐÃ ẨN VÌ LÝ DO BẢO MẬT]`);
          if (webhookConfig.enabled) {
            const nextWebhookIn = (webhookConfig.intervalMinutes * 60) - (webhookCounter % (webhookConfig.intervalMinutes * 60));
            const minutes = Math.floor(nextWebhookIn / 60);
            const seconds = nextWebhookIn % 60;
            console.log(` Webhook: ${minutes}m ${seconds}s nữa sẽ gửi báo cáo (${webhookConfig.intervalMinutes} phút/lần)`);
          } else {
            console.log(` Webhook: Đã tắt - không gửi báo cáo tự động`);
          }
        }

        console.log("\n Nhấn Ctrl+C để dừng chương trình");
      }

      renderCounter++;
      webhookCounter++;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

}

class WebhookManager {
  constructor() {
    this.webhookConfig = Utils.loadWebhookConfig();
  }

  async setupWebhook(rl) {
    console.clear();
    console.log(UIRenderer.renderTitle());
    console.log("\n Cấu hình Webhook Discord");
    console.log("=".repeat(50));

    if (this.webhookConfig) {
      console.log(`\n Cấu hình hiện tại:`);
      const urlParts = this.webhookConfig.url.split('/');
      const webhookId = urlParts[urlParts.length - 2] || 'unknown';
      console.log(` Webhook ID: ${webhookId}`);
      console.log(` URL: [ĐÃ ẨN VÌ LÝ DO BẢO MẬT]`);
      console.log(`⏱️ Thời gian gửi: ${this.webhookConfig.intervalMinutes} phút`);
      console.log(` Trạng thái: ${this.webhookConfig.enabled ? '[+] Đã bật' : '[-] Đã tắt'}`);

      console.log("\n Chọn hành động:");
      console.log("1. ✏️ Chỉnh sửa webhook");
      console.log("2.  Bật/Tắt webhook");
      console.log("3. [-] Xóa webhook");
      console.log("4. ⏭️ Quay lại menu chính");

      const choice = await Utils.ask(rl, "\nNhập lựa chọn (1-4): ");

      if (choice.trim() === "1") {
        await this.editWebhook(rl);
      } else if (choice.trim() === "2") {
        await this.toggleWebhook(rl);
      } else if (choice.trim() === "3") {
        await this.deleteWebhook(rl);
      } else {
        return;
      }
    } else {
      console.log("\n Chưa có cấu hình webhook!");
      console.log("\n Chọn hành động:");
      console.log("1.  Tạo webhook mới");
      console.log("2. ⏭️ Quay lại menu chính");

      const choice = await Utils.ask(rl, "\nNhập lựa chọn (1-2): ");

      if (choice.trim() === "1") {
        await this.createWebhook(rl);
      } else {
        return;
      }
    }
  }

  async createWebhook(rl) {
    console.log("\n Tạo cấu hình webhook mới:");

    let webhookUrl;
    while (true) {
      webhookUrl = await Utils.ask(rl, " Nhập URL webhook Discord: ");
      if (webhookUrl.trim() && webhookUrl.includes('discord.com/api/webhooks/')) {
        break;
      }
      console.log("[-] URL webhook không hợp lệ! Vui lòng nhập lại.");
    }

    let intervalMinutes;
    while (true) {
      const input = await Utils.ask(rl, "⏱️ Thời gian gửi webhook (5-180 phút): ");
      intervalMinutes = parseInt(input);
      if (intervalMinutes >= 5 && intervalMinutes <= 180) {
        break;
      }
      console.log("[-] Thời gian phải từ 5-180 phút! Vui lòng nhập lại.");
    }

    this.webhookConfig = {
      url: webhookUrl.trim(),
      intervalMinutes: intervalMinutes,
      enabled: true
    };

    Utils.saveWebhookConfig(this.webhookConfig);
    console.log("[+] Đã lưu cấu hình webhook!");
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  async editWebhook(rl) {
    console.log("\n✏️ Chỉnh sửa webhook:");

    let webhookUrl;
    while (true) {
      const urlParts = this.webhookConfig.url.split('/');
      const webhookId = urlParts[urlParts.length - 2] || 'unknown';
      webhookUrl = await Utils.ask(rl, ` Webhook ID hiện tại: ${webhookId}\n URL: [ĐÃ ẨN VÌ LÝ DO BẢO MẬT]\nNhập URL mới (Enter để giữ nguyên): `);
      if (!webhookUrl.trim()) {
        webhookUrl = this.webhookConfig.url;
        break;
      }
      if (webhookUrl.includes('discord.com/api/webhooks/')) {
        break;
      }
      console.log("[-] URL webhook không hợp lệ! Vui lòng nhập lại.");
    }

    let intervalMinutes;
    while (true) {
      const input = await Utils.ask(rl, `⏱️ Thời gian hiện tại: ${this.webhookConfig.intervalMinutes} phút\nNhập thời gian mới (5-180 phút, Enter để giữ nguyên): `);
      if (!input.trim()) {
        intervalMinutes = this.webhookConfig.intervalMinutes;
        break;
      }
      intervalMinutes = parseInt(input);
      if (intervalMinutes >= 5 && intervalMinutes <= 180) {
        break;
      }
      console.log("[-] Thời gian phải từ 5-180 phút! Vui lòng nhập lại.");
    }

    this.webhookConfig = {
      url: webhookUrl.trim(),
      intervalMinutes: intervalMinutes,
      enabled: this.webhookConfig.enabled
    };

    Utils.saveWebhookConfig(this.webhookConfig);
    console.log("[+] Đã cập nhật cấu hình webhook!");
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  async toggleWebhook(rl) {
    console.log("\n Bật/Tắt webhook:");
    const urlParts = this.webhookConfig.url.split('/');
    const webhookId = urlParts[urlParts.length - 2] || 'unknown';
    console.log(` Webhook ID: ${webhookId}`);
    console.log(` URL: [ĐÃ ẨN VÌ LÝ DO BẢO MẬT]`);
    console.log(`⏱️ Thời gian gửi: ${this.webhookConfig.intervalMinutes} phút`);
    console.log(` Trạng thái hiện tại: ${this.webhookConfig.enabled ? '[+] Đã bật' : '[-] Đã tắt'}`);

    const newStatus = !this.webhookConfig.enabled;
    const statusText = newStatus ? 'bật' : 'tắt';

    const confirm = await Utils.ask(rl, `\n⚠️ Bạn có muốn ${statusText} webhook? (y/N): `);

    if (confirm.toLowerCase() === 'y' || confirm.toLowerCase() === 'yes') {
      this.webhookConfig.enabled = newStatus;
      Utils.saveWebhookConfig(this.webhookConfig);
      console.log(`[+] Đã ${statusText} webhook!`);
      if (newStatus) {
        console.log(" Webhook sẽ gửi báo cáo tự động.");
      } else {
        console.log(" Webhook sẽ không gửi báo cáo tự động.");
      }
      await new Promise(resolve => setTimeout(resolve, 3000));
    } else {
      console.log("[-] Đã hủy thay đổi trạng thái webhook.");
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  async deleteWebhook(rl) {
    console.log("\n[-] Xóa cấu hình webhook:");
    const urlParts = this.webhookConfig.url.split('/');
    const webhookId = urlParts[urlParts.length - 2] || 'unknown';
    console.log(` Webhook ID: ${webhookId}`);
    console.log(` URL: [ĐÃ ẨN VÌ LÝ DO BẢO MẬT]`);
    console.log(`⏱️ Thời gian gửi: ${this.webhookConfig.intervalMinutes} phút`);

    const confirm = await Utils.ask(rl, "\n⚠️ Bạn có chắc chắn muốn xóa webhook? (y/N): ");

    if (confirm.toLowerCase() === 'y' || confirm.toLowerCase() === 'yes') {
      Utils.saveWebhookConfig(null);
      this.webhookConfig = null;
      console.log("[+] Đã xóa cấu hình webhook!");
      console.log(" Webhook sẽ không còn gửi báo cáo tự động.");
      await new Promise(resolve => setTimeout(resolve, 3000));
    } else {
      console.log("[-] Đã hủy xóa webhook.");
      await new Promise(resolve => setTimeout(resolve, 2000));
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
        let packageDisplay;
        const prefix = Utils.loadPackagePrefixConfig();
        if (instance.packageName === `${prefix}.client`) {
          packageDisplay = 'Global ';
        } else if (instance.packageName === `${prefix}.client.vnggames`) {
          packageDisplay = 'VNG ';
        } else {
          packageDisplay = instance.packageName;
        }
        return `${packageDisplay}: ${instance.status}`;
      }).join('\n');

      const embed = {
        title: "🖥️ RYOMOLOCHITON REJOIN Status Report",
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
          text: "Dawn Rejoin Tool - The Real Dawn"
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
        console.log("[-] Chưa có config nào! Vui lòng chạy setup packages trước.");
        await new Promise(resolve => setTimeout(resolve, 2000));
        return false;
      }

      console.log("\n Danh sách config hiện tại:");
      console.log(this.renderConfigTable());

      console.log("\n Chọn config để chỉnh sửa:");
      console.log("0. ✏️ Sửa tất cả config");

      let index = 1;
      const configList = [];
      for (const [packageName, config] of Object.entries(this.configs)) {
        try {
          let packageDisplay;
          const prefix = Utils.loadPackagePrefixConfig();
          if (packageName === `${prefix}.client`) {
            packageDisplay = 'Global ';
          } else if (packageName === `${prefix}.client.vnggames`) {
            packageDisplay = 'VNG ';
          } else {
            packageDisplay = packageName;
          }


          const maskedUsername = Utils.maskSensitiveInfo(config.username);


          const maskedUserId = Utils.maskSensitiveInfo(config.userId);

          console.log(`${index}. ${packageDisplay} (${maskedUsername}) - Game: ${config.gameName || 'Unknown'}`);
          configList.push({ packageName, config });
          index++;
        } catch (error) {
          console.log(`⚠️ Lỗi khi xử lý config ${packageName}: ${error.message}`);
          continue;
        }
      }

      if (configList.length === 0) {
        console.log("[-] Không có config hợp lệ nào!");
        await new Promise(resolve => setTimeout(resolve, 2000));
        return false;
      }

      const choice = await Utils.ask(rl, "\nNhập lựa chọn (0 để sửa tất cả, hoặc số cách nhau bởi khoảng trắng): ");
      let selectedConfigs = [];

      if (choice.trim() === "0") {
        selectedConfigs = configList;
        console.log("✏️ Sẽ sửa tất cả config!");
      } else {
        try {
          const indices = choice
            .trim()
            .split(/\s+/)
            .map(str => parseInt(str) - 1)
            .filter(i => i >= 0 && i < configList.length);

          if (indices.length === 0) {
            console.log("[-] Lựa chọn không hợp lệ!");
            await new Promise(resolve => setTimeout(resolve, 1000));
            return await this.startEdit(rl);
          }

          selectedConfigs = indices.map(i => configList[i]);
          console.log(`✏️ Sẽ sửa các config:`);
          selectedConfigs.forEach((cfg, i) => {
            try {
              const maskedUsername = Utils.maskSensitiveInfo(cfg.config.username);
              console.log(`  - ${i + 1}. ${cfg.packageName} (${maskedUsername})`);
            } catch (error) {
              console.log(`  - ${i + 1}. ${cfg.packageName} (Lỗi hiển thị)`);
            }
          });
        } catch (error) {
          console.log(`[-] Lỗi khi xử lý lựa chọn: ${error.message}`);
          await new Promise(resolve => setTimeout(resolve, 1000));
          return await this.startEdit(rl);
        }
      }


      for (const { packageName, config } of selectedConfigs) {
        try {
          console.clear();
          console.log(UIRenderer.renderTitle());
          console.log(`\n✏️ Chỉnh sửa config cho ${packageName}`);

          let packageDisplay;
          const prefix = Utils.loadPackagePrefixConfig();
          if (packageName === `${prefix}.client`) {
            packageDisplay = 'Global ';
          } else if (packageName === `${prefix}.client.vnggames`) {
            packageDisplay = 'VNG ';
          } else {
            packageDisplay = packageName;
          }

          console.log(` Package: ${packageDisplay}`);
          console.log(` Username: ${Utils.maskSensitiveInfo(config.username)}`);
          console.log(` User ID: ${Utils.maskSensitiveInfo(config.userId)}`);
          console.log(` Game: ${config.gameName || 'Unknown'} (${config.placeId || 'Unknown'})`);
          console.log(`⏱️ Delay: ${config.delaySec || 'Unknown'}s`);
          if (config.linkCode) {
            console.log(` Link Code: ${config.linkCode}`);
          }

          console.log("\n Chọn thông tin để chỉnh sửa:");
          console.log("1.  Thay đổi game");
          console.log("2. ⏱️ Thay đổi delay");
          console.log("3.  Thay đổi link code");
          console.log("4. [-] Xóa config này");
          console.log("5. ⏭️ Bỏ qua (giữ nguyên)");

          const editChoice = await Utils.ask(rl, "\nChọn option (1-5): ");

          try {
            switch (editChoice.trim()) {
              case "1":
                const selector = new GameSelector();
                const game = await selector.chooseGame(rl);
                config.placeId = game.placeId;
                config.gameName = game.name;
                config.linkCode = game.linkCode;
                console.log(`[+] Đã cập nhật game thành ${game.name}!`);
                break;

              case "2":
                let newDelay;
                while (true) {
                  try {
                    const input = await Utils.ask(rl, "⏱️ Delay check mới (giây, 15-120): ");
                    const delayValue = parseInt(input) || 0;
                    if (delayValue >= 15 && delayValue <= 120) {
                      newDelay = delayValue;
                      break;
                    }
                    console.log("[-] Giá trị không hợp lệ! Vui lòng nhập lại.");
                  } catch (error) {
                    console.log("[-] Lỗi khi nhập delay, vui lòng thử lại.");
                  }
                }
                config.delaySec = newDelay;
                console.log(`[+] Đã cập nhật delay thành ${newDelay}s!`);
                break;

              case "3":
                console.log("\n Dán link redirect sau khi vào private server.");
                console.log("VD: https://www.roblox.com/games/2753915549/Blox-Fruits?privateServerLinkCode=77455530946706396026289495938493");
                while (true) {
                  try {
                    const link = await Utils.ask(rl, "\nDán link redirect đã chuyển hướng: ");
                    const m = link.match(/\/games\/(\d+)[^?]*\?[^=]*=([\w-]+)/);
                    if (!m) {
                      console.log(`[-] Link không hợp lệ!`);
                      continue;
                    }
                    config.placeId = m[1];
                    config.gameName = "Private Server ";
                    config.linkCode = m[2];
                    console.log(`[+] Đã cập nhật link code!`);
                    break;
                  } catch (error) {
                    console.log(`[-] Lỗi khi xử lý link: ${error.message}`);
                  }
                }
                break;

              case "4":
                delete this.configs[packageName];
                console.log(`[+] Đã xóa config cho ${packageDisplay}!`);
                break;

              case "5":
                console.log(`⏭️ Giữ nguyên config cho ${packageDisplay}`);
                break;

              default:
                console.log("[-] Lựa chọn không hợp lệ!");
                break;
            }
          } catch (error) {
            console.log(`[-] Lỗi khi chỉnh sửa config: ${error.message}`);
          }
        } catch (error) {
          console.log(`[-] Lỗi khi xử lý config ${packageName}: ${error.message}`);
          continue;
        }
      }


      try {
        Utils.saveMultiConfigs(this.configs);
        console.log("\n[+] Hoàn tất chỉnh sửa config!");
      } catch (error) {
        console.log(`[-] Lỗi khi lưu config: ${error.message}`);
      }

      return true;
    } catch (error) {
      console.log(`[-] Lỗi nghiêm trọng trong ConfigEditor: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      return false;
    }
  }

  renderConfigTable() {
    try {
      const table = new Table({
        head: ["STT", "Package", "Username", "Delay", "Game ID", "Game Name", "Server VIP Link"],
        colWidths: [5, 20, 15, 8, 15, 20, 15],
        style: {
          head: ["cyan"],
          border: ["gray"]
        }
      });

      let index = 1;
      for (const [packageName, config] of Object.entries(this.configs)) {
        try {
          let packageDisplay;
          const prefix = Utils.loadPackagePrefixConfig();
          if (packageName === `${prefix}.client`) {
            packageDisplay = 'Global ';
          } else if (packageName === `${prefix}.client.vnggames`) {
            packageDisplay = 'VNG ';
          } else {
            packageDisplay = packageName;
          }


          const maskedUsername = Utils.maskSensitiveInfo(config.username);


          const delayDisplay = `${config.delaySec || 'Unknown'}s`;


          const serverLink = config.linkCode ? `Có ` : `Không [-]`;

          table.push([
            index.toString(),
            packageDisplay,
            maskedUsername,
            delayDisplay,
            config.placeId || 'Unknown',
            config.gameName || 'Unknown',
            serverLink
          ]);
          index++;
        } catch (error) {
          console.log(`⚠️ Lỗi khi xử lý config ${packageName}: ${error.message}`);

          table.push([
            index.toString(),
            packageName,
            'Error',
            'Error',
            'Error',
            'Error',
            'Error'
          ]);
          index++;
        }
      }

      return table.toString();
    } catch (error) {
      console.log(`[-] Lỗi khi tạo bảng config: ${error.message}`);
      return "[-] Không thể hiển thị bảng config";
    }
  }
}


process.on('SIGINT', () => {
  console.log('\n\n Đang dừng chương trình...');
  console.log(' Cảm ơn bạn đã sử dụng RYOMOLOCHITON REJOIN!');
  process.exit(0);
});


(async () => {
  const tool = new MultiRejoinTool();
  await tool.start();
})();
