# roblox-rejoin

Tool auto-rejoin Roblox chay tren Termux / Android. File chinh: **`rejoin.cjs`**.

## Cai nhanh (Termux)

```bash
termux-setup-storage && mv /sdcard/Download/loader.sh ~/ && sed -i 's/\r$//' ~/loader.sh && chmod +x ~/loader.sh && ~/loader.sh
```

Nhung lan sau chi can go:

```bash
loader
```

`loader.sh` se: cai `git`/`nodejs`/`sqlite` neu thieu, clone hoac `git pull` repo ve `~/roblox-rejoin`, chay `npm install`, roi chay `node rejoin.cjs`.

## Cai thu cong

```bash
pkg update && pkg install git nodejs sqlite -y
git clone https://github.com/ryomolochiton/roblox-rejoin ~/roblox-rejoin
cd ~/roblox-rejoin
npm install
npm start          # tuong duong: node rejoin.cjs
```

## Yeu cau

| Thanh phan | Ghi chu |
|---|---|
| Node.js | >= 18 |
| sqlite3 | `pkg install sqlite` |
| axios, cli-table3, figlet | bat buoc, tu cai neu thieu |
| boxen | ghim `5.1.2` (ban >= 6 la ESM-only, `require()` se loi) |
| screenshot-desktop | tuy chon, bo qua duoc tren Android |

## Scripts

- `npm start` / `npm run rejoin` -> `node rejoin.cjs`

## Loi thuong gap

- **`ERR_REQUIRE_ESM` khi load boxen**: chay `npm install boxen@5.1.2`.
- **`sqlite3: not found`**: `pkg install sqlite`.
- **`node: command not found`** sau khi cai: mo lai Termux hoac `source ~/.bashrc`.
- **loader bao loi `\r`**: file bi CRLF, chay `sed -i 's/\r$//' ~/loader.sh`.
