import React, { useState } from 'react';
import { usePersistedState } from '../utils/persistedState';
import {
  FileText,
  Search,
  Filter,
  Download,
  CheckCircle2,
  AlertCircle,
  Copy,
  ShieldCheck,
  Calendar
} from 'lucide-react';
import type { PoTransaction } from '../types';
import { tr, tx, type UiLang } from '../i18n';

interface TransactionsProps {
  transactions: PoTransaction[];
  onSelectTransaction?: (txId: string) => void;
  lang?: UiLang;
}

export const Transactions: React.FC<TransactionsProps> = ({ transactions = [], lang = 'en' }) => {
  const [searchTerm, setSearchTerm] = usePersistedState('transactions.searchTerm', '');
  const [statusFilter, setStatusFilter] = usePersistedState('transactions.statusFilter', 'all');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const filtered = transactions.filter((tx) => {
    if (statusFilter !== 'all' && tx.status !== statusFilter) {
      return false;
    }
    if (searchTerm.trim()) {
      const q = searchTerm.toLowerCase();
      return (
        tx.po_number.toLowerCase().includes(q) ||
        tx.company_name.toLowerCase().includes(q) ||
        tx.recipient_email.toLowerCase().includes(q) ||
        tx.archive_sha256.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const escapeCsvCell = (raw: string) => {
    const val = String(raw || '');
    const neutralized = /^[=+\-@\t\r]/.test(val) ? `'${val}` : val;
    return `"${neutralized.replace(/"/g, '""')}"`;
  };

  const handleExportCsv = () => {
    const headers = ['Transaction ID', 'PO Number', 'Company Name', 'Recipient Email', 'Status', 'Sent At', 'SHA256'];
    const rows = filtered.map((tx) => [
      escapeCsvCell(tx.id),
      escapeCsvCell(tx.po_number),
      escapeCsvCell(tx.company_name),
      escapeCsvCell(tx.recipient_email),
      escapeCsvCell(tx.status),
      escapeCsvCell(tx.sent_at),
      escapeCsvCell(tx.archive_sha256),
    ]);

    const csvBody = '\uFEFF' + [headers.join(','), ...rows.map((e) => e.join(','))].join('\n');
    const blob = new Blob([csvBody], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `po_transactions_export_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Top Controls */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-bold text-white flex items-center gap-2">
            <FileText className="w-5 h-5 text-blue-400" />
            {tr(lang, 'txHeading')}
          </h2>
          <p className="text-xs text-zinc-400">
            {tr(lang, 'txSub')}
          </p>
        </div>

        <button
          onClick={handleExportCsv}
          className="px-3.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 text-xs font-semibold transition-colors flex items-center space-x-1.5 shadow-sm"
        >
          <Download className="w-4 h-4 text-blue-400" />
          <span>{tr(lang, 'exportCsv')}</span>
        </button>
      </div>

      {/* Filter and Search Bar */}
      <div className="p-4 rounded-xl bg-[#121215] border border-zinc-800 flex flex-wrap items-center justify-between gap-3 shadow-sm">
        <div className="flex items-center space-x-3">
          <div className="flex items-center space-x-1.5 text-xs text-zinc-400">
            <Filter className="w-4 h-4" />
            <span>{tr(lang, 'filterStatus')}</span>
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded-lg px-2.5 py-1.5 font-medium"
          >
            <option value="all">{tx(lang, 'All Transactions', 'รายการทั้งหมด')}</option>
            <option value="sent">{tx(lang, 'Sent / Delivered', 'ส่งสำเร็จแล้ว')}</option>
            <option value="accepted">{tx(lang, 'Accepted by GAS', 'Apps Script รับงานแล้ว')}</option>
            <option value="blocked_duplicate">{tx(lang, 'Duplicate Blocked', 'ป้องกันการส่งซ้ำ')}</option>
            <option value="failed">{tx(lang, 'Failed Delivery', 'ส่งไม่สำเร็จ')}</option>
          </select>
        </div>

        <div className="relative">
          <Search className="w-4 h-4 text-zinc-400 absolute left-3 top-2.5" />
          <input
            type="text"
            placeholder={tx(
              lang,
              'Search PO#, Company, Recipient or SHA-256...',
              'ค้นหาเลขที่ PO, ชื่อผู้ขาย, อีเมล หรือ SHA-256...'
            )}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded-lg pl-9 pr-3 py-2 w-80 focus:ring-1 focus:ring-blue-500 placeholder-zinc-500 font-medium"
          />
        </div>
      </div>

      {/* Transactions Grid */}
      <div className="rounded-xl bg-[#121215] border border-zinc-800 overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-zinc-950/70 text-zinc-400 font-semibold border-b border-zinc-800">
              <tr>
                <th className="py-3 px-4">{tx(lang, 'PO Number', 'เลขที่ PO')}</th>
                <th className="py-3 px-4">{tx(lang, 'Recipient & Company', 'ผู้ขายและอีเมลผู้รับ')}</th>
                <th className="py-3 px-4">{tx(lang, 'Delivery Status', 'สถานะการจัดส่ง')}</th>
                <th className="py-3 px-4">{tx(lang, 'Date Sent', 'วันที่และเวลาที่ส่ง')}</th>
                <th className="py-3 px-4">{tx(lang, 'Archive SHA-256', 'รหัสตรวจสอบไฟล์ SHA-256')}</th>
                <th className="py-3 px-4 text-right">{tx(lang, 'Transaction ID', 'รหัสธุรกรรม')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/70">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-zinc-500">
                    {tx(
                      lang,
                      'No transactions recorded matching the selected filter.',
                      'ยังไม่มีประวัติรายการที่ตรงกับเงื่อนไขการค้นหา'
                    )}
                  </td>
                </tr>
              ) : (
                filtered.map((item) => (
                  <tr key={item.id} className="hover:bg-zinc-900/50 transition-colors">
                    <td className="py-3.5 px-4">
                      <div className="font-bold text-white text-sm tracking-tight">{item.po_number}</div>
                      <div className="text-[10px] text-zinc-500 font-mono mt-0.5">
                        {tx(lang, 'Fingerprint:', 'ลายนิ้วมือโฟลเดอร์:')} {item.folder_fingerprint.slice(0, 12)}...
                      </div>
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="font-medium text-zinc-200 truncate max-w-[240px]">
                        {item.company_name}
                      </div>
                      <div className="text-[11px] text-blue-400 truncate max-w-[240px]">
                        {item.recipient_email}
                      </div>
                    </td>
                    <td className="py-3.5 px-4">
                      {item.status === 'sent' || item.status === 'confirmed_delivery' ? (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          {tx(lang, 'Delivered', 'ส่งสำเร็จ')}
                        </span>
                      ) : item.status === 'blocked_duplicate' ? (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20">
                          <ShieldCheck className="w-3.5 h-3.5" />
                          {tx(lang, 'Duplicate Blocked', 'ป้องกันการส่งซ้ำ')}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/20">
                          <AlertCircle className="w-3.5 h-3.5" />
                          {item.status}
                        </span>
                      )}
                    </td>
                    <td className="py-3.5 px-4 text-zinc-300 font-mono text-[11px]">
                      <div className="flex items-center gap-1">
                        <Calendar className="w-3.5 h-3.5 text-zinc-500" />
                        {new Date(item.sent_at).toLocaleDateString()}
                      </div>
                      <div className="text-zinc-500 text-[10px] pl-4.5">
                        {new Date(item.sent_at).toLocaleTimeString()}
                      </div>
                    </td>
                    <td className="py-3.5 px-4 font-mono text-[11px] text-zinc-400">
                      <div className="flex items-center space-x-1.5">
                        <span>{item.archive_sha256.slice(0, 16)}...</span>
                        <button
                          onClick={() => handleCopy(item.archive_sha256, item.id)}
                          className="p-1 hover:bg-zinc-800 rounded text-zinc-500 hover:text-zinc-300"
                          title={tx(lang, 'Copy SHA-256', 'คัดลอก SHA-256')}
                        >
                          <Copy className="w-3 h-3" />
                        </button>
                      </div>
                      {copiedId === item.id && (
                        <span className="text-[10px] text-emerald-400">
                          {tx(lang, 'Copied!', 'คัดลอกแล้ว!')}
                        </span>
                      )}
                    </td>
                    <td className="py-3.5 px-4 text-right font-mono text-[11px] text-zinc-500">
                      {item.id.slice(0, 8)}...
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

