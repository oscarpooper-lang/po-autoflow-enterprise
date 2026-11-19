import React, { useMemo, useState } from 'react';
import { AlertTriangle, FileText, Loader2, MousePointerClick } from 'lucide-react';
import type { PagePreviewResponse } from '../types';
import { tx, type UiLang } from '../i18n';
import {
  resolvePageBoxes,
  type BoundingBoxRecord,
  type BoxKind,
  type ResolvedBoxOverlay,
} from '../utils/boxGeometry';

interface DocumentPageViewerProps {
  preview: PagePreviewResponse | null;
  isLoading: boolean;
  previewError: string | null;
  boxes?: BoundingBoxRecord[];
  showBoxes?: boolean;
  zoomLevel: number;
  onZoomChange?: (nextZoom: number) => void;
  fileLabel: string;
  emptyTitle?: string;
  emptyAction?: React.ReactNode;
  fallbackText?: string;
  onBoxClick?: (text: string) => void;
  onViewTextFallback?: () => void;
  onOpenExternal?: () => void;
  lang?: UiLang;
  compact?: boolean;
}

const BOX_KIND_STYLES: Record<BoxKind, string> = {
  supplier: 'border-emerald-400/70 bg-emerald-400/10 hover:bg-emerald-400/25 hover:border-emerald-300',
  email: 'border-cyan-400/75 bg-cyan-400/10 hover:bg-cyan-400/25 hover:border-cyan-300',
  po: 'border-amber-400/75 bg-amber-400/10 hover:bg-amber-400/25 hover:border-amber-300',
  dept: 'border-purple-400/75 bg-purple-400/10 hover:bg-purple-400/25 hover:border-purple-300',
  text: 'border-sky-400/45 bg-sky-400/5 hover:bg-sky-400/20 hover:border-sky-300',
};

