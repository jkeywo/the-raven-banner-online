# The Raven Banner Online

An online interface for The Raven Banner, a megagame for 12–16 players and 2
facilitators set during the Danish invasion of England in 871 AD.

Play runs about three hours across five turns. Everyone talks on voice — Discord
or similar — and uses this app for the board, their private sheet, and the dice.

**Status: in development. Not yet playable.**

The current build is live at
**[jkeywo.github.io/the-raven-banner-online](https://jkeywo.github.io/the-raven-banner-online/)**
— players land on that page, facilitators want
[host.html](https://jkeywo.github.io/the-raven-banner-online/host.html). It is
published from `gh-pages` by CI, so whatever is up there is a revision whose
tests passed.

## Playing

**Players** open the link the facilitator gives you, enter your name, and claim
a role. Your sheet, your resources and your private brief are yours alone; the
three maps are shared. You will need a modern browser and a screen bigger than a
phone.

**Facilitators** open `host.html`, start a game, and share the join code. One of
you is the host — the game state lives in your tab, so keep it open, keep the
laptop plugged in, and turn off sleep. The second facilitator opens
`host.html?role=co` and acts as a warm standby.

The app enforces the rules for players: it will not let you spend silver you do
not have. It enforces nothing on facilitators, who can edit any value in the
game. That mirrors the paper game, where crown claims, rebellions, baptisms and
envoy negotiations all route through a human with final say.

## Rules

This app implements the published v1.1 rules. It is not a substitute for reading
them — the Players Guide is the thing that tells you what you are trying to do
and why. The app tracks the state and does the arithmetic.

## For developers

Vanilla ES modules, no build step. PeerJS star topology with the facilitator's
browser as the authoritative host. CI publishes the runtime files to the
`gh-pages` branch once the tests pass, so the live site is always a revision
that was green.

```bash
npm install
npm test
serve.bat        # then open http://localhost:8173/host.html
```

Opening `index.html` from disk will not work — the consoles fetch their data as
JSON, and browsers refuse that over `file://`. `serve.bat` exists for that one
reason.

See [AGENTS.md](AGENTS.md) for the architecture, the three invariants the
codebase is built around, and where the rules of record actually live.

The host can also stream a game's *public* events to a Discord bot that lives in
its own repository. It is off in every default game and turned on per tab with a
query parameter; [docs/discord-integration.md](docs/discord-integration.md) is
the contract, and a test in this repo checks the code against its examples.

## Licence

See [LICENSE](LICENSE).
