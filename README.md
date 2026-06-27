# @lmdat/google-sheets-oauth-mcp

Local MCP server (Node.js + TypeScript) đọc/ghi/tạo Google Sheets, kèm tạo chart, thông qua
**OAuth** — server hoạt động đại diện chính tài khoản Google đang đăng nhập, không cần share
thủ công từng file như cách dùng Service Account.

## Yêu cầu

- Node.js 18+
- Tài khoản Google (cá nhân hoặc Workspace)
- 1 project trên Google Cloud Console

## 1. Setup Google Cloud Console

1. Vào [console.cloud.google.com](https://console.cloud.google.com), tạo hoặc chọn 1 project.
2. **APIs & Services → Library** → enable **Google Sheets API** và **Google Drive API**.
3. **APIs & Services → OAuth consent screen**:
   - User type: chọn **External** (tài khoản Gmail cá nhân chỉ có lựa chọn này; **Internal**
     chỉ dành cho tài khoản Google Workspace).
   - Điền App name và support email (giá trị tùy ý, không ảnh hưởng chức năng).
   - Sau khi tạo, vào tab **Audience** → bấm **Publish App** → Confirm. Bước này nên làm ngay
     từ đầu — nếu bỏ qua, app ở trạng thái Testing và refresh token sẽ tự hết hạn sau 7 ngày.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Desktop app** (không chọn Web application).
   - Lưu lại `Client ID` và `Client secret` hiện ra sau khi tạo.

## 2. Cài đặt

```bash
npm install
```

## 3. Build

| Lệnh                       | Output                                         | Dùng khi nào                                                                        |
| --------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| `npm run build`           | `build/index.js` + `build/auth.js`         | Phát triển/debug, code dễ đọc                                                    |
| `npm run build:min`       | `dist/index.js` (1 file, đã gộp + minify) | Dùng để chạy thật / publish                                                      |
| `npm run build:obfuscate` | `dist/index.js` (đã obfuscate)             | Muốn code khó đọc hơn khi chia sẻ (không phải mã hóa, chỉ gây khó đọc) |

Build tối thiểu 1 lần trước khi cấu hình opencode ở bước tiếp theo.

## 4. Cấu hình credential

```bash
export GOOGLE_OAUTH_CLIENT_ID="xxx.apps.googleusercontent.com"
export GOOGLE_OAUTH_CLIENT_SECRET="GOCSPX-xxx"
```

Hoặc khai báo trực tiếp trong config opencode ở bước 5 (mục `environment`), không cần export
ra shell.

**Biến môi trường optional:**

| Var                            | Default                  | Khi nào cần đổi                         |
| ------------------------------ | ------------------------ | ------------------------------------------- |
| `GOOGLE_OAUTH_REDIRECT_PORT` | `53682`                | Port bị chương trình khác chiếm dụng |
| `MCP_GSHEETS_TOKEN_DIR`      | `~/.mcp-google-sheets` | Muốn lưu file token ở vị trí khác     |

## 5. Cấu hình trong opencode

Có 2 cách trỏ tới MCP server, chọn 1 trong 2.

### Cách 1 — Trỏ trực tiếp đến file (đơn giản, không cần publish)

```json
"google-sheets": {
  "type": "local",
  "command": [
    "node",
    "/duong-dan-tuyet-doi/google-sheets-oauth-mcp/dist/index.js"
  ],
  "enabled": true,
  "environment": {
    "GOOGLE_OAUTH_CLIENT_ID": "xxx.apps.googleusercontent.com",
    "GOOGLE_OAUTH_CLIENT_SECRET": "GOCSPX-xxx"
  }
}
```

Thay `/duong-dan-tuyet-doi/...` bằng đường dẫn thật trên máy đang chạy opencode. Phù hợp khi
chỉ dùng trên 1 máy, không cần chia sẻ cho người khác.

### Cách 2 — Dùng qua npm package (cần publish trước)

Nếu package đã được publish lên npm registry (xem mục 8), cấu hình gọn hơn, không cần biết
đường dẫn cụ thể trên máy:

```json
"google-sheets": {
  "type": "local",
  "command": [
    "npx",
    "-y",
    "@lmdat/google-sheets-oauth-mcp@latest"
  ],
  "enabled": true,
  "environment": {
    "GOOGLE_OAUTH_CLIENT_ID": "xxx.apps.googleusercontent.com",
    "GOOGLE_OAUTH_CLIENT_SECRET": "GOCSPX-xxx"
  }
}
```

## 6. Lần đầu sử dụng — cần đăng nhập 1 lần

Khi opencode gọi tool đầu tiên (ví dụ `drive_list_spreadsheets`), server sẽ:

1. Tự mở browser (hoặc in URL ra log nếu máy không tự mở được trình duyệt — copy URL đó dán
   vào browser thủ công).
2. Đăng nhập Google và bấm Allow.
3. Browser hiện thông báo đăng nhập thành công → token được lưu vào
   `~/.mcp-google-sheets/token.json`.

Từ lần sau không cần đăng nhập lại — token tự refresh ngầm.

> Flow này cần trình duyệt **trên cùng máy** đang chạy MCP server, vì server mở 1 HTTP server
> tạm trên `127.0.0.1` để nhận redirect từ Google. Nếu server được chạy trên môi trường không
> có giao diện (ví dụ VPS headless), flow này sẽ không hoạt động và cần cách xác thực khác.

## 7. Đổi scope sau này → phải đăng nhập lại

Nếu chỉnh sửa danh sách scope trong `src/auth.ts`, cần xóa file token cũ
(`~/.mcp-google-sheets/token.json`) rồi chạy lại để đăng nhập lại. Google gắn cố định scope vào
thời điểm cấp quyền — token cũ không tự nhận thêm quyền mới.

## 8. (Tùy chọn) Publish lên npm để dùng theo Cách 2

```bash
npm login                       # nếu chưa đăng nhập npm
npm run build:min
npm publish --access public     # bắt buộc thêm flag này nếu dùng scoped package (@username/...)
```

Kiểm tra trước khi publish thật:

```bash
npm run build:min && npm pack --dry-run
```

## 9. Danh sách tool

| Tool                                | Chức năng                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------- |
| `drive_list_spreadsheets`         | Tìm sheet theo tên (Drive API), không cần biết ID trước                  |
| `sheets_create`                   | Tạo sheet mới, tùy chọn đặt vào folder cụ thể và tạo sẵn nhiều tab |
| `sheets_read`                     | Đọc 1 range, trả về mảng 2 chiều                                          |
| `sheets_write`                    | Ghi đè giá trị trong 1 range                                                |
| `sheets_append`                   | Thêm hàng vào cuối bảng dữ liệu hiện có                                |
| `sheets_clear`                    | Xóa giá trị trong 1 range (giữ nguyên format)                              |
| `sheets_list_tabs`                | Liệt kê tên các tab trong file                                              |
| `sheets_create_chart`             | Tạo chart COLUMN/BAR/LINE/AREA/SCATTER/PIE từ dữ liệu có sẵn              |
| `sheets_create_candlestick_chart` | Tạo chart nến (OHLC) cho dữ liệu giá                                       |

Mọi tool đọc/ghi (trừ `drive_list_spreadsheets` và `sheets_create`) đều cần `spreadsheet_id` —
lấy từ URL của sheet hoặc dùng `drive_list_spreadsheets` để tìm theo tên.

### Lưu ý khi dùng 2 tool tạo chart

- Mọi range truyền vào **phải ghi đủ tên sheet**, theo dạng `"TenSheet!A2:E50"`. Range thiếu
  tên sheet không được hỗ trợ.
- `sheets_create_candlestick_chart` yêu cầu `data_range` có **đúng 5 cột liên tiếp**, theo thứ
  tự cố định: **Date, Open, High, Low, Close** — đúng convention chuẩn của Google Sheets khi
  chọn data bằng tay qua Insert > Chart. Sai thứ tự cột (ví dụ đảo Open/Close) **không gây ra
  lỗi** — chart vẫn được tạo nhưng màu nến hiển thị ngược nghĩa, cần tự kiểm tra bằng mắt sau
  khi tạo.
- `anchor_cell` (vị trí đặt chart) là optional ở cả 2 tool — nếu không truyền, chart tự đặt
  ngay bên phải vùng dữ liệu nguồn.

## 10. Scope OAuth đang sử dụng

```typescript
const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",    // đọc/ghi/tạo sheet
  "https://www.googleapis.com/auth/drive.readonly",  // tìm/list toàn bộ sheet user có quyền
  "https://www.googleapis.com/auth/drive.file",       // move file mới tạo vào folder
];
```

`drive.file` chỉ cho phép truy cập file do chính app này tạo ra (hoặc do user chọn qua
Picker) — không đủ để di chuyển hay sửa file cũ không phải do app tạo. Vì vậy cần thêm
`drive.readonly` riêng cho việc tìm/list sheet có sẵn. Scope `drive` (toàn quyền) không được
sử dụng vì rộng hơn mức cần thiết.

## 11. Ví dụ câu lệnh trong opencode

```
Tìm sheet có chữ "Ngân sách"
Tạo sheet mới tên "Theo dõi cổ phiếu 2026" với 2 tab: Giao dịch, Tổng hợp
Đọc A1:E20 trong tab Giao dịch của sheet [tên/id vừa tạo]
Append 1 hàng vào tab Giao dịch: 2026-06-25, VNM, Buy, 1000, 42500
Tạo candlestick chart "Giá VNM Q2 2026" từ range Data!A2:E50
```

## 12. So sánh với bản dùng Service Account

|                          | Service Account                               | OAuth (bản này)                                                       |
| ------------------------ | --------------------------------------------- | ----------------------------------------------------------------------- |
| Truy cập sheet có sẵn | Phải share thủ công email service account  | Tự thấy mọi sheet user đã có quyền                               |
| Tìm sheet theo tên     | Không hỗ trợ                               | Có, qua`drive_list_spreadsheets`                                     |
| File mới tạo           | Thuộc Drive của service account             | Thuộc Drive của chính user                                           |
| Setup ban đầu          | Nhanh, không cần đăng nhập trình duyệt | Cần đăng nhập trình duyệt 1 lần, cấu hình OAuth consent screen |
| Phù hợp                | Vài sheet cố định, biết trước ID       | Cần linh hoạt nhiều sheet, tạo/tìm theo tên                       |
