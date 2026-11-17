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
import { remapWorkspacePaths } from '../utils/workspacePaths';
import { tr, tx, type UiLang } from '../i18n';

interface SetupWizardProps {
  settings: AppSettings;
  onCompleteWizard: (settings: AppSettings) => Promise<void>;
  onCancel: () => void;
  lang?: UiLang;
}

const getSteps = (lang: UiLang) => [
  {
    step: 1,
    title: tx(lang, '1. Local Folders', '1. โฟลเดอร์ในเครื่อง'),
    desc: tx(lang, 'Set where PO folders are dropped and organized.', 'กำหนดโฟลเดอร์สำหรับวางและจัดเก็บไฟล์ PO'),
  },
  {
    step: 2,
    title: tx(lang, '2. Google Sheet Setup', '2. เชื่อมต่อ Google Sheet'),
    desc: tx(lang, 'Set up your supplier list & paste the Spreadsheet ID.', 'ตั้งค่าตารางรายชื่อผู้ขายและวาง Spreadsheet ID'),
  },
  {
    step: 3,
    title: tx(lang, '3. Apps Script & Code.gs', '3. โค้ด Apps Script'),
    desc: tx(lang, 'Copy full Code.gs, authorize once, and deploy Web App.', 'คัดลอก Code.gs อนุญาตสิทธิ์ครั้งแรก และ Deploy Web App'),
  },
  {
    step: 4,
    title: tx(lang, '4. Google Drive Folder', '4. โฟลเดอร์ Google Drive'),
    desc: tx(lang, 'Configure backup folder ID in Google Drive.', 'กำหนด Folder ID สำหรับสำรองไฟล์บน Google Drive'),
  },
  {
    step: 5,
    title: tx(lang, '5. Email Rules & Test', '5. เงื่อนไขการส่งและทดสอบ'),
    desc: tx(lang, 'Choose Auto-Send rules, previewable PDFs & test send.', 'ตั้งเงื่อนไขการส่งอัตโนมัติ รูปแบบไฟล์แนบ และลองส่งอีเมล'),
  },
];

