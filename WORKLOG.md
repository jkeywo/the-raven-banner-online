# Raven Banner Online — work log & master fix plan

This file is the shelf of record for the ongoing streaming-plan work. The session
that produced it was compacted (the grill-me transcript was lost); this document
exists so a later session can pick the work up from a stable note. It is the
record of **what was asked**, **what was decided**, and **what is already in the
working tree**, updated as work progresses.

Nothing here changes the rules of record (the gamespec at
`C:\AnalogueGames\analogue-projects\GameProjects\raven_banner`). It records what
the browser client must do.

---

## The nineteen asks

The source material is a single list of nineteen items a player/facilitator
reported. The JS always numbers them 1–19. The rules for reach/token targeting
and trade gating are authoritative in the gamespec; where the paper rules are
silent, the app picks something and records it in the host's "Where the rules
are silent" panel.

| # | Ask | Stream |
|---|-----|--------|
| 1 | Delete a saved game from the resume list | host console |
| 2 | Remember your seat on refresh | single-PC testing |
| 3 | Support multiple seats on one PC for testing | single-PC testing |
| 4 | Player Name, turn, phase, timer embedded in the top bar | player layout |
| 5 | One too many layers of border | player layout |
| 6 | Actions filtered by phase — can't trade with the market in team phase | rules |
| 7 | "The board" split into maps; a row of buttons between the two side panels | player layout |
| 8 | Map starts blank with interactive icons/dropdowns overlaid; map side panel obsolete | map rework |
| 9 | Discord bot for channels/roles/voice | out of repo |
| 10 | Rules on which shires an initiative token can target | rules |
| 11 | Max one token per player | rules |
| 12 | Facilitator battle screen shows current selected targets in Team Phase | battle |
| 13 | Placing an initiative token = automatically attacking that shire | rules |
| 14 | Players each click to roll their own die | rules |
| 15 | Once all pairs are in battle, autoresolve | rules |
| 16 | The token holder chooses who gets the conquered shire after a win | rules |
| 17 | Crowns/homage doesn't show who swore fealty to whom | crowns display |
| 18 | Facilitator Debrief is filled throughout the game, not just at the end | host console |
| 19 | Game records state action-by-action; a replay screen shows the whole of England, aftermath scores, clickable role panels | replay |

---

## Master plan (grouper → vertical slices)

The fixes were grouped into six workstreams so the flow of every change is the
same: rules first in `gui/rules/*` (pure, tested), UI in `gui/components/*`,
surfaced via `index.html`/`host.html`. No build step — any runtime file added
must join the copy list in `.github/workflows/ci.yml`.

- **A — Rules engine** (`gui/rules/`), tests-first: phase-gate trade, initiative
  targeting + one-token, placing-a-token-attacks, individual rolls + auto-resolve,
  conqueror names the steward.
- **B — Host console**: delete a game, live debrief-throughout.
- **C — Player console layout**: top-bar name/turn/phase/timer, border cleanup,
  board→three maps between the rails, blank+interactive map.
- **D — Single-PC testing**: remember seat on refresh, `?seat=N` test seats.
- **E — Crowns/fealty display.**
- **F — Replay screen.**
- **G — Discord bot** — lives in a **separate repo**, not here.

---

## Locked decisions, with rationale

These were answered one at a time (grill) and are binding. They exist so the
HITL items could become AFK-able; nothing below needs a human later.

1. **Token targeting (item 10): reachability/adjacency.** A holder may only
   target a shire they can reach — reuse `reachableFrom(state, data, roleId)`,
   the same rule `join-battle` already enforces. (Not "adjoining only".)
2. **Trade out of team (item 6): `trade` (market) leaves the Team Phase;**
   player-to-player deals — `give`, `offer/answer/cancel-contract` — stay
   team-able **but only between teammates in the Team Phase** (same `factionId`
   / team), unrestricted in maintenance/encounter.
3. **item 16: the initiative holder names the new steward**, from
   **their own console** (player-side choice), not the facilitator. The facilitator
   only facilitates the dropdown. New player command `name-new-steward`; the
   `settle-battle` flow reads the holder's pick first.
