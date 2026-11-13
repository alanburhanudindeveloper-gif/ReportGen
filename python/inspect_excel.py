#!/usr/bin/env python3
"""
ReportGen.Excel — Deterministic openpyxl Finance Oracle Reader
Identifies scenarios, input columns, expected output columns, and tolerances.
Flags ambiguous structures instead of guessing.
"""
import json
import re
import sys

try:
    import openpyxl
except ImportError:
    print(json.dumps({
        "error": "EXCEL_READ_FAILED",
        "message": "openpyxl is not installed. Run: pip install openpyxl"
    }))
    sys.exit(2)


def read_excel_oracle(xlsx_path: str) -> dict:
    wb = openpyxl.load_workbook(xlsx_path, data_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    if len(rows) < 2:
        return {"sheetName": ws.title, "testCases": [], "ambiguousWarnings": ["Worksheet has insufficient rows."]}

    headers = [str(h).strip() if h is not None else "" for h in rows[0]]
    scenario_idx = next((i for i, h in enumerate(headers) if re.search(r"scenario|case|test|name", h, re.I)), None)
    expected_idxs = [i for i, h in enumerate(headers) if re.search(r"expected|target|result|output|total", h, re.I)]
    tol_idx = next((i for i, h in enumerate(headers) if re.search(r"tolerance|eps", h, re.I)), None)

    warnings = []
    if not expected_idxs:
        warnings.append(f"Ambiguous Excel structure in '{ws.title}': no Expected/Result column detected.")
        return {"sheetName": ws.title, "testCases": [], "ambiguousWarnings": warnings}

    exp_idx = expected_idxs[0]
    cases = []
    for r_num, row in enumerate(rows[1:], start=2):
        exp_val = row[exp_idx]
        if exp_val is None or not isinstance(exp_val, (int, float)):
            warnings.append(f"Row {r_num}: expected value '{exp_val}' is non-numeric; skipped.")
            continue
        inputs = {}
        for i, h in enumerate(headers):
            if i not in (scenario_idx, exp_idx, tol_idx) and h:
                inputs[h] = row[i]
        cases.append({
            "scenario": str(row[scenario_idx]) if scenario_idx is not None and row[scenario_idx] else f"Row_{r_num}",
            "inputs": inputs,
            "expectedField": headers[exp_idx],
            "expectedValue": float(exp_val),
            "tolerance": float(row[tol_idx]) if tol_idx is not None and row[tol_idx] else 0.01,
        })

    return {"sheetName": ws.title, "testCases": cases, "ambiguousWarnings": warnings}


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: inspect_excel.py <oracle.xlsx>", file=sys.stderr)
        sys.exit(1)
    print(json.dumps(read_excel_oracle(sys.argv[1]), indent=2))
