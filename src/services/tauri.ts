import { invoke } from '@tauri-apps/api/core';
import type {
  AppSettings,
  Job,
  PoTransaction,
  OcrResultRecord,
  CompanyCacheEntry,
  CompanyAlias,
  DashboardStats,
  ApplicationEvent,
  AuditLog,
  GoogleAccountInfo,
  PagePreviewResponse,
  DeveloperConsoleSnapshot,
} from '../types';

export interface GitHubUpdateStatus {
  current_version: string;
  latest_version: string;
  update_available: boolean;
  release_name: string;
  release_notes: string;
  published_at: string;
  release_url: string;
  installer_url?: string | null;
  installer_name?: string | null;
  installer_size_bytes?: number | null;
  repository: string;
}

export async function checkGitHubUpdate(repoOverride?: string): Promise<GitHubUpdateStatus> {
  if (isTauriEnvironment()) {
    return await invoke<GitHubUpdateStatus>('check_github_update', {
      repoOverride: repoOverride || null,
    });
  }
  return {
    current_version: '1.0.0',
    latest_version: '1.0.0',
    update_available: false,
    release_name: 'PO AutoFlow Enterprise v1.0.0',
    release_notes: 'GitHub Releases updater is active in desktop runtime.',
    published_at: new Date().toISOString(),
    release_url: 'https://github.com/oscarpooper-lang/po-autoflow-enterprise/releases',
    installer_url: null,
    installer_name: null,
    installer_size_bytes: null,
    repository: repoOverride || 'oscarpooper-lang/po-autoflow-enterprise',
  };
}

export async function installGitHubUpdate(
  installerUrl: string,
  installerName?: string
): Promise<string> {
  if (isTauriEnvironment()) {
    return await invoke<string>('install_github_update', {
      installerUrl,
      installerName: installerName || null,
    });
  }
  throw new Error('Downloading and launching installer requires desktop runtime.');
}

// Detect if running inside real Tauri webview
export const isTauriEnvironment = (): boolean => {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
};

// Fallback in-memory state for browser preview/development and initial boot
export const defaultSettings: AppSettings = {
  root_dir: 'C:\\PO-AutoFlow',
  incoming_dir: 'C:\\PO-AutoFlow\\Incoming',
  processing_dir: 'C:\\PO-AutoFlow\\Processing',
  sent_dir: 'C:\\PO-AutoFlow\\Sent',
  failed_dir: 'C:\\PO-AutoFlow\\Failed',
  review_dir: 'C:\\PO-AutoFlow\\Review',
  temp_dir: 'C:\\PO-AutoFlow\\Temp',
  logs_dir: 'C:\\PO-AutoFlow\\Logs',
  poll_interval_ms: 2000,
  stability_delay_ms: 1500,
  stability_checks: 3,
  ocr_engine_primary: 'paddleocr',
  ocr_confidence_threshold_verified: 98.0,
  ocr_confidence_threshold_high: 90.0,
  ocr_confidence_threshold_review: 75.0,
  google_sheets_id: '',
  google_sheets_tab_name: 'Suppliers',
  google_drive_folder_id: '',
  gas_webhook_url: '',
  gas_auth_secret: 'po-autoflow-enterprise-secret-key',
  email_subject_template: 'Purchase Order - {{PO_NUMBER}} - {{COMPANY_NAME}}',
  email_body_template: 'Dear {{COMPANY_NAME}},\n\nPlease find attached the Purchase Order documents for your reference.\n\nPO Number: {{PO_NUMBER}}\n\nPlease acknowledge receipt.\n\nBest regards,\nPO Automation System',
  max_zip_file_mb: 25,
  auto_monitoring_active: false,
  dark_mode: true,
  setup_completed: false,
  developer_mode_enabled: true,
  debug_logging_enabled: true,
  dry_run_simulation_mode: false,
  save_debug_ocr_images: false,
  auto_send_email_enabled: true,
  auto_send_mode: 'verified_and_high',
  allow_pdf_email_fallback: false,
  require_drive_backup_for_auto_send: false,
  email_attachment_mode: 'individual_files',
};

let mockSettings: AppSettings = { ...defaultSettings };

