import React, { useState, useEffect, useMemo } from 'react';
import { usePersistedState } from '../utils/persistedState';
import { refreshAiChatStatus } from '../utils/aiChatStore';
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
  Trash2,
  Check,
  HardDrive,
  Play,
  AlertTriangle,
} from 'lucide-react';
import type {
  AppSettings,
  GoogleAccountInfo,
  LearningStats,
  LocalVisionStatus,
  BuiltInVisionStatus,
} from '../types';
import {
  api,
  checkGitHubUpdate,
  installGitHubUpdate,
  type GitHubUpdateStatus,
  type OcrEngineStatus,
  type OcrSelfTestResult,
} from '../services/tauri';
import { remapWorkspacePaths } from '../utils/workspacePaths';
import { resolveUiLang, tr, tx, type UiLang } from '../i18n';

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
  const [activeTab, setActiveTab] = usePersistedState('settings.activeTab', 'folders');
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
  const [builtInVision, setBuiltInVision] = useState<BuiltInVisionStatus | null>(null);
  const [downloadingModelId, setDownloadingModelId] = useState<string | null>(null);
  const [ocrEngineStatus, setOcrEngineStatus] = useState<OcrEngineStatus | null>(null);
  const [installingOpenThai, setInstallingOpenThai] = useState(false);
  const [upgradingVulkan, setUpgradingVulkan] = useState(false);
  const [selfTestLoading, setSelfTestLoading] = useState(false);
  const [selfTestResult, setSelfTestResult] = useState<OcrSelfTestResult | null>(null);
  const [selfTestError, setSelfTestError] = useState<string | null>(null);
  const [showAdvancedEngine, setShowAdvancedEngine] = useState(false);
  const [packagePref, setPackagePref] = usePersistedState<'auto' | 'msi' | 'nsis'>(
    'settings.packagePref',
    'auto'
  );
  const lang: UiLang = resolveUiLang(formData);

  const handleInstallOpenThai = async () => {
    setInstallingOpenThai(true);
    setSelfTestError(null);
    try {
      const updated = await api.installOpenThaiOcr();
      setOcrEngineStatus(updated);
      if (formData.ocr_engine_primary === 'paddleocr') {
        handleChange('ocr_engine_primary', 'openthaigpt');
      }
    } catch (err: unknown) {
      setSelfTestError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstallingOpenThai(false);
    }
  };

  const handleUpgradeVulkanEngine = async () => {
    setUpgradingVulkan(true);
    setSelfTestError(null);
    try {
      const vis = await api.installVulkanVisionEngine();
      setBuiltInVision(vis);
      const status = await api.getOcrEngineStatus().catch(() => null);
      if (status) setOcrEngineStatus(status);
    } catch (err: unknown) {
      setSelfTestError(err instanceof Error ? err.message : String(err));
    } finally {
      setUpgradingVulkan(false);
    }
  };

  const handleRunSelfTest = async () => {
    setSelfTestLoading(true);
    setSelfTestError(null);
    try {
      const res = await api.runOcrSelfTest();
      setSelfTestResult(res);
    } catch (err: unknown) {
      setSelfTestError(err instanceof Error ? err.message : String(err));
    } finally {
      setSelfTestLoading(false);
    }
  };

  const handleTestLocalVision = async () => {
    setTestingVision(true);
    try {
      const activeModel =
        builtInVision?.active_model_id || formData.local_vision_model || 'smolvlm2-2.2b';
      const res = await api.testLocalVisionAi('builtin', '', activeModel);
      setVisionStatus(res);
    } catch (err: any) {
      setVisionStatus({
        reachable: false,
        endpoint: formData.local_vision_endpoint || '',
        configured_model: formData.local_vision_model || 'smolvlm2-2.2b',
        available_models: [],
        message:
          typeof err === 'string'
            ? err
            : err?.message || tx(lang, 'Test failed', 'ทดสอบไม่สำเร็จ'),
      });
    } finally {
      setTestingVision(false);
    }
  };

  const handleDownloadBuiltInModel = async (modelId: string) => {
    setDownloadingModelId(modelId);
    setVisionStatus(null);
    try {
      const res = await api.downloadBuiltInVisionModel(modelId);
      setBuiltInVision(res);
    } catch (err: any) {
      setVisionStatus({
        reachable: false,
        endpoint: '',
        configured_model: modelId,
        available_models: [],
        message:
          typeof err === 'string'
            ? err
            : err?.message || tx(lang, 'Failed to start download', 'เริ่มดาวน์โหลดไม่สำเร็จ'),
      });
    } finally {
      setDownloadingModelId(null);
    }
  };

  const handleSelectBuiltInModel = async (modelId: string) => {
    const next: AppSettings = {
      ...formData,
      local_vision_enabled: true,
      local_vision_provider: 'builtin',
      local_vision_model: modelId,
    };
    setFormData(next);
    await onSaveSettings(next);
    const updated = await api.getBuiltInVisionStatus().catch(() => null);
    if (updated) setBuiltInVision(updated);
    refreshAiChatStatus(false);
  };

  const handleDeleteBuiltInModel = async (modelId: string) => {
    try {
      const updated = await api.deleteBuiltInVisionModel(modelId);
      setBuiltInVision(updated);
      if (formData.local_vision_model === modelId) {
        setFormData((prev) => ({ ...prev, local_vision_enabled: false }));
      }
      refreshAiChatStatus(false);
    } catch (err: any) {
      setVisionStatus({
        reachable: false,
        endpoint: '',
        configured_model: modelId,
        available_models: [],
        message:
          typeof err === 'string'
            ? err
            : err?.message || tx(lang, 'Failed to delete model', 'ลบไฟล์โมเดลไม่สำเร็จ'),
      });
    }
  };

  const handleCheckUpdates = async (prefOverride?: 'auto' | 'msi' | 'nsis') => {
    setCheckingUpdate(true);
    setUpdateError(null);
    setUpdateActionMsg(null);
    const pref = prefOverride ?? packagePref;
    try {
      const res = await checkGitHubUpdate(undefined, pref);
      setUpdateStatus(res);
      setUpdateActionMsg(
        res.update_available
          ? tx(
              lang,
              `New version v${res.latest_version} (${res.installer_name}) is ready!`,
              `มีเวอร์ชันใหม่ v${res.latest_version} (${res.installer_name}) พร้อมอัปเดต!`
            )
          : tx(
              lang,
              `You are running the latest version (v${res.current_version}).`,
              `คุณกำลังใช้งานเวอร์ชันล่าสุดแล้ว (v${res.current_version})`
            )
      );
    } catch (err: any) {
      setUpdateError(
        typeof err === 'string'
          ? err
          : err?.message || tx(lang, 'Failed to check updates', 'ตรวจสอบอัปเดตไม่สำเร็จ')
      );
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
    setUpdateActionMsg(
      tx(lang, 'Downloading installer from GitHub Releases...', 'กำลังดาวน์โหลดตัวติดตั้งจาก GitHub Releases...')
    );
    try {
      const launchedPath = await installGitHubUpdate(
        updateStatus.installer_url,
        updateStatus.installer_name || undefined
      );
      setUpdateActionMsg(
        tx(
          lang,
          `Installer launched from ${launchedPath}. Follow the Windows installer prompts.`,
          `เปิดตัวติดตั้งจาก ${launchedPath} แล้ว กรุณาทำตามขั้นตอนติดตั้งบนหน้าจอ`
        )
      );
    } catch (err: any) {
      setUpdateError(
        typeof err === 'string'
          ? err
          : err?.message || tx(lang, 'Failed to install update', 'ติดตั้งอัปเดตไม่สำเร็จ')
      );
    } finally {
      setInstallingUpdate(false);
    }
  };

  useEffect(() => {
    checkGitHubUpdate(undefined, 'auto')
      .then((res) => setUpdateStatus(res))
      .catch(() => {});
    api
      .getLearningStats()
      .then((stats) => setLearningStats(stats))
      .catch(() => {});
    api
      .getBuiltInVisionStatus()
      .then((status) => setBuiltInVision(status))
      .catch(() => {});
    api
      .getOcrEngineStatus()
      .then((status) => setOcrEngineStatus(status))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!builtInVision?.download?.active) return;
    const timer = setInterval(() => {
      api
        .getBuiltInVisionStatus()
        .then((res) => {
          setBuiltInVision(res);
          if (!res.download.active && res.download.stage === 'completed') {
            setFormData((prev) => ({
              ...prev,
              local_vision_enabled: true,
              local_vision_provider: 'builtin',
              local_vision_model: res.active_model_id,
            }));
          }
        })
        .catch(() => {});
    }, 800);
    return () => clearInterval(timer);
  }, [builtInVision?.download?.active]);

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
        formData.gas_auth_secret,
        formData.google_sheets_ov_tab_name
      );
      setTestStatus((prev) => ({
        ...prev,
        sheets: {
          loading: false,
          success: true,
          message: tx(
            lang,
            `Successfully connected! Loaded ${count} company rows.`,
            `เชื่อมต่อสำเร็จ! โหลดข้อมูลผู้ขาย ${count} แถว`
          ),
        },
      }));
    } catch (err: any) {
      setTestStatus((prev) => ({
        ...prev,
        sheets: {
          loading: false,
          success: false,
          message: tx(lang, `Connection failed: ${err}`, `เชื่อมต่อไม่สำเร็จ: ${err}`),
        },
      }));
    }
  };

  const testDrive = async () => {
    setTestStatus((prev) => ({ ...prev, drive: { loading: true } }));
    try {
      const ok = await api.testDriveConnection(formData.google_drive_folder_id);
      setTestStatus((prev) => ({
        ...prev,
        drive: {
          loading: false,
          success: ok,
          message: ok
            ? tx(lang, 'Drive folder ID verified!', 'ตรวจสอบ Google Drive Folder ID สำเร็จ!')
            : tx(lang, 'Invalid Drive Folder', 'Google Drive Folder ID ไม่ถูกต้อง'),
        },
      }));
    } catch (err: any) {
      setTestStatus((prev) => ({
        ...prev,
        drive: {
          loading: false,
          success: false,
          message: tx(lang, `Drive test failed: ${err}`, `ทดสอบ Google Drive ไม่สำเร็จ: ${err}`),
        },
      }));
    }
  };

  const testGas = async () => {
    setTestStatus((prev) => ({ ...prev, gas: { loading: true } }));
    try {
      const ok = await api.testGasConnection(formData.gas_webhook_url, formData.gas_auth_secret);
      setTestStatus((prev) => ({
        ...prev,
        gas: {
          loading: false,
          success: ok,
          message: ok
            ? tx(lang, 'Apps Script Webhook & AUTH_SECRET verified!', 'ตรวจสอบ Apps Script Webhook และ AUTH_SECRET ผ่านแล้ว!')
            : tx(lang, 'Endpoint returned error', 'Webhook ตอบกลับข้อผิดพลาด'),
        },
      }));
    } catch (err: any) {
      setTestStatus((prev) => ({
        ...prev,
        gas: {
          loading: false,
          success: false,
          message: tx(lang, `Webhook unreachable: ${err}`, `ติดต่อ Webhook ไม่ได้: ${err}`),
        },
      }));
    }
  };

  const tabs = [
    { id: 'folders', label: tr(lang, 'tabFolders'), icon: FolderOpen },
    { id: 'ocr', label: tr(lang, 'tabOcr'), icon: Cpu },
    { id: 'sheets', label: tr(lang, 'tabSheets'), icon: Building2 },
    { id: 'drive', label: tr(lang, 'tabDrive'), icon: CloudUpload },
    { id: 'gas', label: tr(lang, 'tabGas'), icon: Mail },
    { id: 'template', label: tr(lang, 'tabTemplate'), icon: Mail },
    { id: 'security', label: lang === 'th' ? 'ความปลอดภัยและตรวจสอบซ้ำ' : 'Security & Integrity', icon: ShieldCheck },
    { id: 'developer', label: lang === 'th' ? 'นักพัฒนาและดีบัก' : 'Developer & Debugging', icon: Terminal },
  ];

  const renderAutoSendOptionsPanel = () => (
    <div className="p-4 rounded-xl bg-zinc-950/70 border border-zinc-800 space-y-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h4 className="font-semibold text-white flex items-center gap-1.5">
            <Send className="w-3.5 h-3.5 text-emerald-400" />
            <span>{tx(lang, 'Auto-Send Email Options', 'ตัวเลือกการส่งอีเมลอัตโนมัติ')}</span>
          </h4>
          <p className="text-[11px] text-zinc-400 mt-0.5">
            {tx(
              lang,
              'Control when POs send automatically versus holding in Needs Review for manual approval.',
              'กำหนดเงื่อนไขการส่งอัตโนมัติเทียบกับการพักไว้ในหน้าตรวจสอบเพื่อให้คุณกดยืนยันเอง'
            )}
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
              ? tx(lang, 'Enabled', 'เปิดใช้งาน')
              : tx(lang, 'Paused (Manual Only)', 'พักไว้ (อนุมัติเองทุกฉบับ)')}
          </span>
        </label>
      </div>

      <div>
        <label className="text-zinc-300 font-medium block mb-1">
          {tx(lang, 'Auto-Send Confidence Rule:', 'เกณฑ์ความมั่นใจสำหรับการส่งอัตโนมัติ:')}
        </label>
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
            {tx(
              lang,
              `Verified & High Confidence (≥ ${formData.ocr_confidence_threshold_high}% single match) — Recommended`,
              `ยืนยันและมั่นใจสูง (≥ ${formData.ocr_confidence_threshold_high}% ตรงรายเดียว) — แนะนำ`
            )}
          </option>
          <option value="verified_only">
            {tx(
              lang,
              `Strict Verified Only (≥ ${formData.ocr_confidence_threshold_verified}% exact/alias match)`,
              `เข้มงวดเฉพาะรายการยืนยัน (≥ ${formData.ocr_confidence_threshold_verified}% ตรงเป๊ะหรือตรงชื่อสำรอง)`
            )}
          </option>
          <option value="manual_review_all">
            {tx(
              lang,
              'Manual Review All (Never auto-send — hold every PO in Needs Review)',
              'ตรวจสอบเองทั้งหมด (ไม่ส่งอัตโนมัติ พักรอตรวจทุกใบ)'
            )}
          </option>
        </select>
      </div>

      <div>
        <label className="text-zinc-300 font-medium block mb-1">
          {tx(lang, 'Email Attachment Format (Gmail):', 'รูปแบบไฟล์แนบอีเมล (Gmail):')}
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
            {tx(
              lang,
              'Individual Files — PDFs & Images Previewable in Gmail (Recommended)',
              'แยกเป็นไฟล์เดี่ยว — เปิดพรีวิว PDF และรูปใน Gmail ได้ทันที (แนะนำ)'
            )}
          </option>
          <option value="both">
            {tx(lang, 'Both Individual Previewable Files + ZIP Archive', 'ส่งทั้งไฟล์เดี่ยวพรีวิวได้ + ไฟล์ ZIP')}
          </option>
          <option value="zip_archive">
            {tx(lang, 'Single Compressed ZIP File Only (.zip)', 'ส่งเป็นไฟล์บีบอัด .zip อย่างเดียว')}
          </option>
        </select>
        <p className="text-[11px] text-zinc-400 mt-1">
          {tx(
            lang,
            'Sending individual files allows suppliers to preview PDFs and images directly inside Gmail instead of downloading/unzipping a single .zip archive.',
            'การส่งแบบแยกไฟล์ช่วยให้ผู้ขายเปิดดู PDF และรูปภาพใน Gmail ได้ทันทีโดยไม่ต้องดาวน์โหลดไปแตกไฟล์ .zip'
          )}
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
              {tx(lang, 'Require Cloud Google Drive Backup Before Dispatch', 'ต้องสำรองไฟล์ขึ้น Google Drive สำเร็จก่อนจึงส่งอีเมล')}
            </span>
            <span className="text-[11px] text-zinc-400">
              {tx(
                lang,
                'Hold in Needs Review if Drive cloud upload is offline instead of continuing with a local reference.',
                'หากอัปโหลดขึ้น Drive ไม่ได้ ให้พักไว้รอตรวจสอบแทนการส่งต่ออัตโนมัติ'
              )}
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
              {tx(lang, 'Allow PDF-Extracted Vendor Email Fallback', 'อนุญาตให้ใช้อีเมลผู้ขายที่อ่านเจอใน PDF เป็นตัวสำรอง')}
            </span>
            <span className="text-[11px] text-zinc-400">
              {tx(
                lang,
                'If a supplier is missing from Google Sheets, use the non-QTC vendor email found inside the PO/quotation PDF.',
                'หากไม่พบผู้ขายใน Google Sheets ให้ใช้อีเมลของซัพพลายเออร์ที่อ่านพบในใบ PO/ใบเสนอราคา (โดยกรองอีเมล QTC ออกเสมอ)'
              )}
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
              {tx(lang, 'Dry-Run Simulation Mode (Test Only — Never Send Real Emails)', 'โหมดจำลอง (Dry-Run — สำหรับทดสอบเท่านั้น ไม่ส่งอีเมลจริง)')}
            </span>
            <span className="text-[11px] text-zinc-400">
              {tx(
                lang,
                'Runs OCR, matching, and ZIP creation while mocking Google Drive upload and Gmail dispatch.',
                'ทำงานครบทั้ง OCR จับคู่ผู้ขาย และจัดเตรียมไฟล์ แต่จำลองการส่ง Google Drive และ Gmail โดยไม่ส่งจริง'
              )}
            </span>
          </span>
        </label>
      </div>
    </div>
  );

  const hasUnsavedChanges = useMemo(
    () => JSON.stringify(formData) !== JSON.stringify(initialSettings),
    [formData, initialSettings]
  );

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-bold text-white flex items-center gap-2">
            <SettingsIcon className="w-5 h-5 text-blue-400" />
            {tr(lang, 'settingsHeading')}
          </h2>
          <p className="text-xs text-zinc-400">
            {tr(lang, 'settingsSub')}
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          {hasUnsavedChanges && (
            <span className="px-2.5 py-1 rounded-full bg-amber-500/15 border border-amber-500/40 text-amber-300 text-[11px] font-medium flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
              {tx(lang, 'Unsaved changes', 'มีการแก้ไขที่ยังไม่บันทึก')}
            </span>
          )}
          <button
            type="button"
            onClick={handleSave}
            disabled={isSaving}
            className={`px-4 py-2 rounded-lg text-white text-xs font-semibold shadow-md transition-all flex items-center space-x-1.5 ${
              hasUnsavedChanges
                ? 'bg-amber-600 hover:bg-amber-500 shadow-amber-500/25 ring-2 ring-amber-400/40'
                : 'bg-blue-600 hover:bg-blue-500 shadow-blue-500/20'
            }`}
          >
            <Save className="w-4 h-4" />
            <span>{isSaving ? tr(lang, 'saving') : tr(lang, 'saveConfig')}</span>
          </button>
        </div>
      </div>

      {saveToast && (
        <div className="p-3 rounded-lg bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 text-xs font-semibold flex items-center space-x-2">
          <CheckCircle2 className="w-4 h-4" />
          <span>{tr(lang, 'savedBanner')}</span>
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
              <div className="p-4 rounded-xl bg-zinc-950/90 border border-zinc-800 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-bold text-white">{tr(lang, 'languageCardTitle')}</h3>
                  <p className="text-[11px] text-zinc-400 mt-0.5">{tr(lang, 'languageCardDesc')}</p>
                </div>
                <div className="inline-flex rounded-lg bg-zinc-900 border border-zinc-700 p-0.5">
                  {(['en', 'th'] as const).map((choice) => {
                    const active = (formData.ui_language === 'th' ? 'th' : 'en') === choice;
                    return (
                      <button
                        key={choice}
                        type="button"
                        onClick={() => {
                          const updated = { ...formData, ui_language: choice };
                          setFormData(updated);
                          void onSaveSettings(updated);
                        }}
                        className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                          active
                            ? 'bg-blue-600 text-white shadow-sm'
                            : 'text-zinc-400 hover:text-zinc-200'
                        }`}
                      >
                        {choice === 'en' ? 'English' : 'ภาษาไทย (TH)'}
                      </button>
                    );
                  })}
                </div>
              </div>

              <h3 className="text-sm font-bold text-white mb-2">
                {lang === 'th' ? 'โครงสร้างโฟลเดอร์อัตโนมัติ' : 'Automated Folder Structure'}
              </h3>
              <p className="text-zinc-400 text-xs mb-4">
                {tx(
                  lang,
                  'Set your Workspace Root (for example D:\\PO-AutoFlow) to keep PO folders and AI models off Drive C. Non-existent folders are created automatically when you save.',
                  'กำหนดโฟลเดอร์หลักของระบบ (เช่น D:\\PO-AutoFlow) เพื่อแยกเก็บงาน PO และโมเดล AI ออกจากไดรฟ์ C โฟลเดอร์ที่ยังไม่มีจะถูกสร้างอัตโนมัติเมื่อกดบันทึก'
                )}
              </p>

              <div className="p-3.5 rounded-xl bg-zinc-950/80 border border-zinc-800 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="text-zinc-200 font-semibold">
                    {tx(lang, 'Workspace Root Directory (Base + AI Models):', 'โฟลเดอร์หลักของระบบ (งาน PO + โมเดล AI):')}
                  </label>
                  <button
                    type="button"
                    onClick={() =>
                      setFormData((prev) => remapWorkspacePaths(prev, prev.root_dir, true))
                    }
                    className="px-2.5 py-1 rounded-md bg-blue-600/20 hover:bg-blue-600/30 border border-blue-500/40 text-blue-300 text-[11px] font-medium"
                  >
                    {tx(lang, 'Apply Root to All Subfolders', 'ปรับโฟลเดอร์ย่อยทั้งหมดตาม Root')}
                  </button>
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={formData.root_dir}
                    onChange={(e) =>
                      setFormData((prev) => remapWorkspacePaths(prev, e.target.value))
                    }
                    className="flex-1 bg-zinc-800 border border-zinc-700 text-zinc-100 rounded-lg px-3 py-2 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => api.openPathInExplorer(formData.root_dir)}
                    className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 flex items-center gap-1"
                  >
                    <FolderOpen className="w-3.5 h-3.5 text-amber-400" />
                    <span>{tx(lang, 'Open', 'เปิด')}</span>
                  </button>
                </div>
                <p className="text-[11px] text-zinc-500">
                  {tx(lang, 'Built-in AI models store under', 'ไฟล์โมเดล AI และภาษาจะถูกเก็บไว้ใน')}{' '}
                  <code className="text-zinc-300 font-mono">
                    {`${(formData.root_dir || '').replace(/[\\/]+$/, '')}\\Models`}
                  </code>
                  .
                </p>
              </div>

              <div className="grid grid-cols-1 gap-4">
                <div>
                  <label className="text-zinc-300 font-semibold block mb-1">
                    {tx(lang, 'Incoming PO Directory (Monitored):', 'โฟลเดอร์ Incoming (รับเข้าและเฝ้าดูอัตโนมัติ):')}
                  </label>
                  <input
                    type="text"
                    value={formData.incoming_dir}
                    onChange={(e) => handleChange('incoming_dir', e.target.value)}
                    className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 font-mono"
                  />
                  <p className="text-[11px] text-zinc-500 mt-1">
                    {tx(lang, 'Users drop new PO folders directly into this location.', 'ผู้ใช้สามารถนำโฟลเดอร์ PO ใหม่มาวางในโฟลเดอร์นี้ได้ทันที')}
                  </p>
                </div>

                <div>
                  <label className="text-zinc-300 font-semibold block mb-1">
                    {tx(lang, 'Processing Directory (Active Lock):', 'โฟลเดอร์ Processing (กำลังประมวลผล):')}
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
                    {tx(lang, 'Sent Directory (Completed):', 'โฟลเดอร์ Sent (จัดส่งเรียบร้อยแล้ว):')}
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
                    {tx(lang, 'Review Directory (Low Confidence / Manual Action Required):', 'โฟลเดอร์ Review (พักไว้รอตรวจสอบ / อนุมัติด้วยตนเอง):')}
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
                    {tx(lang, 'Failed Directory (Errors):', 'โฟลเดอร์ Failed (พบข้อผิดพลาด):')}
                  </label>
                  <input
                    type="text"
                    value={formData.failed_dir}
                    onChange={(e) => handleChange('failed_dir', e.target.value)}
                    className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 font-mono"
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="text-zinc-300 font-semibold block mb-1">
                      {tx(lang, 'Temp / Archive Staging Directory:', 'โฟลเดอร์ชั่วคราว (Temp / Staging):')}
                    </label>
                    <input
                      type="text"
                      value={formData.temp_dir}
                      onChange={(e) => handleChange('temp_dir', e.target.value)}
                      className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 font-mono"
                    />
                  </div>
                  <div>
                    <label className="text-zinc-300 font-semibold block mb-1">
                      {tx(lang, 'Logs Directory:', 'โฟลเดอร์บันทึก Log (Logs):')}
                    </label>
                    <input
                      type="text"
                      value={formData.logs_dir}
                      onChange={(e) => handleChange('logs_dir', e.target.value)}
                      className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 font-mono"
                    />
                  </div>
                </div>

                <div className="pt-2 grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-zinc-300 font-semibold block mb-1">
                      {tx(lang, 'Stability Check Delay (ms):', 'ระยะหน่วงเช็คไฟล์นิ่ง (ms):')}
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
                      {tx(lang, 'Consecutive Unvarying Checks:', 'จำนวนรอบเช็คไฟล์นิ่งต่อเนื่อง:')}
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
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-bold text-white">
                    {tx(lang, 'Document Reader & Vision AI', 'ตัวอ่านเอกสาร OCR และ Vision AI')}
                  </h3>
                  <p className="text-zinc-400 text-xs mt-0.5">
                    {tx(
                      lang,
                      'Crystal-clear view of what reads your PDFs and scans right now — test both in 1 click below.',
                      'ดูสถานะชัดเจนว่าเครื่องมือใดอ่านไฟล์ PDF และสแกนอยู่ตอนนี้ พร้อมทดสอบได้ใน 1 คลิก'
                    )}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => api.getOcrEngineStatus().then(setOcrEngineStatus).catch(() => {})}
                    className="px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 flex items-center gap-1 text-[11px]"
                  >
                    <RefreshCw className="w-3 h-3" />
                    <span>{tx(lang, 'Refresh Status', 'รีเฟรชสถานะ')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleRunSelfTest}
                    disabled={selfTestLoading}
                    className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white font-semibold flex items-center gap-1.5 text-[11px]"
                  >
                    <Play className={`w-3 h-3 ${selfTestLoading ? 'animate-pulse' : ''}`} />
                    <span>
                      {selfTestLoading
                        ? tx(lang, 'Testing OCR & AI...', 'กำลังทดสอบ OCR & AI...')
                        : tx(lang, 'Run Live Self-Test', 'ทดสอบอ่านเอกสารจริงทันที')}
                    </span>
                  </button>
                </div>
              </div>

              {/* Plain-English Live Engine Status Panel */}
              <div className="p-4 rounded-xl bg-zinc-950/80 border border-zinc-800 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-zinc-100">
                    {tx(lang, 'What Reads Your POs Right Now', 'เครื่องมือที่กำลังใช้อ่านเอกสาร PO ของคุณ')}
                  </span>
                  <span className="text-[11px] font-mono text-zinc-400">
                    {ocrEngineStatus?.python_version || tx(lang, 'checking...', 'กำลังตรวจสอบ...')} • Worker{' '}
                    {ocrEngineStatus?.worker_reachable
                      ? tx(lang, 'Online', 'พร้อมทำงาน')
                      : tx(lang, 'Offline', 'ออฟไลน์')}
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
                  <div className="p-3 rounded-lg bg-zinc-900/90 border border-zinc-800 space-y-1.5">
                    <div className="flex items-center justify-between gap-1">
                      <span className="font-semibold text-zinc-200">
                        {tx(lang, '1. Digital PDFs', '1. PDF ดิจิทัล (พิมพ์จากระบบ)')}
                      </span>
                      <span className="px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 text-[10px] font-semibold">
                        {tx(lang, 'ACTIVE', 'เปิดใช้')}
                      </span>
                    </div>
                    <p className="text-[11px] text-zinc-200 font-medium">
                      {tx(lang, 'Built-in Digital PDF Reader', 'ตัวอ่าน PDF ดิจิทัลในตัว')}
                    </p>
                    <p className="text-[10px] text-zinc-400 leading-relaxed">
                      {tx(
                        lang,
                        'Reads embedded text directly in ~0.02s and auto-cleans broken Thai font spacing. Hands image/garbled pages cleanly to OpenThai 2.0.',
                        'อ่านข้อความจาก PDF โดยตรงใน ~0.02 วินาที พร้อมแก้ปัญหาฟอนต์ไทยเพี้ยนอัตโนมัติ และส่งต่อหน้าสแกนให้ OpenThai 2.0'
                      )}
                    </p>
                  </div>

                  <div className="p-3 rounded-lg bg-zinc-900/90 border border-zinc-800 space-y-1.5">
                    <div className="flex items-center justify-between gap-1">
                      <span className="font-semibold text-zinc-200">
                        {tx(lang, '2. Scanned Pages & Photos', '2. เอกสารสแกนและรูปถ่าย')}
                      </span>
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-semibold border ${
                          ocrEngineStatus?.openthaigpt_available
                            ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                            : ocrEngineStatus?.tesseract_available
                            ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                            : 'bg-rose-500/15 text-rose-300 border-rose-500/30'
                        }`}
                      >
                        {ocrEngineStatus?.openthaigpt_available
                          ? tx(lang, 'WINNER READY', 'ตัวหลักพร้อมใช้')
                          : ocrEngineStatus?.tesseract_available
                          ? 'TESSERACT'
                          : tx(lang, 'MISSING', 'ยังไม่ติดตั้ง')}
                      </span>
                    </div>
                    <p className="text-[11px] text-zinc-200 font-medium">
                      {ocrEngineStatus?.openthaigpt_available
                        ? `OpenThai 2.0 OCR-Text (${ocrEngineStatus.openthaigpt_backend || 'onnx'})`
                        : ocrEngineStatus?.tesseract_available
                        ? `Tesseract 5 (${ocrEngineStatus.tesseract_langs.join(' + ') || 'eng'})`
                        : tx(lang, 'No scanned OCR installed', 'ยังไม่ได้ติดตั้งตัวอ่านสแกน OCR')}
                    </p>
                    <p className="text-[10px] text-zinc-400 leading-relaxed">
                      {ocrEngineStatus?.openthaigpt_available
                        ? tx(
                            lang,
                            '0.3–1.0s/page • 93%–98% Thai+EN accuracy (our #1 benchmark winner).',
                            '0.3–1.0 วินาที/หน้า • แม่นยำไทย+อังกฤษ 93%–98% (ชนะเลิศอันดับ 1)'
                          )
                        : ocrEngineStatus?.openthaigpt_note ||
                          tx(
                            lang,
                            'Install OpenThai 2.0 (4.2 MB) for 5–10x faster, cleaner Thai OCR.',
                            'ติดตั้ง OpenThai 2.0 (4.2 MB) เพื่ออ่านภาษาไทยเร็วและคมกว่าเดิม 5–10 เท่า'
                          )}
                    </p>
                    {ocrEngineStatus && !ocrEngineStatus.openthaigpt_available && (
                      <button
                        type="button"
                        onClick={handleInstallOpenThai}
                        disabled={installingOpenThai}
                        className="mt-1 px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white font-semibold text-[10px] flex items-center gap-1"
                      >
                        <Download className="w-3 h-3" />
                        <span>
                          {installingOpenThai
                            ? tx(lang, 'Installing (4.2 MB)...', 'กำลังติดตั้ง (4.2 MB)...')
                            : tx(lang, 'Install OpenThai 2.0 (4.2 MB)', 'ติดตั้ง OpenThai 2.0 (4.2 MB)')}
                        </span>
                      </button>
                    )}
                  </div>

                  <div className="p-3 rounded-lg bg-zinc-900/90 border border-zinc-800 space-y-1.5">
                    <div className="flex items-center justify-between gap-1">
                      <span className="font-semibold text-zinc-200">
                        {tx(lang, '3. Vision AI Second Opinion', '3. Vision AI ผู้ช่วยตรวจสอบเสริม')}
                      </span>
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-semibold border ${
                          ocrEngineStatus?.vision_ai_ready && ocrEngineStatus?.vision_ai_enabled
                            ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                            : ocrEngineStatus?.vision_ai_enabled && !ocrEngineStatus?.vision_ai_ready
                            ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                            : 'bg-zinc-800 text-zinc-400 border-zinc-700'
                        }`}
                      >
                        {ocrEngineStatus?.vision_ai_status_label ||
                          (formData.local_vision_enabled
                            ? tx(lang, 'Enabled', 'เปิดใช้งาน')
                            : tx(lang, 'Disabled', 'ปิดไว้'))}
                      </span>
                    </div>
                    <p className="text-[11px] text-zinc-200 font-medium">
                      {ocrEngineStatus?.vision_ai_model || formData.local_vision_model || tx(lang, 'None', 'ไม่มี')}
                    </p>
                    <p className="text-[10px] text-zinc-400 leading-relaxed">
                      {ocrEngineStatus?.vision_ai_message ||
                        tx(lang, 'Optional visual AI helper for blurry/table scans.', 'AI เสริมช่วยอ่านสแกนเบลอหรือตารางซับซ้อน')}
                    </p>
                    {builtInVision?.engine_installed && ocrEngineStatus && !ocrEngineStatus.vision_engine_vulkan && (
                      <button
                        type="button"
                        onClick={handleUpgradeVulkanEngine}
                        disabled={upgradingVulkan}
                        className="mt-1 px-2.5 py-1 rounded bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-zinc-950 font-semibold text-[10px] flex items-center gap-1"
                      >
                        <Download className="w-3 h-3" />
                        <span>
                          {upgradingVulkan
                            ? tx(lang, 'Upgrading GPU Engine...', 'กำลังอัปเกรด GPU Engine...')
                            : tx(lang, 'Upgrade to Vulkan GPU (~38 MB)', 'อัปเกรดเป็น Vulkan GPU (~38 MB)')}
                        </span>
                      </button>
                    )}
                  </div>
                </div>

                {/* Live Self-Test Immediate Feedback Box */}
                {selfTestError && (
                  <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <div>
                      <div className="font-semibold">{tx(lang, 'Self-Test Error', 'ทดสอบไม่สำเร็จ')}</div>
                      <div className="text-[11px] mt-0.5">{selfTestError}</div>
                    </div>
                  </div>
                )}

                {selfTestResult && (
                  <div className="p-3 rounded-lg bg-zinc-900 border border-blue-500/30 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-blue-200 flex items-center gap-1.5">
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                        <span>
                          {tx(lang, 'Live Self-Test Result', 'ผลการทดสอบอ่านจริง')} ({selfTestResult.file_tested})
                        </span>
                      </span>
                      <span className="font-mono text-[11px] text-zinc-300">
                        {selfTestResult.duration_ms}ms • {tx(lang, 'Engine:', 'ตัวอ่าน:')} <strong>{selfTestResult.engine_used}</strong> •{' '}
                        {selfTestResult.confidence.toFixed(0)}%
                      </span>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-[11px]">
                      <div className="p-2 rounded bg-zinc-950 border border-zinc-800">
                        <span className="text-zinc-500">{tx(lang, 'Supplier: ', 'ผู้ขาย: ')}</span>
                        <span className="text-zinc-100 font-medium">{selfTestResult.supplier_detected || '—'}</span>
                      </div>
                      <div className="p-2 rounded bg-zinc-950 border border-zinc-800 font-mono">
                        <span className="text-zinc-500 font-sans">PO / Tax ID: </span>
                        <span className="text-zinc-100">
                          {[...selfTestResult.po_numbers.slice(0, 1), ...selfTestResult.tax_ids.slice(0, 1)].join(' • ') || '—'}
                        </span>
                      </div>
                      <div className="p-2 rounded bg-zinc-950 border border-zinc-800">
                        <span className="text-zinc-500">Vision AI: </span>
                        {selfTestResult.vision_ai_status === 'ok' ? (
                          <span className="text-emerald-300 font-semibold">
                            OK ({selfTestResult.vision_ai_device || 'Local'},{' '}
                            {((selfTestResult.vision_ai_duration_ms || 0) / 1000).toFixed(1)}s)
                          </span>
                        ) : selfTestResult.vision_ai_status ? (
                          <span className="text-rose-300 font-medium">
                            {selfTestResult.vision_ai_error || selfTestResult.vision_ai_status}
                          </span>
                        ) : (
                          <span className="text-zinc-400">
                            {formData.local_vision_enabled
                              ? tx(lang, 'Skipped (OCR confidence >= 85%)', 'ข้าม (คะแนน OCR >= 85% แล้ว)')
                              : tx(lang, 'Turned Off', 'ปิดใช้งานอยู่')}
                          </span>
                        )}
                      </div>
                    </div>
                    {selfTestResult.text_preview && (
                      <pre className="p-2 rounded bg-zinc-950 border border-zinc-800 text-[10px] font-mono text-zinc-300 whitespace-pre-wrap max-h-28 overflow-y-auto">
                        {selfTestResult.text_preview}
                      </pre>
                    )}
                  </div>
                )}
              </div>

              <div className="space-y-4">
                {/* Performance vs Accuracy Preset */}
                <div className="p-4 rounded-xl bg-zinc-950/70 border border-zinc-800 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h4 className="font-semibold text-zinc-100">
                        {tx(lang, 'Performance vs. Accuracy Mode', 'โหมดความเร็ว vs ความแม่นยำสูงสุด')}
                      </h4>
                      <p className="text-[11px] text-zinc-400">
                        {tx(
                          lang,
                          'OpenThai 2.0 + Digital PDF Reader handle every preset automatically; choose whether Vision AI also assists.',
                          'OpenThai 2.0 และตัวอ่าน PDF ดิจิทัลทำงานอัตโนมัติในทุกโหมด เลือกว่าจะให้ Vision AI ช่วยเสริมแค่ไหน'
                        )}
                      </p>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
                    {(
                      [
                        {
                          id: 'fast',
                          title: tx(lang, 'Fast / Eco', 'โหมดเร็ว / ประหยัดทรัพยากร'),
                          badge: tx(lang, 'Fastest (<0.5s)', 'เร็วสุด (<0.5 วิ)'),
                          summary: tx(
                            lang,
                            'Digital PDF + OpenThai 2.0 OCR only (200 DPI). Vision AI turned off for maximum speed.',
                            'อ่าน PDF + OpenThai 2.0 เท่านั้น (200 DPI) ปิด Vision AI เพื่อความเร็วสูงสุด'
                          ),
                        },
                        {
                          id: 'balanced',
                          title: tx(lang, 'Balanced', 'โหมดสมดุล'),
                          badge: tx(lang, 'Recommended', 'แนะนำ'),
                          summary: tx(
                            lang,
                            'Digital PDF + OpenThai 2.0 (300 DPI) + Smart Vision AI helper only when confidence < 85%.',
                            'อ่าน PDF + OpenThai 2.0 (300 DPI) และเรียก Vision AI ช่วยเฉพาะเมื่อความมั่นใจต่ำกว่า 85%'
                          ),
                        },
                        {
                          id: 'max_accuracy',
                          title: tx(lang, 'Maximum Accuracy', 'โหมดแม่นยำสูงสุด'),
                          badge: tx(lang, 'Deepest (~10s GPU)', 'ละเอียดสุด (~10 วิ GPU)'),
                          summary: tx(
                            lang,
                            '400 DPI multi-pass OpenThai 2.0 + Always run Vision AI (Qwen2.5-VL-3B on Vulkan GPU).',
                            'สแกน OpenThai 2.0 ความละเอียด 400 DPI + รัน Vision AI (Qwen2.5-VL-3B Vulkan GPU) ช่วยตรวจทุกใบ'
                          ),
                        },
                      ] as const
                    ).map((preset) => {
                      const active = (formData.ocr_quality_preset || 'balanced') === preset.id;
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          onClick={() => {
                            const installedModels = (builtInVision?.models || []).filter((m) => m.installed);
                            const hasQwen = installedModels.some((m) => m.id === 'qwen2.5-vl-3b');
                            const hasSmol22 = installedModels.some((m) => m.id === 'smolvlm2-2.2b');
                            const bestInstalled =
                              installedModels.find((m) => m.id === 'qwen2.5-vl-3b')?.id ||
                              installedModels.find((m) => m.id === 'smolvlm2-2.2b')?.id ||
                              installedModels[0]?.id;

                            setFormData((prev) => {
                              if (preset.id === 'fast') {
                                return {
                                  ...prev,
                                  ocr_quality_preset: 'fast',
                                  local_vision_enabled: false,
                                  local_vision_trigger_mode: 'fallback',
                                  ocr_confidence_threshold_verified: 97.0,
                                  ocr_confidence_threshold_high: 88.0,
                                  ocr_confidence_threshold_review: 70.0,
                                };
                              }
                              if (preset.id === 'max_accuracy') {
                                return {
                                  ...prev,
                                  ocr_quality_preset: 'max_accuracy',
                                  local_vision_enabled: true,
                                  local_vision_provider: 'builtin',
                                  local_vision_trigger_mode: 'always',
                                  local_vision_model: hasQwen
                                    ? 'qwen2.5-vl-3b'
                                    : bestInstalled || 'qwen2.5-vl-3b',
                                  ocr_confidence_threshold_verified: 98.5,
                                  ocr_confidence_threshold_high: 92.0,
                                  ocr_confidence_threshold_review: 75.0,
                                };
                              }
                              return {
                                ...prev,
                                ocr_quality_preset: 'balanced',
                                local_vision_enabled: installedModels.length > 0 ? true : prev.local_vision_enabled,
                                local_vision_provider: 'builtin',
                                local_vision_trigger_mode: 'fallback',
                                local_vision_model: hasQwen
                                  ? 'qwen2.5-vl-3b'
                                  : hasSmol22
                                  ? 'smolvlm2-2.2b'
                                  : bestInstalled || 'qwen2.5-vl-3b',
                                ocr_confidence_threshold_verified: 98.0,
                                ocr_confidence_threshold_high: 90.0,
                                ocr_confidence_threshold_review: 75.0,
                              };
                            });
                          }}
                          className={`p-3 rounded-lg border text-left transition-colors space-y-1 ${
                            active
                              ? 'bg-blue-600/15 border-blue-500/60 text-zinc-100'
                              : 'bg-zinc-900/70 border-zinc-800 text-zinc-300 hover:border-zinc-700'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-1">
                            <span className="font-semibold text-xs">{preset.title}</span>
                            <span
                              className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                                active
                                  ? 'bg-blue-500/25 text-blue-200 border border-blue-400/40'
                                  : 'bg-zinc-800 text-zinc-400'
                              }`}
                            >
                              {preset.badge}
                            </span>
                          </div>
                          <p className="text-[10px] text-zinc-400 leading-relaxed">{preset.summary}</p>
                        </button>
                      );
                    })}
                  </div>
                  {(formData.ocr_quality_preset || 'balanced') === 'max_accuracy' &&
                    !(builtInVision?.models || []).some(
                      (m) =>
                        m.installed &&
                        ['qwen3-vl-4b', 'qwen3-vl-2b', 'lfm3-vl-2b', 'qwen2.5-vl-3b', 'gemma-4-e2b', 'typhoon-ocr-3b'].includes(
                          m.id
                        )
                    ) && (
                      <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-200 text-[11px] flex flex-wrap items-center justify-between gap-2">
                        <span>
                          {tx(
                            lang,
                            'Tip: For Maximum Accuracy Vision OCR + Ask AI Chat, download Qwen3-VL-4B (2.75 GB) or Qwen2.5-VL-3B below.',
                            'คำแนะนำ: เพื่อใช้ Vision OCR + ผู้ช่วย Ask AI เต็มประสิทธิภาพ แนะนำดาวน์โหลด Qwen3-VL-4B (2.75 GB) ด้านล่าง'
                          )}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleDownloadBuiltInModel('qwen3-vl-4b')}
                          disabled={!!downloadingModelId || !!builtInVision?.download?.active}
                          className="px-2.5 py-1 rounded bg-amber-500 hover:bg-amber-400 text-zinc-950 font-semibold text-[10px] disabled:opacity-50"
                        >
                          {tx(lang, 'Download Qwen3-VL-4B', 'ดาวน์โหลด Qwen3-VL-4B')}
                        </button>
                      </div>
                    )}
                </div>

                {/* Collapsible Advanced Engine Override */}
                <div className="rounded-lg bg-zinc-950/60 border border-zinc-800 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setShowAdvancedEngine((v) => !v)}
                    className="w-full px-4 py-2.5 text-left flex items-center justify-between text-zinc-400 hover:text-zinc-200"
                  >
                    <span className="font-medium text-[11px]">
                      {tx(lang, 'Advanced: Manual Scanned Engine Override', 'ขั้นสูง: บังคับลำดับตัวอ่าน OCR เอกสารสแกน')} (
                      {formData.ocr_engine_primary === 'tesseract'
                        ? tx(lang, 'Tesseract 5 Forced', 'บังคับ Tesseract 5')
                        : tx(lang, 'Auto — OpenThai 2.0 Winner', 'อัตโนมัติ — ใช้ OpenThai 2.0 เป็นหลัก')}
                      )
                    </span>
                    <span className="text-[10px] font-mono">
                      {showAdvancedEngine ? tx(lang, 'Hide', 'ซ่อน') : tx(lang, 'Show', 'แสดง')}
                    </span>
                  </button>
                  {showAdvancedEngine && (
                    <div className="px-4 pb-3 pt-1 border-t border-zinc-800 space-y-2">
                      <select
                        value={formData.ocr_engine_primary === 'paddleocr' ? 'openthaigpt' : formData.ocr_engine_primary}
                        onChange={(e) => handleChange('ocr_engine_primary', e.target.value)}
                        className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 font-medium"
                      >
                        <option value="openthaigpt">
                          {tx(
                            lang,
                            'Auto Best Pipeline (Digital PDF → OpenThai 2.0 → Tesseract 5 Fallback)',
                            'ระบบที่ดีที่สุดอัตโนมัติ (PDF ดิจิทัล → OpenThai 2.0 → สำรอง Tesseract 5)'
                          )}
                        </option>
                        <option value="tesseract">
                          {tx(lang, 'Force Tesseract 5 (tha+eng) Before OpenThai 2.0', 'บังคับใช้ Tesseract 5 ก่อน OpenThai 2.0')}
                        </option>
                        <option value="google_vision">
                          {tx(lang, 'Google Cloud Vision API (Requires Cloud Credentials)', 'Google Cloud Vision API (ต้องตั้งค่า Cloud Key)')}
                        </option>
                      </select>
                      <p className="text-[10px] text-zinc-500">
                        {tx(
                          lang,
                          'Leave on Auto Best Pipeline unless testing legacy Tesseract ordering.',
                          'แนะนำให้ตั้งไว้ที่ค่าอัตโนมัติ เว้นแต่ต้องการทดสอบ Tesseract แบบเดิม'
                        )}
                      </p>
                    </div>
                  )}
                </div>

                <div className="p-4 rounded-lg bg-zinc-950/70 border border-zinc-800 space-y-3">
                  <h4 className="font-semibold text-zinc-200">
                    {tx(lang, 'Company Match Confidence Thresholds (%)', 'เกณฑ์ความมั่นใจในการจับคู่ชื่อผู้ขาย (%)')}
                  </h4>
                  <div>
                    <div className="flex justify-between mb-1">
                      <span className="text-emerald-400 font-medium">
                        {tx(lang, 'Verified Automatic Send (≥ 98%):', 'ยืนยันส่งอัตโนมัติ (≥ 98%):')}
                      </span>
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
                      <span className="text-blue-400 font-medium">
                        {tx(lang, 'High Confidence (Single Match) (≥ 90%):', 'ความมั่นใจสูง (ตรงผู้ขายรายเดียว) (≥ 90%):')}
                      </span>
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
                      <span className="text-amber-400 font-medium">
                        {tx(lang, 'Human Verification Required (≥ 75%):', 'ส่งให้คนตรวจสอบก่อน (≥ 75%):')}
                      </span>
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
                        <span>
                          {tx(
                            lang,
                            'Self-Learning Memory Engine (Gets Smarter Every PO)',
                            'ระบบความจำอัจฉริยะ (ยิ่งใช้งานยิ่งแม่นขึ้นทุกใบ PO)'
                          )}
                        </span>
                      </h4>
                      <p className="text-[11px] text-zinc-400 mt-0.5">
                        {tx(
                          lang,
                          'Learns from every approved PO: links Thai + English names, 13-digit Tax IDs, email domains, page zones, and blacklists false OCR guesses.',
                          'เรียนรู้จากการอนุมัติทุกครั้ง: จำชื่อไทย+อังกฤษ เลขผู้เสียภาษี 13 หลัก โดเมนอีเมล ตำแหน่งบนหน้า และตัดคำรบกวนออก'
                        )}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => api.getLearningStats().then(setLearningStats).catch(() => {})}
                      className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 flex items-center gap-1 text-[11px]"
                    >
                      <RefreshCw className="w-3 h-3" />
                      <span>{tx(lang, 'Refresh Stats', 'รีเฟรชสถิติ')}</span>
                    </button>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                    <div className="p-2.5 rounded-lg bg-zinc-900/90 border border-zinc-800">
                      <span className="text-zinc-500 block text-[10px]">
                        {tx(lang, 'Name Variants', 'รูปแบบชื่อที่จำไว้')}
                      </span>
                      <span className="text-zinc-100 font-mono font-semibold text-sm">
                        {learningStats?.learned_name_variants ?? 0}
                      </span>
                    </div>
                    <div className="p-2.5 rounded-lg bg-zinc-900/90 border border-zinc-800">
                      <span className="text-zinc-500 block text-[10px]">
                        {tx(lang, '13-Digit Tax IDs', 'เลขผู้เสียภาษี 13 หลัก')}
                      </span>
                      <span className="text-zinc-100 font-mono font-semibold text-sm">
                        {learningStats?.learned_tax_ids ?? 0}
                      </span>
                    </div>
                    <div className="p-2.5 rounded-lg bg-zinc-900/90 border border-zinc-800">
                      <span className="text-zinc-500 block text-[10px]">
                        {tx(lang, 'Email Domains', 'โดเมนอีเมล')}
                      </span>
                      <span className="text-zinc-100 font-mono font-semibold text-sm">
                        {learningStats?.learned_email_domains ?? 0}
                      </span>
                    </div>
                    <div className="p-2.5 rounded-lg bg-zinc-900/90 border border-zinc-800">
                      <span className="text-zinc-500 block text-[10px]">
                        {tx(lang, 'Negative Filters', 'คำที่ไม่ใช่ชื่อผู้ขาย')}
                      </span>
                      <span className="text-amber-300 font-mono font-semibold text-sm">
                        {learningStats?.negative_phrases_count ?? 0}
                      </span>
                    </div>
                    <div className="p-2.5 rounded-lg bg-zinc-900/90 border border-zinc-800">
                      <span className="text-zinc-500 block text-[10px]">
                        {tx(lang, 'Total Reinforced', 'จำนวนครั้งที่เรียนรู้')}
                      </span>
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
                          {tx(lang, 'Enable Self-Learning Memory Loop', 'เปิดใช้งานระบบความจำอัจฉริยะ')}
                        </span>
                        <span className="text-[11px] text-zinc-400">
                          {tx(
                            lang,
                            'Automatically harvest Tax IDs, bilingual supplier names, email domains, and layout zones after each PO approval.',
                            'เก็บจำ Tax ID ชื่อสองภาษา โดเมนอีเมล และตำแหน่งบนเอกสารอัตโนมัติทุกครั้งที่อนุมัติ PO'
                          )}
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
                          {tx(lang, 'Auto-Save New Approved Suppliers Back to Google Sheet', 'บันทึกผู้ขายใหม่กลับขึ้น Google Sheet อัตโนมัติ')}
                        </span>
                        <span className="text-[11px] text-zinc-400">
                          {tx(
                            lang,
                            'When you approve an unknown vendor once, automatically insert/update their name, email & Tax ID in your Google Sheet via Apps Script.',
                            'เมื่ออนุมัติผู้ขายรายใหม่ที่ไม่เคยมีใน Sheet ระบบจะเพิ่มแถวชื่อ อีเมล และ Tax ID ลง Google Sheet ให้อัตโนมัติ'
                          )}
                        </span>
                      </span>
                    </label>
                  </div>
                </div>

                {/* Built-In On-Device Vision AI Manager (Zero 3rd-Party Apps or Localhost Needed) */}
                <div className="p-4 rounded-xl bg-zinc-950/70 border border-zinc-800 space-y-3 text-xs">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h4 className="font-semibold text-white flex items-center gap-1.5">
                        <Sparkles className="w-4 h-4 text-emerald-400" />
                        <span>
                          {tx(
                            lang,
                            'Built-In On-Device Vision AI (No 3rd-Party Apps Needed)',
                            'Vision AI ในตัวเครื่อง (ไม่ต้องลงโปรแกรมภายนอก)'
                          )}
                        </span>
                      </h4>
                      <p className="text-[11px] text-zinc-400 mt-0.5 flex items-center gap-1">
                        <Lock className="w-3 h-3 text-emerald-400 shrink-0" />
                        <span>
                          {tx(lang, 'Runs directly inside PO AutoFlow from', 'ประมวลผลออฟไลน์ภายในเครื่องจาก')}{' '}
                          <code className="text-zinc-300 font-mono">
                            {builtInVision?.models_dir || `${formData.root_dir}\\Models`}
                          </code>{' '}
                          {tx(lang, '— runs offline inside PO AutoFlow for BOTH Document Vision OCR and Ask AI Chat.', '— ประมวลผลออฟไลน์ภายในโปรแกรม ใช้ได้ทั้งอ่านเอกสาร OCR และผู้ช่วยคุยถาม-ตอบ Ask AI')}
                        </span>
                      </p>
                    </div>
                    <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={!!formData.local_vision_enabled}
                        onChange={(e) => {
                          const enabled = e.target.checked;
                          setFormData((prev) => ({
                            ...prev,
                            local_vision_enabled: enabled,
                            local_vision_provider: 'builtin',
                          }));
                        }}
                        className="h-4 w-4 rounded border-zinc-700 bg-zinc-800 text-emerald-500 cursor-pointer"
                      />
                      <span className="font-semibold text-zinc-200">
                        {formData.local_vision_enabled
                          ? tx(lang, 'Enabled', 'เปิดใช้งาน')
                          : tx(lang, 'Disabled', 'ปิดไว้')}
                      </span>
                    </label>
                  </div>

                  {/* When Vision AI Runs */}
                  <div>
                    <label className="text-zinc-300 font-medium block mb-1">
                      {tx(lang, 'When Vision AI Runs:', 'เงื่อนไขการเรียกใช้ Vision AI:')}
                    </label>
                    <select
                      value={formData.local_vision_trigger_mode || 'fallback'}
                      onChange={(e) =>
                        handleChange(
                          'local_vision_trigger_mode',
                          e.target.value as 'fallback' | 'always'
                        )
                      }
                      className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2"
                    >
                      <option value="fallback">
                        {tx(
                          lang,
                          'Smart Fallback (Run when OCR < 85% or supplier is missing — Fast)',
                          'ตัวช่วยอัจฉริยะ (เรียกเฉพาะเมื่อ OCR < 85% หรือไม่พบชื่อผู้ขาย — เร็ว)'
                        )}
                      </option>
                      <option value="always">
                        {tx(
                          lang,
                          'Always Run on Every PO Document (Deep Vision Scan)',
                          'สแกนด้วย Vision AI ทุกฉบับ (Deep Vision Scan)'
                        )}
                      </option>
                    </select>
                  </div>

                  {/* Active Download Progress Bar */}
                  {builtInVision?.download &&
                    (builtInVision.download.active ||
                      builtInVision.download.stage === 'completed' ||
                      builtInVision.download.error) && (
                      <div
                        className={`p-3 rounded-lg border space-y-1.5 ${
                          builtInVision.download.error
                            ? 'bg-red-500/10 border-red-500/30 text-red-300'
                            : builtInVision.download.stage === 'completed'
                            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                            : 'bg-blue-500/10 border-blue-500/30 text-blue-200'
                        }`}
                      >
                        <div className="flex items-center justify-between text-[11px] font-semibold">
                          <span>{builtInVision.download.message || builtInVision.download.stage}</span>
                          <span className="font-mono">
                            {(builtInVision.download.downloaded_bytes / 1_048_576).toFixed(1)} MB /{' '}
                            {(builtInVision.download.total_bytes / 1_048_576).toFixed(0)} MB (
                            {builtInVision.download.percent.toFixed(1)}%)
                          </span>
                        </div>
                        <div className="w-full h-2 rounded-full bg-zinc-900 overflow-hidden">
                          <div
                            className={`h-full transition-all duration-300 ${
                              builtInVision.download.error
                                ? 'bg-red-500'
                                : builtInVision.download.stage === 'completed'
                                ? 'bg-emerald-500'
                                : 'bg-blue-500'
                            }`}
                            style={{ width: `${Math.min(100, Math.max(0, builtInVision.download.percent))}%` }}
                          />
                        </div>
                      </div>
                    )}

                  {/* Selectable Built-In Model Cards */}
                  <div className="space-y-2">
                    {(builtInVision?.models || []).map((m) => {
                      const isDownloadingThis =
                        downloadingModelId === m.id ||
                        (builtInVision?.download?.active && builtInVision.download.model_id === m.id);
                      const isActive =
                        formData.local_vision_enabled &&
                        (formData.local_vision_model || builtInVision?.active_model_id) === m.id;

                      return (
                        <div
                          key={m.id}
                          className={`p-3 rounded-lg border flex flex-wrap items-center justify-between gap-3 ${
                            isActive
                              ? 'bg-emerald-950/30 border-emerald-500/40'
                              : 'bg-zinc-900/70 border-zinc-800'
                          }`}
                        >
                          <div className="min-w-0 flex-1 space-y-0.5">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-semibold text-zinc-100">{m.name}</span>
                              <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 font-mono text-[10px]">
                                {m.size_label}
                              </span>
                              {m.installed && builtInVision?.engine_installed ? (
                                <span
                                  className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                                    isActive
                                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                                      : 'bg-blue-500/15 text-blue-300 border border-blue-500/30'
                                  }`}
                                >
                                  {isActive
                                    ? tx(lang, 'Active & Ready', 'ใช้งานอยู่และพร้อมใช้')
                                    : tx(lang, 'Downloaded', 'ดาวน์โหลดแล้ว')}
                                </span>
                              ) : (
                                <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500 text-[10px]">
                                  {tx(lang, 'Not Installed', 'ยังไม่ติดตั้ง')}
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-zinc-400">{m.description}</p>
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            {m.installed && builtInVision?.engine_installed ? (
                              <>
                                {!isActive && (
                                  <button
                                    type="button"
                                    onClick={() => handleSelectBuiltInModel(m.id)}
                                    className="px-2.5 py-1.5 rounded-md bg-blue-600 hover:bg-blue-500 text-white font-semibold flex items-center gap-1 text-[11px]"
                                  >
                                    <Check className="w-3 h-3" />
                                    <span>{tx(lang, 'Select Active', 'เลือกใช้งาน')}</span>
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => handleDeleteBuiltInModel(m.id)}
                                  className="p-1.5 rounded-md bg-zinc-800 hover:bg-red-500/20 text-zinc-400 hover:text-red-300 border border-zinc-700"
                                  title={tx(lang, 'Delete downloaded model files', 'ลบไฟล์โมเดลที่ดาวน์โหลดไว้')}
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                onClick={() => handleDownloadBuiltInModel(m.id)}
                                disabled={Boolean(builtInVision?.download?.active) || downloadingModelId !== null}
                                className="px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold flex items-center gap-1.5 text-[11px]"
                              >
                                <Download className={`w-3.5 h-3.5 ${isDownloadingThis ? 'animate-bounce' : ''}`} />
                                <span>
                                  {isDownloadingThis
                                    ? tx(lang, 'Downloading...', 'กำลังดาวน์โหลด...')
                                    : tx(lang, 'Download Inside App', 'ดาวน์โหลดในโปรแกรม')}
                                </span>
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    <button
                      type="button"
                      onClick={handleTestLocalVision}
                      disabled={testingVision}
                      className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 font-semibold border border-zinc-700 flex items-center gap-1.5"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${testingVision ? 'animate-spin' : ''}`} />
                      <span>
                        {testingVision
                          ? tx(lang, 'Verifying...', 'กำลังตรวจสอบ...')
                          : tx(lang, 'Verify Built-In Engine', 'ตรวจสอบเครื่องมือ AI ในตัว')}
                      </span>
                    </button>
                    <span className="text-[11px] text-zinc-400 flex items-center gap-1">
                      <HardDrive className="w-3.5 h-3.5 text-zinc-500" />
                      <span>
                        {tx(lang, 'Native Engine:', 'เอนจินในเครื่อง:')}{' '}
                        {builtInVision?.engine_installed
                          ? ocrEngineStatus?.vision_engine_vulkan
                            ? tx(lang, 'Vulkan GPU Ready (~8–12s/page)', 'พร้อมใช้ Vulkan GPU (~8–12 วิ/หน้า)')
                            : tx(
                                lang,
                                'Installed (CPU-only • upgrade to Vulkan GPU above)',
                                'ติดตั้งแล้ว (โหมด CPU — กดอัปเกรดเป็น Vulkan GPU ด้านบนได้)'
                              )
                          : tx(
                              lang,
                              'Auto-installs (Vulkan GPU) on first model download',
                              'ติดตั้งเอนจิน (Vulkan GPU) ให้อัตโนมัติเมื่อดาวน์โหลดโมเดลครั้งแรก'
                            )}
                      </span>
                    </span>
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
              <h3 className="text-sm font-bold text-white mb-2">
                {tx(lang, 'Google Sheets Directory Integration', 'เชื่อมต่อรายชื่อผู้ขายจาก Google Sheets')}
              </h3>
              <p className="text-zinc-400 text-xs mb-4">
                {tx(
                  lang,
                  'The spreadsheet acts as the single source of truth for company aliases and approved recipient emails.',
                  'ตาราง Google Sheets ทำหน้าที่เป็นฐานข้อมูลหลักของรายชื่อผู้ขาย ชื่อสำรอง และอีเมลผู้รับที่อนุมัติแล้ว'
                )}
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
                        <span className="font-semibold text-zinc-100">
                          {googleAccount.name || tx(lang, 'Google Account', 'บัญชี Google')}
                        </span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-medium">
                          {tx(lang, 'Private Access Enabled', 'เปิดใช้สิทธิ์เข้าถึงไฟล์ส่วนตัวแล้ว')}
                        </span>
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
                      {tx(lang, 'Disconnect', 'ออกจากระบบ')}
                    </button>
                  )}
                </div>
              ) : (
                <div className="p-3.5 rounded-xl bg-[#121215] border border-zinc-700 flex items-center justify-between">
                  <div>
                    <h4 className="font-semibold text-zinc-200">
                      {tx(lang, 'Google Account Authentication', 'ยืนยันตัวตนบัญชี Google')}
                    </h4>
                    <p className="text-zinc-400 text-xs mt-0.5">
                      {tx(
                        lang,
                        'Connect with 1 click via Apps Script Cloud Hub, or configure a custom OAuth Client ID below.',
                        'เชื่อมต่อได้ใน 1 คลิกผ่าน Apps Script Cloud Hub หรือกำหนด Custom OAuth Client ID ด้านล่าง'
                      )}
                    </p>
                  </div>
                  {onGoogleLogin && (
                    <button
                      type="button"
                      onClick={onGoogleLogin}
                      disabled={isLoggingIn}
                      className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-white border border-white/20 text-xs font-semibold flex items-center space-x-1.5 shrink-0"
                    >
                      <span>{isLoggingIn ? tr(lang, 'signingIn') : tr(lang, 'signInGoogle')}</span>
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
                    <span>
                      {tx(
                        lang,
                        'Custom Google Cloud OAuth Client Credentials (Optional)',
                        'คีย์ Google Cloud OAuth Client แบบกำหนดเอง (ไม่บังคับ)'
                      )}
                    </span>
                  </span>
                  <span className="text-[11px] text-zinc-400">
                    {showCustomOAuth ? tx(lang, 'Hide', 'ซ่อน') : tx(lang, 'Configure', 'ตั้งค่า')}
                  </span>
                </button>
                {showCustomOAuth && (
                  <div className="mt-3 space-y-2.5 pt-2.5 border-t border-zinc-800">
                    <p className="text-[11px] text-zinc-400">
                      {tx(
                        lang,
                        'Leave blank to use Apps Script Cloud Hub (recommended). Only needed for direct Google Cloud Console Desktop App OAuth.',
                        'ปล่อยว่างไว้ได้เพื่อใช้ Apps Script Cloud Hub (แนะนำ) ใช้เฉพาะกรณีต่อ OAuth ของ Google Cloud Console เอง'
                      )}
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
                <label className="text-zinc-300 font-semibold block mb-1">
                  {tx(lang, 'Google Spreadsheet ID:', 'รหัส Google Spreadsheet ID:')}
                </label>
                <input
                  type="text"
                  value={formData.google_sheets_id}
                  onChange={(e) => handleChange('google_sheets_id', e.target.value)}
                  placeholder="e.g. 1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms"
                  className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 font-mono"
                />
                <p className="text-[11px] text-zinc-500 mt-1">
                  {tx(lang, 'Found in the Google Sheets browser URL between /d/ and /edit', 'ดูได้จาก URL ของ Google Sheets ระหว่าง /d/ และ /edit')}
                </p>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-zinc-300 font-semibold">
                    {tx(lang, 'Worksheet / Sheet Tab Names:', 'ชื่อแผ่นงาน (Tabs) ใน Google Sheet:')}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      handleChange('google_sheets_tab_name', 'DV');
                      handleChange('google_sheets_ov_tab_name', 'OV');
                      if (!formData.google_sheets_dept_tab_name) {
                        handleChange('google_sheets_dept_tab_name', 'Department');
                      }
                    }}
                    className="px-2.5 py-1 rounded bg-blue-500/15 hover:bg-blue-500/25 border border-blue-500/30 text-blue-300 text-[11px] font-semibold"
                  >
                    {tx(lang, 'Set DV + OV + Dept Tabs', 'ตั้งค่าแท็บ DV + OV + แผนก')}
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <label className="text-zinc-400 text-[11px] font-medium block mb-1">
                      {tx(lang, 'Domestic Vendors Tab (DV):', 'แท็บผู้ขายในประเทศ (DV / หลัก):')}
                    </label>
                    <input
                      type="text"
                      value={formData.google_sheets_tab_name}
                      onChange={(e) => handleChange('google_sheets_tab_name', e.target.value)}
                      placeholder="DV (or Suppliers)"
                      className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 font-medium"
                    />
                  </div>
                  <div>
                    <label className="text-zinc-400 text-[11px] font-medium block mb-1">
                      {tx(lang, 'Overseas Vendors Tab (OV — Optional):', 'แท็บผู้ขายต่างประเทศ (OV — ไม่บังคับ):')}
                    </label>
                    <input
                      type="text"
                      value={formData.google_sheets_ov_tab_name || ''}
                      onChange={(e) => handleChange('google_sheets_ov_tab_name', e.target.value)}
                      placeholder="OV"
                      className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 font-medium"
                    />
                  </div>
                  <div>
                    <label className="text-zinc-400 text-[11px] font-medium block mb-1">
                      {tx(lang, 'Department CC Tab (Optional):', 'แท็บอีเมล CC ตามแผนก (ไม่บังคับ):')}
                    </label>
                    <input
                      type="text"
                      value={formData.google_sheets_dept_tab_name || ''}
                      onChange={(e) => handleChange('google_sheets_dept_tab_name', e.target.value)}
                      placeholder="Department (or แผนก)"
                      className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 font-medium"
                    />
                  </div>
                </div>
                <p className="text-[11px] text-zinc-500">
                  {tx(
                    lang,
                    'Separate DV & OV supplier tabs, plus an optional Department tab (No. | แผนก | Email) to auto-CC the requesting department from each PO.',
                    'แยกแท็บ DV และ OV พร้อมแท็บแผนก (No. | แผนก | Email) เพื่อให้ระบบใส่ CC แผนกที่ขอซื้อในใบ PO ให้อัตโนมัติ'
                  )}
                </p>
              </div>

              <div className="pt-2">
                <button
                  type="button"
                  onClick={testSheets}
                  disabled={testStatus.sheets?.loading}
                  className="px-3.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 font-semibold flex items-center space-x-1.5"
                >
                  <span>
                    {testStatus.sheets?.loading
                      ? tx(lang, 'Testing...', 'กำลังทดสอบ...')
                      : tx(lang, 'Test Sheets Connection', 'ทดสอบเชื่อมต่อ Sheets')}
                  </span>
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
              <h3 className="text-sm font-bold text-white mb-2">
                {tx(lang, 'Google Drive Backup Folder', 'โฟลเดอร์สำรองไฟล์ Google Drive')}
              </h3>
              <p className="text-zinc-400 text-xs mb-4">
                {tx(
                  lang,
                  "Uploaded automatically via your Apps Script Web App's built-in DriveApp (no extra Drive API v3 service needs to be added under \"+ Services\" in Apps Script).",
                  'อัปโหลดอัตโนมัติผ่าน DriveApp ของ Apps Script (ไม่จำเป็นต้องเพิ่มบริการ Drive API v3 ในเมนู "+ Services")'
                )}
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
                        <span className="font-semibold text-zinc-100">
                          {googleAccount.name || tx(lang, 'Google Account', 'บัญชี Google')}
                        </span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-medium">
                          {tx(lang, 'Direct Upload to Private Drive', 'อัปโหลดไปยัง Drive ส่วนตัวโดยตรง')}
                        </span>
                      </div>
                      <p className="text-zinc-400 text-xs">{googleAccount.email}</p>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="p-3.5 rounded-xl bg-[#121215] border border-zinc-700 flex items-center justify-between">
                  <div>
                    <h4 className="font-semibold text-zinc-200">
                      {tx(lang, 'Google Drive Private Access', 'สิทธิ์เข้าถึง Google Drive ส่วนตัว')}
                    </h4>
                    <p className="text-zinc-400 text-xs mt-0.5">
                      {tx(
                        lang,
                        'Connect your Google Account to upload directly to private folders in your Drive.',
                        'เชื่อมต่อบัญชี Google เพื่ออัปโหลดเข้าโฟลเดอร์ส่วนตัวใน Drive ได้โดยตรง'
                      )}
                    </p>
                  </div>
                  {onGoogleLogin && (
                    <button
                      type="button"
                      onClick={onGoogleLogin}
                      disabled={isLoggingIn}
                      className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-white border border-white/20 text-xs font-semibold flex items-center space-x-1.5"
                    >
                      <span>{isLoggingIn ? tr(lang, 'signingIn') : tr(lang, 'signInGoogle')}</span>
                    </button>
                  )}
                </div>
              )}

              <div>
                <label className="text-zinc-300 font-semibold block mb-1">
                  {tx(lang, 'Google Drive Folder ID:', 'รหัส Google Drive Folder ID:')}
                </label>
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
                  <span>
                    {testStatus.drive?.loading
                      ? tx(lang, 'Testing...', 'กำลังทดสอบ...')
                      : tx(lang, 'Test Drive Connection', 'ทดสอบเชื่อมต่อ Drive')}
                  </span>
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
              <h3 className="text-sm font-bold text-white mb-2">
                {tx(lang, 'Google Apps Script Delivery Endpoint', 'จุดเชื่อมต่อส่งอีเมล Google Apps Script')}
              </h3>
              <p className="text-zinc-400 text-xs mb-4">
                {tx(
                  lang,
                  'The desktop app invokes this secured Web App endpoint to send authenticated PO emails via GmailApp.',
                  'โปรแกรมจะเรียกใช้ Web App endpoint นี้เพื่อส่งอีเมลใบสั่งซื้อผ่าน GmailApp ของคุณอย่างปลอดภัย'
                )}
              </p>

              <div>
                <label className="text-zinc-300 font-semibold block mb-1">
                  {tx(lang, 'Apps Script Webhook URL:', 'URL ของ Apps Script Webhook:')}
                </label>
                <input
                  type="text"
                  value={formData.gas_webhook_url}
                  onChange={(e) => handleChange('gas_webhook_url', e.target.value)}
                  placeholder="https://script.google.com/macros/s/AKfycb.../exec"
                  className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 font-mono"
                />
              </div>

              <div>
                <label className="text-zinc-300 font-semibold block mb-1">
                  {tx(lang, 'Webhook Secret / Authorization Key:', 'รหัสลับ Webhook / Authorization Key:')}
                </label>
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
                  <span>
                    {testStatus.gas?.loading
                      ? tx(lang, 'Testing...', 'กำลังทดสอบ...')
                      : tx(lang, 'Test Webhook Endpoint', 'ทดสอบเชื่อมต่อ Webhook')}
                  </span>
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
              <h3 className="text-sm font-bold text-white mb-2">
                {tx(lang, 'Automated Email Templates', 'เทมเพลตข้อความอีเมลอัตโนมัติ')}
              </h3>
              <p className="text-zinc-400 text-xs mb-4">
                {tx(lang, 'Available placeholders:', 'ตัวแปรที่ใช้ได้:')}{' '}
                <code className="text-blue-300 font-mono">{'{{PO_NUMBER}}'}</code>,{' '}
                <code className="text-blue-300 font-mono">{'{{COMPANY_NAME}}'}</code>,{' '}
                <code className="text-blue-300 font-mono">{'{{DATE}}'}</code>
              </p>

              <div>
                <label className="text-zinc-300 font-semibold block mb-1">
                  {tx(lang, 'Subject Line Template:', 'เทมเพลตหัวข้ออีเมล (Subject):')}
                </label>
                <input
                  type="text"
                  value={formData.email_subject_template}
                  onChange={(e) => handleChange('email_subject_template', e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 font-medium"
                />
              </div>

              <div>
                <label className="text-zinc-300 font-semibold block mb-1">
                  {tx(lang, 'Email Body Template:', 'เทมเพลตเนื้อหาอีเมล (Body):')}
                </label>
                <textarea
                  rows={6}
                  value={formData.email_body_template}
                  onChange={(e) => handleChange('email_body_template', e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 font-mono text-xs leading-relaxed"
                />
              </div>

              <div>
                <label className="text-zinc-300 font-semibold block mb-1">
                  {tx(lang, 'Default CC Emails (Optional, comma-separated):', 'อีเมล CC เริ่มต้น (ไม่บังคับ คั่นหลายอีเมลด้วยเครื่องหมาย ,):')}
                </label>
                <input
                  type="text"
                  value={formData.email_cc_default || ''}
                  onChange={(e) => handleChange('email_cc_default', e.target.value)}
                  placeholder="yuwanit.n@qtc-energy.com, supervisor@company.com"
                  className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 font-mono"
                />
                <p className="text-[11px] text-zinc-500 mt-1">
                  {tx(
                    lang,
                    'Automatically CC’d on auto-sent PO emails and pre-filled in Overview / Documents Viewer.',
                    'จะถูกใส่เป็น CC อัตโนมัติเมื่อระบบส่งอีเมล และเติมให้ล่วงหน้าในหน้า Overview และ Documents Viewer'
                  )}
                </p>
              </div>

              <div>
                <label className="text-zinc-300 font-semibold block mb-1">
                  {tx(lang, 'Email Attachment Format (Gmail Preview):', 'รูปแบบไฟล์แนบอีเมล (พรีวิวใน Gmail):')}
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
                    {tx(
                      lang,
                      'Individual Files — PDFs & Images Previewable in Gmail (Recommended)',
                      'แยกไฟล์เดี่ยว — เปิดพรีวิว PDF และรูปใน Gmail ได้ทันที (แนะนำ)'
                    )}
                  </option>
                  <option value="both">
                    {tx(lang, 'Both Individual Previewable Files + ZIP Archive', 'แนบทั้งไฟล์เดี่ยวพรีวิวได้ + ไฟล์ ZIP')}
                  </option>
                  <option value="zip_archive">
                    {tx(lang, 'Single Compressed ZIP File Only (.zip)', 'แนบเฉพาะไฟล์บีบอัด .zip')}
                  </option>
                </select>
              </div>
            </div>
          )}

          {/* Tab 7: Security */}
          {activeTab === 'security' && (
            <div className="space-y-4 text-xs">
              <h3 className="text-sm font-bold text-white mb-2">
                {tx(lang, 'Security, Encryption & File Safeguards', 'ความปลอดภัย การเข้ารหัส และระบบป้องกันไฟล์')}
              </h3>
              <p className="text-zinc-400 text-xs mb-4">
                {tx(
                  lang,
                  'Enterprise protections preventing directory traversal, ZIP decompression bombs, and duplicate transactions.',
                  'กลไกป้องกันระดับองค์กรสำหรับกันการเข้าถึงนอกโฟลเดอร์ การแตกไฟล์ ZIP เกินขนาด และการส่งอีเมลซ้ำ'
                )}
              </p>

              <div>
                <label className="text-zinc-300 font-semibold block mb-1">
                  {tx(lang, 'Maximum ZIP Size Limit (MB):', 'ขนาดไฟล์ ZIP สูงสุด (MB):')}
                </label>
                <input
                  type="number"
                  value={formData.max_zip_file_mb}
                  onChange={(e) => handleChange('max_zip_file_mb', parseInt(e.target.value) || 25)}
                  className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 font-mono"
                />
                <p className="text-[11px] text-zinc-500 mt-1">
                  {tx(
                    lang,
                    'If the PO package exceeds 20MB, Apps Script automatically provides a secure Google Drive link instead of direct mail attachment.',
                    'หากไฟล์เกิน 20 MB ระบบ Apps Script จะแนบลิงก์ Google Drive ที่ปลอดภัยแทนการส่งไฟล์ใหญ่ในอีเมล'
                  )}
                </p>
              </div>

              <div className="p-3.5 rounded-lg bg-zinc-950/70 border border-zinc-800 space-y-2">
                <div className="flex items-center space-x-2 text-emerald-400 font-semibold">
                  <ShieldCheck className="w-4 h-4" />
                  <span>{tx(lang, 'Security Guarantees Active', 'ระบบป้องกันความปลอดภัยที่เปิดใช้งาน')}</span>
                </div>
                <ul className="list-disc pl-4 text-zinc-400 text-[11px] space-y-1">
                  <li>
                    {tx(
                      lang,
                      'Deterministic SHA-256 and folder fingerprinting prevent duplicate emails.',
                      'ใช้รหัส SHA-256 และลายนิ้วมือโฟลเดอร์ป้องกันการส่งใบสั่งซื้อซ้ำ'
                    )}
                  </li>
                  <li>
                    {tx(
                      lang,
                      'Strict path canonicalization prevents directory traversal attacks.',
                      'ตรวจสอบขอบเขตโฟลเดอร์อย่างเข้มงวด ป้องกันการเปิดพาธนอกพื้นที่ที่กำหนด'
                    )}
                  </li>
                  <li>
                    {tx(
                      lang,
                      'Local SQLite database stores an immutable audit log of all operations.',
                      'ฐานข้อมูล SQLite ภายในเครื่องเก็บบันทึกประวัติการส่งและธุรกรรมทั้งหมดอย่างตรวจสอบได้'
                    )}
                  </li>
                </ul>
              </div>
            </div>
          )}

          {/* Tab 8: Developer & Debugging */}
          {activeTab === 'developer' && (
            <div className="space-y-4 text-xs">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold text-white">
                    {tx(lang, 'Developer Options & Diagnostics', 'ตัวเลือกนักพัฒนาและเครื่องมือวินิจฉัย')}
                  </h3>
                  <p className="text-zinc-400 text-xs">
                    {tx(
                      lang,
                      'Configure runtime debugging flags, dry-run simulation, and inspect system internals.',
                      'ตั้งค่าสถานะดีบัก โหมดจำลองการทำงาน และตรวจสอบระบบภายใน'
                    )}
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
                  <span>{tx(lang, 'Open DevTools (F12)', 'เปิด DevTools (F12)')}</span>
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2">
                <div className="p-3.5 rounded-lg bg-zinc-900/70 border border-zinc-700 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-zinc-200">{tx(lang, 'Developer Mode', 'โหมดนักพัฒนา')}</span>
                    <input
                      type="checkbox"
                      checked={!!formData.developer_mode_enabled}
                      onChange={(e) => handleChange('developer_mode_enabled', e.target.checked)}
                      className="h-4 w-4 rounded border-zinc-700 bg-zinc-800 text-blue-600 focus:ring-0 cursor-pointer"
                    />
                  </div>
                  <p className="text-[11px] text-zinc-400">
                    {tx(
                      lang,
                      'Enables diagnostic telemetry and deep inspection tools across the UI.',
                      'แสดงหน้า Model Benchmark และเทอร์มินัลดีบักในเมนูด้านข้าง'
                    )}
                  </p>
                </div>

                <div className="p-3.5 rounded-lg bg-zinc-900/70 border border-zinc-700 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-zinc-200">{tx(lang, 'Verbose Debug Logging', 'บันทึก Log แบบละเอียด')}</span>
                    <input
                      type="checkbox"
                      checked={!!formData.debug_logging_enabled}
                      onChange={(e) => handleChange('debug_logging_enabled', e.target.checked)}
                      className="h-4 w-4 rounded border-zinc-700 bg-zinc-800 text-blue-600 focus:ring-0 cursor-pointer"
                    />
                  </div>
                  <p className="text-[11px] text-zinc-400">
                    {tx(
                      lang,
                      'Logs detailed stage execution, regex matches, and timing benchmarks to database.',
                      'บันทึกขั้นตอนการทำงาน การจับคู่ และเวลาที่ใช้ในแต่ละขั้นลงฐานข้อมูล'
                    )}
                  </p>
                </div>

                <div className="p-3.5 rounded-lg bg-zinc-900/70 border border-zinc-700 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-amber-300">{tx(lang, 'Dry-Run / Simulation Mode', 'โหมดจำลอง (Dry-Run)')}</span>
                    <input
                      type="checkbox"
                      checked={!!formData.dry_run_simulation_mode}
                      onChange={(e) => handleChange('dry_run_simulation_mode', e.target.checked)}
                      className="h-4 w-4 rounded border-zinc-700 bg-zinc-800 text-amber-500 focus:ring-0 cursor-pointer"
                    />
                  </div>
                  <p className="text-[11px] text-zinc-400">
                    {tx(
                      lang,
                      'Processes PO folders completely but mocks Drive upload and Gmail sending. No actual emails will be dispatched.',
                      'ประมวลผลครบทุกขั้นตอนโดยจำลองการส่ง Drive และ Gmail ไม่ส่งอีเมลจริงออกไป'
                    )}
                  </p>
                </div>

                <div className="p-3.5 rounded-lg bg-zinc-900/70 border border-zinc-700 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-zinc-200">
                      {tx(lang, 'Save OCR Preprocessing Artifacts', 'บันทึกภาพระหว่างสแกน OCR')}
                    </span>
                    <input
                      type="checkbox"
                      checked={!!formData.save_debug_ocr_images}
                      onChange={(e) => handleChange('save_debug_ocr_images', e.target.checked)}
                      className="h-4 w-4 rounded border-zinc-700 bg-zinc-800 text-blue-600 focus:ring-0 cursor-pointer"
                    />
                  </div>
                  <p className="text-[11px] text-zinc-400">
                    {tx(
                      lang,
                      'Saves deskewed, contrast-enhanced and thresholded images to Temp\\debug_ocr.',
                      'บันทึกภาพที่ปรับแก้อียงและคมชัดแล้วเก็บไว้ที่ Temp\\debug_ocr เพื่อตรวจสอบ'
                    )}
                  </p>
                </div>
              </div>

              <div className="pt-2">
                <label className="text-zinc-300 font-semibold block mb-2">
                  {tx(lang, 'Quick Directory Launchers:', 'ทางลัดเปิดโฟลเดอร์ระบบ:')}
                </label>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => api.openPathInExplorer(formData.incoming_dir)}
                    className="px-2.5 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs border border-zinc-700"
                  >
                    {tx(lang, 'Open Incoming', 'เปิด Incoming')}
                  </button>
                  <button
                    type="button"
                    onClick={() => api.openPathInExplorer(formData.processing_dir)}
                    className="px-2.5 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs border border-zinc-700"
                  >
                    {tx(lang, 'Open Processing', 'เปิด Processing')}
                  </button>
                  <button
                    type="button"
                    onClick={() => api.openPathInExplorer(formData.sent_dir)}
                    className="px-2.5 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs border border-zinc-700"
                  >
                    {tx(lang, 'Open Sent', 'เปิด Sent')}
                  </button>
                  <button
                    type="button"
                    onClick={() => api.openPathInExplorer(formData.failed_dir)}
                    className="px-2.5 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs border border-zinc-700"
                  >
                    {tx(lang, 'Open Failed', 'เปิด Failed')}
                  </button>
                  <button
                    type="button"
                    onClick={() => api.openPathInExplorer(formData.review_dir)}
                    className="px-2.5 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs border border-zinc-700"
                  >
                    {tx(lang, 'Open Review', 'เปิด Review')}
                  </button>
                  <button
                    type="button"
                    onClick={() => api.openPathInExplorer(formData.logs_dir)}
                    className="px-2.5 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs border border-zinc-700"
                  >
                    {tx(lang, 'Open Logs', 'เปิด Logs')}
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
              <span>{tx(lang, 'Software Updates & GitHub Release Channel', 'อัปเดตซอฟต์แวร์และเวอร์ชันบน GitHub')}</span>
            </h3>
            <p className="text-xs text-zinc-400">
              {tx(lang, 'Connected Repository:', 'คลังโค้ดที่เชื่อมต่อ:')}{' '}
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

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={packagePref}
              onChange={(e) => {
                const nextPref = e.target.value as 'auto' | 'msi' | 'nsis';
                setPackagePref(nextPref);
                handleCheckUpdates(nextPref);
              }}
              className="px-2.5 py-1.5 rounded-lg bg-zinc-900 text-zinc-200 text-xs border border-zinc-700"
              title={tx(lang, 'Choose which Windows installer package the updater downloads', 'เลือกชนิดตัวติดตั้ง Windows สำหรับอัปเดต')}
            >
              <option value="auto">
                {tx(lang, 'Auto', 'อัตโนมัติ')} (
                {updateStatus?.detected_install_kind === 'msi'
                  ? tx(lang, 'Matched: MSI', 'ตรงกับ: MSI')
                  : tx(lang, 'Matched: EXE Setup', 'ตรงกับ: EXE Setup')}
                )
              </option>
              <option value="msi">{tx(lang, 'MSI Installer (.msi)', 'ตัวติดตั้ง MSI (.msi)')}</option>
              <option value="nsis">{tx(lang, 'EXE Setup (-setup.exe)', 'ตัวติดตั้ง EXE (-setup.exe)')}</option>
            </select>

            <button
              type="button"
              onClick={() => handleCheckUpdates()}
              disabled={checkingUpdate || installingUpdate}
              className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold border border-zinc-700 flex items-center gap-1.5 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${checkingUpdate ? 'animate-spin' : ''}`} />
              <span>
                {checkingUpdate
                  ? tx(lang, 'Checking...', 'กำลังเช็ค...')
                  : tx(lang, 'Check for Updates', 'ตรวจสอบอัปเดต')}
              </span>
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
                  ? tx(lang, 'Downloading...', 'กำลังดาวน์โหลด...')
                  : updateStatus?.update_available
                  ? tx(lang, `Download & Install v${updateStatus.latest_version}`, `ดาวน์โหลดและติดตั้ง v${updateStatus.latest_version}`)
                  : tx(lang, 'Download & Install Update', 'ดาวน์โหลดและติดตั้งอัปเดต')}
              </span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
          <div className="p-3 rounded-lg bg-zinc-950/70 border border-zinc-800">
            <span className="text-zinc-500 block text-[11px]">{tx(lang, 'Installed Version', 'เวอร์ชันที่ติดตั้งอยู่')}</span>
            <span className="text-zinc-100 font-mono font-semibold text-sm">
              v{updateStatus?.current_version || '1.0.0'}
            </span>
          </div>
          <div className="p-3 rounded-lg bg-zinc-950/70 border border-zinc-800">
            <span className="text-zinc-500 block text-[11px]">{tx(lang, 'Latest GitHub Release', 'เวอร์ชันล่าสุดบน GitHub')}</span>
            <span
              className={`font-mono font-semibold text-sm ${
                updateStatus?.update_available ? 'text-emerald-400' : 'text-zinc-100'
              }`}
            >
              v{updateStatus?.latest_version || '1.0.0'}
              {updateStatus?.update_available ? tx(lang, ' (Update Available)', ' (มีอัปเดตใหม่)') : ''}
            </span>
          </div>
          <div className="p-3 rounded-lg bg-zinc-950/70 border border-zinc-800">
            <span className="text-zinc-500 block text-[11px]">
              {tx(lang, 'Installer Asset', 'ไฟล์ตัวติดตั้ง')} ({updateStatus?.detected_install_kind?.toUpperCase() || 'AUTO'})
            </span>
            <span className="text-zinc-200 font-mono text-[11px] truncate block" title={updateStatus?.detected_install_dir || ''}>
              {updateStatus?.installer_name || tx(lang, 'Auto-detected from GitHub Releases', 'ตรวจจับอัตโนมัติจาก GitHub Releases')}
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
            <span className="text-zinc-400 font-semibold block">
              {tx(lang, 'Release Notes', 'บันทึกการอัปเดต')} ({updateStatus.release_name}):
            </span>
            <pre className="text-zinc-300 font-sans whitespace-pre-wrap text-[11px] leading-relaxed">
              {updateStatus.release_notes}
            </pre>
          </div>
        )}

        <div className="p-3 rounded-lg bg-zinc-950/60 border border-zinc-800/80 text-[11px] text-zinc-400 flex flex-wrap items-center justify-between gap-2">
          <span>
            {tx(lang, 'To publish a new update from your dev PC: run', 'วิธีเผยแพร่อัปเดตใหม่จากเครื่องนักพัฒนา: รันคำสั่ง')}{' '}
            <code className="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-200 font-mono">
              .\scripts\publish-update.ps1 -Version &quot;1.0.1&quot; -Notes &quot;Your fix&quot;
            </code>{' '}
            {tx(lang, 'or push a git tag', 'หรือ push git tag')}{' '}
            <code className="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-200 font-mono">
              git tag v1.0.1 &amp;&amp; git push origin main --tags
            </code>
          </span>
        </div>
      </div>
    </div>
  );
};

