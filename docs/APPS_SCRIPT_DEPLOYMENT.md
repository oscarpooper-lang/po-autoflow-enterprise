# Google Apps Script Web App Deployment Guide

**Target Component:** Gmail & Google Drive Delivery Engine  
**Source Files:** `apps-script/Code.gs`, `apps-script/appsscript.json`  
**Security Model:** HMAC-SHA256 Token Authentication with Idempotency Key De-duplication

---

## 1. Overview

PO AutoFlow Enterprise delivers Purchase Order packages using a dedicated, authenticated Google Apps Script (GAS) Web App. This architecture offers major benefits:
- **Zero Local SMTP Credentials**: No SMTP passwords or local credentials needed.
- **Gmail Infrastructure**: Emails are delivered directly from your enterprise Google Workspace identity.
- **Payload Handling**: Automatically evaluates file attachment sizes. If the ZIP archive is under 20MB, it is attached directly via `GmailApp.sendEmail`. If it exceeds 20MB, it creates a secure, restricted Google Drive sharing link instead.
- **Replay Protection**: Rejects requests missing valid HMAC-SHA256 signatures or timestamp headers older than 300 seconds.

---

## 2. Step-by-Step Deployment Procedure

### Step 1: Create New Google Apps Script Project
1. Open your browser and navigate to [script.google.com](https://script.google.com/).
2. Ensure you are signed in with the Google Workspace account intended to send PO emails (e.g., `procurement@company.com`).
3. Click **"+ New Project"** in the top-left corner.
4. Rename the project to **`PO-AutoFlow-Delivery-Engine`**.

### Step 2: Configure Script Files
1. In the left file tree, click on `Code.gs`.
2. Replace all placeholder contents with the entire content of [`apps-script/Code.gs`](file:///d:/oscar/Documents/what/apps-script/Code.gs).
3. In the left navigation, click **Project Settings** (gear icon) and check **"Show 'appsscript.json' manifest file in editor"**.
4. Return to the **Editor** tab, click `appsscript.json`, and replace its content with [`apps-script/appsscript.json`](file:///d:/oscar/Documents/what/apps-script/appsscript.json):
```json
{
  "timeZone": "Asia/Bangkok",
  "dependencies": {},
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8",
  "webapp": {
    "executeAs": "USER_DEPLOYING",
    "access": "ANYONE"
  }
}
```

### Step 3: Configure Script Properties (Secret Keys & IDs)
1. Go to **Project Settings** (gear icon in the left toolbar).
2. Scroll down to the **Script Properties** section and click **"Add script property"**.
3. Add the following properties:

| Property | Value | Description |
| :--- | :--- | :--- |
| `AUTH_SECRET` | `po-autoflow-enterprise-secret-key` *(or any custom password)* | Shared secret key between the desktop app and Apps Script. |
| `SHEET_ID` | *(Your private Google Sheet ID)* | Optional default Sheet ID for supplier directory synchronization. |
| `DRIVE_FOLDER_ID` | *(Your private Google Drive Folder ID)* | Optional default Drive folder ID for PO archives. |
| `MAX_ATTACHMENT_MB` | `20` | Threshold above which Google Drive links are sent instead of direct attachments. |

4. Click **"Save script properties"**.

### Step 4: Authorize Permissions & Deploy as Web App
1. At the top of the editor toolbar, select **`authorizeAllPermissions`** in the function dropdown and click **Run**. When prompted with **"Authorization required"**, click **Review permissions**, select your Google account, and click **Allow** (grants Sheets, Drive, and Gmail access).
2. In the top-right corner, click **Deploy** > **New deployment** (or **Manage deployments** > **Edit** > **New version**).
3. Click the gear icon next to "Select type" and choose **Web app**.
4. Enter the configuration:
   - **Description**: `PO AutoFlow Production v2`
   - **Execute as**: `Me (<your-email@company.com>)`
   - **Who has access**: `Anyone` *(Access is enforced by our `AUTH_SECRET` verification layer)*
5. Click **Deploy** and copy the generated **Web App URL** (looks like `https://script.google.com/macros/s/AKfycbx.../exec`).

---

## 3. Configuring the Desktop Application

1. Open **PO AutoFlow Enterprise**.
2. Navigate to **Settings** > **Email & Apps Script**.
3. Paste the **Web App URL** into the `Apps Script Webhook URL` field.
4. Paste the **HMAC Secret** into the `HMAC Shared Secret` field.
5. Click **"Test Delivery Connection"**.
6. A success dialog confirming `HTTP 200: Handshake Verified` confirms your deployment is complete and live.

