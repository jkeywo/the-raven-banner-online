/**
 * gui/rules/battle.js — what a shire full of clashes adds up to.
 *
 * A battle is not one fight but several, and the shire falls on a count rather
 * than on any single duel: the attackers must win a clash for every castle,
 * however many they lose doing it. That is why a three-castle shire is hard to
 * take with two fighters and easy with five.
 *
 * The other tally runs the opposite way. Defenders who win two clashes take an
 * Initiative Token from the attackers — even if they lose the shire — which is
 * the rule that stops a strong faction simply rolling forward turn after turn.
 * Extra defenders who did not reinforce may Scout, which counts toward that
 * second tally and nothing else: a way to be useful without being in the line.
 */

import { createClash, sidesOf, resolveClash } from './clash.js';
import { TOKENS } from './state.js';

/**
 * Where a note the battle phase has no other way to say is filed, for one turn.
 *
 * `seizeInitiative` runs inside `effects`, where there is nothing to refuse
 * with and no return value anybody reads — and `facilitator:end-battles` wipes
 * `draft.battle` in the same breath, so a phase that could not hand the spare
 * token out has nowhere left to say so a moment later. That is the one thing
 * here that genuinely has to be written down: it is not derivable afterwards,
 * because the board it was about is gone. Everything else the settling could
 * not do is read back off the board instead — see `heldBackToken`.
 *
 * Its own key rather than `facilitatorNotes`, which is a different channel
 * wearing the same shape. `facilitatorNotes` is prose an umpire typed, and
 * `epilogue()` reads it out under "What the umpire changed" on a page that
 * gets printed and mailed round after the game. Machine-voiced lines about
 * counters do not belong in it: with four factions "more than one stayed out"
 * is the ordinary case, so five turns would leave five of them in the debrief,
 * each under a raw key and none of them anything the umpire changed. Two
 * audiences, two keys, and the epilogue stays clean by construction rather
 * than by a filter at the far end that somebody has to remember.
 *
 * Keyed by turn, so `<rb-facilitator-grid>` renders only the note about the
 * turn in front of it, and rewritten rather than appended, so ending the
 * battles twice leaves one answer rather than two. Older turns are simply left
 * behind: nothing renders them, they are facilitator-only, and a game is five
 * turns long.
 *
 * @param {number} turn
 * @param {string} what  what the note is about — `spare` for the end-of-phase token
 */
export const battleNoteKey = (turn, what) => `initiative:t${turn}:${what}`;

/**
 * The declaration a battle over this shire is being fought under, or null.
 *
 * Three things need to know it: which token passes to a defender who won
 * twice, whether that token can actually move, and — now — who is entitled to
 * name the shire's new steward. They must agree, so they ask here.
 *
 * **Two tokens may not end up attacking one shire.**
 * `facilitator:announce-targets` refuses while any pair does, and asks the
 * lower one's holder to name somewhere else. It is settled there rather than
 * when a player declares, because until the targets are announced a
 * declaration is its team's own business: refusing a player for colliding
 * would tell them exactly which shire another team had secretly chosen.
 *
 * So a collision cannot survive into a battle — but it exists before one, and
 * this function is read during the team phase too. It can also arrive by
 * routes announce never sees: a raw `facilitator:set`, or a save written
 * before the rule. Every reader used to settle that with
 * `Object.entries(...).find(...)`, which answers with whichever declaration
 * was written first: an order that depends on the sequence commands arrived
 * in, differs between a live game and a replay of a re-ordered log, and was
 * never chosen by anybody.
 *
 * So it is `TOKENS` order — white, then black, then bonus — the order the
 * printed sheets name them in, and the same order announce enforces. White and
 * black are the two counters the game starts with; the bonus is the temporary
 * one handed to whoever sat the turn out, and it should not outrank a token
 * somebody has held all game.
 *
 * @returns {{token: string, roleId: string|null}|null}
 */
export function conqueringDeclaration(state, shireId) {
  for (const token of TOKENS) {
    const declaration = state.initiative?.declared?.[token];
    if (declaration && declaration.shireId === shireId) {
      return { token, roleId: declaration.roleId ?? null };
    }
  }
  return null;
}

