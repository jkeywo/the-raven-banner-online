#!/usr/bin/env python3
"""Install the three map sheets and say where the game's cells sit on them.

The art is authored, not extracted. It used to be pulled out of the printed A2
PDF and then *redacted*, because the printed sheet bakes in things that are
really game state -- the steward's name and faction, the support, the castle
glyphs, the settlement letters -- and an app that draws them a second time as
an overlay has two copies of the same fact. Redaction was the wrong instrument
twice over: it painted an opaque rectangle over each cell rather than removing
anything, so the sheets came back with brown blocks patched over them, and it
takes out everything a rectangle so much as touches, so it ate the shire names
around the frames it was aiming at. "North Mercia" came back as "North ".

The artist supplied clean sheets instead: terrain, coastline, borders and sea,
and nothing else. Nothing on them says anything about the game, so nothing on
them can go stale, and the overlay owns the whole board rather than patching
holes in a picture. That is why this file installs artwork instead of deriving
it -- the drawing is a drawing, and the only thing worth generating from it is
where things sit.

So the job here is small: copy the three sheets into `assets/maps/` with a
provenance line, and write `assets/maps/cells.json` -- the manifest saying,
per shire, where its steward frame, support strip, castle stack and settlement
anchors belong, plus the greyed off-sheet frames a neighbour is repeated in.
Coordinates come from `data/geometry.json`, which is A2 at 72dpi (the 1191x1684
viewBox) because that is the space the geometry was transcribed in. The sheets
keep their own 300dpi viewBox; `rb-map` places one inside the other, so the two
resolutions never have to be reconciled anywhere but there.

The artwork is not committed -- see the `raw/` entry in .gitignore:

    py -3 tools/export_maps_svg.py

Writes assets/maps/{northern,western,eastern}.svg and assets/maps/cells.json.
"""

import json
import re
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
RAW = ROOT / "raw"
GEOMETRY = ROOT / "data" / "geometry.json"
SHIRES = ROOT / "data" / "shires.json"
OUT = ROOT / "assets" / "maps"

# The sheet the game calls it, and the file the artist named it.
SHEETS = {
    "northern": "Raven Banner Maps north.svg",
    "western": "Raven Banner Maps west.svg",
    "eastern": "Raven Banner Maps east.svg",
}

# The geometry layer's viewBox, rounded up from the A2 page at 72dpi.
VIEW_BOX = (1191, 1684)

# How far a castle stack may sit beside a frame, in points. The printed sheet
# stacks them in a single column just off the frame's right edge; the cell is
# wider than that so a shire that gains castles has somewhere to put them.
CASTLE_STRIP = 90

# The greyed off-sheet frames, transcribed from the printed sheets.
#
# A shire on the edge of one sheet is repeated on its neighbour, greyed and
# short, so a player looking at one corner of England can see who holds the
# ground across the border without turning to another sheet. These used to be
# found by hunting the PDF for 172x57 rectangles and reading the name nearest
# each one; nothing reads the PDF any more, and twelve rectangles are not worth
# a detector. They are in the same points as the frames in geometry.json, and
# were read off the same sheets, so a retrace moves both together.
GHOSTS = {
    "northern": {
        "magonsets": (150, 1562, 321, 1619),
        "south_mercia": (516, 1615, 688, 1672),
        "middle_anglia": (764, 1614, 935, 1671),
    },
    "western": {
        "wrekinsets": (291, 123, 463, 180),
        "north_mercia": (713, 225, 885, 282),
        "middle_anglia": (982, 683, 1154, 740),
        "sussex": (999, 1260, 1171, 1317),
    },
    "eastern": {
        "lindsey": (285, 246, 457, 303),
        "north_mercia": (20, 297, 192, 354),
        "south_mercia": (11, 700, 184, 758),
        "redding": (56, 1054, 228, 1112),
        "wiltshire": (21, 1265, 193, 1322),
    },
}


# Where each coastal shire's ship number is moored, in the same points as the
# frames above.
#
# The printed sheets drew the number on a little boat out in the water, and
# nothing transcribed where those boats were, so these were found rather than
# read off: each sheet was rendered at this resolution, the sea picked out by
# the two blues the artist used for it, and each shire's outline walked for the
# longest stretch whose seaward side is open water -- its beach rather than its
# borders. The midpoint of that stretch, pushed out into the water, is what is
# written here.
#
# Kept as a table rather than as the code that found it. That code wanted a
# browser to rasterise with and an imaging library to read the pixels back,
# which is a great deal of machinery to carry in a build tool for twelve pairs
# of numbers that only move if the artwork is redrawn -- and if it is redrawn,
# these want checking by eye anyway. Same bargain as GHOSTS above.
SEA_ANCHORS = {
    "bernicia": (554, 255),
    "jorvik": (952, 710),
    "lindsey": (1082, 1049),
    "ribble": (77, 809),
    "wrekinsets": (63, 1178),
    "hwicce": (261, 1109),
    "wiltshire": (689, 1472),
    "west_country": (110, 1142),
    "east_anglia": (861, 247),
    "essex": (861, 1026),
    "kent": (990, 1282),
    "sussex": (543, 1503),
}


def provenance(source: str) -> str:
    return (
        f"Generated by tools/export_maps_svg.py from {source} at "
        f"{datetime.now(timezone.utc):%Y-%m-%dT%H:%M:%SZ}. Do not hand-edit."
    )


