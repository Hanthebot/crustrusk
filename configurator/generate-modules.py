#!/usr/bin/env python3
"""Generate the module catalog used by the Crustrusk configurator.

The catalog is read straight from the KiCad boards in ``pcb/`` so the web app
always talks about the same column / thumb / peripheral boards that are in the
repository.  Key positions are normalised to 19.05 mm (1u) and matrix rows are
taken from the ``SW-<column>-<row>`` reference designators.

Usage (from the repository root):

    python3 configurator/generate-modules.py
    python3 configurator/generate-modules.py --pcb-dir pcb --out configurator/modules.js
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

UNIT = 19.05  # 1u in mm
SWITCH_RE = re.compile(r"SW-(\d+)-(\d+)")

# Hand-written presentation metadata.  Keys must match the board folder names.
META = {
    "col2": ("Column 2", "column", "Two-key column"),
    "col3": ("Column 3", "column", "Three-key column"),
    "col4": ("Column 4", "column", "Four-key column"),
    "col5": ("Column 5", "column", "Five-key column"),
    "asym-col-corne": ("Asym · Corne", "column", "Corne pinky, 5 keys"),
    "asym-col-jian": ("Asym · Jian", "column", "Jian pinky, 4 keys"),
    "asym-col-lily58": ("Asym · Lily58", "column", "Lily58 pinky, 5 keys"),
    "asym-col-square": ("Asym · Square", "column", "2×2 square block"),
    "asym-col-totemx": ("Asym · TotemX", "column", "TotemX pinky, 4 keys"),
    "asym-col-triangle": ("Asym · Triangle", "column", "3-key triangle"),
    "asym-col-wubbo": ("Asym · Wubbo", "column", "Wubbo 3-key block"),
    "asym-col-wysteria": ("Asym · Wysteria", "column", "Wysteria 3-key block"),
    "thumb2-sweep": ("Thumb 2 · Sweep", "thumb", "Sweep thumb cluster"),
    "thumb3-boardloaf": ("Thumb 3 · Boardloaf", "thumb", "Boardloaf thumb cluster"),
    "thumb3-cantor": ("Thumb 3 · Cantor", "thumb", "Cantor thumb cluster"),
    "thumb3-cheapino": ("Thumb 3 · Cheapino", "thumb", "Cheapino thumb cluster"),
    "thumb3-corne": ("Thumb 3 · Corne", "thumb", "Corne thumb cluster"),
    "thumb3-dilemma": ("Thumb 3 · Dilemma", "thumb", "Dilemma thumb cluster"),
    "thumb3-ik": ("Thumb 3 · IK", "thumb", "IK thumb cluster"),
    "thumb3-minidox": ("Thumb 3 · Minidox", "thumb", "Minidox thumb cluster"),
    "thumb3-silakka54": ("Thumb 3 · Silakka54", "thumb", "Silakka54 thumb cluster"),
    "thumb3-slimkeeb36": ("Thumb 3 · SlimKeeb36", "thumb", "SlimKeeb36 thumb cluster"),
    "thumb3-totemx": ("Thumb 3 · TotemX", "thumb", "TotemX thumb cluster"),
    "thumb4-elephant42": ("Thumb 4 · Elephant42", "thumb", "Elephant42 thumb cluster"),
    "thumb4-haili58": ("Thumb 4 · Haili58", "thumb", "Haili58 thumb cluster"),
    "thumb4-lily58": ("Thumb 4 · Lily58", "thumb", "Lily58 thumb cluster"),
    "thumb4-nyx": ("Thumb 4 · Nyx", "thumb", "Nyx diagonal thumb cluster"),
    "thumb4-yuwol": ("Thumb 5 · Yuwol", "thumb", "Yuwol thumb cluster (5 positions / 4 rows)"),
    "thumb5-redox": ("Thumb 5 · Redox", "thumb", "Redox thumb cluster"),
    "thumb5-sofle": ("Thumb 5 · Sofle", "thumb", "Sofle thumb cluster"),
}

PERIPHERAL = {
    "id": "ec11",
    "name": "Rotary encoder · EC11",
    "type": "peripheral",
    "connector": "mp6",
    "pcb": "pcb/peripheral_ec11/peripheral_ec11.kicad_pcb",
    "bus": ["SDA", "SCL", "MOSI"],
    "keys": [],
    "note": "EC11 with push switch",
}


def balanced_block(text: str, start: int) -> str:
    """Return the balanced s-expression beginning at ``start``."""
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "(":
            depth += 1
        elif text[i] == ")":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    raise ValueError("unbalanced s-expression")


def footprints(text: str):
    for match in re.finditer(r'\(footprint\s+"([^"]+)"', text):
        yield match.group(1), balanced_block(text, match.start())


def parse_switches(path: Path) -> list[dict]:
    text = path.read_text()
    switches = []
    for footprint, block in footprints(text):
        if not re.search(r"Kailh|SW_Push|keyswitch", footprint, re.I):
            continue
        ref_match = re.search(r'\(property "Reference" "([^"]+)"', block)
        at_match = re.search(r"\(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?", block)
        if not ref_match or not at_match:
            continue
        ref = ref_match.group(1)
        sw_match = SWITCH_RE.fullmatch(ref)
        if not sw_match:
            continue
        x, y = float(at_match.group(1)), float(at_match.group(2))
        switches.append(
            {
                "ref": ref,
                "row": int(sw_match.group(2)),
                "x": x,
                "y": y,
                "rot": float(at_match.group(3) or 0),
            }
        )
    # Some boards have two footprints sharing a reference (optional layouts).
    # Keep both positions but sort deterministically.
    return sorted(switches, key=lambda s: (s["row"], s["x"], s["y"], s["ref"]))


def normalise(name: str, switches: list[dict]) -> list[dict]:
    """Map KiCad millimetres to a tidy 1u key grid.

    Column boards up to col5 are drawn horizontally in KiCad; rotate them so a
    column reads top-to-bottom in the configurator.  Asymmetric columns and
    thumb clusters are already drawn in their mounted orientation.
    """
    xs = [s["x"] for s in switches]
    ys = [s["y"] for s in switches]
    swap = name.startswith("col") and not name.startswith("asym-col")
    if swap:
        raw = [(0.0, s["x"], s["row"]) for s in switches]
    else:
        raw = [(s["x"], s["y"], s["row"]) for s in switches]

    min_x = min(p[0] for p in raw)
    min_y = min(p[1] for p in raw)
    keys = []
    for x, y, row in raw:
        gx = round((x - min_x) / UNIT, 2)
        gy = round((y - min_y) / UNIT, 2)
        # Keep the common 1u grid crisp without flattening real arc offsets.
        gx = round(gx * 2) / 2 if abs(gx * 2 - round(gx * 2)) < 0.08 else gx
        gy = round(gy * 2) / 2 if abs(gy * 2 - round(gy * 2)) < 0.08 else gy
        keys.append({"x": gx, "y": gy, "row": row})
    return keys


def build(pcb_dir: Path) -> list[dict]:
    modules = []
    for board in sorted(pcb_dir.glob("*/*.kicad_pcb")):
        name = board.parent.name
        if name not in META:
            continue
        display, kind, note = META[name]
        switches = parse_switches(board)
        if not switches:
            continue
        keys = normalise(name, switches)
        rows_used = max(k["row"] for k in keys) + 1
        connector = "mc6" if rows_used <= 5 else "mc8"
        modules.append(
            {
                "id": name,
                "name": display,
                "type": kind,
                "connector": connector,
                "pcb": f"pcb/{name}/{name}.kicad_pcb",
                "note": note,
                "keys": keys,
            }
        )
    modules.append(PERIPHERAL)
    return modules


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pcb-dir", type=Path, default=Path("pcb"))
    parser.add_argument("--out", type=Path, default=Path("configurator/modules.js"))
    args = parser.parse_args()

    modules = build(args.pcb_dir)
    payload = json.dumps(modules, indent=2)
    args.out.write_text(
        "// Generated by configurator/generate-modules.py — do not edit by hand.\n"
        "// Source boards: pcb/*/*.kicad_pcb\n"
        f"const MODULES = {payload};\n"
    )
    print(f"Wrote {len(modules)} modules to {args.out}")


if __name__ == "__main__":
    main()
