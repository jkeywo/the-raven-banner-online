/**
 * gui/rules/visibility.js — who may see what, declared once.
 *
 * Every path in the game state has exactly one entry here. Nothing else in the
 * codebase decides what a recipient may see, and no send site ever filters an
 * object by hand.
 *
 * That rule exists because the alternative fails open. Redaction spread across
 * send sites is correct until somebody adds a field, and then it silently
 * isn't — the new field just goes out. A manifest with a completeness test
 * fails closed instead: a path nobody has classified is a failing test, so the
 * default for anything new is "this breaks the build", not "this leaks".
 *
 * Patterns use `*` for one segment and a trailing `**` for a whole subtree.
 * Where several match, the most specific wins — an exact segment beats `*`,
 * and `*` beats `**`, then longer patterns beat shorter ones.
 */

import { STAGES, stageAtLeast } from './clash.js';
import { conqueringDeclaration } from './battle.js';

/** Everyone at the table. */
export const PUBLIC = 'public';
/** The owning role's seat, and nobody else's. */
export const OWNER = 'owner';
/** Everyone on the owning role's starting team. */
export const TEAM = 'team';
/** Facilitators only. */
export const FACILITATOR = 'facilitator';
/** Nobody: host-internal, never leaves the tab. */
export const NOBODY = 'nobody';

/** `roles.<id>.…` and friends: the role id is the segment after the head. */
const ownerAtIndex = (i) => (segments) => segments[i];

/**
 * The stages at or past a clash's reveal, derived rather than written out.
 *
 * A secret that is open must stay open, so each of these lists has to be a
 * suffix of the stage order. Three hand-maintained arrays are three chances to
 * insert a stage into two of them and leave a hole in the third — which is not
 * hypothetical: adding `rolls_revealed` did exactly that, briefly re-hiding
 * both tactic cards at the one stage where the dice were already public.
 */
const revealedFrom = (stage) => STAGES.filter((s) => stageAtLeast(s, stage));

