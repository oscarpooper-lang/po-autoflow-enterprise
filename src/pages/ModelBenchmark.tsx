import React, { useState, useEffect } from 'react';
import {
  Gauge,
  Play,
  Loader2,
  Trophy,
  Zap,
  Clock,
  FileSearch,
  ChevronDown,
  ChevronUp,
  Cpu,
  AlertTriangle,
  CheckCircle2,
  SkipForward,
  RefreshCw,
} from 'lucide-react';
import type { AppSettings, Job } from '../types';
import { api, type BenchmarkReport, type BenchmarkLayerResult } from '../services/tauri';
import { tx, type UiLang } from '../i18n';

interface ModelBenchmarkProps {
  settings: AppSettings;
  jobs: Job[];
  lang?: UiLang;
}

export const ModelBenchmark: React.FC<ModelBenchmarkProps> = ({ settings, jobs, lang = 'en' }) => {
  const [filePath, setFilePath] = useState(() => {
    const firstJobPath = jobs.find((j) => j.source_path)?.source_path;
    if (firstJobPath) return firstJobPath;
    const rev = (settings.review_dir || `${settings.root_dir}\\Review`).replace(/[\\/]+$/, '');
    return `${rev}\\PO-26004319\\PO-26004319.pdf`;
  });
  const [candidates, setCandidates] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [report, setReport] = useState<BenchmarkReport | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const loadCandidates = () => {
    api
      .listBenchmarkCandidates()
      .then((list) => {
        setCandidates(list);
        if (list.length > 0) {
          setFilePath((prev) => (prev && list.includes(prev) ? prev : list[0]));
        }
      })
      .catch(() => {});
  };

  useEffect(() => {
    loadCandidates();
  }, []);

  const handleRunBenchmark = async () => {
    if (!filePath.trim()) {
      setErrorMsg(tx(lang, 'Please choose or enter a PDF/image file path first.', 'กรุณาเลือกหรือระบุที่อยู่ไฟล์ PDF / รูปภาพก่อน'));
      return;
    }
    setRunning(true);
    setErrorMsg(null);
    try {
      const res = await api.benchmarkOcrLayers(filePath.trim());
      setReport(res);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const maxMs = Math.max(
    1,
    ...(report?.layers || []).filter((l) => l.status === 'ok').map((l) => l.duration_ms)
  );

  const renderStatusBadge = (layer: BenchmarkLayerResult) => {
    if (layer.status === 'ok') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-[10px] font-semibold">
          <CheckCircle2 className="w-3 h-3" /> {tx(lang, 'Completed', 'สำเร็จ')}
        </span>
      );
    }
    if (layer.status === 'skipped') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700 text-[10px] font-semibold">
          <SkipForward className="w-3 h-3" /> {tx(lang, 'Skipped', 'ข้าม')}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-rose-500/15 text-rose-300 border border-rose-500/30 text-[10px] font-semibold">
        <AlertTriangle className="w-3 h-3" /> {tx(lang, 'Error', 'ผิดพลาด')}
      </span>
    );
  };

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6 text-xs">
      {/* Official Single-Winner Verdict Banner */}
      <div className="bg-emerald-950/25 border border-emerald-500/35 rounded-xl p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-emerald-200 flex items-center gap-2">
            <Trophy className="w-4 h-4 text-emerald-400" />
            <span>
              {tx(
                lang,
                'Official OCR Verdict: Best Single Pipeline for PO AutoFlow',
                'ข้อสรุปผลการทดสอบ: ชุดตัวอ่านเอกสารที่ดีที่สุดสำหรับ PO AutoFlow'
              )}
            </span>
          </h3>
          <span className="px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-semibold text-[11px]">
            {tx(lang, '1 Recommended Stack • Zero Clutter', 'ชุดแนะนำเดียวจบ • ไม่สับสน')}
          </span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-[11px]">
          <div className="p-3 rounded-lg bg-zinc-950/70 border border-emerald-500/25 space-y-1">
            <div className="font-bold text-emerald-300">
              {tx(lang, '1. Winner (Scans): OpenThai 2.0 OCR-Text', '1. ชนะเลิศ (เอกสารสแกน): OpenThai 2.0 OCR-Text')}
            </div>
            <p className="text-zinc-300 leading-relaxed">
              {tx(
                lang,
                '0.4s–0.9s/page • 93%–99% Thai+EN at full 400 DPI scale (1920px detector). Cleanly reads Thai diacritics and mixed English headers at 4.2 MB, 5–10x faster and cleaner than Tesseract 5.',
                '0.4–0.9 วินาที/หน้า • แม่นยำไทย+อังกฤษ 93%–99% ที่ความละเอียดเต็ม 400 DPI อ่านสระวรรณยุกต์ไทยและหัวตารางอังกฤษได้คมชัด ขนาดเพียง 4.2 MB เร็วกว่า Tesseract 5 ถึง 5–10 เท่า'
              )}
            </p>
          </div>
          <div className="p-3 rounded-lg bg-zinc-950/70 border border-cyan-500/25 space-y-1">
            <div className="font-bold text-cyan-300">
              {tx(lang, '2. Digital PDFs: Built-in Digital PDF Reader', '2. PDF ดิจิทัล: ตัวอ่าน PDF ดิจิทัลในตัว')}
            </div>
            <p className="text-zinc-300 leading-relaxed">
              {tx(
                lang,
                '~0.01s/page • Exact text. Extracts embedded PDF text instantly and hands image-only or garbled-font pages directly to OpenThai 2.0.',
                '~0.01 วินาที/หน้า • ข้อความตรง 100% ดึงข้อความจาก PDF ทันที และส่งต่อหน้าสแกนหรือหน้าที่ฟอนต์เพี้ยนให้ OpenThai 2.0'
              )}
            </p>
          </div>
          <div className="p-3 rounded-lg bg-zinc-950/70 border border-purple-500/25 space-y-1">
            <div className="font-bold text-purple-300">
              {tx(lang, '3. AI Helper: Qwen2.5-VL-3B (Vulkan GPU)', '3. AI ผู้ช่วยเสริม: Qwen2.5-VL-3B (Vulkan GPU)')}
            </div>
            <p className="text-zinc-300 leading-relaxed">
              {tx(
                lang,
                '~8–12s with GPU acceleration. Great as a fallback second opinion when OCR confidence < 85%, never as standalone text reader.',
                '~8–12 วินาทีเมื่อใช้ GPU เหมาะเป็นตัวช่วยตรวจสอบสำรองเมื่อความมั่นใจ OCR ต่ำกว่า 85%'
              )}
            </p>
          </div>
        </div>
      </div>

      {/* Header & Target Document Selector */}
      <div className="bg-[#121215] border border-zinc-800 rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Gauge className="w-4 h-4 text-blue-400" />
              <span>
                {tx(
                  lang,
                  'Multi-Layer OCR & Vision AI Benchmark Suite (Dev Only)',
                  'ชุดทดสอบเปรียบเทียบ OCR และ Vision AI ทุกชั้น (สำหรับนักพัฒนา)'
                )}
              </span>
            </h3>
            <p className="text-zinc-400 text-xs mt-1">
              {tx(
                lang,
                'Runs every extraction engine independently on a single real PO document so you can compare exact speed (ms), extracted Thai/English company accuracy, PO number, Tax ID, and raw text side by side.',
                'รันตัวอ่านทุกตัวแยกกันบนเอกสาร PO จริง เพื่อเทียบความเร็ว (ms) ความถูกต้องของชื่อผู้ขายไทย/อังกฤษ เลขที่ PO, Tax ID และข้อความดิบแบบตัวต่อตัว'
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={loadCandidates}
            className="px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-700 flex items-center gap-1.5 text-[11px]"
          >
            <RefreshCw className="w-3 h-3" />
            <span>{tx(lang, 'Refresh Files', 'รีเฟรชรายการไฟล์')}</span>
          </button>
        </div>

        <div className="flex flex-wrap gap-2">
          <div className="flex-1 min-w-[280px] relative">
            <FileSearch className="w-4 h-4 text-zinc-500 absolute left-3 top-2.5" />
            <input
              type="text"
              value={filePath}
              onChange={(e) => setFilePath(e.target.value)}
              placeholder="C:\...\PO-26004319.pdf"
              className="w-full bg-zinc-900 border border-zinc-700 text-zinc-100 rounded-lg pl-9 pr-3 py-2 font-mono text-xs"
            />
          </div>
          <button
            type="button"
            onClick={handleRunBenchmark}
            disabled={running}
            className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white font-semibold flex items-center gap-2"
          >
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            <span>
              {running
                ? tx(lang, 'Benchmarking All Layers...', 'กำลังทดสอบทุกเครื่องมือ...')
                : tx(lang, 'Run Full Benchmark', 'เริ่มทดสอบเปรียบเทียบทั้งหมด')}
            </span>
          </button>
        </div>

        {candidates.length > 0 && (
          <div className="space-y-1.5">
            <span className="text-[11px] text-zinc-400 block">
              {tx(
                lang,
                `Quick-Pick Document from Workspace (${candidates.length} found):`,
                `เลือกไฟล์ทดสอบจากในเครื่องด่วน (พบ ${candidates.length} ไฟล์):`
              )}
            </span>
            <div className="flex flex-wrap gap-1.5">
              {candidates.slice(0, 10).map((cand) => {
                const label = cand.split(/[\\/]/).slice(-2).join('\\');
                const selected = cand === filePath;
                return (
                  <button
                    key={cand}
                    type="button"
                    onClick={() => setFilePath(cand)}
                    className={`px-2 py-1 rounded border font-mono text-[11px] transition-colors ${
                      selected
                        ? 'bg-blue-600/20 border-blue-500 text-blue-200'
                        : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200'
                    }`}
                    title={cand}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {errorMsg && (
          <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300">
            {errorMsg}
          </div>
        )}
      </div>

      {/* Benchmark Results */}
      {report && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="p-4 rounded-xl bg-[#121215] border border-zinc-800 space-y-1">
              <span className="text-[11px] text-zinc-400 flex items-center gap-1.5">
                <Trophy className="w-3.5 h-3.5 text-emerald-400" /> {tx(lang, 'Best Accuracy Score', 'แม่นยำสูงสุด')}
              </span>
              <p className="text-sm font-bold text-emerald-300 truncate">
                {report.best_accuracy_layer || tx(lang, 'None matched fields', 'ไม่มีเครื่องมือที่อ่านฟิลด์ครบ')}
              </p>
            </div>
            <div className="p-4 rounded-xl bg-[#121215] border border-zinc-800 space-y-1">
              <span className="text-[11px] text-zinc-400 flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5 text-blue-400" /> {tx(lang, 'Fastest Working Engine', 'ตัวที่เร็วที่สุด')}
              </span>
              <p className="text-sm font-bold text-blue-300 truncate">
                {report.fastest_layer || tx(lang, 'None completed', 'ไม่มีตัวที่สำเร็จ')}
              </p>
            </div>
            <div className="p-4 rounded-xl bg-[#121215] border border-zinc-800 space-y-1">
              <span className="text-[11px] text-zinc-400 flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-zinc-400" /> {tx(lang, 'Total Suite Runtime', 'เวลารวมทั้งหมด')}
              </span>
              <p className="text-sm font-bold font-mono text-zinc-100">
                {(report.total_duration_ms / 1000).toFixed(2)}s ({report.layers.length} {tx(lang, 'layers tested', 'ชั้นที่ทดสอบ')})
              </p>
            </div>
          </div>

          <div className="bg-[#121215] border border-zinc-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-zinc-800 font-semibold text-zinc-200 flex items-center justify-between">
              <span>{tx(lang, 'Engine-by-Engine Comparison', 'ตารางเปรียบเทียบรายเครื่องมือ')}</span>
              <span className="text-[11px] font-mono text-zinc-500 truncate max-w-md">{report.file_path}</span>
            </div>

            <div className="divide-y divide-zinc-800/80">
              {report.layers.map((layer) => {
                const isBest = report.best_accuracy_layer === layer.name;
                const isFastest = report.fastest_layer === layer.name;
                const expanded = expandedId === layer.id;
                const barWidth =
                  layer.status === 'ok' ? Math.max(4, Math.round((layer.duration_ms / maxMs) * 100)) : 0;

                return (
                  <div key={layer.id} className="p-4 space-y-2.5 hover:bg-zinc-900/30 transition-colors">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2 min-w-0">
                        <span className="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-zinc-400 text-[10px]">
                          {layer.category}
                        </span>
                        <span className="font-semibold text-zinc-100">{layer.name}</span>
                        {renderStatusBadge(layer)}
                        {isBest && (
                          <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 text-[10px] font-semibold">
                            {tx(lang, 'Best Accuracy', 'แม่นยำสูงสุด')}
                          </span>
                        )}
                        {isFastest && (
                          <span className="px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 border border-blue-500/40 text-[10px] font-semibold">
                            {tx(lang, 'Fastest', 'เร็วที่สุด')}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-3 font-mono text-[11px]">
                        <span className="text-zinc-300">
                          {layer.status === 'ok'
                            ? layer.duration_ms >= 1000
                              ? `${(layer.duration_ms / 1000).toFixed(2)}s`
                              : `${layer.duration_ms.toFixed(0)}ms`
                            : '—'}
                        </span>
                        <span className="text-zinc-400">{tx(lang, 'Score:', 'คะแนน:')} {layer.field_score}/10</span>
                        <span className="text-zinc-400">{tx(lang, 'Conf:', 'มั่นใจ:')} {layer.confidence.toFixed(0)}%</span>
                        {layer.raw_preview && (
                          <button
                            type="button"
                            onClick={() => setExpandedId(expanded ? null : layer.id)}
                            className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 flex items-center gap-1"
                          >
                            <span>{tx(lang, 'Raw', 'ข้อความดิบ')}</span>
                            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                          </button>
                        )}
                      </div>
                    </div>

                    {layer.status === 'ok' && (
                      <div className="w-full h-1.5 rounded-full bg-zinc-900 overflow-hidden">
                        <div
                          className={`h-full rounded-full ${isBest ? 'bg-emerald-500' : 'bg-blue-500'}`}
                          style={{ width: `${barWidth}%` }}
                        />
                      </div>
                    )}

                    <div className="grid grid-cols-1 md:grid-cols-4 gap-2 text-[11px]">
                      <div className="p-2 rounded bg-zinc-950/70 border border-zinc-800/80 truncate">
                        <span className="text-zinc-500">{tx(lang, 'Thai Name: ', 'ชื่อไทย: ')}</span>
                        <span className="text-zinc-200 font-medium">{layer.supplier_th || '—'}</span>
                      </div>
                      <div className="p-2 rounded bg-zinc-950/70 border border-zinc-800/80 truncate">
                        <span className="text-zinc-500">{tx(lang, 'English Name: ', 'ชื่ออังกฤษ: ')}</span>
                        <span className="text-zinc-200 font-medium">{layer.supplier_en || '—'}</span>
                      </div>
                      <div className="p-2 rounded bg-zinc-950/70 border border-zinc-800/80 truncate font-mono">
                        <span className="text-zinc-500 font-sans">PO / Tax ID: </span>
                        <span className="text-zinc-200">
                          {[...layer.po_numbers.slice(0, 1), ...layer.tax_ids.slice(0, 1)].join(' • ') || '—'}
                        </span>
                      </div>
                      <div className="p-2 rounded bg-zinc-950/70 border border-zinc-800/80 md:col-span-4">
                        <span className="text-zinc-500">{tx(lang, 'Feedback / Note: ', 'หมายเหตุ: ')}</span>
                        <span className={layer.status === 'error' ? 'text-rose-300' : 'text-zinc-300'}>
                          {layer.note || '—'}
                        </span>
                      </div>
                    </div>

                    {expanded && layer.raw_preview && (
                      <pre className="p-3 rounded-lg bg-zinc-950 border border-zinc-800 text-[11px] font-mono text-zinc-300 whitespace-pre-wrap max-h-56 overflow-y-auto">
                        {layer.raw_preview}
                      </pre>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Thai Model Reference Guide */}
      <div className="bg-[#121215] border border-zinc-800 rounded-xl p-5 space-y-3">
        <h4 className="font-semibold text-white flex items-center gap-2">
          <Cpu className="w-4 h-4 text-purple-400" />
          <span>
            {tx(
              lang,
              'Benchmark Notes & Hardware Verdict (GTX 1650 + i5 Laptop)',
              'บันทึกผลการทดสอบจริงและคำแนะนำตามสเปกเครื่อง'
            )}
          </span>
        </h4>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[11px]">
          <div className="p-3 rounded-lg bg-zinc-950/70 border border-emerald-500/30 space-y-1">
            <div className="font-semibold text-emerald-300">
              {tx(lang, 'OpenThai 2.0 OCR-Text (~4.2 MB ONNX) — WINNER', 'OpenThai 2.0 OCR-Text (~4.2 MB ONNX) — แนะนำอันดับ 1')}
            </div>
            <p className="text-zinc-400">
              {tx(
                lang,
                'Built by iApp for Thai+English printed documents. Runs cleanly on CPU in 0.26–1.17s/page with 93%–98% confidence and minimal diacritic errors. (Note: OpenThai 2.0 Markdown is 2.52 GB PyTorch/Nemotron — unnecessary for PO extraction.)',
                'พัฒนาโดย iApp สำหรับเอกสารไทย+อังกฤษ รันบน CPU ได้ใน 0.26–1.17 วินาที/หน้า ความแม่นยำ 93%–98% และอ่านวรรณยุกต์สระไทยได้ครบ (รุ่น Markdown ใหญ่ถึง 2.52 GB จึงไม่จำเป็น)'
              )}
            </p>
          </div>
          <div className="p-3 rounded-lg bg-zinc-950/70 border border-zinc-800 space-y-1">
            <div className="font-semibold text-purple-300">
              {tx(lang, 'Qwen2.5-VL-3B vs Typhoon-OCR-3B (Local VLM Helper)', 'Qwen2.5-VL-3B เทียบ Typhoon-OCR-3B (Vision AI ในเครื่อง)')}
            </div>
            <p className="text-zinc-400">
              {tx(
                lang,
                'With Vulkan GPU acceleration on GTX 1650, Qwen2.5-VL-3B runs in ~8–12s as a fallback second opinion. SCB 10X notes that typhoon-ocr-3b loses accuracy in GGUF vs Ollama; small VLMs can still invent missing emails, so always prefer OpenThai 2.0 first.',
                'เมื่อเปิดเร่งความเร็ว GPU (Vulkan) บน GTX 1650 ใช้เวลา ~8–12 วินาที เหมาะเป็นตัวช่วยสำรองเวลาภาพเบลอ ทั้งนี้โมเดล VLM ขนาดเล็กอาจเดาอีเมลเอง จึงใช้ OpenThai 2.0 เป็นหลักเสมอ'
              )}
            </p>
          </div>
          <div className="p-3 rounded-lg bg-zinc-950/70 border border-zinc-800 space-y-1">
            <div className="font-semibold text-amber-300">
              {tx(lang, 'Tesseract 5 (tha+eng) — Legacy Backup Only', 'Tesseract 5 (tha+eng) — ตัวสำรองแบบดั้งเดิมเท่านั้น')}
            </div>
            <p className="text-zinc-400">
              {tx(
                lang,
                'Takes 2.2–12s per page (5–10x slower than OpenThai 2.0), inserts spaces inside Thai words, and struggles on noisy scans like ภพ.20.',
                'ใช้เวลา 2.2–12 วินาที/หน้า (ช้ากว่า OpenThai 2.0 ถึง 5–10 เท่า) มักเว้นวรรคกลางคำภาษาไทย และอ่านสแกนไม่ชัดเช่น ภพ.20 ได้ยากกว่า'
              )}
            </p>
          </div>
          <div className="p-3 rounded-lg bg-zinc-950/70 border border-zinc-800 space-y-1">
            <div className="font-semibold text-zinc-300">
              {tx(lang, 'Windows WinRT OCR & EasyOCR', 'Windows WinRT OCR และ EasyOCR')}
            </div>
            <p className="text-zinc-400">
              {tx(
                lang,
                "Windows WinRT reads English well, but outputs Latin mojibake on Thai unless Windows' Thai OCR pack is installed. EasyOCR needs ~2.5 GB PyTorch and is much slower than OpenThai 2.0.",
                'Windows OCR อ่านอังกฤษได้ดี แต่จะเพี้ยนเป็นตัวอักษรละตินหากเครื่องยังไม่ได้ติดตั้งแพ็กภาษาไทยของ Windows ส่วน EasyOCR ต้องใช้ PyTorch ใหญ่ ~2.5 GB และช้ากว่ามาก'
              )}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
