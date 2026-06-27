#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getAccessToken } from "./auth.js";
import { createRequire } from "node:module";

// Đọc name/version từ package.json lúc runtime — thay vì ghi cứng, để 2 chỗ
// (MCP protocol serverInfo và npm package) luôn khớp nhau, chỉ cần bump version
// ở 1 nơi duy nhất (package.json).
const require = createRequire(import.meta.url);
const pkg: { name: string; version: string } = require("../package.json");

const MCP_SERVER_NAME = "google-sheets-oauth-mcp";
const MCP_SERVER_VERSION = pkg.version;

const SHEETS_API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";

interface GoogleApiErrorBody {
  error?: { code?: number; message?: string; status?: string };
}

async function parseGoogleError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as GoogleApiErrorBody;
    if (body?.error?.message) {
      let msg = `Google API lỗi (${res.status}): ${body.error.message}`;
      if (res.status === 403) {
        msg +=
          "\n→ Khả năng cao: tài khoản anh chưa có quyền Edit/Viewer trên sheet này, " +
          "hoặc scope OAuth đã xin chưa đủ (cần re-consent với scope mới).";
      }
      if (res.status === 404) {
        msg += "\n→ Kiểm tra lại spreadsheet_id, có thể sai hoặc anh không có quyền truy cập.";
      }
      return msg;
    }
    return `Google API lỗi (${res.status}): ${JSON.stringify(body)}`;
  } catch {
    return `Google API lỗi (${res.status}): ${res.statusText}`;
  }
}

async function googleApiFetch(
  url: string,
  method: "GET" | "PUT" | "POST" | "PATCH",
  body?: unknown
): Promise<any> {
  const token = await getAccessToken();
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(await parseGoogleError(res));
  return res.json();
}

const sheetsFetch = (path: string, method: "GET" | "PUT" | "POST", body?: unknown) =>
  googleApiFetch(`${SHEETS_API_BASE}${path}`, method, body);

const CellValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const RowsSchema = z.array(z.array(CellValue));

function spreadsheetIdField() {
  return z
    .string()
    .min(1)
    .describe(
      'ID của Google Sheet — lấy từ URL (docs.google.com/spreadsheets/d/<ID>/edit) hoặc dùng tool drive_list_spreadsheets để tìm theo tên.'
    );
}

function rangeField(example: string) {
  return z
    .string()
    .min(1)
    .describe(
      `Range theo A1 notation, ví dụ "${example}". Có thể chỉ ghi tên sheet (vd "Sheet1") để lấy/ghi cả sheet.`
    );
}

// ===== Helpers riêng cho chart: parse A1 notation -> GridRange (0-based, end-exclusive) =====

function colLetterToIndex(col: string): number {
  let result = 0;
  for (const ch of col.toUpperCase()) {
    result = result * 26 + (ch.charCodeAt(0) - 64);
  }
  return result - 1; // 0-based
}

