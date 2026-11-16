import React, { useState, useEffect } from 'react';
import {
  Settings as SettingsIcon,
  FolderOpen,
  Cpu,
  Building2,
  CloudUpload,
  Mail,
  ShieldCheck,
  Save,
  CheckCircle2,
  Eye,
  EyeOff,
  Terminal,
  Bug,
  Key,
  Send,
  RefreshCw,
  Download,
  ExternalLink,
  GitBranch,
  BrainCircuit,
  Sparkles,
  Lock,
} from 'lucide-react';
import type { AppSettings, GoogleAccountInfo, LearningStats, LocalVisionStatus } from '../types';
import { api, checkGitHubUpdate, installGitHubUpdate, type GitHubUpdateStatus } from '../services/tauri';

interface SettingsProps {
  settings: AppSettings;
  onSaveSettings: (newSettings: AppSettings) => Promise<void>;
  googleAccount?: GoogleAccountInfo | null;
  onGoogleLogin?: () => void;
  onGoogleLogout?: () => void;
  isLoggingIn?: boolean;
}

export const Settings: React.FC<SettingsProps> = ({
  settings: initialSettings,
  onSaveSettings,
  googleAccount,
  onGoogleLogin,
  onGoogleLogout,
  isLoggingIn,
}) => {
  const [activeTab, setActiveTab] = useState('folders');
  const [formData, setFormData] = useState<AppSettings>(initialSettings);
  const [showSecret, setShowSecret] = useState(false);
  const [showCustomOAuth, setShowCustomOAuth] = useState(false);
  const [testStatus, setTestStatus] = useState<{ [key: string]: { loading: boolean; success?: boolean; message?: string } }>({});
  const [isSaving, setIsSaving] = useState(false);
  const [saveToast, setSaveToast] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<GitHubUpdateStatus | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateActionMsg, setUpdateActionMsg] = useState<string | null>(null);
  const [learningStats, setLearningStats] = useState<LearningStats | null>(null);
  const [visionStatus, setVisionStatus] = useState<LocalVisionStatus | null>(null);
  const [testingVision, setTestingVision] = useState(false);

  const handleTestLocalVision = async () => {
    setTestingVision(true);
    try {
      const res = await api.testLocalVisionAi(
        formData.local_vision_provider || 'ollama',
        formData.local_vision_endpoint || 'http://127.0.0.1:11434',
        formData.local_vision_model || 'hf.co/ggml-org/SmolVLM2-2.2B-Instruct-GGUF'
      );
      setVisionStatus(res);
    } catch (err: any) {
      setVisionStatus({
        reachable: false,
        endpoint: formData.local_vision_endpoint || 'http://127.0.0.1:11434',
        configured_model: formData.local_vision_model || 'hf.co/ggml-org/SmolVLM2-2.2B-Instruct-GGUF',
        available_models: [],
        message: typeof err === 'string' ? err : err?.message || 'Test failed',
      });
    } finally {
      setTestingVision(false);
    }
  };

  const handleCheckUpdates = async () => {
    setCheckingUpdate(true);
    setUpdateError(null);
    setUpdateActionMsg(null);
    try {
      const res = await checkGitHubUpdate();
      setUpdateStatus(res);
      setUpdateActionMsg(
        res.update_available
          ? `New version v${res.latest_version} is available on GitHub!`
          : `You are running the latest version (v${res.current_version}).`
      );
    } catch (err: any) {
      setUpdateError(typeof err === 'string' ? err : err?.message || 'Failed to check updates');
    } finally {
      setCheckingUpdate(false);
    }
  };

  const handleInstallUpdate = async () => {
    if (!updateStatus?.installer_url) {
      window.open(
        updateStatus?.release_url || 'https://github.com/oscarpooper-lang/po-autoflow-enterprise/releases',
        '_blank',
        'noopener,noreferrer'
      );
      return;
    }
    setInstallingUpdate(true);
    setUpdateError(null);
    setUpdateActionMsg('Downloading installer from GitHub Releases...');
    try {
      const launchedPath = await installGitHubUpdate(
        updateStatus.installer_url,
        updateStatus.installer_name || undefined
      );
      setUpdateActionMsg(`Installer launched from ${launchedPath}. Follow the Windows installer prompts.`);
    } catch (err: any) {
      setUpdateError(typeof err === 'string' ? err : err?.message || 'Failed to install update');
    } finally {
      setInstallingUpdate(false);
    }
  };

  useEffect(() => {
    checkGitHubUpdate()
      .then((res) => setUpdateStatus(res))
      .catch(() => {});
    api
      .getLearningStats()
      .then((stats) => setLearningStats(stats))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setFormData(initialSettings);
  }, [initialSettings]);

  const handleChange = (field: keyof AppSettings, value: any) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      await onSaveSettings(formData);
      setSaveToast(true);
      setTimeout(() => setSaveToast(false), 3000);
    } finally {
      setIsSaving(false);
    }
  };

  const testSheets = async () => {
    setTestStatus((prev) => ({ ...prev, sheets: { loading: true } }));
    try {
      const count = await api.testSheetsConnection(
        formData.google_sheets_id,
        formData.google_sheets_tab_name,
        formData.gas_webhook_url,
        formData.gas_auth_secret
      );
      setTestStatus((prev) => ({
        ...prev,
        sheets: { loading: false, success: true, message: `Successfully connected! Loaded ${count} company rows.` },
      }));
    } catch (err: any) {
      setTestStatus((prev) => ({
        ...prev,
        sheets: { loading: false, success: false, message: `Connection failed: ${err}` },
      }));
    }
  };

  const testDrive = async () => {
    setTestStatus((prev) => ({ ...prev, drive: { loading: true } }));
    try {
      const ok = await api.testDriveConnection(formData.google_drive_folder_id);
      setTestStatus((prev) => ({
        ...prev,
        drive: { loading: false, success: ok, message: ok ? 'Drive folder ID verified!' : 'Invalid Drive Folder' },
      }));
    } catch (err: any) {
      setTestStatus((prev) => ({
        ...prev,
        drive: { loading: false, success: false, message: `Drive test failed: ${err}` },
      }));
    }
  };

  const testGas = async () => {
    setTestStatus((prev) => ({ ...prev, gas: { loading: true } }));
    try {
      const ok = await api.testGasConnection(formData.gas_webhook_url, formData.gas_auth_secret);
      setTestStatus((prev) => ({
        ...prev,
        gas: { loading: false, success: ok, message: ok ? 'Apps Script Webhook & AUTH_SECRET verified!' : 'Endpoint returned error' },
      }));
    } catch (err: any) {
      setTestStatus((prev) => ({
        ...prev,
        gas: { loading: false, success: false, message: `Webhook unreachable: ${err}` },
      }));
    }
  };

  const tabs = [
    { id: 'folders', label: 'Folder Monitoring', icon: FolderOpen },
    { id: 'ocr', label: 'OCR Engine & Thresholds', icon: Cpu },
    { id: 'sheets', label: 'Google Sheets Directory', icon: Building2 },
    { id: 'drive', label: 'Google Drive Storage', icon: CloudUpload },
    { id: 'gas', label: 'Apps Script & Gmail', icon: Mail },
    { id: 'template', label: 'Email Templates', icon: Mail },
    { id: 'security', label: 'Security & Integrity', icon: ShieldCheck },
    { id: 'developer', label: 'Developer & Debugging', icon: Terminal },
  ];

  const renderAutoSendOptionsPanel = () => (
    <div className="p-4 rounded-xl bg-zinc-950/70 border border-zinc-800 space-y-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h4 className="font-semibold text-white flex items-center gap-1.5">
            <Send className="w-3.5 h-3.5 text-emerald-400" />
            <span>Auto-Send Email Options</span>
          </h4>
          <p className="text-[11px] text-zinc-400 mt-0.5">
            Control when POs send automatically versus holding in Needs Review for manual approval.
          </p>
        </div>
        <label className="inline-flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={formData.auto_send_email_enabled !== false && formData.auto_send_mode !== 'manual_review_all'}
            onChange={(e) => {
              const enabled = e.target.checked;
              setFormData((prev) => ({
                ...prev,
                auto_send_email_enabled: enabled,
                auto_send_mode: enabled
                  ? prev.auto_send_mode === 'manual_review_all' || !prev.auto_send_mode
                    ? 'verified_and_high'
                    : prev.auto_send_mode
                  : 'manual_review_all',
              }));
            }}
            className="h-4 w-4 rounded border-zinc-700 bg-zinc-800 text-emerald-500 cursor-pointer"
          />
          <span className="font-semibold text-zinc-200">
            {formData.auto_send_email_enabled !== false && formData.auto_send_mode !== 'manual_review_all'
              ? 'Enabled'
              : 'Paused (Manual Only)'}
          </span>
        </label>
      </div>

      <div>
        <label className="text-zinc-300 font-medium block mb-1">Auto-Send Confidence Rule:</label>
        <select
          value={
            formData.auto_send_email_enabled === false
              ? 'manual_review_all'
              : formData.auto_send_mode || 'verified_and_high'
          }
          onChange={(e) => {
            const val = e.target.value as 'verified_and_high' | 'verified_only' | 'manual_review_all';
            setFormData((prev) => ({
              ...prev,
              auto_send_email_enabled: val !== 'manual_review_all',
              auto_send_mode: val,
            }));
          }}
          className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 font-medium"
        >
          <option value="verified_and_high">
            Verified &amp; High Confidence (≥ {formData.ocr_confidence_threshold_high}% single match) — Recommended
          </option>
          <option value="verified_only">
            Strict Verified Only (≥ {formData.ocr_confidence_threshold_verified}% exact/alias match)
          </option>
          <option value="manual_review_all">
            Manual Review All (Never auto-send — hold every PO in Needs Review)
          </option>
        </select>
      </div>

      <div>
        <label className="text-zinc-300 font-medium block mb-1">Email Attachment Format (Gmail):</label>
        <select
          value={formData.email_attachment_mode || 'individual_files'}
          onChange={(e) =>
            handleChange(
              'email_attachment_mode',
              e.target.value as 'individual_files' | 'zip_archive' | 'both'
            )
          }
          className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 font-medium"
        >
          <option value="individual_files">
            Individual Files — PDFs &amp; Images Previewable in Gmail (Recommended)
          </option>
          <option value="both">Both Individual Previewable Files + ZIP Archive</option>
          <option value="zip_archive">Single Compressed ZIP File Only (.zip)</option>
        </select>
        <p className="text-[11px] text-zinc-400 mt-1">
          Sending individual files allows suppliers to preview PDFs and images directly inside Gmail instead of downloading/unzipping a single .zip archive.
        </p>
      </div>

      <div className="space-y-2 pt-1">
        <label className="flex items-start gap-2.5 text-zinc-300 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={!!formData.require_drive_backup_for_auto_send}
            onChange={(e) => handleChange('require_drive_backup_for_auto_send', e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-zinc-700 bg-zinc-800 text-blue-500 cursor-pointer"
          />
          <span>
            <span className="font-medium text-zinc-200 block">
              Require Cloud Google Drive Backup Before Dispatch
            </span>
            <span className="text-[11px] text-zinc-400">
              Hold in Needs Review if Drive cloud upload is offline instead of continuing with a local reference.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2.5 text-zinc-300 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={!!formData.allow_pdf_email_fallback}
            onChange={(e) => handleChange('allow_pdf_email_fallback', e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-zinc-700 bg-zinc-800 text-blue-500 cursor-pointer"
          />
          <span>
            <span className="font-medium text-zinc-200 block">
              Allow PDF-Extracted Vendor Email Fallback
            </span>
            <span className="text-[11px] text-zinc-400">
              If a supplier is missing from Google Sheets, use the non-QTC vendor email found inside the PO/quotation PDF.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2.5 text-zinc-300 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={!!formData.dry_run_simulation_mode}
            onChange={(e) => handleChange('dry_run_simulation_mode', e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-zinc-700 bg-zinc-800 text-amber-500 cursor-pointer"
          />
          <span>
            <span className="font-medium text-amber-300 block">
              Dry-Run Simulation Mode (Test Only — Never Send Real Emails)
            </span>
            <span className="text-[11px] text-zinc-400">
              Runs OCR, matching, and ZIP creation while mocking Google Drive upload and Gmail dispatch.
            </span>
          </span>
        </label>
      </div>
    </div>
  );

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-bold text-white flex items-center gap-2">
            <SettingsIcon className="w-5 h-5 text-blue-400" />
            Enterprise System Configuration
          </h2>
          <p className="text-xs text-zinc-400">
            Configure background folder watchers, neural OCR parameters, and Google Cloud endpoints
          </p>
        </div>

        <button
          onClick={handleSave}
          disabled={isSaving}
          className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-md shadow-blue-500/20 transition-all flex items-center space-x-1.5"
        >
          <Save className="w-4 h-4" />
          <span>{isSaving ? 'Saving...' : 'Save Configuration'}</span>
        </button>
      </div>

      {saveToast && (
        <div className="p-3 rounded-lg bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 text-xs font-semibold flex items-center space-x-2">
          <CheckCircle2 className="w-4 h-4" />
          <span>Settings successfully saved and reloaded into backend runtime!</span>
        </div>
      )}

      {/* Settings Layout: Left Nav, Right Content */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
        <div className="md:col-span-3 space-y-1">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-lg text-xs font-medium transition-all ${
                  active
                    ? 'bg-blue-600 text-white font-semibold shadow-sm'
                    : 'text-zinc-400 hover:bg-zinc-900/70 hover:text-zinc-200'
                }`}
              >
                <Icon className="w-4 h-4" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        <div className="md:col-span-9 bg-[#121215] border border-zinc-800 rounded-xl p-6 shadow-sm">
          {/* Tab 1: Folders */}
          {activeTab === 'folders' && (
            <div className="space-y-4 text-xs">
              <h3 className="text-sm font-bold text-white mb-2">Automated Folder Structure</h3>
              <p className="text-zinc-400 text-xs mb-4">
                Configure paths on the local Windows filesystem. Non-existent folders are created automatically.
              </p>

              <div className="grid grid-cols-1 gap-4">
                <div>
                  <label className="text-zinc-300 font-semibold block mb-1">
                    Incoming PO Directory (Monitored):
                  </label>
                  <input
                    type="text"
                    value={formData.incoming_dir}
                    onChange={(e) => handleChange('incoming_dir', e.target.value)}
                    className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 font-mono"
                  />
                  <p className="text-[11px] text-zinc-500 mt-1">Users drop new PO folders directly into this location.</p>
                </div>

                <div>
                  <label className="text-zinc-300 font-semibold block mb-1">
                    Processing Directory (Active Lock):
                  </label>
                  <input
                    type="text"
                    value={formData.processing_dir}
                    onChange={(e) => handleChange('processing_dir', e.target.value)}
                    className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 font-mono"
                  />
                </div>

                <div>
                  <label className="text-zinc-300 font-semibold block mb-1">
                    Sent Directory (Completed):
                  </label>
                  <input
                    type="text"
                    value={formData.sent_dir}
                    onChange={(e) => handleChange('sent_dir', e.target.value)}
                    className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 font-mono"
                  />
                </div>

                <div>
                  <label className="text-zinc-300 font-semibold block mb-1">
                    Review Directory (Low Confidence / Manual Action Required):
                  </label>
                  <input
                    type="text"
                    value={formData.review_dir}
                    onChange={(e) => handleChange('review_dir', e.target.value)}
                    className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 font-mono"
                  />
                </div>

                <div>
                  <label className="text-zinc-300 font-semibold block mb-1">
                    Failed Directory (Errors):
                  </label>
                  <input
                    type="text"
                    value={formData.failed_dir}
                    onChange={(e) => handleChange('failed_dir', e.target.value)}
                    className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 font-mono"
                  />
                </div>

                <div className="pt-2 grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-zinc-300 font-semibold block mb-1">
                      Stability Check Delay (ms):
                    </label>
                    <input
                      type="number"
                      value={formData.stability_delay_ms}
                      onChange={(e) => handleChange('stability_delay_ms', parseInt(e.target.value) || 1500)}
                      className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 font-mono"
                    />
                  </div>
                  <div>
                    <label className="text-zinc-300 font-semibold block mb-1">
                      Consecutive Unvarying Checks:
                    </label>
                    <input
                      type="number"
                      value={formData.stability_checks}
                      onChange={(e) => handleChange('stability_checks', parseInt(e.target.value) || 3)}
                      className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 font-mono"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Tab 2: OCR */}
          {activeTab === 'ocr' && (
            <div className="space-y-4 text-xs">
              <h3 className="text-sm font-bold text-white mb-2">Document Reader &amp; Matching Rules</h3>
              <p className="text-zinc-400 text-xs mb-4">
                Reads Thai and English PDFs (with AX 2012 font repair), ignores QTC self-company, and prioritizes Thai supplier names first.
              </p>

              <div className="space-y-4">
                <div>
                  <label className="text-zinc-300 font-semibold block mb-1">Primary OCR Engine:</label>
                  <select
                    value={formData.ocr_engine_primary}
                    onChange={(e) => handleChange('ocr_engine_primary', e.target.value)}
                    className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 font-medium"
                  >
                    <option value="paddleocr">PaddleOCR PP-OCRv5 (Thai & English) — Local Managed Sidecar</option>
                    <option value="google_vision">Google Cloud Vision API (DOCUMENT_TEXT_DETECTION)</option>
                  </select>
                </div>

                <div className="p-4 rounded-lg bg-zinc-950/70 border border-zinc-800 space-y-3">
                  <h4 className="font-semibold text-zinc-200">Company Match Confidence Thresholds (%)</h4>
                  <div>
                    <div className="flex justify-between mb-1">
                      <span className="text-emerald-400 font-medium">Verified Automatic Send (≥ 98%):</span>
                      <span className="font-mono">{formData.ocr_confidence_threshold_verified}%</span>
                    </div>
                    <input
                      type="range"
                      min="90"
                      max="100"
                      step="0.5"
                      value={formData.ocr_confidence_threshold_verified}
                      onChange={(e) => handleChange('ocr_confidence_threshold_verified', parseFloat(e.target.value))}
                      className="w-full"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between mb-1">
                      <span className="text-blue-400 font-medium">High Confidence (Single Match) (≥ 90%):</span>
                      <span className="font-mono">{formData.ocr_confidence_threshold_high}%</span>
                    </div>
                    <input
                      type="range"
                      min="80"
                      max="97"
                      step="0.5"
                      value={formData.ocr_confidence_threshold_high}
                      onChange={(e) => handleChange('ocr_confidence_threshold_high', parseFloat(e.target.value))}
                      className="w-full"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between mb-1">
                      <span className="text-amber-400 font-medium">Human Verification Required (≥ 75%):</span>
                      <span className="font-mono">{formData.ocr_confidence_threshold_review}%</span>
                    </div>
                    <input
                      type="range"
                      min="60"
                      max="89"
                      step="0.5"
                      value={formData.ocr_confidence_threshold_review}
                      onChange={(e) => handleChange('ocr_confidence_threshold_review', parseFloat(e.target.value))}
                      className="w-full"
                    />
                  </div>
                </div>

                {renderAutoSendOptionsPanel()}

                {/* Self-Learning Memory Engine Card */}
                <div className="p-4 rounded-xl bg-zinc-950/70 border border-zinc-800 space-y-3 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h4 className="font-semibold text-white flex items-center gap-1.5">
                        <BrainCircuit className="w-4 h-4 text-purple-400" />
                        <span>Self-Learning Memory Engine (Gets Smarter Every PO)</span>
                      </h4>
                      <p className="text-[11px] text-zinc-400 mt-0.5">
                        Learns from every approved PO: links Thai + English names, 13-digit Tax IDs, email domains, page zones, and blacklists false OCR guesses.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => api.getLearningStats().then(setLearningStats).catch(() => {})}
                      className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 flex items-center gap-1 text-[11px]"
                    >
                      <RefreshCw className="w-3 h-3" />
                      <span>Refresh Stats</span>
                    </button>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                    <div className="p-2.5 rounded-lg bg-zinc-900/90 border border-zinc-800">
                      <span className="text-zinc-500 block text-[10px]">Name Variants</span>
                      <span className="text-zinc-100 font-mono font-semibold text-sm">
                        {learningStats?.learned_name_variants ?? 0}
                      </span>
                    </div>
                    <div className="p-2.5 rounded-lg bg-zinc-900/90 border border-zinc-800">
                      <span className="text-zinc-500 block text-[10px]">13-Digit Tax IDs</span>
                      <span className="text-zinc-100 font-mono font-semibold text-sm">
                        {learningStats?.learned_tax_ids ?? 0}
                      </span>
                    </div>
                    <div className="p-2.5 rounded-lg bg-zinc-900/90 border border-zinc-800">
                      <span className="text-zinc-500 block text-[10px]">Email Domains</span>
                      <span className="text-zinc-100 font-mono font-semibold text-sm">
                        {learningStats?.learned_email_domains ?? 0}
                      </span>
                    </div>
                    <div className="p-2.5 rounded-lg bg-zinc-900/90 border border-zinc-800">
                      <span className="text-zinc-500 block text-[10px]">Negative Filters</span>
                      <span className="text-amber-300 font-mono font-semibold text-sm">
                        {learningStats?.negative_phrases_count ?? 0}
                      </span>
                    </div>
                    <div className="p-2.5 rounded-lg bg-zinc-900/90 border border-zinc-800">
                      <span className="text-zinc-500 block text-[10px]">Total Reinforced</span>
                      <span className="text-emerald-400 font-mono font-semibold text-sm">
                        {learningStats?.total_approvals_learned ?? 0}
                      </span>
                    </div>
                  </div>

                  <div className="space-y-2 pt-1">
                    <label className="flex items-start gap-2.5 text-zinc-300 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={formData.self_learning_enabled !== false}
                        onChange={(e) => handleChange('self_learning_enabled', e.target.checked)}
                        className="mt-0.5 h-4 w-4 rounded border-zinc-700 bg-zinc-800 text-purple-500 cursor-pointer"
                      />
                      <span>
                        <span className="font-medium text-zinc-200 block">
                          Enable Self-Learning Memory Loop
                        </span>
                        <span className="text-[11px] text-zinc-400">
                          Automatically harvest Tax IDs, bilingual supplier names, email domains, and layout zones after each PO approval.
                        </span>
                      </span>
                    </label>

                    <label className="flex items-start gap-2.5 text-zinc-300 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={formData.auto_sync_learned_suppliers_to_sheets !== false}
                        onChange={(e) =>
                          handleChange('auto_sync_learned_suppliers_to_sheets', e.target.checked)
                        }
                        className="mt-0.5 h-4 w-4 rounded border-zinc-700 bg-zinc-800 text-purple-500 cursor-pointer"
                      />
                      <span>
                        <span className="font-medium text-zinc-200 block">
                          Auto-Save New Approved Suppliers Back to Google Sheet
                        </span>
                        <span className="text-[11px] text-zinc-400">
                          When you approve an unknown vendor once, automatically insert/update their name, email &amp; Tax ID in your Google Sheet via Apps Script.
                        </span>
                      </span>
                    </label>
                  </div>
                </div>

                {/* 100% Offline Local Vision AI Card */}
                <div className="p-4 rounded-xl bg-zinc-950/70 border border-zinc-800 space-y-3 text-xs">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h4 className="font-semibold text-white flex items-center gap-1.5">
                        <Sparkles className="w-4 h-4 text-emerald-400" />
                        <span>100% Offline Local Vision AI (SmolVLM2-2.2B / Qwen2.5-VL-3B)</span>
                      </h4>
                      <p className="text-[11px] text-zinc-400 mt-0.5 flex items-center gap-1">
                        <Lock className="w-3 h-3 text-emerald-400 shrink-0" />
                        <span>
                          Zero cloud data leakage: strictly runs on-device (`127.0.0.1` / local Python) only when OCR confidence is below 85%.
                        </span>
                      </p>
                    </div>
                    <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={!!formData.local_vision_enabled}
                        onChange={(e) => handleChange('local_vision_enabled', e.target.checked)}
                        className="h-4 w-4 rounded border-zinc-700 bg-zinc-800 text-emerald-500 cursor-pointer"
                      />
                      <span className="font-semibold text-zinc-200">
                        {formData.local_vision_enabled ? 'Enabled' : 'Disabled'}
                      </span>
                    </label>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="text-zinc-300 font-medium block mb-1">Local AI Runtime:</label>
                      <select
                        value={formData.local_vision_provider || 'ollama'}
                        onChange={(e) => {
                          const prov = e.target.value as 'ollama' | 'transformers';
                          setFormData((prev) => ({
                            ...prev,
                            local_vision_provider: prov,
                            local_vision_model:
                              prov === 'transformers'
                                ? 'HuggingFaceTB/SmolVLM2-2.2B-Instruct'
                                : prev.local_vision_model?.includes('HuggingFaceTB/')
                                ? 'hf.co/ggml-org/SmolVLM2-2.2B-Instruct-GGUF'
                                : prev.local_vision_model || 'hf.co/ggml-org/SmolVLM2-2.2B-Instruct-GGUF',
                          }));
                        }}
                        className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2"
                      >
                        <option value="ollama">Local Ollama Server (127.0.0.1:11434 — Recommended)</option>
                        <option value="transformers">Embedded Python Transformers (On-Device PyTorch)</option>
                      </select>
                    </div>

                    <div>
                      <label className="text-zinc-300 font-medium block mb-1">Lightweight Vision Model:</label>
                      <select
                        value={
                          [
                            'hf.co/ggml-org/SmolVLM2-2.2B-Instruct-GGUF',
                            'qwen2.5vl:3b',
                            'moondream',
                            'HuggingFaceTB/SmolVLM2-2.2B-Instruct',
                          ].includes(formData.local_vision_model || '')
                            ? formData.local_vision_model
                            : 'hf.co/ggml-org/SmolVLM2-2.2B-Instruct-GGUF'
                        }
                        onChange={(e) => handleChange('local_vision_model', e.target.value)}
                        className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2"
                      >
                        <option value="hf.co/ggml-org/SmolVLM2-2.2B-Instruct-GGUF">
                          SmolVLM2-2.2B-Instruct (GGUF via Ollama — ~1.3 GB, Ultra Light)
                        </option>
                        <option value="qwen2.5vl:3b">
                          Qwen2.5-VL-3B (via Ollama — ~3.2 GB, Best for Thai + English POs)
                        </option>
                        <option value="moondream">
                          Moondream 1.8B (via Ollama — ~1.7 GB, Fast CPU Fallback)
                        </option>
                        <option value="HuggingFaceTB/SmolVLM2-2.2B-Instruct">
                          HuggingFaceTB/SmolVLM2-2.2B-Instruct (Embedded Python Transformers)
                        </option>
                      </select>
                    </div>
                  </div>

                  {formData.local_vision_provider !== 'transformers' && (
                    <div>
                      <label className="text-zinc-300 font-medium block mb-1">
                        Localhost Endpoint (Locked to 127.0.0.1 / localhost):
                      </label>
                      <input
                        type="text"
                        value={formData.local_vision_endpoint || 'http://127.0.0.1:11434'}
                        onChange={(e) => handleChange('local_vision_endpoint', e.target.value)}
                        className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 font-mono"
                      />
                    </div>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    <button
                      type="button"
                      onClick={handleTestLocalVision}
                      disabled={testingVision}
                      className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 font-semibold border border-zinc-700 flex items-center gap-1.5"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${testingVision ? 'animate-spin' : ''}`} />
                      <span>{testingVision ? 'Checking...' : 'Test Local Vision AI'}</span>
                    </button>
                    <code className="text-[11px] text-zinc-400 font-mono bg-zinc-900 px-2 py-1 rounded border border-zinc-800">
                      {formData.local_vision_provider === 'transformers'
                        ? 'pip install transformers torch accelerate Pillow'
                        : `ollama pull ${formData.local_vision_model || 'hf.co/ggml-org/SmolVLM2-2.2B-Instruct-GGUF'}`}
                    </code>
                  </div>

                  {visionStatus && (
                    <div
                      className={`p-2.5 rounded-lg border text-xs ${
                        visionStatus.reachable
                          ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                          : 'bg-amber-500/10 border-amber-500/30 text-amber-300'
                      }`}
                    >
                      {visionStatus.message}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Tab 3: Sheets */}
          {activeTab === 'sheets' && (
            <div className="space-y-4 text-xs">
              <h3 className="text-sm font-bold text-white mb-2">Google Sheets Directory Integration</h3>
              <p className="text-zinc-400 text-xs mb-4">
                The spreadsheet acts as the single source of truth for company aliases and approved recipient emails.
              </p>

              {/* Google Account Authentication Status Card */}
              {googleAccount ? (
                <div className="p-3.5 rounded-xl bg-emerald-950/40 border border-emerald-500/30 flex items-center justify-between">
                  <div className="flex items-center space-x-3">
                    {googleAccount.picture ? (
                      <img src={googleAccount.picture} alt="" className="w-9 h-9 rounded-full ring-2 ring-emerald-500/50" />
                    ) : (
                      <div className="w-9 h-9 rounded-full bg-emerald-600/30 text-emerald-300 font-bold flex items-center justify-center">
                        {googleAccount.email.charAt(0).toUpperCase()}
                      </div>
                    )}
                    <div>
                      <div className="flex items-center space-x-1.5">
                        <span className="font-semibold text-zinc-100">{googleAccount.name || 'Google Account'}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-medium">Private Access Enabled</span>
                      </div>
                      <p className="text-zinc-400 text-xs">{googleAccount.email}</p>
                    </div>
                  </div>
                  {onGoogleLogout && (
                    <button
                      type="button"
                      onClick={onGoogleLogout}
                      className="px-3 py-1.5 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/20 text-xs font-semibold"
                    >
                      Disconnect
                    </button>
                  )}
                </div>
              ) : (
                <div className="p-3.5 rounded-xl bg-[#121215] border border-zinc-700 flex items-center justify-between">
                  <div>
                    <h4 className="font-semibold text-zinc-200">Google Account Authentication</h4>
                    <p className="text-zinc-400 text-xs mt-0.5">
                      Connect with 1 click via Apps Script Cloud Hub, or configure a custom OAuth Client ID below.
                    </p>
                  </div>
                  {onGoogleLogin && (
                    <button
                      type="button"
                      onClick={onGoogleLogin}
                      disabled={isLoggingIn}
                      className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-white border border-white/20 text-xs font-semibold flex items-center space-x-1.5 shrink-0"
                    >
                      <span>{isLoggingIn ? 'Connecting...' : 'Sign in with Google'}</span>
                    </button>
                  )}
                </div>
              )}

              {/* Optional expandable Custom OAuth Client ID / Secret */}
              <div className="rounded-lg bg-zinc-950/60 border border-zinc-800 p-3">
                <button
                  type="button"
                  onClick={() => setShowCustomOAuth(!showCustomOAuth)}
                  className="w-full flex items-center justify-between text-left text-zinc-300 font-semibold hover:text-white transition-colors"
                >
                  <span className="flex items-center space-x-1.5">
                    <Key className="w-3.5 h-3.5 text-blue-400" />
                    <span>Custom Google Cloud OAuth Client Credentials (Optional)</span>
                  </span>
                  <span className="text-[11px] text-zinc-400">{showCustomOAuth ? 'Hide' : 'Configure'}</span>
                </button>
                {showCustomOAuth && (
                  <div className="mt-3 space-y-2.5 pt-2.5 border-t border-zinc-800">
                    <p className="text-[11px] text-zinc-400">
                      Leave blank to use Apps Script Cloud Hub (recommended). Only needed for direct Google Cloud Console Desktop App OAuth.
                    </p>
                    <div>
                      <label className="text-zinc-300 font-medium block mb-1">Google OAuth Client ID:</label>
                      <input
                        type="text"
                        value={formData.google_oauth_client_id || ''}
                        onChange={(e) => handleChange('google_oauth_client_id', e.target.value)}
                        placeholder="1234567890-xxx.apps.googleusercontent.com"
                        className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-1.5 font-mono"
                      />
                    </div>
                    <div>
                      <label className="text-zinc-300 font-medium block mb-1">Google OAuth Client Secret:</label>
                      <input
                        type="password"
                        value={formData.google_oauth_client_secret || ''}
                        onChange={(e) => handleChange('google_oauth_client_secret', e.target.value)}
                        placeholder="GOCSPX-..."
                        className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-1.5 font-mono"
                      />
                    </div>
                  </div>
                )}
              </div>

              <div>
                <label className="text-zinc-300 font-semibold block mb-1">Google Spreadsheet ID:</label>
                <input
                  type="text"
                  value={formData.google_sheets_id}
                  onChange={(e) => handleChange('google_sheets_id', e.target.value)}
                  placeholder="e.g. 1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms"
                  className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 font-mono"
                />
                <p className="text-[11px] text-zinc-500 mt-1">Found in the Google Sheets browser URL between /d/ and /edit</p>
              </div>

              <div>
                <label className="text-zinc-300 font-semibold block mb-1">Worksheet / Tab Name:</label>
                <input
                  type="text"
                  value={formData.google_sheets_tab_name}
                  onChange={(e) => handleChange('google_sheets_tab_name', e.target.value)}
                  placeholder="Suppliers"
                  className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 font-medium"
                />
              </div>

              <div className="pt-2">
                <button
                  type="button"
                  onClick={testSheets}
                  disabled={testStatus.sheets?.loading}
                  className="px-3.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 font-semibold flex items-center space-x-1.5"
                >
                  <span>{testStatus.sheets?.loading ? 'Testing...' : 'Test Sheets Connection'}</span>
                </button>

                {testStatus.sheets && (
                  <div
                    className={`mt-2 p-2 rounded text-xs font-semibold ${
                      testStatus.sheets.success
                        ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                        : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                    }`}
                  >
                    {testStatus.sheets.message}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Tab 4: Drive */}
          {activeTab === 'drive' && (
            <div className="space-y-4 text-xs">
              <h3 className="text-sm font-bold text-white mb-2">Google Drive Backup Folder</h3>
              <p className="text-zinc-400 text-xs mb-4">
                Uploaded automatically via your Apps Script Web App&apos;s built-in <code className="text-zinc-300 font-mono">DriveApp</code> (no extra Drive API v3 service needs to be added under &quot;+ Services&quot; in Apps Script).
              </p>

              {/* Google Account Authentication Status Card */}
              {googleAccount ? (
                <div className="p-3.5 rounded-xl bg-emerald-950/40 border border-emerald-500/30 flex items-center justify-between">
                  <div className="flex items-center space-x-3">
                    {googleAccount.picture ? (
                      <img src={googleAccount.picture} alt="" className="w-9 h-9 rounded-full ring-2 ring-emerald-500/50" />
                    ) : (
                      <div className="w-9 h-9 rounded-full bg-emerald-600/30 text-emerald-300 font-bold flex items-center justify-center">
                        {googleAccount.email.charAt(0).toUpperCase()}
                      </div>
                    )}
                    <div>
                      <div className="flex items-center space-x-1.5">
                        <span className="font-semibold text-zinc-100">{googleAccount.name || 'Google Account'}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-medium">Direct Upload to Private Drive</span>
                      </div>
                      <p className="text-zinc-400 text-xs">{googleAccount.email}</p>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="p-3.5 rounded-xl bg-[#121215] border border-zinc-700 flex items-center justify-between">
                  <div>
                    <h4 className="font-semibold text-zinc-200">Google Drive Private Access</h4>
                    <p className="text-zinc-400 text-xs mt-0.5">Connect your Google Account to upload directly to private folders in your Drive.</p>
                  </div>
                  {onGoogleLogin && (
                    <button
                      type="button"
                      onClick={onGoogleLogin}
                      disabled={isLoggingIn}
                      className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-white border border-white/20 text-xs font-semibold flex items-center space-x-1.5"
                    >
                      <span>{isLoggingIn ? 'Connecting...' : 'Sign in with Google'}</span>
                    </button>
                  )}
                </div>
              )}

              <div>
                <label className="text-zinc-300 font-semibold block mb-1">Google Drive Folder ID:</label>
                <input
                  type="text"
                  value={formData.google_drive_folder_id}
                  onChange={(e) => handleChange('google_drive_folder_id', e.target.value)}
                  placeholder="e.g. 1a2b3c4d5e6f7g8h9i0"
                  className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 font-mono"
                />
              </div>

              <div className="pt-2">
                <button
                  type="button"
                  onClick={testDrive}
                  disabled={testStatus.drive?.loading}
                  className="px-3.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 font-semibold flex items-center space-x-1.5"
                >
                  <span>{testStatus.drive?.loading ? 'Testing...' : 'Test Drive Connection'}</span>
                </button>

                {testStatus.drive && (
                  <div
                    className={`mt-2 p-2 rounded text-xs font-semibold ${
                      testStatus.drive.success
                        ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                        : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                    }`}
                  >
                    {testStatus.drive.message}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Tab 5: GAS */}
          {activeTab === 'gas' && (
            <div className="space-y-4 text-xs">
              <h3 className="text-sm font-bold text-white mb-2">Google Apps Script Delivery Endpoint</h3>
              <p className="text-zinc-400 text-xs mb-4">
                The desktop app invokes this secured Web App endpoint to send authenticated PO emails via GmailApp.
              </p>

              <div>
                <label className="text-zinc-300 font-semibold block mb-1">Apps Script Webhook URL:</label>
                <input
                  type="text"
                  value={formData.gas_webhook_url}
                  onChange={(e) => handleChange('gas_webhook_url', e.target.value)}
                  placeholder="https://script.google.com/macros/s/AKfycb.../exec"
                  className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 font-mono"
                />
              </div>

              <div>
                <label className="text-zinc-300 font-semibold block mb-1">Webhook Secret / Authorization Key:</label>
                <div className="relative">
                  <input
                    type={showSecret ? 'text' : 'password'}
                    value={formData.gas_auth_secret}
                    onChange={(e) => handleChange('gas_auth_secret', e.target.value)}
                    className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg pl-3 pr-10 py-2 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setShowSecret(!showSecret)}
                    className="absolute right-3 top-2.5 text-zinc-400 hover:text-white"
                  >
                    {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div className="pt-2">
                <button
                  type="button"
                  onClick={testGas}
                  disabled={testStatus.gas?.loading}
                  className="px-3.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 font-semibold flex items-center space-x-1.5"
                >
                  <span>{testStatus.gas?.loading ? 'Testing...' : 'Test Webhook Endpoint'}</span>
                </button>

                {testStatus.gas && (
                  <div
                    className={`mt-2 p-2 rounded text-xs font-semibold ${
                      testStatus.gas.success
                        ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                        : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                    }`}
                  >
                    {testStatus.gas.message}
                  </div>
                )}
              </div>

              {renderAutoSendOptionsPanel()}
            </div>
          )}

          {/* Tab 6: Email Template */}
          {activeTab === 'template' && (
            <div className="space-y-4 text-xs">
              <h3 className="text-sm font-bold text-white mb-2">Automated Email Templates</h3>
              <p className="text-zinc-400 text-xs mb-4">
                Available placeholders: <code className="text-blue-300 font-mono">{'{{PO_NUMBER}}'}</code>,{' '}
                <code className="text-blue-300 font-mono">{'{{COMPANY_NAME}}'}</code>,{' '}
                <code className="text-blue-300 font-mono">{'{{DATE}}'}</code>
              </p>

              <div>
                <label className="text-zinc-300 font-semibold block mb-1">Subject Line Template:</label>
                <input
                  type="text"
                  value={formData.email_subject_template}
                  onChange={(e) => handleChange('email_subject_template', e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 font-medium"
                />
              </div>

              <div>
                <label className="text-zinc-300 font-semibold block mb-1">Email Body Template:</label>
                <textarea
                  rows={6}
                  value={formData.email_body_template}
                  onChange={(e) => handleChange('email_body_template', e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 font-mono text-xs leading-relaxed"
                />
              </div>

              <div>
                <label className="text-zinc-300 font-semibold block mb-1">
                  Email Attachment Format (Gmail Preview):
                </label>
                <select
                  value={formData.email_attachment_mode || 'individual_files'}
                  onChange={(e) =>
                    handleChange(
                      'email_attachment_mode',
                      e.target.value as 'individual_files' | 'zip_archive' | 'both'
                    )
                  }
                  className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 font-medium"
                >
                  <option value="individual_files">
                    Individual Files — PDFs &amp; Images Previewable in Gmail (Recommended)
                  </option>
                  <option value="both">Both Individual Previewable Files + ZIP Archive</option>
                  <option value="zip_archive">Single Compressed ZIP File Only (.zip)</option>
                </select>
              </div>
            </div>
          )}

          {/* Tab 7: Security */}
          {activeTab === 'security' && (
            <div className="space-y-4 text-xs">
              <h3 className="text-sm font-bold text-white mb-2">Security, Encryption & File Safeguards</h3>
              <p className="text-zinc-400 text-xs mb-4">
                Enterprise protections preventing directory traversal, ZIP decompression bombs, and duplicate transactions.
              </p>

              <div>
                <label className="text-zinc-300 font-semibold block mb-1">Maximum ZIP Size Limit (MB):</label>
                <input
                  type="number"
                  value={formData.max_zip_file_mb}
                  onChange={(e) => handleChange('max_zip_file_mb', parseInt(e.target.value) || 25)}
                  className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 font-mono"
                />
                <p className="text-[11px] text-zinc-500 mt-1">If the PO package exceeds 20MB, Apps Script automatically provides a secure Google Drive link instead of direct mail attachment.</p>
              </div>

              <div className="p-3.5 rounded-lg bg-zinc-950/70 border border-zinc-800 space-y-2">
                <div className="flex items-center space-x-2 text-emerald-400 font-semibold">
                  <ShieldCheck className="w-4 h-4" />
                  <span>Security Guarantees Active</span>
                </div>
                <ul className="list-disc pl-4 text-zinc-400 text-[11px] space-y-1">
                  <li>Deterministic SHA-256 and folder fingerprinting prevent duplicate emails.</li>
                  <li>Strict path canonicalization prevents directory traversal attacks.</li>
                  <li>Local SQLite database stores an immutable audit log of all operations.</li>
                </ul>
              </div>
            </div>
          )}

          {/* Tab 8: Developer & Debugging */}
          {activeTab === 'developer' && (
            <div className="space-y-4 text-xs">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold text-white">Developer Options & Diagnostics</h3>
                  <p className="text-zinc-400 text-xs">
                    Configure runtime debugging flags, dry-run simulation, and inspect system internals.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await api.openDevTools();
                    } catch (e) {
                      console.error(e);
                    }
                  }}
                  className="px-3 py-1.5 rounded-lg bg-amber-600/30 hover:bg-amber-600/40 text-amber-300 font-semibold border border-amber-500/40 flex items-center space-x-1.5 transition-colors"
                >
                  <Bug className="w-3.5 h-3.5" />
                  <span>Open DevTools (F12)</span>
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2">
                <div className="p-3.5 rounded-lg bg-zinc-900/70 border border-zinc-700 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-zinc-200">Developer Mode</span>
                    <input
                      type="checkbox"
                      checked={!!formData.developer_mode_enabled}
                      onChange={(e) => handleChange('developer_mode_enabled', e.target.checked)}
                      className="h-4 w-4 rounded border-zinc-700 bg-zinc-800 text-blue-600 focus:ring-0 cursor-pointer"
                    />
                  </div>
                  <p className="text-[11px] text-zinc-400">
                    Enables diagnostic telemetry and deep inspection tools across the UI.
                  </p>
                </div>

                <div className="p-3.5 rounded-lg bg-zinc-900/70 border border-zinc-700 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-zinc-200">Verbose Debug Logging</span>
                    <input
                      type="checkbox"
                      checked={!!formData.debug_logging_enabled}
                      onChange={(e) => handleChange('debug_logging_enabled', e.target.checked)}
                      className="h-4 w-4 rounded border-zinc-700 bg-zinc-800 text-blue-600 focus:ring-0 cursor-pointer"
                    />
                  </div>
                  <p className="text-[11px] text-zinc-400">
                    Logs detailed stage execution, regex matches, and timing benchmarks to database.
                  </p>
                </div>

                <div className="p-3.5 rounded-lg bg-zinc-900/70 border border-zinc-700 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-amber-300">Dry-Run / Simulation Mode</span>
                    <input
                      type="checkbox"
                      checked={!!formData.dry_run_simulation_mode}
                      onChange={(e) => handleChange('dry_run_simulation_mode', e.target.checked)}
                      className="h-4 w-4 rounded border-zinc-700 bg-zinc-800 text-amber-500 focus:ring-0 cursor-pointer"
                    />
                  </div>
                  <p className="text-[11px] text-zinc-400">
                    Processes PO folders completely but mocks Drive upload and Gmail sending. No actual emails will be dispatched.
                  </p>
                </div>

                <div className="p-3.5 rounded-lg bg-zinc-900/70 border border-zinc-700 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-zinc-200">Save OCR Preprocessing Artifacts</span>
                    <input
                      type="checkbox"
                      checked={!!formData.save_debug_ocr_images}
                      onChange={(e) => handleChange('save_debug_ocr_images', e.target.checked)}
                      className="h-4 w-4 rounded border-zinc-700 bg-zinc-800 text-blue-600 focus:ring-0 cursor-pointer"
                    />
                  </div>
                  <p className="text-[11px] text-zinc-400">
                    Saves deskewed, contrast-enhanced and thresholded images to Temp\debug_ocr.
                  </p>
                </div>
              </div>

              <div className="pt-2">
                <label className="text-zinc-300 font-semibold block mb-2">Quick Directory Launchers:</label>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => api.openPathInExplorer(formData.incoming_dir)}
                    className="px-2.5 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs border border-zinc-700"
                  >
                    Open Incoming
                  </button>
                  <button
                    type="button"
                    onClick={() => api.openPathInExplorer(formData.processing_dir)}
                    className="px-2.5 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs border border-zinc-700"
                  >
                    Open Processing
                  </button>
                  <button
                    type="button"
                    onClick={() => api.openPathInExplorer(formData.sent_dir)}
                    className="px-2.5 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs border border-zinc-700"
                  >
                    Open Sent
                  </button>
                  <button
                    type="button"
                    onClick={() => api.openPathInExplorer(formData.failed_dir)}
                    className="px-2.5 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs border border-zinc-700"
                  >
                    Open Failed
                  </button>
                  <button
                    type="button"
                    onClick={() => api.openPathInExplorer(formData.review_dir)}
                    className="px-2.5 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs border border-zinc-700"
                  >
                    Open Review
                  </button>
                  <button
                    type="button"
                    onClick={() => api.openPathInExplorer(formData.logs_dir)}
                    className="px-2.5 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs border border-zinc-700"
                  >
                    Open Logs
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Software Updates & GitHub Release Channel */}
      <div className="bg-[#121215] rounded-xl border border-zinc-800 p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <GitBranch className="w-4 h-4 text-blue-400" />
              <span>Software Updates &amp; GitHub Release Channel</span>
            </h3>
            <p className="text-xs text-zinc-400">
              Connected Repository:{' '}
              <a
                href={`https://github.com/${updateStatus?.repository || 'oscarpooper-lang/po-autoflow-enterprise'}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:underline font-mono inline-flex items-center gap-1"
              >
                <span>
                  https://github.com/{updateStatus?.repository || 'oscarpooper-lang/po-autoflow-enterprise'}
                </span>
                <ExternalLink className="w-3 h-3" />
              </a>
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCheckUpdates}
              disabled={checkingUpdate || installingUpdate}
              className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold border border-zinc-700 flex items-center gap-1.5 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${checkingUpdate ? 'animate-spin' : ''}`} />
              <span>{checkingUpdate ? 'Checking...' : 'Check for Updates'}</span>
            </button>

            <button
              type="button"
              onClick={handleInstallUpdate}
              disabled={installingUpdate || !updateStatus?.update_available}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                updateStatus?.update_available
                  ? 'bg-blue-600 hover:bg-blue-500 text-white'
                  : 'bg-zinc-900 text-zinc-500 border border-zinc-800 cursor-not-allowed'
              }`}
            >
              <Download className="w-3.5 h-3.5" />
              <span>
                {installingUpdate
                  ? 'Downloading...'
                  : updateStatus?.update_available
                  ? `Download & Install v${updateStatus.latest_version}`
                  : 'Download & Install Update'}
              </span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
          <div className="p-3 rounded-lg bg-zinc-950/70 border border-zinc-800">
            <span className="text-zinc-500 block text-[11px]">Installed Version</span>
            <span className="text-zinc-100 font-mono font-semibold text-sm">
              v{updateStatus?.current_version || '1.0.0'}
            </span>
          </div>
          <div className="p-3 rounded-lg bg-zinc-950/70 border border-zinc-800">
            <span className="text-zinc-500 block text-[11px]">Latest GitHub Release</span>
            <span
              className={`font-mono font-semibold text-sm ${
                updateStatus?.update_available ? 'text-emerald-400' : 'text-zinc-100'
              }`}
            >
              v{updateStatus?.latest_version || '1.0.0'}
              {updateStatus?.update_available ? ' (Update Available)' : ''}
            </span>
          </div>
          <div className="p-3 rounded-lg bg-zinc-950/70 border border-zinc-800">
            <span className="text-zinc-500 block text-[11px]">Installer Asset</span>
            <span className="text-zinc-200 font-mono text-[11px] truncate block">
              {updateStatus?.installer_name || 'Auto-detected from GitHub Releases'}
            </span>
          </div>
        </div>

        {updateActionMsg && (
          <div className="p-2.5 rounded-lg bg-blue-500/10 border border-blue-500/30 text-blue-300 text-xs">
            {updateActionMsg}
          </div>
        )}
        {updateError && (
          <div className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-xs">
            {updateError}
          </div>
        )}

        {updateStatus?.release_notes && (
          <div className="p-3 rounded-lg bg-zinc-950/80 border border-zinc-800 text-xs space-y-1">
            <span className="text-zinc-400 font-semibold block">Release Notes ({updateStatus.release_name}):</span>
            <pre className="text-zinc-300 font-sans whitespace-pre-wrap text-[11px] leading-relaxed">
              {updateStatus.release_notes}
            </pre>
          </div>
        )}

        <div className="p-3 rounded-lg bg-zinc-950/60 border border-zinc-800/80 text-[11px] text-zinc-400 flex flex-wrap items-center justify-between gap-2">
          <span>
            To publish a new update from your dev PC: run{' '}
            <code className="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-200 font-mono">
              .\scripts\publish-update.ps1 -Version &quot;1.0.1&quot; -Notes &quot;Your fix&quot;
            </code>{' '}
            or push a git tag{' '}
            <code className="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-200 font-mono">
              git tag v1.0.1 &amp;&amp; git push origin main --tags
            </code>
          </span>
        </div>
      </div>
    </div>
  );
};

