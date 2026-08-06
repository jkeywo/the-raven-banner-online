/**
 * gui/rules/commands/shared.js — the words every fragment speaks.
 *
 * A verb's spec belongs beside the other verbs about the same part of the
 * game, but a handful of things are not about any part of it: how a rule says
 * yes or no, whose role a command acts for, whether somebody can pay, and how
 * a person or a shire is named in a dropdown. Those are the vocabulary the
 * fragments are written in, so they live in one place rather than being copied
 * into each of them — a second `affordable` that rounded differently would be
 * a rules disagreement nobody would ever look for.
 *
 * Nothing here imports a fragment. The dependency runs one way, which is what
 * keeps the split from becoming a knot.
 */

export const ok = () => ({ ok: true });
export const no = (reason) => ({ ok: false, reason });

/** The role a command acts for: a player's own, or whoever a facilitator names. */
export function subjectOf(ctx) {
  return ctx.actor.kind === 'facilitator'
    ? ctx.cmd.payload?.roleId ?? ctx.actor.roleId ?? null
    : ctx.actor.roleId;
}

export function affordable(role, costs) {
  for (const [what, amount] of Object.entries(costs)) {
    if ((role[what] ?? 0) < amount) {
      return `not enough ${what} — you have ${role[what] ?? 0}, this costs ${amount}`;
    }
  }
  return null;
}

export function spend(role, costs) {
  for (const [what, amount] of Object.entries(costs)) role[what] -= amount;
}

export const pretty = (id) => id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Phases in which resources may change hands between players. Not during a
 * battle — and in the Team Phase, only within a team. See `dealingReason`.
 */
export const TRADEABLE_PHASES = ['team', 'maintenance', 'encounter'];

/**
 * Whether two characters answer to the same faction, and so sit at one table.
 *
 * Faction rather than the printed team, because homage moves it: a vassal's
 * lands and loyalties follow their liege, and so does who they may deal with
 * while the teams are sitting apart.
 */
export const sameFaction = (state, roleId, otherId) => {
  const faction = state.roles[roleId]?.factionId;
  return Boolean(faction) && faction === state.roles[otherId]?.factionId;
};

/**
 * Why a deal with this person cannot be struck right now, or null.
 *
 * The Team Phase is the one stretch of the turn a team spends alone with
 * itself, which is what makes the Encounter Phase worth anything: crossing the
 * lines is supposed to cost you the walk. So a gift or a bargain aimed outside
 * your own faction waits until the room is back together, while anything
 * inside it is the whole point of the phase.
 */
export const dealingReason = (state, roleId, otherId) =>
  (state.phase.name === 'team' && !sameFaction(state, roleId, otherId)
    ? no('the Team Phase is your own team\'s — deal with them in the maintenance or encounter phase')
    : null);

/*
 * -----------------------------------------------------------------------------
 * Presentation, and why it lives beside the rules.
 *
 * What a verb is called, the line under its button, and the questions it still
 * needs answered are all declared on the spec beside the `admit` they have to
 * agree with. They used to be three tables and a hand-written `probe` in two
 * other files, and they drifted: a verb could be added to the registry and
 * render as its own id at a player, or send an empty payload to a rule that
 * needed one, without a single test going red.
 *
 * `fields` is plain data — `{name, label, kind, options, min, max, value}` —
 * so this is still a pure rules module. The DOM that renders it stays in
 * `gui/client/action-chooser.js`, and nothing here knows that file exists.
 *
 * A field's options are always ones the game currently allows, which is what
 * lets `probe` be derived from them rather than written twice.
 */

/**
 * @typedef {object} Field
 * @property {string} name
 * @property {string} label
 * @property {'select'|'number'} kind
 * @property {{value: string, label: string}[]} [options]
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [value]
 */

export const roleName = (data, roleId) => data.roles.roles[roleId]?.name ?? roleId;

export const shireName = (data, shireId) => data.shires.shires[shireId]?.name ?? shireId;

/** Everyone else who is in the game, or only those a filter keeps. */
export const others = (state, data, roleId, keep = () => true) =>
  Object.values(state.roles ?? {})
    .filter((role) => role.id !== roleId && keep(role))
    .map((role) => ({ value: role.id, label: roleName(data, role.id) }));

/** The shires this player stewards, as options. */
export const stewarded = (state, data, roleId) => Object.entries(state.shires ?? {})
  .filter(([, shire]) => shire.stewardRoleId === roleId)
  .map(([id]) => ({ value: id, label: shireName(data, id) }));

/**
 * Whether this character is one to strike a bargain with right now.
 *
 * The same question `dealingReason` answers for the reducer, asked the other
 * way round: a dropdown offering a deal the rules would refuse is a dropdown
 * offering a refusal.
 */
export const dealable = (state, roleId, otherId) => !dealingReason(state, roleId, otherId);