export const SetupWizard: React.FC<SetupWizardProps> = ({
  settings: initialSettings,
  onCompleteWizard,
  onCancel,
  lang = 'en',
}) => {
  const STEPS = getSteps(lang);
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
            message: tx(
              lang,
              `Connected! Found ${count} supplier row(s) in Google Sheet.`,
              `เชื่อมต่อสำเร็จ! พบรายชื่อผู้ขาย ${count} แถวใน Google Sheet`
            ),
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
              ? tx(
                  lang,
                  'Apps Script Web App responded and Secret Key matched!',
                  'Apps Script Web App ตอบสนองปกติและ Secret Key ตรงกันแล้ว!'
                )
              : tx(
                  lang,
                  'Endpoint responded but authorization failed — check Secret Key.',
                  'Endpoint ตอบกลับแต่ยืนยันสิทธิ์ไม่ผ่าน — กรุณาตรวจสอบ Secret Key'
                ),
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
              ? tx(lang, 'Drive folder ID verified!', 'ตรวจสอบ Google Drive Folder ID สำเร็จ!')
              : tx(lang, 'Enter a valid Google Drive folder ID.', 'กรุณากรอก Google Drive Folder ID ให้ถูกต้อง'),
          },
        }));
      } else if (stepNumber === 5) {
        if (!testEmailRecipient.trim()) {
          throw new Error(
            tx(lang, 'Enter a test recipient email address first.', 'กรุณากรอกอีเมลผู้รับทดสอบก่อน')
          );
        }
        const res = await api.sendTestEmail(testEmailRecipient.trim());
        setTestLog((prev) => ({
          ...prev,
          [stepNumber]: {
            loading: false,
            success: true,
            message: tx(lang, `Test email sent! Execution ID: ${res}`, `ส่งอีเมลทดสอบแล้ว! Execution ID: ${res}`),
          },
        }));
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setTestLog((prev) => ({
        ...prev,
        [stepNumber]: {
          loading: false,
          success: false,
          message: tx(lang, `Check failed: ${msg}`, `ตรวจสอบไม่สำเร็จ: ${msg}`),
        },
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
          <h2 className="text-base font-semibold text-zinc-100">{tr(lang, 'tabSetupTitle')}</h2>
          <p className="text-xs text-zinc-400">
            {tr(lang, 'tabSetupSub')}
          </p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="px-3.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-xs font-medium border border-zinc-700"
        >
          {tr(lang, 'setupBack')}
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
            {tx(lang, `Step ${currentStep} of ${STEPS.length}`, `ขั้นตอนที่ ${currentStep} จาก ${STEPS.length}`)}
          </span>
          <h3 className="text-base font-semibold text-zinc-100 mt-0.5">{STEPS[currentStep - 1].title}</h3>
          <p className="text-xs text-zinc-400 mt-1">{STEPS[currentStep - 1].desc}</p>
        </div>

        {/* STEP 1: LOCAL FOLDERS */}
        {currentStep === 1 && (
          <div className="space-y-4 text-xs">
            <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800 space-y-2 text-zinc-300 leading-relaxed">
              <p className="font-semibold text-zinc-100">{tx(lang, 'How Folders Work:', 'หลักการทำงานของโฟลเดอร์:')}</p>
              <ul className="list-disc pl-5 space-y-1 text-zinc-400">
                <li>
                  <strong className="text-zinc-200">Incoming Folder</strong>:{' '}
                  {tx(
                    lang,
                    'Drop a PO folder here (containing PO PDF, quotation, or sticker PDFs). The watcher picks it up automatically.',
                    'นำโฟลเดอร์ PO (มี PDF ใบสั่งซื้อ ใบเสนอราคา หรือไฟล์แนบ) มาวางที่นี่ ระบบจะตรวจจับและเริ่มประมวลผลอัตโนมัติ'
                  )}
                </li>
                <li>
                  <strong className="text-zinc-200">Review Folder</strong>:{' '}
                  {tx(
                    lang,
                    'If Ask First is enabled or vendor score is low, the PO moves here so you can preview & approve safely.',
                    'หากเปิดโหมดถามก่อนส่ง หรือคะแนนจับคู่ผู้ขายยังไม่ถึงเกณฑ์ ระบบจะย้ายมาพักที่นี่ให้คุณตรวจสอบและกดอนุมัติ'
                  )}
                </li>
                <li>
                  <strong className="text-zinc-200">Sent Folder</strong>:{' '}
                  {tx(
                    lang,
                    'Once emailed, completed PO packages are archived cleanly here.',
                    'เมื่อส่งอีเมลสำเร็จ โฟลเดอร์ PO จะถูกย้ายมาเก็บไว้ที่นี่อย่างเป็นระเบียบ'
                  )}
                </li>
              </ul>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="text-zinc-300 font-medium block mb-1">
                  {tx(lang, 'Workspace Root Folder:', 'โฟลเดอร์หลักของโปรแกรม (Root):')}
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={settings.root_dir}
                    onChange={(e) =>
                      setSettings((prev) => remapWorkspacePaths(prev, e.target.value, true))
                    }
                    className="flex-1 bg-zinc-900 border border-zinc-800 text-zinc-100 rounded-lg px-3 py-2 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => api.openPathInExplorer(settings.root_dir)}
                    className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 flex items-center gap-1"
                  >
                    <FolderOpen className="w-3.5 h-3.5 text-amber-400" />
                    <span>{tx(lang, 'Open', 'เปิด')}</span>
                  </button>
                </div>
                <p className="text-[11px] text-zinc-500 mt-1">
                  {tx(
                    lang,
                    'Automatically updates Incoming, Processing, Review, Sent, Failed & Models under this root.',
                    'อัปเดตโฟลเดอร์ Incoming, Processing, Review, Sent, Failed และ Models ภายใต้โฟลเดอร์หลักนี้อัตโนมัติ'
                  )}
                </p>
              </div>

              <div>
                <label className="text-zinc-300 font-medium block mb-1">
                  {tx(lang, 'Monitored Incoming Folder (Drop POs Here):', 'โฟลเดอร์รับเข้า Incoming (วางโฟลเดอร์ PO ที่นี่):')}
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
                    <span>{tx(lang, 'Open', 'เปิด')}</span>
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
                {tx(lang, 'How to Prepare Your Google Sheet', 'วิธีเตรียมไฟล์ Google Sheet รายชื่อผู้ขาย')}
              </p>
              <ol className="list-decimal pl-5 space-y-1.5 text-zinc-400">
                <li>
                  {tx(
                    lang,
                    'Create a Google Sheet (can be private — no need to share publicly). Put your supplier Thai/Primary name in Column A, English/Alternate name in Column B, recipient email in Column C, and optional Proofing/Notes in Column D (headers optional; supports filling Thai, English, or both!).',
                    'สร้างไฟล์ Google Sheet (ตั้งเป็นส่วนตัวได้ ไม่ต้องเปิดสาธารณะ) ใส่ชื่อบริษัทผู้ขาย (ภาษาไทยหรือชื่อหลัก) ในคอลัมน์ A, ชื่ออังกฤษ/ชื่อสำรองในคอลัมน์ B, อีเมลในคอลัมน์ C และข้อมูลตรวจทาน/หมายเหตุในคอลัมน์ D (จะใส่ทั้งสองชื่อหรือใส่แค่ชื่อเดียวก็ได้!)'
                  )}
                </li>
                <li>
                  {tx(lang, 'Look at your browser URL:', 'ดูที่ลิงก์บนเบราว์เซอร์:')}{' '}
                  <code className="text-blue-300 font-mono">
                    https://docs.google.com/spreadsheets/d/<strong>SPREADSHEET_ID</strong>/edit
                  </code>
                </li>
                <li>
                  {tx(
                    lang,
                    'Copy the long ID between /d/ and /edit and paste it below.',
                    'คัดลอกรหัส ID ยาวๆ ระหว่าง /d/ และ /edit แล้วนำมาวางด้านล่าง'
                  )}
                </li>
              </ol>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="md:col-span-2">
                <label className="text-zinc-300 font-medium block mb-1">
                  {tx(lang, 'Google Spreadsheet ID:', 'รหัส Google Spreadsheet ID:')}
                </label>
                <input
                  type="text"
                  value={settings.google_sheets_id}
                  onChange={(e) => updateSetting('google_sheets_id', e.target.value)}
                  placeholder="1xocWPkAg6Hry1QBQPtEsElk2MEVvpEDba4MadhV7D8Y"
                  className="w-full bg-zinc-900 border border-zinc-800 text-zinc-100 rounded-lg px-3 py-2 font-mono"
                />
              </div>

              <div>
                <label className="text-zinc-300 font-medium block mb-1">
                  {tx(lang, 'Sheet Tab Name:', 'ชื่อแท็บ (Tab Name):')}
                </label>
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
              {testLog[2]?.loading
                ? tx(lang, 'Testing Sheet...', 'กำลังทดสอบการเชื่อมต่อ...')
                : tx(lang, 'Save & Test Sheet Connection', 'บันทึกและทดสอบเชื่อมต่อ Sheet')}
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
                {tx(lang, 'Exact Apps Script Setup (No Extra Services Needed!)', 'ขั้นตอนติดตั้ง Apps Script (ไม่ต้องเปิด Services เพิ่ม!)')}
              </p>
              <ol className="list-decimal pl-5 space-y-1.5 text-zinc-400">
                <li>
                  {tx(lang, 'Open your Google Sheet and click', 'เปิดไฟล์ Google Sheet ของคุณ แล้วคลิก')}{' '}
                  <strong className="text-zinc-200">Extensions → Apps Script</strong>{' '}
                  {tx(lang, '(or open script.google.com).', '(หรือเปิด script.google.com)')}
                </li>
                <li>
                  {tx(lang, 'Select all code inside', 'ลบโค้ดเดิมทั้งหมดใน')}{' '}
                  <code className="text-zinc-200 font-mono">Code.gs</code>{' '}
                  {tx(lang, ', click Copy Complete Code.gs below, paste it (Ctrl+V), and press Ctrl+S to save.', 'แล้วกด คัดลอก Code.gs ด้านล่าง ไปวางแทนที่ (Ctrl+V) จากนั้นกด Ctrl+S เพื่อบันทึก')}
                </li>
                <li>
                  <strong className="text-emerald-300">
                    {tx(lang, 'Do NOT add anything in "Services (+)"', 'ไม่ต้องเพิ่มอะไรในเมนู "Services (+)"')}
                  </strong>
                  :{' '}
                  {tx(
                    lang,
                    'Drive API v3 is not needed — this script uses built-in SpreadsheetApp, DriveApp, and GmailApp.',
                    'สคริปต์ใช้ SpreadsheetApp, DriveApp และ GmailApp ในตัวอยู่แล้ว'
                  )}
                </li>
                <li>
                  {tx(
                    lang,
                    'Optional custom secret: in Project Settings → Script Properties, add AUTH_SECRET matching the key below (or leave unset to use the default secret key).',
                    'หากต้องการตั้งรหัสลับเอง: ไปที่ Project Settings → Script Properties เพิ่ม AUTH_SECRET ให้ตรงกับช่อง Secret Key ด้านล่าง (หรือปล่อยว่างไว้ใช้ค่าเริ่มต้น)'
                  )}
                </li>
                <li>
                  {tx(lang, 'Select', 'เลือกฟังก์ชัน')}{' '}
                  <code className="text-blue-300 font-mono">authorizeAllPermissions</code>{' '}
                  {tx(
                    lang,
                    'in the top function dropdown and click Run → Review permissions → Advanced → Go to project → Allow.',
                    'จากช่องด้านบนแล้วกด Run → Review permissions → Advanced → Go to project → Allow เพื่ออนุญาตสิทธิ์'
                  )}
                </li>
                <li>
                  {tx(
                    lang,
                    'Click Deploy → New deployment (or Manage deployments → Edit → New version), choose Web app, set Execute as: Me, Who has access: Anyone, then click Deploy and paste the /exec URL below.',
                    'กด Deploy → New deployment (หรือ Manage deployments → Edit → New version) เลือก Web app, Execute as: Me, Who has access: Anyone แล้วกด Deploy จากนั้นนำ URL ที่ลงท้าย /exec มาวางด้านล่าง'
                  )}
                </li>
              </ol>
            </div>

            {/* Full Copyable Code.gs Viewer */}
            <div className="rounded-xl border border-zinc-800 bg-black overflow-hidden">
              <div className="px-4 py-2.5 bg-zinc-900 border-b border-zinc-800 flex items-center justify-between gap-2">
                <span className="font-mono text-xs text-zinc-200 font-semibold">
                  apps-script/Code.gs ({tx(lang, 'Complete Ready-to-Deploy Script', 'โค้ดพร้อมใช้งานฉบับสมบูรณ์')})
                </span>
                <button
                  type="button"
                  onClick={handleCopyCode}
                  className="px-3 py-1 rounded-md bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold flex items-center gap-1.5"
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span>
                    {copiedCode
                      ? tx(lang, 'Copied Code.gs!', 'คัดลอก Code.gs แล้ว!')
                      : tx(lang, 'Copy Complete Code.gs', 'คัดลอก Code.gs ทั้งหมด')}
                  </span>
                </button>
              </div>
              <pre className="p-4 text-[11px] font-mono text-emerald-300 max-h-64 overflow-auto select-text leading-relaxed">
                {appsScriptCode}
              </pre>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="md:col-span-2">
                <label className="text-zinc-300 font-medium block mb-1">
                  {tx(lang, 'Deployed Apps Script Web App URL', 'URL ของ Apps Script Web App')} (<code className="text-zinc-400">.../exec</code>):
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
                <label className="text-zinc-300 font-medium block mb-1">
                  {tx(lang, 'Webhook Secret Key:', 'รหัสลับ Webhook Secret Key:')}
                </label>
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
              {testLog[3]?.loading
                ? tx(lang, 'Testing Webhook...', 'กำลังทดสอบ Webhook...')
                : tx(lang, 'Save & Test Webhook Endpoint', 'บันทึกและทดสอบ Webhook')}
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
                {tx(lang, 'Google Drive Backup Folder Setup', 'การตั้งค่าโฟลเดอร์สำรองไฟล์บน Google Drive')}
              </p>
              <ol className="list-decimal pl-5 space-y-1 text-zinc-400">
                <li>{tx(lang, 'Open Google Drive and create or open a folder for your PO backups.', 'เปิด Google Drive แล้วสร้างหรือเปิดโฟลเดอร์สำหรับเก็บไฟล์สำรองใบ PO')}</li>
                <li>
                  {tx(lang, 'Copy the ID from the URL:', 'คัดลอกรหัส Folder ID จาก URL:')}{' '}
                  <code className="text-blue-300 font-mono">
                    https://drive.google.com/drive/folders/<strong>FOLDER_ID</strong>
                  </code>
                </li>
                <li>
                  {tx(
                    lang,
                    "Paste that Folder ID below. Uploads go through Apps Script's built-in DriveApp automatically.",
                    'วางรหัส Folder ID ด้านล่าง ระบบจะอัปโหลดผ่าน DriveApp ของ Apps Script ให้โดยอัตโนมัติ'
                  )}
                </li>
              </ol>
            </div>

            <div>
              <label className="text-zinc-300 font-medium block mb-1">
                {tx(lang, 'Google Drive Folder ID:', 'รหัส Google Drive Folder ID:')}
              </label>
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
              {testLog[4]?.loading
                ? tx(lang, 'Checking Drive...', 'กำลังตรวจสอบ Google Drive...')
                : tx(lang, 'Save & Test Drive Folder', 'บันทึกและทดสอบโฟลเดอร์ Drive')}
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
                  <span>{tx(lang, 'Auto-Send Email Behavior', 'รูปแบบการส่งอีเมลอัตโนมัติ')}</span>
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
                  <option value="manual_review_all">
                    {tx(lang, 'Ask Me First (Hold in Review for approval)', 'ถามก่อนส่ง (พักไว้รอคุณอนุมัติทุกฉบับ)')}
                  </option>
                  <option value="verified_and_high">
                    {tx(lang, 'Auto-Send Matched POs (≥90% confidence)', 'ส่งอัตโนมัติเมื่อจับคู่แม่นยำ (≥90%)')}
                  </option>
                  <option value="verified_only">
                    {tx(lang, 'Strict Verified Only (≥98% confidence)', 'เข้มงวดเฉพาะรายการยืนยัน (≥98%)')}
                  </option>
                </select>
              </div>

              <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800 space-y-2">
                <label className="font-semibold text-zinc-100 flex items-center gap-1.5">
                  <Mail className="w-3.5 h-3.5 text-blue-400" />
                  <span>{tx(lang, 'Email Attachment Style', 'รูปแบบไฟล์แนบอีเมล')}</span>
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
                  <option value="individual_files">
                    {tx(lang, 'Individual Previewable Files (PDF/Images — Recommended)', 'แยกไฟล์เดี่ยว เปิดดูใน Gmail ได้ทันที (แนะนำ)')}
                  </option>
                  <option value="both">
                    {tx(lang, 'Both Individual Files + ZIP Archive', 'แนบทั้งไฟล์เดี่ยว และไฟล์ ZIP รวม')}
                  </option>
                  <option value="zip_archive">
                    {tx(lang, 'Single Compressed ZIP Only', 'แนบเฉพาะไฟล์บีบอัด .zip')}
                  </option>
                </select>
              </div>
            </div>

            <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800 space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-zinc-100">
                  {tx(lang, 'Optional: Send a Test Email Now', 'ตัวเลือกเพิ่มเติม: ทดลองส่งอีเมลทันที')}
                </span>
                <span className="text-[11px] text-zinc-500">
                  {tx(lang, 'Sends TEST-PO-0001 only if you click the button', 'ส่ง TEST-PO-0001 เฉพาะเมื่อกดปุ่มนี้')}
                </span>
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
                  {testLog[5]?.loading
                    ? tx(lang, 'Sending...', 'กำลังส่ง...')
                    : tx(lang, 'Send Test Email', 'ส่งอีเมลทดสอบ')}
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
            <span>{lang === 'th' ? 'ย้อนกลับ' : 'Previous'}</span>
          </button>

          <div className="flex items-center gap-2">
            {currentStep < STEPS.length ? (
              <button
                type="button"
                onClick={() => setCurrentStep((s) => Math.min(STEPS.length, s + 1))}
                className="px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold flex items-center gap-1.5"
              >
                <span>{lang === 'th' ? 'ขั้นตอนถัดไป' : 'Next Step'}</span>
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
                <span>
                  {isFinishing
                    ? tr(lang, 'saving')
                    : lang === 'th'
                    ? 'บันทึกและเริ่มเฝ้าโฟลเดอร์ Incoming'
                    : 'Save & Start Watching Incoming'}
                </span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
