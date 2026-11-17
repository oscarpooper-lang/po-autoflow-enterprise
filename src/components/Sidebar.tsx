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
} from 'lucide-react';
import { checkGitHubUpdate, installGitHubUpdate, type GitHubUpdateStatus } from '../services/tauri';

interface SidebarProps {
  currentTab: string;
  onSelectTab: (tab: string) => void;
  isMonitoringActive: boolean;
  rootDir?: string;
  needsReviewCount?: number;
  companiesCount?: number;
  developerMode?: boolean;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentTab,
  onSelectTab,
  isMonitoringActive,
  rootDir = 'C:\\PO-AutoFlow',
  needsReviewCount = 0,
  companiesCount = 0,
  developerMode = false,
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
          status.update_available ? `v${status.latest_version} available` : 'Up to date'
        );
      }
    } catch {
      if (!silent) {
        setUpdateMsg('GitHub check failed');
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
    setUpdateMsg('Downloading update...');
    try {
      await installGitHubUpdate(
        updateStatus.installer_url,
        updateStatus.installer_name || undefined
      );
      setUpdateMsg('Installer launched');
    } catch (err: any) {
      setUpdateMsg(typeof err === 'string' ? err : err?.message || 'Install failed');
    } finally {
      setInstallingUpdate(false);
    }
  };
  const navItems = [
    {
      id: 'overview',
      label: 'PO Workspace',
      icon: Inbox,
      badge: needsReviewCount > 0 ? String(needsReviewCount) : undefined,
      badgeTone: 'amber' as const,
    },
    { id: 'ocr-inspector', label: 'Document Viewer', icon: FileSearch },
    {
      id: 'directory',
      label: 'Suppliers',
      icon: Building2,
      badge: companiesCount > 0 ? String(companiesCount) : undefined,
      badgeTone: 'neutral' as const,
    },
    { id: 'transactions', label: 'Sent History', icon: History },
    ...(developerMode
      ? [
          { id: 'benchmark', label: 'Model Benchmark', icon: Gauge },
          { id: 'developer-options', label: 'Terminal & Debug', icon: Terminal },
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
          <h1 className="text-sm font-semibold text-zinc-100 truncate">PO AutoFlow</h1>
          <p className="text-[11px] text-zinc-400 truncate">Purchase Order Mailer</p>
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
                  className={`text-[11px] font-mono px-1.5 py-0.5 rounded-md ${
                    item.badgeTone === 'amber'
                      ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
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
          <span>Settings</span>
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
          <span>Quick Setup Guide</span>
        </button>

        {/* Compact App Version & GitHub Updates Pill */}
        <div className="mt-2 px-3 py-2 rounded-lg bg-zinc-900/90 border border-zinc-800/80 space-y-1.5 text-[11px]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-zinc-300 font-medium truncate">
              App v{updateStatus?.current_version || '1.0.0'}
            </span>
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={() => runUpdateCheck(false)}
                disabled={checkingUpdate || installingUpdate}
                className="px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white border border-zinc-700 flex items-center gap-1 transition-colors disabled:opacity-50"
                title="Check GitHub Releases for updates"
              >
                <RefreshCw className={`w-2.5 h-2.5 ${checkingUpdate ? 'animate-spin' : ''}`} />
                <span>Check Update</span>
              </button>
              <a
                href={
                  updateStatus?.release_url ||
                  'https://github.com/oscarpooper-lang/po-autoflow-enterprise/releases'
                }
                target="_blank"
                rel="noopener noreferrer"
                className="p-0.5 text-zinc-500 hover:text-zinc-200 transition-colors"
                title="View releases on GitHub"
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
                {installingUpdate ? 'Downloading...' : `Update to v${updateStatus.latest_version}`}
              </span>
            </button>
          ) : updateMsg ? (
            <p className="text-[10px] text-zinc-400 truncate">{updateMsg}</p>
          ) : null}
        </div>

        <div
          className="px-3 py-2 rounded-lg bg-zinc-900/90 border border-zinc-800/80 flex items-center justify-between text-[11px]"
          title={`Workspace folder: ${rootDir}`}
        >
          <span className="flex items-center gap-1.5 text-zinc-300">
            <span
              className={`w-2 h-2 rounded-full ${
                isMonitoringActive ? 'bg-emerald-500' : 'bg-zinc-500'
              }`}
            />
            {isMonitoringActive ? 'Watcher On' : 'Watcher Paused'}
          </span>
          <span className="text-zinc-500 font-mono">
            v{updateStatus?.current_version || '1.0.0'}
          </span>
        </div>
      </div>
    </aside>
  );
};
