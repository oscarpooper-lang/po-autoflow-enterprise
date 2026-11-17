import React, { useState, useEffect, useMemo } from 'react';
import {
  FolderOpen,
  RefreshCw,
  Building2,
  Send,
  Search,
  RotateCw,
  Maximize2,
  FileText,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Mail,
  Languages,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  ExternalLink,
  Eye,
  Sparkles,
} from 'lucide-react';
import type {
  DashboardStats,
  Job,
  ApplicationEvent,
  AppSettings,
  CompanyCacheEntry,
  CompanyAlias,
  OcrResultRecord,
  PagePreviewResponse,
} from '../types';
import { api } from '../services/tauri';
import { resolveUiLang, tr, tx, type UiLang } from '../i18n';
import { summarizeOcrRecords } from '../utils/ocrRecords';
import {
  matchSupplierAgainstDirectory,
  findCompaniesSharingEmail,
  splitEmailAddresses,
} from '../utils/supplierMatcher';

interface OverviewProps {
  stats: DashboardStats;
  recentJobs: Job[];
  recentEvents?: ApplicationEvent[];
  companies?: CompanyCacheEntry[];
  aliases?: CompanyAlias[];
  settings?: AppSettings;
  onSaveSettings?: (newSettings: AppSettings) => Promise<void>;
  onSelectJob: (jobId: string) => void;
  onNavigateTab: (tab: string) => void;
  onSyncSheets: () => void;
  onRetryJob?: (jobId: string) => Promise<void> | void;
  onRefreshData?: () => Promise<void> | void;
  isSyncingSheets: boolean;
}

const getBasename = (pathStr?: string): string => {
  if (!pathStr) return 'Document';
  const norm = pathStr.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  return idx >= 0 ? norm.slice(idx + 1) : norm;
};

