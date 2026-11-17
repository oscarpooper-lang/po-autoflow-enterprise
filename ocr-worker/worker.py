#!/usr/bin/env python3
"""
PO AutoFlow Enterprise - Managed Python OCR & Document Processing Sidecar
OpenThai 2.0 OCR-Text | Built-in Digital PDF Reader | Tesseract 5 | Vulkan Vision AI
"""

import sys
import os
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
import json
import base64
import traceback
import re
import shutil
import subprocess
import tempfile
import time
import importlib.util
import urllib.request
import urllib.parse
import urllib.error
from typing import List, Dict, Any, Optional

# Imaging & PDF libraries
import cv2
import numpy as np
import fitz  # PyMuPDF
try:
    import docx
except ImportError:
    docx = None

# OCR engine
try:
    if importlib.util.find_spec("paddle") is not None:
        from paddleocr import PaddleOCR
        HAS_PADDLEOCR = True
    else:
        PaddleOCR = None
        HAS_PADDLEOCR = False
except Exception:
    PaddleOCR = None
    HAS_PADDLEOCR = False

# Google Cloud Vision optional fallback
try:
    from google.cloud import vision
    HAS_GOOGLE_VISION = True
except ImportError:
    HAS_GOOGLE_VISION = False

# RapidFuzz for internal token similarity
try:
    from rapidfuzz import fuzz
    HAS_RAPIDFUZZ = True
except ImportError:
    HAS_RAPIDFUZZ = False

_paddle_ocr_instance: Optional[Any] = None
_paddle_ocr_attempted: bool = False
_openthaigpt_cache: Dict[str, Any] = {}
_smolvlm_cache: Dict[str, Any] = {}


def is_strictly_localhost(endpoint: str) -> bool:
    """Security guard: allow only on-device loopback endpoints so sensitive PO images never leave this PC."""
    try:
        parsed = urllib.parse.urlparse((endpoint or "").strip())
        if parsed.scheme not in ("http", "https"):
            return False
        host = (parsed.hostname or "").lower()
        return host in ("127.0.0.1", "localhost", "::1")
    except Exception:
        return False


def _extract_json_object(raw: str) -> Dict[str, Any]:
    if not raw:
        return {}
    raw_s = raw.strip()
    try:
        val = json.loads(raw_s)
        return val if isinstance(val, dict) else {}
    except Exception:
        m = re.search(r"\{[\s\S]*\}", raw_s)
        if m:
            try:
                val = json.loads(m.group(0))
                return val if isinstance(val, dict) else {}
            except Exception:
                return {}
    return {}


def _prepare_vision_crop(
    img_np: np.ndarray, max_width: int = 960, crop_ratio: float = 0.55
) -> np.ndarray:
    """Focuses VLM input on the header band of portrait pages and caps width."""
    h, w = img_np.shape[:2]
    vision_img = img_np
    if h > int(w * 1.05) and crop_ratio < 0.99:
        crop_h = max(1, int(h * crop_ratio))
        vision_img = img_np[:crop_h, :]
    vh, vw = vision_img.shape[:2]
    if vw > max_width:
        scale = float(max_width) / float(vw)
        vision_img = cv2.resize(vision_img, (max_width, max(1, int(vh * scale))), interpolation=cv2.INTER_AREA)
    return vision_img


def _build_builtin_vlm_cmd(
    engine_path: str,
    model_path: str,
    mmproj_path: str,
    image_path: str,
    prompt: str,
    max_tokens: int,
    img_max_tokens: int,
    use_gpu: bool,
) -> List[str]:
    return [
        engine_path,
        "-m",
        model_path,
        "--mmproj",
        mmproj_path,
        "--image",
        image_path,
        "-p",
        prompt,
        "-n",
        str(max_tokens),
        "-c",
        "2048",
        "--image-max-tokens",
        str(img_max_tokens),
        "-t",
        "6",
        "-ngl",
        "99" if use_gpu else "0",
        "--temp",
        "0.0",
        "--repeat-penalty",
        "1.1",
        "--no-warmup",
    ]


def _vision_error_result(status: str, message: str, elapsed_ms: float = 0.0, device: str = "") -> Dict[str, Any]:
    return {
        "_vision_status": status,
        "_vision_error": message,
        "_vision_duration_ms": round(elapsed_ms, 1),
        "_vision_device": device,
    }


def query_local_vision_model(
    img_np: np.ndarray,
    provider: str,
    endpoint: str,
    model: str,
    engine_path: str = "",
    model_path: str = "",
    mmproj_path: str = "",
    quality_preset: str = "balanced",
) -> Dict[str, Any]:
    """Queries 100% offline on-device Vision AI (Built-in llama-mtmd-cli, Ollama, or Python transformers)."""
    t0 = time.perf_counter()
    prompt = (
        "You are a precise Thai and English document OCR reader. "
        "Note: QTC ENERGY PUBLIC COMPANY LIMITED is the BUYER, so ignore QTC completely. "
        "Read ONLY text visibly printed on this image. Never guess or invent an email, company name, or number; "
        "if a field is not visibly printed, leave it as empty string \"\". "
        "Return ONLY valid JSON with these exact keys: "
        '{"supplier_th": "", "supplier_en": "", "po_number": "", "tax_id": "", "email": ""}.'
    )

    try:
        prov_low = (provider or "builtin").strip().lower()
        if prov_low == "builtin":
            if not (engine_path and os.path.exists(engine_path)):
                return _vision_error_result(
                    "unavailable",
                    "Vision engine binary (llama-mtmd-cli.exe) is missing. Download/Install in Settings.",
                )
            if not (model_path and mmproj_path and os.path.exists(model_path) and os.path.exists(mmproj_path)):
                return _vision_error_result(
                    "unavailable",
                    f"Vision model '{model}' files are missing. Click 'Download Inside App' in Settings.",
                )

            is_max = (quality_preset or "balanced").strip().lower() == "max_accuracy"
            vision_img = _prepare_vision_crop(
                img_np,
                max_width=1120 if is_max else 960,
                crop_ratio=0.80 if is_max else 0.72,
            )
            ok, buf = cv2.imencode(".png", vision_img)
            if not ok:
                return _vision_error_result("error", "Failed to encode page image for Vision AI.")

            tmp_png = ""
            engine_dir = os.path.dirname(engine_path)
            has_vulkan = os.path.exists(os.path.join(engine_dir, "ggml-vulkan.dll"))
            max_gen_tok = 220 if is_max else 180
            img_tok_cap = 768 if is_max else 512
            timeout_sec = 120 if is_max else 90
            try:
                with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tf:
                    tf.write(buf.tobytes())
                    tmp_png = tf.name

                kwargs: Dict[str, Any] = {
                    "capture_output": True,
                    "text": True,
                    "encoding": "utf-8",
                    "errors": "ignore",
                    "stdin": subprocess.DEVNULL,
                    "timeout": timeout_sec,
                    "cwd": engine_dir,
                }
                if os.name == "nt":
                    kwargs["creationflags"] = 0x08000000

                used_gpu = has_vulkan
                cmd = _build_builtin_vlm_cmd(
                    engine_path, model_path, mmproj_path, tmp_png,
                    prompt, max_gen_tok, img_tok_cap, use_gpu=has_vulkan,
                )
                proc = subprocess.run(cmd, **kwargs)

                # Automatic CPU fallback if Vulkan device init fails on unsupported GPU drivers
                if proc.returncode != 0 and has_vulkan:
                    used_gpu = False
                    cpu_cmd = _build_builtin_vlm_cmd(
                        engine_path, model_path, mmproj_path, tmp_png,
                        prompt, max_gen_tok, 384, use_gpu=False,
                    )
                    proc = subprocess.run(cpu_cmd, **kwargs)

                elapsed_ms = (time.perf_counter() - t0) * 1000.0
                device_lbl = "Vulkan GPU" if used_gpu else "CPU"
                if proc.returncode != 0:
                    err_lines = ((proc.stderr or "") or (proc.stdout or "")).strip().splitlines()
                    err_msg = " | ".join(err_lines[-3:]) if err_lines else f"exit code {proc.returncode}"
                    sys.stderr.write(f"Built-in Vision AI error ({device_lbl}): {err_msg}\n")
                    return _vision_error_result(
                        "error",
                        f"Vision AI failed ({device_lbl}, exit {proc.returncode}): {err_msg[:240]}",
                        elapsed_ms,
                        device_lbl,
                    )

                parsed_json = _extract_json_object(proc.stdout or "")
                if not parsed_json:
                    raw_out = (proc.stdout or "").strip()[:180]
                    return _vision_error_result(
                        "error",
                        f"Vision AI ({device_lbl}) did not output valid JSON: {raw_out or '(empty stdout)'}",
                        elapsed_ms,
                        device_lbl,
                    )
                parsed_json["_vision_status"] = "ok"
                parsed_json["_vision_error"] = ""
                parsed_json["_vision_duration_ms"] = round(elapsed_ms, 1)
                parsed_json["_vision_device"] = device_lbl
                return parsed_json
            except subprocess.TimeoutExpired:
                elapsed_ms = (time.perf_counter() - t0) * 1000.0
                msg = f"Vision AI timed out after {timeout_sec}s on {model}. Upgrade to Vulkan GPU engine for ~10s speed."
                sys.stderr.write(msg + "\n")
                return _vision_error_result("timeout", msg, elapsed_ms, "Vulkan GPU" if has_vulkan else "CPU")
            finally:
                if tmp_png and os.path.exists(tmp_png):
                    try:
                        os.remove(tmp_png)
                    except Exception:
                        pass

        if prov_low == "transformers":
            if (
                importlib.util.find_spec("transformers") is None
                or importlib.util.find_spec("torch") is None
                or importlib.util.find_spec("PIL") is None
            ):
                return _vision_error_result("unavailable", "Python transformers/torch/Pillow not installed.")
            import torch
            from PIL import Image
            from transformers import AutoProcessor, AutoModelForImageTextToText

            model_id = (model or "HuggingFaceTB/SmolVLM2-2.2B-Instruct").strip()
            if "/" not in model_id:
                model_id = "HuggingFaceTB/SmolVLM2-2.2B-Instruct"

            if model_id not in _smolvlm_cache:
                processor = AutoProcessor.from_pretrained(model_id, local_files_only=False)
                dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
                vlm = AutoModelForImageTextToText.from_pretrained(
                    model_id,
                    torch_dtype=dtype,
                    low_cpu_mem_usage=True,
                )
                if torch.cuda.is_available():
                    vlm = vlm.to("cuda")
                _smolvlm_cache[model_id] = (processor, vlm)

            processor, vlm = _smolvlm_cache[model_id]
            rgb = cv2.cvtColor(img_np, cv2.COLOR_BGR2RGB)
            pil_img = Image.fromarray(rgb)
            messages = [
                {
                    "role": "user",
                    "content": [
                        {"type": "image", "image": pil_img},
                        {"type": "text", "text": prompt},
                    ],
                }
            ]
            inputs = processor.apply_chat_template(
                messages,
                add_generation_prompt=True,
                tokenize=True,
                return_dict=True,
                return_tensors="pt",
            ).to(vlm.device)
            generated = vlm.generate(**inputs, max_new_tokens=220)
            decoded = processor.batch_decode(generated, skip_special_tokens=True)[0]
            parsed_json = _extract_json_object(decoded)
            elapsed_ms = (time.perf_counter() - t0) * 1000.0
            if not parsed_json:
                return _vision_error_result("error", "Transformers Vision AI returned invalid JSON.", elapsed_ms, "PyTorch")
            parsed_json.update({"_vision_status": "ok", "_vision_error": "", "_vision_duration_ms": round(elapsed_ms, 1), "_vision_device": "PyTorch"})
            return parsed_json

        # Default: local Ollama HTTP server locked strictly to 127.0.0.1 / localhost
        if not is_strictly_localhost(endpoint):
            sys.stderr.write(f"Blocked non-localhost vision endpoint: {endpoint}\n")
            return _vision_error_result("error", f"Blocked non-localhost endpoint: {endpoint}")

        ok, buf = cv2.imencode(".png", img_np)
        if not ok:
            return _vision_error_result("error", "Failed to encode image for Ollama.")
        b64_img = base64.b64encode(buf.tobytes()).decode("ascii")
        url = endpoint.rstrip("/") + "/api/generate"
        body = json.dumps({
            "model": (model or "hf.co/ggml-org/SmolVLM2-2.2B-Instruct-GGUF").strip(),
            "prompt": prompt,
            "images": [b64_img],
            "stream": False,
            "format": "json",
            "options": {"temperature": 0.0},
        }).encode("utf-8")

        req = urllib.request.Request(
            url,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="ignore"))
            parsed_json = _extract_json_object(data.get("response", ""))
            elapsed_ms = (time.perf_counter() - t0) * 1000.0
            if not parsed_json:
                return _vision_error_result("error", "Ollama returned non-JSON response.", elapsed_ms, "Ollama")
            parsed_json.update({"_vision_status": "ok", "_vision_error": "", "_vision_duration_ms": round(elapsed_ms, 1), "_vision_device": "Ollama"})
            return parsed_json
    except Exception as e:
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        sys.stderr.write(f"Local vision fallback error: {e}\n")
        return _vision_error_result("error", f"Vision AI error: {e}", elapsed_ms, "")


