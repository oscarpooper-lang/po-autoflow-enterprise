import React, { useState } from 'react';
import {
  Activity,
  CheckCircle2,
  Clock,
  RotateCw,
  FolderOpen,
  ArrowRight,
  Filter,
  Search,
  ScanEye,
  FileArchive,
  CloudUpload,
  MailCheck,
  Terminal,
  AlertTriangle
} from 'lucide-react';
import type { Job, ApplicationEvent } from '../types';
import { StatusBadge } from './Overview';
import { api } from '../services/tauri';

interface LiveMonitorProps {
  jobs: Job[];
  events: ApplicationEvent[];
  onSelectJob: (jobId: string) => void;
  onRetryJob: (jobId: string) => void;
}

const PIPELINE_STAGES = [
  { id: 'detected', label: '1. Folder Found', icon: FolderOpen },
  { id: 'waiting_stability', label: '2. Copy Check', icon: Clock },
  { id: 'extracting_text', label: '3. Read Docs', icon: Activity },
  { id: 'ocr_processing', label: '4. OCR Scan', icon: ScanEye },
  { id: 'matching_company', label: '5. Vendor Match', icon: CheckCircle2 },
  { id: 'preparing_zip', label: '6. Pack ZIP', icon: FileArchive },
  { id: 'uploading_drive', label: '7. Drive Backup', icon: CloudUpload },
  { id: 'sending_email', label: '8. Send Email', icon: MailCheck },
];

