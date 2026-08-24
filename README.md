# rejoin.cjs — Pro Max (Termux edition)

Công cụ theo dõi presence Roblox và tự mở lại app khi rớt, chạy trên **Termux/Android**.
CommonJS thuần, không phụ thuộc package ESM.

## Cài & chạy

```bash
pkg install nodejs-lts
bash loader.sh          # tự cài deps rồi mở menu
bash loader.sh --setup  # cài deps + chẩn đoán
node rejoin.cjs --selftest
node rejoin.cjs --loop  # chạy thẳng vòng lặp
```

## Cookie (chọn 1 trong 3)

1. `export ROBLOSECURITY='_|WARNING:-DO-NOT-SHARE-THIS...'`
2. Tạo file `cookie.txt` cạnh `rejoin.cjs`
3. Đặt `cookiePath` trong `config.json`

Cookie luôn được copy sang `.tmp/` với `chmod 600` (kèm `-wal`/`-shm` nếu là SQLite)
và **xoá trong `finally`**, kể cả khi crash.

## config.json

| Key | Kiểu | Mặc định | Ý nghĩa |
|---|---|---|---|
| `cooldownSec` | số | 90 | Khoảng cách giữa 2 lần kiểm tra |
| `maxRetries` | số | 5 | Số lần lỗi liên tiếp trước khi dừng |
| `requestTimeoutMs` | số | 12000 | Timeout HTTP |
| `reloadCookieEachCycle` | bool | true | Nạp lại cookie mỗi chu kỳ |
| `webhookEnabled` | bool | false | Bật thông báo Discord |
| `webhookUrl` | chuỗi | "" | Chỉ chấp nhận host Discord + https |
| `packages` | object | {} | `{ "com.roblox.client": { placeId, userId } }` |
| `autoexec` | chuỗi | "" | `\n` literal sẽ thành xuống dòng thật |

## Những lỗi đã xử lý

- **Input queue**: `rl.question` mất dòng khi stdin là pipe (promise resolve trong
  microtask, các `line` event sau rơi vào khoảng trống). Thay bằng một readline
  duy nhất + hàng đợi dòng.
- **AUTH/RATE**: 401/403 → `AUTH` (nạp lại cookie), 429 → `RATE` (tôn trọng
  `Retry-After`), backoff luỹ thừa + jitter, trần 30s.
- **Presence**: xoay vòng 2 endpoint, nhiều tài khoản kiểm tra song song bằng
  `Promise.all`, 401 không retry sang endpoint khác (vô nghĩa).
- **Termux launcher**: dùng `am start` với deep link `roblox://placeId=`, fallback
  `termux-open-url`; `ENOENT` được bọc thành thông báo hướng dẫn thay vì stack thô.
- **An toàn**: `shQuote()` chống command injection, `atomicWrite()` (tmp + rename),
  webhook allowlist host, `drawBox()` tự viết thay `boxen` (ESM).

## Lưu ý

Trên Linux/WSL script vẫn theo dõi presence bình thường nhưng **không mở được app** —
đó là giới hạn nền tảng, script báo lỗi rõ chứ không crash.
