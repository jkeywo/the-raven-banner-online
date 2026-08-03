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

import { createClash, sidesOf } from './clash.js';

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

  const resolved = clashes.length > 0 && clashes.every((c) => c.stage === 'resolved');
  return {
    attackerWins,
    defenderWins,
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
 * Apply the outcome of a finished battle to the board.
 *
 * Mutates a draft, because it is called from inside the reducer where a draft
 * is what exists. Returns what it did, so the log and the console can say.
 */
export function settleBattle(draft, data, shireId, { newSteward = null } = {}) {
  const result = tally(draft, shireId);
  if (!result.resolved) return { ...result, applied: false };

  const shire = draft.shires[shireId];
  const defendingSteward = shire.stewardRoleId;

  if (result.shireFalls) {
    // The token holder names who takes it — often not themselves, which is how
    // a faction rewards whoever actually did the fighting.
    const taker = newSteward ?? clashesIn(draft, shireId)[0]?.attacker ?? null;
    if (taker) {
      shire.stewardRoleId = taker;
      shire.factionId = draft.roles[taker]?.factionId ?? null;
    }
    // A castle comes down, but never below two: a shire is always worth
    // fighting over more than once.
    const floor = Number(data.meta.castleFloor);
    if (shire.castles > floor) shire.castles -= 1;
  }

  if (result.tokenChangesHands && defendingSteward) {
    // Whichever token was used to declare this attack passes to the defender.
    const used = Object.entries(draft.initiative.declared)
      .find(([, declaration]) => declaration.shireId === shireId);
    if (used) {
      const [token] = used;
      draft.initiative[token] = defendingSteward;
    }
  }

  return { ...result, applied: true, newSteward: shire.stewardRoleId };
}

/**
 * Hand out the temporary token at the end of a battle phase.
 *
 * A faction that neither attacked anyone nor was attacked gets one for the
 * following turn only. It is the game's way of noticing that sitting quietly
 * while everyone else fights should not be free of consequence — for them or
 * for you.
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

  // One token, and only if exactly one faction stayed out — otherwise the
  // facilitator decides, which is what the paper game does anyway.
  if (quiet.length !== 1) return null;
  const holder = Object.values(draft.roles).find((r) => r.factionId === quiet[0]);
  if (!holder) return null;
  draft.initiative.bonus = { roleId: holder.id, expiresTurn: draft.phase.turn + 1 };
  return draft.initiative.bonus;
}
