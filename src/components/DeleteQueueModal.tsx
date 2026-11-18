import React from 'react';
import { Trash2, AlertTriangle, X, FolderX, Database } from 'lucide-react';
import type { Job } from '../types';
import { tx, type UiLang } from '../i18n';

interface DeleteQueueModalProps {
  job: Job | null;
  isDeleting: boolean;
  onCancel: () => void;
  onConfirmDelete: (jobId: string, deleteFiles: boolean) => Promise<void> | void;
  lang?: UiLang;
}

export const DeleteQueueModal: React.FC<DeleteQueueModalProps> = ({
  job,
  isDeleting,
  onCancel,
  onConfirmDelete,
  lang = 'en',
}) => {
  if (!job) return null;

  const isCompleted = job.status === 'completed';

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-xl bg-[#121215] border border-zinc-800 shadow-2xl overflow-hidden">
        <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-2 text-rose-400">
            <Trash2 className="w-4 h-4" />
            <h3 className="text-sm font-semibold text-zinc-100">
              {tx(lang, 'Remove PO from Queue', 'ลบใบสั่งซื้อออกจากคิว')}
            </h3>
          </div>
          <button
            type="button"
            disabled={isDeleting}
            onClick={onCancel}
            className="text-zinc-400 hover:text-zinc-200 disabled:opacity-50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3 text-xs">
          <div className="p-3 rounded-lg bg-zinc-900 border border-zinc-800 space-y-1">
            <div className="font-semibold text-zinc-100">
              {job.po_number || job.po_folder_name}
            </div>
            <div className="text-[11px] text-zinc-400 font-mono truncate">
              {job.po_folder_name}
            </div>
            {job.matched_company_name && (
              <div className="text-[11px] text-emerald-300 truncate">
                {job.matched_company_name}
              </div>
            )}
          </div>

          {isCompleted && (
            <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-200 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <span>
                {tx(
                  lang,
                  'This PO was already sent. Removing it from the queue preserves Sent History & duplicate-send protection records.',
                  'ใบ PO นี้ถูกส่งอีเมลไปแล้ว การลบออกจากคิวจะยังคงบันทึกประวัติใน Sent History เพื่อป้องกันการส่งซ้ำไว้'
                )}
              </span>
            </div>
          )}

          <p className="text-zinc-400 leading-relaxed">
            {tx(
              lang,
              'Choose whether to remove only the queue entry in the database or also delete the PO folder inside Incoming / Processing / Review / Failed:',
              'เลือกว่าต้องการลบเฉพาะรายการในคิว หรือลบโฟลเดอร์ไฟล์ PO ออกจากโฟลเดอร์งาน (Incoming / Processing / Review / Failed) ด้วย:'
            )}
          </p>

          <div className="space-y-2 pt-1">
            <button
              type="button"
              disabled={isDeleting}
              onClick={() => onConfirmDelete(job.id, true)}
              className="w-full px-3.5 py-2.5 rounded-lg bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white font-semibold flex items-center justify-center gap-2 transition-colors"
            >
              <FolderX className="w-4 h-4" />
              <span>
                {isDeleting
                  ? tx(lang, 'Removing...', 'กำลังลบ...')
                  : tx(lang, 'Delete Queue & PO Folder Files', 'ลบคิวและลบโฟลเดอร์ไฟล์ PO ทั้งหมด')}
              </span>
            </button>

            <button
              type="button"
              disabled={isDeleting}
              onClick={() => onConfirmDelete(job.id, false)}
              className="w-full px-3.5 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 border border-zinc-700 text-zinc-200 font-medium flex items-center justify-center gap-2 transition-colors"
            >
              <Database className="w-3.5 h-3.5 text-zinc-400" />
              <span>
                {tx(lang, 'Remove Queue Entry Only (Keep Files)', 'ลบเฉพาะรายการในคิว (เก็บไฟล์ในเครื่องไว้)')}
              </span>
            </button>

            <button
              type="button"
              disabled={isDeleting}
              onClick={onCancel}
              className="w-full px-3.5 py-2 rounded-lg bg-transparent hover:bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-zinc-200 font-medium transition-colors"
            >
              {tx(lang, 'Cancel', 'ยกเลิก')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
