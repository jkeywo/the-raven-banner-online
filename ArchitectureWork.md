I explored directly rather than spawning a cold agent — I built this codebase this session and know where the friction is; re-deriving it would cost more and see less. Here's what I found.

## Deepening opportunities

**1. The verb is defined in three places — `commands.js`, `action-chooser.js`, `rb-action-list.js`**

- **Files** — [gui/rules/commands.js](gui/rules/commands.js), [gui/client/action-chooser.js](gui/client/action-chooser.js), [gui/components/rb-action-list.js](gui/components/rb-action-list.js)
- **Problem** — a command spec declares `phases`, `actor`, `admit`, `effects` and `probe`, but not what the player must *say* to issue it. So `fieldsFor()` is a 300-line switch on verb, `LABELS`/`NOTES`/`NEEDS_CHOICE` are three more tables keyed on verb, and `probe` is a fourth hand-written "representative legal instance". Every band this session touched all three files for every verb; Band D alone added five parallel entries per command. The Command Admission module is deep with respect to legality and shallow with respect to presentation — and the omission is silent, because a missing `NEEDS_CHOICE` entry produces a button that sends an empty payload rather than a test failure.
- **Solution** — move `label`, `note` and `fields` onto the command spec. `fields` is a function of `(state, data, roleId)` returning the same Field descriptors the chooser already uses; `probe` becomes derived from the first option of each field rather than written twice. `action-chooser.js` shrinks to the render function and `payloadFrom`; `rb-action-list` reads labels off the registry.
- **Benefits** — one verb, one place: locality per command instead of per file. The interface gains leverage — a console asks the registry "what can this actor do, and what does each still need?" and gets both. Tests improve most: a single completeness test can assert every non-trivial command declares fields, the way `FIELD_VISIBILITY` already fails closed on unclassified paths. Today nothing catches the omission.

**2. `commands.js` is 2,090 lines and 53 commands in one file**

- **Files** — [gui/rules/commands.js](gui/rules/commands.js)
- **Problem** — navigability, not depth. The registry's interface is excellent and should not change. But finding the contract commands means scrolling past the feudal ones, and the module-level helpers (`resolveConsent`, `swearTo`, `activateContract`, `rebellionCost`, `resolveVote`, `neighbourStewards`) now sit in one preamble far from their verbs.
- **Solution** — split into `commands/` by the domain's own seams — lobby, feudal, contracts, consent, battle, envoy, facilitator — each exporting a fragment merged into one `COMMANDS` object. The interface every caller sees is unchanged.
- **Benefits** — locality: a verb and the helpers only it uses live together. The deletion test says the registry earns its keep; this is about where the reader lands.

**3. Consent has two adapters and no seam**

- **Files** — [gui/rules/commands.js](gui/rules/commands.js) (`resolveConsent`)
- **Problem** — `state.consents` now carries Settle Shire and Saxon homage, and `resolveConsent` branches on `request.kind` with an early return per kind. Two adapters is the point at which a seam is real rather than hypothetical — and the third (a crown vote is nearly the same shape) is already visible.
- **Solution** — a consent kind declares its own `carry(draft, data, request)`; `resolveConsent` decides *whether* it carried and delegates *what that means*.
- **Benefits** — leverage: the next thing needing agreement adds one function instead of another branch in a shared one. Tests get to exercise a carry in isolation rather than through a whole consent round.

**4. `derive.js` has grown a second job**

- **Files** — [gui/rules/derive.js](gui/rules/derive.js)
- **Problem** — 460 lines. Support, crowns, reach, income and the four counters are one coherent thing: what is true of the board now. `epilogue()` is a different thing: a report assembled for one reader at one moment, including facilitator notes and resource counts nobody else reads.
- **Solution** — move `epilogue()` to its own module that imports `derive`.
- **Benefits** — modest, and honestly the weakest of the four. Worth it mainly because the debrief will grow (per-player narrative, comparison to history) and it will grow inside the module the whole game depends on.

**Two things I deliberately did not list**: the visibility manifest and the session seam. Both are deep as they stand — small interfaces, a lot behind them, fail-closed tests. And there's no ADR directory yet, so nothing here contradicts a recorded decision.

Which would you like to explore? My recommendation is **1** — it's the one that made every band this session more expensive than it needed to be, and the only one where the current design fails silently.