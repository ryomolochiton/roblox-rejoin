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
const LAUNCH_ACTIVITY_CACHE_PATH = cfgPath("launch_activity_cache.json");

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
  // Bọc chuỗi an toàn cho shell (single-quote escaping)
  static shq(s) {
    return "'" + String(s).replace(/'/g, `'\\''`) + "'";
  }

  // Termux PREFIX
  static termuxPrefix() {
    return process.env.PREFIX || "/data/data/com.termux/files/usr";
  }

  /**
   * Tìm binary `node` THẬT.
   *
   * Lưu ý quan trọng trên Termux/Android:
   * process.execPath có thể trả về "/apex/com.android.runtime/bin/linker64"
   * (khi node được nạp qua dynamic linker). Nếu dùng thẳng giá trị đó làm
   * lệnh chạy thì linker64 sẽ nhận rejoin.cjs làm ELF và báo:
   *   "has bad ELF magic: 23212f75"   (23 21 2f 75 == "#!/u")
   * -> Phải chạy: linker64 <node> <script.cjs>, KHÔNG BAO GIỜ là linker64 <script.cjs>
   */
  static resolveNodeBinary() {
    const prefix = Utils.termuxPrefix();
    const exec = process.execPath || "";
    const isLinker = /(^|\/)linker(64)?$/.test(exec);

    const candidates = [];
    if (exec && !isLinker) candidates.push(exec);
    candidates.push(path.join(prefix, "bin", "node"));
    candidates.push("/data/data/com.termux/files/usr/bin/node");
    candidates.push("/usr/bin/node", "/usr/local/bin/node");

    for (const c of candidates) {
      try {
        if (c && fs.existsSync(c) && fs.statSync(c).isFile()) return c;
      } catch { }
    }

    try {
      const found = execSync("command -v node", { encoding: "utf8" }).trim();
      if (found) return found;
    } catch { }

    return exec || "node";
  }

  static ensureRoot() {
    let uid = "";
    try {
      uid = execSync("id -u", { encoding: "utf8" }).trim();
    } catch (e) {
      console.warn(`[!] Không xác định được uid: ${e.message}`);
      return;
    }

    if (uid === "0") return;

    // Chống lặp vô hạn: nếu đã thử su 1 lần mà vẫn không phải root thì dừng
    if (process.env.DAWN_REJOIN_SU === "1") {
      console.error("[-] Đã thử chuyển sang root nhưng vẫn không có quyền root.");
      console.error("[-] Vui lòng cấp quyền root cho Termux rồi chạy lại.");
      process.exit(1);
    }

    const q = Utils.shq;
    const prefix = Utils.termuxPrefix();
    const home = process.env.HOME || "/data/data/com.termux/files/home";
    const node = Utils.resolveNodeBinary();
    const script = __filename;
    const args = process.argv.slice(2);

    // Shell của `su` không kế thừa env Termux -> phải export lại,
    // nếu không node sẽ chết vì thiếu LD_LIBRARY_PATH / PREFIX / TMPDIR.
    const inner = [
      `export PREFIX=${q(prefix)}`,
      `export HOME=${q(home)}`,
      `export TMPDIR=${q(path.join(prefix, "tmp"))}`,
      `export LD_LIBRARY_PATH=${q(path.join(prefix, "lib"))}`,
      `export PATH=${q(path.join(prefix, "bin"))}:$PATH`,
      `export DAWN_REJOIN_SU=1`,
      `cd ${q(path.dirname(script))}`,
      `exec ${q(node)} ${q(script)}${args.length ? " " + args.map(q).join(" ") : ""}`
    ].join("; ");

    console.log("Cần quyền root, chuyển qua su...");
    try {
      execSync(`su -c ${q(inner)}`, {
        stdio: "inherit",
        env: { ...process.env, DAWN_REJOIN_SU: "1" }
      });
      process.exit(0);
    } catch (e) {
      console.error(`[-] Không thể chạy với quyền root: ${e.message}`);
      console.error(`[-] node binary dùng để chạy: ${node}`);
      console.error("[-] Kiểm tra lại quyền su cho Termux (Magisk/KernelSU): thử `su -c id`.");
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




  /**
   * Env sạch để gọi binary Android (am / pm / monkey / am force-stop).
   * Termux export LD_PRELOAD + LD_LIBRARY_PATH trỏ vào $PREFIX/lib, khiến
   * app_process (mà `am` gọi) không link được -> `am start` chết âm thầm,
   * bot tưởng đã rejoin nhưng thực tế app không hề mở.
   */
  static androidEnv() {
    const env = { ...process.env };
    delete env.LD_PRELOAD;
    delete env.LD_LIBRARY_PATH;
    env.PATH = `/system/bin:/system/xbin:${env.PATH || ""}`;
    return env;
  }

  // Nhận diện output lỗi của `am start` (am trả exit code 0 cả khi lỗi)
  static _amFailed(out) {
    const s = String(out || "");
    return /Error:|Exception|Permission Denial|does not exist|not found|Activity class .* does not exist/i.test(s);
  }

  /** Đóng hẳn app trước khi mở lại (dùng khi app treo / rejoin nhiều lần không lên) */
  static forceStop(packageName) {
    const cmds = [
      `/system/bin/am force-stop ${packageName}`,
      `su -c 'unset LD_PRELOAD LD_LIBRARY_PATH; /system/bin/am force-stop ${packageName}'`
    ];
    for (const c of cmds) {
      try {
        execSync(c, { stdio: "pipe", env: Utils.androidEnv(), timeout: 15000 });
        console.log(`[*] [${packageName}] Đã force-stop app.`);
        return true;
      } catch { }
    }
    return false;
  }

  /** Chạy 1 lệnh shell, trả về {ok, out}. Không ném exception. */
  static _run(cmd, timeout = 15000) {
    try {
      const out = execSync(cmd, {
        stdio: "pipe",
        encoding: "utf8",
        env: Utils.androidEnv(),
        timeout
      });
      return { ok: true, out: String(out || "") };
    } catch (e) {
      const out = ((e.stdout || "") + "\n" + (e.stderr || "") + "\n" + (e.message || "")).toString();
      return { ok: false, out };
    }
  }

  /** App có đang chạy không (pidof / ps). */
  static isAppRunning(packageName) {
    const probes = [
      `/system/bin/pidof ${packageName}`,
      `pidof ${packageName}`,
      `su -c ${Utils.shq(`unset LD_PRELOAD LD_LIBRARY_PATH; /system/bin/pidof ${packageName}`)}`,
      `/system/bin/ps -A -o NAME | grep -x ${Utils.shq(packageName)}`
    ];
    for (const p of probes) {
      const r = Utils._run(p, 8000);
      if (r.ok && r.out.trim()) return true;
    }
    return false;
  }

  static _loadActivityCache() {
    try {
      if (fs.existsSync(LAUNCH_ACTIVITY_CACHE_PATH)) {
        return JSON.parse(fs.readFileSync(LAUNCH_ACTIVITY_CACHE_PATH, "utf8")) || {};
      }
    } catch (_) { }
    return {};
  }

  static _saveActivityCache(packageName, activity) {
    try {
      const cache = Utils._loadActivityCache();
      cache[packageName] = activity;
      fs.writeFileSync(LAUNCH_ACTIVITY_CACHE_PATH, JSON.stringify(cache, null, 2));
    } catch (e) {
      console.warn(`[!] Không lưu được activity cache: ${e.message}`);
    }
  }

  /**
   * Dò activity thật sự dùng để mở deep-link roblox://.
   * Trước đây code ghép cứng `${prefix}.client.ActivityProtocolLaunch` — với app
   * mod (đổi tên package/hệ activity) activity này KHÔNG tồn tại, `am start`
   * luôn báo "Activity class does not exist" -> bot không bao giờ join được.
   *
   * @returns {string[]} danh sách activity ứng viên, xếp theo độ tin cậy giảm dần.
   */
  static resolveLaunchActivities(packageName) {
    const found = new Map(); // activity -> score
    const add = (act, score) => {
      if (!act) return;
      let a = String(act).trim();
      if (!a) return;
      // chuẩn hoá "pkg/.Foo" -> "pkg.Foo"
      if (a.includes("/")) {
        const [p, c] = a.split("/");
        a = c.startsWith(".") ? `${p}${c}` : c;
      } else if (a.startsWith(".")) {
        a = `${packageName}${a}`;
      }
      if (!a.includes(".")) return;
      const prev = found.get(a) || 0;
      if (score > prev) found.set(a, score);
    };

    const scoreOf = (act) => {
      const l = act.toLowerCase();
      if (l.includes("protocollaunch")) return 100;
      if (l.includes("protocol")) return 90;
      if (l.includes("deeplink") || l.includes("deep_link")) return 80;
      if (l.includes("launch")) return 70;
      if (l.includes("splash")) return 60;
      if (l.includes("main")) return 50;
      return 30;
    };

    // 1) Activity đã cache (lần trước chạy được)
    const cached = Utils._loadActivityCache()[packageName];
    if (cached) add(cached, 1000);

    // 2) Activity user cấu hình tay
    const custom = Utils.loadActivityConfig();
    if (custom) add(custom, 900);

    // 3) resolve-activity cho scheme roblox://
    const resolvers = [
      `/system/bin/cmd package resolve-activity --brief -a android.intent.action.VIEW -d "roblox://placeID=1" ${packageName}`,
      `su -c ${Utils.shq(`unset LD_PRELOAD LD_LIBRARY_PATH; /system/bin/cmd package resolve-activity --brief -a android.intent.action.VIEW -d 'roblox://placeID=1' ${packageName}`)}`,
      `/system/bin/cmd package resolve-activity --brief ${packageName}`
    ];
    for (const cmd of resolvers) {
      const r = Utils._run(cmd, 12000);
      if (!r.ok) continue;
      for (const line of r.out.split("\n")) {
        const t = line.trim();
        if (t.includes("/") && t.startsWith(packageName)) add(t, 850);
      }
    }

    // 4) query-activities: liệt kê mọi activity nhận scheme roblox://
    const queries = [
      `/system/bin/cmd package query-activities -a android.intent.action.VIEW -d "roblox://placeID=1"`,
      `su -c ${Utils.shq(`unset LD_PRELOAD LD_LIBRARY_PATH; /system/bin/cmd package query-activities -a android.intent.action.VIEW -d 'roblox://placeID=1'`)}`
    ];
    for (const cmd of queries) {
      const r = Utils._run(cmd, 15000);
      if (!r.ok) continue;
      const re = new RegExp(`${packageName.replace(/\./g, "\\.")}/[\\w.$]+`, "g");
      const m = r.out.match(re);
      if (m) for (const x of m) add(x, 800);
    }

    // 5) dumpsys package: quét activity có trong manifest
    const dumps = [
      `/system/bin/dumpsys package ${packageName}`,
      `su -c ${Utils.shq(`unset LD_PRELOAD LD_LIBRARY_PATH; /system/bin/dumpsys package ${packageName}`)}`
    ];
    for (const cmd of dumps) {
      const r = Utils._run(cmd, 20000);
      if (!r.ok || !r.out.trim()) continue;
      const re = new RegExp(`${packageName.replace(/\./g, "\\.")}/[\\w.$]+`, "g");
      const m = r.out.match(re);
      if (m) for (const x of new Set(m)) {
        const cls = x.split("/")[1] || "";
        add(x, scoreOf(cls));
      }
      break;
    }

    // 6) Fallback theo prefix (giữ hành vi cũ làm phương án cuối)
    const prefix = Utils.loadPackagePrefixConfig();
    add(`${prefix}.client.ActivityProtocolLaunch`, 20);
    add(`${packageName}.ActivityProtocolLaunch`, 15);
    add(`${packageName}.client.ActivityProtocolLaunch`, 10);

    return [...found.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([act]) => act)
      .slice(0, 8);
  }

  /**
   * App đang TẮT HẲN: bắn thẳng deep-link thường thất bại vì process chưa dựng.
   * Mở app bằng intent LAUNCHER (hoặc monkey) trước, chờ process lên rồi mới join.
   * @returns {Promise<boolean>} true nếu process đã chạy.
   */
  static async coldStart(packageName, maxWaitMs = 12000) {
    console.log(`[*] [${packageName}] App đang tắt -> cold start trước khi join.`);
    const q = Utils.shq;
    const starters = [
      `/system/bin/monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`,
      `/system/bin/cmd package resolve-activity --brief ${packageName}`, // no-op an toàn
      `/system/bin/am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p ${packageName}`,
      `su -c ${q(`unset LD_PRELOAD LD_LIBRARY_PATH; /system/bin/monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`)}`,
      `su -c ${q(`unset LD_PRELOAD LD_LIBRARY_PATH; /system/bin/am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p ${packageName}`)}`
    ];

    for (const cmd of starters) {
      if (cmd.includes("resolve-activity")) continue;
      const r = Utils._run(cmd, 20000);
      if (r.ok && !Utils._amFailed(r.out)) break;
    }

    // chờ process dựng lên, poll mỗi giây
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      if (Utils.isAppRunning(packageName)) {
        const left = Math.max(0, deadline - Date.now());
        console.log(`[+] [${packageName}] App đã lên (còn dư ${Math.round(left / 1000)}s), chờ 3s cho ổn định.`);
        await new Promise((r) => setTimeout(r, 3000));
        return true;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.warn(`[!] [${packageName}] Chờ ${Math.round(maxWaitMs / 1000)}s mà app vẫn chưa lên, vẫn thử bắn deep-link.`);
    return false;
  }

  /**
   * Mở Roblox vào đúng place.
   * @returns {Promise<boolean>} true nếu lệnh mở app thực sự thành công.
   *   QUAN TRỌNG: trước đây hàm này luôn "coi như xong" kể cả khi am lỗi,
   *   nên StatusHandler bật cooldown dài -> không rejoin nữa.
   */
  static async launch(placeId, linkCode = null, packageName) {
    const url = linkCode
      ? `roblox://placeID=${placeId}&linkCode=${linkCode}`
      : `roblox://placeID=${placeId}`;

    console.log(` [${packageName}] Đang mở: ${url}`);
    if (linkCode) console.log(` [${packageName}] Đã join bằng linkCode: ${linkCode}`);

    // App tắt hẳn -> phải cold start trước, nếu không deep-link sẽ rơi vào hư không
    if (!Utils.isAppRunning(packageName)) {
      await Utils.coldStart(packageName);
    }

    const q = Utils.shq;
    const activities = Utils.resolveLaunchActivities(packageName);
    console.log(` [${packageName}] Activity ứng viên: ${activities.slice(0, 3).join(", ")}${activities.length > 3 ? " ..." : ""}`);

    // Ưu tiên mở đích danh activity; nếu tất cả hỏng thì mở bằng URL thuần (-p)
    const attempts = [];
    for (const activity of activities) {
      const base = `am start -n ${packageName}/${activity} -a android.intent.action.VIEW -d ${q(url)} --activity-clear-top`;
      attempts.push({ activity, cmd: `/system/bin/${base}` });
      attempts.push({ activity, cmd: `su -c ${q(`unset LD_PRELOAD LD_LIBRARY_PATH; /system/bin/${base}`)}` });
    }
    attempts.push({ activity: null, cmd: `/system/bin/am start -a android.intent.action.VIEW -d ${q(url)} -p ${packageName}` });
    attempts.push({ activity: null, cmd: `su -c ${q(`unset LD_PRELOAD LD_LIBRARY_PATH; /system/bin/am start -a android.intent.action.VIEW -d ${url} -p ${packageName}`)}` });
    attempts.push({ activity: null, cmd: `/system/bin/am start -a android.intent.action.VIEW -d ${q(url)}` });

    for (const { activity, cmd } of attempts) {
      try {
        const out = execSync(cmd, {
          stdio: "pipe",
          encoding: "utf8",
          env: Utils.androidEnv(),
          timeout: 20000
        });

        // `am` hay trả exit 0 kèm "Error: ..." -> phải soi output
        if (Utils._amFailed(out)) {
          console.warn(`[!] [${packageName}] am báo lỗi${activity ? ` (${activity})` : ""}, thử cách khác: ${String(out).trim().split("\n")[0]}`);
          continue;
        }

        if (activity) {
          Utils._saveActivityCache(packageName, activity);
          console.log(`[+] [${packageName}] Launch OK qua activity: ${activity}`);
        } else {
          console.log(`[+] [${packageName}] Launch OK qua deep-link thuần.`);
        }
        return true;
      } catch (e) {
        const detail = (e.stderr || e.stdout || e.message || "").toString().trim().split("\n")[0];
        console.warn(`[!] [${packageName}] Thử launch thất bại${activity ? ` (${activity})` : ""}: ${detail}`);
      }
    }

    console.error(`[-] [${packageName}] Launch failed: không mở được app bằng mọi cách.`);
    return false;
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

  /**
   * Tên hiển thị chuẩn cho 1 package. Trước đây logic này bị lặp ở 7 chỗ khác
   * nhau trong UI, mỗi chỗ một kiểu -> sửa 1 chỗ sót 6 chỗ.
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
   * @param {string} [suffix] khoảng trắng căn lề mà UI cũ đang dùng
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

  /**
   * Quét mọi app KHAI BÁO xử lý được scheme `roblox://`.
   * Đây là cách duy nhất tìm ra app mod đã đổi tên package hoàn toàn
   * (vd: zam.hi1) — quét theo prefix sẽ không bao giờ thấy chúng.
   * @returns {string[]} danh sách package name
   */
  static scanRobloxHandlers() {
    const found = new Set();
    const SYSTEM_DENY = /^(android$|com\.android\.|com\.google\.android\.|com\.samsung\.|com\.sec\.|com\.miui\.|com\.xiaomi\.|com\.huawei\.|com\.oppo\.|com\.vivo\.|com\.termux)/;

    const cmds = [
      `/system/bin/cmd package query-activities -a android.intent.action.VIEW -d "roblox://placeID=1"`,
      `cmd package query-activities -a android.intent.action.VIEW -d "roblox://placeID=1"`,
      `su -c ${Utils.shq(`unset LD_PRELOAD LD_LIBRARY_PATH; /system/bin/cmd package query-activities -a android.intent.action.VIEW -d 'roblox://placeID=1'`)}`,
      `/system/bin/pm query-activities -a android.intent.action.VIEW -d "roblox://placeID=1"`
    ];

    for (const cmd of cmds) {
      const r = Utils._run(cmd, 20000);
      if (!r.ok || !r.out.trim()) continue;
      const m = r.out.match(/[a-zA-Z][\w]*(?:\.[\w]+)+\/[\w.$]+/g) || [];
      for (const x of m) {
        const pkg = x.split("/")[0];
        if (pkg && !SYSTEM_DENY.test(pkg)) found.add(pkg);
      }
      if (found.size) break;
    }

    return [...found];
  }

  /**
   * Suy ra prefix chung từ danh sách package.
   * VD: ["zam.hi1", "zam.hi2"]             -> "zam"
   *     ["com.roblox.client", "com.roblox.client.vnggames"] -> "com.roblox"
   *     ["vip.mod.roblox"]                 -> "vip.mod"
   */
  static derivePrefix(packages) {
    const list = (packages || []).filter(Boolean).map(String);
    if (list.length === 0) return null;

    if (list.length === 1) {
      const parts = list[0].split(".");
      if (parts.length <= 1) return list[0];
      // Bỏ segment cuối (thường là "client" / tên biến thể)
      return parts.slice(0, -1).join(".");
    }

    // Nhiều package: lấy phần segment đầu chung nhau
    const split = list.map((p) => p.split("."));
    const common = [];
    for (let i = 0; i < split[0].length; i++) {
      const seg = split[0][i];
      if (split.every((parts) => parts[i] === seg)) common.push(seg);
      else break;
    }

    if (common.length === 0) return null;
    // Nếu prefix chung ăn trọn 1 package thì lùi lại 1 segment
    if (common.length === Math.min(...split.map((s) => s.length)) && common.length > 1) {
      return common.slice(0, -1).join(".");
    }
    return common.join(".");
  }

  /** Quét handler roblox:// rồi suy ra prefix; null nếu không tìm được. */
  static autoDetectPrefix() {
    const handlers = Utils.scanRobloxHandlers();
    if (!handlers.length) return { prefix: null, packages: [] };
    return { prefix: Utils.derivePrefix(handlers), packages: handlers };
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
          packages[packageName] = {
            packageName,
            displayName: Utils.describePackage(packageName, prefix)
          };
        }
      });

      // Không package nào khớp prefix -> app mod đã đổi tên hoàn toàn.
      // Quét theo scheme roblox:// để tìm chúng thay vì bắt user tự sửa prefix.
      if (foundAny && matchedCount === 0) {
        console.log(`\x1b[33m[!] Không có package nào bắt đầu bằng "${prefix}" — đang tự dò app xử lý roblox://\x1b[0m`);

        const handlers = Utils.scanRobloxHandlers();
        if (handlers.length > 0) {
          for (const packageName of handlers) {
            packages[packageName] = {
              packageName,
              displayName: Utils.describePackage(packageName, prefix)
            };
          }
          const derived = Utils.derivePrefix(handlers);
          console.log(`[+] Tự nhận diện được ${handlers.length} app Roblox: \x1b[32m${handlers.join(', ')}\x1b[0m`);
          if (derived && derived !== prefix) {
            console.log(`[*] Prefix gợi ý: \x1b[32m${derived}\x1b[0m — vào mục "4. Chỉnh prefix package" > "3. Tự động nhận diện prefix" để lưu lại.`);
          }
        } else {
          console.log(`[!] Có vẻ bạn đang dùng Roblox mod (ví dụ: vip.xxx) nhưng không dò được qua roblox://.`);
          console.log(`[!] Vui lòng vào mục "4. Chỉnh prefix package" để đổi lại cho đúng.`);

          const samples = lines
            .filter(l => l.includes('package:'))
            .slice(0, 3)
            .map(l => l.replace('package:', '').trim());
          if (samples.length > 0) {
            console.log(`[*] Gợi ý các package tìm thấy: \x1b[32m${samples.join(', ')}\x1b[0m`);
          }
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
  /**
   * @returns {boolean} true nếu app thực sự được mở.
   * Trước đây hàm này trả về undefined -> caller không biết launch fail
   * nên vẫn bật cooldown và ngừng rejoin.
   */
  static async handleGameLaunch(shouldLaunch, placeId, linkCode, packageName, rejoinOnly = false, forceStop = false) {
    if (!shouldLaunch) return false;

    console.log(` [${packageName}] Starting launch process...`);

    // Rejoin liên tục không lên -> app nhiều khả năng đang treo, kill trước
    if (forceStop) {
      console.log(`[*] [${packageName}] Rejoin nhiều lần không vào được -> force-stop rồi mở lại.`);
      Utils.forceStop(packageName);
      await new Promise(r => setTimeout(r, 2000));
    }

    const ok = await Utils.launch(placeId, linkCode, packageName);

    console.log(ok
      ? `[+] [${packageName}] Launch process completed!`
      : `[-] [${packageName}] Launch process FAILED - sẽ thử lại vòng sau.`);

    return ok;
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
    // Gọi endpoint chính thức trước (kèm cookie để lấy đủ placeId),
    // nếu lỗi mạng/chặn thì fallback sang roproxy (KHÔNG gửi cookie sang proxy bên thứ 3)
    const body = { userIds: [Number(this.userId) || this.userId] };
    let lastErr = null;

    try {
      const r = await axios.post(
        "https://presence.roblox.com/v1/presence/users",
        body,
        {
          timeout: 15000,
          headers: {
            Cookie: this.cookie,
            "User-Agent": "Mozilla/5.0 (Linux; Android 10; Termux)",
            "Content-Type": "application/json",
            Accept: "application/json",
          },
        }
      );
      const p = r.data?.userPresences?.[0];
      if (p) return p;
    } catch (e) {
      lastErr = e;
      // rơi xuống fallback
    }

    try {
      const r = await axios.post(
        "https://presence.roproxy.com/v1/presence/users",
        body,
        {
          timeout: 15000,
          headers: {
            "User-Agent": "Mozilla/5.0 (Linux; Android 10; Termux)",
            "Content-Type": "application/json",
            Accept: "application/json",
          },
        }
      );
      const p = r.data?.userPresences?.[0];
      if (p) return p;
    } catch (e) {
      lastErr = e;
    }

    // Cả 2 endpoint fail: KHÔNG trả null im lặng.
    // Trả marker để vòng lặp biết đây là lỗi mạng (giữ trạng thái cũ),
    // khác hẳn với "API trả về offline thật".
    this.lastPresenceError = lastErr ? (lastErr.message || String(lastErr)) : "unknown";
    return { __fetchFailed: true, error: this.lastPresenceError };
  }
}

class GameSelector {
  constructor() {
    this.GAMES = {
      "1": ["126884695634066", "Grow-a-Garden"],
      "2": ["2753915549", "Blox-Fruits"],
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
  constructor(joinCooldownSec = 90) {
    this.hasLaunched = false;
    this.joinedAt = 0;
    // Thời gian chờ sau khi mở app để Roblox kịp load, tránh spam rejoin
    this.joinCooldownMs = joinCooldownSec * 1000;
    // Số lần đã bắn rejoin liên tiếp mà user vẫn chưa vào game
    this.consecutiveFails = 0;
    // Lần rejoin gần nhất thành công ở mức "đã mở được app"
    this.lastLaunchOk = true;
    // presenceType của lần kiểm tra trước, dùng để phát hiện CHUYỂN trạng thái
    this.lastPtype = null;
    // Khoảng nghỉ tối thiểu giữa 2 lần bắn, kể cả khi vừa đổi trạng thái.
    // Chặn spam nếu presence API nhấp nháy (flapping) giữa 0 và 1.
    this.minLaunchGapMs = 8000;
  }

  /**
   * Cooldown chỉ dùng để chống spam khi app ĐANG load.
   * Nếu user Offline hẳn thì app chắc chắn không load -> không chờ,
   * chỉ giữ 1 khoảng nghỉ ngắn (grace) để am kịp mở app.
   */
  cooldownForState(offline) {
    if (!offline) return this.joinCooldownMs;
    // Offline: app đang TẮT nên phải cold start + load Roblox từ đầu — riêng việc
    // này đã mất 40-70s trên máy yếu. Cooldown cũ 20s là quá ngắn: bot bắn đè
    // liên tục lúc app đang khởi động, Roblox bị reset màn hình loading -> không
    // bao giờ vào được game. Nâng nền lên 90s và backoff thêm.
    const base = 90000;
    const tries = Math.max(0, this.consecutiveFails - 1);
    const backoff = Math.min(tries, 3) * 15000; // 90s -> 105s -> 120s -> 135s
    return base + backoff;
  }

  isCoolingDown(now = Date.now(), offline = false) {
    if (!this.hasLaunched) return false;
    return (now - this.joinedAt) < this.cooldownForState(offline);
  }

  cooldownLeftSec(now = Date.now(), offline = false) {
    return Math.max(0, Math.ceil((this.cooldownForState(offline) - (now - this.joinedAt)) / 1000));
  }

  /**
   * Đã bắn rejoin nhiều lần mà vẫn không vào được -> nên force-stop app.
   * Ngưỡng cũ là 2: quá nhạy, app mới khởi động (còn đang load) đã bị kill,
   * tạo vòng lặp mở-giết vô tận. Nâng lên 4.
   */
  shouldForceStop() {
    return this.consecutiveFails >= 4;
  }

  /**
   * Trạng thái vừa TỤT khỏi in-game (2 -> 0/1/khác) trong lần kiểm tra này?
   * Đây là thời điểm phải rejoin NGAY, không chờ cooldown: app đã thoát hẳn
   * nên chẳng có gì để "chờ load" cả.
   */
  isFreshDrop(ptype) {
    if (this.lastPtype === null) return false;      // lần chạy đầu, chưa có gì để so
    if (ptype === 2) return false;                  // vẫn đang trong game
    // 0 -> 1 KHÔNG phải "rớt game": đó là app vừa được bật lên và đang load
    // (Offline -> Online ngoài game). Bắn rejoin đè lúc này sẽ reset màn loading.
    if (this.lastPtype === 0 && ptype === 1) return false;
    return this.lastPtype !== ptype;                // trạng thái vừa thay đổi
  }

  /** Chống spam tối thiểu, dùng cho trường hợp bỏ qua cooldown */
  withinMinGap(now) {
    return this.joinedAt > 0 && (now - this.joinedAt) < this.minLaunchGapMs;
  }

  analyzePresence(presence, targetRootPlaceId) {
    const now = Date.now();

    // presenceType 0 = Offline, 1 = Online (ngoài game) -> cả hai đều KHÔNG ở trong game
    const ptype = presence && presence.userPresenceType !== undefined
      ? presence.userPresenceType
      : undefined;
    const notInGame = ptype === undefined || ptype === 0 || ptype === 1 || ptype !== 2;

    // Vừa chuyển trạng thái (vd: Online[+] -> Offline, hoặc Offline -> Online ngoài game)
    // => bắn rejoin NGAY, bỏ qua cooldown. Chỉ giữ khoảng nghỉ tối thiểu 8s
    // để tránh spam khi API nhấp nháy.
    const freshDrop = this.isFreshDrop(ptype);
    this.lastPtype = ptype;

    let cooling = this.isCoolingDown(now, notInGame);
    let coolMsg = cooling ? ` (đang chờ load ${this.cooldownLeftSec(now, notInGame)}s)` : "";

    if (freshDrop && cooling && !this.withinMinGap(now)) {
      // Trạng thái mới => cooldown cũ không còn ý nghĩa, huỷ luôn
      cooling = false;
      coolMsg = " [đổi trạng thái -> rejoin ngay]";
      this.hasLaunched = false;
      this.joinedAt = 0;
    }

    if (ptype === undefined) {
      return {
        status: "Không rõ",
        info: `Không lấy được trạng thái${coolMsg}`,
        shouldLaunch: !cooling,
        forceStop: !cooling && this.shouldForceStop(),
        rejoinOnly: true
      };
    }


    if (ptype === 0) {
      return {
        status: "Offline",
        info: `User offline! Tiến hành rejoin ngay!${coolMsg}`,
        shouldLaunch: !cooling,
        // Offline mà bắn 2 lần không lên -> app treo, phải kill rồi mở lại
        forceStop: !cooling && this.shouldForceStop(),
        rejoinOnly: true
      };
    }


    if (ptype === 1) {
      return {
        status: "Online nhưng không trong game",
        info: `User online nhưng không trong game. Rejoin ngay!${coolMsg}`,
        shouldLaunch: !cooling,
        forceStop: !cooling && this.shouldForceStop(),
        rejoinOnly: true
      };
    }


    if (ptype !== 2) {
      return {
        status: "Không online",
        info: `User không trong game. Rejoin ngay!${coolMsg}`,
        shouldLaunch: !cooling,
        forceStop: !cooling && this.shouldForceStop(),
        rejoinOnly: true
      };
    }

    // Đang trong game: chấp nhận nếu khớp rootPlaceId HOẶC placeId
    // (nhiều game có sub-place, chỉ so rootPlaceId sẽ bị rejoin nhầm liên tục)
    const target = targetRootPlaceId != null ? targetRootPlaceId.toString() : "";
    const rootId = presence.rootPlaceId != null ? presence.rootPlaceId.toString() : "";
    const placeId = presence.placeId != null ? presence.placeId.toString() : "";
    const matched = target && (rootId === target || placeId === target);

    if (!matched) {
      // Nếu API không trả về place nào (thiếu quyền/cookie) thì không rejoin bừa
      if (!rootId && !placeId) {
        return {
          status: "Trong game",
          info: "Đang trong game nhưng API không trả về placeId (giữ nguyên)",
          shouldLaunch: false,
          rejoinOnly: true
        };
      }

      return {
        status: "Sai map",
        info: `Sai map (root:${rootId || "?"} / place:${placeId || "?"}). Rejoin đúng map!${coolMsg}`,
        shouldLaunch: !cooling,
        forceStop: !cooling && this.shouldForceStop(),
        rejoinOnly: true
      };
    }

    // Đã vào đúng game -> reset trạng thái cooldown + bộ đếm fail
    this.hasLaunched = false;
    this.consecutiveFails = 0;

    return {
      status: "Online [+]",
      info: "Đang ở đúng game",
      shouldLaunch: false,
      forceStop: false,
      rejoinOnly: true
    };
  }

  /**
   * @param {boolean} shouldLaunch  có bắn rejoin không
   * @param {boolean} launchOk      lệnh mở app có thành công không
   *
   * Nếu am KHÔNG mở được app thì không bật cooldown dài — phải thử lại
   * ở vòng kế tiếp, nếu không bot sẽ đứng im dù user vẫn offline.
   */
  updateJoinStatus(shouldLaunch, launchOk = true) {
    if (!shouldLaunch) return;

    this.consecutiveFails++;
    this.lastLaunchOk = launchOk;

    if (launchOk) {
      this.joinedAt = Date.now();
      this.hasLaunched = true;
    } else {
      // Không mở được app -> bỏ cooldown, vòng sau thử lại ngay
      this.hasLaunched = false;
      this.joinedAt = 0;
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
 ║          DAWN REJOIN                 ║
 ║    Bản quyền thuộc về The Real Dawn  ║
 ╚══════════════════════════════════════╝`;

    try {
      if (!figlet) return fallbackTitle;
      const titleText = figlet.textSync("Dawn Rejoin", {
        font: "Small",
        horizontalLayout: "fitted",
        verticalLayout: "fitted"
      });

      const content = titleText + "\nBản quyền thuộc về The Real Dawn";
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
      const packageDisplay = Utils.packageLabel(instance.packageName);

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
      const packageDisplay = Utils.packageLabel(packageName);


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
║           DAWN REJOIN                ║
║    Bản quyền thuộc về The Real Dawn  ║
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
    console.log("3. 🔍 Tự động nhận diện prefix (quét app xử lý roblox://)");
    console.log("4. ⏭️ Quay lại menu chính");

    const choice = await Utils.ask(rl, "\nNhập lựa chọn (1-4): ");

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
      console.log("\n🔍 Đang quét các app xử lý được scheme roblox:// ...");
      const { prefix: detected, packages: handlers } = Utils.autoDetectPrefix();

      if (!handlers.length) {
        console.log("[-] Không tìm thấy app nào khai báo xử lý roblox://.");
        console.log("[!] Có thể app mod không đăng ký scheme, hãy nhập prefix thủ công (mục 1).");
      } else {
        console.log(`[+] Tìm thấy ${handlers.length} app:`);
        handlers.forEach((p, i) => console.log(`   ${i + 1}. ${p}`));
        console.log(`\n[*] Prefix suy ra: \x1b[32m${detected}\x1b[0m`);

        const ok = (await Utils.ask(rl, `Lưu prefix "${detected}"? (y/n): `)).trim().toLowerCase();
        if (ok === "y" || ok === "yes" || ok === "") {
          Utils.savePackagePrefixConfig(detected);
          console.log(`[+] Đã cập nhật prefix thành: ${detected}`);
        } else {
          console.log("[*] Đã huỷ, giữ nguyên prefix cũ.");
        }
      }

    } else if (choice.trim() === "4") {

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
      console.log(`\n Activity hiện tại: TỰ ĐỘNG DÒ (khuyến nghị)`);
      console.log(`   Bot sẽ tự tìm activity thật của từng app qua resolve-activity/dumpsys,`);
      console.log(`   thử lần lượt rồi nhớ activity chạy được. Chỉ đặt tay khi tự dò thất bại.`);
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
        console.log("[+] Đã đặt lại về chế độ tự động dò activity!");
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
      const packageDisplay = Utils.packageLabel(packageName, ' ');


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
      // Cooldown mặc định = max(90s, delaySec) để game kịp load trước lần rejoin kế tiếp
      const cooldownSec = Math.max(90, Number(config.delaySec) || 0);
      const statusHandler = new StatusHandler(cooldownSec);

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
        // Mặc định coi như chưa ở trong game -> kiểm tra nhanh ngay từ đầu
        notInGame: true
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
    const webhookManager = new WebhookManager();
    const webhookConfig = Utils.loadWebhookConfig();

    // Dùng mốc thời gian thực thay vì đếm vòng lặp (vòng lặp có await nên bị trôi)
    const webhookIntervalMs = webhookConfig && webhookConfig.intervalMinutes
      ? webhookConfig.intervalMinutes * 60 * 1000
      : 0;
    let nextWebhookAt = webhookIntervalMs ? Date.now() + webhookIntervalMs : 0;

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

        // delaySec là chu kỳ kiểm tra khi user ĐANG ở trong game.
        // - Ngoài game/offline: poll dồn dập 5s để rejoin gần như tức thì.
        // - Trong game: vẫn phải poll đủ dày (trần 30s) thì mới PHÁT HIỆN được
        //   lúc user rớt ra. Nếu tôn trọng nguyên delaySec=300 thì rớt game
        //   xong 5 phút sau bot mới biết -> "rejoin ngay" là vô nghĩa.
        const baseDelayMs = (Number(config.delaySec) || 30) * 1000;
        const OUT_OF_GAME_POLL_MS = 5000;
        const IN_GAME_POLL_CAP_MS = 30000;
        const delayMs = instance.notInGame
          ? Math.min(OUT_OF_GAME_POLL_MS, baseDelayMs)
          : Math.min(baseDelayMs, IN_GAME_POLL_CAP_MS);

        const timeSinceLastCheck = now - instance.lastCheck;


        const timeLeft = Math.max(0, delayMs - timeSinceLastCheck);
        instance.countdownSeconds = Math.ceil(timeLeft / 1000);


        if (timeSinceLastCheck >= delayMs) {
          const presence = await user.getPresence();

          // Lỗi mạng/API: giữ nguyên trạng thái cũ, KHÔNG coi là offline giả
          if (presence && presence.__fetchFailed) {
            instance.status = "Lỗi mạng";
            instance.info = `Không gọi được presence API: ${presence.error}. Giữ trạng thái, thử lại sau.`;
            instance.lastCheck = now;
            continue;
          }

          let presenceTypeDisplay = "Unknown";
          if (presence && presence.userPresenceType !== undefined) {
            presenceTypeDisplay = presence.userPresenceType.toString();
          }

          const analysis = statusHandler.analyzePresence(presence, config.placeId);

          if (analysis.shouldLaunch) {
            const launchOk = await GameLauncher.handleGameLaunch(
              analysis.shouldLaunch,
              config.placeId,
              config.linkCode,
              config.packageName || instance.packageName,
              true,
              analysis.forceStop
            );
            // Truyền kết quả thật để không bật cooldown khi launch fail
            statusHandler.updateJoinStatus(analysis.shouldLaunch, launchOk);

            if (!launchOk) {
              analysis.info = `${analysis.info} [mở app thất bại - thử lại vòng sau]`;
            }
          }

          instance.status = analysis.status;
          instance.info = analysis.info;
          instance.presenceType = presenceTypeDisplay;
          instance.lastCheck = now;
          // Chưa vào game -> kiểm tra lại nhanh hơn, không chờ hết delaySec
          instance.notInGame = analysis.shouldLaunch || analysis.status !== "Online [+]";
        }


        if (!instance.presenceType) {
          instance.presenceType = "Unknown";
        }
      }


      if (webhookConfig && webhookConfig.enabled && webhookIntervalMs && Date.now() >= nextWebhookAt) {
        console.log(`\n Đang gửi webhook status...`);
        try {
          await webhookManager.sendStatusWebhook(this.instances, this.startTime);
        } catch (e) {
          console.error(`[-] Lỗi gửi webhook: ${e.message}`);
        }
        nextWebhookAt = Date.now() + webhookIntervalMs;
      }

      if (renderCounter % 5 === 0) {
        console.clear();
        try {
          console.log(UIRenderer.renderTitle());
        } catch (e) {
          console.log(`
╔══════════════════════════════════════╗
║           DAWN REJOIN           ║
║    Bản quyền thuộc về The Real Dawn  ║
╚══════════════════════════════════════╝`);
        }

        console.log(UIRenderer.renderMultiInstanceTable(this.instances, this.startTime));

        if (this.instances.length > 0) {
          console.log("\n Debug (Instance 1):");
          console.log(`Package: ${this.instances[0].packageName}`);
          console.log(`Last Check: ${new Date(this.instances[0].lastCheck).toLocaleTimeString()}`);
        }


        if (webhookConfig && webhookConfig.url) {
          const urlParts = webhookConfig.url.split('/');
          const webhookId = urlParts[urlParts.length - 2] || 'unknown';
          const statusText = webhookConfig.enabled ? '[+] Đã bật' : '[-] Đã tắt';
          console.log(`\n Webhook Status: ID ${webhookId} - ${statusText} - [ĐÃ ẨN VÌ LÝ DO BẢO MẬT]`);
          if (webhookConfig.enabled && webhookIntervalMs) {
            const nextWebhookIn = Math.max(0, Math.ceil((nextWebhookAt - Date.now()) / 1000));
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
        const packageDisplay = Utils.packageLabel(instance.packageName, ' ');
        return `${packageDisplay}: ${instance.status}`;
      }).join('\n');

      const embed = {
        title: "🖥️ Dawn Rejoin Status Report",
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
          const packageDisplay = Utils.packageLabel(packageName, ' ');


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

          const packageDisplay = Utils.packageLabel(packageName, ' ');

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
          const packageDisplay = Utils.packageLabel(packageName, ' ');


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
  console.log(' Cảm ơn bạn đã sử dụng Dawn Rejoin Tool!');
  process.exit(0);
});


(async () => {
  const tool = new MultiRejoinTool();
  await tool.start();
})();