4. **item 8: full-vector map.** The user supplies SVGs if the PDFs aren't enough.
   Sub-decision (Q1): the vector art is **derived from the raw PDF** via a
   generator, not hand-drawn — so slice 15 becomes AFK. "Blank" means blank-until-it-
   differs-better (a shire shows no tint/icons until the game moves the printed
   state). The baked glyphs (settlement letters, steward/support frames, castle
   glyphs) that the PNG art bakes in must be **stripped** so the overlay draws
   them once, live and interactive.
5. **item 9: the Discord bot lives in a separate repo**, connected to the game
   by an event bridge added to the host. This repo only carries the
   `docs/discord-integration.md` contract + the host bridge.
6. **item 19 replay screen (Q5): a standalone `replay.html` page.** It reuses
   the host's save-open flow (file import / resume). The three sheets
   (northern/western/eastern) are shown side by side as a "whole England" view;
   a scrub bar walks the `(seed, log)`;
   Aftermath counters live; clickable role panels.
7. **Replay renderer (Q6): the replay's whole-England view uses the converged
   `cells.json` single-canvas renderer from slice 15** — **not** the PNG
   triptych. Slice 16 (replay) runs **after** slice 15 (map rework) and shares
   its state-driven overlay. See "open / resolved branches" below.
8. **Discord event feed (Q9): the host gets an outbound event pump.** After each
   command the host already recomputes per-seat projections (host-peer.js
   `viewFor`); the bridge hooks that same "something changed" moment to emit
   higher-level events (turn/phase, roster joins, clash/shore movements) as
   line-delimited JSON over `ws://` or an HTTP POST, consumed by the
   separate-repo bot. The bot is de-coupled, testable offline, and this repo's
   deliverables are the pump + `docs/discord-integration.md` + the
   events→channels/roles mapping. No rules-engine automation.
9. **Replay action history (Q7): labelled commands.** Each command in the
   `COMMANDS` registry gains a `label` field (pure data, covered by the
   rules-purity tests); the replay renders `label` + `verb` + phase + role per
   step, with colour-coded facilitator overrides. No prose narration layer.
10. **Replay scrub (Q8): checkpointed.** Snapshot state every N entries as the
    replay walks forward; back-steps and jumps recompute from the nearest
    checkpoint. Bounded memory, no O(n²) blowup.
11. **Interactive map editing (Q10): inline selection editor.** The map is the
    selection surface; a compact editor appears only for the selected shire
    (reusing `rb-shire-editor` + the existing `rb-shire` event). No
    always-visible widgets, no hover-reveal.
12. **Replay role panels (Q11): reuse `rb-private-sheet`.** The role rail mounts
    the existing private sheet per role at the current cursor, on demand only.
    No new summary-card representation that could drift from the player's sheet.
13. **Discord spec scope (Q12): event schema + mapping only.** This repo's
    `docs/discord-integration.md` pins the pump's wire formats, the roster data,
    and a recommended events→channels/roles/voice mapping. The bot's commands,
    config format, and deployment stay in the bot repo.

---

## Resolved decision branches (grill continued post-compaction)

The grill resumed on the branches left open when the session was compacted. All
are binding and AFK-able unless marked OPEN.

### Replay screen (slice 16/17)

- **Map renderer for the replay's whole-England view — RESOLVED (Q6).** Use the
  converged `cells.json` single-canvas renderer from slice 15; the replay does
  **not** reuse the PNG `rb-map` triptych. Slice 16 therefore runs after slice 15
  and composes that shared renderer into the three-sheet whole-England canvas.
- **Action rendering — RESOLVED (Q7).** The replay's step history is rendered
  from **`label` fields added per command in the `COMMANDS` registry**, shown
  alongside `verb`, phase, and role. Because the labels live in the rules
  registry, they stay covered by the rules-purity tests (labels are pure data,
  not effects). Compact payload summary + colour-coded facilitator overrides.
  No full prose narration layer.
- **Read/step performance — RESOLVED (Q8).** Checkpointed scrub. Cache a state
  snapshot every N entries as the replay walks forward; stepping back jumps to
  the nearest checkpoint and replays forward from it. Scrub-bar jumps recompute
  from the nearest checkpoint. Bounded memory, no O(n²) blowup; forward steps
  stay O(1) via `apply`. Pure UI caching — the rules engine is untouched.
- **Clickable role panels — RESOLVED (Q11).** The replay's role rail reuses
  **`rb-private-sheet`**: the revisitor lists the in-play roles and clicking one
  mounts that role's existing sheet against the state at the current cursor,
  mounted on demand only. No new summary-card representation, so a panel cannot
  disagree with what a player sees on their own sheet.