export const FIELD_VISIBILITY = [
  // --- housekeeping --------------------------------------------------------
  { path: 'schemaVersion', audience: PUBLIC },
  { path: 'joinCode', audience: PUBLIC },
  // The seed and cursor would let a client predict every die still to come.
  { path: 'seed', audience: FACILITATOR },
  { path: 'rngCursor', audience: FACILITATOR },
  { path: 'log.**', audience: FACILITATOR },
  { path: 'lastSeq.**', audience: NOBODY },
  { path: 'facilitatorNotes.**', audience: FACILITATOR },
  // The battle phase's own channel, and facilitator-only for the same reason:
  // it is the umpire being told to move a counter the rules could not move
  // themselves. Separate from facilitatorNotes so the epilogue's ledger of
  // what the umpire changed stays a ledger of what the umpire changed.
  { path: 'battleNotes.**', audience: FACILITATOR },
  { path: 'phase.**', audience: PUBLIC },

  // --- seats ---------------------------------------------------------------
  // Who is here and who they are playing is public; the token that proves it
  // is the credential that resumes a seat, so it never goes anywhere. Note
  // that seats are keyed by a public seat id — a manifest can redact a value
  // but not a key, so a token could never have been one.
  { path: 'seats.*.id', audience: PUBLIC },
  { path: 'seats.*.name', audience: PUBLIC },
  { path: 'seats.*.roleId', audience: PUBLIC },
  { path: 'seats.*.kind', audience: PUBLIC },
  { path: 'seats.*.connected', audience: PUBLIC },
  { path: 'seats.*.lastSeen', audience: FACILITATOR },
  { path: 'seats.*.token', audience: NOBODY },
  // Keyed by token, so the keys themselves are the secret. Host-internal.
  { path: 'seatByToken.**', audience: NOBODY },

  // --- roles ---------------------------------------------------------------
  // Position is public; strength is not. Nothing in the printed rules requires
  // a player to disclose what they hold, and concealed strength is one of the
  // few levers a weak player has in a negotiation.
  { path: 'roles.*.id', audience: PUBLIC },
  { path: 'roles.*.liegeId', audience: PUBLIC },
  { path: 'roles.*.teamId', audience: PUBLIC },
  { path: 'roles.*.factionId', audience: PUBLIC },
  { path: 'roles.*.claims', audience: PUBLIC },
  { path: 'roles.*.baptised', audience: PUBLIC },
  // A conversion is a public event and its consequences are read off the
  // board, so both of these are everybody's business.
  { path: 'roles.*.deJureShires', audience: PUBLIC },
  { path: 'roles.*.baptismsPerformed', audience: PUBLIC },
  { path: 'roles.*.dead', audience: PUBLIC },
  // A man who is not the man he was three turns ago is not a secret. Everyone
  // watched the heir arrive.
  { path: 'roles.*.generation', audience: PUBLIC },

  // Whether you are holding mercenaries is exactly what an opponent would pay
  // to know before committing to a battle, so it stays yours until it is spent.
  { path: 'roles.*.mercenary', audience: OWNER, owner: ownerAtIndex(1) },

  { path: 'roles.*.momentum', audience: OWNER, owner: ownerAtIndex(1) },
  { path: 'roles.*.silver', audience: OWNER, owner: ownerAtIndex(1) },
  { path: 'roles.*.food', audience: OWNER, owner: ownerAtIndex(1) },
  { path: 'roles.*.soldiers', audience: OWNER, owner: ownerAtIndex(1) },
  { path: 'roles.*.ships', audience: OWNER, owner: ownerAtIndex(1) },
  { path: 'roles.*.wounds', audience: OWNER, owner: ownerAtIndex(1) },
  { path: 'roles.*.once.*', audience: OWNER, owner: ownerAtIndex(1) },
  { path: 'roles.*.perTurn.*', audience: OWNER, owner: ownerAtIndex(1) },

  // --- the board -----------------------------------------------------------
  // All of it public. Anyone could walk up to the paper maps and read them,
  // and the printed facilitator guide warns that standing at one tells the
  // room what you are thinking. That is a feature, so it is preserved.
  { path: 'shires.**', audience: PUBLIC },

  // --- the turn ------------------------------------------------------------
  // A target chosen at a team table, before it is announced. In the room this
  // is protected by the teams sitting apart; here the manifest does it. The
  // declaring role is inside the record, so both the audience and the reveal
  // condition read it out of state rather than off the path.
  // Who holds each of the three tokens is public — a counter sits in front of
  // somebody, in full view. All three are the same shape, a plain roleId or
  // null, so all three are the same kind of path.
  { path: 'initiative.white', audience: PUBLIC },
  { path: 'initiative.black', audience: PUBLIC },
  { path: 'initiative.bonus', audience: PUBLIC },
  {
    path: 'initiative.declared.**',
    audience: TEAM,
    owner: (segments, state) => state.initiative.declared[segments[2]]?.roleId ?? null,
    revealWhen: (segments, state) => Boolean(state.initiative.declared[segments[2]]?.revealed),
  },

  // --- battle --------------------------------------------------------------
  { path: 'battle.targets.**', audience: PUBLIC },
  { path: 'battle.sides.**', audience: PUBLIC },
  { path: 'battle.spare.**', audience: PUBLIC },
  { path: 'battle.scouts.**', audience: PUBLIC },
  // A mercenary card is a secret while it is in your hand and a counter on the
  // table once it is spent — `roles.*.mercenary` holds the first half, this
  // holds the second. Public because handing it in is a public act: it buys
  // the attackers or the defenders a clash nobody fought, and a battle whose
  // count nobody could check would be a battle nobody could argue about.
  { path: 'battle.mercenaries.**', audience: PUBLIC },
  { path: 'battle.pairingComplete', audience: PUBLIC },
  // Who the conqueror named to take a fallen shire, before the facilitator
  // settles it. Scoped exactly like the declaration that won it — the same
  // person, at the same table, about the same shire — because scoping the two
  // halves of one team-table decision differently would be arbitrary, and
  // because a team-mate about to be handed a shire should see it coming.
  //
  // No `revealWhen`. The only thing one could open is a fact `shires.**`
  // already publishes the instant it matters: settling writes the taker into
  // `shire.stewardRoleId`, which is public to everybody. A reveal condition
  // here would be a second statement of the same truth, with a second way to
  // be wrong, guarding a window that closes on its own.
  {
    path: 'battle.stewardPicks.*',
    audience: TEAM,
    owner: (segments, state) => conqueringDeclaration(state, segments[2])?.roleId ?? null,
  },
  { path: 'battle.clashes.*.id', audience: PUBLIC },
  { path: 'battle.clashes.*.shireId', audience: PUBLIC },
  { path: 'battle.clashes.*.stage', audience: PUBLIC },
  { path: 'battle.clashes.*.attacker', audience: PUBLIC },
  { path: 'battle.clashes.*.defender', audience: PUBLIC },
  { path: 'battle.clashes.*.auto', audience: PUBLIC },
  { path: 'battle.clashes.*.scouts', audience: PUBLIC },
  // Whether a side has finished deciding is public; what they decided is not.
  { path: 'battle.clashes.*.confirmed.*', audience: PUBLIC },
  { path: 'battle.clashes.*.reinforcements.**', audience: PUBLIC },
  { path: 'battle.clashes.*.result.**', audience: PUBLIC },
  { path: 'battle.clashes.*.amendWindowEndsAt', audience: PUBLIC },

  // The three secrets of a clash. All are keyed by role id, and all open to
  // everyone once the machine has passed the stage that reveals them — which
  // is why a client cannot see an opponent's card early even if it misbehaves:
  // the host never sends it.
  {
    path: 'battle.clashes.*.tactic.*',
    audience: OWNER,
    owner: ownerAtIndex(4),
    revealWhen: (segments, state) => TACTICS_REVEALED.includes(
      state.battle.clashes[segments[2]]?.stage),
  },
  {
    path: 'battle.clashes.*.lead.*',
    audience: OWNER,
    owner: ownerAtIndex(4),
    revealWhen: (segments, state) => LEAD_REVEALED.includes(
      state.battle.clashes[segments[2]]?.stage),
  },
  // A die is the third, and the shortest-lived: each fighter throws their own,
  // and the first one down would otherwise tell the second exactly what they
  // had to beat. Exactly as long as the path to one die, so that removing the
  // old public subtree rule leaves no `**` still matching underneath it.
  {
    path: 'battle.clashes.*.rolls.*',
    audience: OWNER,
    owner: ownerAtIndex(4),
    revealWhen: (segments, state) => ROLLS_REVEALED.includes(
      state.battle.clashes[segments[2]]?.stage),
  },

  // --- everything else -----------------------------------------------------
  // Who is asking whom for what is public: a settlement is a thing the
  // whole border can see being negotiated.
  { path: 'consents.**', audience: PUBLIC },
  { path: 'contracts.**', audience: PUBLIC },
  { path: 'votes.**', audience: PUBLIC },
  // A coronation is the most public thing in the game, and a rebellion
  // brewing is exactly the sort of thing the rest of the table notices
  // before the facilitator has even priced it.
  { path: 'crownHolders.**', audience: PUBLIC },
  { path: 'rebellions.**', audience: PUBLIC },
  // An envoy thread is a private line to the facilitator, one per role.
  {
    path: 'envoys.**',
    audience: OWNER,
    owner: (segments, state) => state.envoys[segments[1]]?.roleId ?? null,
  },
  // What Wessex promised Rome is exactly what another player would pay to
  // know, so a concession is visible only to whoever made it — until the
  // epilogue, which is the facilitator reading the whole ledger out.
  {
    path: 'concessions.**',
    audience: OWNER,
    owner: (segments, state) => state.concessions[segments[1]]?.roleId ?? null,
  },
  { path: 'aftermath.**', audience: PUBLIC },
];

