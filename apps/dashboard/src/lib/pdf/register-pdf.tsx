// Transmission Risk Register as PDF, rendered in the browser with
// @react-pdf/renderer (loaded on demand). Built-in Helvetica covers Latin-1
// only, so the PDF is in English; see README.
import { Document, Page, StyleSheet, Text, View, pdf } from "@react-pdf/renderer";
import type { RegisterRow } from "../api/types";
import { formatEstimate } from "../format";

export interface RegisterPdfMeta {
  title: string;
  modelVersion: string | null;
  filters: string;
  generatedAt: string;
  demo: boolean;
}

const s = StyleSheet.create({
  page: { padding: 28, fontSize: 8.5, fontFamily: "Helvetica", color: "#111827" },
  title: { fontSize: 15, fontFamily: "Helvetica-Bold", marginBottom: 4 },
  meta: { fontSize: 8.5, color: "#4b5563", marginBottom: 2 },
  demo: { fontSize: 10, fontFamily: "Helvetica-Bold", color: "#5b4300", backgroundColor: "#fff7db", padding: 6, marginVertical: 6 },
  table: { marginTop: 8, borderTopWidth: 1, borderColor: "#d8dde5" },
  row: { flexDirection: "row", borderBottomWidth: 0.5, borderColor: "#d8dde5", paddingVertical: 3 },
  head: { fontFamily: "Helvetica-Bold", backgroundColor: "#eef1f5" },
  footer: { position: "absolute", bottom: 14, left: 28, right: 28, fontSize: 7.5, color: "#4b5563", flexDirection: "row", justifyContent: "space-between" },
});

const COLS: { key: string; label: string; width: string }[] = [
  { key: "rank", label: "#", width: "4%" },
  { key: "pu_code", label: "PU code", width: "11%" },
  { key: "name", label: "Name", width: "19%" },
  { key: "ward", label: "Ward", width: "9%" },
  { key: "lga", label: "LGA", width: "10%" },
  { key: "chance", label: "Upload chance (likely range)", width: "14%" },
  { key: "n_tests", label: "Tests", width: "6%" },
  { key: "carriers_seen", label: "Networks seen", width: "11%" },
  { key: "suggested_action", label: "Suggested action", width: "16%" },
];

export const PDF_COLUMNS = COLS.map((c) => c.label);

function cell(r: RegisterRow, i: number, key: string): string {
  switch (key) {
    case "rank":
      return String(i + 1);
    case "chance":
      return formatEstimate(r.p_best, r.p_lo, r.p_hi);
    case "carriers_seen":
      return r.carriers_seen.split(";").filter(Boolean).join(", ") || "-";
    default:
      return String(r[key as keyof RegisterRow] ?? "");
  }
}

export function RegisterPdfDocument({ rows, meta }: { rows: RegisterRow[]; meta: RegisterPdfMeta }) {
  return (
    <Document title={meta.title} author="Proof of Signal" subject="Transmission Risk Register">
      <Page size="A4" orientation="landscape" style={s.page}>
        <Text style={s.title}>{meta.title}</Text>
        {meta.demo ? <Text style={s.demo}>SYNTHETIC DEMO DATA - state 99 does not exist; nothing here is real.</Text> : null}
        <Text style={s.meta}>Model version: {meta.modelVersion ?? "-"}</Text>
        <Text style={s.meta}>Filters: {meta.filters}</Text>
        <Text style={s.meta}>Generated: {meta.generatedAt}</Text>
        <Text style={s.meta}>
          Upload chance = probability that a 1.5 MB upload succeeds in the evening on the best network, with its likely range. No vote
          figures.
        </Text>
        <View style={s.table}>
          <View style={[s.row, s.head]} fixed>
            {COLS.map((c) => (
              <Text key={c.key} style={{ width: c.width, paddingRight: 4 }}>
                {c.label}
              </Text>
            ))}
          </View>
          {rows.map((r, i) => (
            <View key={r.pu_code} style={s.row} wrap={false}>
              {COLS.map((c) => (
                <Text key={c.key} style={{ width: c.width, paddingRight: 4 }}>
                  {cell(r, i, c.key)}
                </Text>
              ))}
            </View>
          ))}
        </View>
        <View style={s.footer} fixed>
          <Text>Proof of Signal - Transmission Risk Register{meta.demo ? " - SYNTHETIC DEMO DATA" : ""}</Text>
          <Text render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

export async function renderRegisterPdf(rows: RegisterRow[], meta: RegisterPdfMeta): Promise<Blob> {
  return pdf(<RegisterPdfDocument rows={rows} meta={meta} />).toBlob();
}