def test_local_vision_request(request: Dict[str, Any]) -> Dict[str, Any]:
    """Tests local Vision AI readiness without sending any external network traffic."""
    provider = (request.get("provider") or "ollama").strip().lower()
    endpoint = (request.get("endpoint") or "http://127.0.0.1:11434").strip()
    model = (request.get("model") or "hf.co/ggml-org/SmolVLM2-2.2B-Instruct-GGUF").strip()

    if provider == "transformers":
        has_tf = importlib.util.find_spec("transformers") is not None
        has_torch = importlib.util.find_spec("torch") is not None
        has_pil = importlib.util.find_spec("PIL") is not None
        if has_tf and has_torch and has_pil:
            return {
                "status": "ok",
                "reachable": True,
                "endpoint": "on-device://python-transformers",
                "configured_model": model,
                "available_models": [model],
                "message": f"Embedded Python transformers + PyTorch detected. Ready to run {model} offline.",
            }
        missing = [name for name, ok in [("transformers", has_tf), ("torch", has_torch), ("Pillow", has_pil)] if not ok]
        return {
            "status": "ok",
            "reachable": False,
            "endpoint": "on-device://python-transformers",
            "configured_model": model,
            "available_models": [],
            "message": f"Missing Python package(s): {', '.join(missing)}. Run: pip install transformers torch accelerate Pillow",
        }

    if not is_strictly_localhost(endpoint):
        return {
            "status": "ok",
            "reachable": False,
            "endpoint": endpoint,
            "configured_model": model,
            "available_models": [],
            "message": "Security block: only 127.0.0.1 / localhost endpoints are permitted for PO documents.",
        }

    try:
        tags_url = endpoint.rstrip("/") + "/api/tags"
        req = urllib.request.Request(tags_url, method="GET")
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="ignore"))
            models = [m.get("name", "") for m in data.get("models", []) if m.get("name")]
            has_model = any(
                m == model or m.split(":")[0] == model.split(":")[0]
                for m in models
            )
            msg = (
                f"Connected to offline Ollama ({len(models)} local model(s)). Model '{model}' is ready."
                if has_model
                else f"Offline Ollama running on localhost, but '{model}' is not pulled yet. Run: ollama pull {model}"
            )
            return {
                "status": "ok",
                "reachable": True,
                "endpoint": endpoint,
                "configured_model": model,
                "available_models": models,
                "message": msg,
            }
    except Exception as e:
        return {
            "status": "ok",
            "reachable": False,
            "endpoint": endpoint,
            "configured_model": model,
            "available_models": [],
            "message": f"Offline Ollama not reachable at {endpoint} ({e}). Install Ollama and run: ollama pull {model}",
        }

# Self-company / Buyer identity (QTC Energy PCL) — always ignored during vendor extraction
SELF_COMPANY_KEYWORDS = [
    "qtc energy",
    "qtc ",
    " qtc",
    "qtc(",
    "qtc_",
    "qtc-",
    "คิวทีซี",
    "โรงงานระยอง",
    "krungthep kritha",
    "pluakdaeng",
    "mabyangporn",
    "ปลวกแดง",
    "มาบยางพร",
    "กรุงเทพกรีฑา",
]

SELF_TAX_IDS = {"0107553000158"}

NON_COMPANY_NOISE = [
    "qa inc",
    "qa incoming",
    "incoming pass",
    "purchase order",
    "head office",
    "one thousand",
    "delivery order",
    "bills of lading",
    "offer to purchase",
    "tax invoice",
    "approve by",
    "checked by",
    "issue by",
]

# Windows/macOS Thai PUA presentation glyph fallback map
THAI_PUA_MAP = {
    0xF700: "\u0E10",
    0xF701: "\u0E34",
    0xF702: "\u0E35",
    0xF703: "\u0E36",
    0xF704: "\u0E37",
    0xF705: "\u0E48",
    0xF706: "\u0E49",
    0xF707: "\u0E4A",
    0xF708: "\u0E4B",
    0xF709: "\u0E4C",
    0xF70A: "\u0E48",
    0xF70B: "\u0E49",
    0xF70C: "\u0E4A",
    0xF70D: "\u0E4B",
    0xF70E: "\u0E4C",
    0xF70F: "\u0E0D",
    0xF710: "\u0E31",
    0xF711: "\u0E4D",
    0xF712: "\u0E47",
    0xF713: "\u0E48",
    0xF714: "\u0E49",
    0xF715: "\u0E4A",
    0xF716: "\u0E4B",
    0xF717: "\u0E4C",
    0xF718: "\u0E38",
    0xF719: "\u0E39",
    0xF71A: "\u0E3A",
}

BROKEN_SARA_AM_WORDS = [
    (r"จ\s+ากัด", "จำกัด"),
    (r"ส\s+านักงาน", "สำนักงาน"),
    (r"ส\s+าเนา", "สำเนา"),
    (r"ล\s+าดับ", "ลำดับ"),
    (r"จ\s+านวน", "จำนวน"),
    (r"ก\s+าหนด", "กำหนด"),
    (r"ก\s+ากับ", "กำกับ"),
    (r"ช\s+าระ", "ชำระ"),
    (r"ต\s+าบล", "ตำบล"),
    (r"อ\s+าเภอ", "อำเภอ"),
    (r"ประจ\s+า", "ประจำ"),
    (r"ด\s+าเนิน", "ดำเนิน"),
    (r"อ\s+านาจ", "อำนาจ"),
    (r"บ\s+ารุง", "บำรุง"),
    (r"สีด\s+า", "สีดำ"),
    (r"ขอบด\s+า", "ขอบดำ"),
    (r"ท\s+างาน", "ทำงาน"),
    (r"ค\s+าสั่ง", "คำสั่ง"),
    (r"น\s+าเข้า", "นำเข้า"),
    (r"น\s+าส่ง", "นำส่ง"),
    (r"จำกัต", "จำกัด"),
    (r"จ\s*ำ\s*กั[ดต]", "จำกัด"),
    (r"บริ\s+ษัท", "บริษัท"),
    (r"ห้างหุ้นส่วน\s+จำกัด", "ห้างหุ้นส่วนจำกัด"),
]


def repair_thai_encoding(text: str) -> str:
    """
    Repairs:
    1. Microsoft Dynamics AX 2012 SSRS Tahoma Identity-H GID shift (0x0434..0x04A2).
    2. Windows/Mac PUA Thai presentation glyphs (0xF700..0xF71A).
    3. Decomposed / redundant Sara Am sequences (\u0E4D\u0E32, \u0E33\u0E32).
    4. GDI/Word PDF broken space + Sara Aa in common Thai words ('จ ากัด' -> 'จำกัด').
    """
    if not text:
        return text

    out = []
    for ch in text:
        cp = ord(ch)
        if 0x0434 <= cp <= 0x046D:
            out.append(chr(cp + 0x09CD))
        elif 0x046F <= cp <= 0x047B:
            out.append(chr(cp + 0x09D1))
        elif cp == 0x047C:
            out.append("\u0E33")
        elif 0x0495 <= cp <= 0x0499:
            out.append(chr(cp + 0x09B3))
        elif 0x049E <= cp <= 0x04A2:
            out.append(chr(cp + 0x09AA))
        elif cp in THAI_PUA_MAP:
            out.append(THAI_PUA_MAP[cp])
        else:
            out.append(ch)

    repaired = "".join(out)

    # Fix decomposed Sara Am and redundant trailing Sara Aa from AX 2012 / GDI
    repaired = repaired.replace("\u0E4D\u0E32", "\u0E33")
    repaired = re.sub(r"([\u0E48-\u0E4B])\s*\u0E4D\s*\u0E32", "\\1\u0E33", repaired)
    repaired = repaired.replace("\u0E33\u0E32", "\u0E33")

    # Fix broken space + Sara Aa in Thai words (preserve real non-Thai spaces)
    for pattern, repl in BROKEN_SARA_AM_WORDS:
        repaired = re.sub(pattern, repl, repaired)

    # Normalize zero-width characters
    repaired = re.sub(r"[\u200B-\u200D\uFEFF\u00AD]", "", repaired)
    return repaired


def is_ignored_self_company(name: str) -> bool:
    """Returns True if candidate belongs to QTC Energy (buyer) or generic boilerplate."""
    if not name or not name.strip():
        return True
    low = re.sub(r"\s+", " ", name.strip().lower())
    if low == "qtc":
        return True
    for kw in SELF_COMPANY_KEYWORDS:
        if kw in low:
            return True
    for noise in NON_COMPANY_NOISE:
        if noise in low:
            return True
    for tid in SELF_TAX_IDS:
        if tid in low:
            return True
    # Must contain meaningful name beyond legal prefix/suffix
    stripped = re.sub(
        r"(บริษัท|ห้างหุ้นส่วนจำกัด|ห้างหุ้นส่วนสามัญ|บจก\.?|หจก\.?|จำกัด|\(มหาชน\)|มหาชน|public company limited|limited partnership|company limited|co\.,?\s*ltd\.?|limited|ltd\.?|inc\.?|corp\.?)",
        "",
        low,
    ).strip(" .,-:;/()")
    if len(stripped) < 2:
        return True
    return False


def get_paddle_ocr():
    global _paddle_ocr_instance, _paddle_ocr_attempted
    if _paddle_ocr_instance is None and not _paddle_ocr_attempted and HAS_PADDLEOCR:
        _paddle_ocr_attempted = True
        # PaddleOCR 3.x uses use_textline_orientation without show_log/enable_mkldnn;
        # wrap gracefully so missing paddlepaddle backend never blocks native PDF extraction.
        for kwargs in (
            {"lang": "th", "use_textline_orientation": True},
            {"lang": "en", "use_textline_orientation": True},
            {"use_angle_cls": True, "lang": "th", "show_log": False},
        ):
            try:
                _paddle_ocr_instance = PaddleOCR(**kwargs)
                break
            except BaseException:
                _paddle_ocr_instance = None
    return _paddle_ocr_instance


_TESSDATA_DOWNLOAD_FAILED: bool = False


def _resolve_tess_models_dir(root_dir: str = "") -> str:
    cleaned = (root_dir or os.environ.get("PO_AUTOFLOW_ROOT_DIR") or "").strip().rstrip("\\/")
    if cleaned:
        return os.path.join(cleaned, "Models", "tesseract")
    for fallback_root in (r"D:\PO-AutoFlow", r"C:\PO-AutoFlow"):
        cand = os.path.join(fallback_root, "Models", "tesseract")
        if os.path.isdir(fallback_root) or os.path.isdir(cand):
            return cand
    local_app = os.environ.get("LOCALAPPDATA", "")
    if local_app:
        return os.path.join(local_app, "PO-AutoFlow", "Models", "tesseract")
    return os.path.join(r"D:\PO-AutoFlow", "Models", "tesseract")


def _find_tesseract_exe(root_dir: str = "") -> Optional[str]:
    local_app = os.environ.get("LOCALAPPDATA", "")
    managed_dir = _resolve_tess_models_dir(root_dir)
    candidates = [
        os.path.join(managed_dir, "tesseract.exe"),
        r"D:\PO-AutoFlow\Models\tesseract\tesseract.exe",
        r"C:\PO-AutoFlow\Models\tesseract\tesseract.exe",
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
    ]
    if local_app:
        candidates.append(os.path.join(local_app, "Programs", "Tesseract-OCR", "tesseract.exe"))
    which_tess = shutil.which("tesseract")
    if which_tess:
        candidates.append(which_tess)

    for path in candidates:
        if path and os.path.isfile(path):
            return path
    return None


