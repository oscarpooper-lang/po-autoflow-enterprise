import React, { useState } from 'react';
import {
  Play,
  Pause,
  RefreshCw,
  LogOut,
  Minimize2,
  ShieldCheck,
} from 'lucide-react';
import type { AppSettings, GoogleAccountInfo } from '../types';
import { api } from '../services/tauri';

interface HeaderProps {
  title: string;
  subtitle?: string;
  incomingDir?: string;
  settings?: AppSettings;
  onSaveSettings?: (newSettings: AppSettings) => Promise<void>;
  isMonitoringActive: boolean;
  onToggleMonitoring: () => void;
  onRefreshData?: () => void;
  isRefreshing?: boolean;
  googleAccount?: GoogleAccountInfo | null;
  onGoogleLogin?: () => void;
  onGoogleLogout?: () => void;
  isLoggingIn?: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  title,
  subtitle,
  settings,
  onSaveSettings,
  isMonitoringActive,
  onToggleMonitoring,
  onRefreshData,
  isRefreshing,
  googleAccount,
  onGoogleLogin,
  onGoogleLogout,
  isLoggingIn,
}) => {
  const [showProfileMenu, setShowProfileMenu] = useState(false);

  const currentAutoSendKey: 'verified_and_high' | 'verified_only' | 'manual_review_all' =
    !settings || settings.auto_send_email_enabled === false || settings.auto_send_mode === 'manual_review_all'
      ? settings?.auto_send_email_enabled === false || settings?.auto_send_mode === 'manual_review_all'
        ? 'manual_review_all'
        : 'verified_and_high'
      : settings.auto_send_mode || 'verified_and_high';

  const handleAutoSendChange = async (mode: 'verified_and_high' | 'verified_only' | 'manual_review_all') => {
    if (!settings || !onSaveSettings) return;
    await onSaveSettings({
      ...settings,
      auto_send_email_enabled: mode !== 'manual_review_all',
      auto_send_mode: mode,
    });
  };

  return (
    <header className="h-16 bg-[#121215] border-b border-zinc-800 px-6 flex items-center justify-between gap-4 shrink-0 z-10">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-zinc-100 truncate">{title}</h2>
        {subtitle && <p className="text-xs text-zinc-400 truncate">{subtitle}</p>}
      </div>

      <div className="flex items-center gap-2.5 shrink-0">
        {/* Auto-Send Segmented Policy Control */}
        {settings && onSaveSettings && (
          <div
            className="hidden lg:flex items-center bg-zinc-900 border border-zinc-800 rounded-lg p-0.5 text-xs"
            title="Choose whether PO emails ask for approval first or send automatically"
          >
            {(
              [
                { id: 'manual_review_all', label: 'Ask First' },
                { id: 'verified_and_high', label: 'Auto ≥90%' },
                { id: 'verified_only', label: 'Strict ≥98%' },
              ] as const
            ).map((opt) => {
              const active = currentAutoSendKey === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => handleAutoSendChange(opt.id)}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                    active
                      ? opt.id === 'manual_review_all'
                        ? 'bg-amber-500/20 text-amber-300'
                        : 'bg-blue-600 text-white'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        )}

        {/* Folder Watcher Toggle */}
        <button
          type="button"
          onClick={onToggleMonitoring}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
            isMonitoringActive
              ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/15'
              : 'bg-zinc-900 text-zinc-200 border-zinc-700 hover:bg-zinc-800'
          }`}
        >
          {isMonitoringActive ? (
            <>
              <Pause className="w-3.5 h-3.5" />
              <span>Watching</span>
            </>
          ) : (
            <>
              <Play className="w-3.5 h-3.5" />
              <span>Start Watching</span>
            </>
          )}
        </button>

        {/* Minimize to Tray */}
        <button
          type="button"
          onClick={() => api.minimizeToTray()}
          title="Hide to Windows System Tray — folder watching continues in the background"
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-xs font-medium text-zinc-300 transition-colors"
        >
          <Minimize2 className="w-3.5 h-3.5 text-zinc-400" />
          <span className="hidden xl:inline">Tray</span>
        </button>

        {/* Google Account */}
        <div className="relative">
          {googleAccount ? (
            <div>
              <button
                type="button"
                onClick={() => setShowProfileMenu((v) => !v)}
                className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-xs text-zinc-200 transition-colors"
                title={googleAccount.email}
              >
                <span className="w-2 h-2 rounded-full bg-emerald-500" />
                <span className="max-w-[120px] truncate font-medium">
                  {googleAccount.name || googleAccount.email}
                </span>
              </button>

              {showProfileMenu && (
                <div className="absolute right-0 mt-2 w-60 bg-[#18181b] border border-zinc-800 rounded-xl shadow-xl p-3 z-50 text-xs space-y-2.5">
                  <div className="pb-2 border-b border-zinc-800">
                    <p className="font-semibold text-zinc-100 truncate">
                      {googleAccount.name || 'Connected Google Account'}
                    </p>
                    <p className="text-zinc-400 truncate">{googleAccount.email}</p>
                  </div>
                  <div className="flex items-center gap-1.5 text-emerald-400 text-[11px]">
                    <ShieldCheck className="w-3.5 h-3.5" />
                    <span>Google Cloud connected</span>
                  </div>
                  {onGoogleLogout && (
                    <button
                      type="button"
                      onClick={() => {
                        setShowProfileMenu(false);
                        onGoogleLogout();
                      }}
                      className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/20 font-medium"
                    >
                      <LogOut className="w-3.5 h-3.5" />
                      <span>Disconnect</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : (
            onGoogleLogin && (
              <button
                type="button"
                onClick={onGoogleLogin}
                disabled={isLoggingIn}
                className="px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-xs font-medium text-zinc-200 transition-colors"
              >
                {isLoggingIn ? 'Connecting...' : 'Connect Google'}
              </button>
            )
          )}
        </div>

        {/* Refresh */}
        {onRefreshData && (
          <button
            type="button"
            onClick={onRefreshData}
            disabled={isRefreshing}
            className="p-2 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded-lg transition-colors border border-zinc-800"
            title="Refresh"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin text-blue-400' : ''}`} />
          </button>
        )}
      </div>
    </header>
  );
};