/** Clash stages at or past the simultaneous reveal of tactic cards. */
export const TACTICS_REVEALED = revealedFrom('tactics_revealed');
/** Clash stages at or past the reveal of leadership declarations. */
export const LEAD_REVEALED = revealedFrom('lead_revealed');
/**
 * Clash stages at or past the reveal of the dice.
 *
 * `rolls_revealed` is the stage the machine reaches the instant the second die
 * lands, and `resolved` is where it is a moment later without anything else
 * having happened — so in a projection a player ever actually receives, this
 * list means "the clash is over".
 */
export const ROLLS_REVEALED = revealedFrom('rolls_revealed');

const SEGMENT = /\./;

/**
 * How specific a pattern is. An exact segment beats `*`, `*` beats a trailing
 * `**`, and a longer pattern beats a shorter one. So `shires.**` can make a
 * whole subtree public without stopping a single field inside it being pulled
 * back out by name.
 */
function specificity(pattern) {
  const parts = pattern.split(SEGMENT);
  const deep = parts.includes('**') ? 1 : 0;
  const wide = parts.filter((s) => s === '*').length;
  return [-deep, -wide, parts.length];
}

const ORDERED = [...FIELD_VISIBILITY].sort((a, b) => {
  const [ad, aw, al] = specificity(a.path);
  const [bd, bw, bl] = specificity(b.path);
  return bd - ad || bw - aw || bl - al;
});

function patternMatches(pattern, segments) {
  const parts = pattern.split(SEGMENT);
  const deep = parts[parts.length - 1] === '**';
  if (deep) {
    const head = parts.slice(0, -1);
    if (segments.length < head.length) return false;
    return head.every((p, i) => p === '*' || p === segments[i]);
  }
  if (parts.length !== segments.length) return false;
  return parts.every((p, i) => p === '*' || p === segments[i]);
}

/**
 * The rule governing a path, or null if nobody has classified it.
 *
 * A null here is the whole point of the manifest: it means someone added a
 * field and did not say who may see it, and the completeness test turns that
 * into a build failure rather than a leak.
 *
 * @param {string[]} segments
 */
export function ruleFor(segments) {
  return ORDERED.find((rule) => patternMatches(rule.path, segments)) ?? null;
}
