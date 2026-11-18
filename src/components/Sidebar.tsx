import React, { useState, useEffect } from 'react';
import {
  Inbox,
  FileSearch,
  Building2,
  History,
  Terminal,
  Settings as SettingsIcon,
  HelpCircle,
  Send,
  RefreshCw,
  Download,
  ExternalLink,
  Gauge,
  Sparkles,
} from 'lucide-react';
import { checkGitHubUpdate, installGitHubUpdate, type GitHubUpdateStatus } from '../services/tauri';
import { tr, tx, type UiLang } from '../i18n';

interface SidebarProps {
  currentTab: string;
  onSelectTab: (tab: string) => void;
  isMonitoringActive: boolean;
  rootDir?: string;
  needsReviewCount?: number;
  companiesCount?: number;
  developerMode?: boolean;
  aiSending?: boolean;
  aiUnread?: boolean;
  lang?: UiLang;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentTab,
  onSelectTab,
  isMonitoringActive,
  rootDir = 'C:\\PO-AutoFlow',
  needsReviewCount = 0,
  companiesCount = 0,
  developerMode = false,
  aiSending = false,
  aiUnread = false,
  lang = 'en',
}) => {
  const [updateStatus, setUpdateStatus] = useState<GitHubUpdateStatus | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);

  const runUpdateCheck = async (silent = false) => {
    if (!silent) {
      setCheckingUpdate(true);
      setUpdateMsg(null);
    }
    try {
      const status = await checkGitHubUpdate();
      setUpdateStatus(status);
      if (!silent) {
        setUpdateMsg(
          status.update_available
            ? tx(lang, `v${status.latest_version} available`, `มีเวอร์ชันใหม่ v${status.latest_version}`)
            : tr(lang, 'upToDate')
        );
      }
    } catch {
      if (!silent) {
        setUpdateMsg(tx(lang, 'GitHub check failed', 'เช็คอัปเดตไม่สำเร็จ'));
      }
    } finally {
      if (!silent) {
        setCheckingUpdate(false);
      }
    }
  };

  useEffect(() => {
    let cancelled = false;
    checkGitHubUpdate()
      .then((status) => {
        if (!cancelled) {
          setUpdateStatus(status);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const handleInstallUpdate = async () => {
    if (!updateStatus?.installer_url) {
      if (updateStatus?.release_url) {
        window.open(updateStatus.release_url, '_blank', 'noopener,noreferrer');
      }
      return;
    }
    setInstallingUpdate(true);
    setUpdateMsg(tx(lang, 'Downloading update...', 'กำลังดาวน์โหลดอัปเดต...'));
    try {
      await installGitHubUpdate(
        updateStatus.installer_url,
        updateStatus.installer_name || undefined
      );
      setUpdateMsg(tx(lang, 'Installer launched', 'เปิดตัวติดตั้งแล้ว'));
    } catch (err: any) {
      setUpdateMsg(
        typeof err === 'string' ? err : err?.message || tx(lang, 'Install failed', 'ติดตั้งไม่สำเร็จ')
      );
    } finally {
      setInstallingUpdate(false);
    }
  };
  const navItems: Array<{
    id: string;
    label: string;
    icon: typeof Inbox;
    badge?: string;
    badgeTone?: 'amber' | 'neutral' | 'purple' | 'emerald';
    pulse?: boolean;
  }> = [
    {
      id: 'overview',
      label: tr(lang, 'navOverview'),
      icon: Inbox,
      badge: needsReviewCount > 0 ? String(needsReviewCount) : undefined,
      badgeTone: 'amber',
    },
    { id: 'ocr-inspector', label: tr(lang, 'navInspector'), icon: FileSearch },
    {
      id: 'assistant',
      label: tr(lang, 'navAssistant'),
      icon: Sparkles,
      badge: aiSending
        ? tx(lang, 'Thinking...', 'กำลังคิด...')
        : aiUnread
        ? tx(lang, 'New', 'ตอบแล้ว')
        : undefined,
      badgeTone: aiSending ? 'purple' : 'emerald',
      pulse: aiSending,
    },
    {
      id: 'directory',
      label: tr(lang, 'navDirectory'),
      icon: Building2,
      badge: companiesCount > 0 ? String(companiesCount) : undefined,
      badgeTone: 'neutral',
    },
    { id: 'transactions', label: tr(lang, 'navTransactions'), icon: History },
    ...(developerMode
      ? [
          { id: 'benchmark', label: tr(lang, 'navBenchmark'), icon: Gauge },
          { id: 'developer-options', label: tr(lang, 'navDev'), icon: Terminal },
        ]
      : []),
  ];

  return (
    <aside className="w-60 bg-[#121215] border-r border-zinc-800 flex flex-col h-screen select-none shrink-0">
      {/* Brand Header */}
      <div className="h-16 px-4 border-b border-zinc-800 flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center shrink-0">
          <Send className="w-4 h-4 text-white" />
        </div>
        <div className="min-w-0">
          <h1 className="text-sm font-semibold text-zinc-100 truncate">{tr(lang, 'brandTitle')}</h1>
          <p className="text-[11px] text-zinc-400 truncate">{tr(lang, 'brandSub')}</p>
        </div>
      </div>

      {/* Main Navigation */}
      <nav className="flex-1 px-2.5 py-4 space-y-1 overflow-y-auto">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = currentTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectTab(item.id)}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-[13px] transition-colors ${
                isActive
                  ? 'bg-zinc-800 text-white font-medium'
                  : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/50'
              }`}
            >
              <span className="flex items-center gap-2.5 min-w-0">
                <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-blue-400' : 'text-zinc-500'}`} />
                <span className="truncate">{item.label}</span>
              </span>
              {item.badge && (
                <span
                  className={`text-[10px] font-mono px-1.5 py-0.5 rounded-md ${
                    item.pulse ? 'animate-pulse ' : ''
                  }${
                    item.badgeTone === 'amber'
                      ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                      : item.badgeTone === 'purple'
                      ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40'
                      : item.badgeTone === 'emerald'
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                      : 'bg-zinc-800 text-zinc-400 border border-zinc-700'
                  }`}
                >
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Bottom Configuration & Status */}
      <div className="p-2.5 border-t border-zinc-800 space-y-1">
        <button
          type="button"
          onClick={() => onSelectTab('settings')}
          className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] transition-colors ${
            currentTab === 'settings'
              ? 'bg-zinc-800 text-white font-medium'
              : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/50'
          }`}
        >
          <SettingsIcon className={`w-4 h-4 ${currentTab === 'settings' ? 'text-blue-400' : 'text-zinc-500'}`} />
          <span>{tr(lang, 'navSettings')}</span>
        </button>

        <button
          type="button"
          onClick={() => onSelectTab('setup-wizard')}
          className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] transition-colors ${
            currentTab === 'setup-wizard'
              ? 'bg-zinc-800 text-white font-medium'
              : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/50'
          }`}
        >
          <HelpCircle className={`w-4 h-4 ${currentTab === 'setup-wizard' ? 'text-blue-400' : 'text-zinc-500'}`} />
          <span>{tr(lang, 'navSetup')}</span>
        </button>

        {/* Compact App Version & GitHub Updates Pill */}
        <div className="mt-2 px-3 py-2 rounded-lg bg-zinc-900/90 border border-zinc-800/80 space-y-1.5 text-[11px]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-zinc-300 font-medium truncate">
              v{updateStatus?.current_version || '1.0.0'}
            </span>
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={() => runUpdateCheck(false)}
                disabled={checkingUpdate || installingUpdate}
                className="px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white border border-zinc-700 flex items-center gap-1 transition-colors disabled:opacity-50"
                title={tx(lang, 'Check GitHub Releases for updates', 'เช็คอัปเดตเวอร์ชันใหม่บน GitHub')}
              >
                <RefreshCw className={`w-2.5 h-2.5 ${checkingUpdate ? 'animate-spin' : ''}`} />
                <span>{tr(lang, 'checkUpdate')}</span>
              </button>
              <a
                href={
                  updateStatus?.release_url ||
                  'https://github.com/oscarpooper-lang/po-autoflow-enterprise/releases'
                }
                target="_blank"
                rel="noopener noreferrer"
                className="p-0.5 text-zinc-500 hover:text-zinc-200 transition-colors"
                title={tx(lang, 'View releases on GitHub', 'ดูหน้ารีลีสบน GitHub')}
              >
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          </div>

          {updateStatus?.update_available ? (
            <button
              type="button"
              onClick={handleInstallUpdate}
              disabled={installingUpdate}
              className="w-full px-2 py-1.5 rounded-md bg-blue-600 hover:bg-blue-500 text-white font-medium flex items-center justify-center gap-1.5 transition-colors disabled:opacity-60"
            >
              <Download className="w-3 h-3 shrink-0" />
              <span className="truncate">
                {installingUpdate
                  ? tx(lang, 'Downloading...', 'กำลังดาวน์โหลด...')
                  : tx(lang, `Update to v${updateStatus.latest_version}`, `อัปเดตเป็น v${updateStatus.latest_version}`)}
              </span>
            </button>
          ) : updateMsg ? (
            <p className="text-[10px] text-zinc-400 truncate">{updateMsg}</p>
          ) : null}
        </div>

        <div
          className="px-3 py-2 rounded-lg bg-zinc-900/90 border border-zinc-800/80 flex items-center justify-between text-[11px]"
          title={`${tx(lang, 'Workspace folder:', 'โฟลเดอร์ทำงาน:')} ${rootDir}`}
        >
          <span className="flex items-center gap-1.5 text-zinc-300">
            <span
              className={`w-2 h-2 rounded-full ${
                isMonitoringActive ? 'bg-emerald-500' : 'bg-zinc-500'
              }`}
            />
            {isMonitoringActive ? tr(lang, 'watcherOn') : tr(lang, 'watcherPaused')}
          </span>
          <span className="text-zinc-500 font-mono">
            v{updateStatus?.current_version || '1.0.0'}
          </span>
        </div>
      </div>
    </aside>
  );
};
