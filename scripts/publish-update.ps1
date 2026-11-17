<#
.SYNOPSIS
    Bump version, run quality gates, build Windows installers, push to GitHub, and publish a GitHub Release.
.EXAMPLE
    .\scripts\publish-update.ps1 -Version "1.0.1" -Notes "Fix Thai OCR supplier matching"
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$Version,

    [string]$Notes = "",

    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$cleanVersion = $Version.Trim().TrimStart('v', 'V')
if ($cleanVersion -notmatch '^\d+\.\d+\.\d+$') {
    throw "Invalid semantic version '$Version'. Expected format like '1.0.1'."
}
$tag = "v$cleanVersion"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Push-Location $repoRoot

try {
    Write-Host "==> Preparing release $tag in $repoRoot" -ForegroundColor Cyan

    # Verify gh CLI auth
    gh auth status | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "GitHub CLI (gh) is not authenticated. Run 'gh auth login' first."
    }

    # 1. Update package.json version
    $pkgPath = Join-Path $repoRoot "package.json"
    $pkgJson = Get-Content $pkgPath -Raw
    $pkgJson = [regex]::Replace($pkgJson, '"version"\s*:\s*"[^"]+"', "`"version`": `"$cleanVersion`"", 1)
    [System.IO.File]::WriteAllText($pkgPath, $pkgJson, [System.Text.UTF8Encoding]::new($false))

    # 2. Update src-tauri/tauri.conf.json version
    $tauriConfPath = Join-Path $repoRoot "src-tauri\tauri.conf.json"
    $tauriConf = Get-Content $tauriConfPath -Raw
    $tauriConf = [regex]::Replace($tauriConf, '"version"\s*:\s*"[^"]+"', "`"version`": `"$cleanVersion`"", 1)
    [System.IO.File]::WriteAllText($tauriConfPath, $tauriConf, [System.Text.UTF8Encoding]::new($false))

    # 3. Update src-tauri/Cargo.toml package version
    $cargoPath = Join-Path $repoRoot "src-tauri\Cargo.toml"
    $cargoToml = Get-Content $cargoPath -Raw
    $cargoToml = [regex]::Replace($cargoToml, '(?m)^version\s*=\s*"[^"]+"', "version = `"$cleanVersion`"", 1)
    [System.IO.File]::WriteAllText($cargoPath, $cargoToml, [System.Text.UTF8Encoding]::new($false))

    Write-Host "==> Running quality gates (lint, frontend build, cargo test)..." -ForegroundColor Cyan
    npm run lint
    if ($LASTEXITCODE -ne 0) { throw "npm run lint failed." }

    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed." }

    cargo test --manifest-path src-tauri\Cargo.toml
    if ($LASTEXITCODE -ne 0) { throw "cargo test failed." }

    if (-not $SkipBuild) {
        Write-Host "==> Building Windows release installers (.exe + .msi)..." -ForegroundColor Cyan
        npm run tauri build
        if ($LASTEXITCODE -ne 0) { throw "npm run tauri build failed." }
    }

    # Commit & push to main
    git add -A
    $pending = git status --porcelain
    if ($pending) {
        git commit -m "Release $tag"
        if ($LASTEXITCODE -ne 0) { throw "git commit failed." }
    } else {
        Write-Host "No git changes to commit." -ForegroundColor Yellow
    }

    # Create or move tag locally
    $existingTag = git tag -l $tag
    if (-not $existingTag) {
        git tag $tag
        if ($LASTEXITCODE -ne 0) { throw "git tag $tag failed." }
    }

    Write-Host "==> Pushing main and tag $tag to GitHub..." -ForegroundColor Cyan
    git push origin main
    if ($LASTEXITCODE -ne 0) { throw "git push origin main failed." }

    git push origin $tag
    if ($LASTEXITCODE -ne 0) { throw "git push origin $tag failed." }

    # Collect installer files for this version
    $nsisDir = Join-Path $repoRoot "src-tauri\target\release\bundle\nsis"
    $msiDir = Join-Path $repoRoot "src-tauri\target\release\bundle\msi"
    $assets = @()
    if (Test-Path $nsisDir) {
        $assets += Get-ChildItem -Path $nsisDir -Filter "*_${cleanVersion}_*.exe" | Select-Object -ExpandProperty FullName
    }
    if (Test-Path $msiDir) {
        $assets += Get-ChildItem -Path $msiDir -Filter "*_${cleanVersion}_*.msi" | Select-Object -ExpandProperty FullName
    }

    if ($assets.Count -eq 0) {
        Write-Warning "No versioned installer assets found for $cleanVersion. GitHub Actions workflow will still build from tag $tag."
        exit 0
    }

    $releaseNotes = if ([string]::IsNullOrWhiteSpace($Notes)) {
        "## PO AutoFlow Enterprise $tag`n`nAutomated release built and published for Windows x64."
    } else {
        "## PO AutoFlow Enterprise $tag`n`n$Notes"
    }

    # Generate rate-limit-free latest.json manifest alongside installers (includes both NSIS .exe and MSI)
    $setupExePath = $assets | Where-Object { $_ -like "*_x64-setup.exe" } | Select-Object -First 1
    $setupSize = if ($setupExePath -and (Test-Path $setupExePath)) { (Get-Item $setupExePath).Length } else { $null }
    $publishedName = "PO.AutoFlow.Enterprise_${cleanVersion}_x64-setup.exe"
    $msiFilePath = $assets | Where-Object { $_ -like "*_x64_en-US.msi" } | Select-Object -First 1
    $msiSize = if ($msiFilePath -and (Test-Path $msiFilePath)) { (Get-Item $msiFilePath).Length } else { $null }
    $publishedMsiName = "PO.AutoFlow.Enterprise_${cleanVersion}_x64_en-US.msi"
    $latestManifest = [ordered]@{
        tag_name = $tag
        release_name = "PO AutoFlow Enterprise $tag"
        release_notes = $releaseNotes
        published_at = (Get-Date).ToUniversalTime().ToString("o")
        installer_name = $publishedName
        installer_url = "https://github.com/oscarpooper-lang/po-autoflow-enterprise/releases/download/$tag/$publishedName"
        installer_size_bytes = $setupSize
        msi_name = $publishedMsiName
        msi_url = "https://github.com/oscarpooper-lang/po-autoflow-enterprise/releases/download/$tag/$publishedMsiName"
        msi_size_bytes = $msiSize
    }
    $bundleDir = Join-Path $repoRoot "src-tauri\target\release\bundle"
    New-Item -ItemType Directory -Path $bundleDir -Force | Out-Null
    $latestJsonPath = Join-Path $bundleDir "latest.json"
    $latestJsonContent = $latestManifest | ConvertTo-Json -Depth 4
    [System.IO.File]::WriteAllText($latestJsonPath, $latestJsonContent, [System.Text.UTF8Encoding]::new($false))
    $assets += $latestJsonPath

    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    cmd /c "gh release view $tag >nul 2>&1"
    $releaseExists = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = $prevEap

    if ($releaseExists) {
        Write-Host "==> Uploading installers to existing GitHub Release $tag..." -ForegroundColor Cyan
        & gh release upload $tag @assets --clobber
    } else {
        Write-Host "==> Publishing GitHub Release $tag with $($assets.Count) installer(s)..." -ForegroundColor Cyan
        & gh release create $tag @assets --title "PO AutoFlow Enterprise $tag" --notes $releaseNotes
    }

    if ($LASTEXITCODE -ne 0) { throw "Failed to publish GitHub Release $tag." }

    Write-Host "==> Release $tag published! Users can click 'Check Update' in PO AutoFlow Enterprise." -ForegroundColor Green
}
finally {
    Pop-Location
}
