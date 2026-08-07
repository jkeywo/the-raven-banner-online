#!/usr/bin/env python3
"""Recover the ships and the adjacency arrows from the printed A2 map.

The artist's clean sheets are clean of *everything*: terrain, coastline,
borders and sea, and nothing else. That is right for the things the app draws
itself -- a steward's name, his castles, his settlements -- because two copies
of one fact is how a map and a tracker come to disagree.

But two of the things that went are not game state at all. The little
longships moored off each coast, and the black double-headed arrows across the
borders that say which shires touch, are both fixed properties of the board:
they were true when the map was drawn and they are true now. Redrawing them by
hand gave a boat that did not look like the printed one and no arrows at all,
which is a worse answer than using what the artist already drew.

So they come out of the PDF as vector paths and go back on as an overlay the
renderer lays over the clean art. Nothing here is game state, so nothing here
can go stale.

    py -3 tools/export_map_marks.py

Writes assets/maps/marks-{northern,western,eastern}.svg, and prints the ship
moorings for tools/export_maps_svg.py.
"""

import json
import re
from pathlib import Path

import fitz

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
PDF = ROOT / "raw" / "Raven Banner Maps A2 v1.1.pdf"
OUT = ROOT / "assets" / "maps"

# The page order in the printed file. Checked against the shire names on each
# page, and against the ship count each sheet should have.
SHEETS = {0: "northern", 1: "western", 2: "eastern"}
SHIPS_PER_SHEET = {"northern": 5, "western": 3, "eastern": 4}

# The three inks that matter, as the PDF states them. The near-black of the
# arrows is NOT the near-black of the dotted borders -- 0.003 against 0.113 --
# which is the whole of how the two are told apart, and the only reason this is
# possible without hand-listing every arrow.
GOLD = (0.714187, 0.478243, 0.049254)      # a longship's hull
ARROW_INK = (0.003, 0.004, 0.004)          # arrowheads, shafts, hull outline
SAIL_INK = (0.135836, 0.121035, 0.124331)  # the sail's outline

# Nothing that belongs to a ship or an arrow is bigger than this, and
# everything else in these colours -- a border, a coastline -- is much bigger.
MARK_MAX = 60


def near(colour, want, tol=0.02):
    return colour is not None and all(abs(a - b) < tol for a, b in zip(colour, want))


def path_data(items):
    """MuPDF's drawing items as an SVG `d` string."""
    out = []
    at = None
    for item in items:
        kind = item[0]
        if kind == "l":
            p1, p2 = item[1], item[2]
            if at != (p1.x, p1.y):
                out.append(f"M{p1.x:.2f} {p1.y:.2f}")
            out.append(f"L{p2.x:.2f} {p2.y:.2f}")
            at = (p2.x, p2.y)
        elif kind == "c":
            p1, p2, p3, p4 = item[1], item[2], item[3], item[4]
            if at != (p1.x, p1.y):
                out.append(f"M{p1.x:.2f} {p1.y:.2f}")
            out.append(f"C{p2.x:.2f} {p2.y:.2f} {p3.x:.2f} {p3.y:.2f} {p4.x:.2f} {p4.y:.2f}")
            at = (p4.x, p4.y)
        elif kind == "re":
            r = item[1]
            out.append(f"M{r.x0:.2f} {r.y0:.2f}H{r.x1:.2f}V{r.y1:.2f}H{r.x0:.2f}Z")
            at = None
        elif kind == "qu":
            q = item[1]
            out.append(
                f"M{q.ul.x:.2f} {q.ul.y:.2f}L{q.ur.x:.2f} {q.ur.y:.2f}"
                f"L{q.lr.x:.2f} {q.lr.y:.2f}L{q.ll.x:.2f} {q.ll.y:.2f}Z")
            at = None
    return " ".join(out)


def rgb(colour):
    return "#%02x%02x%02x" % tuple(round(c * 255) for c in colour)


def is_arrow_part(d):
    """An arrowhead or the shaft between two of them, and nothing else.

    Colour alone is not enough: a castle's outline, a defended settlement's
    ring and a ship's own hull outline are all drawn in this same ink, and all
    three are things the app draws itself from the state. Shape tells them
    apart cleanly. An arrowhead is a four-item filled blob; a castle is eighty
    items of crenellation. A shaft is one straight stroked line; a ring is four
    curves. Nothing legitimate sits in between.
    """
    kinds = [i[0] for i in d["items"]]
    if d.get("fill"):
        return len(kinds) <= 8 and any(k == "l" for k in kinds)
    return len(kinds) <= 2 and all(k == "l" for k in kinds)


