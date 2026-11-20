# Cover plate / DXF generator

Generates laser-cut top plates for the Crustrusk keyboard PCBs under `pcb/`.

For every board it creates a `cover/` folder containing:

```text
cover/
├── <name>-cover.kicad_pro
├── <name>-cover.kicad_prl
├── <name>-cover.kicad_sch
├── <name>-cover.kicad_pcb   # only edge cuts + switch/screw holes
└── <name>-cover.dxf         # Edge.Cuts only, centre-line, millimetres
```

Bundles (`pcb_bundle/`), the main boards, and the encoder peripheral are skipped
by default.

## Requirements

| Tool | Why | Install |
| --- | --- | --- |
| KiCad 10+ | `pcbnew` Python module and `kicad-cli` | `sudo apt install kicad` |
| Python 3.10+ | runs the script | already available |
| Pillow | PNG verification previews (optional) | `python3 -m pip install pillow` |

`pcbnew` is the same Python module that ships with KiCad; it is not a pip
package on Debian/Ubuntu.

## Usage

From the repository root (`published/`):

```bash
# Generate every cover
python3 tools/cover_dxf/cover_dxf.py

# One or a few boards
python3 tools/cover_dxf/cover_dxf.py --only 'col[2-5]|thumb3-boardloaf'

# See which boards would be processed
python3 tools/cover_dxf/cover_dxf.py --dry-run

# Change the switch-to-profile clearance (default 2.0 mm)
python3 tools/cover_dxf/cover_dxf.py --switch-clearance 2.0

# Skip DXF or PNG generation
python3 tools/cover_dxf/cover_dxf.py --no-dxf
python3 tools/cover_dxf/cover_dxf.py --no-preview

# Also run KiCad DRC as an extra outline check (slower)
python3 tools/cover_dxf/cover_dxf.py --drc
```

PNG previews are written to `../previews/covers/` by default:

- `<name>-cover.png` - clean laser-cut view
- `<name>-cover-verify.png` - overlay showing the original board (gray), switch
  fab (green), switch cut-outs (orange), JST body + cut line (purple/blue),
  M2 holes (cyan), and the generated profile (red)

## What the script does

1. **Copies the project** (`.kicad_pro`, `.kicad_prl`, `.kicad_sch`) into
   `cover/`, renaming the project/schematic references to `<name>-cover`.
2. **Replaces mechanical footprints**:
   - every MX hot-swap footprint becomes `crustrusk:hole-switch`
   - every M2 stand-off / mounting hole becomes `crustrusk:hole-m2-screw`
   - internal 2 mm circular board cut-outs become M2 screw holes
   - edge-touching circles are left as part of the outer profile
3. **Builds the outer profile** from the board's `Edge.Cuts`:
   - grows it where a switch is closer than `--switch-clearance` to the
     switch's 15 x 15 mm fab body
   - cuts away everything outward of the JST access line, one millimetre
     behind the connector origin
   - adds a ring of material around every M2 hole
4. **Cleans the result** of zero-width excursions and redundant collinear
   points, then writes it as closed `Edge.Cuts` line segments.
5. **Exports the DXF** with only `Edge.Cuts`, centre-line mode, millimetres.
6. **Verifies**:
   - KiCad re-opens the board and confirms the outline is closed
   - every switch fab and cut-out is inside the profile and not crossed by it
   - JST pads are outside the profile
   - M2 holes have material around them
   - the DXF contains only `LINE`/`CIRCLE` entities (no contour polylines)
   - every DXF line endpoint meets another line endpoint

A failed check is reported and the board is skipped unless `--keep-going` is
passed. Use `--no-verify` only if you deliberately want unverified output.

## Notes

- Overlapping switch cut-outs (alternative/reversible positions, currently
  `thumb4-yuwol`) are unioned into one cut-out so the laser does not cut the
  same edge twice. The corresponding `hole-switch` footprints keep their
  14 x 14 mm outline on `Dwgs.User` as a visual reference.
- The generated PCB intentionally has no copper, tracks, zones, or 3D models.
  It is a mechanical drawing for the laser cutter.
- DXF Y coordinates follow KiCad's plot convention (negated relative to the PCB
  editor). This matches the existing sample DXFs and does not affect cutting.
- Existing sample files are overwritten when their board is regenerated.
