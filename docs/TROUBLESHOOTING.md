# PO AutoFlow Enterprise — Operational Troubleshooting Guide

**Platform:** Windows 10/11 / Windows Server  
**Backend:** Rust (Tauri 2) + Python PaddleOCR Sidecar + SQLite 3

---

## 1. Diagnostics & Log Locations

Before beginning troubleshooting, inspect the local diagnostic streams:

- **Application Event Stream**: Available in real-time under the **Live Monitor** > **Event Stream** view in the desktop UI.
- **SQLite Database File**: Located at `C:\PO-AutoFlow\Database\autoflow.db` (or user configured root).
- **Log Files**: Stored in `C:\PO-AutoFlow\Logs\autoflow_YYYY-MM-DD.log`.
- **Python Sidecar Logs**: Written to standard error stream and logged by Rust tracing as `[ocr-worker]`.

---

## 2. Common Issues and Resolutions

### Issue 2.1: Incoming Folder Remains in `Incoming` without Processing
**Symptoms:** A new folder is placed in `C:\PO-AutoFlow\Incoming`, but the status indicator does not change.  
**Probable Causes & Fixes:**
1. **File Copy Still in Progress**: The system checks file sizes and write locks every 2,000ms. If a large 500MB PDF is copying over a slow VPN or SMB network share, the system deliberately waits until the file size remains static across 3 consecutive checks and the write handle is released.
2. **Path Traversal Containment Triggered**: Ensure the folder name does not contain illegal characters (`..`, `/`, `\`, null bytes, or Windows reserved names `CON`, `PRN`, `AUX`).
3. **Recursive Watcher Paused**: Verify the top bar toggle switch shows **"Monitoring: Active"** (Green pill). If toggled off, click the toggle to resume the background directory watcher.

---

### Issue 2.2: Company Extraction Flags Folder to `Review` with Low Confidence
**Symptoms:** PO is moved into `Review/` with a confidence score between 75% and 89%.  
**Probable Causes & Fixes:**
1. **OCR Font / Scan Quality**: Low-resolution scans or photocopies can degrade character classification (e.g., Thai vowel marks `่` or `้` blurring into characters).
   - *Fix:* Navigate to **OCR Inspector**, inspect the bounding boxes and raw extracted text.
   - *Action:* If the company name was recognized with minor typographical variance, click **"Save as Company Alias"**. This permanently links the OCR variation to the master company record, elevating all future encounters to 100% confidence.
2. **Company Name Not in Google Sheet**: If the supplier is newly onboarded:
   - *Fix:* Add the company and their authorized email address to the Google Sheet.
   - *Action:* Click **"Sync Now"** in the **Company Directory** screen to refresh the SQLite cache immediately.

---

### Issue 2.3: Python OCR Worker IPC Timeout or Failure
**Symptoms:** Job fails at Stage 2 with `IPC request timed out` or `Broken pipe`.  
**Probable Causes & Fixes:**
1. **Python Environment Missing Dependencies**:
   - Ensure the Python runtime has `paddleocr`, `opencv-python`, and `PyMuPDF` installed:
     ```powershell
     python -c "import paddleocr, fitz, cv2; print('OK')"
     ```
2. **First-Time Model Download Stalling**:
   - On the very first run, PaddleOCR downloads PP-OCRv5 neural models (approx. 30MB) from the model repository. On restricted corporate networks with proxy filters, this download can fail or time out.
   - *Fix:* Pre-populate the model cache by running `python -c "from paddleocr import PaddleOCR; PaddleOCR(lang='th')"` once under administrative credentials.

---

### Issue 2.4: Google Apps Script Returns `HTTP 401: Invalid Signature`
**Symptoms:** Delivery fails at Stage 6 with `Unauthorized caller`.  
**Probable Causes & Fixes:**
1. **Mismatched HMAC Secret**: Ensure the secret configured under **Settings** > **Email & Apps Script** is byte-for-byte identical to the `HMAC_SECRET` property set in Google Apps Script **Project Settings** > **Script Properties**.
2. **System Clock Drift**: The Apps Script webhook enforces a 300-second timestamp tolerance to thwart replay attacks. If the local Windows PC clock differs by more than 5 minutes from Google's NTP servers:
   - *Fix:* Open Windows **Settings** > **Time & Language** > **Date & Time** and click **"Sync Now"**.

---

### Issue 2.5: Google Workspace Daily Sending Limits Reached
**Symptoms:** Apps Script returns `Service invoked too many times for one day: email`.  
**Probable Causes & Fixes:**
- Google Workspace enterprise accounts have a daily limit of **2,000 emails per 24 hours** (consumer `@gmail.com` accounts are capped at **500 emails/day**).
- *Fix:* If processing higher volumes, distribute the sending load across multiple configured sender accounts or stagger deliveries using the rate-limiting delay setting in `Settings`.

---

### Issue 2.6: Duplicate Blocked Warning on Valid Re-Order
**Symptoms:** Folder moved to `Review` with error `Duplicate PO Transaction Blocked`.  
**Probable Causes & Fixes:**
- The system discovered an exact duplicate PO Number and folder SHA-256 hash sent within the transaction history ledger.
- *Fix:* If this is genuinely a revised PO with updated items:
  1. Open the PO folder.
  2. Append the revision tag to the folder name (e.g., `PO-26002323-REV1`).
  3. Re-place into `C:\PO-AutoFlow\Incoming`. The revised fingerprint will be recognized as a distinct transaction.

