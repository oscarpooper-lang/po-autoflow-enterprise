export interface BoundingBoxRecord {
  box?: unknown;
  norm?: [number, number, number, number];
  space?: [number, number];
  text?: string;
  confidence?: number;
  type?: string;
}

export type BoxKind = 'supplier' | 'email' | 'po' | 'dept' | 'text';

export interface ResolvedBoxOverlay {
  index: number;
  left: number;
  top: number;
  width: number;
  height: number;
  text: string;
  confidence?: number;
  type: string;
  kind: BoxKind;
}

export function classifyBoxText(text: string): BoxKind {
  const cleaned = text.trim();
  if (!cleaned) return 'text';
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(cleaned)) {
    return 'email';
  }
  if (/\b(?:PO|P\.?O\.?)[-\s]?\d{4,}/i.test(cleaned)) {
    return 'po';
  }
  if (/แผนก|ฝ่าย|ส่วน|dept\.?|department/i.test(cleaned)) {
    return 'dept';
  }
  if (
    /บริษัท|ห้างหุ้นส่วน|หจก\.?|บจก\.?|co\.?,?\s*ltd|limited|partnership|corp\.?|inc\.?|pcl\.?|plc\.?/i.test(
      cleaned
    )
  ) {
    return 'supplier';
  }
  return 'text';
}

export function formatBoxCoords(box: unknown): string {
  if (!Array.isArray(box)) return '—';
  if (box.length === 4 && typeof box[0] === 'number') {
    return `[${box.map((n) => Math.round(Number(n))).join(', ')}]`;
  }
  if (box.length > 0 && Array.isArray(box[0])) {
    const first = box[0] as number[];
    const third = (box[2] as number[]) || first;
    return `[${Math.round(first[0] ?? 0)}, ${Math.round(first[1] ?? 0)} → ${Math.round(
      third[0] ?? 0
    )}, ${Math.round(third[1] ?? 0)}]`;
  }
  return JSON.stringify(box);
}

function extractRawBounds(rawBox: unknown): [number, number, number, number] | null {
  if (!Array.isArray(rawBox) || rawBox.length < 4) return null;
  if (typeof rawBox[0] === 'number') {
    const x0 = Number(rawBox[0]);
    const y0 = Number(rawBox[1]);
    const x1 = Number(rawBox[2]);
    const y1 = Number(rawBox[3]);
    if (![x0, y0, x1, y1].every(Number.isFinite)) return null;
    return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
  }
  if (Array.isArray(rawBox[0])) {
    const pts = rawBox as number[][];
    const xs = pts.map((p) => Number(p?.[0] ?? NaN)).filter(Number.isFinite);
    const ys = pts.map((p) => Number(p?.[1] ?? NaN)).filter(Number.isFinite);
    if (xs.length < 2 || ys.length < 2) return null;
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  return null;
}

/**
 * Resolves stored OCR/native bounding boxes into clean 0..100% page coordinates.
 * Prefers worker-emitted normalized (`norm`) and coordinate-space (`space`) metadata,
 * with a uniform page-level scale fallback for legacy SQLite records so top-left and
 * bottom-right boxes never drift into different coordinate scales.
 */
export function resolvePageBoxes(
  boxes: BoundingBoxRecord[],
  pageW: number,
  pageH: number
): ResolvedBoxOverlay[] {
  if (!boxes.length || pageW <= 0 || pageH <= 0) return [];

  // Precompute a single uniform scale for any legacy OCR boxes lacking norm/space metadata
  let legacyMaxX = 0;
  let legacyMaxY = 0;
  let hasLegacyOcr = false;
  for (const b of boxes) {
    if (b.norm || b.space || b.type !== 'ocr') continue;
    const raw = extractRawBounds(b.box);
    if (!raw) continue;
    hasLegacyOcr = true;
    if (raw[2] > legacyMaxX) legacyMaxX = raw[2];
    if (raw[3] > legacyMaxY) legacyMaxY = raw[3];
  }

  let legacyOcrScale = 1;
  if (hasLegacyOcr && (legacyMaxX > pageW * 1.03 || legacyMaxY > pageH * 1.03)) {
    const candidates = [1, 150 / 72, 200 / 72, 300 / 72, 400 / 72];
    const matched = candidates.find(
      (s) => legacyMaxX <= pageW * s * 1.04 && legacyMaxY <= pageH * s * 1.04
    );
    legacyOcrScale = matched ?? Math.max(legacyMaxX / pageW, legacyMaxY / pageH, 1);
  }

  const out: ResolvedBoxOverlay[] = [];
  boxes.forEach((b, index) => {
    let left = 0;
    let top = 0;
    let width = 0;
    let height = 0;

    if (
      Array.isArray(b.norm) &&
      b.norm.length === 4 &&
      b.norm.every((v) => typeof v === 'number' && Number.isFinite(v))
    ) {
      const nx0 = Math.max(0, Math.min(1, b.norm[0]));
      const ny0 = Math.max(0, Math.min(1, b.norm[1]));
      const nx1 = Math.max(nx0, Math.min(1, b.norm[2]));
      const ny1 = Math.max(ny0, Math.min(1, b.norm[3]));
      left = nx0 * 100;
      top = ny0 * 100;
      width = Math.max(0.4, Math.min(100 - left, (nx1 - nx0) * 100));
      height = Math.max(0.4, Math.min(100 - top, (ny1 - ny0) * 100));
    } else {
      const raw = extractRawBounds(b.box);
      if (!raw) return;
      const [x0, y0, x1, y1] = raw;

      const hasSpace =
        Array.isArray(b.space) &&
        b.space.length === 2 &&
        Number(b.space[0]) > 0 &&
        Number(b.space[1]) > 0;
      const effW = hasSpace
        ? Number(b.space![0])
        : pageW * (b.type === 'ocr' ? legacyOcrScale : 1);
      const effH = hasSpace
        ? Number(b.space![1])
        : pageH * (b.type === 'ocr' ? legacyOcrScale : 1);

      if (effW <= 0 || effH <= 0) return;

      left = Math.max(0, Math.min(100, (x0 / effW) * 100));
      top = Math.max(0, Math.min(100, (y0 / effH) * 100));
      width = Math.max(0.4, Math.min(100 - left, ((x1 - x0) / effW) * 100));
      height = Math.max(0.4, Math.min(100 - top, ((y1 - y0) / effH) * 100));
    }

    const text = (b.text || '').trim();
    out.push({
      index,
      left,
      top,
      width,
      height,
      text,
      confidence: b.confidence,
      type: b.type || 'block',
      kind: classifyBoxText(text),
    });
  });

  return out;
}