export const LiveMonitor: React.FC<LiveMonitorProps> = ({
  jobs = [],
  events = [],
  onSelectJob,
  onRetryJob,
}) => {
  const [selectedStatusFilter, setSelectedStatusFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');

  const activeJob = jobs.find(
    (j) => j.status !== 'completed' && j.status !== 'failed' && j.status !== 'needs_review'
  );

  const filteredJobs = jobs.filter((job) => {
    if (selectedStatusFilter !== 'all' && job.status !== selectedStatusFilter) {
      return false;
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        job.po_folder_name.toLowerCase().includes(q) ||
        (job.po_number && job.po_number.toLowerCase().includes(q)) ||
        (job.matched_company_name && job.matched_company_name.toLowerCase().includes(q))
      );
    }
    return true;
  });

  const getStageIndex = (status: string) => {
    switch (status) {
      case 'detected':
        return 0;
      case 'waiting_stability':
        return 1;
      case 'extracting_text':
        return 2;
      case 'ocr_processing':
        return 3;
      case 'matching_company':
        return 4;
      case 'preparing_zip':
        return 5;
      case 'uploading_drive':
        return 6;
      case 'sending_email':
        return 7;
      case 'completed':
        return 8;
      default:
        return -1;
    }
  };

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Live Active Pipeline Visualizer */}
      <div className="p-5 rounded-xl bg-[#121215] border border-zinc-800 shadow-sm">
        <div className="flex items-center justify-between pb-4 border-b border-zinc-800">
          <div>
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-blue-500"></span>
              </span>
              Real-Time Document Pipeline Execution
            </h3>
            <p className="text-xs text-zinc-400">
              {activeJob
                ? `Currently processing: ${activeJob.po_number || activeJob.po_folder_name}`
                : 'Pipeline idle. Waiting for new folders in Incoming.'}
            </p>
          </div>
          {activeJob && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => api.runDeveloperCommand('reset-stuck')}
                title="If this job has been stuck for >1 minute, click to move it safely to Needs Review"
                className="px-2.5 py-1 rounded bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 text-xs font-medium"
              >
                Unstick Job
              </button>
              <span className="px-2.5 py-1 rounded bg-blue-500/20 text-blue-300 border border-blue-500/30 text-xs font-semibold animate-pulse">
                In-Flight
              </span>
            </div>
          )}
        </div>

        {/* 8-Stage Progress Flow */}
        <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
          {PIPELINE_STAGES.map((stage, idx) => {
            const Icon = stage.icon;
            const currentIdx = activeJob ? getStageIndex(activeJob.status) : -1;
            const isCompleted = activeJob ? currentIdx > idx : false;
            const isCurrent = activeJob ? currentIdx === idx : false;

            return (
              <div
                key={stage.id}
                className={`p-3 rounded-lg border flex flex-col items-center text-center transition-all ${
                  isCurrent
                    ? 'bg-blue-600/20 border-blue-500 text-blue-300 ring-2 ring-blue-500/40 shadow-md'
                    : isCompleted
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                    : 'bg-zinc-950/50 border-zinc-800 text-zinc-500'
                }`}
              >
                <Icon className={`w-5 h-5 mb-1.5 ${isCurrent ? 'animate-bounce text-blue-400' : ''}`} />
                <span className="text-[11px] font-semibold tracking-tight">{stage.label}</span>
                <span className="text-[10px] mt-0.5 opacity-80 font-mono">
                  {isCurrent ? 'Active...' : isCompleted ? 'Passed' : 'Pending'}
                </span>
              </div>
            );
          })}
        </div>

        {activeJob && (
          <div className="mt-4 p-3 rounded-lg bg-zinc-950/80 border border-blue-500/30 flex items-center justify-between text-xs">
            <span className="text-zinc-300 font-medium">Stage Status: {activeJob.stage_message}</span>
            <button
              onClick={() => onSelectJob(activeJob.id)}
              className="text-blue-400 hover:text-blue-300 font-semibold flex items-center gap-1"
            >
              <span>Inspect Raw Stream</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Filter and Queue Table */}
      <div className="rounded-xl bg-[#121215] border border-zinc-800 shadow-sm overflow-hidden">
        <div className="p-4 border-b border-zinc-800 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center space-x-2">
            <Filter className="w-4 h-4 text-zinc-400" />
            <select
              value={selectedStatusFilter}
              onChange={(e) => setSelectedStatusFilter(e.target.value)}
              className="bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded-lg px-2.5 py-1.5 font-medium focus:ring-1 focus:ring-blue-500"
            >
              <option value="all">All Statuses</option>
              <option value="completed">Sent (Completed)</option>
              <option value="needs_review">Needs Review</option>
              <option value="failed">Failed</option>
              <option value="ocr_processing">In OCR</option>
              <option value="waiting_stability">Waiting Stability</option>
            </select>
          </div>

          <div className="relative">
            <Search className="w-4 h-4 text-zinc-400 absolute left-3 top-2" />
            <input
              type="text"
              placeholder="Search by PO number or company..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded-lg pl-9 pr-3 py-1.5 w-64 focus:ring-1 focus:ring-blue-500 placeholder-zinc-500"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-zinc-950/60 text-zinc-400 font-medium border-b border-zinc-800">
              <tr>
                <th className="py-2.5 px-4">PO Identifier</th>
                <th className="py-2.5 px-4">Status</th>
                <th className="py-2.5 px-4">Matched Supplier</th>
                <th className="py-2.5 px-4">Score</th>
                <th className="py-2.5 px-4">Stage Message</th>
                <th className="py-2.5 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/70">
              {filteredJobs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-zinc-500">
                    No matching jobs found in queue
                  </td>
                </tr>
              ) : (
                filteredJobs.map((job) => (
                  <tr key={job.id} className="hover:bg-zinc-900/50 transition-colors">
                    <td className="py-3 px-4">
                      <div className="font-semibold text-white">{job.po_number || job.po_folder_name}</div>
                      <div className="text-[11px] text-zinc-500 font-mono">{job.po_folder_name}</div>
                    </td>
                    <td className="py-3 px-4">
                      <StatusBadge status={job.status} />
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-medium text-zinc-200 truncate max-w-[220px]">
                        {job.matched_company_name || job.detected_company_raw || 'Pending'}
                      </div>
                      {job.matched_email && (
                        <div className="text-[11px] text-zinc-400">{job.matched_email}</div>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      {job.match_confidence ? (
                        <span className="font-semibold text-zinc-300">
                          {job.match_confidence.toFixed(1)}%
                        </span>
                      ) : (
                        <span className="text-zinc-500">—</span>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <span className="text-zinc-300 truncate max-w-[260px] block" title={job.stage_message}>
                        {job.stage_message}
                      </span>
                      {job.error_details && (
                        <span
                          className="mt-1 inline-flex items-center gap-1 text-[11px] text-rose-400 truncate max-w-[260px]"
                          title={job.error_details}
                        >
                          <AlertTriangle className="w-3 h-3 shrink-0" />
                          <span className="truncate">{job.error_details}</span>
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right space-x-2">
                      <button
                        onClick={() => onSelectJob(job.id)}
                        className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[11px] font-medium border border-zinc-700"
                      >
                        Inspect
                      </button>
                      {(job.status === 'failed' || job.status === 'needs_review') && (
                        <button
                          onClick={() => onRetryJob(job.id)}
                          className="px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-medium"
                        >
                          <RotateCw className="w-3 h-3 inline mr-1" /> Retry
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Real-Time Event Log Stream */}
      <div className="rounded-xl bg-[#121215] border border-zinc-800 shadow-sm overflow-hidden">
        <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
          <h3 className="text-xs font-semibold text-white uppercase tracking-wider flex items-center gap-2">
            <Terminal className="w-4 h-4 text-blue-400" />
            Live Pipeline Event Stream
          </h3>
          <span className="text-[11px] text-zinc-400 font-mono">{events.length} recent events</span>
        </div>

        <div className="max-h-72 overflow-y-auto divide-y divide-zinc-800/70 font-mono text-[11px]">
          {events.length === 0 ? (
            <div className="py-8 text-center text-zinc-500 font-sans text-xs">
              No pipeline events recorded yet.
            </div>
          ) : (
            events.slice(0, 30).map((ev) => {
              const levelStyle =
                ev.level === 'error'
                  ? 'bg-rose-500/15 text-rose-400 border-rose-500/30'
                  : ev.level === 'warn'
                  ? 'bg-amber-500/15 text-amber-400 border-amber-500/30'
                  : ev.level === 'success'
                  ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                  : 'bg-blue-500/15 text-blue-400 border-blue-500/30';
              return (
                <div key={ev.id} className="px-4 py-2.5 flex items-start gap-3 hover:bg-zinc-900/40">
                  <span className="text-zinc-500 shrink-0">
                    {new Date(ev.timestamp).toLocaleTimeString()}
                  </span>
                  <span className={`px-1.5 py-0.5 rounded border uppercase text-[10px] font-semibold shrink-0 ${levelStyle}`}>
                    {ev.level}
                  </span>
                  <span className="text-zinc-200 flex-1 break-words">{ev.message}</span>
                  {ev.job_id && (
                    <button
                      type="button"
                      onClick={() => onSelectJob(ev.job_id!)}
                      className="text-blue-400 hover:text-blue-300 shrink-0 underline"
                    >
                      Inspect
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};