/** How many defended settlements a shire currently has. */
export function defendedSettlements(state, shireId) {
  return Object.values(state.shires[shireId]?.settlements ?? {})
    .filter((s) => s.defended && !s.destroyed).length;
}

/** Every clash being fought over a shire. */
export const clashesIn = (state, shireId) =>
  Object.values(state.battle.clashes).filter((c) => c.shireId === shireId);

/**
 * Pair attackers against defenders.
 *
 * The facilitator does this by hand in the paper game, honouring whatever
 * rivalries people have announced, so this is a default rather than a rule —
 * `facilitator:pair-clashes` can be handed an explicit pairing instead.
 *
 * Attackers left without an opponent are seeded already resolved: they walked
 * in unopposed, and the printed rules count that as a win.
 */
export function pairSides({ attackers, defenders, shireId, pairs = null }) {
  const clashes = [];
  const used = new Set();

  if (pairs) {
    for (const [attacker, defender] of pairs) {
      clashes.push(createClash({
        id: `${shireId}:${clashes.length + 1}`, shireId, attacker, defender,
      }));
      used.add(attacker);
      if (defender) used.add(defender);
    }
  } else {
    attackers.forEach((attacker, i) => {
      clashes.push(createClash({
        id: `${shireId}:${i + 1}`, shireId, attacker, defender: defenders[i] ?? null,
      }));
      used.add(attacker);
      if (defenders[i]) used.add(defenders[i]);
    });
  }

  // Defenders with nobody to fight are the ones who may reinforce or scout.
  const spare = defenders.filter((roleId) => !used.has(roleId));
  return { clashes, spareDefenders: spare };
}

/**
 * Read a clash whose dice are both down, and charge everyone for it.
 *
 * `resolveClash` works out what happened; this is what it cost, applied to the
 * board. Casualties, then the food the survivors eat and the ones who starve
 * because there was none, then wounds — and death at the printed threshold,
 * read out of `data` rather than written here, because how many wounds kill a
 * man is a number a designer tunes.
 *
 * It lives here rather than in `clash.js` because it reaches across the whole
 * roster: a clash's arithmetic is one duel's business, but spending the food
 * and soldiers it consumed is the board's. It lives in one place rather than
 * two because there are two ways in — both fighters rolling, or a facilitator
 * forcing a stalled clash forward — and they must cost exactly the same.
 *
 * Mutates a draft, like everything else in the reducer's reach. Returns the
 * outcome it applied.
 */
export function settleClash(draft, data, clash) {
  const outcome = resolveClash(clash, data, {
    defendedSettlements: defendedSettlements(draft, clash.shireId),
    food: Object.fromEntries(sidesOf(clash).map((id) => [id, draft.roles[id].food])),
  });

  for (const roleId of sidesOf(clash)) {
    const role = draft.roles[roleId];
    role.soldiers = Math.max(0, role.soldiers - outcome.casualties[roleId]);
    role.food -= outcome.feeding[roleId].foodSpent;
    role.soldiers = Math.max(0, role.soldiers - outcome.feeding[roleId].starved);
    role.wounds += outcome.wounds[roleId];
    if (role.wounds >= Number(data.meta.woundsFatal)) role.dead = true;
    // Reinforcing soldiers are spent whatever happens.
    const committed = clash.reinforcements[roleId];
    if (committed) draft.roles[roleId].soldiers = Math.max(0, role.soldiers - committed);
  }
  // A reinforcing player is not in the clash, so their soldiers are taken
  // here rather than in the loop above.
  for (const [roleId, soldiers] of Object.entries(clash.reinforcements)) {
    if (sidesOf(clash).includes(roleId)) continue;
    draft.roles[roleId].soldiers = Math.max(0, draft.roles[roleId].soldiers - soldiers);
  }

  clash.result = outcome;
  clash.stage = 'resolved';
  return outcome;
}

/**
 * How a battle stands.
 *
 * @returns {{attackerWins: number, defenderWins: number, resolved: boolean,
 *            castles: number, shireFalls: boolean, tokenChangesHands: boolean}}
 */
