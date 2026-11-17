/**
 * PO AutoFlow Enterprise - Google Apps Script All-In-One Cloud Hub (v2.2.0)
 *
 * Capabilities:
 * 1. Private Google Sheets Supplier Directory Reader (SpreadsheetApp + OAuth CSV fallback)
 * 2. Private Google Drive PO Archive Storage (DriveApp)
 * 3. Authenticated Gmail Delivery with attachments (GmailApp)
 * 4. Cloud Hub Identity & Session Token provider (get_account)
 *
 * All operations execute privately under YOUR Google Account ("Execute as: Me").
 * Authentication enforced by shared AUTH_SECRET / HMAC_SECRET.
 */

const CONFIG = {
  DEFAULT_SECRET: "po-autoflow-enterprise-secret-key",
  LEGACY_DEFAULT_SECRET: "rx5ocgZ6yLfnz2HAAmLA0ouy2GRA5sKg",
  MAX_ATTACHMENT_SIZE_BYTES: 20 * 1024 * 1024, // 20 MB Gmail attachment threshold
};

/**
 * Run this function manually ONCE inside the Google Apps Script editor
 * (Select "authorizeAllPermissions" -> Click "Run") to grant Google Sheets,
 * Drive, and Gmail permissions for your private spreadsheets and folders.
 */
function authorizeAllPermissions() {
  const email = Session.getEffectiveUser().getEmail();
  const rootFolder = DriveApp.getRootFolder().getName();
  const token = ScriptApp.getOAuthToken();
  const sheetId =
    PropertiesService.getScriptProperties().getProperty("SHEET_ID") ||
    "1xocWPkAg6Hry1QBQPtEsElk2MEVvpEDba4MadhV7D8Y";

  let sheetStatus = "OK";
  try {
    sheetStatus = "SpreadsheetApp: " + SpreadsheetApp.openById(sheetId).getName();
  } catch (err) {
    const csvUrl =
      "https://docs.google.com/spreadsheets/d/" +
      encodeURIComponent(sheetId) +
      "/gviz/tq?tqx=out:csv&sheet=Suppliers";
    const resp = UrlFetchApp.fetch(csvUrl, {
      headers: { Authorization: "Bearer " + token },
      muteHttpExceptions: true,
    });
    sheetStatus = "UrlFetchApp fallback HTTP " + resp.getResponseCode() + " (" + err.message + ")";
  }

  Logger.log("Authorized for user=" + email + ", driveRoot=" + rootFolder + ", sheet=" + sheetStatus);
  return { status: "authorized", email: email, sheet: sheetStatus };
}

/**
 * Checks whether callerAuth matches configured Script Properties or supported defaults.
 */
function isAuthorized(e, payload) {
  const props = PropertiesService.getScriptProperties();
  const authProp = props.getProperty("AUTH_SECRET");
  const hmacProp = props.getProperty("HMAC_SECRET");
  const callerAuth =
    (e && e.parameter && (e.parameter.auth || e.parameter.auth_secret)) ||
    (payload && payload.auth_secret) ||
    "";

  if (!callerAuth) return false;
  if (authProp && callerAuth === authProp) return true;
  if (hmacProp && callerAuth === hmacProp) return true;
  if (callerAuth === CONFIG.DEFAULT_SECRET) return true;
  if (callerAuth === CONFIG.LEGACY_DEFAULT_SECRET) return true;
  return false;
}

/**
 * Builds the Cloud Hub account info response.
 */