def _ensure_tessdata_dir(tess_exe: str, root_dir: str = "") -> Optional[str]:
    """Ensures eng + tha traineddata exist in a readable tessdata directory."""
    global _TESSDATA_DOWNLOAD_FAILED
    managed_tessdata = os.path.join(_resolve_tess_models_dir(root_dir), "tessdata")
    sibling_tessdata = os.path.join(os.path.dirname(tess_exe), "tessdata")

    for d in (managed_tessdata, sibling_tessdata):
        if (
            os.path.isfile(os.path.join(d, "tha.traineddata"))
            and os.path.isfile(os.path.join(d, "eng.traineddata"))
        ):
            return d

    os.makedirs(managed_tessdata, exist_ok=True)
    for lang in ("eng", "tha"):
        dest = os.path.join(managed_tessdata, f"{lang}.traineddata")
        if os.path.isfile(dest) and os.path.getsize(dest) > 50_000:
            continue
        sib_file = os.path.join(sibling_tessdata, f"{lang}.traineddata")
        if os.path.isfile(sib_file) and os.path.getsize(sib_file) > 50_000:
            try:
                shutil.copy2(sib_file, dest)
                continue
            except Exception:
                pass
        if not _TESSDATA_DOWNLOAD_FAILED:
            url = f"https://github.com/tesseract-ocr/tessdata_fast/raw/main/{lang}.traineddata"
            try:
                urllib.request.urlretrieve(url, dest)
            except Exception as e:
                sys.stderr.write(f"Failed downloading {lang}.traineddata: {e}\n")
                _TESSDATA_DOWNLOAD_FAILED = True
                if os.path.exists(dest):
                    try:
                        os.remove(dest)
                    except Exception:
                        pass

    if os.path.isfile(os.path.join(managed_tessdata, "tha.traineddata")) and os.path.isfile(
        os.path.join(managed_tessdata, "eng.traineddata")
    ):
        return managed_tessdata
    if os.path.isfile(os.path.join(sibling_tessdata, "eng.traineddata")):
        return sibling_tessdata
    if os.path.isfile(os.path.join(managed_tessdata, "eng.traineddata")):
        return managed_tessdata
    return None


def _clean_tesseract_line_tokens(token_items: List[tuple]) -> str:
    """Joins Tesseract TSV word boxes using horizontal pixel gaps to eliminate intra-Thai-word spaces."""
    if not token_items:
        return ""
    items = sorted(token_items, key=lambda t: t[0])
    parts: List[str] = [items[0][3]]
    prev_right = items[0][1]
    prev_h = max(items[0][2], 12.0)
    prev_text = items[0][3]

    thai_tail = re.compile(r"[\u0E00-\u0E7F]$")
    thai_head = re.compile(r"^[\u0E00-\u0E7F]")

    for left, right, h, word in items[1:]:
        gap = left - prev_right
        line_h = max(prev_h, h, 12.0)
        both_thai = bool(thai_tail.search(prev_text) and thai_head.match(word))
        # Tesseract splits Thai syllables into word tokens with small pixel gaps; join intra-word clusters.
        if both_thai and gap <= max(3.5, line_h * 0.24):
            parts.append(word)
        else:
            parts.append(" " + word)
        prev_right = max(prev_right, right)
        prev_h = h
        prev_text = word

    joined = re.sub(r"\s+", " ", "".join(parts)).strip()
    return repair_thai_encoding(joined).strip()


def run_tesseract_ocr(img_np: np.ndarray, root_dir: str = "") -> tuple:
    """Runs Tesseract 5 CLI (tha+eng) on an image and returns (lines, boxes, avg_conf)."""
    tess_exe = _find_tesseract_exe(root_dir)
    if not tess_exe:
        return [], [], 0.0
    tessdata_dir = _ensure_tessdata_dir(tess_exe, root_dir)
    if not tessdata_dir:
        return [], [], 0.0

    has_tha = os.path.isfile(os.path.join(tessdata_dir, "tha.traineddata"))
    lang_arg = "tha+eng" if has_tha else "eng"

    ok, buf = cv2.imencode(".png", img_np)
    if not ok:
        return [], [], 0.0

    tmp_png = ""
    try:
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tf:
            tf.write(buf.tobytes())
            tmp_png = tf.name

        cmd = [
            tess_exe,
            tmp_png,
            "stdout",
            "--tessdata-dir",
            tessdata_dir,
            "-l",
            lang_arg,
            "--oem",
            "1",
            "--psm",
            "6",
            "tsv",
        ]
        kwargs: Dict[str, Any] = {
            "capture_output": True,
            "text": True,
            "encoding": "utf-8",
            "errors": "ignore",
            "timeout": 45,
        }
        if os.name == "nt":
            kwargs["creationflags"] = 0x08000000

        proc = subprocess.run(cmd, **kwargs)
        if proc.returncode != 0 or not proc.stdout:
            return [], [], 0.0

        grouped: Dict[tuple, Dict[str, Any]] = {}
        order: List[tuple] = []
        for raw_row in proc.stdout.splitlines()[1:]:
            parts = raw_row.split("\t")
            if len(parts) < 12:
                continue
            try:
                level = int(parts[0])
                if level != 5:
                    continue
                word = parts[11].strip()
                if not word:
                    continue
                conf_val = float(parts[10])
                if conf_val < 0:
                    conf_val = 0.0
                left = float(parts[6])
                top = float(parts[7])
                right = left + float(parts[8])
                bottom = top + float(parts[9])
                key = (int(parts[1]), int(parts[2]), int(parts[3]), int(parts[4]))
            except ValueError:
                continue

            if key not in grouped:
                grouped[key] = {
                    "tokens": [],
                    "x0": left,
                    "y0": top,
                    "x1": right,
                    "y1": bottom,
                    "conf_sum": 0.0,
                    "count": 0,
                }
                order.append(key)
            entry = grouped[key]
            entry["tokens"].append((left, right, max(1.0, bottom - top), word))
            entry["x0"] = min(entry["x0"], left)
            entry["y0"] = min(entry["y0"], top)
            entry["x1"] = max(entry["x1"], right)
            entry["y1"] = max(entry["y1"], bottom)
            entry["conf_sum"] += conf_val / 100.0
            entry["count"] += 1

        ocr_lines: List[str] = []
        boxes: List[Dict[str, Any]] = []
        total_conf = 0.0
        for key in order:
            entry = grouped[key]
            line_text = _clean_tesseract_line_tokens(entry["tokens"])
            if not line_text:
                continue
            avg_line_conf = entry["conf_sum"] / max(1, entry["count"])
            total_conf += avg_line_conf
            ocr_lines.append(line_text)
            x0, y0, x1, y1 = entry["x0"], entry["y0"], entry["x1"], entry["y1"]
            boxes.append({
                "box": [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
                "text": line_text,
                "confidence": round(avg_line_conf, 4),
                "type": "ocr",
            })

        avg_conf = (total_conf / len(ocr_lines)) if ocr_lines else 0.0
        return ocr_lines, boxes, avg_conf
    except Exception as e:
        sys.stderr.write(f"run_tesseract_ocr error: {e}\n")
        return [], [], 0.0
    finally:
        if tmp_png and os.path.exists(tmp_png):
            try:
                os.remove(tmp_png)
            except Exception:
                pass


def run_windows_winrt_ocr(img_np: np.ndarray) -> tuple:
    """Zero-install Windows 10/11 WinRT OcrEngine fallback returning (lines, boxes, avg_conf)."""
    if os.name != "nt":
        return [], [], 0.0

    # WinRT OcrEngine rejects images exceeding ~2600px on either dimension
    h, w = img_np.shape[:2]
    scale = 1.0
    work_img = img_np
    max_dim = max(h, w)
    if max_dim > 2400:
        scale = 2400.0 / float(max_dim)
        work_img = cv2.resize(
            img_np,
            (max(1, int(w * scale)), max(1, int(h * scale))),
            interpolation=cv2.INTER_AREA,
        )

    ok, buf = cv2.imencode(".png", work_img)
    if not ok:
        return [], [], 0.0

    tmp_png = ""
    try:
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tf:
            tf.write(buf.tobytes())
            tmp_png = tf.name

        escaped_path = tmp_png.replace("'", "''")
        ps_script = (
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; "
            "Add-Type -AssemblyName System.Runtime.WindowsRuntime; "
            "$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]; "
            "$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]; "
            "$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]; "
            "$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { "
            "$_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and "
            "$_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]; "
            "function Await($op, $t) { $nt = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $nt.Wait(-1) | Out-Null; $nt.Result }; "
            f"$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync('{escaped_path}')) ([Windows.Storage.StorageFile]); "
            "$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream]); "
            "$dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder]); "
            "$bmp = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap]); "
            "$eng = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages(); "
            "if (-not $eng) { $eng = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('en-US')) }; "
            "if (-not $eng) { '[]'; exit 0 }; "
            "$res = Await ($eng.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult]); "
            "$out = foreach ($ln in $res.Lines) { "
            "  $ws = $ln.Words; if ($ws.Count -eq 0) { continue }; "
            "  $x0 = ($ws | ForEach-Object { $_.BoundingRect.X } | Measure-Object -Minimum).Minimum; "
            "  $y0 = ($ws | ForEach-Object { $_.BoundingRect.Y } | Measure-Object -Minimum).Minimum; "
            "  $x1 = ($ws | ForEach-Object { $_.BoundingRect.X + $_.BoundingRect.Width } | Measure-Object -Maximum).Maximum; "
            "  $y1 = ($ws | ForEach-Object { $_.BoundingRect.Y + $_.BoundingRect.Height } | Measure-Object -Maximum).Maximum; "
            "  [PSCustomObject]@{ text = $ln.Text; x0 = $x0; y0 = $y0; x1 = $x1; y1 = $y1 } "
            "}; "
            "@($out) | ConvertTo-Json -Compress"
        )
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps_script],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="ignore",
            timeout=30,
            creationflags=0x08000000,
        )
        if proc.returncode != 0 or not proc.stdout.strip():
            return [], [], 0.0

        parsed_json = json.loads(proc.stdout.strip())
        if isinstance(parsed_json, dict):
            parsed_json = [parsed_json]
        if not isinstance(parsed_json, list):
            return [], [], 0.0

        inv_scale = 1.0 / scale if scale > 0 else 1.0
        ocr_lines: List[str] = []
        boxes: List[Dict[str, Any]] = []
        for item in parsed_json:
            line_text = repair_thai_encoding(str(item.get("text") or "").strip())
            if not line_text:
                continue
            x0 = float(item.get("x0") or 0.0) * inv_scale
            y0 = float(item.get("y0") or 0.0) * inv_scale
            x1 = float(item.get("x1") or 0.0) * inv_scale
            y1 = float(item.get("y1") or 0.0) * inv_scale
            ocr_lines.append(line_text)
            boxes.append({
                "box": [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
                "text": line_text,
                "confidence": 0.85,
                "type": "ocr",
            })

        return ocr_lines, boxes, (0.85 if ocr_lines else 0.0)
    except Exception as e:
        sys.stderr.write(f"run_windows_winrt_ocr error: {e}\n")
        return [], [], 0.0
    finally:
        if tmp_png and os.path.exists(tmp_png):
            try:
                os.remove(tmp_png)
            except Exception:
                pass


def _is_winrt_thai_available() -> bool:
    if os.name != "nt":
        return False
    ocr_root = r"C:\Windows\OCR"
    if not os.path.isdir(ocr_root):
        return False
    try:
        return any(name.lower().startswith("th") for name in os.listdir(ocr_root))
    except Exception:
        return False


def _resolve_openthaigpt_dir(root_dir: str = "") -> Optional[str]:
    candidates = []
    if root_dir:
        candidates.append(os.path.join(root_dir.strip(), "Models", "openthaigpt-ocr-text"))
    env_root = os.environ.get("PO_AUTOFLOW_ROOT", "").strip()
    if env_root:
        candidates.append(os.path.join(env_root, "Models", "openthaigpt-ocr-text"))
    meipass = getattr(sys, "_MEIPASS", "")
    if meipass:
        candidates.extend([
            os.path.join(meipass, "openthaigpt-ocr-text"),
            os.path.join(meipass, "models", "openthaigpt-ocr-text"),
        ])
    exe_dir = os.path.dirname(os.path.abspath(sys.executable if getattr(sys, "frozen", False) else __file__))
    candidates.extend([
        os.path.join(exe_dir, "models", "openthaigpt-ocr-text"),
        os.path.join(exe_dir, "..", "models", "openthaigpt-ocr-text"),
        os.path.join(exe_dir, "resources", "models", "openthaigpt-ocr-text"),
        r"D:\PO-AutoFlow\Models\openthaigpt-ocr-text",
        r"C:\PO-AutoFlow\Models\openthaigpt-ocr-text",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "openthaigpt-ocr-text"),
    ])
    for d in candidates:
        norm = os.path.normpath(d) if d else ""
        if (
            norm
            and os.path.isfile(os.path.join(norm, "det.onnx"))
            and os.path.isfile(os.path.join(norm, "rec.onnx"))
            and os.path.isfile(os.path.join(norm, "runtime", "line_engine.py"))
        ):
            return norm
    return None


