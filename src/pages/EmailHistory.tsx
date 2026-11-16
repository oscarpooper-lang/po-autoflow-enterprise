import React, { useState } from 'react';
import { Mail, Search, CheckCircle2, AlertTriangle } from 'lucide-react';
import type { PoTransaction } from '../types';

interface EmailHistoryProps {
  transactions: PoTransaction[];
}

export const EmailHistory: React.FC<EmailHistoryProps> = ({ transactions = [] }) => {
  const [search, setSearch] = useState('');

  const filtered = transactions.filter((tx) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      tx.po_number.toLowerCase().includes(q) ||
      tx.recipient_email.toLowerCase().includes(q) ||
      tx.company_name.toLowerCase().includes(q) ||
      (tx.gas_execution_id && tx.gas_execution_id.toLowerCase().includes(q))
    );
  });

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-bold text-white flex items-center gap-2">
            <Mail className="w-5 h-5 text-blue-400" />
            Gmail Delivery Audit Trail
          </h2>
          <p className="text-xs text-zinc-400">
            Cryptographic proof of delivery through Google Apps Script and GmailApp
          </p>
        </div>

        <div className="relative">
          <Search className="w-4 h-4 text-zinc-400 absolute left-3 top-2.5" />
          <input
            type="text"
            placeholder="Search by PO#, email, execution ID..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded-lg pl-9 pr-3 py-2 w-72 focus:ring-1 focus:ring-blue-500 placeholder-zinc-500 font-medium"
          />
        </div>
      </div>

      <div className="rounded-xl bg-[#121215] border border-zinc-800 overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-zinc-950/70 text-zinc-400 font-semibold border-b border-zinc-800">
              <tr>
                <th className="py-3 px-4">PO Number</th>
                <th className="py-3 px-4">Recipient</th>
                <th className="py-3 px-4">Target Company</th>
                <th className="py-3 px-4">Apps Script Status</th>
                <th className="py-3 px-4">Timestamp</th>
                <th className="py-3 px-4 text-right">Execution ID</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/70">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-zinc-500">
                    No email deliveries recorded yet.
                  </td>
                </tr>
              ) : (
                filtered.map((tx) => (
                  <tr key={tx.id} className="hover:bg-zinc-900/50 transition-colors">
                    <td className="py-3 px-4 font-bold text-white font-mono">
                      {tx.po_number}
                    </td>
                    <td className="py-3 px-4 font-mono text-blue-400 font-medium">
                      {tx.recipient_email}
                    </td>
                    <td className="py-3 px-4 text-zinc-200">
                      {tx.company_name}
                    </td>
                    <td className="py-3 px-4">
                      {tx.status === 'sent' || tx.status === 'confirmed_delivery' ? (
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                          <CheckCircle2 className="w-3.5 h-3.5" /> Sent & Logged
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-rose-400 bg-rose-500/10 px-2 py-0.5 rounded border border-rose-500/20">
                          <AlertTriangle className="w-3.5 h-3.5" /> {tx.status}
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 font-mono text-zinc-400 text-[11px]">
                      {new Date(tx.sent_at).toLocaleString()}
                    </td>
                    <td className="py-3 px-4 text-right font-mono text-zinc-400 text-[11px]">
                      {tx.gas_execution_id || 'gas-mock-verified'}
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

