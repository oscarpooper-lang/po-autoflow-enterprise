import type { OcrResultRecord } from '../types';

export interface ParsedCandidateJson {
  name: string;
  confidence: number;
  language: string;
  line_index?: number | null;
  source?: string | null;
}

export interface ParsedEntitiesJson {
  po_numbers?: string[];
  tax_ids?: string[];
  emails?: string[];
  supplier_candidates?: ParsedCandidateJson[];
  primary_supplier?: string | null;
  primary_confidence?: number;
  primary_supplier_th?: string | null;
  primary_supplier_en?: string | null;
}

export interface OcrSummary {
  primaryTh: string | null;
  primaryEn: string | null;
  emails: string[];
  poNumbers: string[];
  taxIds: string[];
  candidates: ParsedCandidateJson[];
}

function getFileStemLower(filePath: string): string {
  const norm = filePath.replace(/\\/g, '/');
  const base = norm.slice(norm.lastIndexOf('/') + 1).toLowerCase();
  const dotIdx = base.lastIndexOf('.');
  return dotIdx >= 0 ? base.slice(0, dotIdx) : base;
}

export function isPrimaryPurchaseOrderRecord(
  rec: OcrResultRecord,
  poFolderName?: string
): boolean {
  const norm = rec.file_path.replace(/\\/g, '/').toLowerCase();
  const fname = norm.slice(norm.lastIndexOf('/') + 1);
  const stem = getFileStemLower(rec.file_path);
  const folderLow = (poFolderName || '').trim().toLowerCase();

  const isSupportingFilename =
    fname.includes('invoice') ||
    fname.includes('quotation') ||
    fname.includes('receipt') ||
    fname.includes('delivery') ||
    fname.includes('ใบกำกับ') ||
    fname.includes('ใบแจ้งหนี้') ||
    fname.includes('ใบเสนอราคา') ||
    fname.includes('ใบเสร็จ') ||
    fname.includes('ใบส่งของ');

  if (isSupportingFilename) return false;
  if (folderLow && (stem === folderLow || stem.startsWith(folderLow))) return true;
  if (fname.startsWith('po') || fname.includes('purchase order') || fname.includes('ใบสั่งซื้อ')) {
    return true;
  }

  const rawLow = (rec.raw_text || '').toLowerCase();
  return (
    (rawLow.includes('purchase order') || rawLow.includes('ใบสั่งซื้อ')) &&
    !rawLow.includes('tax invoice') &&
    !rawLow.includes('ใบกำกับภาษี') &&
    !rawLow.includes('ใบแจ้งหนี้')
  );
}

/**
 * Summarizes extracted PO entities across all pages while prioritizing clean
 * Digital PO PDFs for supplier names and still harvesting emails/Tax IDs/PO numbers
 * from invoices and supporting attachments.
 */
export function summarizeOcrRecords(
  ocrRecords: OcrResultRecord[],
  poFolderName?: string,
  fallbackParsed?: ParsedEntitiesJson
): OcrSummary {
  const rankRecord = (rec: OcrResultRecord): number => {
    const isPo = isPrimaryPurchaseOrderRecord(rec, poFolderName);
    const isNative = rec.engine === 'native_pdf';
    if (isPo && isNative) return 0;
    if (isPo) return 1;
    if (isNative) return 2;
    return 3;
  };

  const ordered = [...ocrRecords].sort((a, b) => rankRecord(a) - rankRecord(b));

  const primaryPoTh: string[] = [];
  const primaryPoEn: string[] = [];
  const otherTh: string[] = [];
  const otherEn: string[] = [];
  const emails: string[] = [];
  const poNumbers: string[] = [];
  const taxIds: string[] = [];
  const candidates: ParsedCandidateJson[] = [];

  for (const rec of ordered) {
    if (!rec.detected_entities_json) continue;
    try {
      const parsed = JSON.parse(rec.detected_entities_json) as ParsedEntitiesJson;
      const isAuthoritativePo = rankRecord(rec) <= 1;

      if (parsed.primary_supplier_th) {
        const targetTh = isAuthoritativePo ? primaryPoTh : otherTh;
        if (!targetTh.includes(parsed.primary_supplier_th)) {
          targetTh.push(parsed.primary_supplier_th);
        }
      }
      if (parsed.primary_supplier_en) {
        const targetEn = isAuthoritativePo ? primaryPoEn : otherEn;
        if (!targetEn.includes(parsed.primary_supplier_en)) {
          targetEn.push(parsed.primary_supplier_en);
        }
      }
      for (const e of parsed.emails || []) {
        if (e && !emails.includes(e)) emails.push(e);
      }
      for (const p of parsed.po_numbers || []) {
        if (p && !poNumbers.includes(p)) poNumbers.push(p);
      }
      for (const t of parsed.tax_ids || []) {
        if (t && !taxIds.includes(t)) taxIds.push(t);
      }
      for (const c of parsed.supplier_candidates || []) {
        if (c?.name && !candidates.some((x) => x.name === c.name)) {
          candidates.push(c);
        }
      }
    } catch {
      // Ignore malformed entity JSON
    }
  }

  // Only expose noisy supporting-doc names if the primary PO document didn't provide one at all
  const hasAnyAuthoritativeName = primaryPoTh.length > 0 || primaryPoEn.length > 0;
  const primaryTh =
    primaryPoTh[0] ||
    (!hasAnyAuthoritativeName ? otherTh[0] : null) ||
    fallbackParsed?.primary_supplier_th ||
    null;
  const primaryEn =
    primaryPoEn[0] ||
    (!hasAnyAuthoritativeName ? otherEn[0] : null) ||
    fallbackParsed?.primary_supplier_en ||
    null;

  return {
    primaryTh,
    primaryEn,
    emails,
    poNumbers,
    taxIds,
    candidates,
  };
}
