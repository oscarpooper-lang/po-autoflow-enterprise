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
} from 'lucide-react';
import type {
  DashboardStats,
  Job,
  ApplicationEvent,
  AppSettings,
  CompanyCacheEntry,
  OcrResultRecord,
  PagePreviewResponse,
} from '../types';
import { api } from '../services/tauri';

interface OverviewProps {
  stats: DashboardStats;
  recentJobs: Job[];
  recentEvents?: ApplicationEvent[];
  companies?: CompanyCacheEntry[];
  settings?: AppSettings;
  onSaveSettings?: (newSettings: AppSettings) => Promise<void>;
  onSelectJob: (jobId: string) => void;
  onNavigateTab: (tab: string) => void;
  onSyncSheets: () => void;
  onRetryJob?: (jobId: string) => Promise<void> | void;
  onRefreshData?: () => Promise<void> | void;
  isSyncingSheets: boolean;
}

interface ParsedEntitiesMini {
  po_numbers?: string[];
  emails?: string[];
  primary_supplier_th?: string | null;
  primary_supplier_en?: string | null;
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
  settings,
  onSaveSettings,
  onSelectJob,
  onNavigateTab,
  onSyncSheets,
  onRetryJob,
  onRefreshData,
  isSyncingSheets = false,
}) => {
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
          setPreviewError(res.message || 'Preview not available for this file.');
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

  const predictions = useMemo(() => {
    let primaryTh: string | null = null;
    let primaryEn: string | null = null;
    const emails: string[] = [];
    const poNums: string[] = [];

    for (const rec of ocrRecords) {
      if (!rec.detected_entities_json) continue;
      try {
        const parsed = JSON.parse(rec.detected_entities_json) as ParsedEntitiesMini;
        if (!primaryTh && parsed.primary_supplier_th) primaryTh = parsed.primary_supplier_th;
        if (!primaryEn && parsed.primary_supplier_en) primaryEn = parsed.primary_supplier_en;
        for (const e of parsed.emails || []) {
          if (e && !emails.includes(e)) emails.push(e);
        }
        for (const p of parsed.po_numbers || []) {
          if (p && !poNums.includes(p)) poNums.push(p);
        }
      } catch {
        // Ignore malformed entity JSON
      }
    }
    return { primaryTh, primaryEn, emails, poNums };
  }, [ocrRecords]);

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

  useEffect(() => {
    setActionMsg(null);
    const defaultComp =
      activeJobCompany || predictions.primaryTh || predictions.primaryEn || activeJobDetected || '';
    setApproveCompany(defaultComp);
    const dirMatch = companies.find(
      (c) => c.company_name === defaultComp || c.alternative_name === defaultComp
    );
    setApproveEmail(activeJobEmail || dirMatch?.email || predictions.emails[0] || '');
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
  ]);

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
        text: count > 0 ? `Found ${count} folder(s) in Incoming.` : 'No new PO folders in Incoming right now.',
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
        text: `Sent PO ${updated.po_number || activeJob.po_folder_name} to ${
          updated.matched_email || approveEmail
        }.`,
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
      setActionMsg({ type: 'info', text: 'Re-scanned PO folder and updated supplier match.' });
    } catch (err: unknown) {
      setActionMsg({ type: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setIsRetrying(false);
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
              <span className="font-medium text-zinc-200">1. Incoming PO Folder</span>
              <FolderOpen className="w-4 h-4 text-blue-400" />
            </div>
            <p className="mt-1.5 text-xs font-mono text-zinc-300 truncate" title={incomingDir}>
              {incomingDir}
            </p>
            <p className="mt-1 text-[11px] text-zinc-500">
              Drop a PO folder here to start. Closing window minimizes to tray.
            </p>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={() => api.openPathInExplorer(incomingDir)}
              className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium transition-colors"
            >
              Open Folder
            </button>
            <button
              type="button"
              onClick={handleScanNow}
              disabled={isScanning}
              className="px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs font-medium transition-colors"
            >
              {isScanning ? 'Scanning...' : 'Scan Now'}
            </button>
          </div>
        </div>

        {/* Card 2: Google Sheets Directory */}
        <div className="p-4 rounded-xl bg-[#121215] border border-zinc-800 flex flex-col justify-between gap-3">
          <div>
            <div className="flex items-center justify-between text-xs text-zinc-400">
              <span className="font-medium text-zinc-200">2. Supplier Directory</span>
              <Building2 className="w-4 h-4 text-zinc-400" />
            </div>
            <div className="mt-1.5 flex items-baseline gap-2">
              <span className="text-xl font-semibold text-zinc-100">{companies.length}</span>
              <span className="text-xs text-zinc-400">suppliers synced</span>
            </div>
            <p className="mt-1 text-[11px] text-zinc-500 truncate">
              {companies[0]?.company_name
                ? `Example: ${companies[0].company_name}`
                : 'No suppliers synced yet — click Sync Sheet.'}
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
              <span>{isSyncingSheets ? 'Syncing...' : 'Sync Sheet'}</span>
            </button>
            <button
              type="button"
              onClick={() => onNavigateTab('directory')}
              className="px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-300 text-xs font-medium transition-colors"
            >
              Manage
            </button>
          </div>
        </div>

        {/* Card 3: Sending Rule & Attachment Preview */}
        <div className="p-4 rounded-xl bg-[#121215] border border-zinc-800 flex flex-col justify-between gap-3">
          <div>
            <div className="flex items-center justify-between text-xs text-zinc-400">
              <span className="font-medium text-zinc-200">3. Email Sending Rule</span>
              <Send className="w-4 h-4 text-emerald-400" />
            </div>
            <p className="mt-1.5 text-xs text-zinc-200 font-medium">
              {isManualOnly
                ? 'Hold for my approval before sending'
                : 'Auto-send matched POs directly'}
            </p>
            <p className="mt-1 text-[11px] text-zinc-500">
              Attachments:{' '}
              {settings?.email_attachment_mode === 'zip_archive'
                ? 'Single ZIP file'
                : 'Individual previewable PDFs & images'}
              {' • '}Sent: {stats.successfully_sent}
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
              {isManualOnly ? 'Switch to Auto-Send' : 'Switch to Ask First'}
            </button>
            <button
              type="button"
              onClick={() => onNavigateTab('settings')}
              className="px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-300 text-xs font-medium transition-colors"
            >
              Email Options
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
              <h3 className="text-sm font-semibold text-zinc-100">PO Queue</h3>
              <span className="text-xs text-zinc-400">{recentJobs.length} total</span>
            </div>

            <div className="relative">
              <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-2.5" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search PO number or supplier..."
                className="w-full bg-zinc-900 border border-zinc-800 text-zinc-200 text-xs rounded-lg pl-8 pr-3 py-2 focus:outline-none focus:border-blue-500 placeholder-zinc-500"
              />
            </div>

            <div className="flex flex-wrap gap-1.5 text-[11px]">
              {(
                [
                  { id: 'all', label: `All (${recentJobs.length})` },
                  { id: 'needs_review', label: `Review (${reviewCount})` },
                  { id: 'completed', label: `Sent (${sentCount})` },
                  { id: 'failed', label: `Failed (${failedCount})` },
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
                <p className="text-sm font-medium text-zinc-300">No PO folders in this view</p>
                <p className="text-xs text-zinc-500 max-w-xs mx-auto">
                  Drop a PO folder inside <code className="text-zinc-300">{incomingDir}</code> and click Scan Now.
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
                      <StatusBadge status={job.status} />
                    </div>
                    <p className="mt-1 text-xs text-zinc-300 truncate">
                      {job.matched_company_name || job.detected_company_raw || 'Detecting supplier...'}
                    </p>
                    <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-zinc-500">
                      <span className="truncate font-mono">{job.matched_email || 'No email yet'}</span>
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
              <p className="text-sm font-medium text-zinc-300">Select a PO from the list on the left</p>
              <p className="text-xs">
                You will see every attached PDF right here and can verify or send the email in one click.
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
                    <StatusBadge status={activeJob.status} />
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
                      disabled={isRetrying}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-xs font-medium text-zinc-200 transition-colors"
                    >
                      <RotateCw className={`w-3.5 h-3.5 ${isRetrying ? 'animate-spin' : ''}`} />
                      <span>{isRetrying ? 'Scanning...' : 'Re-Scan'}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onSelectJob(activeJob.id)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-100 transition-colors"
                  >
                    <Maximize2 className="w-3.5 h-3.5" />
                    <span>Full Viewer</span>
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
                        <span>Page</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setViewerMode('text')}
                        className={`px-2 py-0.5 rounded text-[11px] font-medium flex items-center gap-1 ${
                          viewerMode === 'text' ? 'bg-blue-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
                        }`}
                      >
                        <FileText className="w-3 h-3" />
                        <span>Text</span>
                      </button>
                    </div>

                    <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-md overflow-hidden">
                      <button
                        type="button"
                        onClick={() => setPreviewZoom((z) => Math.max(60, z - 20))}
                        className="p-1 hover:bg-zinc-800 text-zinc-300"
                        title="Zoom out"
                      >
                        <ZoomOut className="w-3 h-3" />
                      </button>
                      <span className="px-1.5 text-[10px] font-mono text-zinc-300">{previewZoom}%</span>
                      <button
                        type="button"
                        onClick={() => setPreviewZoom((z) => Math.min(200, z + 20))}
                        className="p-1 hover:bg-zinc-800 text-zinc-300"
                        title="Zoom in"
                      >
                        <ZoomIn className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setPreviewZoom(100)}
                        className="p-1 hover:bg-zinc-800 text-zinc-400 border-l border-zinc-800"
                        title="Reset zoom"
                      >
                        <RotateCcw className="w-3 h-3" />
                      </button>
                    </div>

                    {currentRecord && (
                      <button
                        type="button"
                        onClick={() => api.openJobDocument(activeJob.id, currentRecord.file_path)}
                        className="px-2 py-1 rounded-md bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-200 text-[11px] flex items-center gap-1"
                        title="Open file in Windows PDF viewer"
                      >
                        <ExternalLink className="w-3 h-3 text-blue-400" />
                        <span>Open PDF</span>
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => api.openJobDocument(activeJob.id)}
                      className="px-2 py-1 rounded-md bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-200 text-[11px] flex items-center gap-1"
                      title="Open job folder in Windows Explorer"
                    >
                      <FolderOpen className="w-3 h-3 text-amber-400" />
                    </button>
                  </div>
                </div>

                <div className="h-[380px] rounded-lg border border-zinc-800 bg-zinc-950 overflow-auto p-3">
                  {!currentRecord ? (
                    <div className="h-full flex flex-col items-center justify-center text-xs text-zinc-500 gap-2">
                      <FileText className="w-7 h-7 text-zinc-700" />
                      <span>No extracted document pages yet. Click Re-Scan above.</span>
                    </div>
                  ) : viewerMode === 'text' ? (
                    <pre
                      style={{ fontSize: `${Math.round((12 * previewZoom) / 100)}px` }}
                      className="font-mono text-zinc-300 whitespace-pre-wrap leading-relaxed select-text"
                    >
                      {currentRecord.raw_text || 'No text content'}
                    </pre>
                  ) : isLoadingPreview ? (
                    <div className="h-full flex flex-col items-center justify-center text-xs text-zinc-400 gap-2">
                      <Loader2 className="w-6 h-6 animate-spin text-blue-400" />
                      <span>Rendering PDF page...</span>
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
                        <p className="text-[11px] text-amber-400">{previewError}</p>
                      )}
                      <pre className="text-xs font-mono text-zinc-300 whitespace-pre-wrap leading-relaxed">
                        {currentRecord.raw_text || 'No text content'}
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
                    <span className="text-zinc-500">Detected in PDF:</span>
                    {predictions.primaryTh && (
                      <button
                        type="button"
                        onClick={() => setApproveCompany(predictions.primaryTh!)}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/25 hover:bg-emerald-500/20"
                      >
                        <Languages className="w-3 h-3" /> {predictions.primaryTh}
                      </button>
                    )}
                    {predictions.primaryEn && (
                      <button
                        type="button"
                        onClick={() => setApproveCompany(predictions.primaryEn!)}
                        className="px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-zinc-700 hover:bg-zinc-700"
                      >
                        {predictions.primaryEn}
                      </button>
                    )}
                    {predictions.emails.map((em) => (
                      <button
                        key={em}
                        type="button"
                        onClick={() => setApproveEmail(em)}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-blue-500/10 text-blue-300 border border-blue-500/25 hover:bg-blue-500/20 font-mono"
                      >
                        <Mail className="w-3 h-3" /> {em}
                      </button>
                    ))}
                  </div>
                )}

                {companies.length > 0 && (
                  <div className="text-xs">
                    <label className="text-zinc-400 block mb-1">Choose Supplier from Google Sheet:</label>
                    <select
                      value=""
                      onChange={(e) => {
                        const found = companies.find((c) => c.company_name === e.target.value);
                        if (found) {
                          setApproveCompany(found.company_name);
                          setApproveEmail(found.email);
                        }
                      }}
                      className="w-full bg-zinc-900 border border-zinc-800 text-zinc-200 rounded-lg px-3 py-2 text-xs"
                    >
                      <option value="">-- Fill from synced Google Sheet ({companies.length}) --</option>
                      {companies.map((c) => (
                        <option key={c.id} value={c.company_name}>
                          {c.company_name} ({c.email})
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  <div className="sm:col-span-2">
                    <label className="text-zinc-400 block mb-1">Supplier Name (Thai First):</label>
                    <input
                      type="text"
                      required
                      value={approveCompany}
                      onChange={(e) => setApproveCompany(e.target.value)}
                      placeholder="Supplier company name"
                      className="w-full bg-zinc-900 border border-zinc-800 text-zinc-100 rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-blue-500"
                    />
                  </div>

                  <div>
                    <label className="text-zinc-400 block mb-1">Send To Email:</label>
                    <input
                      type="email"
                      required
                      value={approveEmail}
                      onChange={(e) => setApproveEmail(e.target.value)}
                      placeholder="supplier@company.com"
                      className="w-full bg-zinc-900 border border-zinc-800 text-zinc-100 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:border-blue-500"
                    />
                  </div>

                  <div>
                    <label className="text-zinc-400 block mb-1">PO Number:</label>
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
                    <span>Email attachments ({uniqueFiles.length} previewable files):</span>
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
                  <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={saveAlias}
                      onChange={(e) => setSaveAlias(e.target.checked)}
                      className="rounded border-zinc-700 bg-zinc-900 text-blue-600"
                    />
                    <span>Remember supplier name for next time</span>
                  </label>

                  <button
                    type="submit"
                    disabled={isSending || activeJob.status === 'completed'}
                    className="px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-2 transition-colors"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>
                      {activeJob.status === 'completed'
                        ? 'Already Sent'
                        : isSending
                        ? 'Sending Email...'
                        : 'Approve & Send Email'}
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

export const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  switch (status) {
    case 'completed':
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-500/15 text-emerald-300 border border-emerald-500/25">
          Sent
        </span>
      );
    case 'needs_review':
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-amber-500/15 text-amber-300 border border-amber-500/25">
          Needs Review
        </span>
      );
    case 'failed':
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-rose-500/15 text-rose-300 border border-rose-500/25">
          Failed
        </span>
      );
    case 'waiting_stability':
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-blue-500/15 text-blue-300 border border-blue-500/25">
          Checking Files...
        </span>
      );
    case 'ocr_processing':
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-indigo-500/15 text-indigo-300 border border-indigo-500/25">
          Reading PDF...
        </span>
      );
    case 'matching_company':
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-zinc-800 text-zinc-200 border border-zinc-700">
          Matching Vendor...
        </span>
      );
    case 'uploading_drive':
    case 'sending_email':
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-cyan-500/15 text-cyan-300 border border-cyan-500/25">
          Sending...
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