def cells_for(geo: dict, sheet: str, shipcost: dict) -> dict:
    """Where each shire's cells belong on this sheet, keyed by shire id.

    The frame is transcribed; everything else hangs off it in the same
    arrangement the printed sheet used, so a player who has played on paper
    finds the support under the name and the castles beside it.
    """
    cells = {}
    for sid, shire in geo["shires"].items():
        if shire["sheet"] != sheet:
            continue
        fx0, fy0, fx1, fy1 = shire["frame"]
        cells[sid] = {
            "frame": {"x0": fx0, "y0": fy0, "x1": fx1, "y1": fy1},
            # Two rows now: the crowns this ground answers to, and whether one
            # of them is actually behind the man holding it, spelled out.
            "support": {"x0": fx0, "y0": fy1, "x1": fx1, "y1": fy1 + 32},
            "castles": {"x0": fx1, "y0": fy0, "x1": fx1 + CASTLE_STRIP, "y1": fy1},
            "settlements": [
                {"x": x, "y": y,
                 "x0": x - 18, "y0": y - 16, "x1": x + 18, "y1": y + 18}
                for (x, y) in shire.get("settlements", [])],
        }
        # Only for a shire the sea can reach. A landlocked one has no ship
        # value to print, so it gets no mooring and the renderer draws nothing.
        # Checked against the data rather than trusted: a mooring for a shire
        # with no ship value, or a coastal shire with nowhere to moor, means
        # the table above and the sheets have drifted apart.
        moored = SEA_ANCHORS.get(sid)
        if (moored is None) != (shipcost.get(sid) is None):
            raise RuntimeError(
                f"{sid}: shipCost is {shipcost.get(sid)!r} but "
                f"{'a' if moored else 'no'} mooring is transcribed")
        if moored:
            cells[sid]["sea"] = {"x": moored[0], "y": moored[1]}
    cells["ghosts"] = [
        {"shireId": sid, "x0": x0, "y0": y0, "x1": x1, "y1": y1}
        for sid, (x0, y0, x1, y1) in GHOSTS[sheet].items()]
    return cells


def install(source: Path, sheet: str) -> str:
    """The artist's sheet, sized, stamped and otherwise untouched.

    The files are authored at `width="100%" height="100%"`, which is fine for a
    sheet opened on its own and no use at all to something embedding it: a
    percentage of nothing leaves the image with no intrinsic size, and every
    consumer then guesses differently -- MuPDF hands back a US Letter page.
    Giving it the size its own viewBox already claims makes the guess
    unnecessary without changing a single coordinate in the drawing.
    """
    svg = source.read_text(encoding="utf-8")
    open_tag = re.search(r"<svg\b[^>]*>", svg)
    if not open_tag:
        raise RuntimeError(f"{source.name}: no <svg> element")

    box = re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', open_tag.group(0))
    if not box:
        raise RuntimeError(f"{source.name}: no viewBox to take a size from")
    width, height = box.group(1), box.group(2)

    sized = open_tag.group(0)
    for name, value in (("width", width), ("height", height)):
        if re.search(rf'\b{name}="[^"]*"', sized):
            sized = re.sub(rf'\b{name}="[^"]*"', f'{name}="{value}"', sized, count=1)
        else:
            sized = sized.replace("<svg", f'<svg {name}="{value}"', 1)

    # After the doctype rather than at the top of the file: a comment before
    # the XML declaration is not well-formed XML, and these are parsed as XML.
    stamped = f"<!-- {provenance(f'raw/{source.name}')} -->\n{sized}"
    return svg[:open_tag.start()] + stamped + svg[open_tag.end():]


def unchanged(existing: Path, fresh: str) -> bool:
    """Whether the only thing that would move is the timestamp.

    Re-running this to pick up a change to the cells should not rewrite three
    megabytes of untouched artwork, which is a diff nobody can read and a
    revision nobody can bisect.
    """
    if not existing.exists():
        return False
    strip = re.compile(r"<!-- Generated by [^>]*-->\n?")
    return strip.sub("", existing.read_text(encoding="utf-8")) == strip.sub("", fresh)


def main() -> None:
    geo = json.loads(GEOMETRY.read_text(encoding="utf-8"))
    shipcost = {sid: s.get("shipCost") for sid, s in
                json.loads(SHIRES.read_text(encoding="utf-8"))["shires"].items()}
    OUT.mkdir(parents=True, exist_ok=True)

    manifest = {"_generated": provenance("data/geometry.json"),
                "_doNotEdit": True, "viewBox": VIEW_BOX, "sheets": {}}
    for sheet, filename in SHEETS.items():
        manifest["sheets"][sheet] = cells_for(geo, sheet, shipcost)
        svg = install(RAW / filename, sheet)
        target = OUT / f"{sheet}.svg"
        if unchanged(target, svg):
            note = "artwork unchanged, left alone"
        else:
            target.write_text(svg, encoding="utf-8")
            note = f"{len(svg):,} bytes from {filename}"
        cells = manifest["sheets"][sheet]
        moored = sum(1 for k, v in cells.items() if k != "ghosts" and "sea" in v)
        print(f"{sheet}.svg: {note}; {len(cells) - 1} shires, "
              f"{len(GHOSTS[sheet])} ghosts, {moored} moorings")

    (OUT / "cells.json").write_text(
        json.dumps(manifest, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
