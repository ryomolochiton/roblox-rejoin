#!/usr/bin/env node
/**
 * Test mô phỏng logic auto-rejoin của rejoin.cjs
 *
 * KHÔNG chạy rejoin.cjs trực tiếp (file đó tự npm install + đọc stdin + gọi
 * Android `am`). Thay vào đó ta TRÍCH class StatusHandler nguyên văn từ source
 * rồi nạp vào sandbox -> test đúng code thật, không phải bản chép tay.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "rejoin.cjs");
const source = fs.readFileSync(SRC, "utf8");

/* ── Trích 1 class theo tên, dựa vào dấu ngoặc đóng ở cột 0 ───────────── */
function extractClass(name) {
  const start = source.indexOf(`class ${name} {`);
  if (start === -1) throw new Error(`Không tìm thấy class ${name} trong rejoin.cjs`);
  const end = source.indexOf("\n}", start);
  if (end === -1) throw new Error(`Không tìm được điểm kết thúc của class ${name}`);
  return source.slice(start, end + 2);
}

const sandbox = { console, Date, Math, Number, String, Boolean, JSON };
vm.createContext(sandbox);
vm.runInContext(extractClass("StatusHandler") + "\nthis.StatusHandler = StatusHandler;", sandbox);
const StatusHandler = sandbox.StatusHandler;

/* ── Mini test harness ────────────────────────────────────────────────── */
let pass = 0, fail = 0;
const failures = [];