function indexToColLetter(index: number): string {
  let result = "";
  let n = index + 1; // chuyển sang 1-based để chia base-26 đúng
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

interface ParsedRange {
  sheetName: string;
  startRowIndex: number;
  endRowIndex: number; // exclusive
  startColumnIndex: number;
  endColumnIndex: number; // exclusive
}

/** Bắt buộc format "TenSheet!A1:E20" — không hỗ trợ range mở hoặc thiếu tên sheet, để tránh đoán sai. */
function parseA1Range(a1: string): ParsedRange {
  const match = a1.match(/^([^!]+)!([A-Za-z]+)(\d+):([A-Za-z]+)(\d+)$/);
  if (!match) {
    throw new Error(
      `Range "${a1}" không đúng format. Cần dạng "TenSheet!A1:E20" (bắt buộc có tên sheet, đủ 2 góc range).`
    );
  }
  const [, sheetName, startColL, startRowS, endColL, endRowS] = match;
  return {
    sheetName,
    startRowIndex: parseInt(startRowS, 10) - 1,
    endRowIndex: parseInt(endRowS, 10), // số dòng cuối, KHÔNG -1, vì endRowIndex tự exclusive
    startColumnIndex: colLetterToIndex(startColL),
    endColumnIndex: colLetterToIndex(endColL) + 1, // +1 vì endColumnIndex exclusive
  };
}

/** Bắt buộc format "TenSheet!F2" — 1 cell duy nhất, dùng để chỉ vị trí đặt chart. */
function parseA1Cell(a1: string): { sheetName: string; rowIndex: number; columnIndex: number } {
  const match = a1.match(/^([^!]+)!([A-Za-z]+)(\d+)$/);
  if (!match) {
    throw new Error(`Cell "${a1}" không đúng format. Cần dạng "TenSheet!F2".`);
  }
  const [, sheetName, colL, rowS] = match;
  return { sheetName, rowIndex: parseInt(rowS, 10) - 1, columnIndex: colLetterToIndex(colL) };
}

async function getSheetIdByTitle(
  spreadsheet_id: string,
  title: string,
  cache: Map<string, number>
): Promise<number> {
  const cached = cache.get(title);
  if (cached !== undefined) return cached;
  const data = await sheetsFetch(`/${spreadsheet_id}?fields=sheets.properties`, "GET");
  const sheet = (data.sheets || []).find((s: any) => s.properties.title === title);
  if (!sheet) {
    throw new Error(
      `Không tìm thấy tab "${title}" trong spreadsheet. Dùng tool sheets_list_tabs để xem tên tab đúng.`
    );
  }
  cache.set(title, sheet.properties.sheetId);
  return sheet.properties.sheetId;
}

interface GridRange {
  sheetId: number;
  startRowIndex: number;
  endRowIndex: number;
  startColumnIndex: number;
  endColumnIndex: number;
}

interface ResolvedRange {
  sheetName: string;
  sheetId: number;
  gridRange: GridRange;
}

async function resolveRange(
  spreadsheet_id: string,
  a1: string,
  cache: Map<string, number>
): Promise<ResolvedRange> {
  const parsed = parseA1Range(a1);
  const sheetId = await getSheetIdByTitle(spreadsheet_id, parsed.sheetName, cache);
  return {
    sheetName: parsed.sheetName,
    sheetId,
    gridRange: {
      sheetId,
      startRowIndex: parsed.startRowIndex,
      endRowIndex: parsed.endRowIndex,
      startColumnIndex: parsed.startColumnIndex,
      endColumnIndex: parsed.endColumnIndex,
    },
  };
}

async function resolveAnchorCell(
  spreadsheet_id: string,
  a1: string,
  cache: Map<string, number>
): Promise<{ sheetId: number; rowIndex: number; columnIndex: number }> {
  const parsed = parseA1Cell(a1);
  const sheetId = await getSheetIdByTitle(spreadsheet_id, parsed.sheetName, cache);
  return { sheetId, rowIndex: parsed.rowIndex, columnIndex: parsed.columnIndex };
}

/**
 * Đọc lại 1 cột (theo GridRange), ghi đè bằng RAW để ép thành plain text.
 * Cần thiết riêng cho domain của candlestick chart: Google Sheets candlestick
 * chỉ nhận domain dạng TEXT, không nhận Date/Number — nhưng nếu data được ghi
 * trước đó bằng USER_ENTERED, Sheets tự parse "2026-05-28" thành Date type,
 * gây lỗi "Column 1 must be text" khi tạo chart. Hàm này tự fix bất kể data
 * được ghi bằng cách nào trước đó.
 */
async function forceColumnAsText(
  spreadsheet_id: string,
  sheetName: string,
  grid: GridRange
): Promise<void> {
  const col = indexToColLetter(grid.startColumnIndex);
  const startRow = grid.startRowIndex + 1;
  const endRow = grid.endRowIndex;
  const a1 = `${sheetName}!${col}${startRow}:${col}${endRow}`;

  const readResult = await sheetsFetch(
    `/${spreadsheet_id}/values/${encodeURIComponent(a1)}?valueRenderOption=FORMATTED_VALUE`,
    "GET"
  );
  const values = readResult.values || [];
  if (values.length === 0) return;

  // Bước 1: ghi RAW để giá trị thật trong cell là string literal, không phải
  // Date/Number bị parse lại.
  await sheetsFetch(
    `/${spreadsheet_id}/values/${encodeURIComponent(a1)}?valueInputOption=RAW`,
    "PUT",
    { values }
  );

  // Bước 2: ép numberFormat.type = TEXT — vì numberFormat là thuộc tính RIÊNG,
  // độc lập với giá trị cell. Cell có thể vẫn mang numberFormat "DATE" từ trước
  // (lúc USER_ENTERED parse), dù giá trị đã là string — repeatCell ở bước 1
  // không tự xóa format cũ. Candlestick chart kiểm tra numberFormat.type khi
  // quyết định "có phải text không", không chỉ giá trị thật.
  await sheetsFetch(`/${spreadsheet_id}:batchUpdate`, "POST", {
    requests: [
      {
        repeatCell: {
          range: grid,
          cell: { userEnteredFormat: { numberFormat: { type: "TEXT" } } },
          fields: "userEnteredFormat.numberFormat",
        },
      },
    ],
  });
}

/** Gửi 1 AddChartRequest qua batchUpdate, trả về chartId vừa tạo. */
async function addChart(
  spreadsheet_id: string,
  spec: Record<string, unknown>,
  anchor: { sheetId: number; rowIndex: number; columnIndex: number }
): Promise<number> {
  const body = {
    requests: [
      {
        addChart: {
          chart: {
            spec,
            position: {
              overlayPosition: {
                anchorCell: {
                  sheetId: anchor.sheetId,
                  rowIndex: anchor.rowIndex,
                  columnIndex: anchor.columnIndex,
                },
                widthPixels: 600,
                heightPixels: 371,
              },
            },
          },
        },
      },
    ],
  };
  const result = await sheetsFetch(`/${spreadsheet_id}:batchUpdate`, "POST", body);
  const chartId = result.replies?.[0]?.addChart?.chart?.chartId;
  if (chartId === undefined) {
    throw new Error("Tạo chart không trả về chartId — kiểm tra lại response Google API.");
  }
  return chartId;
}

// ---------- MCP Server ----------
const server = new McpServer({
  name: MCP_SERVER_NAME,
  version: MCP_SERVER_VERSION,
});

server.registerTool(
  "drive_list_spreadsheets",
  {
    title: "Tìm Google Sheet theo tên",
    description:
      "List các Google Sheet trong Drive của chính user đang login (không cần share thủ công, vì OAuth đại diện chính user đó). Dùng để tìm spreadsheet_id theo tên thay vì copy URL. " +
      'Trả về JSON array, mỗi item: {name, id, url, modifiedTime, owner}.',
    inputSchema: {
      name_contains: z
        .string()
        .optional()
        .describe('Lọc theo tên file chứa chuỗi này (vd "Ngân sách"). Bỏ trống để lấy gần đây nhất.'),
      max_results: z.number().int().min(1).max(50).default(10),
    },
  },
  async ({ name_contains, max_results }) => {
    try {
      const filters = ["mimeType='application/vnd.google-apps.spreadsheet'", "trashed=false"];
      if (name_contains) {
        const escaped = name_contains.replace(/'/g, "\\'");
        filters.push(`name contains '${escaped}'`);
      }
      const q = encodeURIComponent(filters.join(" and "));
      const fields = encodeURIComponent("files(id,name,modifiedTime,webViewLink,owners(displayName))");
      const data = await googleApiFetch(
        `${DRIVE_API_BASE}/files?q=${q}&fields=${fields}&orderBy=modifiedTime desc&pageSize=${max_results}`,
        "GET"
      );
      const files = data.files || [];
      const result = files.map((f: any) => ({
        name: f.name,
        id: f.id,
        url: f.webViewLink,
        modifiedTime: f.modifiedTime,
        owner: f.owners?.[0]?.displayName ?? null,
      }));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Lỗi: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

server.registerTool(
  "sheets_create",
  {
    title: "Tạo Google Sheet mới",
    description:
      "Tạo 1 spreadsheet mới (rỗng). Mặc định nằm ở root My Drive của account đang login. " +
      "Truyền folder_id nếu muốn đặt luôn vào 1 folder cụ thể.",
    inputSchema: {
      title: z.string().min(1).describe("Tên file Google Sheet mới."),
      folder_id: z
        .string()
        .optional()
        .describe(
          "ID folder Drive muốn đặt file vào (lấy từ URL folder trên Drive). " +
            "Bỏ trống -> file nằm ở root My Drive."
        ),
      sheet_titles: z
        .array(z.string())
        .optional()
        .describe('Tên các tab muốn tạo sẵn, ví dụ ["Thu","Chi"]. Bỏ trống -> 1 tab mặc định "Sheet1".'),
    },
  },
  async ({ title, folder_id, sheet_titles }) => {
    try {
      const body: Record<string, unknown> = { properties: { title } };
      if (sheet_titles && sheet_titles.length > 0) {
        body.sheets = sheet_titles.map((t) => ({ properties: { title: t } }));
      }

      const created = await sheetsFetch("", "POST", body);
      const spreadsheetId = created.spreadsheetId;
      const sheetUrl = created.spreadsheetUrl;

      if (folder_id) {
        // Drive API files.update dùng PATCH để move file (đổi parent folder).
        // Cần scope drive.file — đủ điều kiện vì file này chính app vừa tạo ra.
        await googleApiFetch(
          `${DRIVE_API_BASE}/files/${spreadsheetId}?addParents=${folder_id}&removeParents=root&fields=id,parents`,
          "PATCH"
        );
      }

      return {
        content: [
          {
            type: "text",
            text: `Đã tạo sheet "${title}".\nspreadsheet_id: ${spreadsheetId}\nURL: ${sheetUrl}${
              folder_id ? `\nĐã move vào folder: ${folder_id}` : ""
            }`,
          },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Lỗi: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.registerTool(
  "sheets_read",
  {
    title: "Đọc dữ liệu từ Google Sheet",
    description:
      "Đọc giá trị 1 vùng (range) trong Google Sheet, trả về dạng mảng 2 chiều (hàng x cột).",
    inputSchema: {
      spreadsheet_id: spreadsheetIdField(),
      range: rangeField("Sheet1!A1:D10"),
    },
  },
  async ({ spreadsheet_id, range }) => {
    try {
      const data = await sheetsFetch(`/${spreadsheet_id}/values/${encodeURIComponent(range)}`, "GET");
      const values = data.values || [];
      return {
        content: [
          {
            type: "text",
            text: values.length === 0 ? "Range trống, không có dữ liệu." : JSON.stringify(values, null, 2),
          },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Lỗi: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.registerTool(
  "sheets_write",
  {
    title: "Ghi đè dữ liệu vào Google Sheet",
    description: "Ghi đè giá trị vào 1 range cụ thể. Dữ liệu cũ trong range sẽ bị thay thế hoàn toàn.",
    inputSchema: {
      spreadsheet_id: spreadsheetIdField(),
      range: rangeField("Sheet1!A1:C3"),
      values: RowsSchema.describe(
        'Mảng 2 chiều, mỗi mảng con là 1 hàng. Ví dụ: [["Tên","Tuổi"],["Đạt",30]]'
      ),
      value_input_option: z
        .enum(["RAW", "USER_ENTERED"])
        .default("USER_ENTERED")
        .describe(
          "USER_ENTERED: Sheet tự parse như khi anh gõ tay (công thức, ngày tháng...). RAW: giữ nguyên string."
        ),
    },
  },
  async ({ spreadsheet_id, range, values, value_input_option }) => {
    try {
      const data = await sheetsFetch(
        `/${spreadsheet_id}/values/${encodeURIComponent(range)}?valueInputOption=${value_input_option}`,
        "PUT",
        { values }
      );
      return {
        content: [
          {
            type: "text",
            text: `Đã ghi ${data.updatedCells ?? "?"} cell vào range ${data.updatedRange}.`,
          },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Lỗi: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.registerTool(
  "sheets_append",
  {
    title: "Append hàng mới vào Google Sheet",
    description: "Thêm hàng mới vào cuối bảng dữ liệu hiện có (không đè dữ liệu cũ).",
    inputSchema: {
      spreadsheet_id: spreadsheetIdField(),
      range: rangeField("Sheet1 (chỉ cần tên sheet)"),
      values: RowsSchema.describe('Mảng 2 chiều, mỗi mảng con là 1 hàng cần thêm.'),
      value_input_option: z.enum(["RAW", "USER_ENTERED"]).default("USER_ENTERED"),
    },
  },
  async ({ spreadsheet_id, range, values, value_input_option }) => {
    try {
      const data = await sheetsFetch(
        `/${spreadsheet_id}/values/${encodeURIComponent(
          range
        )}:append?valueInputOption=${value_input_option}&insertDataOption=INSERT_ROWS`,
        "POST",
        { values }
      );
      const updated = data.updates;
      return {
        content: [
          {
            type: "text",
            text: `Đã append ${updated?.updatedRows ?? values.length} hàng vào ${
              updated?.updatedRange ?? range
            }.`,
          },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Lỗi: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.registerTool(
  "sheets_clear",
  {
    title: "Xóa giá trị trong 1 range",
    description: "Xóa nội dung (giá trị) trong 1 range, không xóa format/border.",
    inputSchema: {
      spreadsheet_id: spreadsheetIdField(),
      range: rangeField("Sheet1!A2:D100"),
    },
  },
  async ({ spreadsheet_id, range }) => {
    try {
      await sheetsFetch(`/${spreadsheet_id}/values/${encodeURIComponent(range)}:clear`, "POST", {});
      return { content: [{ type: "text", text: `Đã xóa dữ liệu trong range ${range}.` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Lỗi: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.registerTool(
  "sheets_list_tabs",
  {
    title: "List các tab/sheet trong file",
    description: "Liệt kê tên + ID các tab (sheet con) trong 1 Google Sheet file.",
    inputSchema: {
      spreadsheet_id: spreadsheetIdField(),
    },
  },
  async ({ spreadsheet_id }) => {
    try {
      const data = await sheetsFetch(`/${spreadsheet_id}?fields=properties.title,sheets.properties`, "GET");
      const tabs = (data.sheets || []).map((s: any) => ({
        title: s.properties.title,
        sheetId: s.properties.sheetId,
        rowCount: s.properties.gridProperties?.rowCount,
        columnCount: s.properties.gridProperties?.columnCount,
      }));
      return {
        content: [
          { type: "text", text: `File: ${data.properties?.title}\n\nTabs:\n${JSON.stringify(tabs, null, 2)}` },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Lỗi: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.registerTool(
  "sheets_create_chart",
  {
    title: "Tạo chart cơ bản trong Google Sheet",
    description:
      "Tạo 1 chart COLUMN/BAR/LINE/AREA/SCATTER/PIE từ data có sẵn, chart được embed thẳng vào tab. " +
      'Mọi range PHẢI ghi đủ tên sheet, dạng "TenSheet!A2:A10" — không hỗ trợ range thiếu tên sheet.',
    inputSchema: {
      spreadsheet_id: spreadsheetIdField(),
      chart_type: z.enum(["COLUMN", "BAR", "LINE", "AREA", "SCATTER", "PIE"]),
      title: z.string().min(1).describe("Tiêu đề chart."),
      domain_range: z
        .string()
        .describe(
          'Range nhãn trục X (category/labels), dạng "TenSheet!A2:A10". Với PIE đây là nhãn từng phần.'
        ),
      series_ranges: z
        .array(z.string())
        .min(1)
        .describe(
          'Range giá trị, mỗi string là 1 series, dạng "TenSheet!B2:B10". PIE chỉ nhận đúng 1 series.'
        ),
      stacked: z
        .boolean()
        .default(false)
        .describe("Chỉ có ý nghĩa với COLUMN/BAR/AREA. true = stacked chart."),
      anchor_cell: z
        .string()
        .optional()
        .describe(
          'Vị trí góc trên-trái đặt chart, dạng "TenSheet!F2". Bỏ trống -> tự đặt ngay bên phải domain_range.'
        ),
    },
  },
  async ({ spreadsheet_id, chart_type, title, domain_range, series_ranges, stacked, anchor_cell }) => {
    try {
      if (chart_type === "PIE" && series_ranges.length !== 1) {
        throw new Error("PIE chart chỉ nhận đúng 1 series_ranges, đang truyền " + series_ranges.length + ".");
      }

      const cache = new Map<string, number>();
      const domainResolved = await resolveRange(spreadsheet_id, domain_range, cache);
      const seriesResolved = await Promise.all(
        series_ranges.map((r) => resolveRange(spreadsheet_id, r, cache))
      );

      let spec: Record<string, unknown>;
      if (chart_type === "PIE") {
        spec = {
          title,
          pieChart: {
            legendPosition: "BOTTOM_LEGEND",
            domain: { sourceRange: { sources: [domainResolved.gridRange] } },
            series: { sourceRange: { sources: [seriesResolved[0].gridRange] } },
          },
        };
      } else {
        spec = {
          title,
          basicChart: {
            chartType: chart_type,
            legendPosition: "BOTTOM_LEGEND",
            domains: [{ domain: { sourceRange: { sources: [domainResolved.gridRange] } } }],
            series: seriesResolved.map((r) => ({ series: { sourceRange: { sources: [r.gridRange] } } })),
            ...(["COLUMN", "BAR", "AREA"].includes(chart_type) && stacked
              ? { stackedType: "STACKED" }
              : {}),
          },
        };
      }

      const anchor = anchor_cell
        ? await resolveAnchorCell(spreadsheet_id, anchor_cell, cache)
        : {
            sheetId: domainResolved.sheetId,
            rowIndex: domainResolved.gridRange.startRowIndex,
            columnIndex:
              Math.max(
                domainResolved.gridRange.endColumnIndex,
                ...seriesResolved.map((r) => r.gridRange.endColumnIndex)
              ) + 1,
          };

      const chartId = await addChart(spreadsheet_id, spec, anchor);

      return {
        content: [
          {
            type: "text",
            text: `Đã tạo ${chart_type} chart "${title}" (chartId: ${chartId}) trong tab "${domainResolved.sheetName}".`,
          },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Lỗi: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.registerTool(
  "sheets_create_candlestick_chart",
  {
    title: "Tạo candlestick chart (nến) trong Google Sheet",
    description:
      "Tạo chart nến cho dữ liệu giá (OHLC). data_range PHẢI có ĐÚNG 5 cột liên tiếp theo thứ tự cố định: " +
      "Date, Open, High, Low, Close — đúng convention chuẩn của Google Sheets (giống khi tự chọn data trên " +
      'Insert > Chart bằng tay). Ví dụ: "Data!A2:E50" (không gồm dòng header).',
    inputSchema: {
      spreadsheet_id: spreadsheetIdField(),
      title: z.string().min(1).describe("Tiêu đề chart."),
      data_range: z
        .string()
        .describe(
          'Range 5 cột liên tiếp, thứ tự CỐ ĐỊNH Date-Open-High-Low-Close, dạng "TenSheet!A2:E50". ' +
            "Không gồm dòng header."
        ),
      anchor_cell: z
        .string()
        .optional()
        .describe('Vị trí đặt chart, dạng "TenSheet!G2". Bỏ trống -> tự đặt bên phải data_range.'),
    },
  },
  async ({ spreadsheet_id, title, data_range, anchor_cell }) => {
    try {
      const cache = new Map<string, number>();
      const resolved = await resolveRange(spreadsheet_id, data_range, cache);
      const { gridRange, sheetName } = resolved;

      const width = gridRange.endColumnIndex - gridRange.startColumnIndex;
      if (width !== 5) {
        throw new Error(
          `data_range phải có ĐÚNG 5 cột theo thứ tự Date, Open, High, Low, Close — hiện tại đang có ${width} cột. ` +
            `Kiểm tra lại range "${data_range}".`
        );
      }

      const colSlice = (offset: number): GridRange => ({
        sheetId: gridRange.sheetId,
        startRowIndex: gridRange.startRowIndex,
        endRowIndex: gridRange.endRowIndex,
        startColumnIndex: gridRange.startColumnIndex + offset,
        endColumnIndex: gridRange.startColumnIndex + offset + 1,
      });

      const domainGrid = colSlice(0); // Date
      const openGrid = colSlice(1);
      const highGrid = colSlice(2);
      const lowGrid = colSlice(3);
      const closeGrid = colSlice(4);

      // Candlestick chart của Google Sheets CHỈ nhận domain dạng text — tự ép
      // lại cột Date thành plain text, bất kể trước đó được ghi bằng cách nào
      // (USER_ENTERED hay RAW), tránh lỗi "Column 1 must be text".
      await forceColumnAsText(spreadsheet_id, sheetName, domainGrid);

      const spec = {
        title,
        candlestickChart: {
          domain: { data: { sourceRange: { sources: [domainGrid] } } },
          data: [
            {
              lowSeries: { data: { sourceRange: { sources: [lowGrid] } } },
              openSeries: { data: { sourceRange: { sources: [openGrid] } } },
              closeSeries: { data: { sourceRange: { sources: [closeGrid] } } },
              highSeries: { data: { sourceRange: { sources: [highGrid] } } },
            },
          ],
        },
      };

      const anchor = anchor_cell
        ? await resolveAnchorCell(spreadsheet_id, anchor_cell, cache)
        : {
            sheetId: gridRange.sheetId,
            rowIndex: gridRange.startRowIndex,
            columnIndex: gridRange.endColumnIndex + 1,
          };

      const chartId = await addChart(spreadsheet_id, spec, anchor);

      return {
        content: [
          {
            type: "text",
            text: `Đã tạo candlestick chart "${title}" (chartId: ${chartId}) trong tab "${sheetName}".`,
          },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Lỗi: ${(err as Error).message}` }], isError: true };
    }
  }
);

// ---------- Start ----------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp-google-sheets-oauth] Server đang chạy (stdio).");
}

main().catch((err) => {
  console.error("[mcp-google-sheets-oauth] Fatal error:", err);
  process.exit(1);
});