const BOX_KIND_BADGES: Record<BoxKind, { en: string; th: string; cls: string }> = {
  supplier: { en: 'Supplier', th: 'ผู้ขาย', cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' },
  email: { en: 'Email', th: 'อีเมล', cls: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40' },
  po: { en: 'PO #', th: 'เลข PO', cls: 'bg-amber-500/20 text-amber-300 border-amber-500/40' },
  dept: { en: 'Dept', th: 'แผนก', cls: 'bg-purple-500/20 text-purple-300 border-purple-500/40' },
  text: { en: 'Text', th: 'ข้อความ', cls: 'bg-sky-500/20 text-sky-300 border-sky-500/40' },
};

export const DocumentPageViewer: React.FC<DocumentPageViewerProps> = React.memo(
  ({
    preview,
    isLoading,
    previewError,
    boxes = [],
    showBoxes = false,
    zoomLevel,
    onZoomChange,
    fileLabel,
    emptyTitle,
    emptyAction,
    fallbackText,
    onBoxClick,
    onViewTextFallback,
    onOpenExternal,
    lang = 'en',
    compact = false,
  }) => {
    const [hoveredBox, setHoveredBox] = useState<ResolvedBoxOverlay | null>(null);

    const resolvedBoxes = useMemo(() => {
      if (!showBoxes || !preview?.page_width || !preview?.page_height || boxes.length === 0) {
        return [];
      }
      return resolvePageBoxes(boxes, preview.page_width, preview.page_height);
    }, [showBoxes, preview?.page_width, preview?.page_height, boxes]);

    const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
      if (!onZoomChange || (!e.ctrlKey && !e.metaKey)) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? 15 : -15;
      const next = Math.max(50, Math.min(240, zoomLevel + delta));
      onZoomChange(next);
    };

    const imgWidth = preview?.render_width || Math.round(preview?.page_width || 800);
    const imgHeight = preview?.render_height || Math.round(preview?.page_height || 1100);
    const aspectRatio =
      preview?.page_width && preview?.page_height
        ? `${preview.page_width} / ${preview.page_height}`
        : `${imgWidth} / ${imgHeight}`;

    return (
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
        {/* Fixed-height status strip prevents ANY document shift/jitter when hovering overlays */}
        {showBoxes && (
          <div className="h-8 px-3 bg-zinc-950/90 border-b border-zinc-800 flex items-center gap-2 text-xs shrink-0 overflow-hidden">
            {hoveredBox ? (
              <>
                <span
                  className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold shrink-0 ${
                    BOX_KIND_BADGES[hoveredBox.kind].cls
                  }`}
                >
                  {lang === 'th'
                    ? BOX_KIND_BADGES[hoveredBox.kind].th
                    : BOX_KIND_BADGES[hoveredBox.kind].en}
                </span>
                <span className="font-mono text-zinc-100 truncate flex-1">{hoveredBox.text || '—'}</span>
                {typeof hoveredBox.confidence === 'number' && (
                  <span className="text-[10px] font-mono text-zinc-400 shrink-0">
                    {(hoveredBox.confidence <= 1
                      ? hoveredBox.confidence * 100
                      : hoveredBox.confidence
                    ).toFixed(0)}
                    %
                  </span>
                )}
              </>
            ) : (
              <span className="text-zinc-500 flex items-center gap-1.5 truncate">
                <MousePointerClick className="w-3.5 h-3.5 text-zinc-600 shrink-0" />
                <span className="truncate">
                  {tx(
                    lang,
                    'Hover or click any highlighted box to copy it into the approval form (Ctrl + Scroll to zoom).',
                    'ชี้หรือคลิกกรอบข้อความบนเอกสารเพื่อเติมลงฟอร์มส่งเมล (กด Ctrl + เลื่อนเมาส์เพื่อซูม)'
                  )}
                </span>
              </span>
            )}
          </div>
        )}

        {/* Isolated Scroll & Paint Viewport (CLS-free & containment-scoped) */}
        <div
          onWheel={handleWheel}
          style={{ contain: 'layout style paint' }}
          className={`flex-1 overflow-auto min-h-0 ${compact ? 'bg-zinc-950 p-3' : 'bg-[#09090b] p-4'}`}
        >
          {isLoading ? (
            <div className="h-full flex flex-col items-center justify-center text-zinc-400 space-y-2">
              <Loader2 className="w-7 h-7 animate-spin text-blue-400" />
              <span className="text-xs">
                {tx(lang, 'Rendering page preview...', 'กำลังโหลดภาพหน้าเอกสาร...')}
              </span>
            </div>
          ) : preview?.data_url ? (
            <div
              className="mx-auto rounded border border-zinc-700 shadow-2xl bg-white overflow-hidden select-none"
              style={{
                width: `${zoomLevel}%`,
                minWidth: zoomLevel > 100 ? `${zoomLevel}%` : undefined,
              }}
            >
              {/* Borderless exact-aspect canvas so image & percentage overlay boxes align pixel-for-pixel */}
              <div className="relative w-full" style={{ aspectRatio }}>
                <img
                  src={preview.data_url}
                  alt={fileLabel}
                  width={imgWidth}
                  height={imgHeight}
                  draggable={false}
                  className="w-full h-full block object-contain"
                />
                {showBoxes && resolvedBoxes.length > 0 && (
                  <div className="absolute inset-0 pointer-events-none">
                    {resolvedBoxes.map((b) => (
                      <button
                        key={b.index}
                        type="button"
                        onMouseEnter={() => setHoveredBox(b)}
                        onMouseLeave={() =>
                          setHoveredBox((prev) => (prev?.index === b.index ? null : prev))
                        }
                        onClick={() => onBoxClick?.(b.text)}
                        title={b.text}
                        style={{
                          left: `${b.left}%`,
                          top: `${b.top}%`,
                          width: `${b.width}%`,
                          height: `${b.height}%`,
                        }}
                        className={`pointer-events-auto absolute border transition-colors cursor-pointer ${
                          BOX_KIND_STYLES[b.kind]
                        }`}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : previewError ? (
            compact && fallbackText ? (
              <div className="w-full text-left space-y-2 p-2">
                <p className="text-[11px] text-amber-400">
                  {previewError === '__UNAVAILABLE__'
                    ? tx(lang, 'Preview not available for this file.', 'ไม่สามารถแสดงพรีวิวของไฟล์นี้ได้')
                    : previewError}
                </p>
                <pre className="text-xs font-mono text-zinc-300 whitespace-pre-wrap leading-relaxed">
                  {fallbackText}
                </pre>
              </div>
            ) : (
              <div className="p-6 rounded-xl bg-[#121215] border border-zinc-800 text-center space-y-3 max-w-md mx-auto my-8">
                <AlertTriangle className="w-8 h-8 text-amber-400 mx-auto" />
                <p className="text-xs text-zinc-300 font-medium">
                  {previewError === '__UNAVAILABLE__'
                    ? tx(lang, 'Visual preview unavailable for this file.', 'ไม่สามารถแสดงภาพตัวอย่างของไฟล์นี้ได้')
                    : previewError || tx(lang, 'Could not render live page preview.', 'ไม่สามารถแสดงภาพตัวอย่างของหน้านี้ได้')}
                </p>
                <div className="flex justify-center gap-2">
                  {onViewTextFallback && (
                    <button
                      type="button"
                      onClick={onViewTextFallback}
                      className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium"
                    >
                      {tx(lang, 'View Extracted Text', 'ดูข้อความที่อ่านได้')}
                    </button>
                  )}
                  {onOpenExternal && (
                    <button
                      type="button"
                      onClick={onOpenExternal}
                      className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium"
                    >
                      {tx(lang, 'Open PDF Externally', 'เปิด PDF ภายนอก')}
                    </button>
                  )}
                </div>
              </div>
            )
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-center text-zinc-500 p-8 space-y-3">
              <FileText className="w-10 h-10 text-zinc-700" />
              <p className="text-sm font-medium text-zinc-300">
                {emptyTitle ||
                  tx(lang, 'No document pages stored for this PO yet', 'ยังไม่มีข้อมูลหน้าเอกสารของใบ PO นี้')}
              </p>
              {emptyAction}
            </div>
          )}
        </div>
      </div>
    );
  }
);

DocumentPageViewer.displayName = 'DocumentPageViewer';