def _openthaigpt_runtime_backend() -> Optional[str]:
    try:
        import pyclipper  # noqa: F401
    except ImportError:
        return None
    try:
        import openvino  # noqa: F401
        return "openvino"
    except ImportError:
        pass
    try:
        import onnxruntime  # noqa: F401
        return "onnxruntime"
    except ImportError:
        return None


def get_openthaigpt_ocr(root_dir: str = "", relaxed: bool = False):
    model_dir = _resolve_openthaigpt_dir(root_dir)
    backend = _openthaigpt_runtime_backend()
    if not model_dir or not backend:
        return None
    key = (model_dir, bool(relaxed), backend)
    if key in _openthaigpt_cache:
        return _openthaigpt_cache[key]
    try:
        if model_dir not in sys.path:
            sys.path.insert(0, model_dir)
        from runtime.line_engine import LineOCR  # type: ignore

        kwargs: Dict[str, Any] = {"threads": 4, "runtime": {"backend": backend}}
        if relaxed:
            kwargs["rec"] = {"drop_below": 0.50, "junk_below": 0.65, "junk_invalid": 0.20}
        inst = LineOCR(model_dir, **kwargs)
        _openthaigpt_cache[key] = inst
        return inst
    except Exception as e:
        sys.stderr.write(f"OpenThai 2.0 init failed: {e}\n")
        _openthaigpt_cache[key] = None
        return None


def run_openthaigpt_ocr(img_np: np.ndarray, root_dir: str = "", relaxed: bool = False) -> tuple:
    eng = get_openthaigpt_ocr(root_dir, relaxed=relaxed)
    if eng is None:
        return [], [], 0.0
    res = eng.read(img_np)
    lines: List[str] = []
    boxes: List[Dict[str, Any]] = []
    confs: List[float] = []
    for item in res.get("lines") or []:
        txt = repair_thai_encoding(str(item.get("text") or "").strip())
        if not txt:
            continue
        conf = float(item.get("confidence") or 0.0)
        lines.append(txt)
        confs.append(conf)
        boxes.append({
            "box": item.get("box") or [],
            "text": txt,
            "confidence": conf,
            "type": "ocr",
        })
    avg_conf = (sum(confs) / len(confs)) if confs else 0.0
    return lines, boxes, avg_conf


def _run_image_ocr_cascade(
    img_np: np.ndarray,
    root_dir: str = "",
    quality_preset: str = "balanced",
    preferred_engine: str = "auto",
) -> tuple:
    """Runs offline OCR engines (OpenThai 2.0 OCR-Text -> Tesseract 5 tha+eng -> Windows WinRT)."""
    enhanced_img: Optional[np.ndarray] = None
    is_max = (quality_preset or "balanced").strip().lower() == "max_accuracy"
    pref = (preferred_engine or "auto").strip().lower()

    def _try_openthaigpt():
        lines, boxes, conf = run_openthaigpt_ocr(img_np, root_dir, relaxed=False)
        if not lines or (is_max and (len(lines) < 4 or conf < 0.85)):
            r_lines, r_boxes, r_conf = run_openthaigpt_ocr(img_np, root_dir, relaxed=True)
            if r_lines and (not lines or len(r_lines) > len(lines)):
                lines, boxes, conf = r_lines, r_boxes, r_conf
        if not lines or (is_max and len(lines) < 3):
            nonlocal enhanced_img
            if enhanced_img is None:
                enhanced_img = Preprocessor.deskew_and_enhance(img_np)
            e_lines, e_boxes, e_conf = run_openthaigpt_ocr(enhanced_img, root_dir, relaxed=True)
            if e_lines and len(e_lines) > len(lines):
                lines, boxes, conf = e_lines, e_boxes, e_conf
        return lines, boxes, conf

    def _try_tesseract():
        tess_lines, tess_boxes, tess_conf = run_tesseract_ocr(img_np, root_dir)
        if not tess_lines or (is_max and (len(tess_lines) < 4 or tess_conf < 0.72)):
            nonlocal enhanced_img
            if enhanced_img is None:
                enhanced_img = Preprocessor.deskew_and_enhance(img_np)
            enh_lines, enh_boxes, enh_conf = run_tesseract_ocr(enhanced_img, root_dir)
            if enh_lines and (not tess_lines or len(enh_lines) > len(tess_lines) or enh_conf > tess_conf + 0.03):
                tess_lines, tess_boxes, tess_conf = enh_lines, enh_boxes, enh_conf
        return tess_lines, tess_boxes, tess_conf

    # Honor explicit Tesseract preference if user overrode engine in Advanced settings
    if pref in ("tesseract", "tesseract_tha_eng", "tesseract5"):
        t_lines, t_boxes, t_conf = _try_tesseract()
        if t_lines:
            return t_lines, t_boxes, t_conf, "tesseract_tha_eng"

    # Default #1 winner for Thai & English scans: OpenThai 2.0 OCR-Text
    ot_lines, ot_boxes, ot_conf = _try_openthaigpt()
    if ot_lines:
        return ot_lines, ot_boxes, ot_conf, "openthaigpt_ocr"

    ocr_engine = get_paddle_ocr()
    if ocr_engine is not None:
        try:
            if enhanced_img is None:
                enhanced_img = Preprocessor.deskew_and_enhance(img_np)
            ocr_res = ocr_engine.ocr(enhanced_img, cls=True)
            ocr_lines: List[str] = []
            boxes: List[Dict[str, Any]] = []
            total_conf = 0.0
            if ocr_res and len(ocr_res) > 0 and ocr_res[0]:
                for line_data in ocr_res[0]:
                    bbox, (text, conf) = line_data
                    repaired_line = repair_thai_encoding(text)
                    ocr_lines.append(repaired_line)
                    total_conf += conf
                    boxes.append({
                        "box": bbox,
                        "text": repaired_line,
                        "confidence": float(conf),
                        "type": "ocr",
                    })
            if ocr_lines:
                return ocr_lines, boxes, (total_conf / len(ocr_lines)), "paddleocr_ppocrv5"
        except Exception as e:
            sys.stderr.write(f"PaddleOCR runtime fallback: {e}\n")

    t_lines, t_boxes, t_conf = _try_tesseract()
    if t_lines:
        return t_lines, t_boxes, t_conf, "tesseract_tha_eng"

    winrt_lines, winrt_boxes, winrt_conf = run_windows_winrt_ocr(img_np)
    if winrt_lines:
        return winrt_lines, winrt_boxes, winrt_conf, "windows_winrt_ocr"

    return [], [], 0.0, "none"


def read_image_unicode(file_path: str) -> Optional[np.ndarray]:
    """Reads an image from a path supporting non-ASCII / Unicode characters on Windows."""
    try:
        data = np.fromfile(file_path, dtype=np.uint8)
        if data.size == 0:
            return None
        return cv2.imdecode(data, cv2.IMREAD_COLOR)
    except Exception as e:
        sys.stderr.write(f"read_image_unicode error on {file_path}: {e}\n")
        return None


THAI_PREFIXES_ORDERED = [
    r"บริษัท\s*จำกัด\s*\(มหาชน\)",
    r"บริษัท\s*มหาชน\s*จำกัด",
    r"บริษัท",
    r"บจก\.",
    r"บ\.\s*จำกัด",
    r"ห้างหุ้นส่วนจำกัด",
    r"หจก\.",
    r"ห้างหุ้นส่วนสามัญ",
    r"หสน\.",
]

ENG_SUFFIXES_ORDERED = [
    r"PUBLIC\s+COMPANY\s+LIMITED",
    r"LIMITED\s+PARTNERSHIP",
    r"LTD\.?,?\s*PART\.?",
    r"COMPANY\s+LIMITED",
    r"CO\.,?\s*LTD\.?",
    r"CORPORATION",
    r"INCORPORATED",
    r"LIMITED",
    r"LTD\.?",
    r"CORP\.?",
    r"INC\.?",
    r"PCL\.?",
    r"PLC\.?",
]

SUPPLIER_LABELS = [
    "ชื่อผู้ขาย", "ผู้ขาย", "ผู้จำหน่าย", "ผู้ให้บริการ", "ออกโดย", "เจ้าหนี้",
    "supplier", "vendor", "seller", "issued by", "from:", "biller"
]

BUYER_LABELS = [
    "ผู้ซื้อ", "ลูกค้า", "ส่งถึง", "จัดส่งที่", "ผู้รับ", "สถานที่ส่งของ", "ใบสั่งซื้อออกให้",
    "เรียน", "customer", "buyer", "ship to", "deliver to", "bill to", "consignee", "invoice to"
]

PO_LABELS = [
    "ใบสั่งซื้อเลขที่", "po number", "po no", "p.o. number", "p.o. no", "purchase order no"
]


class Preprocessor:
    @staticmethod
    def deskew_and_enhance(image_np: np.ndarray) -> np.ndarray:
        """Auto-rotation/Deskew + CLAHE + Unsharp sharpening."""
        if len(image_np.shape) == 3:
            gray = cv2.cvtColor(image_np, cv2.COLOR_BGR2GRAY)
        else:
            gray = image_np.copy()

        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        enhanced = clahe.apply(gray)

        gaussian = cv2.GaussianBlur(enhanced, (0, 0), 2.0)
        sharpened = cv2.addWeighted(enhanced, 1.5, gaussian, -0.5, 0)

        try:
            _, thresh = cv2.threshold(sharpened, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
            coords = np.column_stack(np.where(thresh > 0))
            if len(coords) > 50:
                angle = cv2.minAreaRect(coords)[-1]
                if angle < -45:
                    angle = -(90 + angle)
                elif angle > 45:
                    angle = 90 - angle
                else:
                    angle = -angle

                if 0.5 < abs(angle) < 45.0:
                    (h, w) = sharpened.shape[:2]
                    center = (w // 2, h // 2)
                    M = cv2.getRotationMatrix2D(center, angle, 1.0)
                    sharpened = cv2.warpAffine(
                        sharpened, M, (w, h),
                        flags=cv2.INTER_CUBIC,
                        borderMode=cv2.BORDER_REPLICATE,
                    )
        except Exception:
            pass

        return cv2.cvtColor(sharpened, cv2.COLOR_GRAY2BGR)


def extract_native_pdf_text(pdf_path: str) -> List[Dict[str, Any]]:
    """Extract native digital text, repair AX2012/GDI Thai encoding, and order blocks spatially."""
    results = []
    doc = fitz.open(pdf_path)
    for page_idx in range(len(doc)):
        page = doc[page_idx]
        text_blocks = page.get_text("blocks")

        valid_blocks = []
        for b in text_blocks:
            # b: (x0, y0, x1, y1, text, block_no, block_type)
            if len(b) >= 5 and b[4] and b[4].strip():
                repaired_block_text = repair_thai_encoding(b[4].strip())
                valid_blocks.append((float(b[0]), float(b[1]), float(b[2]), float(b[3]), repaired_block_text))

        # Sort blocks top-to-bottom (6pt row bucket), left-to-right for true reading order
        valid_blocks.sort(key=lambda blk: (round(blk[1] / 6.0), blk[0]))

        boxes = []
        ordered_text_parts = []
        for x0, y0, x1, y1, block_text in valid_blocks:
            ordered_text_parts.append(block_text)
            boxes.append({
                "box": [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
                "text": block_text,
                "confidence": 1.0,
                "type": "native",
            })

        repaired_text = "\n".join(ordered_text_parts) if ordered_text_parts else repair_thai_encoding(page.get_text("text"))

        results.append({
            "page_number": page_idx + 1,
            "raw_text": repaired_text,
            "has_native_text": len(repaired_text.strip()) > 30,
            "image_count": len(page.get_images()),
            "boxes": boxes,
            "width": page.rect.width,
            "height": page.rect.height,
        })
    doc.close()
    return results


def render_pdf_page_to_image(pdf_path: str, page_number: int, dpi: int = 200) -> np.ndarray:
    """Renders PDF page to high-res OpenCV BGR image."""
    doc = fitz.open(pdf_path)
    page = doc[page_number - 1]
    zoom = dpi / 72.0
    mat = fitz.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=mat, alpha=False)
    img_data = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3)
    doc.close()
    return cv2.cvtColor(img_data, cv2.COLOR_RGB2BGR)


def _box_rect(box: Dict[str, Any]) -> Optional[tuple]:
    coords = box.get("box")
    if not coords or len(coords) < 4:
        return None
    xs = [float(p[0]) for p in coords]
    ys = [float(p[1]) for p in coords]
    return (min(xs), min(ys), max(xs), max(ys))


def _find_right_adjacent_box(label_box: Dict[str, Any], all_boxes: List[Dict[str, Any]]) -> Optional[str]:
    rect_a = _box_rect(label_box)
    if not rect_a:
        return None
    ax0, ay0, ax1, ay1 = rect_a
    ay_mid = (ay0 + ay1) / 2.0

    line_h = max(ay1 - ay0, 12.0)
    tol_y = max(9.0, line_h * 0.65)
    tol_x = max(220.0, line_h * 18.0)

    best_val = None
    best_dx = 1e9
    for other in all_boxes:
        if other is label_box:
            continue
        rect_b = _box_rect(other)
        if not rect_b:
            continue
        bx0, by0, bx1, by1 = rect_b
        by_mid = (by0 + by1) / 2.0
        dx = bx0 - ax1
        if abs(ay_mid - by_mid) <= tol_y and -2.0 <= dx <= tol_x:
            candidate_text = other.get("text", "").strip()
            if candidate_text and dx < best_dx:
                best_dx = dx
                best_val = candidate_text
    return best_val


def _clean_thai_candidate_tail(candidate: str) -> str:
    """Stops Thai company name before trailing address clauses, verbs, or contact info."""
    stop_markers = [
        r"\s+มีความยินดี",
        r"\s+ขอเสนอราคา",
        r"\s+ขอยืนยัน",
        r"\s+เลขที่\b",
        r"\s+ที่อยู่",
        r"\s+โทร",
        r"\s+tel\b",
        r"\s+fax\b",
        r"\s+e-?mail\b",
        r"\s+\d{1,5}/\d+",
        r"\s+ม\.\s*\d",
        r"\s+หมู่\s*\d",
        r"\s+ซอย",
        r"\s+ถนน",
        r"\s+ต\.\s*\S",
        r"\s+อ\.\s*\S",
        r"\s+จ\.\s*\S",
    ]
    cleaned = candidate
    for marker in stop_markers:
        cleaned = re.split(marker, cleaned, maxsplit=1, flags=re.IGNORECASE)[0]
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" .,:;-/|()")
    return cleaned


