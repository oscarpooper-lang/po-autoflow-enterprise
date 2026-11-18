import React, { useEffect, useRef, useState } from 'react';
import {
  Sparkles,
  Send,
  FileSearch,
  Building2,
  Users,
  Copy,
  Check,
  Loader2,
  Eye,
  Cpu,
  Zap,
  PowerOff,
  RotateCcw,
  Settings as SettingsIcon,
  AlertTriangle,
  ExternalLink,
  Image as ImageIcon,
} from 'lucide-react';
import type {
  CompanyCacheEntry,
  DepartmentCcEntry,
  Job,
} from '../types';
import {
  clearAiChatHistory,
  refreshAiChatStatus,
  sendAiChatPrompt,
  stopAiChatServerFromStore,
  useAiChatState,
} from '../utils/aiChatStore';
import { usePersistedState } from '../utils/persistedState';
import { StatusBadge } from './Overview';
import { tx, type UiLang } from '../i18n';

interface AiAssistantProps {
  jobs: Job[];
  companies: CompanyCacheEntry[];
  departments: DepartmentCcEntry[];
  transientAttachedImage?: { jobId: string; dataUrl: string } | null;
  onInspectJob: (jobId: string) => void;
  onNavigateTab: (tab: string) => void;
  lang?: UiLang;
}

