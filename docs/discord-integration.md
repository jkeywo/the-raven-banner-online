# Discord integration — the host event stream

This document is the contract between **this repository**, which produces a
stream of game events, and **the Discord bot**, which lives in its own
repository and consumes them.

It pins two things and only two things:

1. **The wire.** How the stream is turned on, how it is framed, and the exact
   shape of every event. This half is binding. If the bot and the host disagree
   here, one of them is wrong, and a test in this repository parses the JSON out
   of this file and compares it against what the pump really emits — so if this
   document is wrong, CI here is red.
2. **A recommended mapping** of events onto Discord channels, roles and voice.
   This half is explicitly **not** binding. It is a starting point written by
   the people who know the game, offered so the bot's author does not have to
   infer the shape of a Raven Banner table from a schema.

Everything about the bot itself — its commands, its configuration, its
permissions, its deployment, whether it is one bot or three — belongs in the bot
repository and is deliberately absent here.

## Turning it on

The pump is **off in every default game**. It is enabled per browser tab, by
opening the facilitator's console with an `events` query parameter naming the
sink:

```
host.html?events=ws://localhost:8787/raven
host.html?events=https://bot.example/raven/events
```

No parameter means no pump object is constructed: nothing connects, nothing is
computed, nothing is logged, and the game behaves exactly as it does without
this feature. A parameter that will not parse, or names a scheme other than
`ws`, `wss`, `http` or `https`, is treated the same as no parameter at all.

Enabling is a property of the *tab*, not of the *game*. The URL is never written
to state, never enters the command log, and never reaches a save file — so it
cannot be replayed, cannot be restored, and cannot follow a save onto somebody
else's machine. The player link the console hands out is built from the origin
and path alone, so it never carries the parameter either. Restarting the console
without the parameter turns the integration off completely.

When the co-facilitator takes over hosting, the pump that applies is the one
belonging to *their* tab.

## Framing

Two transports, one payload.

| Sink scheme | Transport | Framing |
|---|---|---|
| `ws:` / `wss:` | WebSocket, client → server only | one text frame per state change, containing one or more `\n`-terminated JSON lines |
| `http:` / `https:` | `POST`, `Content-Type: application/x-ndjson` | one request per state change, body is one or more `\n`-terminated JSON lines |

The bytes are identical either way: newline-delimited JSON, every line
terminated including the last. A batch is the set of events derived from one
state change, so a single frame or body may hold several lines and a bot must
split before parsing.

The host never reads a reply. HTTP responses are discarded; any status is
treated as success, and only a transport-level failure is noticed. The bot must
not use the response body to talk back.

### Delivery is best-effort

The pump is a tap, not a queue. It is allowed to lose events and it will:

- Events derived while the WebSocket is down are buffered, up to 64 batches,
  and the oldest are dropped past that.
- A `POST` that fails is not retried.
- A closed socket is redialled lazily, on the next state change, at most once
  every five seconds. A bot that restarts mid-game will be reconnected by the
  next thing that happens in the game, not sooner.

`seq` exists so the bot can *see* a gap rather than be misled by one. On a gap,
re-derive from what the bot already knows or wait for the next `game.opened`;
do not attempt to ask the host, because there is no channel back.

## The envelope

Every line is an object with exactly these six keys, in this order:

```json
{"v":1,"seq":0,"at":1730000000000,"game":"RAVEN7Z","type":"game.phase","data":{"turn":1,"phase":"team","paused":false,"previousTurn":1,"previousPhase":"lobby"}}
```

| Key | Type | Meaning |
|---|---|---|
| `v` | number | Schema version. Currently `1`. A bot seeing a `v` it does not know should log the line and ignore it rather than guess. |
| `seq` | number | Monotonic from `0` for the life of one pump — that is, one facilitator tab. It restarts at `0` when the console is reloaded, so it identifies gaps within a session and nothing more. |
| `at` | number | Host wall clock, milliseconds since the epoch. The facilitator's machine's clock, not the bot's; useful for ordering, not for timing. |
| `game` | string | The join code. Present so a bot watching two tables at once can tell them apart. |
| `type` | string | One of the eight below. |
| `data` | object | Per-type, and documented per-type below. |