def _normalize_po_token(raw_token: str) -> List[str]:
    """Validates and normalizes extracted PO token(s); rejects bare words like 'Number'."""
    val = raw_token.strip(" :.-_/#")
    # Must contain at least 4 digits overall (e.g. PO-26004156-1, 26004156)
    digits = re.findall(r"\d", val)
    if len(digits) < 4:
        return []
    # Reject phone/fax numbers, dates (29/10/2026), or PR numbers
    if re.match(r"^(PR|DV|TAX|TEL|FAX)", val, re.IGNORECASE):
        return []
    if re.match(r"^\d{1,2}/\d{1,2}/\d{2,4}$", val):
        return []

    if re.match(r"^P\.?O\.?[-_/]?\s*\d", val, re.IGNORECASE):
        norm = re.sub(r"^P\.?O\.?[-_/\s]*", "PO-", val, flags=re.IGNORECASE).upper()
    elif re.match(r"^\d{6,}(-\d+)?$", val):
        norm = f"PO-{val}"
    else:
        norm = val.upper()

    variants = []
    # Preserve base PO before revision suffix if `-1` / `-2` present
    base_match = re.match(r"^(PO-\d{4,})-\d{1,2}$", norm)
    if base_match:
        variants.append(base_match.group(1))
    variants.append(norm)
    return variants


def _normalize_for_neg_check(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip().lower())


def _is_negative_phrase(candidate: str, negative_phrases: List[str]) -> bool:
    if not negative_phrases:
        return False
    norm_cand = _normalize_for_neg_check(candidate)
    if not norm_cand:
        return False
    for neg in negative_phrases:
        norm_neg = _normalize_for_neg_check(neg)
        if not norm_neg:
            continue
        if norm_cand == norm_neg or (len(norm_neg) >= 5 and norm_neg in norm_cand):
            return True
        if HAS_RAPIDFUZZ and fuzz.ratio(norm_cand, norm_neg) >= 90.0:
            return True
    return False


def _clean_ocr_email(raw_email: str) -> str:
    """Repairs common OCR domain/spacing typos inside extracted email addresses."""
    cleaned = re.sub(r"\s+", "", (raw_email or "").strip().lower())
    if "@" not in cleaned:
        return ""
    local, domain = cleaned.split("@", 1)
    domain_fixes = {
        "gmai1.com": "gmail.com",
        "gmaii.com": "gmail.com",
        "gmal.com": "gmail.com",
        "hotmai1.com": "hotmail.com",
        "hotmaii.com": "hotmail.com",
        "yah00.com": "yahoo.com",
        "yahooo.com": "yahoo.com",
        "outl00k.com": "outlook.com",
    }
    domain = domain_fixes.get(domain, domain)
    domain = re.sub(r"\.c0m$", ".com", domain)
    domain = re.sub(r"\.c0\.th$", ".co.th", domain)
    if not local or not re.match(r"^[a-z0-9.\-]+\.[a-z]{2,}$", domain):
        return ""
    return f"{local}@{domain}"


def parse_supplier_and_po(
    text: str,
    boxes: List[Dict[str, Any]],
    negative_phrases: Optional[List[str]] = None,
    preferred_y_band: Optional[float] = None,
) -> Dict[str, Any]:
    """
    Distinguishes supplier vs buyer (ignoring QTC Energy PCL), repairs Thai text,
    pairs spatial labels, applies self-learned negative filters & layout zone boosts,
    and enforces Thai-first -> English fallback ordering.
    """
    neg_list = negative_phrases or []
    text = repair_thai_encoding(text)
    lines = [re.sub(r"\s+", " ", line).strip() for line in text.split("\n") if line.strip()]

    # 1. PO Number extraction (spatial label pairing + regex with digit validation)
    po_numbers: List[str] = []

    def add_po_candidates(raw_val: str):
        for v in _normalize_po_token(raw_val):
            if v not in po_numbers:
                po_numbers.append(v)

    for box in boxes:
        btext_low = box.get("text", "").strip().lower()
        if any(lbl in btext_low for lbl in PO_LABELS):
            adj = _find_right_adjacent_box(box, boxes)
            if adj:
                add_po_candidates(adj)

    po_regexes = [
        r"\b(PO[-_/]\d{4,}(?:[-_/]\d{1,3})?)\b",
        r"\b(P\.O\.[-_/]?\s*\d{4,}(?:[-_/]\d{1,3})?)\b",
        r"(?:ใบสั่งซื้อเลขที่|Purchase\s*Order\s*(?:No\.?|Number|#)|PO\s*Number)\s*[:/]?\s*(PO[-_/]?\d{4,}(?:[-_/]\d{1,3})?|\d{6,}(?:-\d{1,3})?)",
    ]
    for pattern in po_regexes:
        for match in re.finditer(pattern, text, re.IGNORECASE):
            add_po_candidates(match.group(1))

    # 2. Tax IDs (excluding QTC's own Tax ID)
    tax_ids: List[str] = []
    tax_pattern = r"\b(\d{13}|\d-\d{4}-\d{5}-\d{2}-\d)\b"
    for match in re.finditer(tax_pattern, text):
        clean_tax = match.group(1).replace("-", "")
        if clean_tax not in SELF_TAX_IDS and clean_tax not in tax_ids:
            tax_ids.append(clean_tax)

    # 3. Emails (excluding QTC domains; also handles labeled local parts with OCR spaces)
    emails: List[str] = []
    for match in re.finditer(
        r"e-?mail\s*[:：]\s*([A-Za-z0-9._%+\-]+(?:\s+[A-Za-z0-9._%+\-]+){0,2}@[A-Za-z0-9.\-]+\.[A-Za-z0-9]{2,})",
        text,
        re.IGNORECASE,
    ):
        em = _clean_ocr_email(match.group(1))
        if em and "qtc-energy" not in em and em not in emails:
            emails.append(em)
    for match in re.finditer(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z0-9]{2,}", text):
        em = _clean_ocr_email(match.group(0))
        if (
            em
            and "qtc-energy" not in em
            and not any(
                existing == em or (existing.endswith(em) and existing.split("@")[1] == em.split("@")[1])
                for existing in emails
            )
        ):
            emails.append(em)

    # 4. Extract supplier candidates (Spatial pairing + Thai + English)
    supplier_candidates: List[Dict[str, Any]] = []

    # 4a. Spatial label-value pairing from PDF bounding boxes (highest precision)
    for box in boxes:
        btext_low = box.get("text", "").strip().lower()
        # Clean label check (avoid matching body sentences containing 'ผู้ขาย')
        if len(btext_low) <= 35 and any(lbl == btext_low or btext_low.startswith(lbl) for lbl in SUPPLIER_LABELS):
            adj = _find_right_adjacent_box(box, boxes)
            if adj and not is_ignored_self_company(adj):
                clean_adj = _clean_thai_candidate_tail(adj)
                if clean_adj and not is_ignored_self_company(clean_adj):
                    lang = "th" if re.search(r"[\u0E00-\u0E7F]", clean_adj) else "en"
                    supplier_candidates.append({
                        "name": clean_adj,
                        "confidence": 99.5,
                        "language": lang,
                        "line_index": 0,
                        "source": "spatial_label",
                    })

    # 4b. Thai company patterns (Prefix + optional Suffix)
    thai_with_suffix_re = re.compile(
        r"(" + "|".join(THAI_PREFIXES_ORDERED) + r")\s*([^\n,]{2,60}?\s*(?:จำกัด\s*\(มหาชน\)|มหาชน\s*จำกัด|\(มหาชน\)|จำกัด))",
        re.UNICODE,
    )
    thai_prefix_only_re = re.compile(
        r"(ห้างหุ้นส่วนจำกัด|หจก\.|ห้างหุ้นส่วนสามัญ|หสน\.|บจก\.|บริษัท)\s*([\u0E00-\u0E7FA-Za-z0-9\s.\-&]{2,60})",
        re.UNICODE,
    )

    # 4c. English company patterns (longest suffix first + trailing boundary)
    eng_comp_regex = re.compile(
        r"\b([A-Za-z0-9][A-Za-z0-9&.\-\s]{1,60}?\s*(?:" + "|".join(ENG_SUFFIXES_ORDERED) + r"))(?=\s|$|[,;/)])",
        re.IGNORECASE,
    )

    for idx, line in enumerate(lines):
        # Context check around this line
        prev_line = lines[idx - 1].lower() if idx > 0 else ""
        curr_low = line.lower()
        near_context = " ".join(lines[max(0, idx - 2):min(len(lines), idx + 3)]).lower()

        is_buyer_addressed = any(
            curr_low.startswith(k) or prev_line == k or prev_line.startswith(k + " ")
            for k in BUYER_LABELS
        )

        # Extract Thai candidates
        found_thai_on_line = False
        for pattern_re in (thai_with_suffix_re, thai_prefix_only_re):
            for m in pattern_re.finditer(line):
                raw_cand = m.group(0).strip()
                candidate = _clean_thai_candidate_tail(raw_cand)
                if not candidate or is_ignored_self_company(candidate):
                    continue
                if found_thai_on_line and pattern_re is thai_prefix_only_re:
                    # Avoid duplicate prefix-only slice when full prefix+suffix already matched
                    if any(candidate in existing["name"] for existing in supplier_candidates if existing["line_index"] == idx):
                        continue

                found_thai_on_line = True
                score = 92.0
                if any(k in near_context for k in SUPPLIER_LABELS):
                    score += 6.0
                if is_buyer_addressed:
                    score -= 35.0
                for tid in tax_ids:
                    if any(tid in l.replace("-", "") for l in lines[max(0, idx - 2):min(len(lines), idx + 3)]):
                        score += 6.0
                        break
                if idx < len(lines) * 0.40:
                    score += 4.0

                supplier_candidates.append({
                    "name": candidate,
                    "confidence": round(min(100.0, max(10.0, score)), 1),
                    "language": "th",
                    "line_index": idx,
                    "source": "regex_th",
                })

        # Extract English candidates
        for m in eng_comp_regex.finditer(line):
            candidate = re.sub(r"\s+", " ", m.group(1)).strip(" .,-:/()")
            candidate = re.sub(r"^\d\s+(?=[A-Za-z]{2,})", "", candidate)
            if len(candidate) <= 4 or is_ignored_self_company(candidate):
                continue

            score = 89.0
            if any(k in near_context for k in SUPPLIER_LABELS):
                score += 6.0
            if is_buyer_addressed:
                score -= 35.0
            if idx < len(lines) * 0.40:
                score += 4.0

            supplier_candidates.append({
                "name": candidate,
                "confidence": round(min(100.0, max(10.0, score)), 1),
                "language": "en",
                "line_index": idx,
                "source": "regex_en",
            })

    # Thai-first ordering: language=='th' ALWAYS sorts ahead of 'en', then highest confidence, then earliest line
    supplier_candidates.sort(key=lambda c: (0 if c["language"] == "th" else 1, -c["confidence"], c["line_index"]))

    # Deduplicate while preserving Thai-first & filtering learned negative phrases
    max_y = 842.0
    for b in boxes:
        rect = _box_rect(b)
        if rect and rect[3] > max_y:
            max_y = rect[3]

    seen_names = set()
    unique_candidates: List[Dict[str, Any]] = []
    for c in supplier_candidates:
        if _is_negative_phrase(c["name"], neg_list):
            continue
        if preferred_y_band is not None and boxes:
            for b in boxes:
                if c["name"] in b.get("text", ""):
                    rect = _box_rect(b)
                    if rect:
                        y_norm = rect[1] / max_y
                        if abs(y_norm - float(preferred_y_band)) <= 0.08:
                            c["confidence"] = round(min(100.0, c["confidence"] + 3.5), 1)
                            break
        norm = re.sub(r"\s+", "", c["name"].lower())
        if norm not in seen_names:
            seen_names.add(norm)
            unique_candidates.append(c)

    unique_candidates.sort(key=lambda c: (0 if c["language"] == "th" else 1, -c["confidence"], c["line_index"]))

    primary_th = next((c["name"] for c in unique_candidates if c["language"] == "th"), None)
    primary_en = next((c["name"] for c in unique_candidates if c["language"] == "en"), None)

    return {
        "po_numbers": po_numbers,
        "tax_ids": tax_ids,
        "emails": emails,
        "supplier_candidates": unique_candidates,
        "primary_supplier": unique_candidates[0]["name"] if unique_candidates else None,
        "primary_confidence": unique_candidates[0]["confidence"] if unique_candidates else 0.0,
        "primary_supplier_th": primary_th,
        "primary_supplier_en": primary_en,
    }


