#!/usr/bin/env python3
"""Generate laser-cut cover plates for Crustrusk keyboard PCBs.

For every keyboard PCB under ``pcb/`` (excluding bundles, main boards, and the
encoder peripheral) the tool:

1. copies the KiCad project, PCB, and schematic into ``<board>/cover`` with a
   ``-cover`` suffix,
2. replaces MX hot-swap footprints with ``crustrusk:hole-switch`` and M2
   stand-off holes with ``crustrusk:hole-m2-screw``,
3. builds a closed outer profile from the board edge cuts.  The profile is
   pushed out where necessary to keep at least ``--switch-clearance`` mm
   between the profile and every switch's 15x15 mm fab body, and the JST end is
   cut away just behind the connector,
4. writes the same profile and all holes to ``Edge.Cuts``,
5. plots only ``Edge.Cuts`` as a centre-line DXF, and
6. renders a clean preview plus a coloured verification overlay.

Examples
--------
Generate every cover under the repository's ``pcb`` directory::

    python3 tools/cover_dxf/cover_dxf.py

Only a few boards, with a custom clearance::

    python3 tools/cover_dxf/cover_dxf.py --only 'col[2-5]|thumb3-boardloaf' \
        --switch-clearance 2.0

Dry run (show what would be generated, change nothing)::

    python3 tools/cover_dxf/cover_dxf.py --dry-run
"""

from __future__ import annotations

import argparse
import json
import math
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Sequence

try:
    import pcbnew
except ImportError as exc:  # pragma: no cover - environment check
    raise SystemExit(
        "error: the 'pcbnew' Python module is required. "
        "Install KiCad's Python bindings (python3-pcbnew on Debian/Ubuntu)."
    ) from exc

MM = 1_000_000  # KiCad internal units per millimetre
EDGE_WIDTH_MM = 0.05
SWITCH_FAB_HALF_MM = 7.5  # Kailh MX fab outline is 15 x 15 mm
SWITCH_HOLE_HALF_MM = 7.0  # crustrusk:hole-switch cutout is 14 x 14 mm
M2_HOLE_RADIUS_MM = 1.2  # crustrusk:hole-m2-screw radius
M2_CIRCLE_MIN_MM = 1.2
M2_CIRCLE_MAX_MM = 3.0
DEFAULT_SWITCH_CLEARANCE_MM = 2.0
DEFAULT_JST_INSET_MM = 1.0
SCREW_WEB_MM = 1.5
DEFAULT_EXCLUDE = r"(^|/)(main_board|main_board_v2|peripheral_ec11)(/|$)|/cover/|/pcb_bundle/"
DEFAULT_LIBRARY = "crustrusk.pretty"


# --------------------------------------------------------------------------- #
# data helpers
# --------------------------------------------------------------------------- #
@dataclass
class Placement:
    """A footprint position and local-to-world transform."""

    matrix: tuple[tuple[float, float], tuple[float, float]]
    origin: tuple[float, float]
    rotation: float
    reference: str = ""

    def to_world(self, x: float, y: float) -> tuple[float, float]:
        m = self.matrix
        return (
            self.origin[0] + m[0][0] * x + m[0][1] * y,
            self.origin[1] + m[1][0] * x + m[1][1] * y,
        )

    def rect_corners(self, half: float) -> list[tuple[float, float]]:
        return [
            self.to_world(-half, -half),
            self.to_world(half, -half),
            self.to_world(half, half),
            self.to_world(-half, half),
        ]

    def outward(self) -> tuple[float, float]:
        """Local +Y is the connector mouth direction for the JST footprints."""
        m = self.matrix
        ux, uy = m[0][1], m[1][1]
        length = math.hypot(ux, uy) or 1.0
        return ux / length, uy / length