No other key will appear at the top level, and no key here is optional.

## What the stream may carry — and what it never will

An event may only carry information that is already **public inside the game**.
This is not a convention the pump tries to honour; it is the shape of what the
pump is given.

The host builds every outbound copy of the game through one projector, driven by
a single declarative manifest (`gui/rules/visibility.js`) that classifies every
path in state as public, owner-only, team-only, facilitator-only or nobody's.
The pump is handed a **spectator projection** — the projection for a viewer with
no seat, no role and no team — which that projector fills with the public paths
and nothing else. It is not given state. There is nothing for it to filter,
because the private fields are not present in its input at all.

Concretely, the following can never appear in an event, in any release, without
this document changing first:

- any player's silver, food, soldiers, ships, momentum, wounds or mercenary card
- an initiative target that has been declared at a team table but not announced
- a tactic card, a leadership declaration or a die that the clash has not
  revealed
- an envoy thread, or anything promised to a foreign court
- a seat token, the RNG seed or cursor, the command log, or facilitator notes

A player's chosen **display name** *is* public and does appear. It is the only
free text in the stream and it is typed by a stranger, so the bot must escape it
before rendering it anywhere and must never interpolate it into a command.

## Events

Eight types. Each is shown as a literal line as the host emits it; the values
are illustrative, the keys are the contract. Every `data` key listed is always
present — absent means `null`, not missing.

### `game.opened`

The first event of a pump's life: the position as it stands, so a bot that
attached late or restarted knows where it is. Not a replay — nothing before this
is retransmitted.

```json
{"v":1,"seq":0,"at":1730000000000,"game":"RAVEN7Z","type":"game.opened","data":{"turn":1,"phase":"lobby","paused":false,"seats":[{"seatId":"s1","name":"Alice","roleId":"cenred","kind":"player"}]}}
```

### `game.phase`

The turn, the phase, or the pause state changed. This is the event a bot maps to
voice. `previousTurn` and `previousPhase` are what it was a moment ago.

Phase names are `lobby`, `team`, `battle`, `maintenance`, `encounter`,
`epilogue`. Turns run 1 to 5.

```json
{"v":1,"seq":1,"at":1730000060000,"game":"RAVEN7Z","type":"game.phase","data":{"turn":1,"phase":"team","paused":false,"previousTurn":1,"previousPhase":"lobby"}}
```

### `seat.joined`

Somebody sat down in a chair nobody had. `roleId` is `null` until they claim
one. `kind` is `player` or `facilitator`.

```json
{"v":1,"seq":2,"at":1730000120000,"game":"RAVEN7Z","type":"seat.joined","data":{"seatId":"s2","name":"Bryn","roleId":null,"kind":"player"}}
```

### `seat.left`

That seat's connection went away. **The chair is still theirs** — this is not a
departure, and the same seat id will come back if they reload. A bot should not
strip a Discord role on this event.

```json
{"v":1,"seq":3,"at":1730000180000,"game":"RAVEN7Z","type":"seat.left","data":{"seatId":"s2","name":"Bryn","roleId":"guthrum_the_old","kind":"player"}}
```

### `seat.returned`

The same seat reconnected. Distinct from `seat.joined` on purpose: over three
hours a table produces many of these, and a bot that announced each one as an
arrival would be muted by the second turn.

```json
{"v":1,"seq":4,"at":1730000240000,"game":"RAVEN7Z","type":"seat.returned","data":{"seatId":"s2","name":"Bryn","roleId":"guthrum_the_old","kind":"player"}}
```

### `seat.role`