function handleGetAccount() {
  const email = Session.getEffectiveUser().getEmail() || "connected-user@gmail.com";
  const name = email.indexOf("@") > 0 ? email.split("@")[0] : email;
  let token = "";
  try {
    token = ScriptApp.getOAuthToken();
  } catch (err) {
    token = "";
  }
  return ContentService.createTextOutput(JSON.stringify({
    status: "ok",
    email: email,
    name: name,
    access_token: token,
    expires_in: 3600,
    timestamp: new Date().toISOString()
  })).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Handles incoming GET requests:
 * 1. Healthcheck / Ping test: https://.../exec?auth=SECRET
 * 2. Supplier sync via GET:   https://.../exec?action=sync_suppliers&auth=SECRET&sheet_id=ID&tab_name=TAB
 * 3. Account connect via GET: https://.../exec?action=get_account&auth=SECRET
 */
function doGet(e) {
  const authorized = isAuthorized(e, null);
  const action = e && e.parameter && e.parameter.action;

  if (action === "get_account") {
    if (!authorized) {
      return jsonError("Unauthorized: Invalid AUTH_SECRET", 401);
    }
    return handleGetAccount();
  }

  // Action: Read Private Google Sheet Directory via GET
  if (action === "sync_suppliers" || action === "get_suppliers") {
    if (!authorized) {
      return jsonError("Unauthorized: Invalid AUTH_SECRET", 401);
    }
    const sheetId = (e.parameter && e.parameter.sheet_id) || PropertiesService.getScriptProperties().getProperty("SHEET_ID");
    const tabName = (e.parameter && e.parameter.tab_name) || "Suppliers";
    const strictTab = e.parameter && (e.parameter.strict_tab === "1" || e.parameter.strict_tab === "true");
    return handleGetSuppliers(sheetId, tabName, strictTab);
  }

  // Default: Healthcheck diagnostic
  return ContentService.createTextOutput(JSON.stringify({
    status: "ok",
    service: "PO AutoFlow Enterprise Cloud Hub",
    version: "2.2.0",
    authorized: authorized,
    capabilities: ["sheets_directory", "drive_storage", "gmail_delivery", "cloud_hub_auth"],
    timestamp: new Date().toISOString()
  })).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Handles incoming POST requests:
 * - action: "get_account"    -> Returns effective Google account & OAuth token
 * - action: "sync_suppliers" -> Reads private Google Sheet
 * - action: "upload_drive"   -> Uploads file/ZIP to private Google Drive folder
 * - action: "send_email"     -> Delivers PO package via Gmail (default)
 */
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    // 30-second lock prevents race conditions
    lock.waitLock(30000);

    if (!e || !e.postData || !e.postData.contents) {
      return jsonError("Missing POST payload body", 400);
    }

    let payload;
    try {
      payload = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      return jsonError("Invalid JSON payload: " + parseErr.message, 400);
    }

    if (!isAuthorized(e, payload)) {
      return jsonError("Unauthorized: Invalid AUTH_SECRET", 401);
    }

    const action = payload.action || (e.parameter && e.parameter.action) || "send_email";

    if (action === "get_account") {
      return handleGetAccount();
    }

    // =========================================================================
    // ACTION 1: Read Private Google Sheet Directory (SpreadsheetApp)
    // =========================================================================
    if (action === "sync_suppliers" || action === "get_suppliers") {
      const sheetId = payload.sheet_id || (e.parameter && e.parameter.sheet_id) || PropertiesService.getScriptProperties().getProperty("SHEET_ID");
      const tabName = payload.tab_name || (e.parameter && e.parameter.tab_name) || "Suppliers";
      const strictTab = Boolean(payload.strict_tab || (e.parameter && (e.parameter.strict_tab === "1" || e.parameter.strict_tab === "true")));
      return handleGetSuppliers(sheetId, tabName, strictTab);
    }

    // =========================================================================
    // ACTION 1B: Auto-Learn & Upsert New Supplier into Google Sheet
    // =========================================================================
    if (action === "upsert_supplier") {
      const sheetId = payload.sheet_id || (e.parameter && e.parameter.sheet_id) || PropertiesService.getScriptProperties().getProperty("SHEET_ID");
      const tabName = payload.tab_name || (e.parameter && e.parameter.tab_name) || "Suppliers";
      return handleUpsertSupplier(sheetId, tabName, payload);
    }

    // =========================================================================
    // ACTION 2: Upload Archive to Private Google Drive (DriveApp)
    // =========================================================================
    if (action === "upload_drive") {
      const folderId = payload.folder_id || PropertiesService.getScriptProperties().getProperty("DRIVE_FOLDER_ID");
      const fileName = payload.file_name || "PO_Archive.zip";
      const fileBase64 = payload.file_base64;

      if (!fileBase64) {
        return jsonError("Missing file_base64 data for Drive upload", 400);
      }

      try {
        const folder = folderId ? DriveApp.getFolderById(folderId) : DriveApp.getRootFolder();
        const decodedBytes = Utilities.base64Decode(fileBase64);
        const blob = Utilities.newBlob(decodedBytes, payload.mime_type || "application/zip", fileName);
        const driveFile = folder.createFile(blob);

        return ContentService.createTextOutput(JSON.stringify({
          status: "ok",
          file_id: driveFile.getId(),
          web_link: driveFile.getUrl(),
          file_name: driveFile.getName(),
          size_bytes: driveFile.getSize(),
          timestamp: new Date().toISOString()
        })).setMimeType(ContentService.MimeType.JSON);
      } catch (driveErr) {
        return jsonError("Drive upload error: " + driveErr.message, 500);
      }
    }

    // =========================================================================
    // ACTION 3: Send Email with Attachments / Drive Links (GmailApp)
    // =========================================================================
    const {
      transaction_id,
      po_number,
      company_name,
      recipient_email,
      drive_file_id,
      idempotency_key,
      subject,
      body
    } = payload;

    if (!po_number || !recipient_email || !idempotency_key) {
      return jsonError("Missing required delivery parameters (po_number, recipient_email, idempotency_key)", 400);
    }

    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(recipient_email.trim())) {
      return jsonError("Invalid recipient email address format: " + recipient_email, 400);
    }

    // Duplicate protection via Idempotency cache (PropertiesService)
    const props = PropertiesService.getUserProperties();
    const existingTx = props.getProperty("IDEMP_" + idempotency_key);
    if (existingTx) {
      const parsed = JSON.parse(existingTx);
      return ContentService.createTextOutput(JSON.stringify({
        status: "accepted",
        duplicate_suppressed: true,
        message: "Email already delivered for this transaction",
        original_execution_id: parsed.execution_id,
        timestamp: parsed.timestamp
      })).setMimeType(ContentService.MimeType.JSON);
    }

    let attachments = [];
    let totalAttachedBytes = 0;
    let fileLink = "";
    const attachment_mode = payload.attachment_mode || "individual_files";
    const inline_attachments = Array.isArray(payload.attachments) ? payload.attachments : [];

    // 1. Attach individual previewable files sent directly from desktop app (PDF, PNG, JPG, DOCX, etc.)
    if (inline_attachments.length > 0 && attachment_mode !== "zip_archive") {
      for (let i = 0; i < inline_attachments.length; i++) {
        const item = inline_attachments[i];
        if (!item || !item.file_base64 || !item.file_name) continue;
        try {
          const rawBytes = Utilities.base64Decode(item.file_base64);
          if (totalAttachedBytes + rawBytes.length > CONFIG.MAX_ATTACHMENT_SIZE_BYTES) {
            console.warn("Skipping attachment " + item.file_name + ": total Gmail attachment limit exceeded");
            continue;
          }
          const mime = item.mime_type || inferMimeType(item.file_name);
          const blob = Utilities.newBlob(rawBytes, mime, item.file_name);
          attachments.push(blob);
          totalAttachedBytes += rawBytes.length;
        } catch (attErr) {
          console.warn("Notice: Could not decode inline attachment " + item.file_name + ": " + attErr.message);
        }
      }
    }

    // 2. Retrieve archive from Google Drive (for Drive unzip fallback, ZIP mode, or secure link when files >20MB)
    if (drive_file_id && !drive_file_id.startsWith("drive_local_")) {
      try {
        const driveFile = DriveApp.getFileById(drive_file_id);
        const fileSize = driveFile.getSize();
        const driveName = driveFile.getName();

        if (attachment_mode === "individual_files" && attachments.length === 0 && driveName.toLowerCase().endsWith(".zip")) {
          const unzippedBlobs = Utilities.unzip(driveFile.getBlob().setContentType("application/zip"));
          for (let i = 0; i < unzippedBlobs.length; i++) {
            const b = unzippedBlobs[i];
            const cleanName = (b.getName() || ("document_" + (i + 1))).split("/").pop();
            if (!cleanName || cleanName.startsWith("~") || cleanName.startsWith(".")) continue;
            const blobBytes = b.getBytes();
            if (totalAttachedBytes + blobBytes.length <= CONFIG.MAX_ATTACHMENT_SIZE_BYTES) {
              attachments.push(b.setContentType(inferMimeType(cleanName)).setName(cleanName));
              totalAttachedBytes += blobBytes.length;
            }
          }
        }

        if ((attachment_mode === "zip_archive" || attachment_mode === "both") && (totalAttachedBytes + fileSize <= CONFIG.MAX_ATTACHMENT_SIZE_BYTES)) {
          attachments.push(driveFile.getBlob().setName(driveName));
          totalAttachedBytes += fileSize;
        }

        if (attachments.length === 0 || fileSize > CONFIG.MAX_ATTACHMENT_SIZE_BYTES) {
          fileLink = "\n\nSecure Google Drive Package Link (Size: " + (fileSize / (1024 * 1024)).toFixed(1) + " MB):\n" + driveFile.getUrl();
        }
      } catch (err) {
        console.warn("Notice: Could not retrieve Drive file ID (" + drive_file_id + "): " + err.message);
        if (attachments.length === 0) {
          fileLink = "\n\nAttached File Reference: " + drive_file_id + " (Retrieval notice: " + err.message + ")";
        }
      }
    }

    // Prepare Subject & Body
    const emailSubject = subject || ("Purchase Order - " + po_number + " - " + company_name);
    let emailBody = body || ("Dear " + company_name + ",\n\nPlease find attached the Purchase Order documents for your reference.\n\nPO Number: " + po_number + "\n\nPlease acknowledge receipt.\n\nBest regards,\nPO Automation System");

    if (fileLink) {
      emailBody += fileLink;
    }

    const mailOptions = {
      name: "PO Automation System",
      body: emailBody
    };

    if (attachments.length > 0) {
      mailOptions.attachments = attachments;
    }

    GmailApp.sendEmail(recipient_email.trim(), emailSubject, emailBody, mailOptions);

    const executionId = Utilities.getUuid();
    const nowIso = new Date().toISOString();

    // Record idempotency record
    const resultRecord = {
      execution_id: executionId,
      transaction_id: transaction_id || executionId,
      po_number: po_number,
      recipient: recipient_email,
      timestamp: nowIso
    };
    props.setProperty("IDEMP_" + idempotency_key, JSON.stringify(resultRecord));

    return ContentService.createTextOutput(JSON.stringify({
      status: "sent",
      execution_id: executionId,
      transaction_id: transaction_id,
      po_number: po_number,
      recipient: recipient_email,
      timestamp: nowIso,
      attachment_sent: attachments.length > 0
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return jsonError("Execution error: " + error.message, 500);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Parses raw 2D matrix rows into normalized supplier objects (supports Thai & English headers)
 */
function buildSuppliersResponse(values, tabUsed) {
  let token = "";
  try {
    token = ScriptApp.getOAuthToken();
  } catch (e) {
    token = "";
  }

  if (!values || values.length === 0) {
    return ContentService.createTextOutput(JSON.stringify({
      status: "ok",
      count: 0,
      suppliers: [],
      tab_used: tabUsed,
      access_token: token,
      message: "Sheet found but contains 0 rows"
    })).setMimeType(ContentService.MimeType.JSON);
  }

  const firstRow = values[0].map(h => String(h).trim());
  const firstRowLow = firstRow.map(h => h.toLowerCase());
  const emailRowRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const firstRowHasEmail = firstRow.some(h => emailRowRegex.test(h));
  const hasHeaderKeyword = firstRowLow.some(h =>
    h.includes("company") || h.includes("ชื่อ") || h.includes("supplier") || h.includes("vendor") ||
    h.includes("thai") || h.includes("english") || h.includes("email") || h.includes("อีเมล") ||
    h.includes("proofing") || h.includes("บริษัท")
  );
  const isHeaderless = firstRowHasEmail || !hasHeaderKeyword;

  let compCol, emailCol, aliasCol, notesCol, taxCol, startRow;
  if (isHeaderless) {
    emailCol = firstRow.findIndex(h => h.indexOf("@") > 0);
    compCol = firstRow.findIndex((h, idx) => idx !== emailCol && h.length > 0);
    if (compCol < 0) compCol = emailCol === 0 ? 1 : 0;
    aliasCol = firstRow.findIndex((h, idx) => idx !== emailCol && idx !== compCol && h.length > 0);
    notesCol = firstRow.findIndex((h, idx) => idx !== emailCol && idx !== compCol && idx !== aliasCol && h.length > 0);
    taxCol = -1;
    startRow = 0;
  } else {
    if (values.length <= 1) {
      return ContentService.createTextOutput(JSON.stringify({
        status: "ok",
        count: 0,
        suppliers: [],
        tab_used: tabUsed,
        access_token: token,
        message: "Sheet found but contains 0 data rows (only headers or blank)"
      })).setMimeType(ContentService.MimeType.JSON);
    }
    compCol = firstRowLow.findIndex(h =>
      h.includes("company name") || h.includes("thai name") || h.includes("name (th)") || h.includes("name th") ||
      h.includes("ชื่อบริษัท") || h.includes("ชื่อผู้ขาย") || h.includes("ชื่อไทย") ||
      h.includes("company") || h.includes("ชื่อ") || h.includes("supplier") || h.includes("vendor") || h.includes("name")
    );
    emailCol = firstRowLow.findIndex(h => h.includes("email") || h.includes("อีเมล") || h.includes("mail"));
    if (emailCol < 0 && firstRowLow.length === 2) emailCol = 1;
    aliasCol = firstRowLow.findIndex((h, idx) =>
      idx !== compCol && idx !== emailCol && (
        h.includes("alias") || h.includes("alt") || h.includes("english") || h.includes("name (en)") ||
        h.includes("name en") || h.includes("company (en)") || h.includes("อังกฤษ") ||
        h.includes("อื่น") || h.includes("สำรอง") || h.includes("thai") || h.includes("name (th)") || h.includes("ไทย")
      )
    );
    notesCol = firstRowLow.findIndex((h, idx) =>
      idx !== compCol && idx !== emailCol && idx !== aliasCol && (
        h.includes("proofing") || h.includes("proof") || h.includes("reference") ||
        h.includes("remark") || h.includes("note") || h.includes("หมายเหตุ") ||
        h.includes("ตรวจ") || h.includes("อ้างอิง")
      )
    );
    taxCol = firstRowLow.findIndex((h, idx) =>
      idx !== compCol && idx !== emailCol && idx !== aliasCol && (
        h.includes("tax") || h.includes("tin") || h.includes("ภาษี")
      )
    );
    startRow = 1;
  }

  const grp = deriveVendorGroup(tabUsed);
  const suppliers = [];
  for (let r = startRow; r < values.length; r++) {
    const row = values[r];
    const primaryRaw = compCol >= 0 ? String(row[compCol] || "").trim() : String(row[0] || "").trim();
    const altRaw = aliasCol >= 0 && row[aliasCol] ? String(row[aliasCol]).trim() : "";
    // Support keeping both English & Thai, or just one of them filled on a row
    const name = primaryRaw || altRaw;
    const alt = primaryRaw && altRaw ? altRaw : null;
    const email = emailCol >= 0 ? String(row[emailCol] || "").trim() : (row[1] ? String(row[1]).trim() : "");
    if (!name || !email) continue;

    suppliers.push({
      company_name: name,
      alternative_name: alt,
      email: email,
      tax_id: taxCol >= 0 && row[taxCol] ? String(row[taxCol]).trim() : null,
      notes: notesCol >= 0 && row[notesCol] ? String(row[notesCol]).trim() : null,
      vendor_group: grp,
      active: true
    });
  }

  return ContentService.createTextOutput(JSON.stringify({
    status: "ok",
    count: suppliers.length,
    suppliers: suppliers,
    tab_used: tabUsed,
    access_token: token,
    timestamp: new Date().toISOString()
  })).setMimeType(ContentService.MimeType.JSON);
}

function deriveVendorGroup(tabName) {
  const low = String(tabName || "").trim().toLowerCase();
  if (low === "ov" || low.indexOf("oversea") >= 0 || low.indexOf("foreign") >= 0 || low.indexOf("ต่างประเทศ") >= 0) {
    return "OV";
  }
  if (low === "dv" || low.indexOf("domestic") >= 0 || low.indexOf("ในประเทศ") >= 0) {
    return "DV";
  }
  return tabName ? String(tabName).trim() : "DV";
}

function findSheetTab(ss, tabName, allowFallback) {
  const allSheets = ss.getSheets();
  if (tabName) {
    const exact = ss.getSheetByName(tabName);
    if (exact) return exact;
    const low = String(tabName).trim().toLowerCase();
    for (let i = 0; i < allSheets.length; i++) {
      if (allSheets[i].getName().trim().toLowerCase() === low) {
        return allSheets[i];
      }
    }
    if (low === "dv" || low.indexOf("domestic") >= 0) {
      for (let i = 0; i < allSheets.length; i++) {
        const sn = allSheets[i].getName().trim().toLowerCase();
        if (sn === "dv" || sn.indexOf("domestic") >= 0 || sn.indexOf("ในประเทศ") >= 0) {
          return allSheets[i];
        }
      }
    }
    if (low === "ov" || low.indexOf("oversea") >= 0) {
      for (let i = 0; i < allSheets.length; i++) {
        const sn = allSheets[i].getName().trim().toLowerCase();
        if (sn === "ov" || sn.indexOf("oversea") >= 0 || sn.indexOf("foreign") >= 0 || sn.indexOf("ต่างประเทศ") >= 0) {
          return allSheets[i];
        }
      }
    }
  }
  if (!allowFallback) return null;
  for (let i = 0; i < allSheets.length; i++) {
    const sName = allSheets[i].getName().toLowerCase();
    if (sName.includes("supplier") || sName.includes("บริษัท") || sName.includes("ผู้ขาย") || sName.includes("sheet1")) {
      return allSheets[i];
    }
  }
  return allSheets[0];
}

/**
 * Reads suppliers from private Google Sheet.
 * Supports multi-tab layouts (e.g. DV + OV) with strict tab matching so missing tabs do not clone tab 0.
 */
function handleGetSuppliers(sheetId, tabName, strictTab) {
  if (!sheetId) {
    return jsonError("Missing sheet_id parameter. Provide Google Spreadsheet ID in request or in Script Properties (SHEET_ID).", 400);
  }

  try {
    const ss = SpreadsheetApp.openById(sheetId);
    const sheet = findSheetTab(ss, tabName, !strictTab);
    if (!sheet) {
      return ContentService.createTextOutput(JSON.stringify({
        status: "ok",
        count: 0,
        suppliers: [],
        tab_used: tabName || "",
        tab_missing: true,
        message: "Tab '" + tabName + "' not found in spreadsheet (0 rows)"
      })).setMimeType(ContentService.MimeType.JSON);
    }

    const values = sheet.getDataRange().getValues();
    return buildSuppliersResponse(values, sheet.getName());

  } catch (err) {
    // Fallback: use UrlFetchApp with ScriptApp OAuth token on gviz CSV endpoint
    try {
      const csvUrl = "https://docs.google.com/spreadsheets/d/" +
        encodeURIComponent(sheetId) +
        "/gviz/tq?tqx=out:csv&sheet=" +
        encodeURIComponent(tabName || "Suppliers");

      const resp = UrlFetchApp.fetch(csvUrl, {
        headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
        muteHttpExceptions: true
      });

      if (resp.getResponseCode() >= 200 && resp.getResponseCode() < 300) {
        const csvText = resp.getContentText();
        if (csvText && !csvText.trim().startsWith("<")) {
          const parsed = Utilities.parseCsv(csvText);
          return buildSuppliersResponse(parsed, tabName || "Suppliers");
        }
      }
    } catch (fallbackErr) {
      // Ignore fallback error and report original SpreadsheetApp error below
    }

    return jsonError("Failed to open or read spreadsheet: " + err.message + ". Verify the Sheet ID is correct and permissions granted.", 500);
  }
}

function safeSheetCell(val) {
  const s = String(val || "").trim();
  if (!s) return "";
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

function handleUpsertSupplier(sheetId, tabName, payload) {
  if (!sheetId) {
    return jsonError("Missing sheet_id for upsert_supplier", 400);
  }
  const companyName = safeSheetCell(payload.company_name);
  const email = safeSheetCell(payload.email);
  const altName = safeSheetCell(payload.alternative_name);
  const taxId = safeSheetCell(payload.tax_id);
  if (!companyName || !email) {
    return jsonError("Missing company_name or email for upsert_supplier", 400);
  }

  try {
    const ss = SpreadsheetApp.openById(sheetId);
    let sheet = findSheetTab(ss, tabName, !tabName);
    if (!sheet && tabName) {
      sheet = ss.insertSheet(tabName);
    }
    if (!sheet) {
      sheet = ss.getSheets()[0];
    }

    const values = sheet.getDataRange().getValues();
    if (!values || values.length === 0 || (values.length === 1 && values[0].every(c => String(c).trim() === ""))) {
      sheet.appendRow(["Company Name", "English / Alternate Name", "Email", "Proofing / Notes", "Active", "Tax ID"]);
      sheet.appendRow([companyName, altName, email, safeSheetCell(payload.notes) || "Auto-learned by PO AutoFlow", "TRUE", taxId]);
      return ContentService.createTextOutput(JSON.stringify({
        status: "ok",
        mode: "created_with_headers",
        company_name: companyName,
        email: email
      })).setMimeType(ContentService.MimeType.JSON);
    }

    const firstRow = values[0].map(h => String(h).trim());
    const firstRowLow = firstRow.map(h => h.toLowerCase());
    const emailRowRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const firstRowHasEmail = firstRow.some(h => emailRowRegex.test(h));
    const hasHeaderKeyword = firstRowLow.some(h =>
      h.includes("company") || h.includes("ชื่อ") || h.includes("supplier") || h.includes("vendor") ||
      h.includes("thai") || h.includes("english") || h.includes("email") || h.includes("อีเมล") || h.includes("proofing")
    );
    const isHeaderless = firstRowHasEmail || !hasHeaderKeyword;

    let compCol, emailCol, aliasCol, notesCol, taxCol, startRow;
    if (isHeaderless) {
      emailCol = firstRow.findIndex(h => h.indexOf("@") > 0);
      compCol = firstRow.findIndex((h, idx) => idx !== emailCol && h.length > 0);
      if (compCol < 0) compCol = emailCol === 0 ? 1 : 0;
      aliasCol = firstRow.findIndex((h, idx) => idx !== emailCol && idx !== compCol && h.length > 0);
      notesCol = -1;
      taxCol = -1;
      startRow = 0;
    } else {
      compCol = firstRowLow.findIndex(h =>
        h.includes("company name") || h.includes("thai name") || h.includes("name (th)") || h.includes("ชื่อบริษัท") ||
        h.includes("company") || h.includes("ชื่อ") || h.includes("supplier") || h.includes("name")
      );
      if (compCol < 0) compCol = 0;
      emailCol = firstRowLow.findIndex(h => h.includes("email") || h.includes("อีเมล") || h.includes("mail"));
      if (emailCol < 0) emailCol = 1;
      aliasCol = firstRowLow.findIndex((h, idx) =>
        idx !== compCol && idx !== emailCol && (
          h.includes("alias") || h.includes("alt") || h.includes("english") || h.includes("name (en)") ||
          h.includes("อังกฤษ") || h.includes("อื่น") || h.includes("สำรอง") || h.includes("thai") || h.includes("ไทย")
        )
      );
      notesCol = firstRowLow.findIndex((h, idx) =>
        idx !== compCol && idx !== emailCol && idx !== aliasCol && (
          h.includes("proofing") || h.includes("proof") || h.includes("remark") || h.includes("note") || h.includes("หมายเหตุ")
        )
      );
      taxCol = firstRowLow.findIndex((h, idx) =>
        idx !== compCol && idx !== emailCol && idx !== aliasCol && (h.includes("tax") || h.includes("ภาษี"))
      );
      startRow = 1;
    }

    const notesText = safeSheetCell(payload.notes);
    const targetLow = companyName.toLowerCase();
    for (let r = startRow; r < values.length; r++) {
      const cellName = String(values[r][compCol] || "").trim().toLowerCase();
      const cellAlias = aliasCol >= 0 ? String(values[r][aliasCol] || "").trim().toLowerCase() : "";
      if (cellName === targetLow || (cellAlias && cellAlias === targetLow)) {
        sheet.getRange(r + 1, emailCol + 1).setValue(email);
        if (aliasCol >= 0 && altName && !String(values[r][aliasCol] || "").trim()) {
          sheet.getRange(r + 1, aliasCol + 1).setValue(altName);
        }
        if (notesCol >= 0 && notesText && !String(values[r][notesCol] || "").trim()) {
          sheet.getRange(r + 1, notesCol + 1).setValue(notesText);
        }
        if (taxCol >= 0 && taxId && !String(values[r][taxCol] || "").trim()) {
          sheet.getRange(r + 1, taxCol + 1).setValue(taxId);
        }
        return ContentService.createTextOutput(JSON.stringify({
          status: "ok",
          mode: "updated",
          row: r + 1,
          company_name: companyName,
          email: email
        })).setMimeType(ContentService.MimeType.JSON);
      }
    }

    if (isHeaderless) {
      const row = [];
      const width = Math.max(2, compCol + 1, emailCol + 1, aliasCol + 1);
      for (let i = 0; i < width; i++) row.push("");
      row[compCol] = companyName;
      row[emailCol] = email;
      if (aliasCol >= 0 && altName) row[aliasCol] = altName;
      sheet.appendRow(row);
    } else {
      const width = Math.max(firstRow.length, compCol + 1, emailCol + 1, aliasCol + 1, notesCol + 1, taxCol + 1);
      const row = new Array(width).fill("");
      row[compCol] = companyName;
      row[emailCol] = email;
      if (aliasCol >= 0 && altName) row[aliasCol] = altName;
      if (notesCol >= 0) row[notesCol] = notesText || "Auto-learned by PO AutoFlow";
      if (taxCol >= 0 && taxId) row[taxCol] = taxId;
      sheet.appendRow(row);
    }

    return ContentService.createTextOutput(JSON.stringify({
      status: "ok",
      mode: "inserted",
      company_name: companyName,
      email: email
    })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return jsonError("upsert_supplier failed: " + err.message, 500);
  }
}

function inferMimeType(fileName) {
  const lower = String(fileName || "").toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".tif") || lower.endsWith(".tiff")) return "image/tiff";
  if (lower.endsWith(".bmp")) return "image/bmp";
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (lower.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".txt")) return "text/plain";
  return "application/octet-stream";
}

function jsonError(message, code) {
  return ContentService.createTextOutput(JSON.stringify({
    status: "failed",
    error: message,
    code: code || 500,
    timestamp: new Date().toISOString()
  })).setMimeType(ContentService.MimeType.JSON);
}
