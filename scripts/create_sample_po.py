import os
import fitz  # PyMuPDF
from PIL import Image, ImageDraw, ImageFont

def create_sample_dataset():
    target_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "sample_data", "PO-26002323")
    nested_dir = os.path.join(target_dir, "Additional-Documents")
    os.makedirs(nested_dir, exist_ok=True)

    print(f"Generating synthetic PO dataset in: {target_dir}")

    # 1. PO-Invoice.pdf
    doc1 = fitz.open()
    page1 = doc1.new_page(width=595, height=842) # A4
    page1.insert_text(
        fitz.Point(50, 60),
        "PURCHASE ORDER & TAX INVOICE",
        fontsize=16
    )
    page1.insert_text(
        fitz.Point(50, 90),
        "Supplier / ผู้ขาย:\n"
        "บริษัท สยาม ซัพพลาย อินดัสทรี จำกัด\n"
        "SIAM SUPPLY INDUSTRY CO., LTD.\n"
        "เลขประจำตัวผู้เสียภาษีอากร (Tax ID): 0105558012345\n"
        "123/45 ถนนสีลม แขวงสุริยว่องศ์ เขตบางรัก กรุงเทพมหานคร 10500\n"
        "Email: supplier-orders@siamsupply.co.th\n"
        "Tel: 02-987-6543",
        fontsize=11
    )
    page1.insert_text(
        fitz.Point(340, 90),
        "Buyer / ผู้สั่งซื้อ:\n"
        "บริษัท พีโอ โฟลว์ เซ็นเตอร์ จำกัด\n"
        "PO FLOW CENTER CO., LTD.\n"
        "Tax ID: 0105562098765\n"
        "PO Number: PO-26002323\n"
        "Date: 2026-11-12",
        fontsize=11
    )
    page1.insert_text(
        fitz.Point(50, 220),
        "Item 1: Industrial Fasteners M8 x 50mm - Qty: 5,000 pcs - Price: 15,000.00 THB\n"
        "Item 2: Heavy Duty Brackets Type-B - Qty: 1,200 pcs - Price: 42,000.00 THB\n"
        "Subtotal: 57,000.00 THB\n"
        "VAT (7%): 3,990.00 THB\n"
        "Total: 60,990.00 THB",
        fontsize=11
    )
    doc1.save(os.path.join(target_dir, "PO-Invoice.pdf"))
    doc1.close()

    # 2. Invoice.jpg (Rendered scanned document image)
    img = Image.new("RGB", (1200, 1600), color=(255, 255, 255))
    draw = ImageDraw.Draw(img)
    draw.rectangle([(40, 40), (1160, 1560)], outline=(180, 180, 180), width=2)
    draw.text((60, 60), "COMMERCIAL INVOICE - COPY", fill=(0, 0, 0))
    draw.text((60, 100), "VENDOR: SIAM SUPPLY INDUSTRY CO., LTD. (บริษัท สยาม ซัพพลาย อินดัสทรี จำกัด)", fill=(0, 0, 0))
    draw.text((60, 140), "TAX ID: 0105558012345", fill=(0, 0, 0))
    draw.text((60, 180), "PURCHASE ORDER REF: PO-26002323", fill=(0, 0, 0))
    draw.text((60, 240), "DESCRIPTION OF GOODS: FASTENERS AND HARDWARE SUPPLIES", fill=(0, 0, 0))
    draw.text((60, 280), "STATUS: APPROVED FOR SHIPMENT", fill=(0, 128, 0))
    img.save(os.path.join(target_dir, "Invoice.jpg"), quality=95)

    # 3. Supporting-Document.pdf
    doc2 = fitz.open()
    page2 = doc2.new_page(width=595, height=842)
    page2.insert_text(
        fitz.Point(50, 60),
        "SUPPORTING SPECIFICATION & COMPLIANCE SHEET",
        fontsize=14
    )
    page2.insert_text(
        fitz.Point(50, 100),
        "Reference PO: PO-26002323\n"
        "Supplier: SIAM SUPPLY INDUSTRY CO., LTD.\n"
        "ISO 9001:2015 Certified Quality Verification\n"
        "Warranty Period: 24 Months\n"
        "Special instructions: Protect from humidity during transit.",
        fontsize=11
    )
    doc2.save(os.path.join(target_dir, "Supporting-Document.pdf"))
    doc2.close()

    # 4. Additional-Documents/Document1.jpg
    img2 = Image.new("RGB", (1000, 1000), color=(250, 250, 250))
    draw2 = ImageDraw.Draw(img2)
    draw2.rectangle([(30, 30), (970, 970)], outline=(120, 120, 120), width=3)
    draw2.text((60, 60), "QUALITY CONTROL PACKING INSPECTION", fill=(0, 0, 0))
    draw2.text((60, 120), "PO Number: PO-26002323", fill=(0, 0, 0))
    draw2.text((60, 160), "Issuer: SIAM SUPPLY INDUSTRY CO., LTD.", fill=(0, 0, 0))
    draw2.text((60, 200), "Inspector: QC Team A - Pass", fill=(0, 100, 0))
    img2.save(os.path.join(nested_dir, "Document1.jpg"), quality=90)

    # 5. Additional-Documents/Document2.pdf
    doc3 = fitz.open()
    page3 = doc3.new_page(width=595, height=842)
    page3.insert_text(
        fitz.Point(50, 60),
        "DELIVERY ADVICE / PACKING SLIP",
        fontsize=14
    )
    page3.insert_text(
        fitz.Point(50, 100),
        "PO: PO-26002323\n"
        "Shipper: บริษัท สยาม ซัพพลาย อินดัสทรี จำกัด\n"
        "Consignee: Bangkok Logistics Hub\n"
        "Gross Weight: 340.5 kg\n"
        "Net Weight: 320.0 kg\n"
        "Pallets: 2 wooden pallets heat treated (ISPM 15)",
        fontsize=11
    )
    doc3.save(os.path.join(nested_dir, "Document2.pdf"))
    doc3.close()

    print("Successfully generated all 5 synthetic sample files across nested folders!")

if __name__ == "__main__":
    create_sample_dataset()

