# The Raven Banner Online — Agent Guide

A browser client for *The Raven Banner*, a 12–16 player megagame set during the
Danish invasion of England in 871 AD. Two facilitators and up to sixteen players
join from their own machines, talk on voice elsewhere, and play five turns of
four phases through this app. One facilitator's browser tab is the authoritative
host; everyone else is a client over PeerJS.

The paper game is finished and published — v1.1 PDFs live at
`C:\Art and Design\Raven Banner\1.1.0\The Raven Banner v1.1\Home Printing`.
This repo does not invent rules. It implements them.

## This repo is not part of the vellum fleet

`C:\Coding\AGENTS.md` describes vellum and the seven games that pin it. This is
not one of them, any more than `kgd-webpage` is. Determinism tiers, vellum crate
pins, `fleet-ci.yml`, the golden/fixture/trace naming convention and the bump
ceremony **do not apply here**. The single fleet convention this repo adopts is
**PASM**, consumed by rev from vellum and validated in CI.

## Tech stack

| Layer | Technology |
|---|---|
| Client | Vanilla ES modules, no bundler, no framework. Custom elements prefixed `rb-`. |
| Transport | PeerJS (vendored at `vendor/peerjs.min.js`, not CDN), star topology, host-authoritative |
| Rules engine | Plain JS under `gui/rules/` — pure, DOM-free, no network imports |
| Static data | Generated JSON under `data/` |
| Tests | vitest (+ jsdom per-file for components) |
| Architecture model | PASM — YAML under `pasm/spec/`, tool pinned from vellum |
| Rules of record | gamespec, at `C:\AnalogueGames\analogue-projects\GameProjects\raven_banner` |
| Hosting | GitHub Pages, from the `gh-pages` branch, published by CI |

There is deliberately no build. What is committed is what is served, byte for
byte. For a three-hour live event with sixteen strangers on sixteen networks, a
zero-build deploy is the single biggest reliability win available.

The `gh-pages` branch is generated, never edited by hand and never checked out.
CI assembles it from `index.html`, `host.html`, `gui/`, `data/`, `assets/` and
`vendor/` after both gates pass, and force-pushes. That is a copy, not a build:
nothing is transformed. It exists so a failing commit cannot reach players, and
so the model, the tests and the transcription tools are not served to them.
**Adding a runtime file means adding it to the copy list in
`.github/workflows/ci.yml`, or the live site will 404 on it.**

## The three laws

**1. Rules purity.** `gui/rules/**` imports nothing from `gui/net/**`,
`gui/host/**`, `gui/client/**`, or the DOM. It is pure functions over
`(state, data, …)`. Static data is always passed in as an argument, never
reached for as a module global, so tests can inject fixtures. This is what makes
the rules testable in Node and shareable between the host (which enforces them)
and the clients (which use them to grey out buttons). `pasm scan` gates the
dependency edges; a lint test gates the imports.

**2. Redaction.** Nothing leaves the host except through `projectView()` in
`gui/rules/views.js`. What each recipient may see is declared once, as data, in
the `FIELD_VISIBILITY` manifest in `gui/rules/visibility.js`. Never hand-filter
an object at a send site. `tests/rules/redaction.test.js` enforces both halves:
no secret reaches a seat the manifest does not grant it, **and** every path in a
fully-populated state has a manifest entry. That second check is the point — a
new field is a test failure by default rather than a silent leak.

**3. Everything goes through the reducer.** Including facilitator overrides.
`facilitator:set` is a command like any other; its `admit` returns true
unconditionally and its log entry is tagged `override: true`. That keeps the
whole game replayable from `(seed, log)` and keeps "what did the umpire change?"
answerable.

## Generated files — do not hand-edit

`data/*.json` and `tests/vectors/*.json` are generated from the gamespec project
at `C:\AnalogueGames\analogue-projects\GameProjects\raven_banner` by
`tools/export_web_data.py`, `tools/export_map_geometry.py` and (later)
`tools/export_vectors.py` **in that repo**. Each file carries a `_generated`
provenance line naming the `analogue-projects` commit it came from, and
`_doNotEdit: true`. `assets/maps/*.png` are rendered from the map PDFs the same
way. To change any of them, change the authored gamespec module and re-export.

`data/geometry.json` is kept apart from the rules data on purpose. It holds
where things sit on the printed maps — shire outlines and settlement anchors —
so that `map.gamespec.md` stays a readable rules document instead of a few
hundred lines of SVG path data, and so re-tracing the artwork never touches the
rules. Its coordinates are in PDF points against a 1191×1684 viewBox, which is
the aspect the map images were rendered at, so an SVG overlay lines up with the
image at any display size.

The gamespec project is the specification of record; `gui/rules/` is the
implementation. They are two languages and they will drift unless something
stops them, so the Python mechanisms generate conformance vectors that
`tests/rules/vectors.test.js` replays against the JS. A rules disagreement is
therefore a failing test, not a bug report from a player mid-game.

## Common commands

```bash
serve.bat                       # run it locally — the consoles fetch JSON,
                                # so file:// gets you a blank page
npm test                        # vitest
npm run data:validate           # the published checksums and structural integrity
uv run pasm validate pasm/spec  # spec integrity
uv run pasm scan pasm/spec      # observed-vs-declared dependency edges
```

`tools/map-check.html` draws `data/` over the printed maps so a misread shire is
visible at a glance. It needs the repo served over http rather than opened from
disk, because it fetches JSON.

In the gamespec project (note: `python3` on this box is usually `py -3`):

```bash
py -3 spec/tools/check_all.py source
```

## PASM — keep it up to date

Model first, then build. Record accepted choices as `decision` entities in
`pasm/spec/core/foundation.yaml`. Run `uv run pasm validate pasm/spec` after any
model change and fix before committing. Never leave dead spec.

Gotchas, both of which produce confusing errors:

- A PASM YAML string containing `": "` must be quoted, or validation fails with
  `invalid-list-item ... must be a string`.
- The parser accepts only map/seq/str/bool YAML tags. **There are no integers.**
  Write `castles: "3"`, not `castles: 3`.

## Design notes worth knowing before you change things

- **The facilitator is trusted.** They are the umpire in the paper game, they
  wrote the briefs, and they hold the only copy of state. That is why secret
  tactic cards need no commit-reveal scheme: the host legitimately sees
  everything, and the redaction layer is what stops it reaching other *players*.
- **The whole game lives in one browser tab.** Host crash recovery has three
  independent layers: a deterministic peer id derived from the join code (so
  clients reconnect unaided), a debounced localStorage autosave, and a
  downloadable save file. Do not weaken any of them.
- **Derived values are never stored.** Support, effective adjacency, income and
  the four Aftermath counters are computed by `gui/rules/derive.js` on demand.
  Storing them is how the map and the tracker come to disagree.
- **Lead the Charge is a ratchet.** The paper rule lets a player switch their
  declaration after seeing their opponent, which sounds like it loops forever.
  It does not, because you may only switch *to* leading, never away. Admission
  rejects `true → false`, so amend rounds reach a fixpoint after at most two
  flips. See `pasm/spec/architecture/clash-protocol.yaml`.