### Interactive map editing (item 8 / slice 15)

- **Per-shire control model — RESOLVED (Q10).** The map is the selection
  surface; a compact **inline selection editor** appears only when a shire is
  selected (reusing the existing `rb-shire-editor` component internally, itself
  driven by the `rb-shire` event rb-map already emits). Keeps the "starts blank,
  draws only when it differs" look; the shire side panel is retired. The map is
  not permanently covered in dropdowns (no always-visible widgets, no
  hover-reveal).

### Discord (item 9)

- **Event feed — RESOLVED (Q9).** Host-side outbound pump (see decision #8
  above).
- **Spec scope — RESOLVED (Q12).** `docs/discord-integration.md` pins the **event
  schema + mapping only**: the pump's wire formats (ndjson/HTTP payload shapes),
  the roster data they carry, and a **recommended** events→channels/roles/voice
  mapping per phase. The bot's command surface, config file format, and
  deployment stay with the separate bot repo. This repo implements the stream;
  it does not own the bot.

---

## Work already in the working tree (this file, uncommitted)

The map-art foundation for **item 8 / slice 15** was built in-session and is
**uncommitted**. It retires the last HITL dependency of the vector map.

- `tools/export_maps_svg.py` — reads the raw PDF
  (`raw/Raven Banner Maps A2 v1.1.pdf`), emits vector sheets
  `assets/maps/{northern,western,eastern}.svg` (viewBox `0 0 1191 1684`,
  provenance-stamped), **strips the baked static info cells** (settlement
  letters, steward/support frames, castle glyphs, ghost frames) by blanking them
  to the surrounding parchment, and writes `assets/maps/cells.json`, a per-shire
  manifest of where replacement glyphs go
  (frame/support/castles/settlements + ghosts). `--review` writes side-by-side
  review pages to `tools/review/`. `raw/` is gitignored.
- `assets/maps/*.svg` and `assets/maps/cells.json` exist, verified consistent.
  `rb-map` still uses the PNGs until slice 15 reworks it.

Also modified in the working tree, uncommitted (each should be reviewed and
committed on its own, since these conflate rules/trade gating, the map work, and
precompaction partial edits):
- `.gitignore` — updated for the `raw/` map sources.
- `gui/rules/commands.js`, `gui/components/rb-action-list.js`,
  `gui/components/rb-facilitator-grid.js`, `gui/client/player-app.js`.
- `tests/rules/facilitator-overrides.test.js`, `tests/components/clock.test.js`
  (modified), and untracked `tests/components/facilitator-grid.test.js`,
  `tests/components/player-target.test.js`.
- Untracked assets: `assets/maps/{northern,western,eastern}.svg`,
  `assets/maps/cells.json`, `tools/review/`, `tools/export_maps_svg.py`.

The replay implementation (`replayTo` in the reducer, `replay-app.js`,
`replay.html`) was **planned but never written** — the tool edit that started it
was aborted when the user reverted to grilling, so slice 16 is still pending.

---

## Architecture improvements (from `ArchitectureWork.md`)

A deepening pass over `gui/` found four refactors. They are recorded here so
they can be picked up as implementation work; they are the one place the worklog
branches from the bug-fix stream. All four sit inside `gui/rules/*` /
`gui/client/*` / `gui/components/*` and are AFK-able (no HITL decisions). None of
them changes the observable `COMMANDS` interface, so callers are untouched; each
should be landed as its own reviewed commit, with its rules-purity/lint tests
kept green throughout.

### 1. Locate the verb in one place — `fields`/`label`/`note`/`probe` onto the command spec
- **Files** — `gui/rules/commands.js`, `gui/client/action-chooser.js`,
  `gui/components/rb-action-list.js`.
- **Problem** — presentation is fragmented across three files: `fieldsFor()` is
  a ~300-line switch on verb; `LABELS`/`NOTES`/`NEEDS_CHOICE` are three more
  verb-keyed tables; `probe` is a fourth hand-written "representative legal
  instance". A missing `NEEDS_CHOICE` entry silently sends an empty payload
  instead of failing a test — the same silence the `FIELD_VISIBILITY` manifest
  is designed to close.