let mockCompanies: CompanyCacheEntry[] = [
  {
    id: 'comp_1',
    company_name: 'บริษัท สยาม ซัพพลาย แอนด์ เทรดดิ้ง จำกัด',
    alternative_name: 'SIAM SUPPLY & TRADING CO., LTD.',
    email: 'billing@siamsupply.co.th',
    active: true,
    tax_id: '0105556012345',
    synced_at: new Date().toISOString(),
  },
  {
    id: 'comp_2',
    company_name: 'บริษัท บางกอก ออโตเมชั่น โซลูชั่นส์ จำกัด',
    alternative_name: 'BANGKOK AUTOMATION SOLUTIONS CO., LTD.',
    email: 'po@bangkok-auto.com',
    active: true,
    tax_id: '0105557089123',
    synced_at: new Date().toISOString(),
  },
  {
    id: 'comp_3',
    company_name: 'ห้างหุ้นส่วนจำกัด ไทยอินดัสเตรียล พาร์ทส์',
    alternative_name: 'THAI INDUSTRIAL PARTS LTD., PART.',
    email: 'orders@thaiindustrial.com',
    active: true,
    tax_id: '0103554009876',
    synced_at: new Date().toISOString(),
  },
  {
    id: 'comp_4',
    company_name: 'บริษัท แอดวานซ์ ดิจิทัล โลจิสติกส์ จำกัด (มหาชน)',
    alternative_name: 'ADVANCED DIGITAL LOGISTICS PCL',
    email: 'finance@advanced-logistics.co.th',
    active: true,
    tax_id: '0107559001122',
    synced_at: new Date().toISOString(),
  },
];

let mockAliases: CompanyAlias[] = [
  {
    id: 'alias_1',
    alias: 'บจก. สยาม ซัพพลาย',
    canonical_company_name: 'บริษัท สยาม ซัพพลาย แอนด์ เทรดดิ้ง จำกัด',
    created_by: 'OFFICE_STAFF',
    created_at: new Date(Date.now() - 86400000 * 3).toISOString(),
  },
];

let mockJobs: Job[] = [
  {
    id: 'job-9801',
    po_folder_name: 'PO-26002323',
    source_path: 'C:\\PO-AutoFlow\\Sent\\PO-26002323',
    status: 'completed',
    stage_message: 'Delivered to billing@siamsupply.co.th. Execution ID: gas-exec-9872',
    po_number: 'PO-26002323',
    detected_company_raw: 'บริษัท สยาม ซัพพลาย แอนด์ เทรดดิ้ง จำกัด',
    matched_company_name: 'บริษัท สยาม ซัพพลาย แอนด์ เทรดดิ้ง จำกัด',
    matched_email: 'billing@siamsupply.co.th',
    match_confidence: 99.4,
    match_category: 'verified',
    archive_path: 'C:\\PO-AutoFlow\\Temp\\PO-26002323.zip',
    archive_sha256: 'a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0',
    archive_size_bytes: 4851200,
    drive_file_id: '1Drive_PO_26002323',
    drive_web_link: 'https://drive.google.com/file/d/1Drive_PO_26002323/view',
    email_transaction_id: 'tx-26002323',
    retry_count: 0,
    created_at: new Date(Date.now() - 3600000 * 2).toISOString(),
    updated_at: new Date(Date.now() - 3600000 * 2 + 15000).toISOString(),
    completed_at: new Date(Date.now() - 3600000 * 2 + 15000).toISOString(),
  },
  {
    id: 'job-9802',
    po_folder_name: 'PO-2026-0892',
    source_path: 'C:\\PO-AutoFlow\\Processing\\PO-2026-0892',
    status: 'ocr_processing',
    stage_message: 'Running PP-OCRv5 Thai & English neural OCR worker (Page 2 of 3).',
    po_number: 'PO-2026-0892',
    detected_company_raw: 'BANGKOK AUTOMATION SOLUTIONS',
    matched_company_name: 'บริษัท บางกอก ออโตเมชั่น โซลูชั่นส์ จำกัด',
    matched_email: 'po@bangkok-auto.com',
    match_confidence: 96.8,
    match_category: 'high',
    retry_count: 0,
    created_at: new Date(Date.now() - 30000).toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'job-9803',
    po_folder_name: 'PO-UNKNOWN-SCAN',
    source_path: 'C:\\PO-AutoFlow\\Review\\PO-UNKNOWN-SCAN',
    status: 'needs_review',
    stage_message: 'Company match requires verification (Score: 78.5%, Category: review). Moved to Review.',
    po_number: 'PO-99120',
    detected_company_raw: 'ไทยอินดัสเตรียล สาขา 2',
    matched_company_name: 'ห้างหุ้นส่วนจำกัด ไทยอินดัสเตรียล พาร์ทส์',
    matched_email: 'orders@thaiindustrial.com',
    match_confidence: 78.5,
    match_category: 'review',
    retry_count: 0,
    created_at: new Date(Date.now() - 86400000).toISOString(),
    updated_at: new Date(Date.now() - 86400000 + 40000).toISOString(),
  },
];