export const AiAssistant: React.FC<AiAssistantProps> = ({
  jobs,
  companies,
  departments,
  transientAttachedImage = null,
  onInspectJob,
  onNavigateTab,
  lang = 'en',
}) => {
  const { turns, isSending, sendingStartedAt, sendingWithVision, status } = useAiChatState();
  const [focusJobId, setFocusJobId] = usePersistedState<string>('assistant.focusJobId', '');
  const [includePageImage, setIncludePageImage] = usePersistedState<boolean>(
    'assistant.includePageImage',
    false
  );
  const [manualImageCleared, setManualImageCleared] = useState<boolean>(false);
  const [attachedPage, setAttachedPage] = usePersistedState<number>('assistant.attachedPage', 1);
  const [inputText, setInputText] = usePersistedState<string>('assistant.inputText', '');
  const [isStoppingServer, setIsStoppingServer] = useState<boolean>(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState<number>(0);
  const scrollEndRef = useRef<HTMLDivElement | null>(null);

  const attachedImageUrl =
    !manualImageCleared && transientAttachedImage && transientAttachedImage.jobId === focusJobId
      ? transientAttachedImage.dataUrl
      : null;

  useEffect(() => {
    refreshAiChatStatus(true);
  }, []);

  useEffect(() => {
    if (!isSending || !sendingStartedAt) return;
    const timer = setInterval(() => {
      setElapsedSec(Math.max(1, Math.floor((Date.now() - sendingStartedAt) / 1000)));
    }, 1000);
    return () => {
      clearInterval(timer);
      setElapsedSec(0);
    };
  }, [isSending, sendingStartedAt]);

  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns, isSending]);

  const focusedJob = jobs.find((j) => j.id === focusJobId) || null;

  const handleSelectFocusJob = (nextJobId: string) => {
    setFocusJobId(nextJobId);
    // Clear cached image whenever switching PO or page so backend never sends another PO's screenshot
    setManualImageCleared(true);
    setAttachedPage(1);
    if (!nextJobId) {
      setIncludePageImage(false);
    }
  };

  const handleCopyText = async (key: string, text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1800);
    } catch {
      // Clipboard blocked in non-secure context
    }
  };

  const handleStopWarmServer = async () => {
    setIsStoppingServer(true);
    try {
      await stopAiChatServerFromStore();
    } finally {
      setIsStoppingServer(false);
    }
  };

  const submitPrompt = async (rawPrompt: string, forceAttachVision?: boolean) => {
    const prompt = rawPrompt.trim();
    if (!prompt || isSending) return;

    const useVision =
      forceAttachVision !== undefined ? forceAttachVision : includePageImage && Boolean(focusJobId);
    if (forceAttachVision && focusJobId && !includePageImage) {
      setIncludePageImage(true);
    }

    setInputText('');
    await sendAiChatPrompt({
      prompt,
      focusJobId: focusJobId || null,
      includePageImage: useVision,
      attachedImageUrl,
      attachedPage,
    });
  };

  const quickTasks = focusedJob
    ? [
        {
          label: tx(lang, 'Why is this PO in its status?', 'ทำไม PO นี้อยู่สถานะนี้?'),
          prompt:
            lang === 'th'
              ? `ช่วยสรุปสถานะของใบ PO นี้ (${focusedJob.po_number || focusedJob.po_folder_name}) ว่าทำไมถึงยังไม่ส่ง หรือจับคู่ได้อย่างไร`
              : `Explain the current status of ${focusedJob.po_number || focusedJob.po_folder_name}, why it paused/completed, supplier match details, and any Department CC.`,
          vision: false,
        },
        {
          label: tx(lang, 'Read items & total from PDF image', 'ให้ AI อ่านยอดเงินและรายการจากภาพ PDF'),
          prompt:
            lang === 'th'
              ? 'ช่วยดูภาพหน้า PDF นี้แล้วสรุปเลขที่ PO ชื่อผู้ขาย รายการหลัก ยอดเงินรวม และวันส่งมอบให้หน่อย'
              : 'Inspect this PDF page image and extract the PO number, supplier name, key line items, grand total, and delivery date.',
          vision: true,
        },
        {
          label: tx(lang, 'Verify supplier email & Dept CC', 'ตรวจสอบอีเมลผู้ขายและ CC แผนก'),
          prompt:
            lang === 'th'
              ? 'ตรวจสอบชื่อบริษัท อีเมลผู้รับ และอีเมล CC แผนกสำหรับใบ PO นี้ให้ถูกต้องตามฐานข้อมูล'
              : 'Verify the canonical supplier name, recipient email(s), and auto-matched Department CC emails for this PO.',
          vision: false,
        },
      ]
    : [
        {
          label: tx(lang, 'Find POs needing review', 'หา PO ที่รอตรวจสอบ'),
          prompt:
            lang === 'th'
              ? 'ช่วยแสดงรายการใบ PO ที่รอตรวจสอบ (needs_review) พร้อมบอกสาเหตุ'
              : 'Find all POs currently needing review and summarize why each one needs attention.',
          vision: false,
        },
        {
          label: tx(lang, 'Any failed POs & why?', 'มี PO ที่ส่งไม่ผ่านไหม?'),
          prompt:
            lang === 'th'
              ? 'มีใบ PO ที่ล้มเหลว (failed) ไหม และเกิดจากสาเหตุอะไร'
              : 'List any failed POs and explain their errors.',
          vision: false,
        },
        {
          label: tx(lang, 'Summary of today & stats', 'สรุปภาพรวมและสถิติทั้งหมด'),
          prompt:
            lang === 'th'
              ? 'สรุปภาพรวมใบสั่งซื้อทั้งหมดในระบบ จำนวนที่ส่งแล้ว และรายการล่าสุด'
              : 'Give a concise summary of overall PO stats and the most recent POs.',
          vision: false,
        },
        {
          label: tx(lang, 'Lookup Dept CC (e.g. ฝ่ายขายในประเทศ)', 'ค้นหาอีเมล CC แผนก'),
          prompt:
            lang === 'th'
              ? 'ช่วยหาอีเมล CC ของ ฝ่ายขายในประเทศ และ แผนก MIS'
              : 'What Department CC emails are configured for ฝ่ายขายในประเทศ and แผนก MIS?',
          vision: false,
        },
      ];

  return (
    <div className="flex flex-col h-[calc(100vh-7.5rem)] max-w-6xl mx-auto space-y-3">
      {/* Top Status & Context Controls */}
      <div className="p-4 rounded-xl bg-[#121215] border border-zinc-800 space-y-3 shrink-0">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-lg bg-purple-600/20 border border-purple-500/30 flex items-center justify-center shrink-0">
              <Sparkles className="w-4 h-4 text-purple-300" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-zinc-100">
                  {tx(lang, 'Local Procurement AI Assistant', 'ผู้ช่วย AI ออฟไลน์ในระบบ')}
                </h3>
                {status?.ready ? (
                  <span
                    className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border flex items-center gap-1 ${
                      status.server_running
                        ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                        : 'bg-blue-500/15 text-blue-300 border-blue-500/30'
                    }`}
                  >
                    {status.has_vulkan ? <Zap className="w-3 h-3" /> : <Cpu className="w-3 h-3" />}
                    <span>{status.active_model_name}</span>
                    {status.server_running && (
                      <span>• {tx(lang, 'Warm', 'พร้อมตอบไว')}</span>
                    )}
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/30">
                    {tx(lang, 'Live DB Search Mode (No VLM Installed)', 'โหมดค้นหาฐานข้อมูล (ยังไม่ได้ติดตั้งโมเดล AI)')}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-zinc-400 truncate mt-0.5">
                {status?.message ||
                  tx(
                    lang,
                    `Grounded across ${jobs.length} POs, ${companies.length} suppliers & ${departments.length} Dept CCs.`,
                    `เชื่อมต่อข้อมูลจริง: ${jobs.length} PO, ${companies.length} ผู้ขาย, ${departments.length} แผนก CC`
                  )}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {status?.server_running && (
              <button
                type="button"
                onClick={handleStopWarmServer}
                disabled={isStoppingServer}
                className="px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-300 text-xs flex items-center gap-1.5"
                title={tx(lang, 'Unload local AI model from GPU/RAM', 'หยุดโมเดล AI ชั่วคราวเพื่อคืนหน่วยความจำ GPU/RAM')}
              >
                <PowerOff className="w-3.5 h-3.5 text-amber-400" />
                <span>{tx(lang, 'Unload VRAM', 'ปิดเซิร์ฟเวอร์ AI')}</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => onNavigateTab('settings')}
              className="px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs flex items-center gap-1.5"
            >
              <SettingsIcon className="w-3.5 h-3.5 text-zinc-400" />
              <span>{tx(lang, status?.ready ? 'Models' : 'Download Model', status?.ready ? 'เลือกโมเดล' : 'โหลดโมเดล AI')}</span>
            </button>
            {turns.length > 0 && (
              <button
                type="button"
                onClick={clearAiChatHistory}
                disabled={isSending}
                className="px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-300 text-xs flex items-center gap-1 disabled:opacity-50"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>{tx(lang, 'New Chat', 'เริ่มใหม่')}</span>
              </button>
            )}
          </div>
        </div>

        {/* Focused PO + Multimodal PDF Image Attach Bar */}
        <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-zinc-800/80 text-xs">
          <div className="flex items-center gap-2 flex-1 min-w-[240px]">
            <span className="text-zinc-400 shrink-0 font-medium">
              {tx(lang, 'Focus PO:', 'เจาะจง PO:')}
            </span>
            <select
              value={focusJobId}
              onChange={(e) => handleSelectFocusJob(e.target.value)}
              className="flex-1 min-w-0 bg-zinc-900 border border-zinc-700 rounded-lg px-2.5 py-1.5 text-zinc-200 text-xs focus:outline-none focus:border-purple-500"
            >
              <option value="">
                {tx(lang, 'All POs, Suppliers & Department CCs', 'ค้นหาทั้งหมดในฐานข้อมูล (PO + ผู้ขาย + แผนก)')}
              </option>
              {jobs.slice(0, 80).map((j) => (
                <option key={j.id} value={j.id}>
                  {j.po_number ? `PO ${j.po_number}` : j.po_folder_name} • {j.status}
                  {j.matched_company_name ? ` — ${j.matched_company_name}` : ''}
                </option>
              ))}
            </select>
          </div>

          {focusedJob && (
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-700 text-zinc-200 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={includePageImage}
                  onChange={(e) => setIncludePageImage(e.target.checked)}
                  className="rounded border-zinc-600 bg-zinc-800 text-purple-500 cursor-pointer"
                />
                <Eye className="w-3.5 h-3.5 text-purple-400" />
                <span>{tx(lang, 'Attach PDF Page Image', 'แนบภาพ PDF ให้ AI ดู')}</span>
              </label>

              {includePageImage && (
                <div className="flex items-center gap-1 px-2 py-1 rounded-lg bg-zinc-900 border border-zinc-700 text-[11px] text-zinc-300">
                  <span>{tx(lang, 'Page:', 'หน้า:')}</span>
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={attachedPage}
                    onChange={(e) => {
                      const val = Math.max(1, parseInt(e.target.value || '1', 10) || 1);
                      setAttachedPage(val);
                      setManualImageCleared(true);
                    }}
                    className="w-11 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-center font-mono text-zinc-100"
                  />
                  {attachedImageUrl && (
                    <span className="ml-1 inline-flex items-center gap-1 text-emerald-400 font-medium">
                      <ImageIcon className="w-3 h-3" />
                      {tx(lang, 'Cached', 'พร้อมส่ง')}
                    </span>
                  )}
                </div>
              )}

              <button
                type="button"
                onClick={() => onInspectJob(focusedJob.id)}
                className="px-2.5 py-1.5 rounded-lg bg-blue-600/20 hover:bg-blue-600/30 border border-blue-500/30 text-blue-300 text-xs flex items-center gap-1"
              >
                <FileSearch className="w-3.5 h-3.5" />
                <span>{tx(lang, 'Open Viewer', 'ดูใน Document Viewer')}</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Chat Conversation Feed */}
      <div className="flex-1 overflow-y-auto rounded-xl bg-[#121215] border border-zinc-800 p-4 space-y-4">
        {turns.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center max-w-xl mx-auto space-y-4 py-8">
            <div className="w-12 h-12 rounded-2xl bg-purple-600/15 border border-purple-500/30 flex items-center justify-center">
              <Sparkles className="w-6 h-6 text-purple-300" />
            </div>
            <div className="space-y-1.5">
              <h4 className="text-base font-semibold text-zinc-100">
                {focusedJob
                  ? tx(
                      lang,
                      `Ask about ${focusedJob.po_number || focusedJob.po_folder_name}`,
                      `ถามเกี่ยวกับ ${focusedJob.po_number || focusedJob.po_folder_name}`
                    )
                  : tx(lang, 'Ask anything about your POs, suppliers, or PDFs', 'ถามได้ทุกเรื่องเกี่ยวกับ PO ผู้ขาย อีเมล หรือให้ AI อ่านหน้า PDF')}
              </h4>
              <p className="text-xs text-zinc-400">
                {tx(
                  lang,
                  'Every answer searches live SQLite jobs, vendor aliases, Department CC rules, and OCR text before answering with your local Qwen3-VL / LFM3-VL / Gemma 4 model — 100% offline.',
                  'คำตอบทุกข้อค้นหาจากฐานข้อมูล SQLite รายชื่อผู้ขาย แผนก CC และข้อความ OCR จริงก่อนส่งให้โมเดลออฟไลน์ (Qwen3-VL / LFM3-VL / Gemma 4) จึงไม่มั่วอีเมลหรือเลข PO'
                )}
              </p>
            </div>

            {!status?.ready && (
              <div className="w-full p-3 rounded-xl bg-amber-500/10 border border-amber-500/25 text-left text-xs text-amber-200 flex items-start gap-2.5">
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <div className="font-semibold">
                    {tx(lang, 'No local chat model installed yet — Live DB search still works!', 'ยังไม่ได้ดาวน์โหลดโมเดล AI — แต่ค้นหาฐานข้อมูลจริงได้ทันที!')}
                  </div>
                  <p className="text-[11px] text-amber-200/80">
                    {tx(
                      lang,
                      'Recommended for 8 GB GPUs (e.g. RX 580): Qwen3-VL-4B (2.75 GB), Qwen3-VL-2B (1.45 GB), or LFM3-VL-2B (1.21 GB) in Settings -> OCR & AI Engine.',
                      'แนะนำสำหรับระบบนี้: Qwen3-VL-4B (2.75 GB), Qwen3-VL-2B (1.45 GB) หรือ LFM3-VL-2B (1.21 GB) ดาวน์โหลดได้ใน Settings -> OCR & AI Engine (ใช้ได้ทั้งอ่านบิลและแชท)'
                    )}
                  </p>
                </div>
              </div>
            )}

            <div className="flex flex-wrap justify-center gap-2 pt-1">
              {quickTasks.map((qt, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => submitPrompt(qt.prompt, qt.vision)}
                  className="px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-700/80 text-xs text-zinc-200 flex items-center gap-1.5 transition-colors"
                >
                  {qt.vision ? <Eye className="w-3.5 h-3.5 text-purple-400" /> : <Sparkles className="w-3.5 h-3.5 text-blue-400" />}
                  <span>{qt.label}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          turns.map((turn) => (
            <div
              key={turn.id}
              className={`flex flex-col ${turn.role === 'user' ? 'items-end' : 'items-start'} space-y-2`}
            >
              <div
                className={`max-w-[88%] rounded-xl px-4 py-3 text-xs leading-relaxed ${
                  turn.role === 'user'
                    ? 'bg-blue-600 text-white'
                    : turn.error
                    ? 'bg-rose-500/10 border border-rose-500/30 text-rose-200'
                    : 'bg-zinc-900/90 border border-zinc-800 text-zinc-100'
                }`}
              >
                {turn.role === 'user' ? (
                  <div className="space-y-1">
                    {turn.hadVisionImage && (
                      <div className="inline-flex items-center gap-1 text-[10px] bg-blue-700/80 px-2 py-0.5 rounded-full mb-1">
                        <Eye className="w-3 h-3" />
                        <span>{tx(lang, 'With PDF Page Image', 'แนบภาพหน้า PDF')}</span>
                      </div>
                    )}
                    <div className="whitespace-pre-wrap">{turn.text}</div>
                  </div>
                ) : turn.error ? (
                  <div className="space-y-1">
                    <div className="font-semibold flex items-center gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
                      <span>{tx(lang, 'Request Failed', 'เกิดข้อผิดพลาด')}</span>
                    </div>
                    <div className="whitespace-pre-wrap">{turn.error}</div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2 text-[10px] text-zinc-400 border-b border-zinc-800 pb-1.5">
                      <span className="font-semibold text-purple-300">{turn.response?.model_used}</span>
                      <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 font-mono">
                        {turn.response?.engine_mode}
                      </span>
                      {turn.response?.used_vision_image && (
                        <span className="px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-300 border border-purple-500/30">
                          {tx(lang, 'Vision Image Read', 'อ่านจากภาพ PDF')}
                        </span>
                      )}
                      <span>{((turn.response?.duration_ms || 0) / 1000).toFixed(1)}s</span>
                      <span className="ml-auto">{turn.timestamp}</span>
                    </div>
                    <div className="whitespace-pre-wrap text-[13px] text-zinc-100">{turn.text}</div>
                    {turn.response?.note && (
                      <div className="text-[11px] text-amber-300/90 pt-1 border-t border-zinc-800/80">
                        {turn.response.note}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Grounded Action Cards under Assistant Replies */}
              {turn.response &&
                (turn.response.matched_jobs.length > 0 ||
                  turn.response.matched_companies.length > 0 ||
                  turn.response.matched_departments.length > 0) && (
                  <div className="w-full max-w-[92%] space-y-2 pl-1">
                    {turn.response.matched_jobs.length > 0 && (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        {turn.response.matched_jobs.map((job) => (
                          <div
                            key={job.id}
                            className="p-2.5 rounded-lg bg-zinc-900/70 border border-zinc-800 flex items-start justify-between gap-2 text-xs"
                          >
                            <div className="min-w-0 space-y-0.5">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-semibold text-zinc-100 truncate">
                                  {job.po_number || job.po_folder_name}
                                </span>
                                <StatusBadge status={job.status} lang={lang} />
                              </div>
                              <div className="text-[11px] text-zinc-400 truncate">
                                {job.matched_company_name || job.detected_company_raw || tx(lang, 'Unmatched supplier', 'ยังไม่พบผู้ขาย')}
                              </div>
                              {job.matched_email && (
                                <div className="text-[10px] text-emerald-300/90 truncate font-mono">
                                  {job.matched_email}
                                </div>
                              )}
                              {job.department_cc_emails && (
                                <div className="text-[10px] text-cyan-300/90 truncate">
                                  CC ({job.matched_department}): {job.department_cc_emails}
                                </div>
                              )}
                            </div>
                            <div className="flex flex-col gap-1 shrink-0">
                              <button
                                type="button"
                                onClick={() => onInspectJob(job.id)}
                                className="px-2 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-medium flex items-center gap-1"
                              >
                                <ExternalLink className="w-3 h-3" />
                                <span>{tx(lang, 'Inspect', 'เปิดดู')}</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => handleSelectFocusJob(job.id)}
                                className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[10px]"
                              >
                                {tx(lang, 'Focus PO', 'เจาะจง')}
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {turn.response.matched_companies.some(
                      (comp) => (comp.company_name || comp.alternative_name || '').trim().length > 0
                    ) && (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        {turn.response.matched_companies
                          .filter(
                            (comp) =>
                              (comp.company_name || comp.alternative_name || '').trim().length > 0
                          )
                          .map((comp, idx) => {
                            const cKey = `${turn.id}-co-${idx}`;
                            const displayName =
                              comp.company_name.trim() || comp.alternative_name?.trim() || '';
                            return (
                              <div
                                key={cKey}
                                className="p-2.5 rounded-lg bg-zinc-900/70 border border-zinc-800 flex items-start justify-between gap-2 text-xs"
                              >
                                <div className="min-w-0 space-y-0.5">
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    <Building2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                                    <span className="font-semibold text-zinc-100 truncate">
                                      {displayName}
                                    </span>
                                    {comp.vendor_group && (
                                      <span className="px-1.5 py-0.2 rounded bg-zinc-800 text-zinc-300 text-[10px]">
                                        {comp.vendor_group}
                                      </span>
                                    )}
                                  </div>
                                  {comp.alternative_name &&
                                    comp.alternative_name !== displayName && (
                                      <div className="text-[11px] text-zinc-400 truncate">
                                        {comp.alternative_name}
                                      </div>
                                    )}
                                  <div className="text-[11px] text-emerald-300 font-mono truncate">
                                    {comp.email || tx(lang, '(no email)', '(ไม่มีอีเมล)')}
                                  </div>
                                  {comp.tax_id && (
                                    <div className="text-[10px] text-zinc-500 font-mono">
                                      Tax ID: {comp.tax_id}
                                    </div>
                                  )}
                                </div>
                                {comp.email && (
                                  <button
                                    type="button"
                                    onClick={() => handleCopyText(cKey, comp.email)}
                                    className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-[11px] flex items-center gap-1 shrink-0"
                                  >
                                    {copiedKey === cKey ? (
                                      <Check className="w-3 h-3 text-emerald-400" />
                                    ) : (
                                      <Copy className="w-3 h-3" />
                                    )}
                                    <span>{tx(lang, 'Copy', 'คัดลอก')}</span>
                                  </button>
                                )}
                              </div>
                            );
                          })}
                      </div>
                    )}

                    {turn.response.matched_departments.length > 0 && (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        {turn.response.matched_departments.map((dept, idx) => {
                          const dKey = `${turn.id}-dept-${idx}`;
                          return (
                            <div
                              key={dKey}
                              className="p-2.5 rounded-lg bg-zinc-900/70 border border-zinc-800 flex items-start justify-between gap-2 text-xs"
                            >
                              <div className="min-w-0 space-y-0.5">
                                <div className="flex items-center gap-1.5">
                                  <Users className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                                  <span className="font-semibold text-zinc-100 truncate">
                                    #{dept.department_no} {dept.department_name}
                                  </span>
                                </div>
                                <div className="text-[11px] text-cyan-300 font-mono truncate">
                                  {dept.emails}
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => handleCopyText(dKey, dept.emails)}
                                className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-[11px] flex items-center gap-1 shrink-0"
                              >
                                {copiedKey === dKey ? (
                                  <Check className="w-3 h-3 text-emerald-400" />
                                ) : (
                                  <Copy className="w-3 h-3" />
                                )}
                                <span>{tx(lang, 'Copy CC', 'คัดลอก CC')}</span>
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
            </div>
          ))
        )}

        {isSending && (
          <div className="flex items-center gap-2 text-xs text-zinc-400 px-2 py-1">
            <Loader2 className="w-4 h-4 animate-spin text-purple-400 shrink-0" />
            <span>
              {sendingWithVision
                ? tx(
                    lang,
                    `Reading live DB & analyzing PDF page (${elapsedSec}s) — safe to switch tabs, AI keeps running...`,
                    `กำลังอ่านฐานข้อมูลและภาพ PDF (${elapsedSec} วินาที) — สลับไปทำหน้าอื่นได้ AI ยังทำงานต่อในพื้นหลัง...`
                  )
                : tx(
                    lang,
                    `Thinking locally (${elapsedSec}s) — safe to switch tabs, AI keeps running...`,
                    `กำลังประมวลผลด้วย AI ในเครื่อง (${elapsedSec} วินาที) — สลับไปทำหน้าอื่นได้ คำตอบจะถูกบันทึกให้อัตโนมัติ...`
                  )}
            </span>
          </div>
        )}
        <div ref={scrollEndRef} />
      </div>

      {/* Prompt Composer */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submitPrompt(inputText);
        }}
        className="p-3 rounded-xl bg-[#121215] border border-zinc-800 flex items-end gap-2.5 shrink-0"
      >
        <textarea
          rows={2}
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submitPrompt(inputText);
            }
          }}
          placeholder={
            focusedJob
              ? tx(
                  lang,
                  `Ask about ${focusedJob.po_number || focusedJob.po_folder_name} (e.g., total amount, delivery date, supplier match)...`,
                  `ถามเกี่ยวกับ ${focusedJob.po_number || focusedJob.po_folder_name} (เช่น ยอดรวม วันส่งของ ชื่อบริษัท อีเมล CC)...`
                )
              : tx(
                  lang,
                  'Ask to find a PO, supplier email, Department CC, or why a PO needs review... (Enter to send)',
                  'พิมพ์ถามได้เลย เช่น หาใบ PO ที่รอตรวจ, หาอีเมลบริษัท, หาอีเมล CC แผนก... (กด Enter เพื่อส่ง)'
                )
          }
          className="flex-1 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-zinc-100 placeholder-zinc-500 resize-none focus:outline-none focus:border-purple-500"
        />
        <button
          type="submit"
          disabled={isSending || !inputText.trim()}
          className="px-4 py-2.5 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-1.5 shrink-0"
        >
          {isSending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          <span>{tx(lang, 'Ask AI', 'ส่งคำถาม')}</span>
        </button>
      </form>
    </div>
  );
};