@dataclass
class BoardSpec:
    source: Path
    switches: list[Placement] = field(default_factory=list)
    screws: list[Placement] = field(default_factory=list)
    jst: Placement | None = None
    jst_bbox: tuple[float, float, float, float] | None = None
    jst_pad_centers: list[tuple[float, float]] = field(default_factory=list)
    board_bbox: tuple[float, float, float, float] = (0, 0, 0, 0)
    loops: list[list[tuple[float, float]]] = field(default_factory=list)
    source_loops: list[list[tuple[float, float]]] = field(default_factory=list)
    source_holes: list[list[tuple[float, float]]] = field(default_factory=list)
    merged_switch_indices: set[int] = field(default_factory=set)
    merged_holes: list[list[tuple[float, float]]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


class CoverError(RuntimeError):
    pass


# Footprint templates are loaded before any SHAPE_POLY_SET work.  Some KiCad 10
# Python builds corrupt the global PCB_IO plugin after heavy polygon booleans,
# so calling FootprintLoad() late can fail with a SwigPyObject error.
_FOOTPRINT_TEMPLATES: dict[str, "pcbnew.FOOTPRINT"] = {}


def load_footprint_templates(library: Path) -> None:
    for name in ("hole-switch", "hole-m2-screw"):
        template = pcbnew.FootprintLoad(str(library), name)
        if template is None:
            raise CoverError(f"cannot load footprint {library.name}:{name}")
        _FOOTPRINT_TEMPLATES[name] = template


def footprint_matrix(fp: "pcbnew.FOOTPRINT") -> tuple[tuple[float, float], tuple[float, float]]:
    """Local-to-world rotation matrix for a front-side footprint.

    KiCad reports the angle counter-clockwise in the schematic sense, while PCB
    coordinates grow downwards.  Using ``theta = rotation`` directly gives the
    matrix that reproduces pad world positions (verified against the pads).
    """
    theta = math.radians(fp.GetOrientationDegrees())
    cos_t = math.cos(theta)
    sin_t = math.sin(theta)
    return ((cos_t, sin_t), (-sin_t, cos_t))


def placement_for(fp: "pcbnew.FOOTPRINT") -> Placement:
    pos = fp.GetPosition()
    return Placement(
        matrix=footprint_matrix(fp),
        origin=(pcbnew.ToMM(pos.x), pcbnew.ToMM(pos.y)),
        rotation=fp.GetOrientationDegrees(),
        reference=str(fp.GetReference()),
    )


def is_switch(name: str) -> bool:
    lower = name.lower()
    return "kailh" in lower or "mx" in lower or "hotswap" in lower


def is_m2_footprint(name: str) -> bool:
    lower = name.lower()
    return (
        "m2" in lower
        or "mountinghole" in lower
        or "mounting_hole" in lower
        or "stand" in lower and "hole" in lower
    )


def is_jst(name: str) -> bool:
    return "jst" in name.lower()


# --------------------------------------------------------------------------- #
# board inspection
# --------------------------------------------------------------------------- #
def collect_spec(board: "pcbnew.BOARD", source: Path) -> BoardSpec:
    spec = BoardSpec(source=source)

    # Extract the board outline first: the circle handling below needs it to
    # tell internal M2 holes from edge notches / mouse bites.
    outlines = pcbnew.SHAPE_POLY_SET()
    if not board.GetBoardPolygonOutlines(outlines, True):
        spec.warnings.append("source board outline is not a closed polygon")
    for index in range(outlines.OutlineCount()):
        spec.source_loops.append(polygon_loop(outlines.Outline(index)))
        for hole in range(outlines.HoleCount(index)):
            spec.source_holes.append(polygon_loop(outlines.Hole(index, hole)))

    box = board.GetBoardEdgesBoundingBox()
    spec.board_bbox = (
        pcbnew.ToMM(box.GetX()),
        pcbnew.ToMM(box.GetY()),
        pcbnew.ToMM(box.GetRight()),
        pcbnew.ToMM(box.GetBottom()),
    )

    for fp in board.GetFootprints():
        name = str(fp.GetFPID().GetLibItemName())
        if is_switch(name):
            spec.switches.append(placement_for(fp))
        elif is_jst(name):
            spec.jst = placement_for(fp)
            xs: list[float] = []
            ys: list[float] = []
            for pad in fp.Pads():
                box = pad.GetBoundingBox()
                xs += [pcbnew.ToMM(box.GetX()), pcbnew.ToMM(box.GetRight())]
                ys += [pcbnew.ToMM(box.GetY()), pcbnew.ToMM(box.GetBottom())]
                center = pad.GetPosition()
                spec.jst_pad_centers.append(
                    (pcbnew.ToMM(center.x), pcbnew.ToMM(center.y))
                )
            if xs:
                spec.jst_bbox = (min(xs), min(ys), max(xs), max(ys))
        elif is_m2_footprint(name):
            spec.screws.append(placement_for(fp))

    # Round 2 mm board cut-outs (the thumb boards use these as M2 mounting
    # holes) become proper screw holes in the cover.  Circles that touch the
    # board edge are edge features, not mounting holes: keep them only as part
    # of the outer profile.
    for drawing in board.GetDrawings():
        if drawing.GetLayer() != pcbnew.Edge_Cuts:
            continue
        if drawing.GetShape() != pcbnew.SHAPE_T_CIRCLE:
            continue
        radius = pcbnew.ToMM(drawing.GetRadius())
        if not (M2_CIRCLE_MIN_MM <= radius <= M2_CIRCLE_MAX_MM):
            continue
        center = drawing.GetCenter()
        point = (pcbnew.ToMM(center.x), pcbnew.ToMM(center.y))
        edge_distance = min(
            (polygon_distance(loop, point) for loop in spec.source_loops),
            default=0.0,
        )
        if edge_distance < radius + 0.5:
            spec.warnings.append(
                f"ignored edge-touching circular cut-out at ({point[0]:.2f}, {point[1]:.2f})"
            )
            continue
        spec.screws.append(
            Placement(
                matrix=((1.0, 0.0), (0.0, 1.0)),
                origin=point,
                rotation=0.0,
                reference="MH",
            )
        )

    return spec


def polygon_loop(chain: "pcbnew.SHAPE_LINE_CHAIN") -> list[tuple[float, float]]:
    points = [
        (pcbnew.ToMM(chain.CPoint(i).x), pcbnew.ToMM(chain.CPoint(i).y))
        for i in range(chain.PointCount())
    ]
    if points and points[0] == points[-1]:
        points.pop()
    return clean_loop(points)


def clean_loop(
    loop: Sequence[tuple[float, float]],
    tolerance: float = 1e-6,
) -> list[tuple[float, float]]:
    """Remove zero-width excursions and redundant collinear points."""
    points = list(loop)
    if len(points) < 3:
        return points

    # Boolean operations sometimes leave an out-and-back excursion where the
    # path returns to the same vertex.  Drop the material between repeats.
    changed = True
    while changed and len(points) >= 3:
        changed = False
        for i in range(len(points)):
            for j in range(i + 2, len(points)):
                if math.dist(points[i], points[j]) <= tolerance:
                    points = points[: i + 1] + points[j + 1 :]
                    changed = True
                    break
            if changed:
                break

    # Remove very short segments left over from boolean rounding.
    changed = True
    while changed and len(points) > 3:
        changed = False
        for index in range(len(points)):
            a = points[index]
            b = points[(index + 1) % len(points)]
            if math.dist(a, b) < 0.01:
                points.pop((index + 1) % len(points))
                changed = True
                break

    # Remove points that lie almost on a straight line between their neighbours.
    index = 0
    while len(points) > 3 and index < len(points):
        a = points[index - 1]
        b = points[index]
        c = points[(index + 1) % len(points)]
        cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
        base = math.dist(a, c)
        if base > 0 and abs(cross) / base < 0.005:
            points.pop(index)
        else:
            index += 1

    return points


def add_loop_to_poly(poly: "pcbnew.SHAPE_POLY_SET", loop: Sequence[tuple[float, float]]) -> None:
    index = poly.NewOutline()
    for x, y in loop:
        poly.Append(int(round(x * MM)), int(round(y * MM)), index)


def make_poly(loop: Sequence[tuple[float, float]]) -> "pcbnew.SHAPE_POLY_SET":
    poly = pcbnew.SHAPE_POLY_SET()
    add_loop_to_poly(poly, loop)
    return poly


def half_plane_outward(jst: Placement, inset_mm: float) -> list[tuple[float, float]]:
    """A large rectangle covering everything outward of the JST cut line."""
    ux, uy = jst.outward()
    cx = jst.origin[0] - ux * inset_mm
    cy = jst.origin[1] - uy * inset_mm
    px, py = -uy, ux
    span = 500.0
    return [
        (cx - px * span, cy - py * span),
        (cx + px * span, cy + py * span),
        (cx + px * span + ux * span, cy + py * span + uy * span),
        (cx - px * span + ux * span, cy - py * span + uy * span),
    ]


def circle_points(
    center: tuple[float, float],
    radius: float,
    segments: int = 48,
) -> list[tuple[float, float]]:
    cx, cy = center
    return [
        (
            cx + radius * math.cos(2 * math.pi * index / segments),
            cy + radius * math.sin(2 * math.pi * index / segments),
        )
        for index in range(segments)
    ]


def build_outline(
    spec: BoardSpec,
    switch_clearance_mm: float,
    jst_inset_mm: float,
) -> list[list[tuple[float, float]]]:
    if not spec.source_loops:
        raise CoverError("source board has no usable outline")
    if not spec.switches:
        raise CoverError("source board has no MX switch footprints")
    if spec.jst is None:
        raise CoverError("source board has no JST footprint")

    cover = pcbnew.SHAPE_POLY_SET()
    for loop in spec.source_loops:
        add_loop_to_poly(cover, loop)

    # Keep every temporary polygon alive until the boolean work is finished;
    # some KiCad 10 Python builds otherwise corrupt their SWIG state.
    keep_alive: list["pcbnew.SHAPE_POLY_SET"] = []

    # Grow the profile where a switch is closer than the requested clearance.
    switch_half = SWITCH_FAB_HALF_MM + switch_clearance_mm
    for switch in spec.switches:
        add_poly = make_poly(switch.rect_corners(switch_half))
        keep_alive.append(add_poly)
        cover.BooleanAdd(add_poly)

    # Remove everything outward of the JST access line.  Switch clearance
    # squares are added again below, so a switch beside the connector keeps its
    # material while the socket itself is always outside the plate.
    notch_poly = make_poly(half_plane_outward(spec.jst, jst_inset_mm))
    keep_alive.append(notch_poly)
    cover.BooleanSubtract(notch_poly)
    # A switch can sit right next to the JST.  Restore its clearance area so the
    # notch cannot open the switch cut-out; this creates a local bump around the
    # switch while the socket itself stays outside the plate.
    for switch in spec.switches:
        add_poly = make_poly(switch.rect_corners(switch_half))
        keep_alive.append(add_poly)
        cover.BooleanAdd(add_poly)

    # Make sure every screw hole has a ring of material around it, even when the
    # original M2 cut-out sat close to the board edge.
    for screw in spec.screws:
        boss_poly = make_poly(
            circle_points(screw.origin, M2_HOLE_RADIUS_MM + SCREW_WEB_MM)
        )
        keep_alive.append(boss_poly)
        cover.BooleanAdd(boss_poly)
    cover.Simplify()

    loops: list[list[tuple[float, float]]] = []
    for index in range(cover.OutlineCount()):
        loops.append(polygon_loop(cover.Outline(index)))
    if not loops:
        raise CoverError("generated cover outline is empty")
    for loop in loops:
        if len(loop) < 3:
            raise CoverError("generated cover outline has fewer than 3 points")
    return loops


# --------------------------------------------------------------------------- #
# verification geometry
# --------------------------------------------------------------------------- #
def point_in_polygon(point: tuple[float, float], loop: Sequence[tuple[float, float]]) -> bool:
    x, y = point
    inside = False
    j = len(loop) - 1
    for i in range(len(loop)):
        xi, yi = loop[i]
        xj, yj = loop[j]
        if ((yi > y) != (yj > y)) and (
            x < (xj - xi) * (y - yi) / (yj - yi) + xi
        ):
            inside = not inside
        j = i
    return inside


def point_segment_distance(
    point: tuple[float, float], a: tuple[float, float], b: tuple[float, float]
) -> float:
    px, py = point
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.dist(point, a)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.dist(point, (ax + t * dx, ay + t * dy))


def polygon_distance(
    loop: Sequence[tuple[float, float]], point: tuple[float, float]
) -> float:
    return min(
        point_segment_distance(point, loop[i], loop[(i + 1) % len(loop)])
        for i in range(len(loop))
    )


def segments_cross(
    a: tuple[float, float],
    b: tuple[float, float],
    c: tuple[float, float],
    d: tuple[float, float],
) -> bool:
    """True when two segments properly cross (touching endpoints do not count)."""
    def orient(p: tuple[float, float], q: tuple[float, float], r: tuple[float, float]) -> float:
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

    o1 = orient(a, b, c)
    o2 = orient(a, b, d)
    o3 = orient(c, d, a)
    o4 = orient(c, d, b)
    return (o1 * o2 < -1e-9) and (o3 * o4 < -1e-9)


def verify_spec(spec: BoardSpec, switch_clearance_mm: float) -> list[str]:
    problems: list[str] = []
    if not spec.loops:
        return ["no cover outline"]
    if len(spec.loops) > 1:
        problems.append(f"cover has {len(spec.loops)} separate outer loops")

    outer = spec.loops[0]
    for switch in spec.switches:
        fab = switch.rect_corners(SWITCH_FAB_HALF_MM)
        for corner in fab:
            if not point_in_polygon(corner, outer):
                problems.append(f"switch {switch.reference}: fab corner is outside profile")
                break
        for index in range(len(fab)):
            a = fab[index]
            b = fab[(index + 1) % len(fab)]
            if any(
                segments_cross(a, b, outer[j], outer[(j + 1) % len(outer)])
                for j in range(len(outer))
            ):
                problems.append(f"switch {switch.reference}: profile crosses its fab")
                break
        hole = switch.rect_corners(SWITCH_HOLE_HALF_MM)
        for corner in hole:
            if not point_in_polygon(corner, outer):
                problems.append(f"switch {switch.reference}: cut-out is outside profile")
                break
        # The outer profile must not pass through a switch cut-out; otherwise
        # the hole is open to the outside and the switch cannot seat.
        crossed = False
        for index in range(len(hole)):
            a = hole[index]
            b = hole[(index + 1) % len(hole)]
            for j in range(len(outer)):
                if segments_cross(a, b, outer[j], outer[(j + 1) % len(outer)]):
                    crossed = True
                    break
            if crossed:
                break
        if crossed:
            problems.append(f"switch {switch.reference}: profile crosses its cut-out")
        # Check the actual fab edge distance, not just corner containment.
        for corner in switch.rect_corners(SWITCH_FAB_HALF_MM):
            if polygon_distance(outer, corner) < 0.01:
                problems.append(f"switch {switch.reference}: fab touches profile")
                break

    for point in spec.jst_pad_centers:
        if point_in_polygon(point, outer):
            problems.append("JST pads are inside the cover profile")
            break

    # Screw holes must sit comfortably inside the plate.
    for screw in spec.screws:
        if not point_in_polygon(screw.origin, outer):
            problems.append(f"screw hole {screw.reference} is outside profile")
            continue
        if polygon_distance(outer, screw.origin) < M2_HOLE_RADIUS_MM + 0.1:
            problems.append(f"screw hole {screw.reference} is too close to profile")

    return problems


# --------------------------------------------------------------------------- #
# writing the cover board
# --------------------------------------------------------------------------- #
def new_footprint(
    board: "pcbnew.BOARD",
    library: Path,
    name: str,
    placement: Placement,
    reference: str,
) -> "pcbnew.FOOTPRINT":
    template = _FOOTPRINT_TEMPLATES.get(name)
    if template is None:
        template = pcbnew.FootprintLoad(str(library), name)
        if template is None:
            raise CoverError(f"cannot load footprint {library.name}:{name}")
        _FOOTPRINT_TEMPLATES[name] = template
    footprint = pcbnew.Cast_to_FOOTPRINT(template.Duplicate(False))
    footprint.SetFPID(pcbnew.LIB_ID("crustrusk", name))
    footprint.SetSheetname("/")
    footprint.SetSheetfile("")
    footprint.SetPosition(
        pcbnew.VECTOR2I(
            int(round(placement.origin[0] * MM)),
            int(round(placement.origin[1] * MM)),
        )
    )
    footprint.SetOrientationDegrees(placement.rotation)
    footprint.SetReference(reference)
    return footprint


def add_loop_segments(board: "pcbnew.BOARD", loop: Sequence[tuple[float, float]]) -> None:
    for index in range(len(loop)):
        start = loop[index]
        end = loop[(index + 1) % len(loop)]
        shape = pcbnew.PCB_SHAPE(board)
        shape.SetShape(pcbnew.SHAPE_T_SEGMENT)
        shape.SetStart(
            pcbnew.VECTOR2I(int(round(start[0] * MM)), int(round(start[1] * MM)))
        )
        shape.SetEnd(
            pcbnew.VECTOR2I(int(round(end[0] * MM)), int(round(end[1] * MM)))
        )
        shape.SetLayer(pcbnew.Edge_Cuts)
        shape.SetWidth(int(round(EDGE_WIDTH_MM * MM)))
        board.Add(shape)


def merged_switch_holes(
    switches: Sequence[Placement],
) -> tuple[set[int], list[list[tuple[float, float]]]]:
    """Union switch cut-outs that overlap (reversible/alternative positions).

    Returns the indices whose footprint Edge.Cuts should be suppressed and the
    replacement union outlines to add at board level.
    """
    count = len(switches)
    parent = list(range(count))

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    holes = [switch.rect_corners(SWITCH_HOLE_HALF_MM) for switch in switches]
    for i in range(count):
        for j in range(i + 1, count):
            intersection = make_poly(holes[i])
            other = make_poly(holes[j])
            intersection.BooleanIntersection(other)
            if intersection.Area() > 1e6:  # > 0.001 mm^2
                union(i, j)

    groups: dict[int, list[int]] = {}
    for index in range(count):
        groups.setdefault(find(index), []).append(index)

    merged_indices: set[int] = set()
    merged_loops: list[list[tuple[float, float]]] = []
    for group in groups.values():
        if len(group) < 2:
            continue
        merged_indices.update(group)
        union_poly = make_poly(holes[group[0]])
        for index in group[1:]:
            union_poly.BooleanAdd(make_poly(holes[index]))
        union_poly.Simplify()
        for outline in range(union_poly.OutlineCount()):
            merged_loops.append(polygon_loop(union_poly.Outline(outline)))
    return merged_indices, merged_loops


def move_edge_cuts_to_drawings(footprint: "pcbnew.FOOTPRINT") -> None:
    """Keep the hole outline as a reference, but stop it cutting the board.

    Removing items from a duplicated footprint corrupts KiCad 10's SWIG state,
    so move the four edges to Dwgs.User instead.  The merged cut-out is added at
    board level.
    """
    for item in list(footprint.GraphicalItems()):
        if item.GetLayer() == pcbnew.Edge_Cuts:
            item.SetLayer(pcbnew.Dwgs_User)


def write_cover_board(
    spec: BoardSpec,
    output: Path,
    library: Path,
) -> None:
    board = pcbnew.LoadBoard(str(spec.source))
    board.RemoveAll()

    merged_indices, merged_loops = merged_switch_holes(spec.switches)
    spec.merged_switch_indices = merged_indices
    spec.merged_holes = merged_loops

    for index, switch in enumerate(spec.switches):
        footprint = new_footprint(
            board,
            library,
            "hole-switch",
            switch,
            switch.reference or f"SW-{index + 1}",
        )
        if index in merged_indices:
            move_edge_cuts_to_drawings(footprint)
        board.Add(footprint)
    for index, screw in enumerate(spec.screws, start=1):
        board.Add(
            new_footprint(
                board,
                library,
                "hole-m2-screw",
                screw,
                screw.reference if screw.reference not in ("", "REF**") else f"MH{index}",
            )
        )

    for loop in spec.loops:
        add_loop_segments(board, loop)
    for loop in merged_loops:
        add_loop_segments(board, loop)

    output.parent.mkdir(parents=True, exist_ok=True)
    board.Save(str(output))

    # Re-open and ask KiCad to validate the outline.  This catches gaps and
    # self-intersections that a text-only check would miss.
    check = pcbnew.LoadBoard(str(output))
    polygon = pcbnew.SHAPE_POLY_SET()
    if not check.GetBoardPolygonOutlines(polygon, True):
        raise CoverError("KiCad reports the generated Edge.Cuts outline is not closed")


# --------------------------------------------------------------------------- #
# project copying
# --------------------------------------------------------------------------- #
def copy_project(spec: BoardSpec, cover_dir: Path, name: str) -> None:
    for suffix in (".kicad_pro", ".kicad_prl", ".kicad_sch"):
        source = spec.source.with_suffix(suffix)
        if not source.exists():
            continue
        target = cover_dir / f"{name}-cover{suffix}"
        if suffix == ".kicad_pro":
            data = json.loads(source.read_text(encoding="utf-8"))
            data.setdefault("meta", {})["filename"] = target.name
            top = data.get("schematic", {}).get("top_level_sheets", [])
            for sheet in top:
                sheet["filename"] = f"{name}-cover.kicad_sch"
                sheet["name"] = f"{name}-cover"
            sheets = data.get("sheets", [])
            for entry in sheets:
                if isinstance(entry, list) and len(entry) >= 2:
                    entry[1] = f"{name}-cover"
            target.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        else:
            shutil.copyfile(source, target)


# --------------------------------------------------------------------------- #
# DXF export
# --------------------------------------------------------------------------- #
def export_dxf(board: Path, output: Path, kicad_cli: str) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        kicad_cli,
        "pcb",
        "export",
        "dxf",
        "--layers",
        "Edge.Cuts",
        "--output-units",
        "mm",
        "--mode-single",
        "-o",
        str(output),
        str(board),
    ]
    run(cmd)


