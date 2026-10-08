#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");
const util = require("util");
const {
  execFile,
  execFileSync,
  spawnSync
} = require("child_process");

const TERMUX_BIN = "/data/data/com.termux/files/usr/bin";
process.env.PATH = [
  TERMUX_BIN,
  process.env.PATH || "",
  "/system/bin"
].join(":");

function hasCommand(name) {
  return String(process.env.PATH)
    .split(":")
    .some((dir) => {
      if (!dir) return false;
      try {
        const file = path.join(dir, name);
        if (!fs.statSync(file).isFile()) return false;
        fs.accessSync(file, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
}

function ensureDependencies() {
  for (const name of ["axios", "form-data"]) {
    try {
      require.resolve(name);
    } catch {
      console.log(`Đang cài ${name}...`);
      execFileSync(
        "npm",
        ["install", "--no-audit", "--no-fund", name],
        {
          cwd: __dirname,
          stdio: "inherit",
          timeout: 180000
        }
      );
    }
  }

  if (!hasCommand("sqlite3")) {
    if (process.getuid?.() === 0) {
      throw new Error(
        "Thiếu sqlite3. Mở Termux thường, chạy: pkg install sqlite"
      );
    }

    execFileSync("pkg", ["install", "sqlite", "-y"], {
      stdio: "inherit",
      timeout: 180000
    });
  }
}

try {
  ensureDependencies();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const axios = require("axios");
const FormData = require("form-data");
const runFile = util.promisify(execFile);

const CONFIG_DIR = path.resolve(
  process.env.ROBLOX_REJOIN_HOME ||
  path.join(os.homedir(), ".roblox-rejoin")
);

const TMP_DIR = path.join(CONFIG_DIR, "tmp");

fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(TMP_DIR, { recursive: true, mode: 0o700 });

try {
  fs.chmodSync(TMP_DIR, 0o700);
} catch {}

const FILES = {
  configs: "multi_configs.json",
  webhook: "webhook_config.json",
  prefix: "package_prefix_config.json",
  activity: "activity_config.json",
  autoexec: "autoexec_config.json"
};

for (const name of Object.values(FILES)) {
  const target = path.join(CONFIG_DIR, name);
  const old = path.join(__dirname, name);

  try {
    if (!fs.existsSync(target) && fs.existsSync(old)) {
      fs.copyFileSync(old, target);
      fs.chmodSync(target, 0o600);
    }
  } catch {}
}

function cleanTmp() {
  try {
    for (const name of fs.readdirSync(TMP_DIR)) {
      if (!/^(shot-|cookie-)/.test(name)) continue;

      const file = path.join(TMP_DIR, name);

      try {
        const stat = fs.lstatSync(file);
        if (
          stat.isFile() &&
          Date.now() - stat.mtimeMs > 3600000
        ) {
          fs.unlinkSync(file);
        }
      } catch {}
    }
  } catch {}
}
cleanTmp();

const DEFAULT_ACTIVITY = "com.roblox.client.ActivityProtocolLaunch";
const HTTP_TIMEOUT = 15000;
const LAUNCH_GRACE_MS = 75000;
const LAUNCH_GAP_MS = 2000;
const CACHE_TTL_MS = 15000;
const CACHE_STALE_MS = 180000;
const RESERVE_MS = 120000;
const USER_AGENT = "Roblox-Rejoin/2.0 (Android; Termux)";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (text) => `'${String(text).replace(/'/g, "'\\''")}'`;
const packageValid = (value) =>
  /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/.test(String(value || ""));
const placeValid = (value) => /^\d+$/.test(String(value || ""));
const activityValid = (value) =>
  /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(String(value || ""));

const api = axios.create({
  timeout: HTTP_TIMEOUT,
  proxy: false,
  maxRedirects: 0,
  headers: {
    "User-Agent": USER_AGENT,
    Accept: "application/json"
  }
});

function filePath(key) {
  return path.join(CONFIG_DIR, FILES[key]);
}

function readJson(key, fallback) {
  const file = filePath(key);

  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Không đọc được ${FILES[key]}; giữ lại file cũ.`);
    }
    return fallback;
  }
}

function writeJson(key, value) {
  const file = filePath(key);
  const temp = `${file}.${process.pid}.tmp`;

  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), {
      encoding: "utf8",
      mode: 0o600
    });
    fs.renameSync(temp, file);
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {}
  }
}

function loadConfigs() {
  const configs = readJson("configs", {});
  if (
    !configs ||
    typeof configs !== "object" ||
    Array.isArray(configs)
  ) {
    throw new Error("multi_configs.json sai định dạng.");
  }
  return configs;
}

function loadPrefix() {
  const prefix = readJson("prefix", {})?.prefix;
  return packageValid(prefix) ? prefix : "com.roblox";
}

function joinMode(config) {
  if (config.linkCode) return "vip";
  return config.joinMode === "normal" ? "normal" : "lowpop";
}

function joinLabel(config) {
  return {
    vip: "VIP",
    normal: "Thường",
    lowpop: "Ít người"
  }[joinMode(config)];
}

function errorText(error) {
  const status = error.response?.status;
  if (status === 429) return "Roblox giới hạn tốc độ (429)";
  if (status === 401) return "Cookie hết hạn";
  if (status) return `HTTP ${status}`;
  if (
    error.code === "ECONNABORTED" ||
    error.code === "ETIMEDOUT"
  ) {
    return "Hết thời gian chờ";
  }
  return error.code || "Lỗi mạng";
}

function mask(value) {
  const text = String(value || "?");
  return text.length > 3
    ? "*".repeat(Math.min(8, text.length - 3)) + text.slice(-3)
    : text;
}

function countdown(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return seconds >= 60
    ? `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`
    : `${seconds}s`;
}

function title(text) {
  console.log(`\n=== ${text} ===`);
}

function safeLine(value, width) {
  const text = String(value ?? "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f]/g, " ");

  // Giao diện gọn; cắt theo code point, không chèn ANSI từ dữ liệu.
  const chars = Array.from(text);
  return chars.length <= width
    ? text
    : chars.slice(0, Math.max(0, width - 1)).join("") + "…";
}

let rl = null;
let live = false;
let stopping = false;
let wakeHeld = false;

function ask(text) {
  if (!rl || rl.closed) {
    return Promise.reject(new Error("Đầu vào đã đóng."));
  }

  return new Promise((resolve) => {
    rl.question(`\n${text}: `, (answer) => resolve(answer.trim()));
  });
}

async function numberInput(text, min, max, fallback) {
  while (true) {
    const raw = await ask(text);

    if (!raw && fallback !== undefined) return fallback;

    const value = Number(raw);
    if (
      raw &&
      Number.isInteger(value) &&
      value >= min &&
      value <= max
    ) {
      return value;
    }

    console.log(`Nhập số nguyên từ ${min} đến ${max}.`);
  }
}

async function ack() {
  await ask("Enter để quay lại");
}

function ensureRoot() {
  if (process.getuid?.() === 0) return;

  console.log("Đang yêu cầu quyền root...");

  const command = [
    `ROBLOX_REJOIN_HOME=${quote(CONFIG_DIR)}`,
    `PATH=${quote(process.env.PATH)}`,
    `TERM=${quote(process.env.TERM || "xterm")}`,
    quote(process.execPath),
    quote(__filename),
    ...process.argv.slice(2).map(quote)
  ].join(" ");

  const result = spawnSync("su", ["-c", command], {
    stdio: "inherit"
  });

  if (result.error) {
    console.error("Không mở được su:", result.error.message);
  }

  process.exit(
    typeof result.status === "number" ? result.status : 1
  );
}

function enableWake() {
  try {
    execFileSync("termux-wake-lock", [], {
      stdio: "ignore",
      timeout: 5000
    });
    wakeHeld = true;
  } catch {
    console.warn("Không bật được wake lock; tránh để máy ngủ.");
  }
}

function disableWake() {
  if (!wakeHeld) return;
  wakeHeld = false;

  try {
    execFileSync("termux-wake-unlock", [], {
      stdio: "ignore",
      timeout: 5000
    });
  } catch {}
}

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  live = false;
  disableWake();

  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[?25h\n");
  }

  process.exit(code);
}

process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());
process.on("exit", disableWake);

process.on("uncaughtException", (error) => {
  console.error("\nLỗi nghiêm trọng:", error.message);
  shutdown(1);
});

process.on("unhandledRejection", (error) => {
  console.error("\nLỗi bất đồng bộ:", error?.message || error);
  shutdown(1);
});

async function androidCommand(name, args, timeout = 20000) {
  const env = { ...process.env };
  delete env.LD_PRELOAD;
  delete env.LD_LIBRARY_PATH;

  let lastError;

  for (const bin of [`/system/bin/${name}`, name]) {
    try {
      const result = await runFile(bin, args, {
        timeout,
        maxBuffer: 2 * 1024 * 1024,
        env
      });

      const output = `${result.stdout || ""}\n${result.stderr || ""}`;
      const bad = output.split("\n").find((line) =>
        /^\s*(Error|Exception|java\.lang\.)/i.test(line)
      );

      if (bad) throw new Error(bad.trim());

      return result.stdout || "";
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(`Không chạy được ${name}`);
}

async function detectPackages() {
  const prefix = loadPrefix();
  const output = await androidCommand(
    "pm",
    ["list", "packages", prefix]
  );

  return [...new Set(
    output.split(/\r?\n/)
      .map((line) => line.replace(/^package:/, "").trim())
      .filter((name) => packageValid(name) && name.startsWith(prefix))
  )].sort();
}

async function getCookie(packageName) {
  if (!packageValid(packageName)) return null;

  const source =
    `/data/data/${packageName}/app_webview/Default/Cookies`;
  const target = path.join(
    TMP_DIR,
    `cookie-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
  );

  try {
    await fs.promises.copyFile(source, target);
    await fs.promises.chmod(target, 0o600);

    for (const suffix of ["-wal", "-journal"]) {
      try {
        await fs.promises.copyFile(source + suffix, target + suffix);
        await fs.promises.chmod(target + suffix, 0o600);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }

    const result = await runFile("sqlite3", [
      target,
      "SELECT value FROM cookies WHERE name='.ROBLOSECURITY' LIMIT 1;"
    ], {
      timeout: 15000,
      maxBuffer: 1024 * 1024
    });

    const value = String(result.stdout || "").trim();
    return value ? `.ROBLOSECURITY=${value}` : null;
  } catch {
    return null;
  } finally {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try {
        await fs.promises.unlink(target + suffix);
      } catch {}
    }
  }
}

async function authPost(url, body, user) {
  const headers = {
    Cookie: user.cookie,
    ...(user.csrf ? { "X-CSRF-TOKEN": user.csrf } : {})
  };

  try {
    return await api.post(url, body, { headers });
  } catch (error) {
    const token = error.response?.headers?.["x-csrf-token"];

    if (error.response?.status === 403 && token) {
      user.csrf = token;
      return api.post(url, body, {
        headers: {
          Cookie: user.cookie,
          "X-CSRF-TOKEN": token
        }
      });
    }

    throw error;
  }
}

async function authenticatedUser(cookie) {
  const response = await api.get(
    "https://users.roblox.com/v1/users/authenticated",
    { headers: { Cookie: cookie } }
  );

  return response.data;
}

// API công khai: tuần tự theo host, không dùng proxy.
const gates = new Map();

function gateFor(url) {
  const host = new URL(url).host;
  if (!gates.has(host)) {
    gates.set(host, { tail: Promise.resolve(), nextAt: 0 });
  }
  return gates.get(host);
}

async function publicGet(url, params = {}, retries = 1) {
  const gate = gateFor(url);

  const operation = gate.tail.then(async () => {
    for (let attempt = 0; ; attempt++) {
      await sleep(Math.max(0, gate.nextAt - Date.now()));
      gate.nextAt = Date.now() + 900;

      try {
        return await api.get(url, { params });
      } catch (error) {
        if (error.response?.status !== 429) throw error;

        const raw = error.response.headers?.["retry-after"];
        const seconds = Number(raw);
        const date = Date.parse(String(raw || ""));

        const wait = Number.isFinite(seconds) && seconds > 0
          ? seconds * 1000
          : Number.isFinite(date)
            ? Math.max(1000, date - Date.now())
            : Math.min(30000, 3000 * 2 ** attempt);

        gate.nextAt = Math.max(gate.nextAt, Date.now() + wait);
        if (attempt >= retries) throw error;
      }
    }
  });

  gate.tail = operation.then(() => undefined, () => undefined);
  return operation;
}

const universeCache = new Map();
const universePending = new Map();

async function universeOf(placeId) {
  const key = String(placeId);
  const cached = universeCache.get(key);

  if (cached?.id) return cached.id;
  if (cached && Date.now() - cached.at < 30000) return null;
  if (universePending.has(key)) return universePending.get(key);

  const pending = (async () => {
    try {
      const response = await publicGet(
        `https://apis.roblox.com/universes/v1/places/${key}/universe`,
        {},
        0
      );

      const id = response.data?.universeId;
      if (!id) throw new Error("Không có universe");

      universeCache.set(key, { id: String(id), at: Date.now() });
      return String(id);
    } catch {
      universeCache.set(key, { id: null, at: Date.now() });
      return null;
    } finally {
      universePending.delete(key);
    }
  })();

  universePending.set(key, pending);
  return pending;
}

const serverCache = new Map();
const serverPending = new Map();
const reservations = new Map();

function pruneCaches() {
  const now = Date.now();

  for (const [key, value] of serverCache) {
    if (now - value.at > CACHE_STALE_MS) serverCache.delete(key);
  }

  while (serverCache.size > 16) {
    serverCache.delete(serverCache.keys().next().value);
  }

  while (universeCache.size > 512) {
    universeCache.delete(universeCache.keys().next().value);
  }

  for (const [id, times] of reservations) {
    const valid = times.filter((time) => now - time < RESERVE_MS);
    if (valid.length) reservations.set(id, valid);
    else reservations.delete(id);
  }
}

async function serverList(placeId) {
  const key = String(placeId);
  const cached = serverCache.get(key);

  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.list;
  }

  if (serverPending.has(key)) return serverPending.get(key);

  const pending = (async () => {
    try {
      const response = await publicGet(
        `https://games.roblox.com/v1/games/${key}/servers/Public`,
        {
          sortOrder: "Asc",
          excludeFullGames: true,
          limit: 100
        },
        1
      );

      const list = (response.data?.data || [])
        .filter((server) =>
          /^[0-9a-f-]{8,64}$/i.test(String(server.id || "")) &&
          Number.isFinite(Number(server.playing)) &&
          Number(server.maxPlayers) > 0 &&
          Number(server.playing) < Number(server.maxPlayers)
        )
        .map((server) => ({
          id: String(server.id),
          playing: Number(server.playing),
          maxPlayers: Number(server.maxPlayers)
        }));

      serverCache.set(key, { at: Date.now(), list });
      pruneCaches();
      return list;
    } catch (error) {
      if (cached && Date.now() - cached.at < CACHE_STALE_MS) {
        return cached.list;
      }
      throw error;
    } finally {
      serverPending.delete(key);
    }
  })();

  serverPending.set(key, pending);
  return pending;
}

async function pickServer(placeId) {
  pruneCaches();

  const list = await serverList(placeId);
  const now = Date.now();

  const scored = list.map((server) => ({
    ...server,
    score:
      server.playing +
      (reservations.get(server.id) || [])
        .filter((time) => now - time < RESERVE_MS).length
  })).filter((server) => server.score < server.maxPlayers);

  const occupied = scored.filter((server) => server.playing > 0);
  const candidates = occupied.length ? occupied : scored;

  if (!candidates.length) {
    throw new Error("Không có server public còn chỗ");
  }

  const best = Math.min(...candidates.map((server) => server.score));
  const ties = candidates.filter((server) => server.score === best);
  const chosen = ties[Math.floor(Math.random() * ties.length)];

  const times = reservations.get(chosen.id) || [];
  times.push(now);
  reservations.set(chosen.id, times);

  return chosen;
}

function parseTarget(input) {
  const text = String(input || "").trim()
    .replace(/^[<"']+|[>"']+$/g, "");

  if (/^\d+$/.test(text)) {
    return { placeId: text, name: `Place ${text}`, linkCode: null };
  }

  let url;

  try {
    url = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
        ? text
        : `https://${text}`
    );
  } catch {
    throw new Error("Không nhận ra Place ID hoặc link Roblox.");
  }

  if (url.protocol === "https:") {
    if (!["roblox.com", "www.roblox.com"].includes(url.hostname)) {
      throw new Error("Chỉ nhận link roblox.com.");
    }
  } else if (url.protocol !== "roblox:") {
    throw new Error("Link không hợp lệ.");
  }

  const params = new Map(
    [...url.searchParams.entries()]
      .map(([key, value]) => [key.toLowerCase(), value])
  );

  if (
    params.get("code") &&
    params.get("type")?.toLowerCase() === "server"
  ) {
    return { shareCode: params.get("code") };
  }

  const placeId =
    url.pathname.match(/\/games\/(\d+)/i)?.[1] ||
    params.get("placeid");

  const linkCode =
    params.get("privateserverlinkcode") ||
    params.get("linkcode") ||
    null;

  if (!placeValid(placeId)) {
    throw new Error("Link thiếu Place ID hợp lệ.");
  }

  if (linkCode && !/^[\w-]+$/.test(linkCode)) {
    throw new Error("Mã VIP không hợp lệ.");
  }

  return {
    placeId,
    linkCode,
    name: linkCode ? "Private Server" : `Place ${placeId}`
  };
}

async function resolveTarget(input, cookie) {
  const target = parseTarget(input);
  if (!target.shareCode) return target;

  if (!cookie) throw new Error("Cần cookie để đổi link chia sẻ.");

  const response = await authPost(
    "https://apis.roblox.com/sharelinks/v1/resolve-link",
    { linkId: target.shareCode, linkType: "Server" },
    { cookie, csrf: null }
  );

  const data = response.data?.privateServerInviteData;

  if (
    !data ||
    (data.status && data.status !== "Valid") ||
    !placeValid(data.placeId) ||
    !/^[\w-]+$/.test(String(data.linkCode || ""))
  ) {
    throw new Error("Link VIP hết hạn hoặc không đổi được.");
  }

  return {
    placeId: String(data.placeId),
    linkCode: String(data.linkCode),
    name: "Private Server"
  };
}

async function chooseGame(cookie, current = null) {
  while (true) {
    const input = await ask(
      current
        ? "Place ID/link mới [Enter giữ nguyên]"
        : "Place ID hoặc link server"
    );

    if (!input && current) {
      return {
        placeId: current.placeId,
        name: current.gameName,
        linkCode: current.linkCode || null,
        joinMode: current.joinMode || "lowpop"
      };
    }

    if (!input) throw new Error("Đã hủy chọn game.");

    try {
      const game = await resolveTarget(input, cookie);

      if (game.linkCode) {
        game.joinMode = null;
      } else {
        console.log("\n1. Join thường\n2. Server ít người");
        const mode = await numberInput("Kiểu join [1-2]", 1, 2);
        game.joinMode = mode === 1 ? "normal" : "lowpop";
      }

      return game;
    } catch (error) {
      console.log(error.message);
    }
  }
}

async function choosePackages(packages, label = "Chọn package") {
  if (!packages.length) return [];

  console.log("\n0. Tất cả");
  packages.forEach((name, index) => {
    console.log(`${index + 1}. ${name}`);
  });

  const input = await ask(`${label} [nhiều số cách nhau bằng dấu cách]`);
  if (input === "0") return [...packages];

  const parts = input.split(/\s+/);
  if (!parts.every((value) => /^\d+$/.test(value))) return [];

  return [...new Set(
    parts.map(Number)
      .filter((value) => value >= 1 && value <= packages.length)
      .map((value) => packages[value - 1])
  )];
}

async function setupPackages() {
  title("THIẾT LẬP");
  const packages = await detectPackages();

  if (!packages.length) {
    console.log("Không tìm thấy package. Kiểm tra prefix ở mục 4.");
    return;
  }

  const selected = await choosePackages(packages);
  const configs = loadConfigs();

  for (const packageName of selected) {
    title(packageName);

    try {
      const cookie = await getCookie(packageName);
      if (!cookie) throw new Error("Không đọc được cookie; đăng nhập Roblox trước.");

      const user = await authenticatedUser(cookie);
      const game = await chooseGame(cookie);
      const delaySec = await numberInput(
        "Nhịp kiểm tra [15-120 giây, Enter=60]",
        15,
        120,
        60
      );

      configs[packageName] = {
        packageName,
        username: user.name,
        userId: user.id,
        placeId: game.placeId,
        gameName: game.name,
        linkCode: game.linkCode,
        joinMode: game.joinMode,
        delaySec,
        autoRejoinMinutes: 0
      };

      // Lưu từng package, tránh mất phần đã thiết lập.
      writeJson("configs", configs);
      console.log(`Đã lưu ${packageName} — ${mask(user.name)}.`);
    } catch (error) {
      console.log(
        `Bỏ qua: ${error.response ? errorText(error) : error.message}`
      );
    }
  }
}

async function editConfigs() {
  const configs = loadConfigs();
  const packages = Object.keys(configs);

  if (!packages.length) {
    console.log("Chưa có cấu hình.");
    return;
  }

  const selected = await choosePackages(packages, "Chọn cấu hình");

  for (const packageName of selected) {
    const config = configs[packageName];
    title(packageName);

    console.log(
      `Game: ${config.gameName || config.placeId}\n` +
      `Join: ${joinLabel(config)} | Quét: ${config.delaySec || 60}s`
    );

    console.log(
      "\n1. Đổi game / link VIP / kiểu join" +
      "\n2. Đổi nhịp kiểm tra" +
      "\n3. Xóa cấu hình" +
      "\n0. Giữ nguyên"
    );

    const choice = await ask("Chọn");

    if (choice === "1") {
      const cookie = await getCookie(packageName);
      const game = await chooseGame(cookie, config);

      Object.assign(config, {
        placeId: game.placeId,
        gameName: game.name,
        linkCode: game.linkCode,
        joinMode: game.joinMode
      });
    } else if (choice === "2") {
      config.delaySec = await numberInput("Giây [15-120]", 15, 120);
    } else if (choice === "3") {
      if ((await ask("Xóa cấu hình? [y/N]")).toLowerCase() === "y") {
        delete configs[packageName];
      }
    }

    writeJson("configs", configs);
  }
}

async function configurePrefix() {
  console.log(`Prefix hiện tại: ${loadPrefix()}`);
  const prefix = await ask("Prefix mới [Enter giữ nguyên]");

  if (!prefix) return;
  if (!packageValid(prefix)) {
    throw new Error("Prefix không hợp lệ, ví dụ com.roblox.");
  }

  writeJson("prefix", { prefix });
}

async function configureActivity() {
  const current = readJson("activity", {})?.activity || DEFAULT_ACTIVITY;
  console.log(`Activity: ${current}`);
  const value = await ask("Activity mới [0=mặc định, Enter giữ nguyên]");

  if (!value) return;
  if (value === "0") {
    writeJson("activity", { activity: null });
    return;
  }

  if (!activityValid(value)) throw new Error("Activity không hợp lệ.");
  writeJson("activity", { activity: value });
}

function discordUrl(input) {
  try {
    const url = new URL(input);

    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      ![
        "discord.com",
        "discordapp.com",
        "ptb.discord.com",
        "canary.discord.com"
      ].includes(url.hostname.toLowerCase()) ||
      !/^\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+\/?$/.test(url.pathname)
    ) {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
}

async function configureWebhook() {
  const current = readJson("webhook", null);

  console.log(
    current
      ? `Webhook: ${current.enabled ? "Bật" : "Tắt"}; ` +
        `${current.intervalMinutes} phút; có ảnh`
      : "Chưa có webhook."
  );

  console.log(
    "\n1. Tạo / sửa\n2. Bật / tắt\n3. Xóa\n0. Quay lại"
  );

  const choice = await ask("Chọn");

  if (choice === "1") {
    const input = await ask("URL [Enter giữ URL cũ]");
    const url = discordUrl(input || current?.url || "");

    if (!url) throw new Error("URL Discord không hợp lệ.");

    const intervalMinutes = await numberInput(
      "Chu kỳ [5-180 phút, Enter=30]",
      5,
      180,
      30
    );

    writeJson("webhook", {
      url,
      intervalMinutes,
      enabled: true
    });
  } else if (choice === "2" && current) {
    writeJson("webhook", {
      ...current,
      enabled: !current.enabled
    });
  } else if (choice === "3" && current) {
    if ((await ask("Xóa webhook? [y/N]")).toLowerCase() === "y") {
      await fs.promises.unlink(filePath("webhook"));
    }
  }
}

const EXECUTORS = {
  Delta: "/storage/emulated/0/Delta/Autoexecute/text.txt",
  Ronix: "/storage/emulated/0/RonixExploit/autoexec/text.txt",
  Codex: "/storage/emulated/0/Codex/Autoexec/text.txt",
  "Arceus X": "/storage/emulated/0/Arceus X/Autoexec/text.txt"
};

async function restoreAutoexec(config) {
  const target = EXECUTORS[config?.executor];
  if (!target || typeof config.script !== "string") return;

  let current = null;

  try {
    current = await fs.promises.readFile(target, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  if (current === config.script) return;

  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, config.script, "utf8");
}

async function configureAutoexec() {
  const current = readJson("autoexec", null);
  console.log(`Autoexec: ${current?.executor || "Tắt"}`);
  console.log("\n1. Thiết lập\n2. Tắt quản lý autoexec\n0. Quay lại");

  const action = await ask("Chọn");

  if (action === "2") {
    writeJson("autoexec", null);
    return;
  }

  if (action !== "1") return;

  const names = Object.keys(EXECUTORS);
  names.forEach((name, index) => console.log(`${index + 1}. ${name}`));

  const index = await numberInput("Executor", 1, names.length);
  const executor = names[index - 1];

  // Đọc từ file thay vì giữ trình soạn thảo trong tool.
  const source = await ask("Đường dẫn file script muốn dùng");
  const stat = await fs.promises.stat(source);

  if (!stat.isFile() || stat.size > 1024 * 1024) {
    throw new Error("Script phải là file và không quá 1 MB.");
  }

  const script = await fs.promises.readFile(source, "utf8");
  if (!script.trim()) throw new Error("Script trống.");

  const config = { executor, script, path: EXECUTORS[executor] };
  await restoreAutoexec(config);
  writeJson("autoexec", config);
  console.log("Đã lưu autoexec.");
}

async function scanWorlds() {
  const input = await ask("Place ID / link game [Enter hủy]");
  if (!input) return;

  const target = parseTarget(input);
  if (!target.placeId) {
    throw new Error("Dùng Place ID hoặc link game, không dùng link share.");
  }

  const universeId = await universeOf(target.placeId);
  if (!universeId) throw new Error("Không tra được universe.");

  console.log(`Universe: ${universeId}`);
  console.log("Chỉ liệt kê place; không dò server để giảm request.");

  let cursor = null;
  let count = 0;

  for (let page = 0; page < 3; page++) {
    const response = await publicGet(
      `https://develop.roblox.com/v1/universes/${universeId}/places`,
      {
        sortOrder: "Asc",
        limit: 100,
        ...(cursor ? { cursor } : {})
      }
    );

    for (const place of response.data?.data || []) {
      console.log(`${++count}. ${place.id} — ${safeLine(place.name, 80)}`);
    }

    cursor = response.data?.nextPageCursor;
    if (!cursor) break;
  }

  if (!count) console.log("Không có place trong phản hồi.");
  if (cursor) console.log("Danh sách còn nữa; đã giới hạn 300 place.");
}

let statsCache = null;
let statsAt = 0;
let previousCpu = null;

function systemStats() {
  const now = Date.now();
  if (statsCache && now - statsAt < 15000) return statsCache;

  let cpu = "?";

  try {
    const cpus = os.cpus() || [];
    const idle = cpus.reduce((sum, item) => sum + item.times.idle, 0);
    const total = cpus.reduce(
      (sum, item) =>
        sum + Object.values(item.times).reduce((a, b) => a + b, 0),
      0
    );

    if (previousCpu && total > previousCpu.total) {
      cpu = (
        100 * (
          1 -
          (idle - previousCpu.idle) /
          (total - previousCpu.total)
        )
      ).toFixed(1);
    }

    previousCpu = { idle, total };
  } catch {}

  statsCache = {
    cpu,
    ram:
      `${((os.totalmem() - os.freemem()) / 1024 ** 3).toFixed(2)}` +
      `/${(os.totalmem() / 1024 ** 3).toFixed(2)} GB`,
    toolRam: Math.round(process.memoryUsage().rss / 1024 ** 2)
  };

  statsAt = now;
  return statsCache;
}

async function screenshotToFile() {
  const file = path.join(
    TMP_DIR,
    `shot-${process.pid}-${Date.now()}.png`
  );

  try {
    // Tạo trước với quyền riêng tư; screencap ghi trực tiếp vào file.
    await fs.promises.writeFile(file, "", { mode: 0o600 });
    await androidCommand("screencap", ["-p", file], 20000);

    const handle = await fs.promises.open(file, "r");

    try {
      const signature = Buffer.alloc(8);
      const { bytesRead } = await handle.read(signature, 0, 8, 0);

      if (
        bytesRead !== 8 ||
        !signature.equals(Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
        ]))
      ) {
        throw new Error("Ảnh không hợp lệ");
      }
    } finally {
      await handle.close();
    }

    return file;
  } catch (error) {
    try {
      await fs.promises.unlink(file);
    } catch {}
    throw error;
  }
}

async function sendReport(config, instances, startedAt, log) {
  const url = discordUrl(config?.url || "");
  if (!url || !config.enabled) return;

  let screenshot = null;
  let stream = null;

  try {
    try {
      screenshot = await screenshotToFile();
    } catch {
      log("Không chụp được màn hình; gửi báo cáo chữ.");
    }

    const stats = systemStats();
    const active = instances.filter((item) => item.inGame).length;
    const rejoins = instances.reduce((sum, item) => sum + item.rejoins, 0);

    const embed = {
      title: "REJOIN TOOL • Báo cáo",
      description: `${active}/${instances.length} tài khoản trong game`,
      color: active === instances.length ? 0x2ecc71 : 0xf1c40f,
      timestamp: new Date().toISOString(),
      fields: [
        { name: "CPU", value: `${stats.cpu}%`, inline: true },
        { name: "RAM máy", value: stats.ram, inline: true },
        { name: "RAM tool", value: `${stats.toolRam} MB`, inline: true },
        {
          name: "Thời gian chạy",
          value: countdown(Date.now() - startedAt),
          inline: true
        },
        { name: "Rejoin", value: String(rejoins), inline: true },
        {
          name: "Instances",
          value: instances.map((item) =>
            `${safeLine(item.packageName, 60)}: ` +
            `${safeLine(item.status, 70)} (↻${item.rejoins})`
          ).join("\n").slice(0, 1024) || "Không có"
        }
      ]
    };

    const payload = { username: "REJOIN TOOL", embeds: [embed] };

    if (screenshot) {
      const name = path.basename(screenshot);
      const stat = await fs.promises.stat(screenshot);

      embed.image = { url: `attachment://${name}` };

      const form = new FormData();
      form.append("payload_json", JSON.stringify(payload));

      stream = fs.createReadStream(screenshot, {
        highWaterMark: 64 * 1024
      });

      form.append("files[0]", stream, {
        filename: name,
        contentType: "image/png",
        knownLength: stat.size
      });

      const length = await new Promise((resolve, reject) => {
        form.getLength((error, value) =>
          error ? reject(error) : resolve(value)
        );
      });

      await api.post(url, form, {
        timeout: 30000,
        maxBodyLength: Infinity,
        maxContentLength: 1024 * 1024,
        headers: {
          ...form.getHeaders(),
          "Content-Length": length
        }
      });
    } else {
      await api.post(url, payload, { timeout: 30000 });
    }

    log("Đã gửi webhook.");
  } catch (error) {
    log(`Webhook thất bại: ${errorText(error)}`);
  } finally {
    if (stream && !stream.closed) {
      await new Promise((resolve) => {
        stream.once("close", resolve);
        stream.destroy();
      });
    }

    if (screenshot) {
      try {
        await fs.promises.unlink(screenshot);
      } catch {}
    }
  }
}

class Monitor {
  constructor(instances, minutes) {
    this.instances = instances;
    this.minutes = minutes;
    this.startedAt = Date.now();
    this.events = [];
    this.launchTail = Promise.resolve();
    this.lastLaunchFinished = 0;
    this.webhook = readJson("webhook", null);
    this.autoexec = readJson("autoexec", null);
    this.reportBusy = false;
    this.autoexecBusy = false;
    this.nextReport =
      Date.now() +
      Math.max(5, Number(this.webhook?.intervalMinutes) || 30) * 60000;
    this.nextAutoexec = Date.now() + 15 * 60000;
    this.nextCleanup = 0;
  }

  log(text) {
    const time = new Date().toLocaleTimeString();
    this.events.push(`${time} ${safeLine(text, 150)}`);
    if (this.events.length > 12) this.events.shift();
  }

  grace(item, now = Date.now()) {
    return item.joinedAt > 0 && now - item.joinedAt < LAUNCH_GRACE_MS;
  }

  periodicDue(item, now = Date.now()) {
    return (
      this.minutes > 0 &&
      !this.grace(item, now) &&
      now - item.lastResetAt >= this.minutes * 60000
    );
  }

  enqueueLaunch(item, reason) {
    if (!live || item.launching) return;

    const retryMs = Math.max(15, Number(item.config.delaySec) || 60) * 1000;

    if (
      item.lastAttemptAt &&
      Date.now() - item.lastAttemptAt < retryMs
    ) {
      return;
    }

    item.launching = true;
    item.status = "Chờ mở game";

    const task = this.launchTail.then(async () => {
      if (!live) return;

      await sleep(Math.max(
        0,
        this.lastLaunchFinished + LAUNCH_GAP_MS - Date.now()
      ));

      if (!live) return;

      item.lastAttemptAt = Date.now();
      item.status = "Đang tìm server";
      let server = null;

      if (joinMode(item.config) === "lowpop") {
        try {
          server = await pickServer(item.config.placeId);
        } catch (error) {
          this.log(
            `${item.packageName}: ` +
            `${error.response ? errorText(error) : error.message}; join thường`
          );
        }
      }

      if (!live) return;

      const config = item.config;
      const link = new URLSearchParams({
        placeID: String(config.placeId)
      });

      if (config.linkCode) {
        link.set("linkCode", config.linkCode);
      } else if (server) {
        link.set("gameInstanceId", server.id);
      }

      const savedActivity = readJson("activity", {})?.activity;
      const activity = activityValid(savedActivity)
        ? savedActivity
        : DEFAULT_ACTIVITY;

      item.status = "Đang mở game";

      // Đóng phiên cũ để chu kỳ cố định thực sự mở lại ứng dụng.
      await androidCommand("am", ["force-stop", item.packageName]);

      await androidCommand("am", [
        "start",
        "-n", `${item.packageName}/${activity}`,
        "-a", "android.intent.action.VIEW",
        "-d", `roblox://${link.toString()}`,
        "--activity-clear-top"
      ]);

      const now = Date.now();
      item.joinedAt = now;
      item.lastResetAt = now;
      item.nextCheckAt = now + 15000;
      item.failures = 0;
      item.rejoins++;
      item.inGame = false;
      item.status = "Đang tải game";

      this.log(
        `${item.packageName}: ${reason}; đã gửi lệnh mở ` +
        `${server ? `server ${server.playing}/${server.maxPlayers}` : joinLabel(config)}` +
        `, lần ${item.rejoins}`
      );
    });

    this.launchTail = task.catch((error) => {
      item.status = "Lỗi mở game";
      item.inGame = false;

      this.log(
        `${item.packageName}: mở thất bại — ` +
        safeLine(error.message, 100)
      );
    }).finally(() => {
      item.launching = false;
      this.lastLaunchFinished = Date.now();
    });
  }

  async presence(item) {
    try {
      const response = await authPost(
        "https://presence.roblox.com/v1/presence/users",
        { userIds: [Number(item.config.userId)] },
        item
      );

      const presence = response.data?.userPresences?.[0];
      if (!presence) throw new Error("Không có presence");
      return presence;
    } catch (error) {
      if (
        error.response?.status === 401 &&
        Date.now() - item.cookieRefreshAt >= 180000
      ) {
        item.cookieRefreshAt = Date.now();
        const fresh = await getCookie(item.packageName);

        if (fresh && fresh !== item.cookie) {
          item.cookie = fresh;
          item.csrf = null;

          const response = await authPost(
            "https://presence.roblox.com/v1/presence/users",
            { userIds: [Number(item.config.userId)] },
            item
          );

          const presence = response.data?.userPresences?.[0];
          if (presence) return presence;
        }
      }

      throw error;
    }
  }

  async check(item) {
    if (!live || item.checking || item.launching) return;
    item.checking = true;

    const base =
      Math.max(15, Number(item.config.delaySec) || 60) * 1000;

    try {
      const presence = await this.presence(item);
      item.failures = 0;

      let needsLaunch = false;
      let status;

      if (presence.userPresenceType !== 2) {
        item.inGame = false;
        needsLaunch = true;
        status = presence.userPresenceType === 0
          ? "Offline"
          : "Không trong game";
      } else {
        item.inGame = true;
        status = "Trong game";

        const actualPlace = presence.placeId || presence.rootPlaceId;
        const target = String(item.config.placeId);

        const samePlace = [
          presence.placeId,
          presence.rootPlaceId
        ].some((id) => id && String(id) === target);

        if (!samePlace && actualPlace) {
          const targetUniverse = await universeOf(target);
          const actualUniverse = presence.universeId
            ? String(presence.universeId)
            : await universeOf(actualPlace);

          // Chưa xác minh được thì không kết luận sai game.
          if (
            targetUniverse &&
            actualUniverse &&
            targetUniverse !== actualUniverse
          ) {
            needsLaunch = true;
            status = "Sai game";
          }
        }
      }

      if (!live) return;

      if (!item.launching) {
        if (needsLaunch && this.grace(item)) {
          item.status = "Đang tải game";
        } else {
          item.status = status;

          if (needsLaunch) {
            this.enqueueLaunch(item, status);
          }
        }
      }

      item.nextCheckAt = Date.now() + base;
    } catch (error) {
      item.failures++;
      item.inGame = false;

      if (!item.launching) {
        item.status = errorText(error);
      }

      const delay = error.response?.status === 401
        ? Math.max(base, 180000)
        : Math.min(300000, base * 2 ** Math.min(item.failures, 4));

      item.nextCheckAt = Date.now() + delay;

      // Chỉ ghi một lần khi bắt đầu lỗi để tránh spam.
      if (item.failures === 1) {
        this.log(`${item.packageName}: ${errorText(error)}; giữ nguyên game`);
      }
    } finally {
      item.checking = false;
    }
  }

  render() {
    if (
      process.stdout.destroyed ||
      process.stdout.writableNeedDrain
    ) {
      return;
    }

    const now = Date.now();
    const stats = systemStats();
    const width = Math.max(
      20,
      Math.min(110, (process.stdout.columns || 80) - 2)
    );

    const lines = [
      "REJOIN • Q + Enter: dừng | R + Enter: kiểm tra",
      this.minutes
        ? `Chế độ 2: mỗi ${this.minutes} phút + theo trạng thái`
        : "Chế độ 1: rejoin bình thường",
      `CPU ${stats.cpu}% | RAM ${stats.ram} | Tool ${stats.toolRam} MB`,
      `Chạy ${countdown(now - this.startedAt)}`,
      "─".repeat(width)
    ];

    for (const item of this.instances) {
      const remaining = this.minutes
        ? countdown(this.minutes * 60000 - (now - item.lastResetAt))
        : "Tắt";

      lines.push(
        `${item.packageName} | ${mask(item.config.username)}`,
        `${item.status} | ↻${item.rejoins} | Auto ${remaining}`
      );
    }

    const terminalRows = process.stdout.rows || 30;
    const room = Math.max(0, terminalRows - lines.length - 3);

    if (room > 1 && this.events.length) {
      lines.push("─".repeat(width));
      lines.push(...this.events.slice(-Math.min(4, room - 1)));
    }

    const shown = lines
      .slice(0, Math.max(4, terminalRows - 2))
      .map((line) => safeLine(line, width));

    if (process.stdout.isTTY) {
      process.stdout.write(
        "\x1b[H" +
        shown.map((line) => `${line}\x1b[K`).join("\n") +
        "\n\x1b[J"
      );
    } else {
      process.stdout.write(shown.join("\n") + "\n");
    }
  }

  async run() {
    live = true;

    const onLine = (line) => {
      const command = line.trim().toLowerCase();

      if (command === "q") {
        shutdown();
      } else if (command === "r") {
        for (const item of this.instances) item.nextCheckAt = 0;
        this.log("Đã yêu cầu kiểm tra ngay.");
      }
    };

    rl.on("line", onLine);

    if (process.stdout.isTTY) {
      process.stdout.write("\x1b[2J\x1b[H");
    }

    this.log(`Bắt đầu ${this.instances.length} package.`);

    if (this.minutes > 0) {
      for (const item of this.instances) {
        this.enqueueLaunch(item, "Join ngay khi bật");
      }
    }

    let nextRender = 0;

    try {
      while (live) {
        const now = Date.now();

        if (now >= this.nextCleanup) {
          pruneCaches();
          this.nextCleanup = now + 60000;
        }

        for (const item of this.instances) {
          if (this.periodicDue(item, now)) {
            this.enqueueLaunch(item, "Đủ chu kỳ");
          }
        }

        const activeChecks = this.instances
          .filter((item) => item.checking).length;
        let slots = Math.max(0, 2 - activeChecks);

        for (const item of this.instances) {
          if (!slots) break;

          if (
            !item.checking &&
            !item.launching &&
            now >= item.nextCheckAt
          ) {
            slots--;
            // check() tự xử lý lỗi và luôn nhả checking.
            void this.check(item);
          }
        }

        if (
          this.webhook?.enabled &&
          discordUrl(this.webhook.url || "") &&
          !this.reportBusy &&
          now >= this.nextReport
        ) {
          this.reportBusy = true;
          this.nextReport = now +
            Math.max(5, Number(this.webhook.intervalMinutes) || 30) * 60000;

          void sendReport(
            this.webhook,
            this.instances,
            this.startedAt,
            (text) => this.log(text)
          ).finally(() => {
            this.reportBusy = false;
          });
        }

        if (
          this.autoexec &&
          !this.autoexecBusy &&
          now >= this.nextAutoexec
        ) {
          this.autoexecBusy = true;
          this.nextAutoexec = now + 15 * 60000;

          void restoreAutoexec(this.autoexec)
            .catch(() => this.log("Không khôi phục được autoexec."))
            .finally(() => {
              this.autoexecBusy = false;
            });
        }

        if (now >= nextRender) {
          this.render();
          nextRender = now + (process.stdout.isTTY ? 5000 : 60000);
        }

        await sleep(1000);
      }
    } finally {
      rl.off("line", onLine);
    }
  }
}

async function startRejoin() {
  const configs = loadConfigs();
  const all = Object.keys(configs);

  if (!all.length) {
    console.log("Chưa có cấu hình. Chạy mục 2 trước.");
    return;
  }

  const installed = new Set(await detectPackages());
  const available = all.filter((name) => installed.has(name));

  if (!available.length) {
    console.log("Không tìm thấy package đã cấu hình. Kiểm tra prefix.");
    return;
  }

  const selected = await choosePackages(available);
  if (!selected.length) {
    console.log("Chưa chọn package hợp lệ.");
    return;
  }

  title("CHẾ ĐỘ REJOIN");
  console.log(
    "1. Rejoin bình thường" +
    "\n2. Rejoin cố định x phút + offline"
  );

  const mode = await numberInput("Chế độ [1-2]", 1, 2);
  const minutes = mode === 2
    ? await numberInput("Rejoin mỗi x phút [1-1440]", 1, 1440)
    : 0;

  const instances = [];

  for (const packageName of selected) {
    const config = configs[packageName];

    if (
      !config ||
      !packageValid(packageName) ||
      !placeValid(config.placeId) ||
      !/^\d+$/.test(String(config.userId || "")) ||
      (
        config.linkCode &&
        !/^[\w-]+$/.test(String(config.linkCode))
      )
    ) {
      console.log(`Bỏ qua ${packageName}: cấu hình không hợp lệ.`);
      continue;
    }

    console.log(`Đang đọc cookie ${packageName}...`);
    const cookie = await getCookie(packageName);

    if (!cookie) {
      console.log(`Bỏ qua ${packageName}: không đọc được cookie.`);
      continue;
    }

    // Kiểm tra tài khoản hiện tại để tránh theo dõi user cũ.
    try {
      const user = await authenticatedUser(cookie);

      if (String(user.id) !== String(config.userId)) {
        console.log(`Bỏ qua ${packageName}: tài khoản đã đổi; thiết lập lại.`);
        continue;
      }
    } catch (error) {
      console.log(`Bỏ qua ${packageName}: ${errorText(error)}.`);
      continue;
    }

    instances.push({
      packageName,
      config: {
        ...config,
        // Chu kỳ chỉ dùng cho phiên chạy này.
        autoRejoinMinutes: minutes
      },
      cookie,
      csrf: null,
      cookieRefreshAt: 0,
      checking: false,
      launching: false,
      failures: 0,
      rejoins: 0,
      joinedAt: 0,
      lastResetAt: Date.now(),
      lastAttemptAt: 0,
      nextCheckAt: 0,
      inGame: false,
      status: "Khởi tạo"
    });
  }

  if (!instances.length) {
    console.log("Không có package đủ điều kiện chạy.");
    return;
  }

  console.log(
    `Chạy ${instances.length} package. ` +
    (minutes
      ? `Join ngay, chu kỳ ${minutes} phút; offline vẫn rejoin.`
      : "Rejoin theo trạng thái.")
  );

  await new Monitor(instances, minutes).run();
}

async function main() {
  ensureRoot();
  enableWake();

  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  rl.on("SIGINT", () => shutdown());
  rl.on("close", () => shutdown());

  const actions = {
    "1": startRejoin,
    "2": setupPackages,
    "3": editConfigs,
    "4": configurePrefix,
    "5": configureActivity,
    "6": configureWebhook,
    "7": configureAutoexec,
    "8": scanWorlds
  };

  while (!stopping) {
    title("REJOIN TOOL • LITE");

    console.log(
      "1. Chạy Rejoin\n" +
      "2. Thiết lập package\n" +
      "3. Cấu hình\n" +
      "4. Prefix package\n" +
      "5. Activity\n" +
      "6. Webhook + ảnh\n" +
      "7. Autoexec\n" +
      "8. Dò world\n" +
      "0. Thoát"
    );

    const choice = await ask("Chọn [0-8]");
    if (choice === "0" || choice.toLowerCase() === "q") {
      shutdown();
      return;
    }

    const action = actions[choice];
    if (!action) {
      console.log("Lựa chọn không hợp lệ.");
      continue;
    }

    try {
      await action();
    } catch (error) {
      console.log(
        "Không hoàn tất: " +
        (error.response ? errorText(error) : error.message)
      );
    }

    if (!live) await ack();
  }
}

main().catch((error) => {
  console.error("Tool dừng:", error.message);
  shutdown(1);
});