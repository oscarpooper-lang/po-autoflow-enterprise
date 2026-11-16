# Auto-Updater Setup & GitHub Releases Maintenance Guide

This guide explains how **PO AutoFlow Enterprise** delivers updates directly from its GitHub repository:

- **Repository**: [https://github.com/oscarpooper-lang/po-autoflow-enterprise](https://github.com/oscarpooper-lang/po-autoflow-enterprise)
- **Releases Feed**: [https://github.com/oscarpooper-lang/po-autoflow-enterprise/releases](https://github.com/oscarpooper-lang/po-autoflow-enterprise/releases)

---

## 1. How In-App Updates Work

1. On launch (and whenever you click **Check Update** in the sidebar or **Check for Updates** in **Settings**), the Rust backend (`check_github_update`) queries:
   `https://api.github.com/repos/oscarpooper-lang/po-autoflow-enterprise/releases/latest`
2. It compares the latest GitHub Release tag (for example `v1.0.1`) against the installed app version (`Cargo.toml` / `tauri.conf.json`).
3. If a newer version is available, clicking **Update to vX.Y.Z** or **Download & Install Update** triggers `install_github_update`, which downloads the Windows `-setup.exe` (or `.msi`) installer from GitHub Releases to your temporary folder and launches the installer directly.

---

## 2. How to Publish a New Update

You have two ways to release a new version:

### Method A: 1-Command Local Build & Publish (Fastest)

Run the release helper script from the project root in PowerShell:

```powershell
.\scripts\publish-update.ps1 -Version "1.0.1" -Notes "Describe what changed in this update"
```

What `publish-update.ps1` does automatically:
1. Updates `"version"` in `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`.
2. Runs quality gates (`npm run lint`, `npm run build`, and `cargo test --manifest-path src-tauri/Cargo.toml`).
3. Compiles the Windows NSIS (`.exe`) and WiX (`.msi`) installers via `npm run tauri build`.
4. Commits changes, creates tag `v1.0.1`, pushes `main` + the tag to GitHub, and publishes/uploads the installers to GitHub Releases.

### Method B: GitHub Actions Cloud Build (Push a Tag)

If you want GitHub's cloud Windows runner to build and publish the installers automatically:

1. Bump the version in `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` (e.g., to `1.0.1`).
2. Commit, tag, and push:

```powershell
git add .
git commit -m "Release v1.0.1: Description of changes"
git tag v1.0.1
git push origin main --tags
```

The workflow in [`.github/workflows/release.yml`](../.github/workflows/release.yml) runs lint, typecheck, `cargo test`, builds the Windows installers, and attaches them to the GitHub Release automatically.

---

## 3. Continuous Integration (CI)

Every push or pull request to `main` automatically runs [`.github/workflows/ci.yml`](../.github/workflows/ci.yml), verifying:
- `npm run lint`
- `npx tsc -b`
- `npm run build`
- `cargo test --manifest-path src-tauri/Cargo.toml`