_ADDRESS_NOISE_RE = re.compile(
    r"(?i)\b(moo\.?\s*\d+|soi\s+\d+|road|rd\.|rayong|bangkok|chonburi|thailand|t\.|a\.|j\.|tel\.|fax)\b|ตำบล|อำเภอ|จังหวัด|แขวง|เขต|หมู่ที่|ซอย|ถนน|โทร\.?"
)


def _merge_local_vision_into_parsed(parsed: Dict[str, Any], vision: Dict[str, Any], neg_list: List[str]) -> None:
    if not vision or not isinstance(vision, dict):
        return

    cands = parsed.setdefault("supplier_candidates", [])
    for key, lang in (("supplier_th", "th"), ("supplier_en", "en")):
        raw_name = str(vision.get(key) or "").strip()
        if not raw_name or raw_name.lower() in ("none", "null", "n/a", "unknown", "-"):
            continue
        if _ADDRESS_NOISE_RE.search(raw_name) and not any(k in raw_name.lower() for k in ("จำกัด", "co.", "ltd", "partnership", "inc", "corp")):
            continue
        if not is_ignored_self_company(raw_name) and not _is_negative_phrase(raw_name, neg_list):
            detected_lang = "th" if re.search(r"[\u0E00-\u0E7F]", raw_name) else lang
            cands.append({
                "name": repair_thai_encoding(raw_name),
                "confidence": 91.0,
                "language": detected_lang,
                "line_index": 0,
                "source": "local_vision_ai",
            })

    cands.sort(key=lambda c: (0 if c["language"] == "th" else 1, -c["confidence"], c.get("line_index") or 0))
    if cands:
        parsed["primary_supplier"] = cands[0]["name"]
        parsed["primary_confidence"] = cands[0]["confidence"]
        parsed["primary_supplier_th"] = next((c["name"] for c in cands if c["language"] == "th"), parsed.get("primary_supplier_th"))
        parsed["primary_supplier_en"] = next((c["name"] for c in cands if c["language"] == "en"), parsed.get("primary_supplier_en"))

    po_raw = str(vision.get("po_number") or "").strip()
    if po_raw and not _ADDRESS_NOISE_RE.search(po_raw) and po_raw.lower() not in ("none", "null", "-"):
        po_list = parsed.setdefault("po_numbers", [])
        for v in _normalize_po_token(po_raw):
            if v not in po_list:
                po_list.append(v)

    tid_digits = re.sub(r"\D", "", str(vision.get("tax_id") or ""))
    if len(tid_digits) == 13 and tid_digits not in SELF_TAX_IDS:
        tid_list = parsed.setdefault("tax_ids", [])
        if tid_digits not in tid_list:
            tid_list.append(tid_digits)

    v_email = str(vision.get("email") or "").strip().lower()
    if v_email and re.match(r"^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$", v_email) and "qtc-energy" not in v_email:
        em_list = parsed.setdefault("emails", [])
        if v_email not in em_list:
            em_list.append(v_email)


def _page_has_garbled_font(text: str) -> bool:
    if not text:
        return False
    if text.count("·") >= 8 or "\ufffd" in text:
        return True
    pua_count = sum(1 for c in text if 0xF000 <= ord(c) <= 0xF8FF)
    return pua_count >= 4


def process_file_request(request: Dict[str, Any]) -> Dict[str, Any]:
    """Processes a single file (PDF, Image, or DOCX) end-to-end."""
    file_path = request.get("file_path", "")
    if not os.path.exists(file_path):
        return {"status": "error", "message": f"File not found: {file_path}"}

    hints = request.get("hints") or {}
    root_dir = str(hints.get("root_dir") or "")
    ocr_engine_primary = str(hints.get("ocr_engine_primary") or "auto").strip().lower()
    quality_preset = str(hints.get("ocr_quality_preset") or "balanced").strip().lower()
    if quality_preset not in ("fast", "balanced", "max_accuracy"):
        quality_preset = "balanced"
    scan_dpi = 200 if quality_preset == "fast" else (400 if quality_preset == "max_accuracy" else 300)
    neg_phrases = [str(x) for x in (hints.get("negative_phrases") or []) if x]
    pref_y_raw = hints.get("preferred_y_band")
    pref_y = float(pref_y_raw) if pref_y_raw is not None else None
    local_vision_enabled = bool(hints.get("local_vision_enabled", False))
    local_vision_provider = str(hints.get("local_vision_provider") or "builtin")
    local_vision_endpoint = str(hints.get("local_vision_endpoint") or "http://127.0.0.1:11434")
    local_vision_model = str(hints.get("local_vision_model") or "smolvlm2-2.2b")
    builtin_engine_path = str(hints.get("builtin_engine_path") or "")
    builtin_model_path = str(hints.get("builtin_model_path") or "")
    builtin_mmproj_path = str(hints.get("builtin_mmproj_path") or "")
    force_vision = bool(hints.get("force_vision", False))

    ext = os.path.splitext(file_path)[1].lower()
    page_results = []
    overall_text_parts = []
    all_boxes: List[Dict[str, Any]] = []
    first_page_img: Optional[np.ndarray] = None
    vision_ai_status: Optional[str] = None
    vision_ai_error: Optional[str] = None
    vision_ai_duration_ms: Optional[float] = None
    vision_ai_device: Optional[str] = None

    try:
        if ext == ".pdf":
            native_pages = extract_native_pdf_text(file_path)

            for page_info in native_pages:
                page_num = page_info["page_number"]
                raw_text = page_info["raw_text"]
                boxes = page_info["boxes"]
                method = "native_pdf"
                confidence = 1.0

                initial_parsed = parse_supplier_and_po(raw_text, boxes, neg_phrases, pref_y)
                needs_ocr = (
                    (not page_info["has_native_text"])
                    or _page_has_garbled_font(raw_text)
                    or (
                        page_info.get("image_count", 0) > 0
                        and (
                            len(raw_text.strip()) < 250
                            or not initial_parsed.get("supplier_candidates")
                        )
                    )
                )

                if needs_ocr:
                    img = render_pdf_page_to_image(file_path, page_num, dpi=scan_dpi)
                    if page_num == 1:
                        first_page_img = img
                    ocr_lines, ocr_boxes, ocr_conf, ocr_method = _run_image_ocr_cascade(
                        img, root_dir, quality_preset, ocr_engine_primary
                    )
                    if ocr_lines:
                        native_clean = raw_text.strip()
                        ocr_joined = "\n".join(ocr_lines)
                        raw_text = f"{ocr_joined}\n{native_clean}" if native_clean else ocr_joined
                        boxes = ocr_boxes
                        confidence = ocr_conf
                        method = f"native+{ocr_method}" if native_clean else ocr_method

                parsed = parse_supplier_and_po(raw_text, boxes, neg_phrases, pref_y)
                overall_text_parts.append(raw_text)
                if page_num == 1:
                    all_boxes.extend(boxes)

                page_results.append({
                    "page_number": page_num,
                    "raw_text": raw_text,
                    "confidence": float(confidence),
                    "extraction_method": method,
                    "boxes": boxes,
                    "parsed": parsed,
                })

        elif ext in [".jpg", ".jpeg", ".png", ".tiff", ".tif", ".bmp"]:
            img = read_image_unicode(file_path)
            if img is None:
                return {"status": "error", "message": f"Could not read image (or unsupported format): {file_path}"}

            first_page_img = img
            ocr_lines, boxes, confidence, ocr_method = _run_image_ocr_cascade(
                img, root_dir, quality_preset, ocr_engine_primary
            )
            raw_text = "\n".join(ocr_lines)
            parsed = parse_supplier_and_po(raw_text, boxes, neg_phrases, pref_y)
            overall_text_parts.append(raw_text)
            all_boxes.extend(boxes)

            page_results.append({
                "page_number": 1,
                "raw_text": raw_text,
                "confidence": float(confidence),
                "extraction_method": ocr_method,
                "boxes": boxes,
                "parsed": parsed,
            })

        elif ext == ".docx" and docx is not None:
            doc = docx.Document(file_path)
            lines = [repair_thai_encoding(p.text) for p in doc.paragraphs if p.text.strip()]
            for table in doc.tables:
                for row in table.rows:
                    row_text = " | ".join([repair_thai_encoding(cell.text.strip()) for cell in row.cells if cell.text.strip()])
                    if row_text:
                        lines.append(row_text)

            raw_text = "\n".join(lines)
            parsed = parse_supplier_and_po(raw_text, [], neg_phrases, pref_y)
            overall_text_parts.append(raw_text)

            page_results.append({
                "page_number": 1,
                "raw_text": raw_text,
                "confidence": 1.0,
                "extraction_method": "docx_native",
                "boxes": [],
                "parsed": parsed,
            })

        else:
            return {"status": "error", "message": f"Unsupported file extension: {ext}"}

        all_text = "\n".join(overall_text_parts)
        agg_parsed = parse_supplier_and_po(all_text, all_boxes, neg_phrases, pref_y)

        # Optional 100% Offline Local Vision AI fallback / deep scan (Qwen2.5-VL / SmolVLM2 / Typhoon)
        needs_vision_fallback = (
            (local_vision_enabled or force_vision)
            and ext != ".docx"
            and (
                force_vision
                or not agg_parsed.get("supplier_candidates")
                or float(agg_parsed.get("primary_confidence") or 0.0) < 85.0
            )
        )
        if needs_vision_fallback:
            if first_page_img is None and ext == ".pdf":
                try:
                    first_page_img = render_pdf_page_to_image(file_path, 1, dpi=180)
                except Exception:
                    first_page_img = None
            if first_page_img is not None:
                vision_out = query_local_vision_model(
                    first_page_img,
                    local_vision_provider,
                    local_vision_endpoint,
                    local_vision_model,
                    builtin_engine_path,
                    builtin_model_path,
                    builtin_mmproj_path,
                    quality_preset="max_accuracy" if (force_vision or quality_preset == "max_accuracy") else quality_preset,
                )
                vision_ai_status = str(vision_out.get("_vision_status") or "error")
                vision_ai_error = str(vision_out.get("_vision_error") or "") or None
                vision_ai_duration_ms = vision_out.get("_vision_duration_ms")
                vision_ai_device = str(vision_out.get("_vision_device") or "") or None

                if vision_ai_status == "ok":
                    _merge_local_vision_into_parsed(agg_parsed, vision_out, neg_phrases)
                    if page_results:
                        _merge_local_vision_into_parsed(page_results[0]["parsed"], vision_out, neg_phrases)
                        if any(vision_out.get(k) for k in ("supplier_th", "supplier_en", "po_number", "tax_id")):
                            existing_method = str(page_results[0].get("extraction_method") or "")
                            if "vision_ai" not in existing_method:
                                page_results[0]["extraction_method"] = (
                                    f"{existing_method}+vision_ai" if existing_method else "vision_ai"
                                )
                if page_results:
                    page_results[0]["vision_ai_status"] = vision_ai_status
                    page_results[0]["vision_ai_error"] = vision_ai_error
                    page_results[0]["vision_ai_duration_ms"] = vision_ai_duration_ms
                    page_results[0]["vision_ai_device"] = vision_ai_device

        return {
            "status": "ok",
            "file_path": file_path,
            "pages_count": len(page_results),
            "pages": page_results,
            "aggregated": agg_parsed,
            "vision_ai_status": vision_ai_status,
            "vision_ai_error": vision_ai_error,
            "vision_ai_duration_ms": vision_ai_duration_ms,
            "vision_ai_device": vision_ai_device,
        }

    except Exception as e:
        return {
            "status": "error",
            "message": str(e),
            "traceback": traceback.format_exc(),
        }


