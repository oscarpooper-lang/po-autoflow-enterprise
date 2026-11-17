import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Terminal,
  Bug,
  FolderOpen,
  Activity,
  Cpu,
  RefreshCw,
  Trash2,
  Play,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  FileSearch,
  Copy,
  Send,
} from 'lucide-react';
import type {
  AppSettings,
  ApplicationEvent,
  SystemDiagnostics,
  DeveloperConsoleSnapshot,
} from '../types';
import { api } from '../services/tauri';
import { tx, type UiLang } from '../i18n';

interface DeveloperOptionsProps {
  settings: AppSettings;
  onSaveSettings: (newSettings: AppSettings) => Promise<void>;
  events: ApplicationEvent[];
  onRefreshData: () => Promise<void>;
  lang?: UiLang;
}

const QUICK_COMMANDS = [
  { cmd: 'help', label: 'help' },
  { cmd: 'status', label: 'status / ps' },
  { cmd: 'jobs', label: 'jobs' },
  { cmd: 'test-drive', label: 'test-drive' },
  { cmd: 'test-gas', label: 'test-gas' },
  { cmd: 'test-sheets', label: 'test-sheets' },
  { cmd: 'ping-ocr', label: 'ping-ocr' },
  { cmd: 'reset-stuck', label: 'reset-stuck' },
  { cmd: 'scan', label: 'scan' },
];

