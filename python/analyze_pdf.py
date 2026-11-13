#!/usr/bin/env python3
"""
ReportGen.Pdf — Deterministic PyMuPDF (fitz) + Pillow PDF Extractor
Extracts page dimensions, text blocks, spans, bounding boxes, fonts, colors,
images, and vector drawings into the Intermediate Layout JSON format.
"""
import json
import sys
from pathlib import Path

try:
    import fitz  # PyMuPDF
except ImportError:
    print(json.dumps({
        "error": "PDF_ANALYSIS_FAILED",
        "message": "PyMuPDF (fitz) is not installed. Run: pip install pymupdf pillow openpyxl"
    }))
    sys.exit(2)

PT_PER_INCH = 72.0


def rgb_int_to_hex(color_int: int) -> str:
    r = (color_int >> 16) & 0xFF
    g = (color_int >> 8) & 0xFF
    b = color_int & 0xFF
    return f"#{r:02X}{g:02X}{b:02X}"


def analyze_pdf(pdf_path: str) -> dict:
    doc = fitz.open(pdf_path)
    pages = []
    region_seq = 1

    for page_idx in range(len(doc)):
        page = doc[page_idx]
        rect = page.rect
        width_in = round(rect.width / PT_PER_INCH, 3)
        height_in = round(rect.height / PT_PER_INCH, 3)
        regions = []

        # Text blocks & spans
        text_dict = page.get_text("dict")
        for b_idx, block in enumerate(text_dict.get("blocks", [])):
            if block.get("type") == 0:
                for l_idx, line in enumerate(block.get("lines", [])):
                    for s_idx, span in enumerate(line.get("spans", [])):
                        txt = span.get("text", "").strip()
                        if not txt:
                            continue
                        x0, y0, x1, y1 = span["bbox"]
                        flags = span.get("flags", 0)
                        regions.append({
                            "id": f"region-{region_seq:04d}",
                            "pageNumber": page_idx + 1,
                            "type": "text",
                            "x": round(x0 / PT_PER_INCH, 3),
                            "y": round(y0 / PT_PER_INCH, 3),
                            "width": round(max(0.05, (x1 - x0) / PT_PER_INCH), 3),
                            "height": round(max(0.10, (y1 - y0) / PT_PER_INCH), 3),
                            "text": txt,
                            "style": {
                                "fontFamily": span.get("font", "Arial"),
                                "fontSizePt": round(span.get("size", 10.0), 1),
                                "bold": bool(flags & 16),
                                "italic": bool(flags & 2),
                                "color": rgb_int_to_hex(span.get("color", 0)),
                            },
                            "sourceObjectRefs": [f"p{page_idx+1}-b{b_idx}-l{l_idx}-s{s_idx}"],
                        })
                        region_seq += 1

        # Vector drawings
        for d_idx, drawing in enumerate(page.get_drawings()):
            d_rect = drawing.get("rect")
            if not d_rect:
                continue
            regions.append({
                "id": f"region-{region_seq:04d}",
                "pageNumber": page_idx + 1,
                "type": "vector_rect",
                "x": round(d_rect.x0 / PT_PER_INCH, 3),
                "y": round(d_rect.y0 / PT_PER_INCH, 3),
                "width": round(max(0.02, d_rect.width / PT_PER_INCH), 3),
                "height": round(max(0.02, d_rect.height / PT_PER_INCH), 3),
                "sourceObjectRefs": [f"p{page_idx+1}-draw-{d_idx}"],
            })
            region_seq += 1

        pages.append({
            "pageNumber": page_idx + 1,
            "width": width_in,
            "height": height_in,
            "regions": regions,
        })

    return {
        "document": {
            "name": Path(pdf_path).stem,
            "pageCount": len(pages),
            "pageWidth": pages[0]["width"] if pages else 8.5,
            "pageHeight": pages[0]["height"] if pages else 11.0,
            "unit": "inch",
        },
        "pages": pages,
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: analyze_pdf.py <input.pdf>", file=sys.stderr)
        sys.exit(1)
    result = analyze_pdf(sys.argv[1])
    print(json.dumps(result, indent=2))
