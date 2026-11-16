import React, { useState, useEffect } from 'react';
import {
  CheckCircle2,
  ArrowRight,
  ArrowLeft,
  FolderOpen,
  Building2,
  CloudUpload,
  Mail,
  Send,
  Copy,
  Code2,
  AlertTriangle,
  Play,
} from 'lucide-react';
import appsScriptCode from '../../apps-script/Code.gs?raw';
import type { AppSettings } from '../types';
import { api } from '../services/tauri';

interface SetupWizardProps {
  settings: AppSettings;
  onCompleteWizard: (settings: AppSettings) => Promise<void>;
  onCancel: () => void;
}

const STEPS = [
  { step: 1, title: '1. Local Folders', desc: 'Set where PO folders are dropped and organized.' },
  { step: 2, title: '2. Google Sheet Setup', desc: 'Set up your supplier list & paste the Spreadsheet ID.' },
  { step: 3, title: '3. Apps Script & Code.gs', desc: 'Copy full Code.gs, authorize once, and deploy Web App.' },
  { step: 4, title: '4. Google Drive Folder', desc: 'Configure backup folder ID in Google Drive.' },
  { step: 5, title: '5. Email Rules & Test', desc: 'Choose Auto-Send rules, previewable PDFs & test send.' },
];

export const SetupWizard: React.FC<SetupWizardProps> = ({
  settings: initialSettings,
  onCompleteWizard,
  onCancel,
}) => {
  const [currentStep, setCurrentStep] = useState(1);
  const [settings, setSettings] = useState<AppSettings>(initialSettings);
  const [testEmailRecipient, setTestEmailRecipient] = useState('');
  const [testLog, setTestLog] = useState<{
    [key: number]: { loading: boolean; success?: boolean; message?: string };
  }>({});
  const [isFinishing, setIsFinishing] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);

  useEffect(() => {
    setSettings(initialSettings);
    if (!testEmailRecipient && initialSettings.google_account?.email) {
      setTestEmailRecipient(initialSettings.google_account.email);
    }
  }, [initialSettings, testEmailRecipient]);

  const updateSetting = <K extends keyof AppSettings>(key: K, val: AppSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: val }));
  };

  const handleCopyCode = () => {
    navigator.clipboard.writeText(appsScriptCode);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2500);
  };

  const persistCurrentSettings = async () => {
    await api.saveSettings(settings);
  };

  const runTest = async (stepNumber: number) => {
    setTestLog((prev) => ({ ...prev, [stepNumber]: { loading: true } }));
    try {
      await persistCurrentSettings();

      if (stepNumber === 2) {
        const count = await api.testSheetsConnection(
          settings.google_sheets_id,
          settings.google_sheets_tab_name,
          settings.gas_webhook_url,
          settings.gas_auth_secret
        );
        setTestLog((prev) => ({
          ...prev,
          [stepNumber]: {
            loading: false,
            success: true,
            message: `Connected! Found ${count} supplier row(s) in Google Sheet.`,
          },
        }));
      } else if (stepNumber === 3) {
        const ok = await api.testGasConnection(settings.gas_webhook_url, settings.gas_auth_secret);
        setTestLog((prev) => ({
          ...prev,
          [stepNumber]: {
            loading: false,
            success: ok,
            message: ok
              ? 'Apps Script Web App responded and Secret Key matched!'
              : 'Endpoint responded but authorization failed — check Secret Key.',
          },
        }));
      } else if (stepNumber === 4) {
        const ok = await api.testDriveConnection(settings.google_drive_folder_id);
        setTestLog((prev) => ({
          ...prev,
          [stepNumber]: {
            loading: false,
            success: ok,
            message: ok
              ? 'Drive folder ID verified!'
              : 'Enter a valid Google Drive folder ID.',
          },
        }));
      } else if (stepNumber === 5) {
        if (!testEmailRecipient.trim()) {
          throw new Error('Enter a test recipient email address first.');
        }
        const res = await api.sendTestEmail(testEmailRecipient.trim());
        setTestLog((prev) => ({
          ...prev,
          [stepNumber]: {
            loading: false,
            success: true,
            message: `Test email sent! Execution ID: ${res}`,
          },
        }));
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setTestLog((prev) => ({
        ...prev,
        [stepNumber]: { loading: false, success: false, message: `Check failed: ${msg}` },
      }));
    }
  };

  const handleFinish = async () => {
    setIsFinishing(true);
    try {
      const updated: AppSettings = {
        ...settings,
        setup_completed: true,
        auto_monitoring_active: true,
      };
      await onCompleteWizard(updated);
    } finally {
      setIsFinishing(false);
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-zinc-800">
        <div>
          <h2 className="text-base font-semibold text-zinc-100">Quick Setup &amp; Apps Script Guide</h2>
          <p className="text-xs text-zinc-400">
            Complete step-by-step instructions to connect folders, Google Sheet, Apps Script code, Drive, and Email.
          </p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="px-3.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-xs font-medium border border-zinc-700"
        >
          Back to Workspace
        </button>
      </div>

      {/* Clickable Step Tabs */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        {STEPS.map((s) => {
          const isCurrent = currentStep === s.step;
          const isDone = currentStep > s.step || testLog[s.step]?.success;
          return (
            <button
              key={s.step}
              type="button"
              onClick={() => setCurrentStep(s.step)}
              className={`p-3 rounded-xl border text-left transition-colors ${
                isCurrent
                  ? 'bg-zinc-800 border-blue-500/60 text-white'
                  : isDone
                  ? 'bg-[#121215] border-emerald-500/30 text-zinc-200'
                  : 'bg-[#121215] border-zinc-800 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <div className="flex items-center justify-between text-xs font-semibold">
                <span className="truncate">{s.title}</span>
                {testLog[s.step]?.success && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />}
              </div>
              <p className="text-[11px] text-zinc-500 mt-1 line-clamp-2">{s.desc}</p>
            </button>
          );
        })}
      </div>

      {/* Main Content Card */}
      <div className="bg-[#121215] border border-zinc-800 rounded-xl p-6 space-y-5">
        <div>
          <span className="text-[11px] font-semibold text-blue-400 uppercase tracking-wider">
            Step {currentStep} of {STEPS.length}
          </span>
          <h3 className="text-base font-semibold text-zinc-100 mt-0.5">{STEPS[currentStep - 1].title}</h3>
          <p className="text-xs text-zinc-400 mt-1">{STEPS[currentStep - 1].desc}</p>
        </div>

        {/* STEP 1: LOCAL FOLDERS */}
        {currentStep === 1 && (
          <div className="space-y-4 text-xs">
            <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800 space-y-2 text-zinc-300 leading-relaxed">
              <p className="font-semibold text-zinc-100">How Folders Work:</p>
              <ul className="list-disc pl-5 space-y-1 text-zinc-400">
                <li>
                  <strong className="text-zinc-200">Incoming Folder</strong>: Drop a PO folder here (containing PO PDF, quotation, or sticker PDFs). The watcher picks it up automatically.
                </li>
                <li>
                  <strong className="text-zinc-200">Review Folder</strong>: If Ask First is enabled or vendor score is low, the PO moves here so you can preview &amp; approve safely.
                </li>
                <li>
                  <strong className="text-zinc-200">Sent Folder</strong>: Once emailed, completed PO packages are archived cleanly here.
                </li>
              </ul>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="text-zinc-300 font-medium block mb-1">Workspace Root Folder:</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={settings.root_dir}
                    onChange={(e) => updateSetting('root_dir', e.target.value)}
                    className="flex-1 bg-zinc-900 border border-zinc-800 text-zinc-100 rounded-lg px-3 py-2 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => api.openPathInExplorer(settings.root_dir)}
                    className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 flex items-center gap-1"
                  >
                    <FolderOpen className="w-3.5 h-3.5 text-amber-400" />
                    <span>Open</span>
                  </button>
                </div>
              </div>

              <div>
                <label className="text-zinc-300 font-medium block mb-1">
                  Monitored Incoming Folder (Drop POs Here):
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={settings.incoming_dir}
                    onChange={(e) => updateSetting('incoming_dir', e.target.value)}
                    className="flex-1 bg-zinc-900 border border-zinc-800 text-zinc-100 rounded-lg px-3 py-2 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => api.openPathInExplorer(settings.incoming_dir)}
                    className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 flex items-center gap-1"
                  >
                    <FolderOpen className="w-3.5 h-3.5 text-blue-400" />
                    <span>Open</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* STEP 2: GOOGLE SHEET SETUP */}
        {currentStep === 2 && (
          <div className="space-y-4 text-xs">
            <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800 space-y-2 text-zinc-300 leading-relaxed">
              <p className="font-semibold text-zinc-100 flex items-center gap-1.5">
                <Building2 className="w-4 h-4 text-blue-400" />
                How to Prepare Your Google Sheet
              </p>
              <ol className="list-decimal pl-5 space-y-1.5 text-zinc-400">
                <li>
                  Create a Google Sheet (can be private — no need to share publicly). Put your supplier company name in Column A and recipient email in Column B (headers optional; supports Thai names, English names, or both!).
                </li>
                <li>
                  Look at your browser URL:{' '}
                  <code className="text-blue-300 font-mono">
                    https://docs.google.com/spreadsheets/d/<strong>SPREADSHEET_ID</strong>/edit
                  </code>
                </li>
                <li>Copy the long ID between <code className="text-zinc-300">/d/</code> and <code className="text-zinc-300">/edit</code> and paste it below.</li>
              </ol>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="md:col-span-2">
                <label className="text-zinc-300 font-medium block mb-1">Google Spreadsheet ID:</label>
                <input
                  type="text"
                  value={settings.google_sheets_id}
                  onChange={(e) => updateSetting('google_sheets_id', e.target.value)}
                  placeholder="1xocWPkAg6Hry1QBQPtEsElk2MEVvpEDba4MadhV7D8Y"
                  className="w-full bg-zinc-900 border border-zinc-800 text-zinc-100 rounded-lg px-3 py-2 font-mono"
                />
              </div>

              <div>
                <label className="text-zinc-300 font-medium block mb-1">Sheet Tab Name:</label>
                <input
                  type="text"
                  value={settings.google_sheets_tab_name}
                  onChange={(e) => updateSetting('google_sheets_tab_name', e.target.value)}
                  placeholder="Suppliers"
                  className="w-full bg-zinc-900 border border-zinc-800 text-zinc-100 rounded-lg px-3 py-2"
                />
              </div>
            </div>

            <button
              type="button"
              onClick={() => runTest(2)}
              disabled={testLog[2]?.loading}
              className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold"
            >
              {testLog[2]?.loading ? 'Testing Sheet...' : 'Save & Test Sheet Connection'}
            </button>

            {testLog[2] && (
              <div
                className={`p-3 rounded-lg text-xs font-medium border ${
                  testLog[2].success
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                    : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                }`}
              >
                {testLog[2].message}
              </div>
            )}
          </div>
        )}

        {/* STEP 3: APPS SCRIPT + COMPLETE CODE.GS */}
        {currentStep === 3 && (
          <div className="space-y-4 text-xs">
            <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800 space-y-2.5 text-zinc-300 leading-relaxed">
              <p className="font-semibold text-zinc-100 flex items-center gap-1.5">
                <Code2 className="w-4 h-4 text-blue-400" />
                Exact Apps Script Setup (No Extra Services Needed!)
              </p>
              <ol className="list-decimal pl-5 space-y-1.5 text-zinc-400">
                <li>
                  Open your Google Sheet and click <strong className="text-zinc-200">Extensions → Apps Script</strong> (or open <span className="text-blue-300">script.google.com</span>).
                </li>
                <li>
                  Select all code inside <code className="text-zinc-200 font-mono">Code.gs</code>, delete it, click <strong className="text-zinc-200">Copy Complete Code.gs</strong> below, paste it (<kbd className="px-1 py-0.5 rounded bg-zinc-800">Ctrl+V</kbd>), and press <kbd className="px-1 py-0.5 rounded bg-zinc-800">Ctrl+S</kbd> to save.
                </li>
                <li>
                  <strong className="text-emerald-300">Do NOT add anything in &quot;Services (+)&quot;</strong>: Drive API v3 is <strong>not</strong> needed — this script uses built-in <code className="text-zinc-200 font-mono">SpreadsheetApp</code>, <code className="text-zinc-200 font-mono">DriveApp</code>, and <code className="text-zinc-200 font-mono">GmailApp</code>.
                </li>
                <li>
                  Optional custom secret: in <strong className="text-zinc-200">Project Settings → Script Properties</strong>, add <code className="text-zinc-200 font-mono">AUTH_SECRET</code> matching the key below (or leave unset to use the default secret key).
                </li>
                <li>
                  Select <code className="text-blue-300 font-mono">authorizeAllPermissions</code> in the top function dropdown and click <strong className="text-zinc-200">Run</strong> → <strong className="text-zinc-200">Review permissions → Advanced → Go to project → Allow</strong>.
                </li>
                <li>
                  Click <strong className="text-zinc-200">Deploy → New deployment</strong> (or <strong className="text-zinc-200">Manage deployments → Edit → New version</strong>), choose <strong className="text-zinc-200">Web app</strong>, set Execute as: <strong className="text-zinc-200">Me</strong>, Who has access: <strong className="text-zinc-200">Anyone</strong>, then click <strong className="text-zinc-200">Deploy</strong> and paste the <code className="text-blue-300 font-mono">/exec</code> URL below.
                </li>
              </ol>
            </div>

            {/* Full Copyable Code.gs Viewer */}
            <div className="rounded-xl border border-zinc-800 bg-black overflow-hidden">
              <div className="px-4 py-2.5 bg-zinc-900 border-b border-zinc-800 flex items-center justify-between gap-2">
                <span className="font-mono text-xs text-zinc-200 font-semibold">
                  apps-script/Code.gs (Complete Ready-to-Deploy Script)
                </span>
                <button
                  type="button"
                  onClick={handleCopyCode}
                  className="px-3 py-1 rounded-md bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold flex items-center gap-1.5"
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span>{copiedCode ? 'Copied Code.gs!' : 'Copy Complete Code.gs'}</span>
                </button>
              </div>
              <pre className="p-4 text-[11px] font-mono text-emerald-300 max-h-64 overflow-auto select-text leading-relaxed">
                {appsScriptCode}
              </pre>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="md:col-span-2">
                <label className="text-zinc-300 font-medium block mb-1">
                  Deployed Apps Script Web App URL (<code className="text-zinc-400">.../exec</code>):
                </label>
                <input
                  type="text"
                  value={settings.gas_webhook_url}
                  onChange={(e) => updateSetting('gas_webhook_url', e.target.value)}
                  placeholder="https://script.google.com/macros/s/AKfycb.../exec"
                  className="w-full bg-zinc-900 border border-zinc-800 text-zinc-100 rounded-lg px-3 py-2 font-mono"
                />
              </div>

              <div>
                <label className="text-zinc-300 font-medium block mb-1">Webhook Secret Key:</label>
                <input
                  type="text"
                  value={settings.gas_auth_secret}
                  onChange={(e) => updateSetting('gas_auth_secret', e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 text-zinc-100 rounded-lg px-3 py-2 font-mono"
                />
              </div>
            </div>

            <button
              type="button"
              onClick={() => runTest(3)}
              disabled={testLog[3]?.loading}
              className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold"
            >
              {testLog[3]?.loading ? 'Testing Webhook...' : 'Save & Test Webhook Endpoint'}
            </button>

            {testLog[3] && (
              <div
                className={`p-3 rounded-lg text-xs font-medium border ${
                  testLog[3].success
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                    : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                }`}
              >
                {testLog[3].message}
              </div>
            )}
          </div>
        )}

        {/* STEP 4: GOOGLE DRIVE FOLDER */}
        {currentStep === 4 && (
          <div className="space-y-4 text-xs">
            <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800 space-y-2 text-zinc-300 leading-relaxed">
              <p className="font-semibold text-zinc-100 flex items-center gap-1.5">
                <CloudUpload className="w-4 h-4 text-blue-400" />
                Google Drive Backup Folder Setup
              </p>
              <ol className="list-decimal pl-5 space-y-1 text-zinc-400">
                <li>Open Google Drive and create or open a folder for your PO backups.</li>
                <li>
                  Copy the ID from the URL:{' '}
                  <code className="text-blue-300 font-mono">
                    https://drive.google.com/drive/folders/<strong>FOLDER_ID</strong>
                  </code>
                </li>
                <li>Paste that Folder ID below. Uploads go through Apps Script&apos;s built-in <code className="text-zinc-200 font-mono">DriveApp</code> automatically.</li>
              </ol>
            </div>

            <div>
              <label className="text-zinc-300 font-medium block mb-1">Google Drive Folder ID:</label>
              <input
                type="text"
                value={settings.google_drive_folder_id}
                onChange={(e) => updateSetting('google_drive_folder_id', e.target.value)}
                placeholder="10yHZNZ2MbRqtVQpabYOSdSoUy4wSTgFZ"
                className="w-full bg-zinc-900 border border-zinc-800 text-zinc-100 rounded-lg px-3 py-2 font-mono"
              />
            </div>

            <button
              type="button"
              onClick={() => runTest(4)}
              disabled={testLog[4]?.loading}
              className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold"
            >
              {testLog[4]?.loading ? 'Checking Drive...' : 'Save & Test Drive Folder'}
            </button>

            {testLog[4] && (
              <div
                className={`p-3 rounded-lg text-xs font-medium border ${
                  testLog[4].success
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                    : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                }`}
              >
                {testLog[4].message}
              </div>
            )}
          </div>
        )}

        {/* STEP 5: EMAIL RULES & LIVE TEST */}
        {currentStep === 5 && (
          <div className="space-y-4 text-xs">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800 space-y-2">
                <label className="font-semibold text-zinc-100 flex items-center gap-1.5">
                  <Send className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Auto-Send Email Behavior</span>
                </label>
                <select
                  value={
                    settings.auto_send_email_enabled === false
                      ? 'manual_review_all'
                      : settings.auto_send_mode || 'verified_and_high'
                  }
                  onChange={(e) => {
                    const v = e.target.value as 'verified_and_high' | 'verified_only' | 'manual_review_all';
                    setSettings((prev) => ({
                      ...prev,
                      auto_send_email_enabled: v !== 'manual_review_all',
                      auto_send_mode: v,
                    }));
                  }}
                  className="w-full bg-zinc-900 border border-zinc-800 text-zinc-100 rounded-lg px-3 py-2"
                >
                  <option value="manual_review_all">Ask Me First (Hold in Review for approval)</option>
                  <option value="verified_and_high">Auto-Send Matched POs (≥90% confidence)</option>
                  <option value="verified_only">Strict Verified Only (≥98% confidence)</option>
                </select>
              </div>

              <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800 space-y-2">
                <label className="font-semibold text-zinc-100 flex items-center gap-1.5">
                  <Mail className="w-3.5 h-3.5 text-blue-400" />
                  <span>Email Attachment Style</span>
                </label>
                <select
                  value={settings.email_attachment_mode || 'individual_files'}
                  onChange={(e) =>
                    updateSetting(
                      'email_attachment_mode',
                      e.target.value as 'individual_files' | 'zip_archive' | 'both'
                    )
                  }
                  className="w-full bg-zinc-900 border border-zinc-800 text-zinc-100 rounded-lg px-3 py-2"
                >
                  <option value="individual_files">Individual Previewable Files (PDF/Images — Recommended)</option>
                  <option value="both">Both Individual Files + ZIP Archive</option>
                  <option value="zip_archive">Single Compressed ZIP Only</option>
                </select>
              </div>
            </div>

            <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800 space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-zinc-100">Optional: Send a Test Email Now</span>
                <span className="text-[11px] text-zinc-500">Sends TEST-PO-0001 only if you click the button</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <input
                  type="email"
                  value={testEmailRecipient}
                  onChange={(e) => setTestEmailRecipient(e.target.value)}
                  placeholder="your-test-email@gmail.com"
                  className="flex-1 min-w-[220px] bg-zinc-900 border border-zinc-800 text-zinc-100 rounded-lg px-3 py-2 font-mono"
                />
                <button
                  type="button"
                  onClick={() => runTest(5)}
                  disabled={testLog[5]?.loading}
                  className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-100 font-semibold"
                >
                  {testLog[5]?.loading ? 'Sending...' : 'Send Test Email'}
                </button>
              </div>
              {testLog[5] && (
                <div
                  className={`p-3 rounded-lg text-xs font-medium border flex items-center gap-2 ${
                    testLog[5].success
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                      : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                  }`}
                >
                  {testLog[5].success ? (
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                  ) : (
                    <AlertTriangle className="w-4 h-4 shrink-0" />
                  )}
                  <span>{testLog[5].message}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Footer Controls */}
        <div className="flex items-center justify-between pt-4 border-t border-zinc-800">
          <button
            type="button"
            disabled={currentStep === 1}
            onClick={() => setCurrentStep((s) => Math.max(1, s - 1))}
            className="px-4 py-2 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 disabled:opacity-40 text-zinc-200 text-xs font-medium flex items-center gap-1.5"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Previous</span>
          </button>

          <div className="flex items-center gap-2">
            {currentStep < STEPS.length ? (
              <button
                type="button"
                onClick={() => setCurrentStep((s) => Math.min(STEPS.length, s + 1))}
                className="px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold flex items-center gap-1.5"
              >
                <span>Next Step</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            ) : (
              <button
                type="button"
                disabled={isFinishing}
                onClick={handleFinish}
                className="px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center gap-1.5"
              >
                <Play className="w-3.5 h-3.5" />
                <span>{isFinishing ? 'Saving...' : 'Save & Start Watching Incoming'}</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
