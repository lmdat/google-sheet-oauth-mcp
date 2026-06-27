import { OAuth2Client, Credentials } from "google-auth-library";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { URL } from "node:url";
import { exec } from "node:child_process";

const TOKEN_DIR =
  process.env.MCP_GSHEETS_TOKEN_DIR || path.join(os.homedir(), ".mcp-google-sheets");
const TOKEN_PATH = path.join(TOKEN_DIR, "token.json");

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const REDIRECT_PORT = Number(process.env.GOOGLE_OAUTH_REDIRECT_PORT || 53682);
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/oauth2callback`;

// drive.readonly: chỉ để LIST tên file (tool drive_list_spreadsheets) — thấy được
//   mọi sheet user đã có quyền, kể cả sheet không phải do app này tạo.
// drive.file: chỉ thấy/sửa được file mà CHÍNH APP NÀY tạo ra (hoặc user chọn qua
//   Picker) — đủ để move file mới tạo vào 1 folder cụ thể, KHÔNG đủ để move/sửa
//   file cũ không phải do app tạo (đó là lý do cần drive.readonly riêng cho việc đọc).
const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.file",
];

function createOAuthClient(): OAuth2Client {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error(
      "Thiếu GOOGLE_OAUTH_CLIENT_ID hoặc GOOGLE_OAUTH_CLIENT_SECRET trong env. " +
        "Lấy 2 giá trị này từ OAuth Client (loại 'Desktop app') trong Google Cloud Console."
    );
  }
  return new OAuth2Client({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
  });
}

function loadSavedTokens(client: OAuth2Client): boolean {
  if (!fs.existsSync(TOKEN_PATH)) return false;
  const tokens: Credentials = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
  client.setCredentials(tokens);
  return true;
}

function saveTokens(tokens: Credentials): void {
  fs.mkdirSync(TOKEN_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

function tryOpenBrowser(url: string): void {
  const platform = process.platform;
  const cmd =
    platform === "darwin" ? `open "${url}"` : platform === "win32" ? `start "" "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {
    /* im lặng nếu fail — user vẫn có URL in ra console để tự mở */
  });
}

/**
 * Chạy lần đầu khi chưa có token: mở local HTTP server tạm trên REDIRECT_PORT,
 * in ra URL consent, đợi Google redirect về kèm "code", đổi code lấy
 * access_token + refresh_token, rồi lưu xuống disk.
 */
async function runConsentFlow(client: OAuth2Client): Promise<void> {
  const authUrl = client.generateAuthUrl({
    access_type: "offline", // bắt buộc để nhận refresh_token, không chỉ access_token
    scope: SCOPES,
    prompt: "consent", // luôn hỏi lại consent — đảm bảo chắc chắn nhận refresh_token
                        // (Google chỉ trả refresh_token ở lần consent ĐẦU TIÊN nếu thiếu prompt=consent)
  });

  console.error(
    `\n[mcp-google-sheets-oauth] Chưa có token. Mở URL sau để đăng nhập (đang tự mở browser...):\n${authUrl}\n`
  );
  tryOpenBrowser(authUrl);

  const code: string = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // QUAN TRỌNG: Node http server không tự set charset — thiếu header này,
      // browser tự đoán encoding (thường đoán sai) -> tiếng Việt ra mojibake.
      res.setHeader("Content-Type", "text/html; charset=utf-8");

      const url = new URL(req.url || "", REDIRECT_URI);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.end("Đăng nhập bị từ chối hoặc lỗi. Đóng tab này, xem log ở terminal.");
        server.close();
        reject(new Error(`Google trả lỗi OAuth: ${error}`));
        return;
      }
      if (code) {
        res.end(
          "<h2>Đăng nhập thành công!</h2><p>Đóng tab này và quay lại terminal/opencode.</p>"
        );
        server.close();
        resolve(code);
        return;
      }
      res.end("Thiếu tham số code/error trong redirect.");
    });
    server.listen(REDIRECT_PORT, "127.0.0.1");
  });

  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  saveTokens(tokens);
  console.error(`[mcp-google-sheets-oauth] Đã lưu token vào: ${TOKEN_PATH}`);
}

let cachedClient: OAuth2Client | null = null;

/**
 * Trả về 1 OAuth2Client đã sẵn sàng dùng (có credentials hợp lệ).
 * - Lần đầu chạy: không có file token -> kích hoạt consent flow.
 * - Các lần sau: load refresh_token từ file, tự refresh access_token khi cần.
 * - Nếu Google rotate refresh_token mới, tự ghi đè lại file token.
 */
export async function getAuthorizedClient(): Promise<OAuth2Client> {
  if (cachedClient) return cachedClient;

  const client = createOAuthClient();
  const hasTokens = loadSavedTokens(client);

  if (!hasTokens) {
    await runConsentFlow(client);
  }

  client.on("tokens", (tokens) => {
    // event này bắn ra mỗi khi library tự refresh access_token ngầm.
    // Merge với credentials hiện có vì response refresh đôi khi không kèm refresh_token mới.
    const merged = { ...client.credentials, ...tokens };
    saveTokens(merged);
  });

  cachedClient = client;
  return client;
}

export async function getAccessToken(): Promise<string> {
  const client = await getAuthorizedClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error("Không lấy được access token từ OAuth client.");
  return token;
}

export function getTokenPath(): string {
  return TOKEN_PATH;
}