def run(cmd: Sequence[str], timeout: float = 300.0) -> None:
    proc = subprocess.run(
        list(cmd),
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()
        raise CoverError(f"command failed ({proc.returncode}): {' '.join(cmd)}\n{detail[-2000:]}")


def check_drc(board: Path, kicad_cli: str) -> list[str]:
    """Run KiCad's DRC and return error-level messages, if any."""
    with tempfile.TemporaryDirectory(prefix="cover-drc-") as tmp:
        report = Path(tmp) / "drc.rpt"
        proc = subprocess.run(
            [
                kicad_cli,
                "pcb",
                "drc",
                "--severity-error",
                "--exit-code-violations",
                "--format",
                "report",
                "-o",
                str(report),
                str(board),
            ],
            capture_output=True,
            text=True,
            timeout=300,
            check=False,
        )
        if proc.returncode == 0:
            return []
        text = report.read_text(encoding="utf-8", errors="replace") if report.exists() else ""
        violations = [
            line.strip()
            for line in text.splitlines()
            if line.strip().startswith("[")
        ]
        return violations or [(proc.stderr or proc.stdout or "DRC failed").strip()[-500:]]


def dxf_is_centerline(path: Path) -> tuple[bool, str]:
    """Check that the DXF contains only centre-line LINE/CIRCLE entities."""
    text = path.read_text(encoding="utf-8", errors="replace")
    if "ENTITIES" not in text:
        return False, "DXF has no ENTITIES section"
    entities = re.findall(r"\n  0\n([A-Z]+)\n", text)
    entity_set = set(entities)
    allowed = {"LINE", "CIRCLE", "ENDSEC", "EOF"}
    unexpected = entity_set - allowed - {
        "SECTION", "HEADER", "TABLES", "BLOCKS", "ENDTAB", "TABLE",
        "LAYER", "LTYPE", "STYLE", "APPID", "DIMSTYLE", "BLOCK", "ENDBLK",
        "DICTIONARY", "ACDBDICTIONARYWDFLT", "ACDBPLACEHOLDER", "LAYOUT",
    }
    if unexpected:
        return False, f"unexpected DXF entities: {sorted(unexpected)}"
    if "POLYLINE" in entity_set or "LWPOLYLINE" in entity_set:
        return False, "DXF contains outline/contour entities instead of centre lines"
    return True, ""


def dxf_open_endpoints(path: Path) -> list[tuple[float, float]]:
    """Return LINE endpoints that do not meet another LINE endpoint.

    CIRCLE entities are intrinsically closed and are ignored.  The tolerance
    (0.001 mm) absorbs DXF's decimal formatting noise.
    """
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    pairs: list[tuple[int, str]] = []
    for index in range(0, len(lines) - 1, 2):
        code = lines[index].strip()
        value = lines[index + 1].strip()
        if code.lstrip("-").isdigit():
            pairs.append((int(code), value))

    endpoints: list[tuple[float, float]] = []
    index = 0
    while index < len(pairs):
        code, value = pairs[index]
        if code == 0 and value == "LINE":
            line: dict[int, str] = {}
            index += 1
            while index < len(pairs) and pairs[index][0] != 0:
                line[pairs[index][0]] = pairs[index][1]
                index += 1
            try:
                endpoints.append((round(float(line[10]), 4), round(float(line[20]), 4)))
                endpoints.append((round(float(line[11]), 4), round(float(line[21]), 4)))
            except (KeyError, ValueError):
                pass
            continue
        index += 1

    counts: dict[tuple[float, float], int] = {}
    for point in endpoints:
        counts[point] = counts.get(point, 0) + 1
    return [point for point, count in counts.items() if count % 2]


# --------------------------------------------------------------------------- #
# preview rendering
# --------------------------------------------------------------------------- #
def render_previews(
    spec: BoardSpec,
    clean_path: Path,
    verify_path: Path,
    title: str,
    jst_inset: float = DEFAULT_JST_INSET_MM,
) -> None:
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        return

    width = 1800
    height = 1200
    margin = 40
    xs: list[float] = []
    ys: list[float] = []
    for loop in spec.source_loops + spec.source_holes + spec.loops:
        xs += [p[0] for p in loop]
        ys += [p[1] for p in loop]
    for switch in spec.switches:
        for x, y in switch.rect_corners(SWITCH_FAB_HALF_MM):
            xs.append(x)
            ys.append(y)
    if not xs:
        return
    x0, x1 = min(xs), max(xs)
    y0, y1 = min(ys), max(ys)
    span_x = max(x1 - x0, 1.0)
    span_y = max(y1 - y0, 1.0)
    scale = min((width - 2 * margin) / span_x, (height - 2 * margin) / span_y)
    off_x = (width - span_x * scale) / 2 - x0 * scale
    off_y = (height - span_y * scale) / 2 - y0 * scale

    def px(point: tuple[float, float]) -> tuple[float, float]:
        return (point[0] * scale + off_x, point[1] * scale + off_y)

    def draw_loop(draw: "ImageDraw.ImageDraw", loop: Sequence[tuple[float, float]], color: str, width_px: int) -> None:
        points = [px(p) for p in loop]
        if len(points) > 1:
            draw.line(points + [points[0]], fill=color, width=width_px)

    # Clean laser-cut preview.
    clean = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(clean)
    for loop in spec.loops:
        draw_loop(draw, loop, "black", 4)
    for index, switch in enumerate(spec.switches):
        if index not in spec.merged_switch_indices:
            draw_loop(draw, switch.rect_corners(SWITCH_HOLE_HALF_MM), "black", 4)
    for loop in spec.merged_holes:
        draw_loop(draw, loop, "black", 4)
    for screw in spec.screws:
        x, y = px(screw.origin)
        radius = M2_HOLE_RADIUS_MM * scale
        draw.ellipse(
            (x - radius, y - radius, x + radius, y + radius),
            outline="black",
            width=3,
        )
    clean_path.parent.mkdir(parents=True, exist_ok=True)
    clean.save(clean_path, "PNG", optimize=True)

    # Verification overlay.
    image = Image.new("RGB", (width, height), "#fafafa")
    draw = ImageDraw.Draw(image)
    for loop in spec.source_loops:
        draw_loop(draw, loop, "#9aa0a6", 2)
    for loop in spec.source_holes:
        draw_loop(draw, loop, "#9aa0a6", 2)
    for index, switch in enumerate(spec.switches):
        draw_loop(draw, switch.rect_corners(SWITCH_FAB_HALF_MM), "#2ca02c", 2)
        if index not in spec.merged_switch_indices:
            draw_loop(draw, switch.rect_corners(SWITCH_HOLE_HALF_MM), "#ff7f0e", 3)
    for loop in spec.merged_holes:
        draw_loop(draw, loop, "#ff7f0e", 3)
    for screw in spec.screws:
        x, y = px(screw.origin)
        radius = M2_HOLE_RADIUS_MM * scale
        draw.ellipse(
            (x - radius, y - radius, x + radius, y + radius),
            outline="#17becf",
            width=3,
        )
    if spec.jst is not None:
        if spec.jst_bbox is not None:
            x0, y0, x1, y1 = spec.jst_bbox
            draw.rectangle(
                (*px((x0, y0)), *px((x1, y1))),
                outline="#9467bd",
                width=2,
            )
        ux, uy = spec.jst.outward()
        cx = spec.jst.origin[0] - ux * jst_inset
        cy = spec.jst.origin[1] - uy * jst_inset
        pxv, pyv = -uy, ux
        length = max(span_x, span_y) * 0.6
        a = (cx + pxv * length, cy + pyv * length)
        b = (cx - pxv * length, cy - pyv * length)
        draw.line([px(a), px(b)], fill="#1f77b4", width=2)
    for loop in spec.loops:
        draw_loop(draw, loop, "#d62728", 4)

    font = ImageFont.load_default(size=18)
    draw.text((margin, 18), title, fill="#111111", font=font)
    legend = [
        ("red  cover profile", "#d62728"),
        ("orange  switch cut-outs", "#ff7f0e"),
        ("green  15x15 switch fab", "#2ca02c"),
        ("purple  JST body", "#9467bd"),
        ("blue  JST cut line", "#1f77b4"),
        ("cyan  M2 holes", "#17becf"),
        ("gray  original board", "#9aa0a6"),
    ]
    for index, (label, color) in enumerate(legend):
        y = height - margin - (len(legend) - index) * 22
        draw.rectangle((margin, y + 4, margin + 14, y + 14), fill=color)
        draw.text((margin + 22, y), label, fill="#222222", font=ImageFont.load_default(size=14))

    verify_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(verify_path, "PNG", optimize=True)


def build_contact_sheet(preview_dir: Path, verify: bool = False) -> Path | None:
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        return None

    suffix = "-cover-verify.png" if verify else "-cover.png"
    files = sorted(preview_dir.glob(f"*{suffix}"))
    if not files:
        return None

    columns = 4
    thumb_w, thumb_h = 440, 300
    label_h, pad = 26, 10
    rows = (len(files) + columns - 1) // columns
    width = columns * (thumb_w + pad) + pad
    height = rows * (thumb_h + label_h + pad) + pad + 30
    sheet = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(sheet)
    title = "Crustrusk cover plates"
    if verify:
        title += " - verification overlays"
    draw.text((pad, 8), title, fill="black", font=ImageFont.load_default(size=16))

    for index, path in enumerate(files):
        row, column = divmod(index, columns)
        x = pad + column * (thumb_w + pad)
        y = 30 + pad + row * (thumb_h + label_h + pad)
        image = Image.open(path).convert("RGB")
        image.thumbnail((thumb_w, thumb_h), Image.LANCZOS)
        sheet.paste(image, (x + (thumb_w - image.width) // 2, y + (thumb_h - image.height) // 2))
        label = path.name[: -len(suffix)]
        draw.text((x, y + thumb_h + 4), label, fill="black", font=ImageFont.load_default(size=16))

    output = preview_dir / ("contact-sheet-verify.png" if verify else "contact-sheet.png")
    sheet.save(output, "PNG", optimize=True)
    return output


# --------------------------------------------------------------------------- #
# pipeline
# --------------------------------------------------------------------------- #
def find_boards(root: Path, exclude: re.Pattern[str]) -> list[Path]:
    boards = []
    for path in sorted(root.glob("*/*.kicad_pcb")):
        if exclude.search(path.as_posix()):
            continue
        if path.parent.name == "cover":
            continue
        boards.append(path)
    return boards


def process_board(
    board_path: Path,
    args: argparse.Namespace,
    kicad_cli: str,
    library: Path,
) -> dict[str, object]:
    name = board_path.stem
    cover_dir = board_path.parent / "cover"
    result: dict[str, object] = {"name": name, "warnings": [], "problems": []}

    if args.dry_run:
        result["status"] = "dry-run"
        return result

    board = pcbnew.LoadBoard(str(board_path))
    spec = collect_spec(board, board_path)
    result["warnings"] = list(spec.warnings)

    try:
        spec.loops = build_outline(spec, args.switch_clearance, args.jst_inset)
    except CoverError as exc:
        result["status"] = "skipped"
        result["problems"] = [str(exc)]
        return result

    problems = verify_spec(spec, args.switch_clearance)
    result["problems"] = problems
    if problems and not args.keep_going and not args.no_verify:
        result["status"] = "failed"
        return result

    cover_dir.mkdir(parents=True, exist_ok=True)
    copy_project(spec, cover_dir, name)

    pcb_path = cover_dir / f"{name}-cover.kicad_pcb"
    write_cover_board(spec, pcb_path, library)

    dxf_path = cover_dir / f"{name}-cover.dxf"
    if not args.no_dxf:
        export_dxf(pcb_path, dxf_path, kicad_cli)
        centerline, detail = dxf_is_centerline(dxf_path)
        if not centerline:
            problems.append(f"DXF check: {detail}")
        open_ends = dxf_open_endpoints(dxf_path)
        if open_ends:
            problems.append(f"DXF has {len(open_ends)} open endpoint(s)")
        result["problems"] = problems

    if args.drc:
        drc_problems = check_drc(pcb_path, kicad_cli)
        if drc_problems:
            problems.extend(f"DRC: {problem}" for problem in drc_problems)
            result["problems"] = problems

    if not args.no_preview:
        render_previews(
            spec,
            args.preview_dir / f"{name}-cover.png",
            args.preview_dir / f"{name}-cover-verify.png",
            f"{name} cover",
            args.jst_inset,
        )

    result["status"] = "ok" if not result["problems"] else "warn"
    result["pcb"] = str(pcb_path)
    result["dxf"] = str(dxf_path) if not args.no_dxf else ""
    return result


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    repo_root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(
        description="Generate laser-cut cover plates and centre-line DXFs for Crustrusk PCBs.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=repo_root / "pcb",
        help="directory containing the board subdirectories",
    )
    parser.add_argument(
        "--only",
        default=None,
        help="only boards whose path matches this regular expression",
    )
    parser.add_argument(
        "--exclude",
        default=DEFAULT_EXCLUDE,
        help="exclude boards whose path matches this regular expression",
    )
    parser.add_argument(
        "--switch-clearance",
        type=float,
        default=DEFAULT_SWITCH_CLEARANCE_MM,
        help="minimum profile-to-switch-fab clearance in mm",
    )
    parser.add_argument(
        "--jst-inset",
        type=float,
        default=DEFAULT_JST_INSET_MM,
        help="distance from the JST origin to the access cut, in mm",
    )
    parser.add_argument(
        "--library",
        type=Path,
        default=repo_root / DEFAULT_LIBRARY,
        help="path to crustrusk.pretty",
    )
    parser.add_argument(
        "--preview-dir",
        type=Path,
        default=repo_root.parent / "previews" / "covers",
        help="directory for generated PNG previews",
    )
    parser.add_argument(
        "--kicad-cli",
        default=None,
        help="path to kicad-cli (default: find on PATH)",
    )
    parser.add_argument("--no-dxf", action="store_true", help="do not export DXF")
    parser.add_argument("--no-preview", action="store_true", help="do not render PNG previews")
    parser.add_argument(
        "--drc",
        action="store_true",
        help="run kicad-cli DRC as an extra outline check (slower)",
    )
    parser.add_argument(
        "--contact-sheet",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="build a contact sheet from the previews",
    )
    parser.add_argument("--no-verify", action="store_true", help="write files even if checks fail")
    parser.add_argument(
        "--keep-going",
        action="store_true",
        help="continue after a verification failure (files are still written)",
    )
    parser.add_argument("--dry-run", action="store_true", help="list boards and exit")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    kicad_cli = args.kicad_cli or shutil.which("kicad-cli")
    if not kicad_cli and (not args.no_dxf or args.drc):
        print("error: kicad-cli not found; install KiCad or pass --kicad-cli", file=sys.stderr)
        return 2

    if not args.library.exists():
        print(f"error: footprint library not found: {args.library}", file=sys.stderr)
        return 2

    try:
        load_footprint_templates(args.library)
    except CoverError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    exclude = re.compile(args.exclude)
    boards = find_boards(args.root, exclude)
    if args.only:
        only = re.compile(args.only)
        boards = [board for board in boards if only.search(board.as_posix())]
    if not boards:
        print("error: no boards matched", file=sys.stderr)
        return 1

    print(f"Cover generation for {len(boards)} board(s)")
    failures = 0
    warnings = 0
    for index, board in enumerate(boards, 1):
        label = board.parent.name
        try:
            result = process_board(board, args, kicad_cli or "", args.library)
        except Exception as exc:  # noqa: BLE001 - one bad board must not stop the batch
            failures += 1
            print(f"[{index}/{len(boards)}] FAILED {label}: {exc}", file=sys.stderr)
            continue

        status = result.get("status", "ok")
        problems = result.get("problems") or []
        notes = result.get("warnings") or []
        if status in ("failed", "skipped"):
            failures += 1
        if problems:
            warnings += 1
        suffix = ""
        if problems:
            suffix = "  " + "; ".join(str(p) for p in problems)
        if notes:
            suffix += "  [" + "; ".join(str(n) for n in notes) + "]"
        print(f"[{index}/{len(boards)}] {status:<8} {label}{suffix}")

    if not args.dry_run and not args.no_preview and args.contact_sheet:
        for verify in (False, True):
            sheet = build_contact_sheet(args.preview_dir, verify=verify)
            if sheet:
                print(f"Contact sheet: {sheet}")

    print(f"\nDone: {len(boards) - failures} ok, {failures} failed, {warnings} with warnings")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
