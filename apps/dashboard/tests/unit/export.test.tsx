import { renderToBuffer } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";
import type { RegisterRow } from "@/lib/api/types";
import { REGISTER_COLUMNS, csvCell, parseCsv, registerToCsv, suggestedAction } from "@/lib/csv";
import { RegisterPdfDocument } from "@/lib/pdf/register-pdf";

const rows: RegisterRow[] = [
  {
    pu_code: "99-03-02-007",
    name: 'Demo "Market", Square',
    ward: "Ward G",
    lga: "Demo East",
    state: "Demo State",
    p_best: 0.04,
    p_lo: 0,
    p_hi: 0.71,
    n_tests: 0,
    carriers_seen: "",
    suggested_action: "satellite or alternate upload point",
  },
  {
    pu_code: "99-01-01-001",
    name: "=HYPERLINK(\"x\")",
    ward: "Ward A",
    lga: "Demo North",
    state: "Demo State",
    p_best: 0.9,
    p_lo: 0.82,
    p_hi: 0.95,
    n_tests: 11,
    carriers_seen: "MTN;Airtel",
    suggested_action: "monitor",
  },
];

describe("CSV", () => {
  it("writes the contract columns and round-trips quoted cells", () => {
    const parsed = parseCsv(registerToCsv(rows));
    expect(parsed[0]).toEqual([...REGISTER_COLUMNS]);
    expect(parsed[1][1]).toBe('Demo "Market", Square');
    expect(parsed[2][9]).toBe("MTN;Airtel");
    expect(parsed).toHaveLength(3);
  });

  it("neutralises spreadsheet formulas", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell(-0.5)).toBe("-0.5");
  });

  it("suggested_action follows the contract", () => {
    expect(suggestedAction(0.1)).toBe("satellite or alternate upload point");
    expect(suggestedAction(0.3)).toBe("alternate upload point or signal booster");
    expect(suggestedAction(0.6)).toBe("confirm fallback plan");
    expect(suggestedAction(0.85)).toBe("monitor");
  });
});

describe("PDF", () => {
  it("renders a PDF with every row", async () => {
    const buf = await renderToBuffer(
      <RegisterPdfDocument
        rows={rows}
        meta={{ title: "Transmission Risk Register", modelVersion: "2026-12-08.1", filters: "State: 99", generatedAt: "now", demo: true }}
      />,
    );
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(buf.length).toBeGreaterThan(1500);
  });
});
