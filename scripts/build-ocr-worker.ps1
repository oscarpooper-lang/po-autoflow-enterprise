<#
.SYNOPSIS
    Builds the self-contained standalone OCR worker executable (ocr-worker.exe) and bundles
    OpenThai 2.0 OCR-Text (4.2 MB) into src-tauri\resources so end users require ZERO Python install.
#>
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$workerScript = Join-Path $repoRoot "ocr-worker\worker.py"
$resourcesRoot = Join-Path $repoRoot "src-tauri\resources"
$workerOutDir = Join-Path $resourcesRoot "ocr-worker"
$modelOutDir = Join-Path $resourcesRoot "models\openthaigpt-ocr-text"
$buildStage = Join-Path $repoRoot "src-tauri\target\pyinstaller-build"

Write-Host "==> Preparing bundled OpenThai 2.0 OCR-Text weights..." -ForegroundColor Cyan
New-Item -ItemType Directory -Path (Join-Path $modelOutDir "runtime") -Force | Out-Null

$hfFiles = @(
    "config.json",
    "det.yml",
    "det.onnx",
    "rec.onnx",
    "rec_dict.txt",
    "runtime/__init__.py",
    "runtime/line_engine.py",
    "runtime/thai_norm.py"
)

$localCacheDirs = @(
    "D:\PO-AutoFlow\Models\openthaigpt-ocr-text",
    "C:\PO-AutoFlow\Models\openthaigpt-ocr-text"
)

foreach ($rel in $hfFiles) {
    $dest = Join-Path $modelOutDir ($rel -replace '/', '\')
    $needCopy = -not (Test-Path $dest)
    if (-not $needCopy -and -not $rel.EndsWith("__init__.py")) {
        $needCopy = ((Get-Item $dest).Length -eq 0)
    }
    if ($needCopy) {
        $copied = $false
        foreach ($cacheDir in $localCacheDirs) {
            $src = Join-Path $cacheDir ($rel -replace '/', '\')
            if (Test-Path $src) {
                Copy-Item -Path $src -Destination $dest -Force
                $copied = $true
                break
            }
        }
        if (-not $copied) {
            $url = "https://huggingface.co/iapp/OpenThai2.0-OCR-Text/resolve/main/$rel"
            Write-Host "  Downloading $rel..." -ForegroundColor Yellow
            Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
        }
    }
}

Write-Host "==> Compiling standalone ocr-worker.exe via PyInstaller..." -ForegroundColor Cyan
if (Test-Path $buildStage) {
    Remove-Item -Path $buildStage -Recurse -Force -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Path $buildStage -Force | Out-Null

$distTemp = Join-Path $buildStage "dist"
$workTemp = Join-Path $buildStage "work"

$excludes = @(
    "paddle", "paddleocr", "paddlex", "torch", "torchvision", "torchaudio",
    "transformers", "easyocr", "google.cloud", "google.api_core",
    "PySide6", "shiboken6", "PyQt5", "PyQt6", "tkinter", "_tkinter",
    "matplotlib", "scipy", "pandas", "sklearn", "scikit-learn", "librosa",
    "numba", "llvmlite", "moviepy", "imageio", "playwright", "mediapipe",
    "anthropic", "openai", "yt_dlp", "IPython", "pytest", "PIL", "Pillow",
    "pytesseract", "sounddevice", "soundfile", "soxr"
)

$pyArgs = @(
    "-m", "PyInstaller",
    "--noconfirm",
    "--clean",
    "--onedir",
    "--console",
    "--name", "ocr-worker",
    "--distpath", $distTemp,
    "--workpath", $workTemp,
    "--specpath", $buildStage,
    "--collect-binaries", "onnxruntime",
    "--collect-submodules", "fitz",
    "--collect-submodules", "pymupdf",
    "--hidden-import", "onnxruntime",
    "--hidden-import", "pyclipper",
    "--hidden-import", "cv2",
    "--hidden-import", "numpy",
    "--hidden-import", "docx",
    "--hidden-import", "lxml",
    "--hidden-import", "lxml.etree",
    "--hidden-import", "rapidfuzz"
)

foreach ($ex in $excludes) {
    $pyArgs += "--exclude-module"
    $pyArgs += $ex
}
$pyArgs += $workerScript

& python @pyArgs
if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller failed building standalone ocr-worker.exe"
}

$builtDir = Join-Path $distTemp "ocr-worker"
if (-not (Test-Path (Join-Path $builtDir "ocr-worker.exe"))) {
    throw "Expected ocr-worker.exe was not generated at $builtDir"
}

if (Test-Path $workerOutDir) {
    Remove-Item -Path $workerOutDir -Recurse -Force -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Path $workerOutDir -Force | Out-Null
Copy-Item -Path "$builtDir\*" -Destination $workerOutDir -Recurse -Force

# Remove unused FFmpeg video codecs (~52 MB) since the OCR worker only decodes still images/PDFs
Get-ChildItem -Path (Join-Path $workerOutDir "_internal\cv2") -Filter "opencv_videoio_ffmpeg*.dll" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

Remove-Item -Path $buildStage -Recurse -Force -ErrorAction SilentlyContinue

$sizeMb = [math]::Round(((Get-ChildItem -Path $workerOutDir -Recurse -File | Measure-Object -Property Length -Sum).Sum) / 1MB, 1)
$fileCount = (Get-ChildItem -Path $workerOutDir -Recurse -File | Measure-Object).Count
Write-Host "==> Standalone ocr-worker.exe ready ($sizeMb MB across $fileCount files) at $workerOutDir" -ForegroundColor Green