export const Overview: React.FC<OverviewProps> = ({
  stats,
  recentJobs = [],
  companies = [],
  aliases = [],
  settings,
  onSaveSettings,
  onSelectJob,
  onNavigateTab,
  onSyncSheets,
  onRetryJob,
  onRefreshData,
  isSyncingSheets = false,
}) => {
  const lang: UiLang = resolveUiLang(settings);
  const incomingDir = settings?.incoming_dir || 'C:\\PO-AutoFlow\\Incoming';
  const [filterTab, setFilterTab] = useState<'all' | 'needs_review' | 'completed' | 'failed'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string>('');
  const [isScanning, setIsScanning] = useState(false);

  // Selected job preview & send state
  const [ocrRecords, setOcrRecords] = useState<OcrResultRecord[]>([]);
  const [activeDocIndex, setActiveDocIndex] = useState(0);
  const [viewerMode, setViewerMode] = useState<'visual' | 'text'>('visual');
  const [previewZoom, setPreviewZoom] = useState(100);
  const [preview, setPreview] = useState<PagePreviewResponse | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Inline approval form state
  const [approveCompany, setApproveCompany] = useState('');
  const [approveEmail, setApproveEmail] = useState('');
  const [approvePo, setApprovePo] = useState('');
  const [saveAlias, setSaveAlias] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [isDeepScanning, setIsDeepScanning] = useState(false);
  const [actionMsg, setActionMsg] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(
    null
  );

  const filteredJobs = useMemo(() => {
    return recentJobs.filter((job) => {
      if (filterTab !== 'all' && job.status !== filterTab) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return (
          job.po_folder_name.toLowerCase().includes(q) ||
          (job.po_number && job.po_number.toLowerCase().includes(q)) ||
          (job.matched_company_name && job.matched_company_name.toLowerCase().includes(q)) ||
          (job.detected_company_raw && job.detected_company_raw.toLowerCase().includes(q))
        );
      }
      return true;
    });
  }, [recentJobs, filterTab, searchQuery]);

  // Default to first needs_review job if available, else first job
  const activeJob =
    recentJobs.find((j) => j.id === selectedId) ||
    filteredJobs.find((j) => j.status === 'needs_review') ||
    filteredJobs[0] ||
    recentJobs[0];

  useEffect(() => {
    if (!activeJob?.id) {
      setOcrRecords([]);
      return;
    }
    let cancelled = false;
    api
      .getOcrResults(activeJob.id)
      .then((recs) => {
        if (!cancelled) {
          setOcrRecords(recs || []);
          setActiveDocIndex(0);
        }
      })
      .catch(() => {
        if (!cancelled) setOcrRecords([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeJob?.id]);

  const currentRecord = ocrRecords[activeDocIndex] || ocrRecords[0];

  useEffect(() => {
    if (!activeJob?.id || !currentRecord?.file_path) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setIsLoadingPreview(true);
    setPreviewError(null);
    api
      .getDocumentPagePreview(activeJob.id, currentRecord.file_path, currentRecord.page_number || 1)
      .then((res) => {
        if (cancelled) return;
        if (res.status === 'ok' && res.data_url) {
          setPreview(res);
        } else {
          setPreview(null);
          setPreviewError(res.message || '__UNAVAILABLE__');
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPreview(null);
        setPreviewError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setIsLoadingPreview(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeJob?.id, currentRecord?.id, currentRecord?.file_path, currentRecord?.page_number]);

  const activeJobFolderName = activeJob?.po_folder_name || '';

  const predictions = useMemo(() => {
    const summary = summarizeOcrRecords(ocrRecords, activeJobFolderName);
    return {
      primaryTh: summary.primaryTh,
      primaryEn: summary.primaryEn,
      emails: summary.emails,
      poNums: summary.poNumbers,
    };
  }, [ocrRecords, activeJobFolderName]);

  const uniqueFiles = useMemo(() => {
    const map = new Map<string, number>();
    ocrRecords.forEach((rec, idx) => {
      if (!map.has(rec.file_path)) {
        map.set(rec.file_path, idx);
      }
    });
    return Array.from(map.entries());
  }, [ocrRecords]);

  const activeJobId = activeJob?.id || '';
  const activeJobCompany = activeJob?.matched_company_name || '';
  const activeJobDetected = activeJob?.detected_company_raw || '';
  const activeJobEmail = activeJob?.matched_email || '';
  const activeJobPo = activeJob?.po_number || '';
  const activeJobFolder = activeJob?.po_folder_name || '';

  const jobAutoMatch = useMemo(
    () =>
      matchSupplierAgainstDirectory(
        [activeJobCompany, predictions.primaryTh, predictions.primaryEn, activeJobDetected],
        [activeJobEmail, ...predictions.emails],
        companies,
        aliases
      ),
    [activeJobCompany, predictions, activeJobDetected, activeJobEmail, companies, aliases]
  );

  const liveFormMatch = useMemo(
    () =>
      matchSupplierAgainstDirectory(
        [approveCompany, predictions.primaryTh, predictions.primaryEn, activeJobDetected],
        [approveEmail, ...predictions.emails],
        companies,
        aliases
      ),
    [approveCompany, predictions, activeJobDetected, approveEmail, companies, aliases]
  );

  const sameEmailCombos = useMemo(
    () =>
      findCompaniesSharingEmail(
        approveEmail || activeJobEmail || predictions.emails[0] || '',
        companies
      ),
    [approveEmail, activeJobEmail, predictions.emails, companies]
  );

  useEffect(() => {
    setActionMsg(null);
    const matchedComp =
      companies.find(
        (c) =>
          Boolean(activeJobCompany) &&
          (c.company_name === activeJobCompany || c.alternative_name === activeJobCompany)
      ) || jobAutoMatch.company;
    const defaultComp =
      matchedComp?.company_name ||
      activeJobCompany ||
      predictions.primaryTh ||
      predictions.primaryEn ||
      activeJobDetected ||
      '';
    setApproveCompany(defaultComp);
    setApproveEmail(activeJobEmail || matchedComp?.email || predictions.emails[0] || '');
    setApprovePo(activeJobPo || predictions.poNums[0] || activeJobFolder || '');
  }, [
    activeJobId,
    activeJobCompany,
    activeJobDetected,
    activeJobEmail,
    activeJobPo,
    activeJobFolder,
    companies,
    predictions,
    jobAutoMatch,
  ]);

  const applySheetSupplier = (compName: string) => {
    const found = companies.find(
      (c) => c.company_name === compName || c.alternative_name === compName
    );
    if (!found) return;
    setApproveCompany(found.company_name);
    if (found.email) {
      setApproveEmail(found.email);
    }
  };

  const handleDetectedSupplierPillClick = (rawName: string) => {
    const matched = matchSupplierAgainstDirectory(
      [rawName],
      [approveEmail, ...predictions.emails],
      companies,
      aliases
    );
    if (matched.company && matched.score >= 78) {
      setApproveCompany(matched.company.company_name);
      if (matched.company.email) {
        setApproveEmail(matched.company.email);
      }
    } else {
      setApproveCompany(rawName);
    }
  };

  const handleDetectedEmailPillClick = (emailVal: string) => {
    setApproveEmail(emailVal);
    const sharing = findCompaniesSharingEmail(emailVal, companies);
    if (sharing.length === 1) {
      setApproveCompany(sharing[0].company_name);
    } else if (sharing.length > 1) {
      const best = matchSupplierAgainstDirectory(
        [approveCompany, predictions.primaryTh, predictions.primaryEn, activeJobDetected],
        [emailVal],
        sharing,
        aliases
      );
      if (best.company) {
        setApproveCompany(best.company.company_name);
      }
    }
  };

  const handleApproveCompanyInput = (val: string) => {
    setApproveCompany(val);
    const matched = matchSupplierAgainstDirectory(
      [val],
      [approveEmail, ...predictions.emails],
      companies,
      aliases
    );
    if (matched.company && matched.score >= 88 && matched.company.email) {
      const emailAlreadyBelongs =
        splitEmailAddresses(approveEmail).length > 0 &&
        sameEmailCombos.some((c) => c.id === matched.company?.id);
      if (!emailAlreadyBelongs) {
        setApproveEmail(matched.company.email);
      }
    }
  };

  const handleApproveEmailInput = (val: string) => {
    setApproveEmail(val);
    const sharing = findCompaniesSharingEmail(val, companies);
    if (sharing.length === 1) {
      setApproveCompany(sharing[0].company_name);
    } else if (sharing.length > 1) {
      const best = matchSupplierAgainstDirectory(
        [approveCompany, predictions.primaryTh, predictions.primaryEn, activeJobDetected],
        [val],
        sharing,
        aliases
      );
      if (best.company) {
        setApproveCompany(best.company.company_name);
      }
    }
  };

  const isManualOnly =
    !settings ||
    settings.auto_send_email_enabled === false ||
    settings.auto_send_mode === 'manual_review_all';

  const handleScanNow = async () => {
    setIsScanning(true);
    try {
      const count = await api.triggerFolderScan();
      setActionMsg({
        type: 'info',
        text:
          count > 0
            ? tx(lang, `Found ${count} folder(s) in Incoming.`, `พบโฟลเดอร์ใหม่ ${count} รายการใน Incoming`)
            : tx(lang, 'No new PO folders in Incoming right now.', 'ยังไม่มีโฟลเดอร์ PO ใหม่ใน Incoming'),
      });
      await onRefreshData?.();
    } finally {
      setIsScanning(false);
    }
  };

  const handleToggleAutoSend = async (manualOnly: boolean) => {
    if (!settings || !onSaveSettings) return;
    await onSaveSettings({
      ...settings,
      auto_send_email_enabled: !manualOnly,
      auto_send_mode: manualOnly ? 'manual_review_all' : 'verified_and_high',
    });
  };

  const handleApproveAndSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeJob || !approveCompany.trim() || !approveEmail.trim()) return;
    setIsSending(true);
    setActionMsg(null);
    try {
      const updated = await api.approveAndSendJob(
        activeJob.id,
        approveCompany.trim(),
        approveEmail.trim(),
        approvePo.trim() || undefined,
        saveAlias
      );
      setActionMsg({
        type: 'success',
        text: tx(
          lang,
          `Sent PO ${updated.po_number || activeJob.po_folder_name} to ${
            updated.matched_email || approveEmail
          }.`,
          `ส่งใบสั่งซื้อ ${updated.po_number || activeJob.po_folder_name} ไปยัง ${
            updated.matched_email || approveEmail
          } สำเร็จ`
        ),
      });
      await onRefreshData?.();
    } catch (err: unknown) {
      setActionMsg({
        type: 'error',
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsSending(false);
    }
  };

  const handleRetryActive = async () => {
    if (!activeJob || !onRetryJob) return;
    setIsRetrying(true);
    setActionMsg(null);
    try {
      await onRetryJob(activeJob.id);
      const recs = await api.getOcrResults(activeJob.id);
      setOcrRecords(recs || []);
      setActionMsg({
        type: 'info',
        text: tx(lang, 'Re-scanned PO folder and updated supplier match.', 'สแกนโฟลเดอร์ PO และอัปเดตผลจับคู่ผู้ขายใหม่แล้ว'),
      });
    } catch (err: unknown) {
      setActionMsg({ type: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setIsRetrying(false);
    }
  };

  const handleDeepScanActive = async () => {
    if (!activeJob) return;
    setIsDeepScanning(true);
    setActionMsg(null);
    try {
      await api.deepScanJobWithVision(activeJob.id);
      const recs = await api.getOcrResults(activeJob.id);
      setOcrRecords(recs || []);
      await onRefreshData?.();
      setActionMsg({
        type: 'success',
        text: tx(
          lang,
          'AI Deep Scan completed and updated supplier prediction.',
          'สแกนด้วย Vision AI เสร็จสิ้น และอัปเดตผลชื่อผู้ขายแล้ว'
        ),
      });
    } catch (err: unknown) {
      setActionMsg({ type: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setIsDeepScanning(false);
    }
  };

  const reviewCount = recentJobs.filter((j) => j.status === 'needs_review').length;
  const sentCount = recentJobs.filter((j) => j.status === 'completed').length;
  const failedCount = recentJobs.filter((j) => j.status === 'failed').length;

  return (
    <div className="p-6 space-y-5 max-w-7xl mx-auto">
      {/* Step-by-Step Setup & Quick Status Row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Card 1: Incoming Folder */}
        <div className="p-4 rounded-xl bg-[#121215] border border-zinc-800 flex flex-col justify-between gap-3">
          <div>
            <div className="flex items-center justify-between text-xs text-zinc-400">
              <span className="font-medium text-zinc-200">{tr(lang, 'step1Title')}</span>
              <FolderOpen className="w-4 h-4 text-blue-400" />
            </div>
            <p className="mt-1.5 text-xs font-mono text-zinc-300 truncate" title={incomingDir}>
              {incomingDir}
            </p>
            <p className="mt-1 text-[11px] text-zinc-500">
              {tr(lang, 'step1Desc')}
            </p>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={() => api.openPathInExplorer(incomingDir)}
              className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium transition-colors"
            >
              {tr(lang, 'openIncoming')}
            </button>
            <button
              type="button"
              onClick={handleScanNow}
              disabled={isScanning}
              className="px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs font-medium transition-colors"
            >
              {isScanning ? '...' : tr(lang, 'scanNow')}
            </button>
          </div>
        </div>

        {/* Card 2: Google Sheets Directory */}
        <div className="p-4 rounded-xl bg-[#121215] border border-zinc-800 flex flex-col justify-between gap-3">
          <div>
            <div className="flex items-center justify-between text-xs text-zinc-400">
              <span className="font-medium text-zinc-200">{tr(lang, 'step2Title')}</span>
              <Building2 className="w-4 h-4 text-zinc-400" />
            </div>
            <div className="mt-1.5 flex items-baseline gap-2">
              <span className="text-xl font-semibold text-zinc-100">{companies.length}</span>
              <span className="text-xs text-zinc-400">{tr(lang, 'suppliersSynced')}</span>
            </div>
            <p className="mt-1 text-[11px] text-zinc-500 truncate">
              {companies[0]?.company_name
                ? `${companies[0].company_name}`
                : tx(lang, 'No suppliers synced yet — click Sync Sheet.', 'ยังไม่ได้ซิงก์รายชื่อผู้ขาย — กดปุ่มซิงก์ Google Sheet')}
            </p>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={onSyncSheets}
              disabled={isSyncingSheets}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isSyncingSheets ? 'animate-spin' : ''}`} />
              <span>{isSyncingSheets ? tr(lang, 'syncing') : tr(lang, 'syncSheet')}</span>
            </button>
            <button
              type="button"
              onClick={() => onNavigateTab('directory')}
              className="px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-300 text-xs font-medium transition-colors"
            >
              {tr(lang, 'manage')}
            </button>
          </div>
        </div>

        {/* Card 3: Sending Rule & Attachment Preview */}
        <div className="p-4 rounded-xl bg-[#121215] border border-zinc-800 flex flex-col justify-between gap-3">
          <div>
            <div className="flex items-center justify-between text-xs text-zinc-400">
              <span className="font-medium text-zinc-200">{tr(lang, 'step3Title')}</span>
              <Send className="w-4 h-4 text-emerald-400" />
            </div>
            <p className="mt-1.5 text-xs text-zinc-200 font-medium">
              {isManualOnly
                ? tr(lang, 'holdApproval')
                : tr(lang, 'autoSendActive')}
            </p>
            <p className="mt-1 text-[11px] text-zinc-500">
              {settings?.email_attachment_mode === 'zip_archive'
                ? 'ZIP'
                : tx(lang, 'PDF / Image', 'ไฟล์ PDF / รูปภาพ')}{' '}
              • {tr(lang, 'filterSent')}: {stats.successfully_sent}
            </p>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={() => handleToggleAutoSend(!isManualOnly)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                isManualOnly
                  ? 'bg-amber-500/15 text-amber-300 border-amber-500/30 hover:bg-amber-500/20'
                  : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/20'
              }`}
            >
              {isManualOnly ? tr(lang, 'switchToAuto') : tr(lang, 'switchToAsk')}
            </button>
            <button
              type="button"
              onClick={() => onNavigateTab('settings')}
              className="px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-300 text-xs font-medium transition-colors"
            >
              {tr(lang, 'emailOptions')}
            </button>
          </div>
        </div>
      </div>

      {/* Main Master-Detail PO Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* Left Column: PO Queue */}
        <div className="lg:col-span-5 rounded-xl bg-[#121215] border border-zinc-800 overflow-hidden">
          <div className="p-4 border-b border-zinc-800 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-100">{tr(lang, 'poQueue')}</h3>
              <span className="text-xs text-zinc-400">{recentJobs.length} {tr(lang, 'totalLabel')}</span>
            </div>

            <div className="relative">
              <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-2.5" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={tr(lang, 'searchPoPlaceholder')}
                className="w-full bg-zinc-900 border border-zinc-800 text-zinc-200 text-xs rounded-lg pl-8 pr-3 py-2 focus:outline-none focus:border-blue-500 placeholder-zinc-500"
              />
            </div>

            <div className="flex flex-wrap gap-1.5 text-[11px]">
              {(
                [
                  { id: 'all', label: `${tr(lang, 'filterAll')} (${recentJobs.length})` },
                  { id: 'needs_review', label: `${tr(lang, 'filterReview')} (${reviewCount})` },
                  { id: 'completed', label: `${tr(lang, 'filterSent')} (${sentCount})` },
                  { id: 'failed', label: `${tr(lang, 'filterFailed')} (${failedCount})` },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setFilterTab(tab.id)}
                  className={`px-2.5 py-1 rounded-md font-medium transition-colors ${
                    filterTab === tab.id
                      ? 'bg-zinc-800 text-white'
                      : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          <div className="divide-y divide-zinc-800/70 max-h-[640px] overflow-y-auto">
            {filteredJobs.length === 0 ? (
              <div className="p-8 text-center space-y-2">
                <FileText className="w-8 h-8 text-zinc-700 mx-auto" />
                <p className="text-sm font-medium text-zinc-300">{tr(lang, 'noPoFolders')}</p>
                <p className="text-xs text-zinc-500 max-w-xs mx-auto">
                  {tx(lang, 'Drop a PO folder inside', 'นำโฟลเดอร์ PO มาวางใน')}{' '}
                  <code className="text-zinc-300">{incomingDir}</code>{' '}
                  {tx(lang, 'and click Scan Now.', 'แล้วกดสแกนทันที')}
                </p>
              </div>
            ) : (
              filteredJobs.map((job) => {
                const isSelected = activeJob?.id === job.id;
                return (
                  <button
                    key={job.id}
                    type="button"
                    onClick={() => setSelectedId(job.id)}
                    className={`w-full text-left p-4 transition-colors ${
                      isSelected ? 'bg-zinc-800/70' : 'hover:bg-zinc-900/80'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-zinc-100 truncate">
                        {job.po_number || job.po_folder_name}
                      </span>
                      <StatusBadge status={job.status} lang={lang} />
                    </div>
                    <p className="mt-1 text-xs text-zinc-300 truncate">
                      {job.matched_company_name ||
                        job.detected_company_raw ||
                        tx(lang, 'Detecting supplier...', 'กำลังอ่านชื่อผู้ขาย...')}
                    </p>
                    <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-zinc-500">
                      <span className="truncate font-mono">
                        {job.matched_email || tx(lang, 'No email yet', 'ยังไม่มีอีเมล')}
                      </span>
                      {typeof job.match_confidence === 'number' && (
                        <span className="font-mono text-zinc-400 shrink-0">
                          {job.match_confidence.toFixed(0)}%
                        </span>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Right Column: Live Document Preview & Send Panel */}
        <div className="lg:col-span-7 rounded-xl bg-[#121215] border border-zinc-800 overflow-hidden">
          {!activeJob ? (
            <div className="p-12 text-center space-y-2 text-zinc-500">
              <FileText className="w-10 h-10 text-zinc-700 mx-auto" />
              <p className="text-sm font-medium text-zinc-300">
                {tx(lang, 'Select a PO from the list on the left', 'เลือกรายการใบสั่งซื้อจากคิวด้านซ้าย')}
              </p>
              <p className="text-xs">
                {tx(
                  lang,
                  'You will see every attached PDF right here and can verify or send the email in one click.',
                  'ดูไฟล์ PDF แนบทั้งหมดได้ที่นี่ และกดตรวจสอบหรืออนุมัติส่งอีเมลได้ในคลิกเดียว'
                )}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-zinc-800">
              {/* PO Header Bar */}
              <div className="p-4 flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2.5">
                    <h3 className="text-base font-semibold text-zinc-100">
                      {activeJob.po_number || activeJob.po_folder_name}
                    </h3>
                    <StatusBadge status={activeJob.status} lang={lang} />
                  </div>
                  <p className="text-xs text-zinc-400 mt-0.5 truncate" title={activeJob.stage_message}>
                    {activeJob.stage_message}
                  </p>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {onRetryJob && (
                    <button
                      type="button"
                      onClick={handleRetryActive}
                      disabled={isRetrying || isDeepScanning}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-xs font-medium text-zinc-200 transition-colors disabled:opacity-50"
                    >
                      <RotateCw className={`w-3.5 h-3.5 ${isRetrying ? 'animate-spin' : ''}`} />
                      <span>{isRetrying ? tx(lang, 'Scanning...', 'กำลังสแกน...') : tr(lang, 'rescan')}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleDeepScanActive}
                    disabled={isDeepScanning || isRetrying}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-600/20 hover:bg-purple-600/30 border border-purple-500/40 text-xs font-medium text-purple-200 transition-colors disabled:opacity-50"
                    title={tx(lang, 'Force-run Built-In Vision AI on this PO now', 'บังคับใช้ Vision AI ช่วยอ่านเอกสาร PO ใบนี้')}
                  >
                    <Sparkles className={`w-3.5 h-3.5 ${isDeepScanning ? 'animate-pulse' : ''}`} />
                    <span>{isDeepScanning ? tx(lang, 'AI Scanning...', 'AI กำลังอ่าน...') : tr(lang, 'deepScanAi')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onSelectJob(activeJob.id)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-100 transition-colors"
                  >
                    <Maximize2 className="w-3.5 h-3.5" />
                    <span>{tx(lang, 'Full Viewer', 'มุมมองเต็มจอ')}</span>
                  </button>
                </div>
              </div>

              {/* Document File Switcher + Live Visual Page Preview */}
              <div className="p-4 space-y-3 bg-[#09090b]/60">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 overflow-x-auto">
                    {ocrRecords.map((rec, idx) => (
                      <button
                        key={rec.id}
                        type="button"
                        onClick={() => setActiveDocIndex(idx)}
                        className={`px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap border transition-colors ${
                          idx === activeDocIndex
                            ? 'bg-zinc-800 text-white border-zinc-600'
                            : 'bg-zinc-900/70 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                        }`}
                      >
                        {getBasename(rec.file_path)}
                      </button>
                    ))}
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <div className="flex rounded-md bg-zinc-950 p-0.5 border border-zinc-800">
                      <button
                        type="button"
                        onClick={() => setViewerMode('visual')}
                        className={`px-2 py-0.5 rounded text-[11px] font-medium flex items-center gap-1 ${
                          viewerMode === 'visual' ? 'bg-blue-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
                        }`}
                      >
                        <Eye className="w-3 h-3" />
                        <span>{tx(lang, 'Page', 'ภาพหน้า')}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setViewerMode('text')}
                        className={`px-2 py-0.5 rounded text-[11px] font-medium flex items-center gap-1 ${
                          viewerMode === 'text' ? 'bg-blue-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
                        }`}
                      >
                        <FileText className="w-3 h-3" />
                        <span>{tx(lang, 'Text', 'ข้อความ')}</span>
                      </button>
                    </div>

                    <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-md overflow-hidden">
                      <button
                        type="button"
                        onClick={() => setPreviewZoom((z) => Math.max(60, z - 20))}
                        className="p-1 hover:bg-zinc-800 text-zinc-300"
                        title={tx(lang, 'Zoom out', 'ซูมออก')}
                      >
                        <ZoomOut className="w-3 h-3" />
                      </button>
                      <span className="px-1.5 text-[10px] font-mono text-zinc-300">{previewZoom}%</span>
                      <button
                        type="button"
                        onClick={() => setPreviewZoom((z) => Math.min(200, z + 20))}
                        className="p-1 hover:bg-zinc-800 text-zinc-300"
                        title={tx(lang, 'Zoom in', 'ซูมเข้า')}
                      >
                        <ZoomIn className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setPreviewZoom(100)}
                        className="p-1 hover:bg-zinc-800 text-zinc-400 border-l border-zinc-800"
                        title={tx(lang, 'Reset zoom', 'ขนาดปกติ')}
                      >
                        <RotateCcw className="w-3 h-3" />
                      </button>
                    </div>

                    {currentRecord && (
                      <button
                        type="button"
                        onClick={() => api.openJobDocument(activeJob.id, currentRecord.file_path)}
                        className="px-2 py-1 rounded-md bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-200 text-[11px] flex items-center gap-1"
                        title={tx(lang, 'Open file in Windows PDF viewer', 'เปิดไฟล์ด้วยโปรแกรมอ่าน PDF ของ Windows')}
                      >
                        <ExternalLink className="w-3 h-3 text-blue-400" />
                        <span>{tr(lang, 'openPdf')}</span>
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => api.openJobDocument(activeJob.id)}
                      className="px-2 py-1 rounded-md bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-200 text-[11px] flex items-center gap-1"
                      title={tx(lang, 'Open job folder in Windows Explorer', 'เปิดโฟลเดอร์งานนี้ใน Windows Explorer')}
                    >
                      <FolderOpen className="w-3 h-3 text-amber-400" />
                    </button>
                  </div>
                </div>

                <div className="h-[380px] rounded-lg border border-zinc-800 bg-zinc-950 overflow-auto p-3">
                  {!currentRecord ? (
                    <div className="h-full flex flex-col items-center justify-center text-xs text-zinc-500 gap-2">
                      <FileText className="w-7 h-7 text-zinc-700" />
                      <span>{tx(lang, 'No extracted document pages yet. Click Re-Scan above.', 'ยังไม่มีหน้าที่แยกข้อความไว้ กด "สแกนใหม่" ด้านบน')}</span>
                    </div>
                  ) : viewerMode === 'text' ? (
                    <pre
                      style={{ fontSize: `${Math.round((12 * previewZoom) / 100)}px` }}
                      className="font-mono text-zinc-300 whitespace-pre-wrap leading-relaxed select-text"
                    >
                      {currentRecord.raw_text || tx(lang, 'No text content', 'ไม่มีข้อความ')}
                    </pre>
                  ) : isLoadingPreview ? (
                    <div className="h-full flex flex-col items-center justify-center text-xs text-zinc-400 gap-2">
                      <Loader2 className="w-6 h-6 animate-spin text-blue-400" />
                      <span>{tx(lang, 'Rendering PDF page...', 'กำลังโหลดภาพหน้า PDF...')}</span>
                    </div>
                  ) : preview?.data_url ? (
                    <div
                      className="mx-auto shadow-lg rounded bg-white"
                      style={{ width: `${previewZoom}%`, minWidth: previewZoom > 100 ? `${previewZoom}%` : undefined }}
                    >
                      <img
                        src={preview.data_url}
                        alt={getBasename(currentRecord.file_path)}
                        className="w-full h-auto block rounded"
                      />
                    </div>
                  ) : (
                    <div className="w-full text-left space-y-2 p-2">
                      {previewError && (
                        <p className="text-[11px] text-amber-400">
                          {previewError === '__UNAVAILABLE__'
                            ? tx(lang, 'Preview not available for this file.', 'ไม่สามารถแสดงพรีวิวของไฟล์นี้ได้')
                            : previewError}
                        </p>
                      )}
                      <pre className="text-xs font-mono text-zinc-300 whitespace-pre-wrap leading-relaxed">
                        {currentRecord.raw_text || tx(lang, 'No text content', 'ไม่มีข้อความ')}
                      </pre>
                    </div>
                  )}
                </div>
              </div>

              {/* Approve & Send Form */}
              <form onSubmit={handleApproveAndSend} className="p-4 space-y-3.5">
                {actionMsg && (
                  <div
                    className={`p-3 rounded-lg border text-xs flex items-center gap-2 ${
                      actionMsg.type === 'success'
                        ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                        : actionMsg.type === 'error'
                        ? 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                        : 'bg-blue-500/10 border-blue-500/30 text-blue-300'
                    }`}
                  >
                    {actionMsg.type === 'success' ? (
                      <CheckCircle2 className="w-4 h-4 shrink-0" />
                    ) : (
                      <AlertTriangle className="w-4 h-4 shrink-0" />
                    )}
                    <span>{actionMsg.text}</span>
                  </div>
                )}

                {/* Predicted Values Pills (Thai first, then English, then PDF email) */}
                {(predictions.primaryTh || predictions.primaryEn || predictions.emails.length > 0) && (
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span className="text-zinc-500">{tx(lang, 'Detected in PDF:', 'พบในเอกสาร PDF:')}</span>
                    {predictions.primaryTh && (
                      <button
                        type="button"
                        onClick={() => handleDetectedSupplierPillClick(predictions.primaryTh!)}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/25 hover:bg-emerald-500/20"
                      >
                        <Languages className="w-3 h-3" /> {predictions.primaryTh}
                      </button>
                    )}
                    {predictions.primaryEn && (
                      <button
                        type="button"
                        onClick={() => handleDetectedSupplierPillClick(predictions.primaryEn!)}
                        className="px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-zinc-700 hover:bg-zinc-700"
                      >
                        {predictions.primaryEn}
                      </button>
                    )}
                    {predictions.emails.map((em) => (
                      <button
                        key={em}
                        type="button"
                        onClick={() => handleDetectedEmailPillClick(em)}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-blue-500/10 text-blue-300 border border-blue-500/25 hover:bg-blue-500/20 font-mono"
                      >
                        <Mail className="w-3 h-3" /> {em}
                      </button>
                    ))}
                  </div>
                )}

                {companies.length > 0 && (
                  <div className="text-xs space-y-1.5">
                    <label className="text-zinc-400 block">
                      {tx(lang, 'Choose Supplier from Google Sheet:', 'เลือกชื่อผู้ขายจาก Google Sheet:')}
                    </label>
                    <select
                      value={liveFormMatch.company && liveFormMatch.score >= 82 ? liveFormMatch.company.company_name : ''}
                      onChange={(e) => {
                        if (e.target.value) applySheetSupplier(e.target.value);
                      }}
                      className="w-full bg-zinc-900 border border-zinc-800 text-zinc-200 rounded-lg px-3 py-2 text-xs"
                    >
                      <option value="">
                        {tx(
                          lang,
                          `-- Fill from synced Google Sheet (${companies.length}) --`,
                          `-- เลือกข้อมูลจาก Google Sheet (${companies.length} ราย) --`
                        )}
                      </option>
                      {companies.map((c) => (
                        <option key={c.id} value={c.company_name}>
                          {c.vendor_group ? `[${c.vendor_group}] ` : ''}
                          {c.company_name}
                          {c.alternative_name ? ` / ${c.alternative_name}` : ''} ({c.email})
                        </option>
                      ))}
                    </select>

                    {liveFormMatch.company && (
                      <div className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/25 text-[11px] text-emerald-300">
                        <span>
                          {tx(lang, 'Sheet Match:', 'ตรงกับ Sheet:')}{' '}
                          <strong className="text-emerald-200">{liveFormMatch.company.company_name}</strong>
                          {liveFormMatch.company.alternative_name
                            ? ` (${liveFormMatch.company.alternative_name})`
                            : ''}{' '}
                          · {liveFormMatch.score.toFixed(0)}% ({liveFormMatch.matchedBy})
                        </span>
                        <button
                          type="button"
                          onClick={() => applySheetSupplier(liveFormMatch.company!.company_name)}
                          className="px-2 py-0.5 rounded bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-100 font-medium"
                        >
                          {tx(lang, 'Apply Match', 'ใช้ข้อมูลนี้')}
                        </button>
                      </div>
                    )}

                    {sameEmailCombos.length > 1 && (
                      <div className="flex flex-wrap items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/25 text-[11px] text-amber-300">
                        <span>
                          {tx(
                            lang,
                            `${sameEmailCombos.length} Sheet companies share this email:`,
                            `มี ${sameEmailCombos.length} บริษัทใน Sheet ใช้อีเมลนี้ร่วมกัน:`
                          )}
                        </span>
                        {sameEmailCombos.map((comp) => (
                          <button
                            key={comp.id}
                            type="button"
                            onClick={() => applySheetSupplier(comp.company_name)}
                            className={`px-2 py-0.5 rounded border text-[11px] transition-colors ${
                              approveCompany === comp.company_name
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

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  <div className="sm:col-span-2">
                    <label className="text-zinc-400 block mb-1">
                      {tx(lang, 'Supplier Name (Thai First):', 'ชื่อผู้ขาย (เน้นชื่อไทยก่อน):')}
                    </label>
                    <input
                      type="text"
                      required
                      value={approveCompany}
                      onChange={(e) => handleApproveCompanyInput(e.target.value)}
                      placeholder={tx(lang, 'Supplier company name', 'ชื่อบริษัทผู้ขาย')}
                      className="w-full bg-zinc-900 border border-zinc-800 text-zinc-100 rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-blue-500"
                    />
                  </div>

                  <div>
                    <label className="text-zinc-400 block mb-1">
                      {tx(lang, 'Send To Email:', 'ส่งไปยังอีเมล:')}
                    </label>
                    <input
                      type="text"
                      required
                      value={approveEmail}
                      onChange={(e) => handleApproveEmailInput(e.target.value)}
                      placeholder="ooo@email.com, aaa@gmail.com"
                      className="w-full bg-zinc-900 border border-zinc-800 text-zinc-100 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:border-blue-500"
                    />
                  </div>

                  <div>
                    <label className="text-zinc-400 block mb-1">
                      {tx(lang, 'PO Number:', 'เลขที่ใบสั่งซื้อ (PO Number):')}
                    </label>
                    <input
                      type="text"
                      value={approvePo}
                      onChange={(e) => setApprovePo(e.target.value)}
                      placeholder="PO-26004156"
                      className="w-full bg-zinc-900 border border-zinc-800 text-zinc-100 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:border-blue-500"
                    />
                  </div>
                </div>

                {uniqueFiles.length > 0 && (
                  <div className="text-[11px] text-zinc-400 flex flex-wrap items-center gap-1.5">
                    <span>
                      {tx(
                        lang,
                        `Email attachments (${uniqueFiles.length} previewable files):`,
                        `ไฟล์แนบอีเมล (${uniqueFiles.length} ไฟล์):`
                      )}
                    </span>
                    {uniqueFiles.map(([path]) => (
                      <span
                        key={path}
                        className="px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-300"
                      >
                        {getBasename(path)}
                      </span>
                    ))}
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                  <div className="space-y-1">
                    <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={saveAlias}
                        onChange={(e) => setSaveAlias(e.target.checked)}
                        className="rounded border-zinc-700 bg-zinc-900 text-blue-600"
                      />
                      <span>{tx(lang, 'Remember supplier name for next time', 'จำชื่อผู้ขายนี้ไว้จับคู่อัตโนมัติครั้งถัดไป')}</span>
                    </label>
                    {saveAlias && (!activeJob.matched_company_name || activeJob.match_category === 'no_match') && (
                      <p className="text-[11px] text-emerald-400/90 pl-5">
                        {tr(lang, 'willSaveNewSupplierSheet')}
                      </p>
                    )}
                  </div>

                  <button
                    type="submit"
                    disabled={isSending || activeJob.status === 'completed'}
                    className="px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-2 transition-colors"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>
                      {activeJob.status === 'completed'
                        ? tx(lang, 'Already Sent', 'ส่งแล้ว')
                        : isSending
                        ? tx(lang, 'Sending Email...', 'กำลังส่งอีเมล...')
                        : tr(lang, 'approveAndSend')}
                    </span>
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export const StatusBadge: React.FC<{ status: string; lang?: UiLang }> = ({ status, lang = 'en' }) => {
  switch (status) {
    case 'completed':
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-500/15 text-emerald-300 border border-emerald-500/25">
          {tx(lang, 'Sent', 'ส่งแล้ว')}
        </span>
      );
    case 'needs_review':
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-amber-500/15 text-amber-300 border border-amber-500/25">
          {tx(lang, 'Needs Review', 'รอตรวจสอบ')}
        </span>
      );
    case 'failed':
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-rose-500/15 text-rose-300 border border-rose-500/25">
          {tx(lang, 'Failed', 'ผิดพลาด')}
        </span>
      );
    case 'waiting_stability':
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-blue-500/15 text-blue-300 border border-blue-500/25">
          {tx(lang, 'Checking Files...', 'กำลังเช็คไฟล์...')}
        </span>
      );
    case 'ocr_processing':
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-indigo-500/15 text-indigo-300 border border-indigo-500/25">
          {tx(lang, 'Reading PDF...', 'กำลังอ่าน PDF...')}
        </span>
      );
    case 'matching_company':
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-zinc-800 text-zinc-200 border border-zinc-700">
          {tx(lang, 'Matching Vendor...', 'กำลังจับคู่ผู้ขาย...')}
        </span>
      );
    case 'uploading_drive':
    case 'sending_email':
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-cyan-500/15 text-cyan-300 border border-cyan-500/25">
          {tx(lang, 'Sending...', 'กำลังส่ง...')}
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-zinc-800 text-zinc-400">
          {status}
        </span>
      );
  }
};