def render_preview_request(request: Dict[str, Any]) -> Dict[str, Any]:
    """Renders a PDF page or image into a base64 PNG data URL plus coordinate dimensions."""
    file_path = request.get("file_path", "")
    if not file_path or not os.path.exists(file_path):
        return {"status": "error", "message": f"File not found: {file_path}"}

    page_number = int(request.get("page_number", 1) or 1)
    dpi = int(request.get("dpi", 150) or 150)
    dpi = max(72, min(dpi, 300))
    ext = os.path.splitext(file_path)[1].lower()

    try:
        if ext == ".pdf":
            doc = fitz.open(file_path)
            try:
                if len(doc) == 0:
                    return {"status": "error", "message": "PDF contains 0 pages"}
                page_idx = max(0, min(len(doc) - 1, page_number - 1))
                page = doc[page_idx]
                page_width = float(page.rect.width)
                page_height = float(page.rect.height)
                pix = page.get_pixmap(dpi=dpi, alpha=False)
                png_bytes = pix.tobytes("png")
                data_url = "data:image/png;base64," + base64.b64encode(png_bytes).decode("ascii")
                return {
                    "status": "ok",
                    "data_url": data_url,
                    "page_width": page_width,
                    "page_height": page_height,
                    "render_width": int(pix.width),
                    "render_height": int(pix.height),
                }
            finally:
                doc.close()

        elif ext in [".jpg", ".jpeg", ".png", ".tiff", ".tif", ".bmp"]:
            img = read_image_unicode(file_path)
            if img is None:
                return {"status": "error", "message": f"Could not decode image: {file_path}"}
            h, w = img.shape[:2]
            ok, encoded = cv2.imencode(".png", img)
            if not ok:
                return {"status": "error", "message": "Failed to encode PNG preview"}
            data_url = "data:image/png;base64," + base64.b64encode(encoded.tobytes()).decode("ascii")
            return {
                "status": "ok",
                "data_url": data_url,
                "page_width": float(w),
                "page_height": float(h),
                "render_width": int(w),
                "render_height": int(h),
            }

        return {"status": "error", "message": f"Visual preview is not supported for {ext}"}
    except Exception as e:
        return {"status": "error", "message": f"Preview render failed: {str(e)}"}


def get_engine_capabilities(root_dir: str = "") -> Dict[str, Any]:
    """Reports exact installed OCR engines, paths, languages, and active fallback chain."""
    import platform

    tess_exe = _find_tesseract_exe(root_dir)
    tessdata_dir = None
    tess_langs: List[str] = []
    if tess_exe:
        managed_tessdata = os.path.join(_resolve_tess_models_dir(root_dir), "tessdata")
        sibling_tessdata = os.path.join(os.path.dirname(tess_exe), "tessdata")
        for d in (managed_tessdata, sibling_tessdata):
            if os.path.isdir(d):
                found = sorted(
                    os.path.splitext(f)[0]
                    for f in os.listdir(d)
                    if f.endswith(".traineddata") and os.path.getsize(os.path.join(d, f)) > 50_000
                )
                if found:
                    tessdata_dir = d
                    tess_langs = found
                    break

    tess_ok = bool(tess_exe and tessdata_dir)
    openthaigpt_dir = _resolve_openthaigpt_dir(root_dir)
    openthaigpt_backend = _openthaigpt_runtime_backend()
    openthaigpt_ok = bool(openthaigpt_dir and openthaigpt_backend)
    py_ver = (
        f"Bundled ({platform.python_version()})"
        if getattr(sys, "frozen", False)
        else platform.python_version()
    )
    if openthaigpt_ok:
        openthaigpt_note = f"Ready ({openthaigpt_backend}) — Winner for fast Thai & English scans"
    elif openthaigpt_dir and not openthaigpt_backend:
        openthaigpt_note = "Model weights present, needs onnxruntime + pyclipper Python packages."
    else:
        openthaigpt_note = "Not installed yet (4.2 MB lightweight Thai+English neural OCR)."

    winrt_ok = os.name == "nt"
    winrt_thai = _is_winrt_thai_available()
    if openthaigpt_ok:
        active_scanned = "openthaigpt_ocr"
    elif HAS_PADDLEOCR:
        active_scanned = "paddleocr_ppocrv5"
    elif tess_ok:
        active_scanned = "tesseract_tha_eng" if ("tha" in tess_langs and "eng" in tess_langs) else "tesseract"
    elif winrt_ok:
        active_scanned = "windows_winrt_ocr"
    else:
        active_scanned = "none"

    paddle_note = (
        "Installed and active."
        if HAS_PADDLEOCR
        else f"Not installed on Python {py_ver} (optional; OpenThai 2.0 replaces it cleanly)."
    )

    return {
        "python_version": py_ver,
        "pymupdf_available": True,
        "openthaigpt_available": openthaigpt_ok,
        "openthaigpt_path": openthaigpt_dir or "",
        "openthaigpt_backend": openthaigpt_backend or "",
        "openthaigpt_note": openthaigpt_note,
        "paddleocr_available": bool(HAS_PADDLEOCR),
        "paddleocr_note": paddle_note,
        "tesseract_available": tess_ok,
        "tesseract_path": tess_exe or "",
        "tesseract_langs": tess_langs,
        "winrt_available": winrt_ok,
        "winrt_thai_installed": winrt_thai,
        "active_scanned_engine": active_scanned,
    }


def _score_benchmark_fields(parsed: Dict[str, Any]) -> int:
    score = 0
    if parsed.get("primary_supplier_th"):
        score += 3
    if parsed.get("primary_supplier_en"):
        score += 2
    if parsed.get("po_numbers"):
        score += 2
    if parsed.get("tax_ids"):
        score += 2
    if parsed.get("emails"):
        score += 1
    return score


def _run_bench_step(
    layer_id: str,
    name: str,
    category: str,
    fn,
) -> Dict[str, Any]:
    """Executes one benchmark layer safely and collects timing + extracted entity metrics."""
    t0 = time.perf_counter()
    try:
        out = fn()
        dt_ms = round((time.perf_counter() - t0) * 1000.0, 1)
        status = out.get("status", "ok")
        parsed = out.get("parsed") or {}
        raw_text = str(out.get("raw_text") or "")
        return {
            "id": layer_id,
            "name": name,
            "category": category,
            "status": status,
            "note": str(out.get("note") or ""),
            "duration_ms": dt_ms,
            "confidence": round(float(out.get("confidence") or 0.0) * 100.0, 1)
            if float(out.get("confidence") or 0.0) <= 1.05
            else round(float(out.get("confidence") or 0.0), 1),
            "supplier_th": parsed.get("primary_supplier_th"),
            "supplier_en": parsed.get("primary_supplier_en"),
            "po_numbers": parsed.get("po_numbers") or [],
            "tax_ids": parsed.get("tax_ids") or [],
            "emails": parsed.get("emails") or [],
            "field_score": _score_benchmark_fields(parsed) if status == "ok" else 0,
            "chars_count": len(raw_text),
            "raw_preview": raw_text[:800],
        }
    except Exception as e:
        dt_ms = round((time.perf_counter() - t0) * 1000.0, 1)
        return {
            "id": layer_id,
            "name": name,
            "category": category,
            "status": "error",
            "note": str(e),
            "duration_ms": dt_ms,
            "confidence": 0.0,
            "supplier_th": None,
            "supplier_en": None,
            "po_numbers": [],
            "tax_ids": [],
            "emails": [],
            "field_score": 0,
            "chars_count": 0,
            "raw_preview": "",
        }