def marks_on(page):
    """The ships and the arrows, each as (rect, svg fragment)."""
    small = [d for d in page.get_drawings()
             if not d["rect"].is_empty
             and d["rect"].width <= MARK_MAX and d["rect"].height <= MARK_MAX]

    # Hulls first, because everything else about a ship is found by sitting on
    # one. The mast and sail stand clear above the hull, so the catchment
    # reaches up as far as a ship is tall.
    hulls = [d["rect"] for d in small
             if near(d.get("fill"), GOLD) and 40 < d["rect"].width < 80]
    aboard = [fitz.Rect(h.x0 - 2, h.y0 - 26, h.x1 + 2, h.y1 + 2) for h in hulls]

    def draw(d):
        data = path_data(d["items"])
        if not data:
            return None
        fill, stroke = d.get("fill"), d.get("color")
        parts = [f'd="{data}"', f'fill="{rgb(fill)}"' if fill else 'fill="none"']
        if stroke:
            parts.append(f'stroke="{rgb(stroke)}"')
            parts.append(f'stroke-width="{d.get("width", 1) or 1:.2f}"')
        return "<path " + " ".join(parts) + "/>"

    ships, arrows, sails = [], [], []
    for d in small:
        r = d["rect"]
        if any(box.contains(r) for box in aboard):
            frag = draw(d)
            if frag:
                ships.append((r, frag))
            # The white field on the sail is where the printed number sat, and
            # the only part of a ship with anywhere to read a digit against.
            if near(d.get("fill"), (1.0, 1.0, 1.0)) and 15 < r.width < 40:
                sails.append(r)
            continue
        if (near(d.get("fill"), ARROW_INK) or near(d.get("color"), ARROW_INK)) \
                and is_arrow_part(d):
            frag = draw(d)
            if frag:
                arrows.append((r, frag))
    return hulls, sails, ships, arrows


def main() -> None:
    doc = fitz.open(PDF)
    moorings = {}
    for pageno, sheet in SHEETS.items():
        page = doc[pageno]
        hulls, sails, ships, arrows = marks_on(page)

        expected = SHIPS_PER_SHEET[sheet]
        if len(hulls) != expected:
            raise RuntimeError(
                f"{sheet}: found {len(hulls)} ships, expected {expected}")
        if len(sails) != expected:
            raise RuntimeError(
                f"{sheet}: found {len(sails)} sails for {expected} ships")
        # The number goes on the sail rather than in the hull, which is where
        # the printed sheet put it and the only part of a ship with a clear
        # white field to read a digit against. Its centre, so the renderer only
        # has to drop a baseline below it.
        moorings[sheet] = sorted(
            ((round((s.x0 + s.x1) / 2), round((s.y0 + s.y1) / 2)) for s in sails),
            key=lambda p: (p[1], p[0]))

        svg = (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1191 1684"\n'
            f'     width="1191" height="1684">\n'
            f'  <!-- Recovered from {PDF.name} page {pageno} by\n'
            f'       tools/export_map_marks.py. Do not hand-edit. -->\n'
            f'  <g class="rb-arrows">\n    '
            + "\n    ".join(f for _, f in arrows) + "\n  </g>\n"
            f'  <g class="rb-ships">\n    '
            + "\n    ".join(f for _, f in ships) + "\n  </g>\n"
            f"</svg>\n")
        (OUT / f"marks-{sheet}.svg").write_text(svg, encoding="utf-8")
        print(f"marks-{sheet}.svg: {len(hulls)} ships ({len(ships)} parts), "
              f"{len(arrows)} arrow parts, {len(svg):,} bytes")

    print("\nSEA_ANCHORS, for tools/export_maps_svg.py:")
    geo = json.loads((ROOT / "data" / "geometry.json").read_text(encoding="utf-8"))
    shires = json.loads((ROOT / "data" / "shires.json").read_text(encoding="utf-8"))["shires"]
    for sheet, points in moorings.items():
        # A ship is moored off its own shire, so the nearest outline owns it.
        # Checked rather than trusted: every coastal shire on the sheet must
        # come out with exactly one, or the reading is wrong somewhere.
        here = {sid: outline_points(geo["shires"][sid]["polygon"])
                for sid, s in shires.items()
                if geo["shires"][sid]["sheet"] == sheet and s.get("shipCost") is not None}
        taken = {}
        for (x, y) in points:
            owner = min(here, key=lambda sid: min(
                (px - x) ** 2 + (py - y) ** 2 for px, py in here[sid]))
            taken.setdefault(owner, []).append((x, y))
        for sid, got in taken.items():
            if len(got) != 1:
                raise RuntimeError(f"{sid}: {len(got)} ships claim it")
        missing = set(here) - set(taken)
        if missing:
            raise RuntimeError(f"{sheet}: no ship found for {sorted(missing)}")
        for sid, ((x, y),) in taken.items():
            print(f'    "{sid}": ({x}, {y}),')


def outline_points(polygon):
    return [(float(x), float(y))
            for x, y in re.findall(r"[ML]\s*(-?[\d.]+),(-?[\d.]+)", polygon)]


if __name__ == "__main__":
    main()