export function tally(state, shireId) {
  const clashes = clashesIn(state, shireId);
  const shire = state.shires[shireId];
  const scouts = state.battle.scouts?.[shireId]?.length ?? 0;

  let attackerWins = 0;
  let defenderWins = 0;
  for (const clash of clashes) {
    if (!clash.result) continue;
    if (clash.result.winner === clash.attacker) attackerWins += 1;
    else defenderWins += 1;
  }

  // "Your side counts as achieving victory in one additional clash during the
  // battle." Handed in before the pairing, so it is spent knowing who joined
  // rather than knowing who you will face.
  const hired = state.battle.mercenaries?.[shireId] ?? {};
  attackerWins += hired.attackers ?? 0;
  defenderWins += hired.defenders ?? 0;

  const resolved = clashes.length > 0 && clashes.every((c) => c.stage === 'resolved');
  return {
    attackerWins,
    defenderWins,
    mercenaries: hired,
    scouts,
    resolved,
    castles: shire?.castles ?? 0,
    // One win per castle, however many were lost getting them.
    shireFalls: resolved && attackerWins >= (shire?.castles ?? 0),
    // Scouting counts here and nowhere else.
    tokenChangesHands: resolved && (defenderWins + scouts) >= 2,
  };
}

/**
 * The token a finished battle should move and cannot, or null.
 *
 * A role holds at most one token — three counters on a table, and nobody is
 * handed two — so a defender who won twice while already holding one leaves
 * the attacker's token where it is. `settleBattle` runs inside `effects`,
 * where there is nothing to refuse with, so the answer is to not create the
 * double-hold and let the facilitator, who is standing over the battle anyway,
 * push a counter across by hand.
 *
 * Read off the board rather than filed away at the moment it happens, because
 * it is a fact about the board and not an event: the tally, which token
 * declared against this shire, and who is holding what. `settleBattle` asks
 * before it moves anything and `<rb-facilitator-grid>` asks again to draw the
 * warning, so the two cannot come to disagree — and following the instruction
 * is what makes the warning go away, which is a dismissal a stored note never
 * had.
 *
 * @returns {{token: string, steward: string, alsoHolds: string,
 *            stays: string|null}|null}
 */
export function heldBackToken(state, shireId) {
  const result = tally(state, shireId);
  const steward = state.shires[shireId]?.stewardRoleId;
  if (!result.resolved || !result.tokenChangesHands || !steward) return null;

  // Whichever token was used to declare this attack is the one that would pass.
  const used = conqueringDeclaration(state, shireId);
  if (!used) return null;

  const { token } = used;
  const alsoHolds = TOKENS.find((other) => other !== token
    && state.initiative[other] === steward);
  if (!alsoHolds) return null;
  // `stays` is a roleId or null — a token can be sitting on the table with
  // nobody holding it, which is what removing a role leaves behind.
  return { token, steward, alsoHolds, stays: state.initiative[token] ?? null };
}

/**
 * Apply the outcome of a finished battle to the board.
 *
 * Mutates a draft, because it is called from inside the reducer where a draft
 * is what exists. Returns what it did, so the log and the console can say —
 * including `tokenHeldBack`, because `tokenChangesHands` is what the tally
 * says should happen and is not always what did.
 *
 * @param {object} [options]
 * @param {string|null} [options.newSteward] a taker named by whoever is
 *   calling, which loses to the conqueror's own pick. It is the facilitator's
 *   last resort — for a shire whose token holder has left the table — not
 *   their choice: `<rb-facilitator-grid>` stopped offering the dropdown when
 *   `name-new-steward` gave the holder the decision.
 */