let mockTransactions: PoTransaction[] = [
  {
    id: 'tx-26002323',
    job_id: 'job-9801',
    po_number: 'PO-26002323',
    folder_fingerprint: 'fp_a9b8c7d6e5',
    archive_sha256: 'a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0',
    company_name: 'บริษัท สยาม ซัพพลาย แอนด์ เทรดดิ้ง จำกัด',
    recipient_email: 'billing@siamsupply.co.th',
    status: 'sent',
    gas_execution_id: 'gas-exec-9872',
    sent_at: new Date(Date.now() - 3600000 * 2).toISOString(),
  },
];

let mockEvents: ApplicationEvent[] = [
  {
    id: 1,
    level: 'info',
    message: 'System initialized. PaddleOCR PP-OCRv5 ready with Thai & English models.',
    timestamp: new Date(Date.now() - 3600000 * 3).toISOString(),
  },
  {
    id: 2,
    job_id: 'job-9801',
    level: 'success',
    message: 'PO-26002323 successfully packaged and delivered via GmailApp to billing@siamsupply.co.th.',
    timestamp: new Date(Date.now() - 3600000 * 2).toISOString(),
  },
  {
    id: 3,
    job_id: 'job-9802',
    level: 'info',
    message: 'Detected incoming folder PO-2026-0892. Copy stability confirmed (3/3 checks passed).',
    timestamp: new Date(Date.now() - 30000).toISOString(),
  },
];

