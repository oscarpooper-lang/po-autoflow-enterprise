# PO AutoFlow Enterprise — User Manual

**Version:** 1.0.0 Enterprise Edition  
**Platform:** Microsoft Windows 10 / 11 / Server 2019+  
**Target Audience:** Procurement, Accounts Payable, Finance, and IT Operations Teams

---

## 1. Quick Start: The One-Action Workflow

The fundamental design of **PO AutoFlow Enterprise** is zero-touch background automation: **the only recurring human action is placing a Purchase Order folder into the incoming directory.**

```
C:\PO-AutoFlow\Incoming\
└── PO-26002323\
    ├── PO-Invoice.pdf
    ├── Invoice.jpg
    ├── Supporting-Document.pdf
    └── Additional-Documents\
        ├── Document1.jpg
        └── Document2.pdf
```

### What Happens Automatically
1. **Detection**: Within milliseconds of the folder being placed, the application detects the new entry.
2. **Copy Stability Verification**: The system waits until all files have finished copying (verifies file size stability and releases of Windows file write locks) so partially-copied files are never processed prematurely.
3. **Recursive Document Discovery**: All nested documents (`.pdf`, `.jpg`, `.png`, `.tiff`, `.docx`) are located and checksummed (SHA-256).
4. **Text Extraction & Thai/English OCR**: PyMuPDF extracts native digital text; scans and photos are processed through the PaddleOCR PP-OCRv5 neural engine.
5. **Supplier Classification**: Distinguishes the supplier from buyer, customer, or shipping recipients using contextual scoring and Thai Tax ID patterns.
6. **Company Directory Matching**: Matches the detected name against your synchronized Google Sheets directory using Thai Unicode normalization and RapidFuzz token matching.
7. **Secure Packaging**: Compresses the entire folder (including nested subfolders) into an encrypted/verified ZIP archive.
8. **Cloud Upload & Delivery**: Uploads the archive to Google Drive and delivers a personalized notification email with the archive through Google Apps Script and Gmail.
9. **Permanent Ledger Entry**: Records the transaction with SHA-256 fingerprinting for duplicate prevention.
10. **Folder Relocation**: Moves the source folder into `C:\PO-AutoFlow\Sent\`.

---

## 2. Directory Structure Overview

The system maintains 6 primary operational directories under its root:

| Directory | Purpose | What Belongs Here |
| :--- | :--- | :--- |
| `Incoming/` | Drop zone for new Purchase Order folders. | Folders containing PO documents dropped by staff or network scripts. |
| `Processing/` | Working quarantine during active extraction and matching. | Folders currently undergoing OCR, matching, or email dispatch. |
| `Sent/` | Successfully completed Purchase Orders. | Archived folders whose emails were verified and sent. |
| `Review/` | Human verification queue. | Folders requiring manual review (low OCR confidence, ambiguous match, or missing email). |
| `Failed/` | Terminal errors requiring IT assistance. | Corrupted ZIPs, unreadable files, or persistent delivery timeouts. |
| `Temp/` | Staging for generated ZIP files before upload. | Cleared automatically after successful upload. |

---

## 3. Supported File Types & Best Practices

- **PDF Files (`.pdf`)**: Native digital PDFs are processed instantaneously using internal text layer extraction. Scanned PDFs are rendered at 300 DPI for high-accuracy neural OCR.
- **Images (`.jpg`, `.jpeg`, `.png`, `.tiff`, `.bmp`)**: Automatically deskewed, contrast-enhanced via CLAHE, and sharpened before character recognition.
- **Office Documents (`.docx`)**: Text is extracted from native XML structures.

### Recommended PO Folder Naming
While the system extracts the PO number directly from document text using regular expressions (`PO-\d{6,10}`), naming the folder with the PO reference (e.g., `PO-26002323`) accelerates lookup and transaction tracing.

---

## 4. Understanding Confidence Scores & The Review Queue

The company matching engine classifies every candidate into one of four calibrated confidence tiers:

```
┌─────────────────────────────────────────────────────────────┐
│ 98% – 100% : VERIFIED (Auto-Sent)                           │
│ 90% – 97%  : HIGH CONFIDENCE (Auto-Sent if no conflicts)    │
│ 75% – 89%  : REVIEW REQUIRED (Placed in Review Queue)       │
│ < 75%      : NO MATCH (Placed in Review Queue)              │
└─────────────────────────────────────────────────────────────┘
```

### Resolving a Folder in the Review Queue
1. Navigate to the **Review Queue** tab in the desktop application.
2. Select the flagged PO. The application will show:
   - Extracted company candidates with their confidence scores.
   - A side-by-side preview of the document.
   - The reason for flag (e.g., "Confidence 82.4% below 90% threshold" or "Supplier email missing in directory").
3. Choose one of the following actions:
   - **Confirm Match**: Select the intended company from the dropdown directory.
   - **Save as Alias**: Click **"Save as Alias"** to associate the OCR-extracted spelling with the supplier permanently so future POs match at 100% confidence.
   - **Re-process**: Trigger a re-extraction using Google Cloud Vision if local OCR was blurry.
   - **Release to Send**: Dispatches the email immediately and moves the folder to `Sent`.

---

## 5. Duplicate Protection Safeguards

To prevent accidental double-billing or sending duplicate emails to vendors, PO AutoFlow Enterprise enforces a three-level cryptographic safety barrier:

1. **PO Number Check**: Checks whether an email has already been dispatched for this PO Number within the configured cooldown period.
2. **Folder Fingerprint Check**: Combines filenames, file sizes, and modification timestamps into an SHA-256 digest.
3. **Archive Payload Hash**: Verifies whether the exact byte-level content has already been transmitted.

If any check identifies a prior successful transmission, the job is halted immediately, marked as **Duplicate Blocked**, and logged in the audit ledger without sending an email.

---

## 6. Daily Monitoring & System Tray

- **Minimizing to Tray**: Closing the window with the `X` button minimizes the application to the Windows System Tray. The background folder watcher continues monitoring `C:\PO-AutoFlow\Incoming`.
- **System Notifications**: Windows desktop toast notifications will appear when:
  - A PO has been successfully dispatched.
  - An item requires manual attention in the Review Queue.
  - A Google Sheets sync warning or network interruption occurs.
- **Restoring Window**: Double-click the tray icon or right-click and choose **"Open PO AutoFlow"**.

---

## 7. Developer Options & System Debugging Suite

For system administrators, DevOps engineers, and developers maintaining the pipeline:

### Accessing Developer Mode
1. Click the **Developer & Debug [DEV]** button in the left sidebar, or open **Settings -> Developer & Debugging**.
2. Toggle **Developer Mode** to activate diagnostic telemetry and sidecar controls.

### Key Developer Features
- **Open DevTools Console**: Click **"Open DevTools (F12)"** to launch the full Chromium/WebView2 developer tools console for network and DOM inspection.
- **Dry-Run / Simulation Mode**: When enabled, incoming PO folders undergo complete stability checks, native parsing, neural OCR, entity extraction, and ZIP compression, but mock Google Drive uploads and Gmail transmissions. No emails are dispatched to real suppliers.
- **Direct Explorer Launchers**: Instantly open any operational folder (`Incoming`, `Processing`, `Sent`, `Failed`, `Review`, `Logs`, `Temp`) in Windows File Explorer with a single click.
- **Trigger Folder Scan**: Force an immediate re-scan of the incoming folder.
- **Neural OCR Test Sandbox**: Enter any file path to test OCR text extraction directly through the sidecar without moving or altering files.
- **Live Telemetry Stream**: Real-time log console filterable by log level (`INFO`, `WARN`, `ERROR`) with search and JSON export.