export const DeveloperOptions: React.FC<DeveloperOptionsProps> = ({
  settings,
  onSaveSettings,
  events,
  onRefreshData,
  lang = 'en',
}) => {
  const [diagnostics, setDiagnostics] = useState<SystemDiagnostics | null>(null);
  const [snapshot, setSnapshot] = useState<DeveloperConsoleSnapshot | null>(null);
  const [isLoadingDiag, setIsLoadingDiag] = useState(false);

  // Interactive CLI state
  const [cliInput, setCliInput] = useState('');
  const [cliHistory, setCliHistory] = useState<string[]>([]);
  const [cliHistoryIndex, setCliHistoryIndex] = useState<number>(-1);
  const [cliTranscript, setCliTranscript] = useState<string[]>([
    "PO AutoFlow Enterprise Diagnostic Console. Type 'help' or click a quick command below.",
  ]);
  const [isRunningCmd, setIsRunningCmd] = useState(false);
  const terminalEndRef = useRef<HTMLDivElement | null>(null);

  const [logFilter, setLogFilter] = useState<'all' | 'info' | 'warn' | 'error'>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [statusMessage, setStatusMessage] = useState<{
    type: 'success' | 'error' | 'info';
    text: string;
  } | null>(null);
  const [testFilePath, setTestFilePath] = useState(() => {
    const rev = (settings.review_dir || `${settings.root_dir}\\Review`).replace(/[\\/]+$/, '');
    return `${rev}\\PO-26004156\\PO-26004156.pdf`;
  });
  const [ocrTestResult, setOcrTestResult] = useState<unknown>(null);
  const [isRunningOcrTest, setIsRunningOcrTest] = useState(false);
  const [copiedDiag, setCopiedDiag] = useState(false);
  const [copiedReport, setCopiedReport] = useState(false);

  const fetchSnapshot = useCallback(async () => {
    try {
      const snap = await api.getDeveloperConsoleSnapshot();
      setSnapshot(snap);
    } catch (err) {
      console.error('Failed to load developer console snapshot:', err);
    }
  }, []);

  const fetchDiagnostics = useCallback(async () => {
    setIsLoadingDiag(true);
    try {
      const [diag, snap] = await Promise.all([
        api.getSystemDiagnostics(),
        api.getDeveloperConsoleSnapshot(),
      ]);
      setDiagnostics(diag);
      setSnapshot(snap);
    } catch (err) {
      console.error('Failed to load system diagnostics:', err);
    } finally {
      setIsLoadingDiag(false);
    }
  }, []);

  useEffect(() => {
    fetchDiagnostics();
    const timer = setInterval(fetchSnapshot, 3000);
    return () => clearInterval(timer);
  }, [fetchDiagnostics, fetchSnapshot]);

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [cliTranscript, snapshot?.terminal_lines.length]);

  const showToast = (text: string, type: 'success' | 'error' | 'info' = 'success') => {
    setStatusMessage({ type, text });
    setTimeout(() => setStatusMessage(null), 4000);
  };

  const executeCliCommand = async (rawCmd: string) => {
    const cmd = rawCmd.trim();
    if (!cmd) return;
    setIsRunningCmd(true);
    setCliTranscript((prev) => [...prev, `po-autoflow> ${cmd}`]);
    setCliHistory((prev) => [cmd, ...prev.slice(0, 29)]);
    setCliHistoryIndex(-1);

    try {
      const result = await api.runDeveloperCommand(cmd);
      setCliTranscript((prev) => [...prev, ...(result ? result.split('\n') : ['(ok)'])]);
      await fetchSnapshot();
      await onRefreshData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setCliTranscript((prev) => [...prev, `ERROR: ${msg}`]);
    } finally {
      setIsRunningCmd(false);
    }
  };

  const handleCliSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cmd = cliInput.trim();
    if (!cmd || isRunningCmd) return;
    setCliInput('');
    executeCliCommand(cmd);
  };

  const handleCliKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (cliHistory.length === 0) return;
      const next = Math.min(cliHistory.length - 1, cliHistoryIndex + 1);
      setCliHistoryIndex(next);
      setCliInput(cliHistory[next]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (cliHistoryIndex <= 0) {
        setCliHistoryIndex(-1);
        setCliInput('');
      } else {
        const next = cliHistoryIndex - 1;
        setCliHistoryIndex(next);
        setCliInput(cliHistory[next]);
      }
    }
  };

  const handleCopyFullDebugReport = () => {
    const report = [
      '=== PO AutoFlow Enterprise Support Debug Report ===',
      `Timestamp: ${new Date().toISOString()}`,
      '',
      '--- PROCESS SNAPSHOT ---',
      JSON.stringify(snapshot, null, 2),
      '',
      '--- SYSTEM DIAGNOSTICS ---',
      JSON.stringify(diagnostics, null, 2),
      '',
      '--- INTERACTIVE TERMINAL TRANSCRIPT ---',
      ...cliTranscript,
    ].join('\n');
    navigator.clipboard.writeText(report);
    setCopiedReport(true);
    setTimeout(() => setCopiedReport(false), 2500);
    showToast(
      tx(
        lang,
        'Full debug report copied to clipboard! You can paste it directly to support.',
        'คัดลอกรายงานดีบักทั้งหมดไปยังคลิปบอร์ดแล้ว'
      ),
      'info'
    );
  };

  const handleToggleFlag = async (field: keyof AppSettings, value: boolean) => {
    const updated = { ...settings, [field]: value };
    await onSaveSettings(updated);
    showToast(
      tx(
        lang,
        `Setting '${field}' updated to ${value ? 'ENABLED' : 'DISABLED'}`,
        `อัปเดตค่า '${field}' เป็น ${value ? 'เปิดใช้งาน' : 'ปิดใช้งาน'} แล้ว`
      )
    );
    fetchDiagnostics();
  };

  const handleOpenDevTools = async () => {
    try {
      await api.openDevTools();
      showToast(
        tx(lang, 'WebView2 DevTools console opened (Press F12 to inspect)', 'เปิด WebView2 DevTools แล้ว (กด F12 เพื่อตรวจ)'),
        'info'
      );
    } catch (err: unknown) {
      showToast(`${tx(lang, 'Could not open DevTools:', 'ไม่สามารถเปิด DevTools ได้:')} ${err}`, 'error');
    }
  };

  const handleOpenExplorer = async (path: string) => {
    try {
      await api.openPathInExplorer(path);
      showToast(`${tx(lang, 'Opened directory in Explorer:', 'เปิดโฟลเดอร์ใน Explorer แล้ว:')} ${path}`, 'info');
    } catch (err: unknown) {
      showToast(`${tx(lang, 'Failed to open Explorer:', 'เปิด Explorer ไม่สำเร็จ:')} ${err}`, 'error');
    }
  };

  const handleTriggerScan = async () => {
    try {
      const count = await api.triggerFolderScan();
      showToast(
        tx(lang, `Folder scan initiated. Queued ${count} PO item(s).`, `เริ่มสแกนโฟลเดอร์แล้ว เพิ่มงานเข้าคิว ${count} รายการ`),
        'success'
      );
      await onRefreshData();
      fetchDiagnostics();
    } catch (err: unknown) {
      showToast(`${tx(lang, 'Trigger scan failed:', 'สั่งสแกนไม่สำเร็จ:')} ${err}`, 'error');
    }
  };

  const handleClearCaches = async () => {
    try {
      await api.clearAllCaches();
      showToast(
        tx(lang, 'Temporary processing and lock caches cleared successfully.', 'ล้างแคชชั่วคราวและล็อกไฟล์เรียบร้อยแล้ว'),
        'success'
      );
      fetchDiagnostics();
    } catch (err: unknown) {
      showToast(`${tx(lang, 'Failed to clear caches:', 'ล้างแคชไม่สำเร็จ:')} ${err}`, 'error');
    }
  };

  const handleRunOcrTest = async () => {
    if (!testFilePath.trim()) return;
    setIsRunningOcrTest(true);
    setOcrTestResult(null);
    try {
      const res = await api.testOcrOnFile(testFilePath.trim());
      setOcrTestResult(res);
      showToast(tx(lang, 'OCR test completed successfully.', 'ทดสอบอ่าน OCR เสร็จสมบูรณ์'), 'success');
      fetchSnapshot();
    } catch (err: unknown) {
      setOcrTestResult({ error: String(err) });
      showToast(`${tx(lang, 'OCR test failed:', 'ทดสอบ OCR ไม่สำเร็จ:')} ${err}`, 'error');
    } finally {
      setIsRunningOcrTest(false);
    }
  };

  const handleCopyDiagnostics = () => {
    if (!diagnostics) return;
    navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
    setCopiedDiag(true);
    setTimeout(() => setCopiedDiag(false), 2000);
    showToast(tx(lang, 'Diagnostics JSON copied to clipboard', 'คัดลอกข้อมูล Diagnostics JSON แล้ว'), 'info');
  };

  const filteredEvents = events.filter((ev) => {
    const matchesFilter =
      logFilter === 'all' ||
      (logFilter === 'info' && ev.level === 'info') ||
      (logFilter === 'warn' && ev.level === 'warn') ||
      (logFilter === 'error' && ev.level === 'error');

    const matchesSearch =
      !searchTerm ||
      ev.message.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (ev.job_id && ev.job_id.toLowerCase().includes(searchTerm.toLowerCase()));

    return matchesFilter && matchesSearch;
  });

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-bold text-white flex items-center gap-2">
            <Terminal className="w-5 h-5 text-amber-400" />
            {tx(lang, 'Developer Console, Process Monitor & CLI', 'คอนโซลนักพัฒนา ตัวติดตามโปรเซส และ CLI')}
          </h2>
          <p className="text-xs text-zinc-400">
            {tx(
              lang,
              'Live backend process monitor, interactive CLI diagnostics (test Drive, GAS, Sheets, reset stuck jobs), and captured worker output',
              'ตรวจสอบโปรเซสฝั่งแบ็กเอนด์ ทดสอบ Drive / Apps Script / Sheets แก้งานค้าง และดูบันทึกการทำงานแบบสด'
            )}
          </p>
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={handleCopyFullDebugReport}
            className="px-3 py-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 text-xs font-semibold border border-emerald-500/30 transition-all flex items-center space-x-1.5"
          >
            <Copy className="w-3.5 h-3.5" />
            <span>
              {copiedReport
                ? tx(lang, 'Copied Full Report!', 'คัดลอกรายงานแล้ว!')
                : tx(lang, 'Copy Full Debug Log', 'คัดลอกบันทึกดีบักทั้งหมด')}
            </span>
          </button>

          <button
            onClick={fetchDiagnostics}
            disabled={isLoadingDiag}
            className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium border border-zinc-700 transition-all flex items-center space-x-1.5"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoadingDiag ? 'animate-spin' : ''}`} />
            <span>{tx(lang, 'Refresh', 'รีเฟรช')}</span>
          </button>

          <button
            onClick={handleOpenDevTools}
            className="px-3 py-1.5 rounded-lg bg-gradient-to-r from-amber-600 to-amber-700 hover:from-amber-500 hover:to-amber-600 text-white text-xs font-semibold shadow-md shadow-amber-600/20 transition-all flex items-center space-x-1.5"
          >
            <Bug className="w-3.5 h-3.5" />
            <span>WebView DevTools</span>
          </button>
        </div>
      </div>

      {/* Notification Toast */}
      {statusMessage && (
        <div
          className={`p-3 rounded-lg text-xs font-semibold flex items-center space-x-2 border transition-all ${
            statusMessage.type === 'success'
              ? 'bg-emerald-500/20 border-emerald-500/30 text-emerald-300'
              : statusMessage.type === 'error'
              ? 'bg-red-500/20 border-red-500/30 text-red-300'
              : 'bg-blue-500/20 border-blue-500/30 text-blue-300'
          }`}
        >
          {statusMessage.type === 'success' && <CheckCircle2 className="w-4 h-4 shrink-0" />}
          {statusMessage.type === 'error' && <XCircle className="w-4 h-4 shrink-0" />}
          {statusMessage.type === 'info' && <Activity className="w-4 h-4 shrink-0" />}
          <span>{statusMessage.text}</span>
        </div>
      )}

      {/* Running Processes Live Monitor */}
      <div className="p-5 rounded-xl bg-[#121215] border border-zinc-800 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-bold text-zinc-300 uppercase tracking-wider flex items-center gap-2">
            <Cpu className="w-4 h-4 text-emerald-400" />
            {tx(lang, 'Active Processes & Background Workers', 'โปรเซสที่กำลังทำงานอยู่')}
          </h3>
          <span className="text-[11px] font-mono text-zinc-500">
            {snapshot
              ? `${tx(lang, 'Updated', 'อัปเดตเมื่อ')} ${new Date(snapshot.timestamp).toLocaleTimeString()}`
              : tx(lang, 'Polling...', 'กำลังดึงข้อมูล...')}
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
          <div className="p-3 rounded-lg bg-zinc-950/80 border border-zinc-800 space-y-1">
            <div className="flex items-center justify-between">
              <span className="font-mono font-bold text-white">po-autoflow.exe</span>
              <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 text-[10px] font-semibold">
                {tx(lang, 'RUNNING', 'กำลังทำงาน')}
              </span>
            </div>
            <p className="text-[11px] font-mono text-zinc-400">
              PID: {snapshot?.app_pid ?? '—'}
            </p>
            <p className="text-[11px] text-zinc-500">
              {tx(lang, 'Main Rust Host + Tray Service', 'โปรแกรมหลัก Rust + ถาดระบบ')}
            </p>
          </div>

          <div className="p-3 rounded-lg bg-zinc-950/80 border border-zinc-800 space-y-1">
            <div className="flex items-center justify-between">
              <span className="font-mono font-bold text-white">ocr-worker (OCR)</span>
              <span
                className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                  snapshot?.ocr_worker_pid
                    ? 'bg-emerald-500/15 text-emerald-400'
                    : 'bg-zinc-800 text-zinc-400'
                }`}
              >
                {snapshot?.ocr_worker_pid ? tx(lang, 'ALIVE', 'พร้อมทำงาน') : tx(lang, 'ON DEMAND', 'พร้อมเรียกใช้งาน')}
              </span>
            </div>
            <p className="text-[11px] font-mono text-zinc-400">
              PID: {snapshot?.ocr_worker_pid ?? tx(lang, 'Idle', 'ว่าง')} • {tx(lang, 'No Console Popup', 'ไม่เปิดหน้าต่างดำ')}
            </p>
            <p className="text-[11px] text-zinc-500 truncate" title={snapshot?.ocr_worker_script}>
              {snapshot?.ocr_worker_script || 'ocr-worker/worker.py'}
            </p>
          </div>

          <div className="p-3 rounded-lg bg-zinc-950/80 border border-zinc-800 space-y-1">
            <div className="flex items-center justify-between">
              <span className="font-mono font-bold text-white">FolderWatcher</span>
              <span
                className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                  snapshot?.watcher_active
                    ? 'bg-emerald-500/15 text-emerald-400'
                    : 'bg-amber-500/15 text-amber-400'
                }`}
              >
                {snapshot?.watcher_active ? tx(lang, 'WATCHING', 'กำลังเฝ้าดู') : tx(lang, 'PAUSED', 'หยุดชั่วคราว')}
              </span>
            </div>
            <p className="text-[11px] font-mono text-zinc-400">
              {tx(lang, 'Queued:', 'คิวรอ:')} {snapshot?.watcher_queued_count ?? 0} • {tx(lang, 'Locks:', 'ล็อกงาน:')} {snapshot?.in_flight_count ?? 0}
            </p>
            <p className="text-[11px] text-zinc-500 truncate" title={snapshot?.watcher_dir}>
              {snapshot?.watcher_dir || settings.incoming_dir}
            </p>
          </div>

          <div className="p-3 rounded-lg bg-zinc-950/80 border border-zinc-800 space-y-1">
            <div className="flex items-center justify-between">
              <span className="font-mono font-bold text-white">{tx(lang, 'Pipeline Jobs', 'คิวงานระบบ')}</span>
              <span className="px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400 text-[10px] font-semibold">
                SQLITE WAL
              </span>
            </div>
            <p className="text-[11px] font-mono text-zinc-300 truncate">
              {snapshot && Object.keys(snapshot.jobs_summary).length > 0
                ? Object.entries(snapshot.jobs_summary)
                    .map(([k, v]) => `${k}:${v}`)
                    .join(' | ')
                : tx(lang, 'No jobs in queue', 'ไม่มีงานในคิว')}
            </p>
            <p className="text-[11px] text-zinc-500">
              {tx(lang, 'Use "reset-stuck" if any job stalls', 'พิมพ์ "reset-stuck" หากมีงานค้าง')}
            </p>
          </div>
        </div>
      </div>

      {/* Interactive Command-Line Terminal */}
      <div className="p-5 rounded-xl bg-[#121215] border border-zinc-800 space-y-3 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-2">
            <Terminal className="w-4 h-4 text-emerald-400" />
            {tx(lang, 'Interactive Command-Line Terminal & Worker Output', 'เทอร์มินัลสั่งงานด่วนและผลลัพธ์จาก Worker')}
          </h3>

          <div className="flex flex-wrap gap-1.5">
            {QUICK_COMMANDS.map((q) => (
              <button
                key={q.cmd}
                type="button"
                disabled={isRunningCmd}
                onClick={() => executeCliCommand(q.cmd)}
                className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-[11px] font-mono text-emerald-300 disabled:opacity-50"
              >
                {q.label}
              </button>
            ))}
          </div>
        </div>

        {/* Captured Backend + Python Worker Logs */}
        <div className="rounded-lg bg-black/95 border border-zinc-800 p-3 font-mono text-[11px] leading-relaxed text-zinc-200 max-h-72 overflow-y-auto space-y-0.5">
          {snapshot?.terminal_lines && snapshot.terminal_lines.length > 0 && (
            <div className="pb-2 mb-2 border-b border-zinc-800 space-y-0.5">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
                --- Captured Process & Python Sidecar Stream ---
              </div>
              {snapshot.terminal_lines.slice(-60).map((line, i) => (
                <div
                  key={`sys-${i}`}
                  className={
                    line.includes('ERROR') || line.includes('stderr')
                      ? 'text-rose-400'
                      : line.includes('WARN')
                      ? 'text-amber-300'
                      : line.includes('[gmail OK]') || line.includes('Ready')
                      ? 'text-emerald-400'
                      : 'text-zinc-400'
                  }
                >
                  {line}
                </div>
              ))}
            </div>
          )}

          {cliTranscript.map((line, idx) => (
            <div
              key={`cli-${idx}`}
              className={
                line.startsWith('po-autoflow>')
                  ? 'text-cyan-400 font-semibold pt-1'
                  : line.startsWith('ERROR') || line.includes('FAILED')
                  ? 'text-rose-400 whitespace-pre-wrap'
                  : 'text-emerald-300 whitespace-pre-wrap'
              }
            >
              {line}
            </div>
          ))}
          <div ref={terminalEndRef} />
        </div>

        {/* Command Input Prompt */}
        <form onSubmit={handleCliSubmit} className="flex items-center gap-2">
          <div className="flex-1 flex items-center bg-black border border-zinc-700 rounded-lg px-3 py-2 focus-within:border-emerald-500">
            <span className="font-mono text-xs text-emerald-400 mr-2 select-none">
              po-autoflow&gt;
            </span>
            <input
              type="text"
              value={cliInput}
              onChange={(e) => setCliInput(e.target.value)}
              onKeyDown={handleCliKeyDown}
              placeholder={tx(
                lang,
                'Type command (e.g. test-drive, jobs, reset-stuck, status, help)...',
                'พิมพ์คำสั่ง (เช่น test-drive, jobs, reset-stuck, status, help)...'
              )}
              className="flex-1 bg-transparent text-xs font-mono text-white focus:outline-none placeholder-zinc-600"
            />
          </div>
          <button
            type="submit"
            disabled={isRunningCmd || !cliInput.trim()}
            className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-1.5"
          >
            <Send className="w-3.5 h-3.5" />
            <span>{isRunningCmd ? tx(lang, 'Running...', 'กำลังรัน...') : tx(lang, 'Run', 'รันคำสั่ง')}</span>
          </button>
        </form>
      </div>

      {/* Dry Run Simulation Banner */}
      {settings.dry_run_simulation_mode && (
        <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-start space-x-3">
          <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <h4 className="text-xs font-bold text-amber-300 uppercase tracking-wide">
              {tx(lang, 'Dry-Run / Simulation Mode Active', 'กำลังเปิดโหมดจำลองการทำงาน (Dry-Run)')}
            </h4>
            <p className="text-xs text-amber-200/80">
              {tx(
                lang,
                'The pipeline will perform complete OCR, supplier matching, and archive packaging, but will simulate Google Drive uploads and Gmail transmissions. No live emails will be dispatched to suppliers.',
                'ระบบจะสแกน OCR จับคู่ผู้ขาย และสร้างไฟล์ ZIP ตามปกติ แต่จะจำลองการอัปโหลด Drive และการส่ง Gmail โดยไม่มีการส่งอีเมลจริงออกไป'
              )}
            </p>
          </div>
        </div>
      )}

      {/* Developer Controls & Feature Flags Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-4 rounded-xl bg-[#121215] border border-zinc-800 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-zinc-300">{tx(lang, 'Developer Mode', 'โหมดนักพัฒนา')}</span>
            <input
              type="checkbox"
              checked={!!settings.developer_mode_enabled}
              onChange={(e) => handleToggleFlag('developer_mode_enabled', e.target.checked)}
              className="h-4 w-4 rounded border-zinc-700 bg-zinc-800 text-blue-600 focus:ring-0 cursor-pointer"
            />
          </div>
          <p className="text-[11px] text-zinc-400 leading-relaxed">
            {tx(
              lang,
              'Enables advanced diagnostics tools, sidecar inspection, and direct folder controls.',
              'เปิดใช้งานเครื่องมือวินิจฉัยขั้นสูง การตรวจสอบ Worker และคำสั่งควบคุมโฟลเดอร์โดยตรง'
            )}
          </p>
        </div>

        <div className="p-4 rounded-xl bg-[#121215] border border-zinc-800 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-zinc-300">{tx(lang, 'Verbose Debug Logging', 'บันทึก Log แบบละเอียด')}</span>
            <input
              type="checkbox"
              checked={!!settings.debug_logging_enabled}
              onChange={(e) => handleToggleFlag('debug_logging_enabled', e.target.checked)}
              className="h-4 w-4 rounded border-zinc-700 bg-zinc-800 text-blue-600 focus:ring-0 cursor-pointer"
            />
          </div>
          <p className="text-[11px] text-zinc-400 leading-relaxed">
            {tx(
              lang,
              'Emits detailed trace telemetry during OCR parsing, Drive upload, and email delivery.',
              'บันทึกรายละเอียดการทำงานทุกขั้นตอนทั้งระหว่างสแกน OCR อัปโหลด Drive และส่งอีเมล'
            )}
          </p>
        </div>

        <div className="p-4 rounded-xl bg-[#121215] border border-zinc-800 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-zinc-300">{tx(lang, 'Dry-Run Simulation Mode', 'โหมดจำลอง (Dry-Run)')}</span>
            <input
              type="checkbox"
              checked={!!settings.dry_run_simulation_mode}
              onChange={(e) => handleToggleFlag('dry_run_simulation_mode', e.target.checked)}
              className="h-4 w-4 rounded border-zinc-700 bg-zinc-800 text-amber-500 focus:ring-0 cursor-pointer"
            />
          </div>
          <p className="text-[11px] text-zinc-400 leading-relaxed">
            {tx(
              lang,
              'Test documents end-to-end safely without sending real emails or uploading to Drive.',
              'ทดสอบประมวลผลเอกสารครบขั้นตอนโดยไม่ส่งอีเมลหรืออัปโหลดจริง'
            )}
          </p>
        </div>

        <div className="p-4 rounded-xl bg-[#121215] border border-zinc-800 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-zinc-300">{tx(lang, 'Save OCR Debug Images', 'บันทึกรูปภาพปรับแต่ง OCR')}</span>
            <input
              type="checkbox"
              checked={!!settings.save_debug_ocr_images}
              onChange={(e) => handleToggleFlag('save_debug_ocr_images', e.target.checked)}
              className="h-4 w-4 rounded border-zinc-700 bg-zinc-800 text-blue-600 focus:ring-0 cursor-pointer"
            />
          </div>
          <p className="text-[11px] text-zinc-400 leading-relaxed">
            {tx(lang, 'Saves deskewed page previews into', 'บันทึกภาพหน้าที่ปรับแก้อียงแล้วไว้ใน')}{' '}
            <code className="text-blue-300 font-mono">Temp\debug_ocr</code>.
          </p>
        </div>
      </div>

      {/* System Diagnostics Metrics Cards */}
      <div className="p-5 rounded-xl bg-[#121215] border border-zinc-800 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-bold text-zinc-300 uppercase tracking-wider flex items-center gap-2">
            <Cpu className="w-4 h-4 text-blue-400" />
            {tx(lang, 'Runtime Environment & Sidecar Diagnostics', 'สภาพแวดล้อมการทำงานและตัวอ่าน OCR')}
          </h3>
          <button
            onClick={handleCopyDiagnostics}
            className="text-[11px] text-zinc-400 hover:text-white flex items-center gap-1 transition-colors"
          >
            <Copy className="w-3.5 h-3.5" />
            <span>
              {copiedDiag
                ? tx(lang, 'Copied JSON!', 'คัดลอก JSON แล้ว!')
                : tx(lang, 'Copy Diagnostics JSON', 'คัดลอกข้อมูลระบบ JSON')}
            </span>
          </button>
        </div>

        {diagnostics ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
            <div className="p-3 rounded-lg bg-zinc-950/70 border border-zinc-800 space-y-1">
              <span className="text-[10px] text-zinc-500 uppercase font-semibold">
                {tx(lang, 'OS & Architecture', 'ระบบปฏิบัติการและสถาปัตยกรรม')}
              </span>
              <p className="text-white font-mono font-medium">
                {diagnostics.os_name} ({diagnostics.os_arch})
              </p>
              <p className="text-[11px] text-zinc-400 truncate" title={diagnostics.webview2_executable}>
                WebView2: {diagnostics.webview2_executable.split('\\').pop() || 'Auto'}
              </p>
            </div>

            <div className="p-3 rounded-lg bg-zinc-950/70 border border-zinc-800 space-y-1">
              <span className="text-[10px] text-zinc-500 uppercase font-semibold">
                {tx(lang, 'SQLite WAL Database', 'ฐานข้อมูล SQLite WAL')}
              </span>
              <div className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-emerald-500"></span>
                <span className="text-white font-mono font-medium">
                  {tx(lang, 'Mode:', 'โหมด:')} {diagnostics.database_journal_mode}
                </span>
              </div>
              <p className="text-[11px] text-zinc-400 font-mono">
                {tx(lang, 'Size:', 'ขนาด:')} {(diagnostics.database_size_bytes / 1024).toFixed(1)} KB ({diagnostics.total_jobs_recorded}{' '}
                {tx(lang, 'jobs', 'งาน')})
              </p>
            </div>

            <div className="p-3 rounded-lg bg-zinc-950/70 border border-zinc-800 space-y-1">
              <span className="text-[10px] text-zinc-500 uppercase font-semibold">
                {tx(lang, 'Bundled OCR Worker', 'ตัวประมวลผล OCR ในตัว')}
              </span>
              <div className="flex items-center gap-1.5">
                <span
                  className={`h-2 w-2 rounded-full ${
                    diagnostics.ocr_worker_status === 'READY' ? 'bg-emerald-500' : 'bg-red-500'
                  }`}
                ></span>
                <span className="text-white font-mono font-semibold">{diagnostics.ocr_worker_status}</span>
                <span className="text-[11px] text-zinc-400 font-mono">({diagnostics.ocr_latency_ms}ms)</span>
              </div>
              <p className="text-[11px] text-zinc-400 font-mono truncate" title={diagnostics.ocr_worker_path}>
                OpenThai 2.0 / PyMuPDF
              </p>
            </div>

            <div className="p-3 rounded-lg bg-zinc-950/70 border border-zinc-800 space-y-1">
              <span className="text-[10px] text-zinc-500 uppercase font-semibold">
                {tx(lang, 'Queue & Concurrency', 'คิวงานและการทำงานพร้อมกัน')}
              </span>
              <p className="text-white font-mono font-medium">
                {tx(lang, 'Active:', 'กำลังทำ:')} {diagnostics.active_jobs_count} | {tx(lang, 'Locks:', 'ล็อก:')} {diagnostics.in_flight_locks_count}
              </p>
              <p className="text-[11px] text-zinc-400">
                {tx(lang, 'Monitoring:', 'เฝ้าโฟลเดอร์:')}{' '}
                {diagnostics.auto_monitoring_active ? tx(lang, 'Active', 'เปิด') : tx(lang, 'Paused', 'หยุดชั่วคราว')}
              </p>
            </div>
          </div>
        ) : (
          <div className="p-6 text-center text-xs text-zinc-500">
            {tx(lang, 'Loading diagnostics...', 'กำลังโหลดข้อมูลวินิจฉัยระบบ...')}
          </div>
        )}
      </div>

      {/* Explorer Launchers & Quick Actions */}
      <div className="p-5 rounded-xl bg-[#121215] border border-zinc-800 space-y-4">
        <h3 className="text-xs font-bold text-zinc-300 uppercase tracking-wider flex items-center gap-2">
          <FolderOpen className="w-4 h-4 text-emerald-400" />
          {tx(lang, 'Windows Explorer Directory Launchers', 'ทางลัดเปิดโฟลเดอร์ระบบใน Windows Explorer')}
        </h3>

        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => handleOpenExplorer(settings.incoming_dir)}
            className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium border border-zinc-700 flex items-center space-x-1.5 transition-colors"
          >
            <FolderOpen className="w-3.5 h-3.5 text-blue-400" />
            <span>{tx(lang, 'Incoming Folder', 'โฟลเดอร์ Incoming')}</span>
          </button>

          <button
            onClick={() => handleOpenExplorer(settings.processing_dir)}
            className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium border border-zinc-700 flex items-center space-x-1.5 transition-colors"
          >
            <FolderOpen className="w-3.5 h-3.5 text-amber-400" />
            <span>{tx(lang, 'Processing Folder', 'โฟลเดอร์ Processing')}</span>
          </button>

          <button
            onClick={() => handleOpenExplorer(settings.sent_dir)}
            className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium border border-zinc-700 flex items-center space-x-1.5 transition-colors"
          >
            <FolderOpen className="w-3.5 h-3.5 text-emerald-400" />
            <span>{tx(lang, 'Sent Folder', 'โฟลเดอร์ Sent')}</span>
          </button>

          <button
            onClick={() => handleOpenExplorer(settings.failed_dir)}
            className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium border border-zinc-700 flex items-center space-x-1.5 transition-colors"
          >
            <FolderOpen className="w-3.5 h-3.5 text-red-400" />
            <span>{tx(lang, 'Failed Folder', 'โฟลเดอร์ Failed')}</span>
          </button>

          <button
            onClick={() => handleOpenExplorer(settings.review_dir)}
            className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium border border-zinc-700 flex items-center space-x-1.5 transition-colors"
          >
            <FolderOpen className="w-3.5 h-3.5 text-purple-400" />
            <span>{tx(lang, 'Review Folder', 'โฟลเดอร์ Review')}</span>
          </button>

          <button
            onClick={() => handleOpenExplorer(settings.temp_dir)}
            className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium border border-zinc-700 flex items-center space-x-1.5 transition-colors"
          >
            <FolderOpen className="w-3.5 h-3.5 text-zinc-400" />
            <span>{tx(lang, 'Temp Archive Folder', 'โฟลเดอร์ Temp Archive')}</span>
          </button>

          <button
            onClick={handleTriggerScan}
            className="px-3 py-1.5 rounded-lg bg-blue-600/30 hover:bg-blue-600/50 text-blue-300 text-xs font-semibold border border-blue-500/40 flex items-center space-x-1.5 transition-colors ml-auto"
          >
            <Play className="w-3.5 h-3.5" />
            <span>{tx(lang, 'Trigger Incoming Scan Now', 'สแกนโฟลเดอร์ Incoming ทันที')}</span>
          </button>

          <button
            onClick={handleClearCaches}
            className="px-3 py-1.5 rounded-lg bg-red-600/20 hover:bg-red-600/30 text-red-300 text-xs font-medium border border-red-500/30 flex items-center space-x-1.5 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>{tx(lang, 'Clear Temp Caches', 'ล้างแคชชั่วคราว')}</span>
          </button>
        </div>
      </div>

      {/* Manual OCR Testing Sandbox */}
      <div className="p-5 rounded-xl bg-[#121215] border border-zinc-800 space-y-4">
        <h3 className="text-xs font-bold text-zinc-300 uppercase tracking-wider flex items-center gap-2">
          <FileSearch className="w-4 h-4 text-purple-400" />
          {tx(lang, 'OCR Direct Test Sandbox', 'ช่องทดสอบสแกนเอกสาร OCR โดยตรง')}
        </h3>

        <div className="flex items-center space-x-2">
          <input
            type="text"
            value={testFilePath}
            onChange={(e) => setTestFilePath(e.target.value)}
            placeholder="C:\Path\To\Invoice.pdf"
            className="flex-1 px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-white font-mono focus:outline-none focus:border-blue-500"
          />
          <button
            onClick={handleRunOcrTest}
            disabled={isRunningOcrTest}
            className="px-4 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold shadow-md shadow-purple-600/20 transition-all flex items-center space-x-1.5"
          >
            <Play className={`w-3.5 h-3.5 ${isRunningOcrTest ? 'animate-spin' : ''}`} />
            <span>
              {isRunningOcrTest
                ? tx(lang, 'Processing OCR...', 'กำลังอ่านเอกสาร...')
                : tx(lang, 'Run Direct Test', 'ทดสอบอ่านเอกสาร')}
            </span>
          </button>
        </div>

        {ocrTestResult !== null && (
          <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800 overflow-x-auto max-h-60 text-[11px] font-mono text-zinc-300">
            <pre>{JSON.stringify(ocrTestResult, null, 2)}</pre>
          </div>
        )}
      </div>

      {/* Live Event & Telemetry Console */}
      <div className="p-5 rounded-xl bg-[#121215] border border-zinc-800 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-xs font-bold text-zinc-300 uppercase tracking-wider flex items-center gap-2">
            <Activity className="w-4 h-4 text-blue-400" />
            {tx(lang, 'Database Event Log', 'บันทึกเหตุการณ์จากฐานข้อมูล')} ({filteredEvents.length} {tx(lang, 'events', 'รายการ')})
          </h3>

          <div className="flex items-center space-x-2">
            <input
              type="text"
              placeholder={tx(lang, 'Search events...', 'ค้นหาเหตุการณ์...')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="px-2.5 py-1 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-white focus:outline-none focus:border-blue-500 w-44"
            />

            <div className="flex rounded-lg bg-zinc-950 p-0.5 border border-zinc-800">
              {(['all', 'info', 'warn', 'error'] as const).map((lvl) => (
                <button
                  key={lvl}
                  onClick={() => setLogFilter(lvl)}
                  className={`px-2.5 py-1 rounded text-[11px] font-medium uppercase transition-colors ${
                    logFilter === lvl
                      ? 'bg-blue-600 text-white font-semibold'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  {lvl === 'all' ? tx(lang, 'all', 'ทั้งหมด') : lvl}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="rounded-lg bg-zinc-950 border border-zinc-800 overflow-hidden font-mono text-xs max-h-80 overflow-y-auto">
          {filteredEvents.length === 0 ? (
            <div className="p-8 text-center text-zinc-500">
              {tx(lang, 'No events found matching the filter criteria.', 'ไม่พบบันทึกเหตุการณ์ที่ตรงกับเงื่อนไข')}
            </div>
          ) : (
            <div className="divide-y divide-zinc-800/70">
              {filteredEvents.map((ev) => {
                const isErr = ev.level === 'error';
                const isWarn = ev.level === 'warn';
                return (
                  <div
                    key={ev.id}
                    className="p-2.5 flex items-start space-x-3 hover:bg-[#121215]/90 transition-colors"
                  >
                    <span
                      className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded shrink-0 ${
                        isErr
                          ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                          : isWarn
                          ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                          : 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                      }`}
                    >
                      {ev.level}
                    </span>

                    <span className="text-zinc-500 text-[11px] shrink-0">
                      {new Date(ev.timestamp).toLocaleTimeString()}
                    </span>

                    <span className="text-zinc-200 flex-1 break-words">{ev.message}</span>

                    {ev.job_id && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 shrink-0">
                        {ev.job_id.substring(0, 8)}...
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