export const api = {
  getSettings: async (): Promise<AppSettings> => {
    if (isTauriEnvironment()) {
      return await invoke<AppSettings>('get_settings');
    }
    return { ...mockSettings };
  },

  saveSettings: async (settings: AppSettings): Promise<void> => {
    if (isTauriEnvironment()) {
      return await invoke<void>('save_settings', { settings });
    }
    mockSettings = { ...settings };
  },

  getDashboardStats: async (): Promise<DashboardStats> => {
    if (isTauriEnvironment()) {
      return await invoke<DashboardStats>('get_dashboard_stats');
    }
    return {
      total_processed: mockJobs.length,
      successfully_sent: mockJobs.filter((j) => j.status === 'completed').length,
      waiting_processing: mockJobs.filter(
        (j) => j.status !== 'completed' && j.status !== 'failed' && j.status !== 'needs_review'
      ).length,
      needs_review: mockJobs.filter((j) => j.status === 'needs_review').length,
      failed_transactions: mockJobs.filter((j) => j.status === 'failed').length,
      success_rate_percent: 98.6,
      avg_ocr_confidence: 97.4,
    };
  },

  listJobs: async (limit = 50, offset = 0): Promise<Job[]> => {
    if (isTauriEnvironment()) {
      return await invoke<Job[]>('list_jobs', { limit, offset });
    }
    return [...mockJobs];
  },

  getJobDetails: async (jobId: string): Promise<Job | null> => {
    if (isTauriEnvironment()) {
      return await invoke<Job | null>('get_job_details', { jobId });
    }
    return mockJobs.find((j) => j.id === jobId) || null;
  },

  listTransactions: async (limit = 50, offset = 0): Promise<PoTransaction[]> => {
    if (isTauriEnvironment()) {
      return await invoke<PoTransaction[]>('list_transactions', { limit, offset });
    }
    return [...mockTransactions];
  },

  getOcrResults: async (jobId: string): Promise<OcrResultRecord[]> => {
    if (isTauriEnvironment()) {
      return await invoke<OcrResultRecord[]>('get_ocr_results', { jobId });
    }
    return [
      {
        id: 'ocr-res-1',
        job_id: jobId,
        file_path: 'PO-Invoice.pdf',
        page_number: 1,
        raw_text:
          'บริษัท สยาม ซัพพลาย แอนด์ เทรดดิ้ง จำกัด\nเลขประจำตัวผู้เสียภาษีอากร 0105556012345\nใบสั่งซื้อเลขที่: PO-26002323\nวันที่: 12 พ.ย. 2026\nผู้ขาย: บริษัท สยาม ซัพพลาย แอนด์ เทรดดิ้ง จำกัด\nส่งถึง: ฝ่ายจัดซื้อ บริษัท ลูกค้า จำกัด',
        normalized_text: 'บริษัท สยาม ซัพพลาย แอนด์ เทรดดิ้ง จำกัด',
        confidence: 99.4,
        engine: 'paddleocr_ppocrv5',
        bounding_boxes_json: JSON.stringify([
          { box: [[50, 40], [420, 40], [420, 70], [50, 70]], text: 'บริษัท สยาม ซัพพลาย แอนด์ เทรดดิ้ง จำกัด', confidence: 0.99 },
          { box: [[50, 80], [300, 80], [300, 105], [50, 105]], text: 'เลขประจำตัวผู้เสียภาษีอากร 0105556012345', confidence: 0.98 },
          { box: [[480, 40], [680, 40], [680, 70], [480, 70]], text: 'PO-26002323', confidence: 0.99 },
        ]),
        detected_entities_json: JSON.stringify({
          po_numbers: ['PO-26002323'],
          tax_ids: ['0105556012345'],
          primary_supplier: 'บริษัท สยาม ซัพพลาย แอนด์ เทรดดิ้ง จำกัด',
          primary_confidence: 99.4,
        }),
        created_at: new Date().toISOString(),
      },
    ];
  },

  getCompaniesCache: async (): Promise<CompanyCacheEntry[]> => {
    if (isTauriEnvironment()) {
      return await invoke<CompanyCacheEntry[]>('get_companies_cache');
    }
    return [...mockCompanies];
  },

  syncCompaniesFromSheets: async (): Promise<number> => {
    if (isTauriEnvironment()) {
      return await invoke<number>('sync_companies_from_sheets');
    }
    return mockCompanies.length;
  },

  addCompanyAlias: async (alias: string, canonicalCompanyName: string): Promise<void> => {
    if (isTauriEnvironment()) {
      return await invoke<void>('add_company_alias', { alias, canonicalCompanyName });
    }
    mockAliases.push({
      id: `alias_${Date.now()}`,
      alias,
      canonical_company_name: canonicalCompanyName,
      created_by: 'USER',
      created_at: new Date().toISOString(),
    });
  },

  deleteCompanyAlias: async (id: string): Promise<void> => {
    if (isTauriEnvironment()) {
      return await invoke<void>('delete_company_alias', { id });
    }
    mockAliases = mockAliases.filter((a) => a.id !== id);
  },

  getCompanyAliases: async (): Promise<CompanyAlias[]> => {
    if (isTauriEnvironment()) {
      return await invoke<CompanyAlias[]>('get_company_aliases');
    }
    return [...mockAliases];
  },

  getRecentEvents: async (limit = 50): Promise<ApplicationEvent[]> => {
    if (isTauriEnvironment()) {
      return await invoke<ApplicationEvent[]>('get_recent_events', { limit });
    }
    return [...mockEvents];
  },

  getAuditLogs: async (limit = 50): Promise<AuditLog[]> => {
    if (isTauriEnvironment()) {
      return await invoke<AuditLog[]>('get_audit_logs', { limit });
    }
    return [
      {
        id: 'audit-1',
        action: 'PO_DELIVERED',
        category: 'DELIVERY',
        actor: 'SYSTEM',
        details: 'Delivered PO PO-26002323 to billing@siamsupply.co.th',
        timestamp: new Date().toISOString(),
      },
    ];
  },

  retryJob: async (jobId: string): Promise<void> => {
    if (isTauriEnvironment()) {
      return await invoke<void>('retry_job', { jobId });
    }
  },

  approveAndSendJob: async (
    jobId: string,
    companyName: string,
    recipientEmail: string,
    poNumber?: string,
    saveAlias = true
  ): Promise<Job> => {
    if (isTauriEnvironment()) {
      return await invoke<Job>('approve_and_send_job', {
        jobId,
        companyName,
        recipientEmail,
        poNumber: poNumber || null,
        saveAlias,
      });
    }
    const existing = mockJobs.find((j) => j.id === jobId) || mockJobs[0];
    return {
      ...existing,
      status: 'completed',
      matched_company_name: companyName,
      matched_email: recipientEmail,
      po_number: poNumber || existing?.po_number,
      match_confidence: 100,
      match_category: 'verified',
      completed_at: new Date().toISOString(),
    };
  },

  startMonitoring: async (): Promise<boolean> => {
    if (isTauriEnvironment()) {
      return await invoke<boolean>('start_monitoring');
    }
    mockSettings.auto_monitoring_active = true;
    return true;
  },

  stopMonitoring: async (): Promise<boolean> => {
    if (isTauriEnvironment()) {
      return await invoke<boolean>('stop_monitoring');
    }
    mockSettings.auto_monitoring_active = false;
    return false;
  },

  isMonitoringActive: async (): Promise<boolean> => {
    if (isTauriEnvironment()) {
      return await invoke<boolean>('is_monitoring_active');
    }
    return mockSettings.auto_monitoring_active;
  },

  testSheetsConnection: async (
    spreadsheetId: string,
    tabName: string,
    gasUrl?: string,
    gasSecret?: string
  ): Promise<number> => {
    if (isTauriEnvironment()) {
      return await invoke<number>('test_sheets_connection', {
        spreadsheetId,
        tabName,
        gasUrl: gasUrl || null,
        gasSecret: gasSecret || null,
      });
    }
    return 14;
  },

  testDriveConnection: async (folderId: string): Promise<boolean> => {
    if (isTauriEnvironment()) {
      return await invoke<boolean>('test_drive_connection', { folderId });
    }
    return true;
  },

  testGasConnection: async (gasUrl: string, gasSecret?: string): Promise<boolean> => {
    if (isTauriEnvironment()) {
      return await invoke<boolean>('test_gas_connection', {
        gasUrl,
        gasSecret: gasSecret || null,
      });
    }
    return true;
  },

  sendTestEmail: async (recipientEmail: string): Promise<string> => {
    if (isTauriEnvironment()) {
      return await invoke<string>('send_test_email', { recipientEmail });
    }
    return 'mock-exec-id-test-success';
  },

  testOcrOnFile: async (filePath: string): Promise<any> => {
    if (isTauriEnvironment()) {
      return await invoke<any>('test_ocr_on_file', { filePath });
    }
    return {
      status: 'ok',
      file_path: filePath,
      pages_count: 1,
      aggregated: {
        po_numbers: ['PO-26002323'],
        primary_supplier: 'บริษัท สยาม ซัพพลาย แอนด์ เทรดดิ้ง จำกัด',
        primary_confidence: 96.5,
      },
    };
  },

  openDevTools: async (): Promise<void> => {
    if (isTauriEnvironment()) {
      await invoke<void>('open_devtools');
    } else {
      console.log('[DevTools] Open DevTools requested (Browser mode)');
    }
  },

  closeDevTools: async (): Promise<void> => {
    if (isTauriEnvironment()) {
      await invoke<void>('close_devtools');
    }
  },

  openPathInExplorer: async (path: string): Promise<void> => {
    if (isTauriEnvironment()) {
      await invoke<void>('open_path_in_explorer', { path });
    } else {
      console.log(`[Explorer] Opening path in explorer: ${path}`);
    }
  },

  openJobDocument: async (jobId: string, filePath?: string): Promise<void> => {
    if (isTauriEnvironment()) {
      await invoke<void>('open_job_document', { jobId, filePath: filePath || null });
    }
  },

  getSystemDiagnostics: async (): Promise<any> => {
    if (isTauriEnvironment()) {
      return await invoke<any>('get_system_diagnostics');
    }
    return {
      app_name: 'PO AutoFlow Enterprise',
      app_version: '1.0.0',
      os_name: 'windows',
      os_arch: 'x86_64',
      webview2_executable: 'C:\\Program Files (x86)\\Microsoft\\EdgeCore\\157.0.4341.46',
      database_path: 'C:\\Users\\User\\AppData\\Roaming\\po-autoflow\\po_autoflow.db',
      database_size_bytes: 147456,
      database_journal_mode: 'WAL',
      ocr_worker_path: 'D:\\oscar\\Documents\\what\\ocr-worker\\worker.py',
      ocr_worker_status: 'READY',
      ocr_latency_ms: 12,
      auto_monitoring_active: true,
      active_jobs_count: 0,
      in_flight_locks_count: 0,
      total_jobs_recorded: 24,
      total_transactions_recorded: 22,
      cached_companies_count: 4,
      debug_logging_enabled: true,
      dry_run_simulation_mode: false,
      timestamp: new Date().toISOString(),
    };
  },

  triggerFolderScan: async (): Promise<number> => {
    if (isTauriEnvironment()) {
      return await invoke<number>('trigger_folder_scan');
    }
    return 1;
  },

  clearAllCaches: async (): Promise<void> => {
    if (isTauriEnvironment()) {
      await invoke<void>('clear_all_caches');
    }
  },

  startGoogleLogin: async (clientId?: string, clientSecret?: string): Promise<GoogleAccountInfo> => {
    if (isTauriEnvironment()) {
      return await invoke<GoogleAccountInfo>('start_google_login', { clientId, clientSecret });
    }
    const mockInfo: GoogleAccountInfo = {
      email: 'user.business@gmail.com',
      name: 'Google Workspace User',
      picture: 'https://lh3.googleusercontent.com/a/default-user=s96-c',
      access_token: 'mock-access-token',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      connected_at: new Date().toISOString(),
    };
    mockSettings.google_account = mockInfo;
    return mockInfo;
  },

  logoutGoogle: async (): Promise<boolean> => {
    if (isTauriEnvironment()) {
      return await invoke<boolean>('logout_google');
    }
    mockSettings.google_account = null;
    return true;
  },

  getGoogleAccount: async (): Promise<GoogleAccountInfo | null> => {
    if (isTauriEnvironment()) {
      return await invoke<GoogleAccountInfo | null>('get_google_account');
    }
    return mockSettings.google_account || null;
  },

  minimizeToTray: async (): Promise<void> => {
    if (isTauriEnvironment()) {
      await invoke<void>('minimize_to_tray');
    }
  },

  getDocumentPagePreview: async (
    jobId: string,
    filePath: string,
    pageNumber: number
  ): Promise<PagePreviewResponse> => {
    if (isTauriEnvironment()) {
      return await invoke<PagePreviewResponse>('get_document_page_preview', {
        jobId,
        filePath,
        pageNumber,
      });
    }
    return { status: 'error', message: 'Visual preview requires Tauri backend runtime' };
  },

  getDeveloperConsoleSnapshot: async (): Promise<DeveloperConsoleSnapshot> => {
    if (isTauriEnvironment()) {
      return await invoke<DeveloperConsoleSnapshot>('get_developer_console_snapshot');
    }
    return {
      app_pid: 1001,
      ocr_worker_pid: 2002,
      ocr_worker_script: 'ocr-worker/worker.py',
      watcher_active: true,
      watcher_dir: mockSettings.incoming_dir,
      watcher_queued_count: 0,
      in_flight_count: 0,
      jobs_summary: {},
      terminal_lines: ['[system] Browser preview mode active'],
      recent_events: mockEvents,
      audit_logs: [],
      timestamp: new Date().toISOString(),
    };
  },

  runDeveloperCommand: async (command: string): Promise<string> => {
    if (isTauriEnvironment()) {
      return await invoke<string>('run_developer_command', { command });
    }
    return `Preview mode command: ${command}`;
  },

  checkGitHubUpdate,
  installGitHubUpdate,
};