The role in a chair changed — claimed, released (`roleId` `null`), or reassigned
by a facilitator. This is the event that drives Discord role grants.

```json
{"v":1,"seq":5,"at":1730000300000,"game":"RAVEN7Z","type":"seat.role","data":{"seatId":"s2","name":"Bryn","roleId":"guthrum_the_old","kind":"player","previousRoleId":null}}
```

### `board.steward`

A shire changed hands. `stewardRoleId` is `null` when it is left unheld. Shire
and role ids are the ones in `data/shires.json` and `data/roles.json`, and they
are stable — the bot may key a static table off them.

```json
{"v":1,"seq":6,"at":1730000360000,"game":"RAVEN7Z","type":"board.steward","data":{"shireId":"lindsey","stewardRoleId":"halfdan_ragnarsson","previousStewardRoleId":"gainbeald"}}
```

### `battle.targets`

The announced list of shires under attack this turn, sent whole rather than one
at a time, because it is announced whole. Emitted again if the list changes, and
emitted as an empty list when the battle phase ends and it is cleared.

```json
{"v":1,"seq":7,"at":1730000420000,"game":"RAVEN7Z","type":"battle.targets","data":{"turn":2,"shireIds":["lindsey","essex"]}}
```

## Recommended Discord mapping

**Non-binding.** None of this constrains the bot; it is what the game's own
shape suggests. The bot repository owns every decision below and may ignore all
of it.

### Roles

| Discord role | Driven by |
|---|---|
| one per game role (`Guthrum the Old`, `King Alfred`, …) | `seat.role` — grant on the new `roleId`, revoke the `previousRoleId` |
| `Facilitator` | `seat.joined` / `seat.role` where `kind` is `facilitator` |
| `Dane` / `Saxon` | the team of the claimed `roleId`, which the bot can hold as a static table; the host does not send it |

Do not tie role grants to `seat.left` or `seat.returned`. A player who reloads
their browser has not stopped being Guthrum.

### Channels

| Channel | Fed by |
|---|---|
| `#table-talk` (text, everyone) | `game.phase`, as a phase banner |
| `#herald` (text, everyone, read-only) | `board.steward` and `battle.targets` — the public record of what moved |
| `#lobby` (text) | `seat.joined` only, and only before the first `game.phase` leaves `lobby` |

Nothing in this stream should ever be posted to a per-team or per-player
channel, because nothing in this stream is private. If a bot ever needs to
whisper, it needs a different source than this one.

### Voice, by phase

The phase is the room's shape, so `game.phase` is the one event worth wiring to
voice moves.

| `phase` | Suggested voice arrangement |
|---|---|
| `lobby` | everyone in one lobby channel |
| `team` | two channels, Danes and Saxons, members moved by their game role |
| `battle` | one channel per shire in the latest `battle.targets`, created on the event and torn down when the list empties; everyone else in a shared channel |
| `maintenance` | back to one channel — this is bookkeeping and people talk across the table |
| `encounter` | one channel per team again, plus a quiet channel a facilitator can pull one player into |
| `epilogue` | everyone in one channel |

When `paused` is `true`, leave people where they are and post a notice. A pause
is a facilitator holding the room, not a change of activity.

## Versioning

`v` is bumped when a field changes meaning, changes type, or leaves. Adding a
new `type` is **not** a version bump, so a bot must ignore types it does not
recognise rather than treating them as an error. Adding a key to an existing
`data` object is also not a bump, for the same reason: read the keys you know.

## Reading the stream offline

Because a batch is exactly the bytes a bot receives, a facilitator can capture a
game without a bot at all:

```sh
# any ws server that appends frames to a file, e.g.
websocat -s 8787 >> raven.ndjson
```

and then `host.html?events=ws://localhost:8787`. The resulting file is a valid
newline-delimited JSON log of the whole game's public history, replayable
through the bot's own parser at leisure. This is the intended way to develop the
bot without sixteen people in the room.
