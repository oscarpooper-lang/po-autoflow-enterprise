import React, { useState } from 'react';
import {
  Building2,
  RefreshCw,
  Search,
  Plus,
  BookmarkPlus,
  CheckCircle2,
  XCircle,
  Trash2,
} from 'lucide-react';
import type { CompanyCacheEntry, CompanyAlias } from '../types';
import { api } from '../services/tauri';
import { tr, tx, type UiLang } from '../i18n';

interface CompanyDirectoryProps {
  companies: CompanyCacheEntry[];
  aliases: CompanyAlias[];
  onRefreshCompanies: () => void;
  onSyncSheets?: () => void;
  isSyncing: boolean;
  lang?: UiLang;
}

export const CompanyDirectory: React.FC<CompanyDirectoryProps> = ({
  companies = [],
  aliases = [],
  onRefreshCompanies,
  onSyncSheets,
  isSyncing,
  lang = 'en',
}) => {
  const [activeTab, setActiveTab] = useState<'directory' | 'aliases'>('directory');
  const [searchQuery, setSearchQuery] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newAlias, setNewAlias] = useState('');
  const [newCanonical, setNewCanonical] = useState(companies[0]?.company_name || '');
  const [deletingAliasId, setDeletingAliasId] = useState<string | null>(null);

  const effectiveCanonical = newCanonical || companies[0]?.company_name || '';

  const filteredCompanies = companies.filter((c) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      c.company_name.toLowerCase().includes(q) ||
      (c.alternative_name && c.alternative_name.toLowerCase().includes(q)) ||
      c.email.toLowerCase().includes(q)
    );
  });

  const filteredAliases = aliases.filter((a) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      a.alias.toLowerCase().includes(q) ||
      a.canonical_company_name.toLowerCase().includes(q)
    );
  });

  const handleCreateAlias = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAlias.trim() || !effectiveCanonical) return;
    try {
      await api.addCompanyAlias(newAlias.trim(), effectiveCanonical);
      setNewAlias('');
      setIsModalOpen(false);
      onRefreshCompanies();
    } catch (err) {
      console.error(err);
    }
  };

  const handleDeleteAlias = async (id: string) => {
    setDeletingAliasId(id);
    try {
      await api.deleteCompanyAlias(id);
      onRefreshCompanies();
    } catch (err) {
      console.error('Failed to delete alias:', err);
    } finally {
      setDeletingAliasId(null);
    }
  };

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header & Controls */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-bold text-white flex items-center gap-2">
            <Building2 className="w-5 h-5 text-blue-400" />
            {tr(lang, 'dirHeading')}
          </h2>
          <p className="text-xs text-zinc-400">
            {tr(lang, 'dirSub')}
          </p>
        </div>

        <div className="flex items-center space-x-3">
          <button
            onClick={() => setIsModalOpen(true)}
            className="px-3.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 text-xs font-semibold transition-colors flex items-center space-x-1.5 shadow-sm"
          >
            <Plus className="w-4 h-4 text-blue-400" />
            <span>{tr(lang, 'addAlias')}</span>
          </button>

          <button
            onClick={onSyncSheets || onRefreshCompanies}
            disabled={isSyncing}
            className="px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold transition-colors flex items-center space-x-1.5 shadow-sm shadow-blue-500/20"
          >
            <RefreshCw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
            <span>{isSyncing ? tr(lang, 'syncing') : tr(lang, 'syncSheet')}</span>
          </button>
        </div>
      </div>

      {/* Tab Switcher & Search Bar */}
      <div className="p-4 rounded-xl bg-[#121215] border border-zinc-800 flex flex-wrap items-center justify-between gap-3 shadow-sm">
        <div className="flex items-center space-x-1 bg-zinc-950 p-1 rounded-lg border border-zinc-800">
          <button
            onClick={() => setActiveTab('directory')}
            className={`px-3 py-1.5 rounded text-xs font-semibold transition-all ${
              activeTab === 'directory'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {tx(lang, 'Google Sheets Directory', 'รายชื่อจาก Google Sheets')} ({companies.length})
          </button>
          <button
            onClick={() => setActiveTab('aliases')}
            className={`px-3 py-1.5 rounded text-xs font-semibold transition-all ${
              activeTab === 'aliases'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {tx(lang, 'Learned Aliases', 'ชื่อเรียกสำรองที่จำไว้')} ({aliases.length})
          </button>
        </div>

        <div className="relative">
          <Search className="w-4 h-4 text-zinc-400 absolute left-3 top-2.5" />
          <input
            type="text"
            placeholder={
              activeTab === 'directory'
                ? tx(lang, 'Search companies or email...', 'ค้นหาชื่อบริษัทหรืออีเมล...')
                : tx(lang, 'Search aliases...', 'ค้นหาชื่อเรียกสำรอง...')
            }
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded-lg pl-9 pr-3 py-2 w-72 focus:ring-1 focus:ring-blue-500 placeholder-zinc-500 font-medium"
          />
        </div>
      </div>

      {/* Content Table */}
      {activeTab === 'directory' ? (
        <div className="rounded-xl bg-[#121215] border border-zinc-800 overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-zinc-950/70 text-zinc-400 font-semibold border-b border-zinc-800">
                <tr>
                  <th className="py-3 px-4">{tx(lang, 'Supplier Name', 'ชื่อผู้ขาย')}</th>
                  <th className="py-3 px-4">{tx(lang, 'English / Alternate Name', 'ชื่ออังกฤษ / ชื่อสำรอง')}</th>
                  <th className="py-3 px-4">{tx(lang, 'Recipient Email', 'อีเมลผู้รับ')}</th>
                  <th className="py-3 px-4">{tx(lang, 'Tax ID', 'เลขผู้เสียภาษี (Tax ID)')}</th>
                  <th className="py-3 px-4">{tx(lang, 'Status', 'สถานะ')}</th>
                  <th className="py-3 px-4 text-right">{tx(lang, 'Synced At', 'วันที่ซิงก์')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/70">
                {filteredCompanies.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-zinc-500">
                      {tx(
                        lang,
                        'No companies found. Click "Sync from Google Sheets" to fetch directory.',
                        'ไม่พบข้อมูลผู้ขาย กรุณากด "ซิงก์ Google Sheet" เพื่อดึงรายชื่อ'
                      )}
                    </td>
                  </tr>
                ) : (
                  filteredCompanies.map((comp) => (
                    <tr key={comp.id} className="hover:bg-zinc-900/50 transition-colors">
                      <td className="py-3 px-4">
                        <span className="font-bold text-white text-xs">{comp.company_name}</span>
                      </td>
                      <td className="py-3 px-4 text-zinc-300">
                        {comp.alternative_name || <span className="text-zinc-600">—</span>}
                      </td>
                      <td className="py-3 px-4 font-mono text-blue-400 font-medium">
                        {comp.email}
                      </td>
                      <td className="py-3 px-4 font-mono text-zinc-400 text-[11px]">
                        {comp.tax_id || <span className="text-zinc-600">—</span>}
                      </td>
                      <td className="py-3 px-4">
                        {comp.active ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-400">
                            <CheckCircle2 className="w-3.5 h-3.5" /> {tx(lang, 'Active', 'ใช้งานอยู่')}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-zinc-500">
                            <XCircle className="w-3.5 h-3.5" /> {tx(lang, 'Inactive', 'ปิดใช้งาน')}
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right text-zinc-500 font-mono text-[11px]">
                        {new Date(comp.synced_at).toLocaleDateString()}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="rounded-xl bg-[#121215] border border-zinc-800 overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-zinc-950/70 text-zinc-400 font-semibold border-b border-zinc-800">
                <tr>
                  <th className="py-3 px-4">{tx(lang, 'Name Found in PDF', 'ชื่อที่พบใน PDF')}</th>
                  <th className="py-3 px-4">{tx(lang, 'Google Sheet Supplier', 'ผู้ขายหลักใน Google Sheet')}</th>
                  <th className="py-3 px-4">{tx(lang, 'Added By', 'บันทึกโดย')}</th>
                  <th className="py-3 px-4 text-right">{tx(lang, 'Date Added', 'วันที่บันทึก')}</th>
                  <th className="py-3 px-4 text-right">{tx(lang, 'Actions', 'จัดการ')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/70">
                {filteredAliases.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-12 text-center text-zinc-500">
                      {tx(
                        lang,
                        'No custom aliases recorded yet. Use the OCR Inspector or "Add Custom Alias" to map irregular OCR strings.',
                        'ยังไม่มีชื่อเรียกสำรอง สามารถเพิ่มได้จากหน้าตรวจเอกสาร หรือกด "เพิ่มชื่อสำรอง"'
                      )}
                    </td>
                  </tr>
                ) : (
                  filteredAliases.map((a) => (
                    <tr key={a.id} className="hover:bg-zinc-900/50 transition-colors">
                      <td className="py-3 px-4">
                        <span className="font-semibold text-amber-300 font-mono">{a.alias}</span>
                      </td>
                      <td className="py-3 px-4">
                        <span className="font-bold text-white">{a.canonical_company_name}</span>
                      </td>
                      <td className="py-3 px-4 text-zinc-400 font-mono text-[11px]">
                        {a.created_by}
                      </td>
                      <td className="py-3 px-4 text-right text-zinc-500 font-mono text-[11px]">
                        {new Date(a.created_at).toLocaleDateString()}
                      </td>
                      <td className="py-3 px-4 text-right">
                        <button
                          type="button"
                          onClick={() => handleDeleteAlias(a.id)}
                          disabled={deletingAliasId === a.id}
                          title={tx(lang, 'Delete alias', 'ลบชื่อเรียกสำรอง')}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20 text-[11px] font-medium disabled:opacity-50"
                        >
                          <Trash2 className="w-3 h-3" />
                          <span>{tx(lang, 'Delete', 'ลบ')}</span>
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Add Alias Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-zinc-950/90 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-[#121215] border border-zinc-800 rounded-xl p-6 w-full max-w-md shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <BookmarkPlus className="w-4 h-4 text-blue-400" />
                {tx(lang, 'Add OCR Alias Mapping', 'เพิ่มการจับคู่ชื่อผู้ขายสำรอง')}
              </h3>
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-zinc-400 hover:text-white text-xs font-bold"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateAlias} className="space-y-4 text-xs">
              <div>
                <label className="text-zinc-300 font-medium block mb-1">
                  {tx(lang, 'OCR Variant or Abbreviation:', 'ชื่อที่อ่านได้จากเอกสาร หรือชื่อย่อ:')}
                </label>
                <input
                  type="text"
                  required
                  placeholder={tx(
                    lang,
                    'e.g. บจก. สยาม ซัพพลาย or Siam Supply Co',
                    'เช่น บจก. สยาม ซัพพลาย หรือ Siam Supply Co'
                  )}
                  value={newAlias}
                  onChange={(e) => setNewAlias(e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 font-medium"
                />
              </div>

              <div>
                <label className="text-zinc-300 font-medium block mb-1">
                  {tx(lang, 'Canonical Company in Google Sheets:', 'จับคู่กับผู้ขายหลักใน Google Sheets:')}
                </label>
                <select
                  value={effectiveCanonical}
                  onChange={(e) => setNewCanonical(e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 font-medium"
                >
                  {companies.map((c) => (
                    <option key={c.id} value={c.company_name}>
                      {c.company_name} ({c.email})
                    </option>
                  ))}
                </select>
              </div>

              <div className="pt-2 flex justify-end space-x-2">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-3.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium"
                >
                  {tx(lang, 'Cancel', 'ยกเลิก')}
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-sm"
                >
                  {tx(lang, 'Save Alias', 'บันทึกชื่อสำรอง')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

