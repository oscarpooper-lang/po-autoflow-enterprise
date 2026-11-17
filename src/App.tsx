import React, { useState, useEffect, useCallback } from 'react';
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { Overview } from './pages/Overview';
import { LiveMonitor } from './pages/LiveMonitor';
import { Transactions } from './pages/Transactions';
import { OcrInspector } from './pages/OcrInspector';
import { CompanyDirectory } from './pages/CompanyDirectory';
import { EmailHistory } from './pages/EmailHistory';
import { Analytics } from './pages/Analytics';
import { Settings } from './pages/Settings';
import { SetupWizard } from './pages/SetupWizard';
import { DeveloperOptions } from './pages/DeveloperOptions';
import { ModelBenchmark } from './pages/ModelBenchmark';
import { ErrorBoundary } from './components/ErrorBoundary';
import { api, defaultSettings } from './services/tauri';
import { resolveUiLang, tr, tx } from './i18n';
import type {
  AppSettings,
  Job,
  PoTransaction,
  CompanyCacheEntry,
  CompanyAlias,
  DashboardStats,
  ApplicationEvent,
  GoogleAccountInfo,
} from './types';

export const App: React.FC = () => {
  const [currentTab, setCurrentTab] = useState<string>('overview');
  const [selectedJobId, setSelectedJobId] = useState<string>('');
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [stats, setStats] = useState<DashboardStats>({
    total_processed: 0,
    successfully_sent: 0,
    waiting_processing: 0,
    needs_review: 0,
    failed_transactions: 0,
    success_rate_percent: 100.0,
    avg_ocr_confidence: 97.5,
  });
  const [jobs, setJobs] = useState<Job[]>([]);
  const [transactions, setTransactions] = useState<PoTransaction[]>([]);
  const [companies, setCompanies] = useState<CompanyCacheEntry[]>([]);
  const [aliases, setAliases] = useState<CompanyAlias[]>([]);
  const [events, setEvents] = useState<ApplicationEvent[]>([]);
  const [googleAccount, setGoogleAccount] = useState<GoogleAccountInfo | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState<boolean>(false);
  const [isMonitoringActive, setIsMonitoringActive] = useState<boolean>(false);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [isSyncingSheets, setIsSyncingSheets] = useState<boolean>(false);
  const [appToast, setAppToast] = useState<{
    type: 'success' | 'error' | 'info';
    message: string;
  } | null>(null);

  const lang = resolveUiLang(settings);

  const showToast = useCallback((type: 'success' | 'error' | 'info', message: string) => {
    setAppToast({ type, message });
  }, []);

  useEffect(() => {
    if (!appToast) return;
    const t = setTimeout(() => setAppToast(null), 5000);
    return () => clearTimeout(t);
  }, [appToast]);

  // Load all initial data from backend with safe decoupled fallbacks
  const loadInitialData = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const results = await Promise.allSettled([
        api.getSettings(),
        api.getDashboardStats(),
        api.listJobs(100),
        api.listTransactions(100),
        api.getCompaniesCache(),
        api.getCompanyAliases(),
        api.getRecentEvents(50),
        api.isMonitoringActive(),
        api.getGoogleAccount(),
      ]);

      if (results[0].status === 'fulfilled' && results[0].value) {
        const loadedSettings = results[0].value;
        setSettings(loadedSettings);
        if (!loadedSettings.setup_completed) {
          setCurrentTab('setup-wizard');
        }
      }
      if (results[1].status === 'fulfilled' && results[1].value) setStats(results[1].value);
      if (results[2].status === 'fulfilled' && results[2].value) setJobs(results[2].value);
      if (results[3].status === 'fulfilled' && results[3].value) setTransactions(results[3].value);
      if (results[4].status === 'fulfilled' && results[4].value) setCompanies(results[4].value);
      if (results[5].status === 'fulfilled' && results[5].value) setAliases(results[5].value);
      if (results[6].status === 'fulfilled' && results[6].value) setEvents(results[6].value);
      if (results[7].status === 'fulfilled') setIsMonitoringActive(results[7].value);
      if (results[8].status === 'fulfilled') setGoogleAccount(results[8].value);
    } catch (e) {
      console.error('Failed to load initial data:', e);
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadInitialData();
  }, [loadInitialData]);

  // Periodic polling for live monitoring and real-time event updates
  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        const results = await Promise.allSettled([
          api.getDashboardStats(),
          api.listJobs(50),
          api.getRecentEvents(30),
          api.isMonitoringActive(),
        ]);
        if (results[0].status === 'fulfilled' && results[0].value) setStats(results[0].value);
        if (results[1].status === 'fulfilled' && results[1].value) setJobs(results[1].value);
        if (results[2].status === 'fulfilled' && results[2].value) setEvents(results[2].value);
        if (results[3].status === 'fulfilled') setIsMonitoringActive(results[3].value);
      } catch (e) {
        console.error('Poll update failed', e);
      }
    }, 3000);
    return () => clearInterval(timer);
  }, []);

  // Handle monitoring toggle
  const handleToggleMonitoring = async () => {
    try {
      if (isMonitoringActive) {
        const res = await api.stopMonitoring();
        setIsMonitoringActive(res);
      } else {
        const res = await api.startMonitoring();
        setIsMonitoringActive(res);
      }
    } catch (err) {
      console.error('Failed to toggle monitoring:', err);
    }
  };

  const handleSyncSheets = async () => {
    setIsSyncingSheets(true);
    try {
      const syncedCount = await api.syncCompaniesFromSheets();
      const updated = await api.getCompaniesCache();
      setCompanies(updated);
      showToast(
        'success',
        tx(
          lang,
          `Synced ${syncedCount} supplier(s) from Google Sheets.`,
          `ซิงก์รายชื่อผู้ขาย ${syncedCount} รายจาก Google Sheets สำเร็จ`
        )
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Sync failed:', err);
      showToast('error', tx(lang, `Google Sheets sync failed: ${msg}`, `ซิงก์ Google Sheets ไม่สำเร็จ: ${msg}`));
    } finally {
      setIsSyncingSheets(false);
    }
  };

  const handleGoogleLogin = async () => {
    setIsLoggingIn(true);
    try {
      const account = await api.startGoogleLogin(
        settings.google_oauth_client_id,
        settings.google_oauth_client_secret
      );
      setGoogleAccount(account);
      setSettings((prev) => ({ ...prev, google_account: account }));
    } catch (err: any) {
      console.error('Google login failed:', err);
      alert(`${tx(lang, 'Google Login:', 'เข้าสู่ระบบ Google ไม่สำเร็จ:')} ${err}`);
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleGoogleLogout = async () => {
    try {
      await api.logoutGoogle();
      setGoogleAccount(null);
      setSettings((prev) => ({ ...prev, google_account: null }));
    } catch (err: any) {
      console.error('Google logout failed:', err);
    }
  };

  const handleSaveSettings = async (newSettings: AppSettings) => {
    await api.saveSettings(newSettings);
    setSettings(newSettings);
    if (
      !newSettings.developer_mode_enabled &&
      (currentTab === 'developer-options' || currentTab === 'benchmark')
    ) {
      setCurrentTab('overview');
    }
    const nextLang = resolveUiLang(newSettings);
    const modeLabel =
      newSettings.auto_send_email_enabled === false || newSettings.auto_send_mode === 'manual_review_all'
        ? tx(nextLang, 'OFF (Manual Approval Only)', 'ปิด (ต้องกดอนุมัติเองทุกฉบับ)')
        : newSettings.auto_send_mode === 'verified_only'
        ? tx(nextLang, 'Strict (≥98% Verified)', 'เข้มงวด (ยืนยัน ≥98%)')
        : tx(nextLang, 'ON (≥90% Verified & High)', 'เปิด (ส่งอัตโนมัติ ≥90%)');
    showToast(
      'info',
      tx(nextLang, `Settings saved • Auto-Send Email: ${modeLabel}`, `บันทึกการตั้งค่าแล้ว • การส่งอีเมลอัตโนมัติ: ${modeLabel}`)
    );
  };

  const handleCompleteWizard = async (wizardSettings: AppSettings) => {
    await api.saveSettings(wizardSettings);
    setSettings(wizardSettings);
    await api.startMonitoring();
    setIsMonitoringActive(true);
    setCurrentTab('overview');
  };

  const handleSelectJobForInspection = (jobId: string) => {
    setSelectedJobId(jobId);
    setCurrentTab('ocr-inspector');
  };

  const handleRetryJob = async (jobId: string) => {
    try {
      await api.retryJob(jobId);
      await loadInitialData();
      showToast(
        'info',
        tx(
          lang,
          'Job re-processed using updated OCR & Thai-first directory matching.',
          'สแกนและจับคู่รายชื่อผู้ขายใหม่เรียบร้อยแล้ว'
        )
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('Retry failed', e);
      showToast('error', tx(lang, `Retry failed: ${msg}`, `สแกนซ้ำไม่สำเร็จ: ${msg}`));
      throw e;
    }
  };

  // Tab Header Titles
  const getTabTitle = () => {
    switch (currentTab) {
      case 'overview':
        return { title: tr(lang, 'tabOverviewTitle'), subtitle: tr(lang, 'tabOverviewSub') };
      case 'live-monitor':
        return { title: tr(lang, 'tabLiveTitle'), subtitle: tr(lang, 'tabLiveSub') };
      case 'transactions':
        return { title: tr(lang, 'tabTxTitle'), subtitle: tr(lang, 'tabTxSub') };
      case 'ocr-inspector':
        return { title: tr(lang, 'tabInspectorTitle'), subtitle: tr(lang, 'tabInspectorSub') };
      case 'directory':
        return { title: tr(lang, 'tabDirectoryTitle'), subtitle: tr(lang, 'tabDirectorySub') };
      case 'email-history':
        return { title: tr(lang, 'tabEmailHistoryTitle'), subtitle: tr(lang, 'tabEmailHistorySub') };
      case 'analytics':
        return { title: tr(lang, 'tabAnalyticsTitle'), subtitle: tr(lang, 'tabAnalyticsSub') };
      case 'settings':
        return { title: tr(lang, 'tabSettingsTitle'), subtitle: tr(lang, 'tabSettingsSub') };
      case 'developer-options':
        return { title: tr(lang, 'tabDevTitle'), subtitle: tr(lang, 'tabDevSub') };
      case 'benchmark':
        return { title: tr(lang, 'tabBenchmarkTitle'), subtitle: tr(lang, 'tabBenchmarkSub') };
      case 'setup-wizard':
        return { title: tr(lang, 'tabSetupTitle'), subtitle: tr(lang, 'tabSetupSub') };
      default:
        return { title: 'PO AutoFlow', subtitle: '' };
    }
  };

  const activeTab =
    !settings.developer_mode_enabled &&
    (currentTab === 'developer-options' || currentTab === 'benchmark')
      ? 'overview'
      : currentTab;

  const { title, subtitle } = getTabTitle();

  return (
    <div className="flex h-screen bg-[#09090b] text-zinc-100 overflow-hidden font-sans">
      {/* Sidebar Navigation */}
      <Sidebar
        currentTab={activeTab}
        onSelectTab={setCurrentTab}
        isMonitoringActive={isMonitoringActive}
        rootDir={settings.root_dir}
        needsReviewCount={jobs.filter((j) => j.status === 'needs_review').length}
        companiesCount={companies.length}
        developerMode={!!settings.developer_mode_enabled}
        lang={lang}
      />

      {/* Main App Container */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <Header
          title={title}
          subtitle={subtitle}
          incomingDir={settings.incoming_dir}
          settings={settings}
          onSaveSettings={handleSaveSettings}
          isMonitoringActive={isMonitoringActive}
          onToggleMonitoring={handleToggleMonitoring}
          onRefreshData={loadInitialData}
          isRefreshing={isRefreshing}
          googleAccount={googleAccount}
          onGoogleLogin={handleGoogleLogin}
          onGoogleLogout={handleGoogleLogout}
          isLoggingIn={isLoggingIn}
        />

        {appToast && (
          <div className="px-6 pt-3 shrink-0">
            <div
              className={`px-4 py-2.5 rounded-xl border text-xs flex items-center justify-between gap-3 shadow-sm ${
                appToast.type === 'success'
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                  : appToast.type === 'error'
                  ? 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                  : 'bg-blue-500/10 border-blue-500/30 text-blue-300'
              }`}
            >
              <div className="flex items-center gap-2">
                {appToast.type === 'success' ? (
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                ) : appToast.type === 'error' ? (
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                ) : (
                  <Info className="w-4 h-4 shrink-0" />
                )}
                <span>{appToast.message}</span>
              </div>
              <button
                type="button"
                onClick={() => setAppToast(null)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* Viewport Content with ErrorBoundary */}
        <main className="flex-1 overflow-y-auto">
          <ErrorBoundary
            lang={lang}
            fallbackTitle={tx(lang, 'View Rendering Error', 'เกิดข้อผิดพลาดในการแสดงผลหน้าจอ')}
          >
            {activeTab === 'overview' && (
              <Overview
                stats={stats}
                recentJobs={jobs}
                recentEvents={events}
                companies={companies}
                aliases={aliases}
                settings={settings}
                onSaveSettings={handleSaveSettings}
                onSelectJob={handleSelectJobForInspection}
                onNavigateTab={setCurrentTab}
                onSyncSheets={handleSyncSheets}
                onRetryJob={handleRetryJob}
                onRefreshData={loadInitialData}
                isSyncingSheets={isSyncingSheets}
              />
            )}

            {activeTab === 'live-monitor' && (
              <LiveMonitor
                jobs={jobs}
                events={events}
                onSelectJob={handleSelectJobForInspection}
                onRetryJob={handleRetryJob}
                lang={lang}
              />
            )}

            {activeTab === 'transactions' && (
              <Transactions transactions={transactions} lang={lang} />
            )}

            {activeTab === 'ocr-inspector' && (
              <OcrInspector
                selectedJobId={selectedJobId}
                jobs={jobs}
                companies={companies}
                aliases={aliases}
                settings={settings}
                onSelectJob={setSelectedJobId}
                onRefreshData={loadInitialData}
                onRetryJob={handleRetryJob}
                lang={lang}
              />
            )}

            {activeTab === 'directory' && (
              <CompanyDirectory
                companies={companies}
                aliases={aliases}
                onRefreshCompanies={loadInitialData}
                onSyncSheets={handleSyncSheets}
                isSyncing={isSyncingSheets}
                lang={lang}
              />
            )}

            {activeTab === 'email-history' && (
              <EmailHistory transactions={transactions} lang={lang} />
            )}

            {activeTab === 'analytics' && (
              <Analytics
                stats={stats}
                jobs={jobs}
                companies={companies}
                transactions={transactions}
                lang={lang}
              />
            )}

            {activeTab === 'settings' && (
              <Settings
                settings={settings}
                onSaveSettings={handleSaveSettings}
                googleAccount={googleAccount}
                onGoogleLogin={handleGoogleLogin}
                onGoogleLogout={handleGoogleLogout}
                isLoggingIn={isLoggingIn}
              />
            )}

            {activeTab === 'benchmark' && !!settings.developer_mode_enabled && (
              <ModelBenchmark settings={settings} jobs={jobs} lang={lang} />
            )}

            {activeTab === 'developer-options' && !!settings.developer_mode_enabled && (
              <DeveloperOptions
                settings={settings}
                onSaveSettings={handleSaveSettings}
                events={events}
                onRefreshData={loadInitialData}
                lang={lang}
              />
            )}

            {activeTab === 'setup-wizard' && (
              <SetupWizard
                settings={settings}
                onCompleteWizard={handleCompleteWizard}
                onCancel={() => setCurrentTab('overview')}
                lang={lang}
              />
            )}
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
};

export default App;
