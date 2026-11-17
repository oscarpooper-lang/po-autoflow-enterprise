import React from 'react';
import {
  BarChart3,
  TrendingUp,
  Languages,
  Building2,
  MailCheck,
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import type { DashboardStats, Job, CompanyCacheEntry, PoTransaction } from '../types';
import { tx, type UiLang } from '../i18n';

interface AnalyticsProps {
  stats: DashboardStats;
  jobs?: Job[];
  companies?: CompanyCacheEntry[];
  transactions?: PoTransaction[];
  lang?: UiLang;
}

const hasThaiScript = (value?: string): boolean => Boolean(value && /[\u0E00-\u0E7F]/.test(value));

export const Analytics: React.FC<AnalyticsProps> = ({
  stats,
  jobs = [],
  companies = [],
  transactions = [],
  lang = 'en',
}) => {
  const totalJobs = jobs.length;
  const completedCount = jobs.filter((j) => j.status === 'completed').length;
  const reviewCount = jobs.filter((j) => j.status === 'needs_review').length;
  const failedCount = jobs.filter((j) => j.status === 'failed').length;
  const inFlightCount = jobs.filter(
    (j) => j.status !== 'completed' && j.status !== 'needs_review' && j.status !== 'failed'
  ).length;

  const matchedJobsWithScore = jobs.filter((j) => typeof j.match_confidence === 'number');
  const avgMatchScore =
    matchedJobsWithScore.length > 0
      ? matchedJobsWithScore.reduce((acc, j) => acc + (j.match_confidence || 0), 0) /
        matchedJobsWithScore.length
      : stats.avg_ocr_confidence;

  const thaiDetectedCount = jobs.filter((j) => hasThaiScript(j.detected_company_raw)).length;
  const englishOnlyCount = jobs.filter(
    (j) => Boolean(j.detected_company_raw) && !hasThaiScript(j.detected_company_raw)
  ).length;

  const verifiedCount = jobs.filter((j) => j.match_category === 'verified').length;
  const highCount = jobs.filter((j) => j.match_category === 'high').length;
  const categoryReviewCount = jobs.filter((j) => j.match_category === 'review').length;
  const noMatchCount = jobs.filter((j) => j.match_category === 'no_match').length;

  const activeSuppliersCount = companies.filter((c) => c.active).length;
  const confirmedTxCount = transactions.filter(
    (t) => t.status === 'sent' || t.status === 'confirmed_delivery' || t.status === 'accepted'
  ).length;

  const pct = (count: number, total: number) =>
    total > 0 ? `${Math.round((count / total) * 100)}%` : '0%';

  const statusRows = [
    { label: tx(lang, 'Completed / Delivered', 'ส่งสำเร็จแล้ว'), count: completedCount, color: 'bg-emerald-500' },
    { label: tx(lang, 'Needs Manual Review', 'รอตรวจสอบและอนุมัติ'), count: reviewCount, color: 'bg-amber-500' },
    { label: tx(lang, 'In Progress / Queued', 'กำลังประมวลผล / อยู่ในคิว'), count: inFlightCount, color: 'bg-blue-500' },
    { label: tx(lang, 'Failed', 'ผิดพลาด'), count: failedCount, color: 'bg-rose-500' },
  ];

  const categoryRows = [
    { label: tx(lang, 'Verified Auto-Match (>= 98%)', 'ยืนยันอัตโนมัติ (>= 98%)'), count: verifiedCount, color: 'bg-emerald-500' },
    { label: tx(lang, 'High Confidence Match (>= 90%)', 'ความมั่นใจสูง (>= 90%)'), count: highCount, color: 'bg-blue-500' },
    { label: tx(lang, 'Review Threshold', 'รอคนตรวจสอบ'), count: categoryReviewCount, color: 'bg-amber-500' },
    { label: tx(lang, 'No Match Found', 'ไม่พบรายชื่อที่ตรง'), count: noMatchCount, color: 'bg-rose-500' },
  ];

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-white flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-blue-400" />
            {tx(lang, 'OCR & Directory Matching Analytics', 'สถิติความแม่นยำ OCR และการจับคู่ผู้ขาย')}
          </h2>
          <p className="text-xs text-zinc-400">
            {tx(
              lang,
              'Live metrics computed from SQLite jobs, OCR extraction confidence, Google Sheets supplier directory, and delivery audit logs',
              'ข้อมูลสถิติจากคิวงาน SQLite ความมั่นใจการอ่าน OCR ฐานข้อมูลผู้ขาย Google Sheets และบันทึกการส่งอีเมล'
            )}
          </p>
        </div>

        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
          <ShieldCheck className="w-3.5 h-3.5" />
          {tx(lang, 'QTC Self-Company Filtered • Thai-First Matching', 'กรองบริษัท QTC เองออก • จับคู่ชื่อไทยก่อน')}
        </span>
      </div>

      {/* Real KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="p-4 rounded-xl bg-[#121215] border border-zinc-800 shadow-sm">
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span>{tx(lang, 'Avg Match / OCR Confidence', 'คะแนนความมั่นใจเฉลี่ย')}</span>
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="mt-2 text-2xl font-bold text-white">{avgMatchScore.toFixed(1)}%</div>
          <p className="text-[11px] text-zinc-500 mt-1">
            {matchedJobsWithScore.length > 0
              ? tx(
                  lang,
                  `Across ${matchedJobsWithScore.length} scored PO jobs`,
                  `คำนวณจากใบ PO ที่ตรวจคะแนนแล้ว ${matchedJobsWithScore.length} รายการ`
                )
              : tx(
                  lang,
                  `DB baseline (${stats.avg_ocr_confidence.toFixed(1)}% avg OCR)`,
                  `ค่าอ้างอิงเริ่มต้น (${stats.avg_ocr_confidence.toFixed(1)}% OCR เฉลี่ย)`
                )}
          </p>
        </div>

        <div className="p-4 rounded-xl bg-[#121215] border border-zinc-800 shadow-sm">
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span>{tx(lang, 'Pipeline Success Rate', 'อัตราความสำเร็จการส่งงาน')}</span>
            <TrendingUp className="w-4 h-4 text-blue-400" />
          </div>
          <div className="mt-2 text-2xl font-bold text-blue-400">
            {stats.success_rate_percent.toFixed(1)}%
          </div>
          <p className="text-[11px] text-zinc-500 mt-1">
            {tx(
              lang,
              `${stats.successfully_sent} delivered out of ${stats.total_processed} terminal jobs`,
              `ส่งแล้ว ${stats.successfully_sent} จากทั้งหมด ${stats.total_processed} งานที่จบแล้ว`
            )}
          </p>
        </div>

        <div className="p-4 rounded-xl bg-[#121215] border border-zinc-800 shadow-sm">
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span>{tx(lang, 'Thai vs English Primary', 'เอกสารภาษาไทย vs อังกฤษ')}</span>
            <Languages className="w-4 h-4 text-indigo-400" />
          </div>
          <div className="mt-2 text-2xl font-bold text-indigo-400">
            {thaiDetectedCount} TH / {englishOnlyCount} EN
          </div>
          <p className="text-[11px] text-zinc-500 mt-1">
            {tx(lang, 'Thai supplier prioritized before English fallback', 'ให้ความสำคัญชื่อผู้ขายภาษาไทยก่อนชื่ออังกฤษ')}
          </p>
        </div>

        <div className="p-4 rounded-xl bg-[#121215] border border-zinc-800 shadow-sm">
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span>{tx(lang, 'Synced Directory & Deliveries', 'ฐานข้อมูลผู้ขายและการส่ง')}</span>
            <Building2 className="w-4 h-4 text-amber-400" />
          </div>
          <div className="mt-2 text-2xl font-bold text-amber-400">{companies.length}</div>
          <p className="text-[11px] text-zinc-500 mt-1">
            {tx(
              lang,
              `${activeSuppliersCount} active suppliers • ${confirmedTxCount}/${transactions.length} tx sent`,
              `ผู้ขายที่ใช้งาน ${activeSuppliersCount} ราย • ส่งสำเร็จ ${confirmedTxCount}/${transactions.length} ครั้ง`
            )}
          </p>
        </div>
      </div>

      {/* Real Breakdown Panels */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="p-5 rounded-xl bg-[#121215] border border-zinc-800 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">
              {tx(lang, 'Job Execution Status Breakdown', 'สัดส่วนสถานะงานทั้งหมด')}
            </h3>
            <span className="text-xs text-zinc-400 font-mono">
              {totalJobs} {tx(lang, 'jobs recorded', 'งานทั้งหมด')}
            </span>
          </div>

          <div className="space-y-3">
            {statusRows.map((row) => (
              <div key={row.label}>
                <div className="flex justify-between text-xs text-zinc-400 mb-1">
                  <span>{row.label}</span>
                  <span className="font-mono text-zinc-200">
                    {row.count} ({pct(row.count, totalJobs)})
                  </span>
                </div>
                <div className="w-full h-2 rounded-full bg-zinc-800 overflow-hidden">
                  <div
                    className={`${row.color} h-full rounded-full transition-all`}
                    style={{ width: pct(row.count, totalJobs) }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="p-5 rounded-xl bg-[#121215] border border-zinc-800 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <MailCheck className="w-4 h-4 text-emerald-400" />
              {tx(lang, 'Directory Matching Tier Distribution', 'ระดับความแม่นยำในการจับคู่ผู้ขาย')}
            </h3>
            <span className="text-xs text-zinc-400 font-mono">
              {matchedJobsWithScore.length} {tx(lang, 'evaluated', 'รายการที่ประเมิน')}
            </span>
          </div>

          <div className="space-y-3">
            {categoryRows.map((row) => (
              <div key={row.label}>
                <div className="flex justify-between text-xs text-zinc-400 mb-1">
                  <span>{row.label}</span>
                  <span className="font-mono text-zinc-200">
                    {row.count} ({pct(row.count, totalJobs)})
                  </span>
                </div>
                <div className="w-full h-2 rounded-full bg-zinc-800 overflow-hidden">
                  <div
                    className={`${row.color} h-full rounded-full transition-all`}
                    style={{ width: pct(row.count, totalJobs) }}
                  />
                </div>
              </div>
            ))}
          </div>

          {companies.length === 0 && (
            <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                {tx(
                  lang,
                  'Google Sheets directory cache is currently empty. Sync from Company Directory or Overview so incoming POs can match suppliers automatically.',
                  'ยังไม่มีรายชื่อผู้ขายในแคช กรุณากดซิงก์ข้อมูลจาก Google Sheet เพื่อให้ระบบจับคู่ผู้ขายอัตโนมัติได้'
                )}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
