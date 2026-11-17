import React, { useState, useEffect, useMemo } from 'react';
import {
  ZoomIn,
  ZoomOut,
  RotateCcw,
  ChevronLeft,
  ChevronRight,
  BookmarkPlus,
  Building2,
  CheckCircle2,
  AlertTriangle,
  FileText,
  Copy,
  Layers,
  ShieldCheck,
  Send,
  RotateCw,
  Mail,
  Hash,
  FolderOpen,
  Languages,
  Eye,
  Loader2,
  ExternalLink,
  Sparkles,
} from 'lucide-react';
import type { Job, OcrResultRecord, CompanyCacheEntry, CompanyAlias, PagePreviewResponse } from '../types';
import { api } from '../services/tauri';
import { StatusBadge } from './Overview';
import { tr, tx, type UiLang } from '../i18n';
import { summarizeOcrRecords, type ParsedEntitiesJson } from '../utils/ocrRecords';
import {
  matchSupplierAgainstDirectory,
  findCompaniesSharingEmail,
  normalizeCompanyKey,
  splitEmailAddresses,
} from '../utils/supplierMatcher';

interface OcrInspectorProps {
  selectedJobId?: string;
  jobs: Job[];
  companies: CompanyCacheEntry[];
  aliases?: CompanyAlias[];
  onSelectJob: (id: string) => void;
  onRefreshData?: () => void;
  onRetryJob?: (jobId: string) => Promise<void> | void;
  lang?: UiLang;
}

interface BoundingBoxRecord {
  box?: unknown;
  text?: string;
  confidence?: number;
  type?: string;
}

const getBasename = (pathStr?: string): string => {
  if (!pathStr) return 'Document';
  const normalized = pathStr.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
};

const formatBoxCoords = (box: unknown): string => {
  if (!Array.isArray(box)) return '—';
  if (box.length === 4 && typeof box[0] === 'number') {
    return `[${box.map((n) => Math.round(Number(n))).join(', ')}]`;
  }
  if (box.length > 0 && Array.isArray(box[0])) {
    const first = box[0] as number[];
    const third = (box[2] as number[]) || first;
    return `[${Math.round(first[0] ?? 0)}, ${Math.round(first[1] ?? 0)} → ${Math.round(third[0] ?? 0)}, ${Math.round(third[1] ?? 0)}]`;
  }
  return JSON.stringify(box);
};

const extractBoxRect = (
  b: BoundingBoxRecord,
  pageW: number,
  pageH: number
): { left: number; top: number; width: number; height: number } | null => {
  if (!b.box || pageW <= 0 || pageH <= 0) return null;
  let x0 = 0;
  let y0 = 0;
  let x1 = 0;
  let y1 = 0;

  if (Array.isArray(b.box) && b.box.length === 4 && typeof b.box[0] === 'number') {
    [x0, y0, x1, y1] = b.box as number[];
  } else if (Array.isArray(b.box) && b.box.length >= 4 && Array.isArray(b.box[0])) {
    const pts = b.box as number[][];
    const xs = pts.map((p) => Number(p[0] ?? 0));
    const ys = pts.map((p) => Number(p[1] ?? 0));
    x0 = Math.min(...xs);
    y0 = Math.min(...ys);
    x1 = Math.max(...xs);
    y1 = Math.max(...ys);
  } else {
    return null;
  }

  const scaleFactor =
    b.type === 'ocr' && (x1 > pageW * 1.05 || y1 > pageH * 1.05) ? 200 / 72 : 1;
  const effW = pageW * scaleFactor;
  const effH = pageH * scaleFactor;

  const left = Math.max(0, Math.min(100, (x0 / effW) * 100));
  const top = Math.max(0, Math.min(100, (y0 / effH) * 100));
  const width = Math.max(0.5, Math.min(100 - left, ((x1 - x0) / effW) * 100));
  const height = Math.max(0.5, Math.min(100 - top, ((y1 - y0) / effH) * 100));

  return { left, top, width, height };
};

