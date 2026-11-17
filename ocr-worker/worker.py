#!/usr/bin/env python3
"""
PO AutoFlow Enterprise - Managed Python OCR & Document Processing Sidecar
PP-OCRv5 Thai & English Recognition | PyMuPDF Native Extraction + AX2012 Tahoma Repair | OpenCV Preprocessing
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


def _prepare_vision_crop(img_np: np.ndarray, max_width: int = 960) -> np.ndarray:
    """Focuses VLM input on the header band of portrait pages and caps width for fast inference."""
    h, w = img_np.shape[:2]
    vision_img = img_np
    if h > int(w * 1.05):
        crop_h = max(1, int(h * 0.55))
        vision_img = img_np[:crop_h, :]
    vh, vw = vision_img.shape[:2]
    if vw > max_width:
        scale = float(max_width) / float(vw)
        vision_img = cv2.resize(vision_img, (max_width, max(1, int(vh * scale))), interpolation=cv2.INTER_AREA)
    return vision_img


def query_local_vision_model(
    img_np: np.ndarray,
    provider: str,
    endpoint: str,
    model: str,
    engine_path: str = "",
    model_path: str = "",
    mmproj_path: str = "",
) -> Dict[str, Any]:
    """Queries 100% offline on-device Vision AI (Built-in llama-mtmd-cli, Ollama, or Python transformers)."""
    prompt = (
        "Analyze this Purchase Order or Tax Invoice image. "
        "Note: QTC ENERGY PUBLIC COMPANY LIMITED is the BUYER, so ignore QTC completely. "
        "Extract ONLY the EXTERNAL SUPPLIER / VENDOR details as JSON with these exact keys: "
        '{"supplier_th": "", "supplier_en": "", "po_number": "", "tax_id": "", "email": ""}. '
        "Return ONLY valid JSON."
    )

    try:
        prov_low = (provider or "builtin").strip().lower()
        if prov_low == "builtin":
            if not (
                engine_path
                and model_path
                and mmproj_path
                and os.path.exists(engine_path)
                and os.path.exists(model_path)
                and os.path.exists(mmproj_path)
            ):
                return {}

            vision_img = _prepare_vision_crop(img_np, max_width=960)
            ok, buf = cv2.imencode(".png", vision_img)
            if not ok:
                return {}

            tmp_png = ""
            try:
                with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tf:
                    tf.write(buf.tobytes())
                    tmp_png = tf.name

                cmd = [
                    engine_path,
                    "-m",
                    model_path,
                    "--mmproj",
                    mmproj_path,
                    "--image",
                    tmp_png,
                    "-p",
                    prompt,
                    "-n",
                    "200",
                    "--temp",
                    "0.1",
                    "--repeat-penalty",
                    "1.3",
                    "--no-warmup",
                ]
                kwargs: Dict[str, Any] = {
                    "capture_output": True,
                    "text": True,
                    "encoding": "utf-8",
                    "errors": "ignore",
                    "timeout": 60,
                    "cwd": os.path.dirname(engine_path),
                }
                if os.name == "nt":
                    kwargs["creationflags"] = 0x08000000

                proc = subprocess.run(cmd, **kwargs)
                return _extract_json_object(proc.stdout)
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
                return {}
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
            return _extract_json_object(decoded)

        # Default: local Ollama HTTP server locked strictly to 127.0.0.1 / localhost
        if not is_strictly_localhost(endpoint):
            sys.stderr.write(f"Blocked non-localhost vision endpoint: {endpoint}\n")
            return {}

        ok, buf = cv2.imencode(".png", img_np)
        if not ok:
            return {}
        b64_img = base64.b64encode(buf.tobytes()).decode("ascii")
        url = endpoint.rstrip("/") + "/api/generate"
        body = json.dumps({
            "model": (model or "hf.co/ggml-org/SmolVLM2-2.2B-Instruct-GGUF").strip(),
            "prompt": prompt,
            "images": [b64_img],
            "stream": False,
            "format": "json",
            "options": {"temperature": 0.1},
        }).encode("utf-8")

        req = urllib.request.Request(
            url,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=25) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="ignore"))
            return _extract_json_object(data.get("response", ""))
    except Exception as e:
        sys.stderr.write(f"Local vision fallback skipped: {e}\n")
        return {}


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


def _run_image_ocr_cascade(img_np: np.ndarray, root_dir: str = "") -> tuple:
    """Runs available on-device OCR engines (PaddleOCR -> Tesseract tha+eng -> Windows WinRT OCR)."""
    enhanced_img: Optional[np.ndarray] = None

    ocr_engine = get_paddle_ocr()
    if ocr_engine is not None:
        try:
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

    tess_lines, tess_boxes, tess_conf = run_tesseract_ocr(img_np, root_dir)
    if not tess_lines:
        if enhanced_img is None:
            enhanced_img = Preprocessor.deskew_and_enhance(img_np)
        tess_lines, tess_boxes, tess_conf = run_tesseract_ocr(enhanced_img, root_dir)
    if tess_lines:
        return tess_lines, tess_boxes, tess_conf, "tesseract_tha_eng"

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


def _merge_local_vision_into_parsed(parsed: Dict[str, Any], vision: Dict[str, Any], neg_list: List[str]) -> None:
    if not vision or not isinstance(vision, dict):
        return

    cands = parsed.setdefault("supplier_candidates", [])
    for key, lang in (("supplier_th", "th"), ("supplier_en", "en")):
        raw_name = str(vision.get(key) or "").strip()
        if raw_name and not is_ignored_self_company(raw_name) and not _is_negative_phrase(raw_name, neg_list):
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
    if po_raw:
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


def process_file_request(request: Dict[str, Any]) -> Dict[str, Any]:
    """Processes a single file (PDF, Image, or DOCX) end-to-end."""
    file_path = request.get("file_path", "")
    if not os.path.exists(file_path):
        return {"status": "error", "message": f"File not found: {file_path}"}

    hints = request.get("hints") or {}
    root_dir = str(hints.get("root_dir") or "")
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
                needs_ocr = (not page_info["has_native_text"]) or (
                    page_info.get("image_count", 0) > 0
                    and (
                        len(raw_text.strip()) < 250
                        or not initial_parsed.get("supplier_candidates")
                    )
                )

                if needs_ocr:
                    img = render_pdf_page_to_image(file_path, page_num, dpi=300)
                    if page_num == 1:
                        first_page_img = img
                    ocr_lines, ocr_boxes, ocr_conf, ocr_method = _run_image_ocr_cascade(img, root_dir)
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
            ocr_lines, boxes, confidence, ocr_method = _run_image_ocr_cascade(img, root_dir)
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

        # Optional 100% Offline Local Vision AI fallback / deep scan (SmolVLM2 / Qwen2.5-VL)
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
                    first_page_img = render_pdf_page_to_image(file_path, 1, dpi=150)
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
                )
                if vision_out:
                    _merge_local_vision_into_parsed(agg_parsed, vision_out, neg_phrases)
                    if page_results:
                        _merge_local_vision_into_parsed(page_results[0]["parsed"], vision_out, neg_phrases)
                        if any(vision_out.get(k) for k in ("supplier_th", "supplier_en", "po_number", "tax_id")):
                            existing_method = str(page_results[0].get("extraction_method") or "")
                            if "vision_ai" not in existing_method:
                                page_results[0]["extraction_method"] = (
                                    f"{existing_method}+vision_ai" if existing_method else "vision_ai"
                                )

        return {
            "status": "ok",
            "file_path": file_path,
            "pages_count": len(page_results),
            "pages": page_results,
            "aggregated": agg_parsed,
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
    winrt_ok = os.name == "nt"
    if HAS_PADDLEOCR:
        active_scanned = "paddleocr_ppocrv5"
    elif tess_ok:
        active_scanned = "tesseract_tha_eng" if ("tha" in tess_langs and "eng" in tess_langs) else "tesseract"
    elif winrt_ok:
        active_scanned = "windows_winrt_ocr"
    else:
        active_scanned = "none"

    py_ver = platform.python_version()
    paddle_note = (
        "Installed and active."
        if HAS_PADDLEOCR
        else f"Not installed on Python {py_ver} (requires Python 3.11/3.12 with paddlepaddle)."
    )

    return {
        "python_version": py_ver,
        "pymupdf_available": True,
        "paddleocr_available": bool(HAS_PADDLEOCR),
        "paddleocr_note": paddle_note,
        "tesseract_available": tess_ok,
        "tesseract_path": tess_exe or "",
        "tesseract_langs": tess_langs,
        "winrt_available": winrt_ok,
        "active_scanned_engine": active_scanned,
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
