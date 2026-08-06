# PASM model

The architecture of this app, written down so a change can be checked against
what the system is supposed to be rather than only against what it currently
does. The tool lives in vellum and is pinned by rev in `../pyproject.toml` and
in the `uses:` line of `../.github/workflows/ci.yml` — the two must match.

```bash
uv run pasm validate pasm/spec
uv run pasm scan pasm/spec
uv run pasm scenario pasm/spec/scenarios/turn-one.yaml --spec-root pasm/spec
```

## Layout

| Path | What it holds |
|---|---|
| `spec/core/foundation.yaml` | The system entity and the four decisions everything else follows from |
| `spec/architecture/runtimes.yaml` | The two browser runtimes and their trust boundaries |
| `spec/architecture/networking.yaml` | Transport components, the four wire messages, and the two connection failures |
| `spec/architecture/state-and-views.yaml` | Authoritative state, the admission gate, the projector, and the restricted information sets |
| `spec/architecture/clash-protocol.yaml` | The clash state machine and the Lead the Charge ratchet decision |
| `spec/architecture/event-pump.yaml` | The optional outbound event stream, the spectator projection it is given, and why it is off unless a URL says otherwise |
| `spec/design/turn-one-slice.yaml` | Roles, verbs, the phase clock, and the five resources |
| `spec/scenarios/turn-one.yaml` | The vertical slice walked end to end, including a host loss and its recovery |

## Two things the validator taught us, worth not relearning

**Reveal conditions are facts, not prose.** An `information` entity's
`reveal_conditions` are checked against facts that earlier `action` steps
produced, so they must name a fact — `both-tactics-submitted` — rather than
describe one. The fact vocabulary is small and lives in the `produces_facts`
of the verbs in `design/turn-one-slice.yaml`.

**`requires_facts` belongs to a scenario step, not to an entity.** A verb
declares what it produces; a scenario step declares what must already hold when
it runs. Putting `requires_facts` on the verb is an unknown-field error.

Also: there are no integers in this dialect, and a string containing `": "`
must be quoted.