export function settleBattle(draft, data, shireId, { newSteward = null } = {}) {
  const result = tally(draft, shireId);
  if (!result.resolved) return { ...result, applied: false };

  const shire = draft.shires[shireId];
  const defendingSteward = shire.stewardRoleId;
  // Asked before the shire below can change hands, because it is a question
  // about whoever was defending it.
  const heldBack = heldBackToken(draft, shireId);

  if (result.shireFalls) {
    // The token holder names who takes it — often not themselves, which is how
    // a faction rewards whoever actually did the fighting. Three answers in
    // order of authority: what the conqueror actually said, then whatever the
    // caller was told by hand, then the plain default. The holder's pick comes
    // first because it is the only one of the three that is a decision — the
    // other two are a stand-in for one nobody made.
    const taker = draft.battle.stewardPicks?.[shireId]
      ?? newSteward ?? clashesIn(draft, shireId)[0]?.attacker ?? null;
    if (taker) {
      shire.stewardRoleId = taker;
      shire.factionId = draft.roles[taker]?.factionId ?? null;
    }
    // A castle comes down, but never below two: a shire is always worth
    // fighting over more than once.
    const floor = Number(data.meta.castleFloor);
    if (shire.castles > floor) shire.castles -= 1;
  }

  // Skipping is defensible; skipping silently would not be — `tokenChangesHands`
  // goes on reading true and nobody reads this return value. But nothing is
  // written down about it either: the grid asks `heldBackToken` the same
  // question against the same board and says so itself, so there is no second
  // copy of the answer to go stale while the facilitator fixes it.
  if (result.tokenChangesHands && defendingSteward && !heldBack) {
    // Whichever token was used to declare this attack passes to the defender —
    // the same declaration `heldBackToken` just asked about, and the same one
    // that named the steward, because there is one answer to that question.
    const used = conqueringDeclaration(draft, shireId);
    if (used) draft.initiative[used.token] = defendingSteward;
  }

  return {
    ...result,
    applied: true,
    newSteward: shire.stewardRoleId,
    tokenHeldBack: Boolean(heldBack),
  };
}

/**
 * Hand out the temporary token at the end of a battle phase.
 *
 * A faction that neither attacked anyone nor was attacked gets one for the
 * following turn only. It is the game's way of noticing that sitting quietly
 * while everyone else fights should not be free of consequence — for them or
 * for you.
 *
 * The token is a plain roleId, exactly like white and black. It used to be
 * written here as `{ roleId, expiresTurn }` and as a bare string everywhere
 * else, which meant every `initiative[token] === roleId` comparison in the
 * codebase stopped seeing the bonus holder the moment this function fired —
 * including the one that clears a removed role's token. `expiresTurn` was
 * never read by anything, so the "next turn only" it implied was a comment
 * with a field attached; the facilitator takes the token back by hand.
 */
export function seizeInitiative(draft) {
  const involved = new Set();
  for (const clash of Object.values(draft.battle.clashes)) {
    for (const roleId of sidesOf(clash)) {
      const faction = draft.roles[roleId]?.factionId;
      if (faction) involved.add(faction);
    }
  }
  for (const shireId of draft.battle.targets) {
    const steward = draft.shires[shireId]?.stewardRoleId;
    const faction = steward && draft.roles[steward]?.factionId;
    if (faction) involved.add(faction);
  }

  const quiet = [...new Set(Object.values(draft.roles).map((r) => r.factionId))]
    .filter((faction) => faction && !involved.has(faction));

  // Every way this ends says so. The button that calls it reads "End the
  // battles and hand out the spare token", and nobody reads the return value,
  // so a phase that handed one out and a phase that could not have to look
  // different to the facilitator standing in front of it. This one is written
  // down rather than derived because the command wipes `draft.battle` a line
  // after calling this, taking the evidence with it.
  const noteKey = battleNoteKey(draft.phase.turn, 'spare');
  delete draft.battleNotes[noteKey];

  // One token, and only if exactly one faction stayed out — otherwise the
  // facilitator decides, which is what the paper game does anyway.
  if (quiet.length !== 1) {
    draft.battleNotes[noteKey] = quiet.length
      ? `No spare initiative token was handed out: ${quiet.length} factions stayed out of the `
        + 'fighting, so which of them takes it is yours to decide.'
      : 'No spare initiative token was handed out: every faction was in the fighting.';
    return null;
  }
  // Which member of that faction takes it was always an arbitrary pick, so it
  // picks somebody empty-handed: a role may hold only one token, and handing
  // a second to whoever happens to be first in the roster would break that
  // for no reason. If the whole faction is already holding tokens there is
  // nobody left to give it to, and the facilitator decides — as above.
  const members = Object.values(draft.roles).filter((r) => r.factionId === quiet[0]);
  const holder = members.find((r) => !TOKENS.some((t) => draft.initiative[t] === r.id));
  if (!holder) {
    draft.battleNotes[noteKey] = 'No spare initiative token was handed out: everyone in '
      + 'the faction that stayed out of the fighting is already holding one.';
    return null;
  }
  draft.initiative.bonus = holder.id;
  return holder.id;
}