def benchmark_file_request(request: Dict[str, Any]) -> Dict[str, Any]:
    """Benchmarks every OCR engine & installed Vision AI model independently on page 1 of a file."""
    file_path = request.get("file_path", "")
    if not file_path or not os.path.exists(file_path):
        return {"status": "error", "message": f"File not found: {file_path}"}

    hints = request.get("hints") or {}
    root_dir = str(hints.get("root_dir") or "")
    local_vision_endpoint = str(hints.get("local_vision_endpoint") or "http://127.0.0.1:11434")
    vision_models = hints.get("vision_models") or []
    ext = os.path.splitext(file_path)[1].lower()
    t_total = time.perf_counter()
    results: List[Dict[str, Any]] = []

    img_300: Optional[np.ndarray] = None
    img_400: Optional[np.ndarray] = None

    if ext == ".pdf":
        img_300 = render_pdf_page_to_image(file_path, 1, dpi=300)
        img_400 = render_pdf_page_to_image(file_path, 1, dpi=400)

        def bench_native():
            pages = extract_native_pdf_text(file_path)
            if not pages:
                return {"status": "skipped", "note": "Empty PDF"}
            p0 = pages[0]
            txt = p0.get("raw_text", "")
            boxes = p0.get("boxes", [])
            parsed = parse_supplier_and_po(txt, boxes)
            garbled = _page_has_garbled_font(txt)
            if garbled:
                note = "Embedded font has garbled/missing Thai Unicode glyphs; live pipeline automatically runs OpenThai 2.0 alongside it."
            elif p0.get("image_count", 0) > 0 and len(txt.strip()) < 250:
                note = f"{p0.get('image_count', 0)} embedded image(s) detected; scarce text triggers OpenThai 2.0 OCR in live pipeline."
            else:
                note = "Direct embedded PDF text extraction (no image rendering needed; includes legacy Thai glyph cleanup)."
            return {
                "status": "ok",
                "raw_text": txt,
                "confidence": 1.0 if (len(txt.strip()) > 30 and not garbled) else (0.45 if garbled else 0.0),
                "parsed": parsed,
                "note": note,
            }

        results.append(_run_bench_step("native_pdf", "Built-in Digital PDF Reader", "Digital PDF", bench_native))
    elif ext in (".jpg", ".jpeg", ".png", ".tiff", ".tif", ".bmp"):
        img_300 = read_image_unicode(file_path)
        img_400 = img_300
        results.append({
            "id": "native_pdf",
            "name": "Built-in Digital PDF Reader",
            "category": "Digital PDF",
            "status": "skipped",
            "note": f"Not applicable to image file ({ext}) — images use OpenThai 2.0 OCR.",
            "duration_ms": 0.0,
            "confidence": 0.0,
            "supplier_th": None,
            "supplier_en": None,
            "po_numbers": [],
            "tax_ids": [],
            "emails": [],
            "field_score": 0,
            "chars_count": 0,
            "raw_preview": "",
        })
    else:
        return {"status": "error", "message": f"Unsupported file extension for benchmark: {ext}"}

    if img_300 is None:
        return {"status": "error", "message": f"Failed to decode page image from: {file_path}"}

    # 1b. OpenThai 2.0 OCR-Text (Standard Balanced)
    def bench_openthaigpt_strict():
        ot_dir = _resolve_openthaigpt_dir(root_dir)
        backend = _openthaigpt_runtime_backend()
        if not ot_dir:
            return {"status": "skipped", "note": "OpenThai 2.0 model not downloaded yet (click 'Install OpenThai 2.0' in Settings)."}
        if not backend:
            return {"status": "skipped", "note": "Missing Python runtime (install onnxruntime + pyclipper)."}
        lines, boxes, conf = run_openthaigpt_ocr(img_300, root_dir, relaxed=False)
        raw = "\n".join(lines)
        return {
            "status": "ok" if lines else "error",
            "raw_text": raw,
            "confidence": conf,
            "parsed": parse_supplier_and_po(raw, boxes),
            "note": f"{len(lines)} lines via OpenThai 2.0 ({backend}) • Recommended #1 for Thai+English scans",
        }

    results.append(_run_bench_step("openthaigpt_strict", "OpenThai 2.0 OCR-Text (Winner — Balanced)", "Scanned OCR", bench_openthaigpt_strict))

    # 1c. OpenThai 2.0 OCR-Text (Faint-Scan Boost)
    def bench_openthaigpt_relaxed():
        ot_dir = _resolve_openthaigpt_dir(root_dir)
        backend = _openthaigpt_runtime_backend()
        if not ot_dir or not backend:
            return {"status": "skipped", "note": "Requires OpenThai 2.0 model + onnxruntime/openvino."}
        lines, boxes, conf = run_openthaigpt_ocr(img_300, root_dir, relaxed=True)
        raw = "\n".join(lines)
        return {
            "status": "ok" if lines else "error",
            "raw_text": raw,
            "confidence": conf,
            "parsed": parse_supplier_and_po(raw, boxes),
            "note": f"{len(lines)} lines with relaxed confidence threshold for faint/blurry scans",
        }

    results.append(_run_bench_step("openthaigpt_relaxed", "OpenThai 2.0 OCR-Text (Faint-Scan Boost)", "Scanned OCR", bench_openthaigpt_relaxed))

    # 2. PaddleOCR PP-OCRv5
    def bench_paddle():
        if not HAS_PADDLEOCR:
            import platform
            return {
                "status": "skipped",
                "note": f"Not installed on Python {platform.python_version()} (OpenThai 2.0 replaces it at 4.2 MB).",
            }
        eng = get_paddle_ocr()
        if eng is None:
            return {"status": "skipped", "note": "PaddleOCR failed to initialize."}
        enh = Preprocessor.deskew_and_enhance(img_300)
        res = eng.ocr(enh, cls=True)
        lines, boxes, tot = [], [], 0.0
        if res and res[0]:
            for bbox, (txt, conf) in res[0]:
                rep = repair_thai_encoding(txt)
                lines.append(rep)
                tot += conf
                boxes.append({"box": bbox, "text": rep, "confidence": float(conf), "type": "ocr"})
        raw = "\n".join(lines)
        return {
            "status": "ok",
            "raw_text": raw,
            "confidence": (tot / len(lines)) if lines else 0.0,
            "parsed": parse_supplier_and_po(raw, boxes),
            "note": f"{len(lines)} text lines read",
        }

    results.append(_run_bench_step("paddleocr", "PaddleOCR PP-OCRv5 (Legacy)", "Scanned OCR", bench_paddle))

    # 3. Tesseract 5 Raw 300 DPI
    def bench_tess_raw():
        tess_exe = _find_tesseract_exe(root_dir)
        if not tess_exe:
            return {"status": "skipped", "note": "tesseract.exe not found on PC."}
        lines, boxes, conf = run_tesseract_ocr(img_300, root_dir)
        raw = "\n".join(lines)
        return {
            "status": "ok" if lines else "error",
            "raw_text": raw,
            "confidence": conf,
            "parsed": parse_supplier_and_po(raw, boxes),
            "note": f"{len(lines)} lines at 300 DPI raw ({os.path.basename(tess_exe)})",
        }

    results.append(_run_bench_step("tesseract_300", "Tesseract 5 (tha+eng • 300 DPI Raw)", "Scanned OCR", bench_tess_raw))

    # 4. Tesseract 5 Enhanced 400 DPI
    def bench_tess_enh():
        tess_exe = _find_tesseract_exe(root_dir)
        if not tess_exe:
            return {"status": "skipped", "note": "tesseract.exe not found on PC."}
        enh = Preprocessor.deskew_and_enhance(img_400 if img_400 is not None else img_300)
        lines, boxes, conf = run_tesseract_ocr(enh, root_dir)
        raw = "\n".join(lines)
        return {
            "status": "ok" if lines else "error",
            "raw_text": raw,
            "confidence": conf,
            "parsed": parse_supplier_and_po(raw, boxes),
            "note": f"{len(lines)} lines at 400 DPI + CLAHE/Deskew",
        }

    results.append(_run_bench_step("tesseract_400_enh", "Tesseract 5 (tha+eng • 400 DPI Enhanced)", "Scanned OCR", bench_tess_enh))

    # 5. EasyOCR (if installed in Python env)
    def bench_easyocr():
        if importlib.util.find_spec("easyocr") is None:
            return {"status": "skipped", "note": "Not installed (requires ~2.5 GB PyTorch; slower and heavier than OpenThai 2.0)."}
        import easyocr
        reader = easyocr.Reader(["th", "en"], gpu=False, verbose=False)
        res = reader.readtext(img_300)
        lines, boxes, tot = [], [], 0.0
        for bbox, txt, conf in res:
            rep = repair_thai_encoding(str(txt))
            lines.append(rep)
            tot += float(conf)
            boxes.append({"box": bbox, "text": rep, "confidence": float(conf), "type": "ocr"})
        raw = "\n".join(lines)
        return {
            "status": "ok",
            "raw_text": raw,
            "confidence": (tot / len(lines)) if lines else 0.0,
            "parsed": parse_supplier_and_po(raw, boxes),
            "note": f"{len(lines)} EasyOCR spans",
        }

    results.append(_run_bench_step("easyocr", "EasyOCR (th+en PyTorch)", "Scanned OCR", bench_easyocr))

    # 6. Windows Built-In WinRT OCR
    def bench_winrt():
        if os.name != "nt":
            return {"status": "skipped", "note": "Windows-only API."}
        has_thai = _is_winrt_thai_available()
        lines, boxes, conf = run_windows_winrt_ocr(img_300)
        raw = "\n".join(lines)
        lang_note = (
            f"{len(lines)} lines via Windows.Media.Ocr (Thai + English pack active)"
            if has_thai
            else f"{len(lines)} lines via Windows.Media.Ocr — WARNING: Windows Thai OCR pack not installed on this PC (Thai reads as garbled Latin)"
        )
        return {
            "status": "ok" if lines else "error",
            "raw_text": raw,
            "confidence": conf if has_thai else min(conf, 0.45),
            "parsed": parse_supplier_and_po(raw, boxes),
            "note": lang_note,
        }

    results.append(_run_bench_step("windows_winrt", "Windows Built-In WinRT OCR", "Scanned OCR", bench_winrt))

    # 7. Built-In GGUF Vision AI Models (discovers all presets)
    for vm in vision_models:
        vm_id = str(vm.get("id") or "")
        vm_name = str(vm.get("name") or vm_id)

        def bench_builtin_vlm(m_info=vm):
            if not m_info.get("installed"):
                return {"status": "skipped", "note": "Not downloaded in Models\\ folder."}
            v_out = query_local_vision_model(
                img_300,
                "builtin",
                "",
                str(m_info.get("id") or ""),
                str(m_info.get("engine_path") or ""),
                str(m_info.get("model_path") or ""),
                str(m_info.get("mmproj_path") or ""),
                quality_preset="max_accuracy",
            )
            if v_out.get("_vision_status") != "ok":
                return {
                    "status": "error",
                    "note": str(v_out.get("_vision_error") or "Built-in Vision engine failed."),
                }
            pseudo_parsed = {
                "po_numbers": [],
                "tax_ids": [],
                "emails": [],
                "supplier_candidates": [],
                "primary_supplier": None,
                "primary_confidence": 0.0,
                "primary_supplier_th": None,
                "primary_supplier_en": None,
            }
            _merge_local_vision_into_parsed(pseudo_parsed, v_out, [])
            clean_json = {k: v for k, v in v_out.items() if not k.startswith("_vision_")}
            dev = str(v_out.get("_vision_device") or "Local")
            return {
                "status": "ok",
                "raw_text": json.dumps(clean_json, ensure_ascii=False, indent=2),
                "confidence": 0.91 if (pseudo_parsed.get("primary_supplier_th") or pseudo_parsed.get("primary_supplier_en")) else 0.55,
                "parsed": pseudo_parsed,
                "note": f"On-device GGUF VLM ({m_info.get('size_label', '')}) running on {dev}",
            }

        results.append(
            _run_bench_step(
                f"builtin_{vm_id}",
                f"Built-In Vision AI: {vm_name}",
                "Vision AI (VLM)",
                bench_builtin_vlm,
            )
        )

    # 8. External Local Ollama Models if running on 127.0.0.1 (e.g., Typhoon OCR, OpenThaiGPT)
    ollama_models: List[str] = []
    if is_strictly_localhost(local_vision_endpoint):
        try:
            tags_url = local_vision_endpoint.rstrip("/") + "/api/tags"
            with urllib.request.urlopen(urllib.request.Request(tags_url, method="GET"), timeout=2) as resp:
                data = json.loads(resp.read().decode("utf-8", errors="ignore"))
                ollama_models = [m.get("name", "") for m in data.get("models", []) if m.get("name")][:3]
        except Exception:
            ollama_models = []

    if ollama_models:
        for om in ollama_models:
            def bench_ollama(model_name=om):
                v_out = query_local_vision_model(img_300, "ollama", local_vision_endpoint, model_name)
                if v_out.get("_vision_status") != "ok":
                    return {"status": "error", "note": str(v_out.get("_vision_error") or "Ollama model returned empty/non-JSON response.")}
                pseudo_parsed = {
                    "po_numbers": [],
                    "tax_ids": [],
                    "emails": [],
                    "supplier_candidates": [],
                    "primary_supplier": None,
                    "primary_confidence": 0.0,
                    "primary_supplier_th": None,
                    "primary_supplier_en": None,
                }
                _merge_local_vision_into_parsed(pseudo_parsed, v_out, [])
                clean_json = {k: v for k, v in v_out.items() if not k.startswith("_vision_")}
                return {
                    "status": "ok",
                    "raw_text": json.dumps(clean_json, ensure_ascii=False, indent=2),
                    "confidence": 0.90,
                    "parsed": pseudo_parsed,
                    "note": "External Ollama localhost model",
                }

            results.append(
                _run_bench_step(
                    f"ollama_{om}",
                    f"Ollama Local VLM: {om}",
                    "Vision AI (VLM)",
                    bench_ollama,
                )
            )
    else:
        results.append({
            "id": "ollama_external",
            "name": "External Ollama VLM (Typhoon OCR / OpenThai 2.0)",
            "category": "Vision AI (VLM)",
            "status": "skipped",
            "note": f"Ollama server not running at {local_vision_endpoint} (optional 3rd-party VLM host).",
            "duration_ms": 0.0,
            "confidence": 0.0,
            "supplier_th": None,
            "supplier_en": None,
            "po_numbers": [],
            "tax_ids": [],
            "emails": [],
            "field_score": 0,
            "chars_count": 0,
            "raw_preview": "",
        })

    ok_layers = [r for r in results if r["status"] == "ok" and r["field_score"] > 0]
    fastest_usable = min(ok_layers, key=lambda r: r["duration_ms"]) if ok_layers else None
    best_accuracy = (
        max(ok_layers, key=lambda r: (r["field_score"], r["confidence"], -r["duration_ms"]))
        if ok_layers
        else None
    )

    return {
        "status": "ok",
        "file_path": file_path,
        "total_duration_ms": round((time.perf_counter() - t_total) * 1000.0, 1),
        "fastest_layer": fastest_usable["name"] if fastest_usable else None,
        "best_accuracy_layer": best_accuracy["name"] if best_accuracy else None,
        "layers": results,
    }


def main():
    """Main JSON-lines IPC protocol loop on stdin / stdout."""
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")

    caps = get_engine_capabilities()
    sys.stdout.write(json.dumps({
        "event": "ready",
        "paddleocr": HAS_PADDLEOCR,
        "google_vision": HAS_GOOGLE_VISION,
        "rapidfuzz": HAS_RAPIDFUZZ,
        "capabilities": caps,
    }) + "\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            req = json.loads(line)
            cmd = req.get("command", "")

            if cmd == "ping":
                ping_caps = get_engine_capabilities(str(req.get("root_dir") or ""))
                resp = {
                    "status": "ok",
                    "message": "pong",
                    "paddleocr": HAS_PADDLEOCR,
                    "capabilities": ping_caps,
                }
            elif cmd == "process_file":
                resp = process_file_request(req)
            elif cmd == "benchmark_file":
                resp = benchmark_file_request(req)
            elif cmd == "render_preview":
                resp = render_preview_request(req)
            elif cmd == "test_local_vision":
                resp = test_local_vision_request(req)
            elif cmd == "shutdown":
                sys.stdout.write(json.dumps({"status": "ok", "message": "shutting down"}) + "\n")
                sys.stdout.flush()
                break
            else:
                resp = {"status": "error", "message": f"Unknown command: {cmd}"}

            sys.stdout.write(json.dumps(resp) + "\n")
            sys.stdout.flush()

        except Exception as e:
            sys.stdout.write(json.dumps({
                "status": "error",
                "message": f"IPC error: {str(e)}",
                "traceback": traceback.format_exc(),
            }) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