- **Do** — move `label`, `note`, `fields` onto the command spec. `fields` is
  `(state, data, roleId) => FieldDescriptor[]` reusing the chooser's descriptors;
  derive `probe` from the first option of each field rather than writing it
  twice. `action-chooser.js` shrinks to the render + `payloadFrom`;
  `rb-action-list` reads labels off the registry. Add a completeness test that
  every non-trivial command declares `fields` (mirroring `FIELD_VISIBILITY`
  fail-closed).

### 2. Split `commands.js` (2,090 lines, 53 commands) by domain
- **Files** — `gui/rules/commands.js`.
- **Do** — split into `commands/` using the game's own seams (lobby, feudal,
  contracts, consent, battle, envoy, facilitator), each exporting a fragment
  merged into one `COMMANDS` object. Keep the public interface identical. Move
  module-level helpers (`resolveConsent`, `swearTo`, `activateContract`,
  `rebellionCost`, `resolveVote`, `neighbourStewards`) next to the verbs that
  use them.

### 3. Consent adapters need a seam
- **Files** — `gui/rules/commands.js` (`resolveConsent`).
- **Do** — let a consent `kind` declare its own `carry(draft, data, request)`;
  `resolveConsent` decides *whether* it carried and delegates *what it means*.
  Removes the `request.kind` early-return branching; the next agreement type
  (a crown vote is already visible) adds one function, not a branch.

### 4. Move `epilogue()` out of `derive.js`
- **Files** — `gui/rules/derive.js`.
- **Do** — split `epilogue()` into its own module that imports `derive`. `derive.js`
  keeps "what is true of the board now"; the report (facilitator notes, resource
  counts, per-player narrative) lives separately so the growing debrief doesn't
  grow `derive` with it.

The two deliberately-not-listed seams (`FIELD_VISIBILITY` manifest and the
session seam) stay as they are — deep interfaces with fail-closed tests.

---

## Not yet done — not started

Published to the tracker (jkeywo/the-raven-banner-online, `needs-triage`):

| Issue | Title | Blocked by |
|-------|-------|-----------|
| #3 | Gate market trades out of the Team Phase | — |
| #4 | Initiative tokens: reachable targets only; one token per player | — |
| #5 | Facilitator grid shows Team-Phase declared targets | — |
| #6 | Each player rolls their own die (with hidden rolls) | — |
| #7 | Conqueror names the new steward from their own console | — |
| #8 | Auto-resolve once all pairs are in | #6, #7 |
| #9 | Delete a saved game from the resume list | — |
| #10 | Facilitator debrief fills throughout the game | — |
| #11 | Homage web visible in the crowns panel | — |
| #12 | Remember your seat on refresh | — |
| #13 | Multiple seats on one PC for testing | — |
| #14 | Player name, turn, phase, timer in the top bar | — |
| #15 | Remove the extra border layer | — |
| #16 | Split the board into a three-map row | — |
| #17 | Refactor: locate the verb in one place | — |
| #18 | Full-vector interactive map | #16 |
| #19 | Refactor: split commands by domain | #17 |
| #20 | Refactor: consent carry seam | #19 |
| #21 | Refactor: move epilogue out of derive | — |
| #22 | Replay screen: whole-England overview | #18, #17 |
| #23 | Replay screen: clickable role panels | #22 |
| #24 | Host event pump and Discord integration spec | — |

Slices 1–18 are the feature stream (vertical); R1–R4 (#17, #19, #20, #21) are
the separate refactor track. Not yet implemented: none of the feature slices
have landed; the map-art foundation and initiative-target work in the tree are
uncommitted.

---

## Deploy / copy-list reminder

`gh-pages` is generated, never hand-written, never checked out. Adding a runtime
file (e.g. `replay.html`, a `gui/replay/` folder, any new `.js`) means adding it
to the copy list in `.github/workflows/ci.yml` or the live site 404s on it.

## Deploy-from source note

Nothing in this log changes the serving model. Serve via `serve.bat`; the
consoles fetch JSON, so `file://` yields a blank page. Validate before and after:
`npm test`, `npm run data:validate`, `uv run pasm validate pasm/spec`,
`uv run pasm scan pasm/spec`.

---

Last updated: 2026-08-05. Record of the sessions that built/planned this.

**Next carried-over step:** implement the four architecture improvements above
(independent of the bug-fix stream).