function group(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}
function check(desc, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${desc}`);
  } else {
    fail++;
    failures.push(desc);
    console.log(`  \x1b[31m✗ ${desc}\x1b[0m ${extra}`);
  }
}
function eq(desc, actual, expected) {
  check(desc, actual === expected, `→ nhận "${actual}", mong đợi "${expected}"`);
}

const P = {
  offline:    { userPresenceType: 0 },
  onlineOnly: { userPresenceType: 1 },
  inGame:     (root, place) => ({ userPresenceType: 2, rootPlaceId: root, placeId: place }),
  inGameNoId: { userPresenceType: 2 },
  studio:     { userPresenceType: 3 },
};
const TARGET = "126884695634066";

/* Cho phép tua ngược thời gian: giả lập cooldown đã trôi qua */
function rewind(h, ms) { if (h.joinedAt) h.joinedAt -= ms; }

/* ══════════════════════════════════════════════════════════════════════ */
group("1. Offline → phải rejoin NGAY (bug chính: cooldown 90s chặn)");
{
  const h = new StatusHandler(90);
  const a1 = h.analyzePresence(P.offline, TARGET);
  eq("lần đầu offline: status = Offline", a1.status, "Offline");
  check("lần đầu offline: shouldLaunch = true", a1.shouldLaunch === true);

  h.updateJoinStatus(true, true);
  const a2 = h.analyzePresence(P.offline, TARGET);
  check("ngay sau khi bắn: bị chặn (chống spam)", a2.shouldLaunch === false);

  rewind(h, 21000); // 21s
  const a3 = h.analyzePresence(P.offline, TARGET);
  check("sau 21s vẫn offline: rejoin lại (KHÔNG chờ 90s)", a3.shouldLaunch === true,
    `→ cooldown offline = ${h.cooldownForState(true) / 1000}s`);
}

group("2. Cooldown offline vs in-game phải khác nhau");
{
  const h = new StatusHandler(90);
  eq("in-game cooldown = 90s", h.cooldownForState(false), 90000);
  eq("offline cooldown ban đầu = 20s", h.cooldownForState(true), 20000);

  h.consecutiveFails = 1; eq("sau lần bắn 1 → vẫn 20s", h.cooldownForState(true), 20000);
  h.consecutiveFails = 2; eq("sau lần bắn 2 → 30s", h.cooldownForState(true), 30000);
  h.consecutiveFails = 3; eq("sau lần bắn 3 → 40s", h.cooldownForState(true), 40000);
  h.consecutiveFails = 4; eq("sau lần bắn 4 → 50s", h.cooldownForState(true), 50000);
  h.consecutiveFails = 9; eq("backoff bị chặn trần ở 50s", h.cooldownForState(true), 50000);
  check("backoff offline không bao giờ vượt cooldown in-game",
    h.cooldownForState(true) <= h.cooldownForState(false));
}

group("3. delaySec lớn không được kéo dài cooldown offline");
{
  // Kịch bản user set delaySec = 300 → cooldownSec = max(90, 300) = 300
  const h = new StatusHandler(300);
  eq("in-game cooldown = 300s", h.cooldownForState(false), 300000);
  eq("offline cooldown vẫn 20s", h.cooldownForState(true), 20000);
  check("offline KHÔNG bị delaySec=300 chặn", h.cooldownForState(true) < 300000);
}

group("4. Online nhưng ngoài game (presenceType 1)");
{
  const h = new StatusHandler(90);
  const a = h.analyzePresence(P.onlineOnly, TARGET);
  eq("status", a.status, "Online nhưng không trong game");
  check("shouldLaunch = true", a.shouldLaunch === true);

  h.updateJoinStatus(true, true);
  rewind(h, 21000);
  check("21s sau vẫn ngoài game → rejoin lại", h.analyzePresence(P.onlineOnly, TARGET).shouldLaunch === true);
}

group("5. Launch THẤT BẠI → không được bật cooldown");
{
  const h = new StatusHandler(90);
  const a = h.analyzePresence(P.offline, TARGET);
  check("quyết định rejoin", a.shouldLaunch === true);

  h.updateJoinStatus(true, false); // am mở app thất bại
  eq("hasLaunched = false khi launch fail", h.hasLaunched, false);
  eq("joinedAt bị reset về 0", h.joinedAt, 0);
  check("vòng ngay sau: thử lại NGAY, không chờ",
    h.analyzePresence(P.offline, TARGET).shouldLaunch === true);
  eq("lastLaunchOk ghi nhận fail", h.lastLaunchOk, false);
}

group("6. Rejoin ≥2 lần không lên → force-stop app");
{
  const h = new StatusHandler(90);
  check("chưa fail lần nào: không force-stop", h.shouldForceStop() === false);

  h.analyzePresence(P.offline, TARGET);
  h.updateJoinStatus(true, true);
  eq("consecutiveFails sau lần 1", h.consecutiveFails, 1);
  check("1 lần: chưa force-stop", h.shouldForceStop() === false);

  rewind(h, 31000);
  const a2 = h.analyzePresence(P.offline, TARGET);
  check("lần 2 được phép bắn", a2.shouldLaunch === true);
  h.updateJoinStatus(true, true);
  eq("consecutiveFails sau lần 2", h.consecutiveFails, 2);

  rewind(h, 41000);
  const a3 = h.analyzePresence(P.offline, TARGET);
  check("lần 3: bật cờ forceStop", a3.forceStop === true);
}

group("7. Vào đúng game → reset toàn bộ trạng thái");
{
  const h = new StatusHandler(90);
  h.analyzePresence(P.offline, TARGET);
  h.updateJoinStatus(true, true);
  check("đang có cooldown", h.hasLaunched === true);

  const a = h.analyzePresence(P.inGame(TARGET, TARGET), TARGET);
  eq("status", a.status, "Online [+]");
  check("không rejoin nữa", a.shouldLaunch === false);
  eq("hasLaunched reset", h.hasLaunched, false);
  eq("consecutiveFails reset", h.consecutiveFails, 0);
  eq("cooldown offline về mức đáy 20s", h.cooldownForState(true), 20000);
}

group("8. Nhận diện đúng map / sai map / thiếu placeId");
{
  const h = new StatusHandler(90);
  check("khớp rootPlaceId → OK",
    h.analyzePresence(P.inGame(TARGET, "999"), TARGET).status === "Online [+]");

  const h2 = new StatusHandler(90);
  check("khớp placeId (sub-place) → OK, không rejoin nhầm",
    h2.analyzePresence(P.inGame("999", TARGET), TARGET).status === "Online [+]");

  const h3 = new StatusHandler(90);
  const wrong = h3.analyzePresence(P.inGame("111", "222"), TARGET);
  eq("sai map → status", wrong.status, "Sai map");
  check("sai map → rejoin", wrong.shouldLaunch === true);

  const h4 = new StatusHandler(90);
  const noId = h4.analyzePresence(P.inGameNoId, TARGET);
  check("trong game nhưng API thiếu placeId → KHÔNG rejoin bừa", noId.shouldLaunch === false);
}

group("9. presenceType lạ / thiếu dữ liệu");
{
  const h = new StatusHandler(90);
  const st = h.analyzePresence(P.studio, TARGET);
  eq("Studio (type 3) → status", st.status, "Không online");
  check("Studio → rejoin", st.shouldLaunch === true);

  const h2 = new StatusHandler(90);
  const un = h2.analyzePresence(null, TARGET);
  eq("presence null → status", un.status, "Không rõ");
  check("presence null → vẫn rejoin", un.shouldLaunch === true);
}

/* ── Nhóm 10: mô phỏng vòng lặp thật theo trục thời gian ──────────────── */
group("10. Mô phỏng 10 phút offline với delaySec = 300");
{
  const delaySec = 300;
  const h = new StatusHandler(Math.max(90, delaySec));
  const baseDelayMs = delaySec * 1000;

  let t = 0;
  let notInGame = true;        // cờ khởi tạo trong rejoin.cjs
  let lastCheck = -Infinity;
  let launches = 0, checks = 0;

  // tick 1s, tổng 600s
  const originalNow = Date.now;
  for (t = 0; t <= 600000; t += 1000) {
    Date.now = () => t;

    const delayMs = notInGame ? Math.min(5000, baseDelayMs) : Math.min(baseDelayMs, 30000);
    if (t - lastCheck < delayMs) continue;

    checks++;
    const a = h.analyzePresence(P.offline, TARGET);
    if (a.shouldLaunch) { launches++; h.updateJoinStatus(true, true); }
    lastCheck = t;
    notInGame = a.shouldLaunch || a.status !== "Online [+]";
  }
  Date.now = originalNow;

  console.log(`  → ${checks} lần kiểm tra, ${launches} lần bắn rejoin trong 10 phút`);
  check("poll mỗi 10s, không bị delaySec=300 chặn", checks >= 55, `(checks=${checks})`);
  check("bắn rejoin nhiều lần (code cũ chỉ ~2 lần)", launches >= 10, `(launches=${launches})`);
  check("không spam mỗi vòng (có backoff)", launches < checks, `(${launches}/${checks})`);
}

group("11. Đang trong game: poll trần 30s, không rejoin thừa");
{
  const delaySec = 300;
  const h = new StatusHandler(Math.max(90, delaySec));
  const baseDelayMs = delaySec * 1000;

  let notInGame = true, lastCheck = -Infinity, checks = 0, launches = 0;
  const originalNow = Date.now;
  for (let t = 0; t <= 600000; t += 1000) {
    Date.now = () => t;
    const delayMs = notInGame ? Math.min(5000, baseDelayMs) : Math.min(baseDelayMs, 30000);
    if (t - lastCheck < delayMs) continue;
    checks++;
    const a = h.analyzePresence(P.inGame(TARGET, TARGET), TARGET);
    if (a.shouldLaunch) launches++;
    lastCheck = t;
    notInGame = a.shouldLaunch || a.status !== "Online [+]";
  }
  Date.now = originalNow;

  console.log(`  → ${checks} lần kiểm tra, ${launches} lần rejoin trong 10 phút khi đang chơi`);
  eq("đang chơi ngon: KHÔNG rejoin lần nào", launches, 0);
  check("poll trần 30s → ~21 lần/10 phút", checks >= 20 && checks <= 22, `(checks=${checks})`);
  check("nhẹ hơn nhiều so với poll 5s (120 lần)", checks < 60, `(checks=${checks})`);
}

group("12. Rớt game giữa chừng → phát hiện và rejoin nhanh");
{
  const h = new StatusHandler(90);
  h.analyzePresence(P.inGame(TARGET, TARGET), TARGET); // đang chơi ngon
  let notInGame = false;

  const drop = h.analyzePresence(P.offline, TARGET);   // đột ngột offline
  check("phát hiện rớt game ngay", drop.shouldLaunch === true);
  notInGame = drop.shouldLaunch || drop.status !== "Online [+]";
  check("cờ notInGame bật → chuyển sang poll nhanh", notInGame === true);
}

/* ══ Nhóm mới: rejoin NGAY khi status CHUYỂN sang offline ═══════════════ */
group("14. Chuyển trạng thái → bỏ qua cooldown, rejoin tức thì");
{
  // Kịch bản: bot vừa bắn rejoin (đang cooldown) thì user chuyển 1 -> 0
  const h = new StatusHandler(90);
  h.analyzePresence(P.onlineOnly, TARGET);   // type 1
  h.updateJoinStatus(true, true);            // bật cooldown
  rewind(h, 9000);                           // mới 9s trôi qua (< 20s cooldown)

  check("cùng trạng thái type 1 → vẫn phải chờ cooldown",
    h.analyzePresence(P.onlineOnly, TARGET).shouldLaunch === false);

  // giờ user chuyển sang OFFLINE
  const drop = h.analyzePresence(P.offline, TARGET);
  eq("status", drop.status, "Offline");
  check("đổi 1 → 0: rejoin NGAY dù đang cooldown", drop.shouldLaunch === true);
  check("info ghi rõ lý do bỏ cooldown", /đổi trạng thái/.test(drop.info), `→ "${drop.info}"`);
}

group("15. Đang trong game rồi rớt thẳng xuống offline");
{
  const h = new StatusHandler(90);
  h.analyzePresence(P.inGame(TARGET, TARGET), TARGET);
  h.updateJoinStatus(false);                 // trong game thì không bắn gì

  const drop = h.analyzePresence(P.offline, TARGET);
  check("2 → 0: rejoin ngay lập tức", drop.shouldLaunch === true);
  check("không dính cooldown 90s", !/đang chờ load/.test(drop.info), `→ "${drop.info}"`);
}

group("16. Chống spam khi presence nhấp nháy (flapping 0↔1)");
{
  const h = new StatusHandler(90);
  h.analyzePresence(P.offline, TARGET);
  h.updateJoinStatus(true, true);
  rewind(h, 3000);                           // mới 3s, dưới minLaunchGapMs = 8s

  const flap = h.analyzePresence(P.onlineOnly, TARGET);
  check("đổi trạng thái nhưng chưa qua 8s → KHÔNG bắn (chống spam)",
    flap.shouldLaunch === false, `→ "${flap.info}"`);

  rewind(h, 6000);                           // tổng 9s > 8s
  const ok = h.analyzePresence(P.offline, TARGET);
  check("qua mốc 8s + đổi trạng thái → bắn ngay", ok.shouldLaunch === true);
}

group("17. Lần chạy đầu tiên không bị coi là 'đổi trạng thái'");
{
  const h = new StatusHandler(90);
  eq("lastPtype khởi tạo = null", h.lastPtype, null);
  check("chưa có lịch sử → isFreshDrop = false", h.isFreshDrop(0) === false);

  h.analyzePresence(P.offline, TARGET);
  eq("sau lần đầu, lastPtype được ghi lại", h.lastPtype, 0);
  check("cùng trạng thái offline → không tính là đổi", h.isFreshDrop(0) === false);
  check("đang trong game thì không bao giờ tính là drop", h.isFreshDrop(2) === false);
}

group("18. Vòng lặp phải phát hiện rớt game trong ≤30s (delaySec=300)");
{
  const delaySec = 300;
  const h = new StatusHandler(Math.max(90, delaySec));
  const baseDelayMs = delaySec * 1000;
  const OUT = 5000, CAP = 30000;

  // user chơi ngon 100s rồi rớt offline tại t=100s
  const DROP_AT = 100000;
  let notInGame = true, lastCheck = -Infinity, detectedAt = null, firstLaunchAt = null;

  const originalNow = Date.now;
  for (let t = 0; t <= 300000; t += 1000) {
    Date.now = () => t;
    const delayMs = notInGame ? Math.min(OUT, baseDelayMs) : Math.min(baseDelayMs, CAP);
    if (t - lastCheck < delayMs) continue;

    const presence = t < DROP_AT ? P.inGame(TARGET, TARGET) : P.offline;
    const a = h.analyzePresence(presence, TARGET);

    if (t >= DROP_AT && detectedAt === null && a.status === "Offline") detectedAt = t;
    if (a.shouldLaunch) {
      if (firstLaunchAt === null && t >= DROP_AT) firstLaunchAt = t;
      h.updateJoinStatus(true, true);
    }
    lastCheck = t;
    notInGame = a.shouldLaunch || a.status !== "Online [+]";
  }
  Date.now = originalNow;

  const detectLag = (detectedAt - DROP_AT) / 1000;
  const launchLag = (firstLaunchAt - DROP_AT) / 1000;
  console.log(`  → phát hiện offline sau ${detectLag}s, bắn rejoin sau ${launchLag}s`);
  check("phát hiện rớt game trong vòng 30s", detectLag <= 30, `(${detectLag}s)`);
  check("bắn rejoin ngay khi phát hiện (không thêm độ trễ)", launchLag === detectLag);
  check("KHÔNG phải chờ hết delaySec=300s", launchLag < 300);
}

group("19. Ngoài game: poll 5s (nhanh hơn mức 10s cũ)");
{
  const h = new StatusHandler(90);
  const baseDelayMs = 300000;
  let notInGame = true, lastCheck = -Infinity, checks = 0;

  const originalNow = Date.now;
  for (let t = 0; t <= 60000; t += 1000) {
    Date.now = () => t;
    const delayMs = notInGame ? Math.min(5000, baseDelayMs) : baseDelayMs;
    if (t - lastCheck < delayMs) continue;
    checks++;
    const a = h.analyzePresence(P.offline, TARGET);
    if (a.shouldLaunch) h.updateJoinStatus(true, true);
    lastCheck = t;
    notInGame = a.shouldLaunch || a.status !== "Online [+]";
  }
  Date.now = originalNow;
  console.log(`  → ${checks} lần kiểm tra trong 60s`);
  check("poll ~5s một lần", checks >= 12, `(checks=${checks})`);
}

/* ── Kiểm tra source-level các fix không thuộc StatusHandler ──────────── */
group("13. Kiểm tra các fix khác còn nguyên trong source");
{
  check("Utils.androidEnv() tồn tại", /static androidEnv\(\)/.test(source));
  check("androidEnv xoá LD_PRELOAD", /delete env\.LD_PRELOAD/.test(source));
  check("androidEnv xoá LD_LIBRARY_PATH", /delete env\.LD_LIBRARY_PATH/.test(source));
  check("có hàm dò lỗi output của am", /_amFailed/.test(source));
  check("launch() trả về true/false", /console\.error\(`\[-\] \[\$\{packageName\}\] Launch failed/.test(source));
  check("Utils.forceStop() tồn tại", /static forceStop\(packageName\)/.test(source));
  check("getPresence trả marker __fetchFailed", /__fetchFailed: true/.test(source));
  check("vòng lặp xử lý __fetchFailed", /presence\.__fetchFailed/.test(source));
  check("vòng lặp dùng cờ notInGame", /instance\.notInGame/.test(source));
  check("poll nhanh 5s khi ngoài game", /OUT_OF_GAME_POLL_MS = 5000/.test(source));
  check("trong game vẫn poll trần 30s để bắt lúc rớt", /IN_GAME_POLL_CAP_MS = 30000/.test(source));
  check("có logic phát hiện đổi trạng thái", /isFreshDrop/.test(source));
  check("có khoảng nghỉ tối thiểu chống spam", /minLaunchGapMs/.test(source));
  check("truyền launchOk vào updateJoinStatus", /updateJoinStatus\(analysis\.shouldLaunch, launchOk\)/.test(source));
  check("truyền forceStop vào handleGameLaunch", /analysis\.forceStop/.test(source));

  const launchCount = (source.match(/const attempts = \[/g) || []).length;
  check("launch có danh sách nhiều biến thể lệnh", launchCount >= 1);
}

/* ── Kết quả ──────────────────────────────────────────────────────────── */
console.log("\n" + "─".repeat(58));
if (fail === 0) {
  console.log(`\x1b[32m✓ TẤT CẢ ${pass} TEST ĐỀU PASS\x1b[0m`);
} else {
  console.log(`\x1b[31m✗ ${fail} test FAIL\x1b[0m / ${pass} pass`);
  failures.forEach(f => console.log(`   - ${f}`));
}
console.log("─".repeat(58));
process.exit(fail === 0 ? 0 : 1);