export const OcrInspector: React.FC<OcrInspectorProps> = ({
  selectedJobId,
  jobs = [],
  companies = [],
  aliases = [],
  onSelectJob,
  onRefreshData,
  onRetryJob,
  lang = 'en',
}) => {
  const [manualJobId, setManualJobId] = useState<string>('');
  const [ocrRecords, setOcrRecords] = useState<OcrResultRecord[]>([]);
  const [currentPageIndex, setCurrentPageIndex] = useState<number>(0);
  const [zoomLevel, setZoomLevel] = useState<number>(100);
  const [viewMode, setViewMode] = useState<'visual' | 'text' | 'boxes'>('visual');
  const [showBoundingBoxes, setShowBoundingBoxes] = useState<boolean>(true);
  const [hoveredBoxText, setHoveredBoxText] = useState<string | null>(null);

  // Live visual preview state
  const [pagePreview, setPagePreview] = useState<PagePreviewResponse | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState<boolean>(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Alias form
  const [aliasInput, setAliasInput] = useState<string>('');
  const [selectedCanonical, setSelectedCanonical] = useState<string>('');
  const [aliasSavedSuccess, setAliasSavedSuccess] = useState<boolean>(false);
  const [aliasError, setAliasError] = useState<string | null>(null);

  // Approve & Dispatch form
  const [approveCompany, setApproveCompany] = useState<string>('');
  const [approveEmail, setApproveEmail] = useState<string>('');
  const [approvePo, setApprovePo] = useState<string>('');
  const [saveAliasOnApprove, setSaveAliasOnApprove] = useState<boolean>(true);
  const [isSendingApproval, setIsSendingApproval] = useState<boolean>(false);
  const [isRetrying, setIsRetrying] = useState<boolean>(false);
  const [isDeepScanning, setIsDeepScanning] = useState<boolean>(false);
  const [actionBanner, setActionBanner] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [copiedText, setCopiedText] = useState<boolean>(false);

  const effectiveJobId = manualJobId || selectedJobId || jobs[0]?.id || '';
  const currentJob = jobs.find((j) => j.id === effectiveJobId) || jobs[0];

  useEffect(() => {
    if (!effectiveJobId) return;
    let cancelled = false;
    api
      .getOcrResults(effectiveJobId)
      .then((records) => {
        if (!cancelled) {
          setOcrRecords(records || []);
          setCurrentPageIndex(0);
        }
      })
      .catch((err) => {
        console.error('Failed to load OCR records:', err);
        if (!cancelled) setOcrRecords([]);
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveJobId]);

  const currentRecord = ocrRecords[currentPageIndex] || ocrRecords[0];
  const currentJobId = currentJob?.id || '';
  const currentRecordId = currentRecord?.id || '';
  const currentRecordFile = currentRecord?.file_path || '';
  const currentRecordPage = currentRecord?.page_number || 1;

  // Fetch rendered visual page preview whenever selected document page changes
  useEffect(() => {
    if (!currentJobId || !currentRecordFile) return;
    let cancelled = false;
    setIsLoadingPreview(true);
    setPreviewError(null);

    api
      .getDocumentPagePreview(currentJobId, currentRecordFile, currentRecordPage)
      .then((resp) => {
        if (cancelled) return;
        if (resp.status === 'ok' && resp.data_url) {
          setPagePreview(resp);
        } else {
          setPagePreview(null);
          setPreviewError(resp.message || '__UNAVAILABLE__');
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPagePreview(null);
        setPreviewError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setIsLoadingPreview(false);
      });

    return () => {
      cancelled = true;
    };
  }, [currentJobId, currentRecordId, currentRecordFile, currentRecordPage]);

  const parsedEntities: ParsedEntitiesJson = useMemo(() => {
    const rawJson = currentRecord?.detected_entities_json;
    if (!rawJson) return {};
    try {
      return JSON.parse(rawJson) as ParsedEntitiesJson;
    } catch {
      return {};
    }
  }, [currentRecord]);

  const currentJobFolder = currentJob?.po_folder_name || '';

  const aggregatedEntities = useMemo(
    () => summarizeOcrRecords(ocrRecords, currentJobFolder, parsedEntities),
    [ocrRecords, currentJobFolder, parsedEntities]
  );

  const currentDetectedRaw = currentJob?.detected_company_raw || '';
  const currentMatchedName = currentJob?.matched_company_name || '';
  const currentMatchedEmail = currentJob?.matched_email || '';
  const currentPoNumber = currentJob?.po_number || '';

  const matchedSheetEntry = useMemo(
    () =>
      companies.find(
        (c) =>
          Boolean(currentMatchedName) &&
          (c.company_name === currentMatchedName || c.alternative_name === currentMatchedName)
      ),
    [companies, currentMatchedName]
  );

  const boxes: BoundingBoxRecord[] = useMemo(() => {
    const rawBoxes = currentRecord?.bounding_boxes_json;
    if (!rawBoxes) return [];
    try {
      const parsed = JSON.parse(rawBoxes);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }, [currentRecord]);

  const uniqueFiles = useMemo(() => {
    const map = new Map<string, number>();
    ocrRecords.forEach((rec, idx) => {
      if (!map.has(rec.file_path)) {
        map.set(rec.file_path, idx);
      }
    });
    return Array.from(map.entries());
  }, [ocrRecords]);

  const jobAutoMatch = useMemo(
    () =>
      matchSupplierAgainstDirectory(
        [
          currentMatchedName,
          aggregatedEntities.primaryTh,
          aggregatedEntities.primaryEn,
          currentDetectedRaw,
        ],
        [currentMatchedEmail, ...aggregatedEntities.emails],
        companies,
        aliases
      ),
    [
      currentMatchedName,
      aggregatedEntities,
      currentDetectedRaw,
      currentMatchedEmail,
      companies,
      aliases,
    ]
  );

  const liveSheetMatch = useMemo(
    () =>
      matchSupplierAgainstDirectory(
        [
          approveCompany,
          aliasInput,
          aggregatedEntities.primaryTh,
          aggregatedEntities.primaryEn,
          currentDetectedRaw,
        ],
        [approveEmail, ...aggregatedEntities.emails],
        companies,
        aliases
      ),
    [
      approveCompany,
      aliasInput,
      aggregatedEntities,
      currentDetectedRaw,
      approveEmail,
      companies,
      aliases,
    ]
  );

  const sameEmailCombos = useMemo(
    () =>
      findCompaniesSharingEmail(
        approveEmail || currentMatchedEmail || aggregatedEntities.emails[0] || '',
        companies
      ),
    [approveEmail, currentMatchedEmail, aggregatedEntities.emails, companies]
  );

  const linkedSheetCompany = useMemo(() => {
    if (selectedCanonical) {
      const exact = companies.find((c) => c.company_name === selectedCanonical);
      if (exact) return exact;
    }
    const appKey = normalizeCompanyKey(approveCompany);
    if (appKey) {
      const byName = companies.find(
        (c) =>
          normalizeCompanyKey(c.company_name) === appKey ||
          normalizeCompanyKey(c.alternative_name) === appKey
      );
      if (byName) return byName;
    }
    if (liveSheetMatch.company && liveSheetMatch.score >= 82) {
      return liveSheetMatch.company;
    }
    return undefined;
  }, [selectedCanonical, approveCompany, companies, liveSheetMatch]);

  useEffect(() => {
    setActionBanner(null);
    const detectedDefault =
      currentDetectedRaw ||
      aggregatedEntities.primaryTh ||
      aggregatedEntities.primaryEn ||
      '';
    setAliasInput(detectedDefault);

    const backendMatchedEntry = currentMatchedName
      ? companies.find(
          (c) =>
            c.company_name === currentMatchedName || c.alternative_name === currentMatchedName
        )
      : undefined;
    const autoEntry = backendMatchedEntry || jobAutoMatch.company || undefined;

    setSelectedCanonical(autoEntry?.company_name || '');

    const defaultCompany =
      autoEntry?.company_name ||
      currentMatchedName ||
      aggregatedEntities.primaryTh ||
      aggregatedEntities.primaryEn ||
      currentDetectedRaw ||
      '';
    setApproveCompany(defaultCompany);

    setApproveEmail(
      currentMatchedEmail || autoEntry?.email || aggregatedEntities.emails[0] || ''
    );
    setApprovePo(
      currentPoNumber || aggregatedEntities.poNumbers[0] || currentJobFolder || ''
    );
  }, [
    currentJobId,
    currentJobFolder,
    currentDetectedRaw,
    currentMatchedName,
    currentMatchedEmail,
    currentPoNumber,
    companies,
    aggregatedEntities,
    jobAutoMatch,
  ]);

  const effectiveCanonical = selectedCanonical || linkedSheetCompany?.company_name || '';

  const selectLinkedSupplier = (
    companyName: string,
    opts?: { syncAliasInput?: string }
  ) => {
    if (!companyName) {
      setSelectedCanonical('');
      return;
    }
    const found = companies.find(
      (c) => c.company_name === companyName || c.alternative_name === companyName
    );
    if (!found) {
      setSelectedCanonical(companyName);
      setApproveCompany(companyName);
      return;
    }
    setSelectedCanonical(found.company_name);
    setApproveCompany(found.company_name);
    if (found.email) {
      setApproveEmail(found.email);
    }
    if (opts?.syncAliasInput !== undefined) {
      setAliasInput(opts.syncAliasInput);
    }
  };

  const handleSaveAlias = async () => {
    if (!aliasInput.trim() || !effectiveCanonical) return;
    setAliasError(null);
    try {
      await api.addCompanyAlias(aliasInput.trim(), effectiveCanonical);
      const canonEntry = companies.find((c) => c.company_name === effectiveCanonical);
      if (canonEntry) {
        setSelectedCanonical(canonEntry.company_name);
        setApproveCompany(canonEntry.company_name);
        if (canonEntry.email) {
          setApproveEmail(canonEntry.email);
        }
      } else {
        setApproveCompany(effectiveCanonical);
      }
      setAliasSavedSuccess(true);
      onRefreshData?.();
      setTimeout(() => setAliasSavedSuccess(false), 3000);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setAliasError(tx(lang, `Failed to save alias: ${msg}`, `บันทึกชื่อเรียกสำรองไม่สำเร็จ: ${msg}`));
    }
  };

  const handleRetryCurrentJob = async () => {
    if (!currentJob || !onRetryJob) return;
    setIsRetrying(true);
    setActionBanner(null);
    try {
      await onRetryJob(currentJob.id);
      const records = await api.getOcrResults(currentJob.id);
      setOcrRecords(records || []);
      setCurrentPageIndex(0);
      setActionBanner({
        type: 'success',
        message: tx(
          lang,
          'Re-scanned PDFs and updated Thai-first supplier match.',
          'สแกนไฟล์ PDF และอัปเดตผลจับคู่ผู้ขายใหม่แล้ว'
        ),
      });
      onRefreshData?.();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setActionBanner({
        type: 'error',
        message: tx(lang, `Re-scan failed: ${msg}`, `สแกนซ้ำไม่สำเร็จ: ${msg}`),
      });
    } finally {
      setIsRetrying(false);
    }
  };

  const handleDeepScanCurrentJob = async () => {
    if (!currentJob) return;
    setIsDeepScanning(true);
    setActionBanner(null);
    try {
      await api.deepScanJobWithVision(currentJob.id);
      const records = await api.getOcrResults(currentJob.id);
      setOcrRecords(records || []);
      setCurrentPageIndex(0);
      setActionBanner({
        type: 'success',
        message: tx(
          lang,
          'Built-In Vision AI Deep Scan completed and updated supplier match.',
          'สแกนด้วย Vision AI ในตัวเสร็จสิ้น และอัปเดตผลผู้ขายแล้ว'
        ),
      });
      onRefreshData?.();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setActionBanner({
        type: 'error',
        message: tx(lang, `AI Deep Scan failed: ${msg}`, `สแกนด้วย AI ไม่สำเร็จ: ${msg}`),
      });
    } finally {
      setIsDeepScanning(false);
    }
  };

  const handleApproveAndSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentJob || !approveCompany.trim() || !approveEmail.trim()) return;
    setIsSendingApproval(true);
    setActionBanner(null);
    try {
      const updated = await api.approveAndSendJob(
        currentJob.id,
        approveCompany.trim(),
        approveEmail.trim(),
        approvePo.trim() || undefined,
        saveAliasOnApprove
      );
      setActionBanner({
        type: 'success',
        message: tx(
          lang,
          `Approved and delivered PO ${updated.po_number || currentJob.po_folder_name} to ${
            updated.matched_email || approveEmail
          }.`,
          `อนุมัติและส่งใบสั่งซื้อ ${updated.po_number || currentJob.po_folder_name} ไปยัง ${
            updated.matched_email || approveEmail
          } สำเร็จ`
        ),
      });
      onRefreshData?.();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setActionBanner({
        type: 'error',
        message: tx(lang, `Delivery failed: ${msg}`, `ส่งอีเมลไม่สำเร็จ: ${msg}`),
      });
    } finally {
      setIsSendingApproval(false);
    }
  };

  const handleOpenExternal = async (filePath?: string) => {
    if (!currentJob) return;
    setActionBanner(null);
    try {
      await api.openJobDocument(currentJob.id, filePath);
    } catch (err: unknown) {
      setActionBanner({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleCopyRaw = () => {
    if (currentRecord?.raw_text) {
      navigator.clipboard.writeText(currentRecord.raw_text);
      setCopiedText(true);
      setTimeout(() => setCopiedText(false), 2000);
    }
  };

  const handleApproveCompanyInput = (val: string) => {
    setApproveCompany(val);
    const matched = matchSupplierAgainstDirectory(
      [val],
      [approveEmail, ...aggregatedEntities.emails],
      companies,
      aliases
    );
    if (matched.company && matched.score >= 82) {
      setSelectedCanonical(matched.company.company_name);
      if (matched.score >= 88 && matched.company.email) {
        const alreadySharing =
          splitEmailAddresses(approveEmail).length > 0 &&
          sameEmailCombos.some((c) => c.id === matched.company?.id);
        if (!alreadySharing) {
          setApproveEmail(matched.company.email);
        }
      }
    }
  };

  const handleApproveEmailInput = (val: string) => {
    setApproveEmail(val);
    const sharing = findCompaniesSharingEmail(val, companies);
    if (sharing.length === 1) {
      setSelectedCanonical(sharing[0].company_name);
      setApproveCompany(sharing[0].company_name);
    } else if (sharing.length > 1) {
      const best = matchSupplierAgainstDirectory(
        [
          approveCompany,
          aliasInput,
          aggregatedEntities.primaryTh,
          aggregatedEntities.primaryEn,
          currentDetectedRaw,
        ],
        [val],
        sharing,
        aliases
      );
      if (best.company) {
        setSelectedCanonical(best.company.company_name);
        setApproveCompany(best.company.company_name);
      }
    }
  };

  const handleAliasInputChange = (val: string) => {
    setAliasInput(val);
    const matched = matchSupplierAgainstDirectory(
      [val],
      [approveEmail, ...aggregatedEntities.emails],
      companies,
      aliases
    );
    if (matched.company && matched.score >= 86) {
      setSelectedCanonical(matched.company.company_name);
    }
  };

  const handleDetectedSupplierTextClick = (rawName: string) => {
    const cleaned = rawName.trim();
    if (!cleaned) return;
    setAliasInput(cleaned);
    const matched = matchSupplierAgainstDirectory(
      [cleaned],
      [approveEmail, ...aggregatedEntities.emails],
      companies,
      aliases
    );
    if (matched.company && matched.score >= 78) {
      selectLinkedSupplier(matched.company.company_name);
    } else {
      setApproveCompany(cleaned);
    }
  };

  const handleBoxClick = (text?: string) => {
    if (!text) return;
    const cleaned = text.trim();
    if (!cleaned) return;
    if (cleaned.includes('@') && cleaned.includes('.')) {
      handleApproveEmailInput(cleaned);
    } else if (/^PO[-\s]?\d{4,}/i.test(cleaned)) {
      setApprovePo(cleaned);
    } else {
      handleDetectedSupplierTextClick(cleaned);
    }
  };

  return (
    <div className="p-6 space-y-4 max-w-7xl mx-auto">
      {/* Top Bar */}
      <div className="p-4 rounded-xl bg-[#121215] border border-zinc-800 flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-zinc-100">{tr(lang, 'tabInspectorTitle')}</h3>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-500/10 text-emerald-300 border border-emerald-500/25">
              <ShieldCheck className="w-3 h-3" />
              {tx(lang, 'QTC Excluded • Thai First', 'กรอง QTC ออก • ชื่อไทยก่อน')}
            </span>
          </div>
          <p className="text-xs text-zinc-400">
            {tx(
              lang,
              'Inspect attached PDFs, click detected boxes to fill fields, or open the file in Windows.',
              'ตรวจสอบไฟล์ PDF แนบ คลิกกรอบข้อความที่ตรวจพบเพื่อเติมฟอร์ม หรือเปิดดูใน Windows'
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-zinc-400">{tx(lang, 'PO Job:', 'งาน PO:')}</label>
          <select
            value={effectiveJobId}
            onChange={(e) => {
              setManualJobId(e.target.value);
              onSelectJob(e.target.value);
            }}
            className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs rounded-lg px-3 py-1.5 font-medium max-w-xs"
          >
            {jobs.length === 0 ? (
              <option value="">{tx(lang, 'No jobs recorded yet', 'ยังไม่มีรายการ PO')}</option>
            ) : (
              jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  [{j.status}] {j.po_number || j.po_folder_name} —{' '}
                  {j.matched_company_name || j.detected_company_raw || tx(lang, 'Unmatched', 'ยังไม่จับคู่')}
                </option>
              ))
            )}
          </select>

          {currentJob && (
            <button
              type="button"
              onClick={() => handleOpenExternal(undefined)}
              className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 text-xs font-medium flex items-center gap-1.5"
            >
              <FolderOpen className="w-3.5 h-3.5 text-amber-400" />
              <span>{tr(lang, 'openIncoming')}</span>
            </button>
          )}
        </div>
      </div>

      {/* Main Master-Detail Viewer */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* Left Pane: Fixed-height clean Document Viewport */}
        <div className="lg:col-span-7 bg-[#121215] border border-zinc-800 rounded-xl flex flex-col overflow-hidden h-[720px]">
          {/* Attached Files Tabs */}
          {ocrRecords.length > 0 && (
            <div className="px-3 py-2 bg-zinc-950 border-b border-zinc-800 flex items-center gap-1.5 overflow-x-auto shrink-0">
              {ocrRecords.map((rec, idx) => (
                <button
                  key={rec.id}
                  type="button"
                  onClick={() => setCurrentPageIndex(idx)}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap border transition-colors ${
                    idx === currentPageIndex
                      ? 'bg-zinc-800 text-white border-zinc-600'
                      : 'bg-zinc-900/60 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                  }`}
                >
                  {getBasename(rec.file_path)} (p.{rec.page_number})
                </button>
              ))}
            </div>
          )}

          {/* Clean Viewer Toolbar */}
          <div className="px-3 py-2 bg-zinc-900/60 border-b border-zinc-800 flex flex-wrap items-center justify-between gap-2 text-xs shrink-0">
            <div className="flex items-center gap-1.5">
              <div className="flex rounded-lg bg-zinc-950 p-0.5 border border-zinc-800">
                <button
                  type="button"
                  onClick={() => setViewMode('visual')}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                    viewMode === 'visual' ? 'bg-blue-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  <Eye className="w-3.5 h-3.5" />
                  <span>{tx(lang, 'Page View', 'มุมมองภาพ')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('text')}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                    viewMode === 'text' ? 'bg-blue-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  <FileText className="w-3.5 h-3.5" />
                  <span>{tx(lang, 'Text', 'ข้อความ')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('boxes')}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                    viewMode === 'boxes' ? 'bg-blue-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  <Layers className="w-3.5 h-3.5" />
                  <span>{tx(lang, 'Boxes', 'กรอบข้อความ')} ({boxes.length})</span>
                </button>
              </div>

              {viewMode === 'visual' && (
                <button
                  type="button"
                  onClick={() => setShowBoundingBoxes((v) => !v)}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
                    showBoundingBoxes
                      ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                      : 'bg-zinc-900 text-zinc-400 border-zinc-800'
                  }`}
                >
                  {tx(lang, `Overlays ${showBoundingBoxes ? 'ON' : 'OFF'}`, `กรอบคลิก ${showBoundingBoxes ? 'เปิด' : 'ปิด'}`)}
                </button>
              )}
            </div>

            <div className="flex items-center gap-1.5 flex-wrap">
              <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-md overflow-hidden">
                <button
                  type="button"
                  onClick={() => setZoomLevel((z) => Math.max(50, z - 20))}
                  className="p-1.5 hover:bg-zinc-800 text-zinc-300"
                  title={tx(lang, 'Zoom out', 'ซูมออก')}
                >
                  <ZoomOut className="w-3.5 h-3.5" />
                </button>
                <span className="px-2 text-[11px] font-mono text-zinc-200">{zoomLevel}%</span>
                <button
                  type="button"
                  onClick={() => setZoomLevel((z) => Math.min(200, z + 20))}
                  className="p-1.5 hover:bg-zinc-800 text-zinc-300"
                  title={tx(lang, 'Zoom in', 'ซูมเข้า')}
                >
                  <ZoomIn className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setZoomLevel(100)}
                  className="p-1.5 hover:bg-zinc-800 text-zinc-400 border-l border-zinc-800"
                  title={tx(lang, 'Reset zoom', 'ขนาดปกติ')}
                >
                  <RotateCcw className="w-3 h-3" />
                </button>
              </div>

              {currentRecord && (
                <button
                  type="button"
                  onClick={() => handleOpenExternal(currentRecord.file_path)}
                  className="px-2.5 py-1 rounded-md bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs flex items-center gap-1"
                  title={tx(lang, 'Open this PDF in your default Windows viewer', 'เปิดไฟล์ PDF นี้ด้วยโปรแกรมบน Windows')}
                >
                  <ExternalLink className="w-3.5 h-3.5 text-blue-400" />
                  <span>{tr(lang, 'openPdf')}</span>
                </button>
              )}

              <button
                type="button"
                onClick={handleCopyRaw}
                disabled={!currentRecord?.raw_text}
                className="px-2.5 py-1 rounded-md bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs flex items-center gap-1 disabled:opacity-40"
              >
                <Copy className="w-3.5 h-3.5" />
                <span>{copiedText ? tx(lang, 'Copied', 'คัดลอกแล้ว') : tx(lang, 'Copy', 'คัดลอก')}</span>
              </button>
            </div>
          </div>

          {/* Hovered Bounding Box Hint Bar */}
          {viewMode === 'visual' && hoveredBoxText && (
            <div className="px-4 py-1.5 bg-blue-950/80 border-b border-blue-500/30 text-xs text-blue-200 font-mono truncate shrink-0">
              {tx(lang, 'Click box to fill form:', 'คลิกกรอบนี้เพื่อกรอกลงฟอร์ม:')} {hoveredBoxText}
            </div>
          )}

          {/* Main Document Scroll Viewport */}
          <div className="flex-1 overflow-auto bg-[#09090b] p-4 min-h-0">
            {!currentRecord ? (
              <div className="h-full flex flex-col items-center justify-center text-center text-zinc-500 p-8 space-y-3">
                <FileText className="w-10 h-10 text-zinc-700" />
                <p className="text-sm font-medium text-zinc-300">
                  {tx(lang, 'No document pages stored for this PO yet', 'ยังไม่มีข้อมูลหน้าเอกสารของใบ PO นี้')}
                </p>
                {currentJob && onRetryJob && (
                  <button
                    type="button"
                    onClick={handleRetryCurrentJob}
                    disabled={isRetrying}
                    className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold flex items-center gap-1.5"
                  >
                    <RotateCw className={`w-3.5 h-3.5 ${isRetrying ? 'animate-spin' : ''}`} />
                    <span>
                      {isRetrying
                        ? tx(lang, 'Scanning PO...', 'กำลังสแกน PO...')
                        : tx(lang, 'Scan Documents Now', 'สแกนเอกสารทันที')}
                    </span>
                  </button>
                )}
              </div>
            ) : viewMode === 'visual' ? (
              isLoadingPreview ? (
                <div className="h-full flex flex-col items-center justify-center text-zinc-400 space-y-2">
                  <Loader2 className="w-7 h-7 animate-spin text-blue-400" />
                  <span className="text-xs">{tx(lang, 'Rendering page preview...', 'กำลังโหลดภาพหน้าเอกสาร...')}</span>
                </div>
              ) : pagePreview?.data_url ? (
                <div
                  className="relative mx-auto shadow-2xl border border-zinc-700 rounded bg-white select-none"
                  style={{ width: `${zoomLevel}%`, minWidth: zoomLevel > 100 ? `${zoomLevel}%` : undefined }}
                >
                  <img
                    src={pagePreview.data_url}
                    alt={getBasename(currentRecord.file_path)}
                    className="w-full h-auto block rounded"
                  />
                  {showBoundingBoxes &&
                    pagePreview.page_width &&
                    pagePreview.page_height &&
                    boxes.map((b, idx) => {
                      const rect = extractBoxRect(
                        b,
                        pagePreview.page_width!,
                        pagePreview.page_height!
                      );
                      if (!rect) return null;
                      return (
                        <button
                          key={idx}
                          type="button"
                          onMouseEnter={() => setHoveredBoxText(b.text || null)}
                          onMouseLeave={() => setHoveredBoxText(null)}
                          onClick={() => handleBoxClick(b.text)}
                          title={b.text || ''}
                          style={{
                            left: `${rect.left}%`,
                            top: `${rect.top}%`,
                            width: `${rect.width}%`,
                            height: `${rect.height}%`,
                          }}
                          className="absolute border border-blue-500/60 bg-blue-500/10 hover:bg-emerald-500/25 hover:border-emerald-400 transition-colors cursor-pointer"
                        />
                      );
                    })}
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
                    <button
                      type="button"
                      onClick={() => setViewMode('text')}
                      className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium"
                    >
                      {tx(lang, 'View Extracted Text', 'ดูข้อความที่อ่านได้')}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleOpenExternal(currentRecord.file_path)}
                      className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium"
                    >
                      {tx(lang, 'Open PDF Externally', 'เปิด PDF ภายนอก')}
                    </button>
                  </div>
                </div>
              )
            ) : viewMode === 'text' ? (
              <pre
                style={{ fontSize: `${Math.round((13 * zoomLevel) / 100)}px` }}
                className="font-mono leading-relaxed text-zinc-200 whitespace-pre-wrap select-text bg-[#121215] p-4 rounded-lg border border-zinc-800"
              >
                {currentRecord.raw_text || tx(lang, '(No text layer extracted from this page)', '(ไม่พบข้อความที่อ่านได้จากหน้านี้)')}
              </pre>
            ) : (
              <div className="rounded-lg border border-zinc-800 overflow-hidden bg-[#121215]">
                <table className="w-full text-left text-xs">
                  <thead className="bg-zinc-900 text-zinc-400 border-b border-zinc-800">
                    <tr>
                      <th className="py-2 px-3">#</th>
                      <th className="py-2 px-3">{tx(lang, 'Detected Text', 'ข้อความที่ตรวจพบ')}</th>
                      <th className="py-2 px-3">{tx(lang, 'Type', 'ประเภท')}</th>
                      <th className="py-2 px-3">{tx(lang, 'Confidence', 'ความมั่นใจ')}</th>
                      <th className="py-2 px-3">{tx(lang, 'Coordinates', 'พิกัด')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/70">
                    {boxes.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-8 text-center text-zinc-500">
                          {tx(lang, 'No bounding boxes stored for this page.', 'ไม่มีข้อมูลตำแหน่งกรอบข้อความในหน้านี้')}
                        </td>
                      </tr>
                    ) : (
                      boxes.map((b, idx) => (
                        <tr
                          key={idx}
                          onClick={() => handleBoxClick(b.text)}
                          className="hover:bg-zinc-800/50 cursor-pointer"
                          title={tx(lang, 'Click row to copy into form', 'คลิกแถวเพื่อเติมลงฟอร์ม')}
                        >
                          <td className="py-2 px-3 font-mono text-zinc-500">{idx + 1}</td>
                          <td className="py-2 px-3 text-zinc-200 font-medium">{b.text || '—'}</td>
                          <td className="py-2 px-3 font-mono text-[11px] text-blue-400">
                            {b.type || 'block'}
                          </td>
                          <td className="py-2 px-3 font-mono text-[11px] text-emerald-400">
                            {typeof b.confidence === 'number'
                              ? `${(b.confidence <= 1 ? b.confidence * 100 : b.confidence).toFixed(1)}%`
                              : '—'}
                          </td>
                          <td className="py-2 px-3 font-mono text-[11px] text-zinc-400">
                            {formatBoxCoords(b.box)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Pagination Footer */}
          <div className="px-4 py-2.5 bg-zinc-950 border-t border-zinc-800 flex items-center justify-between text-xs text-zinc-400 shrink-0">
            <button
              type="button"
              disabled={currentPageIndex === 0}
              onClick={() => setCurrentPageIndex((i) => Math.max(0, i - 1))}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-200 disabled:opacity-40"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              <span>{tx(lang, 'Previous Page', 'หน้าก่อนหน้า')}</span>
            </button>

            <span className="font-mono text-zinc-300">
              {tx(lang, 'Page', 'หน้า')} {ocrRecords.length === 0 ? 0 : currentPageIndex + 1} {tx(lang, 'of', 'จาก')} {ocrRecords.length}
            </span>

            <button
              type="button"
              disabled={currentPageIndex >= ocrRecords.length - 1}
              onClick={() => setCurrentPageIndex((i) => i + 1)}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-200 disabled:opacity-40"
            >
              <span>{tx(lang, 'Next Page', 'หน้าถัดไป')}</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Right Pane: Detected Predictions, Match Result, Approve & Send, Alias Save */}
        <div className="lg:col-span-5 space-y-4">
          {actionBanner && (
            <div
              className={`p-3 rounded-xl border text-xs flex items-start gap-2 ${
                actionBanner.type === 'success'
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                  : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
              }`}
            >
              {actionBanner.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              ) : (
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              )}
              <span>{actionBanner.message}</span>
            </div>
          )}

          {/* Match Summary Card */}
          <div className="p-4 rounded-xl bg-[#121215] border border-zinc-800 space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-xs font-semibold text-zinc-200 flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                {tx(lang, 'Matched Supplier Summary', 'สรุปผลการอ่านและจับคู่ผู้ขาย')}
              </span>
              <div className="flex items-center gap-1.5 flex-wrap">
                {currentRecord && (
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${
                      currentRecord.engine.includes('vision_ai')
                        ? 'bg-purple-500/15 text-purple-300 border-purple-500/30'
                        : currentRecord.engine.includes('openthaigpt')
                        ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                        : currentRecord.engine.includes('tesseract')
                        ? 'bg-blue-500/15 text-blue-300 border-blue-500/30'
                        : currentRecord.engine.includes('native')
                        ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30'
                        : 'bg-zinc-800 text-zinc-300 border-zinc-700'
                    }`}
                    title={`Engine: ${currentRecord.engine}`}
                  >
                    {[
                      currentRecord.engine.includes('openthaigpt')
                        ? tx(lang, 'Scanned: OpenThai 2.0', 'สแกน: OpenThai 2.0')
                        : currentRecord.engine.includes('paddleocr')
                        ? tx(lang, 'Scanned: PaddleOCR', 'สแกน: PaddleOCR')
                        : currentRecord.engine.includes('tesseract')
                        ? tx(lang, 'Scanned: Tesseract 5', 'สแกน: Tesseract 5')
                        : currentRecord.engine.includes('winrt')
                        ? tx(lang, 'Scanned: Windows OCR', 'สแกน: Windows OCR')
                        : currentRecord.engine === 'native_pdf'
                        ? tx(lang, 'Built-in PDF Reader', 'ตัวอ่าน PDF ในตัว')
                        : currentRecord.engine,
                      currentRecord.engine.includes('vision_ai') ? '+ Vision AI' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}{' '}
                    ({currentRecord.confidence.toFixed(0)}%)
                  </span>
                )}
                {currentJob && <StatusBadge status={currentJob.status} lang={lang} />}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
              <button
                type="button"
                disabled={!aggregatedEntities.primaryTh}
                onClick={() => {
                  if (aggregatedEntities.primaryTh) {
                    handleDetectedSupplierTextClick(aggregatedEntities.primaryTh);
                  }
                }}
                className="p-2.5 rounded-lg bg-emerald-500/5 border border-emerald-500/20 text-left hover:bg-emerald-500/10 disabled:opacity-60"
              >
                <span className="text-[10px] font-semibold uppercase text-emerald-400 flex items-center gap-1">
                  <Languages className="w-3 h-3" /> {tx(lang, 'Thai Name (Priority 1)', 'ชื่อไทย (ลำดับ 1)')}
                </span>
                <div className="mt-1 font-medium text-zinc-100 truncate">
                  {aggregatedEntities.primaryTh || tx(lang, 'None on document', 'ไม่พบในเอกสาร')}
                </div>
              </button>

              <button
                type="button"
                disabled={!aggregatedEntities.primaryEn}
                onClick={() => {
                  if (aggregatedEntities.primaryEn) {
                    handleDetectedSupplierTextClick(aggregatedEntities.primaryEn);
                  }
                }}
                className="p-2.5 rounded-lg bg-zinc-900 border border-zinc-800 text-left hover:bg-zinc-800/80 disabled:opacity-60"
              >
                <span className="text-[10px] font-semibold uppercase text-zinc-400 flex items-center gap-1">
                  <Building2 className="w-3 h-3" /> {tx(lang, 'English Fallback (2)', 'ชื่ออังกฤษ (ลำดับ 2)')}
                </span>
                <div className="mt-1 font-medium text-zinc-200 truncate">
                  {aggregatedEntities.primaryEn || tx(lang, 'None on document', 'ไม่พบในเอกสาร')}
                </div>
              </button>
            </div>

            {(aggregatedEntities.poNumbers.length > 0 || aggregatedEntities.emails.length > 0) && (
              <div className="flex flex-wrap gap-1.5 text-[11px]">
                {aggregatedEntities.poNumbers.map((po) => (
                  <button
                    key={po}
                    type="button"
                    onClick={() => setApprovePo(po)}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-blue-500/10 text-blue-300 border border-blue-500/25 hover:bg-blue-500/20 font-mono"
                  >
                    <Hash className="w-3 h-3" /> {po}
                  </button>
                ))}
                {aggregatedEntities.emails.map((em) => (
                  <button
                    key={em}
                    type="button"
                    onClick={() => handleApproveEmailInput(em)}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-300 border border-cyan-500/25 hover:bg-cyan-500/20 font-mono"
                  >
                    <Mail className="w-3 h-3" /> {em}
                  </button>
                ))}
              </div>
            )}

            <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800 space-y-1.5 text-xs">
              <div className="flex justify-between gap-2">
                <span className="text-zinc-500">
                  {tx(lang, 'Detected From Digital PO / Docs:', 'ชื่อที่อ่านได้จากเอกสารหลัก:')}
                </span>
                <span className="text-amber-300 font-medium truncate" title={currentJob?.detected_company_raw || ''}>
                  {currentJob?.detected_company_raw || '—'}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-zinc-500">
                  {tx(lang, 'Matched Sheet Supplier:', 'ผู้ขายที่ตรงใน Google Sheet:')}
                </span>
                <span className="text-emerald-400 font-medium truncate">
                  {matchedSheetEntry?.vendor_group ? `[${matchedSheetEntry.vendor_group}] ` : ''}
                  {currentJob?.matched_company_name || tx(lang, 'Not matched', 'ยังไม่ตรงกับรายชื่อ')}
                </span>
              </div>
              {matchedSheetEntry?.alternative_name && (
                <div className="flex justify-between gap-2">
                  <span className="text-zinc-500">
                    {tx(lang, 'Sheet Alternate (EN/TH):', 'ชื่ออีกภาษา / สำรองใน Sheet:')}
                  </span>
                  <span className="text-zinc-200 truncate" title={matchedSheetEntry.alternative_name}>
                    {matchedSheetEntry.alternative_name}
                  </span>
                </div>
              )}
              {matchedSheetEntry?.notes && (
                <div className="flex justify-between gap-2">
                  <span className="text-zinc-500">
                    {tx(lang, 'Sheet Proofing / Notes:', 'ข้อมูลตรวจทาน / หมายเหตุ Sheet:')}
                  </span>
                  <span className="text-zinc-300 truncate" title={matchedSheetEntry.notes}>
                    {matchedSheetEntry.notes}
                  </span>
                </div>
              )}
              <div className="flex justify-between gap-2">
                <span className="text-zinc-500">{tx(lang, 'Match Score:', 'คะแนนความแม่นยำ:')}</span>
                <span className="text-zinc-200 font-mono">
                  {typeof currentJob?.match_confidence === 'number'
                    ? `${currentJob.match_confidence.toFixed(1)}%`
                    : '—'}
                </span>
              </div>
              {currentJob?.stage_message && (
                <p className="text-[11px] text-zinc-400 pt-1 border-t border-zinc-800/80">
                  {currentJob.stage_message}
                </p>
              )}
              {currentJob?.error_details && (
                <p className="text-[11px] text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded p-2 mt-1">
                  {currentJob.error_details}
                </p>
              )}
            </div>

            {currentJob && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {onRetryJob && (
                  <button
                    type="button"
                    onClick={handleRetryCurrentJob}
                    disabled={isRetrying || isDeepScanning}
                    className="w-full py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-100 border border-zinc-700 font-medium text-xs flex items-center justify-center gap-1.5"
                  >
                    <RotateCw className={`w-3.5 h-3.5 ${isRetrying ? 'animate-spin' : ''}`} />
                    <span>
                      {isRetrying ? tx(lang, 'Re-Scanning...', 'กำลังสแกนใหม่...') : tr(lang, 'rescan')}
                    </span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleDeepScanCurrentJob}
                  disabled={isDeepScanning || isRetrying}
                  className="w-full py-2 rounded-lg bg-purple-600/20 hover:bg-purple-600/30 disabled:opacity-50 text-purple-200 border border-purple-500/40 font-medium text-xs flex items-center justify-center gap-1.5"
                  title={tx(lang, 'Force-run Built-In Vision AI on this PO now', 'บังคับใช้ Vision AI ช่วยอ่านเอกสาร PO ใบนี้')}
                >
                  <Sparkles className={`w-3.5 h-3.5 ${isDeepScanning ? 'animate-pulse' : ''}`} />
                  <span>
                    {isDeepScanning ? tx(lang, 'AI Scanning...', 'AI กำลังอ่าน...') : tr(lang, 'deepScanAi')}
                  </span>
                </button>
              </div>
            )}
          </div>

          {/* Approve & Send PO Email Panel */}
          {currentJob && (
            <form
              onSubmit={handleApproveAndSend}
              className="p-4 rounded-xl bg-[#121215] border border-zinc-800 space-y-3"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-zinc-200 flex items-center gap-1.5">
                  <Send className="w-4 h-4 text-emerald-400" />
                  {tr(lang, 'approveAndSend')}
                </span>
                <span className="text-[11px] text-emerald-400">
                  {tx(lang, 'Previewable PDFs', 'ไฟล์ PDF พร้อมพรีวิว')}
                </span>
              </div>

              {uniqueFiles.length > 0 && (
                <div className="p-2.5 rounded-lg bg-zinc-950 border border-zinc-800 space-y-1.5">
                  <div className="text-[11px] font-medium text-zinc-400">
                    {tx(
                      lang,
                      `Attachments to send (${uniqueFiles.length} file(s) — click Preview):`,
                      `ไฟล์ที่จะส่ง (${uniqueFiles.length} ไฟล์ — กดเพื่อดูตัวอย่าง):`
                    )}
                  </div>
                  <div className="space-y-1 max-h-28 overflow-y-auto">
                    {uniqueFiles.map(([filePath, firstIdx]) => (
                      <div
                        key={filePath}
                        className="flex items-center justify-between gap-2 px-2 py-1 rounded bg-zinc-900 border border-zinc-800 text-[11px]"
                      >
                        <span className="text-zinc-200 truncate">{getBasename(filePath)}</span>
                        <button
                          type="button"
                          onClick={() => {
                            setViewMode('visual');
                            setCurrentPageIndex(firstIdx);
                          }}
                          className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-blue-300 text-[10px] font-medium shrink-0"
                        >
                          {tx(lang, 'Preview', 'ดูตัวอย่าง')}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {companies.length > 0 && (
                <div className="text-xs space-y-1.5">
                  <label className="text-zinc-400 text-[11px] block">
                    {tx(lang, 'Pick Supplier from Google Sheet:', 'เลือกผู้ขายจาก Google Sheet:')}
                  </label>
                  <select
                    value={linkedSheetCompany?.company_name || ''}
                    onChange={(e) => selectLinkedSupplier(e.target.value)}
                    className="w-full bg-zinc-900 border border-zinc-800 text-zinc-200 rounded-lg px-2.5 py-2 font-medium"
                  >
                    <option value="">
                      {tx(lang, '-- Choose Google Sheet Supplier --', '-- เลือกผู้ขายจาก Google Sheet --')}
                    </option>
                    {companies.map((c) => (
                      <option key={c.id} value={c.company_name}>
                        {c.vendor_group ? `[${c.vendor_group}] ` : ''}
                        {c.company_name}
                        {c.alternative_name ? ` / ${c.alternative_name}` : ''} ({c.email})
                      </option>
                    ))}
                  </select>

                  {liveSheetMatch.company && (
                    <div className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/25 text-[11px] text-emerald-300">
                      <span>
                        {tx(lang, 'Auto Sheet Match:', 'ตรงกับ Sheet อัตโนมัติ:')}{' '}
                        <strong className="text-emerald-200">{liveSheetMatch.company.company_name}</strong>
                        {liveSheetMatch.company.alternative_name
                          ? ` (${liveSheetMatch.company.alternative_name})`
                          : ''}{' '}
                        · {liveSheetMatch.score.toFixed(0)}% ({liveSheetMatch.matchedBy})
                      </span>
                      <button
                        type="button"
                        onClick={() => selectLinkedSupplier(liveSheetMatch.company!.company_name)}
                        className="px-2 py-0.5 rounded bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-100 font-medium"
                      >
                        {tx(lang, 'Sync Both', 'ซิงก์ทั้ง 2 ช่อง')}
                      </button>
                    </div>
                  )}

                  {sameEmailCombos.length > 1 && (
                    <div className="flex flex-wrap items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/25 text-[11px] text-amber-300">
                      <span>
                        {tx(
                          lang,
                          `${sameEmailCombos.length} suppliers share this email:`,
                          `มี ${sameEmailCombos.length} บริษัทใช้อีเมลนี้:`
                        )}
                      </span>
                      {sameEmailCombos.map((comp) => (
                        <button
                          key={comp.id}
                          type="button"
                          onClick={() => selectLinkedSupplier(comp.company_name)}
                          className={`px-2 py-0.5 rounded border text-[11px] transition-colors ${
                            effectiveCanonical === comp.company_name || approveCompany === comp.company_name
                              ? 'bg-amber-400/25 border-amber-400 text-amber-100 font-semibold'
                              : 'bg-zinc-900 border-zinc-700 text-zinc-200 hover:bg-zinc-800'
                          }`}
                        >
                          {comp.company_name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div className="grid grid-cols-1 gap-2.5 text-xs">
                <div>
                  <label className="text-zinc-400 text-[11px] block mb-1">
                    {tx(lang, 'Supplier Name:', 'ชื่อบริษัทผู้ขาย:')}
                  </label>
                  <input
                    type="text"
                    required
                    value={approveCompany}
                    onChange={(e) => handleApproveCompanyInput(e.target.value)}
                    placeholder={tx(lang, 'Supplier company name', 'ชื่อบริษัทผู้ขาย')}
                    className="w-full bg-zinc-900 border border-zinc-800 text-zinc-100 rounded-lg px-2.5 py-2"
                  />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-zinc-400 text-[11px] block mb-1">
                      {tx(lang, 'Send To Email:', 'ส่งไปยังอีเมล:')}
                    </label>
                    <input
                      type="text"
                      required
                      value={approveEmail}
                      onChange={(e) => handleApproveEmailInput(e.target.value)}
                      placeholder="ooo@email.com, aaa@gmail.com"
                      className="w-full bg-zinc-900 border border-zinc-800 text-zinc-100 rounded-lg px-2.5 py-2 font-mono"
                    />
                  </div>
                  <div>
                    <label className="text-zinc-400 text-[11px] block mb-1">
                      {tx(lang, 'PO Number:', 'เลขที่ใบสั่งซื้อ:')}
                    </label>
                    <input
                      type="text"
                      value={approvePo}
                      onChange={(e) => setApprovePo(e.target.value)}
                      placeholder="PO-26004156"
                      className="w-full bg-zinc-900 border border-zinc-800 text-zinc-100 rounded-lg px-2.5 py-2 font-mono"
                    />
                  </div>
                </div>

                <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={saveAliasOnApprove}
                    onChange={(e) => setSaveAliasOnApprove(e.target.checked)}
                    className="rounded border-zinc-700 bg-zinc-900 text-blue-600"
                  />
                  <span>{tx(lang, 'Remember supplier name mapping for future POs', 'จำการจับคู่ชื่อผู้ขายนี้ไว้ใช้ครั้งถัดไป')}</span>
                </label>

                <button
                  type="submit"
                  disabled={isSendingApproval || currentJob.status === 'completed'}
                  className="w-full py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold text-xs flex items-center justify-center gap-1.5"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>
                    {currentJob.status === 'completed'
                      ? tx(lang, 'Already Sent', 'ส่งแล้ว')
                      : isSendingApproval
                      ? tx(lang, 'Sending Email...', 'กำลังส่งอีเมล...')
                      : tr(lang, 'approveAndSend')}
                  </span>
                </button>
              </div>
            </form>
          )}

          {/* Save Alternate Supplier Name */}
          <div className="p-4 rounded-xl bg-[#121215] border border-zinc-800 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-zinc-200 flex items-center gap-1.5">
                <BookmarkPlus className="w-4 h-4 text-blue-400" />
                {tx(lang, 'Save Alternate Supplier Name', 'บันทึกชื่อเรียกสำรองของบริษัทผู้ขาย')}
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-300 border border-blue-500/20">
                {tx(lang, 'Linked ↔ Send', 'ซิงก์กับช่องส่งเมล')}
              </span>
            </div>

            <div className="space-y-2.5 text-xs">
              <div>
                <label className="text-zinc-400 text-[11px] block mb-1">
                  {tx(lang, 'Name Found in PDF:', 'ชื่อที่ปรากฏในเอกสาร PDF:')}
                </label>
                <input
                  type="text"
                  value={aliasInput}
                  onChange={(e) => handleAliasInputChange(e.target.value)}
                  placeholder={tx(lang, 'e.g. ห้างหุ้นส่วนจำกัด พศินสุข', 'เช่น ห้างหุ้นส่วนจำกัด พศินสุข')}
                  className="w-full bg-zinc-900 border border-zinc-800 text-zinc-200 rounded-lg px-2.5 py-2"
                />
              </div>

              <div>
                <label className="text-zinc-400 text-[11px] block mb-1">
                  {tx(lang, 'Matches Google Sheet Supplier:', 'ตรงกับชื่อผู้ขายใน Google Sheet:')}
                </label>
                <select
                  value={effectiveCanonical}
                  onChange={(e) => selectLinkedSupplier(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 text-zinc-200 rounded-lg px-2.5 py-2"
                >
                  {companies.length === 0 ? (
                    <option value="">{tx(lang, 'Sync Google Sheets directory first', 'กรุณาซิงก์รายชื่อ Google Sheet ก่อน')}</option>
                  ) : (
                    <>
                      <option value="">
                        {tx(lang, '-- Choose Google Sheet Supplier --', '-- เลือกผู้ขายจาก Google Sheet --')}
                      </option>
                      {companies.map((c) => (
                        <option key={c.id} value={c.company_name}>
                          {c.vendor_group ? `[${c.vendor_group}] ` : ''}
                          {c.company_name}
                          {c.alternative_name ? ` / ${c.alternative_name}` : ''} ({c.email})
                        </option>
                      ))}
                    </>
                  )}
                </select>
              </div>

              <button
                type="button"
                onClick={handleSaveAlias}
                disabled={!aliasInput.trim() || !effectiveCanonical}
                className="w-full py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-100 border border-zinc-700 font-medium text-xs"
              >
                {tx(lang, 'Save Supplier Mapping', 'บันทึกการจับคู่ชื่อผู้ขาย')}
              </button>

              {aliasSavedSuccess && (
                <div className="p-2 rounded bg-emerald-500/15 text-emerald-300 text-center text-xs border border-emerald-500/30">
                  {tx(
                    lang,
                    'Saved & linked to Approve form! Next PO with this name will match automatically.',
                    'บันทึกและซิงก์กับฟอร์มส่งอีเมลแล้ว! ใบ PO ถัดไปที่ใช้ชื่อนี้จะจับคู่อัตโนมัติทันที'
                  )}
                </div>
              )}
              {aliasError && (
                <div className="p-2 rounded bg-rose-500/15 text-rose-300 text-center text-xs border border-rose-500/30">
                  {aliasError}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
