// RFC 4180 CSV for the Transmission Risk Register. The live API generates the
// CSV itself (GET /v1/register?format=csv); demo mode uses this to answer the
// same request, and the dashboard uses it for nothing else.
import type { RegisterRow } from "./api/types";

export const REGISTER_COLUMNS = [
  "pu_code",
  "name",
  "ward",
  "lga",
  "state",
  "p_best",
  "p_lo",
  "p_hi",
  "n_tests",
  "carriers_seen",
  "suggested_action",
] as const satisfies readonly (keyof RegisterRow)[];

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  // Neutralise spreadsheet formula injection in text cells.
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function registerToCsv(rows: RegisterRow[]): string {
  const lines = [REGISTER_COLUMNS.join(",")];
  for (const r of rows) lines.push(REGISTER_COLUMNS.map((c) => csvCell(r[c])).join(","));
  return lines.join("\r\n") + "\r\n";
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Contract rule for suggested_action (contracts/api.md, /v1/register). */
export function suggestedAction(pBest: number): string {
  if (pBest < 0.2) return "satellite or alternate upload point";
  if (pBest < 0.5) return "alternate upload point or signal booster";
  if (pBest < 0.8) return "confirm fallback plan";
  return "monitor";
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
