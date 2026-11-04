# Crustrusk web configurator

A small, dependency-free web app for assembling a Crustrusk half from the
column, thumb and peripheral PCBs in this repository.

## Run it

The app is plain HTML/CSS/JS. From the repository root:

```bash
python3 -m http.server 8000
# open http://localhost:8000/configurator/
```

Opening `configurator/index.html` directly also works in most browsers. A local
server is recommended so `localStorage` and clipboard access behave normally.

## What it does

- **Drag and drop** a module onto a `COL0`–`COL7` connector, or click a module
  to auto-place it. Thumbs prefer the rightmost free connector.
- **Presets** for the default 3×7+3 build, Corne, Lily58-style, Sofle-style,
  Sweep-style and an asymmetric-pinky build.
- **Live pin map** for the RP2040-Zero, including the shared `SCK` / `COL7`
  pin, split pins and the 8-pin peripheral connector.
- **Checks** for connector row capacity, `COL7` + `SCK` peripherals, MPEX8
  matrix-row conflicts and connector mismatches.
- **Exports** `config.h`, `info.json`, `vial.json` and a starter `keymap.c`.
- **Mirror preview** for checking both halves of the split.
- State is saved in `localStorage`; **Reset** clears it.

## Module catalog

`modules.js` is generated from the actual KiCad boards so key positions and
matrix rows match the PCBs:

```bash
# from the repository root
python3 configurator/generate-modules.py
```

The generator reads `pcb/*/*.kicad_pcb`, normalises switch positions to a 1u
grid and takes each key's matrix row from its `SW-<column>-<row>` reference.
To add a new board, add its folder name to `META` in
`configurator/generate-modules.py` and re-run the generator.

`data.js` contains the main-board facts (row/column pins, connector pinouts,
presets). Keep it in sync with `pcb/main_board/main_board.kicad_pcb` and the
schematic if the hardware changes.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Layout and panel structure |
| `style.css` | Dark theme, responsive board/palette/sidebar layout |
| `data.js` | Main-board pin map, connectors and presets |
| `modules.js` | Generated catalog of column/thumb/peripheral PCBs |
| `app.js` | Placement logic, pin checks, rendering and exports |
| `generate-modules.py` | Regenerates `modules.js` from `pcb/` |
