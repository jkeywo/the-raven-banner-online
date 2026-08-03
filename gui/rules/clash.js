/**
 * gui/rules/clash.js — one duel, and the only true secret in the game.
 *
 * A clash is a pair of fighters resolved in five steps: choose a card in
 * secret, reveal both, add what the shire and any reinforcements are worth,
 * decide whether to lead personally, roll, and count the dead.
 *
 * Two of those steps are simultaneous reveals, and they are why the redaction
 * layer exists. A player must not see their opponent's card before their own
 * is committed — and here that is not a matter of the client behaving, because
 * the host simply never sends it. `views.js` gates both fields on this
 * machine's stage.
 *
 * The interesting rule is the second reveal. The printed text says that if you
 * chose to fight normally and your opponent leads the charge, you may change
 * your mind. Read as a free switch that never terminates: each side would keep
 * answering the other. Read as what it says — you may change *to* leading, not
 * away from it — it settles on its own, because each side can flip at most
 * once and only in one direction.
 */

/** Stages, in order. A clash only ever moves forward. */
export const STAGES = [
  'awaiting_tactics',
  'tactics_revealed',
  'awaiting_lead',
  'lead_revealed',
  'rolling',
  'resolved',
];

/** The defender's bonus applies at this many defended settlements. */
export const DEFENDED_FOR_BONUS = 3;

/** A reinforcing player may commit at most this many soldiers. */
export const MAX_REINFORCEMENT = 2;

export const stageAtLeast = (stage, target) =>
  STAGES.indexOf(stage) >= STAGES.indexOf(target);

/** A fresh clash between two fighters over a shire. */
export function createClash({ id, shireId, attacker, defender }) {
  return {
    id,
    shireId,
    attacker,
    defender: defender ?? null,
    // An attacker nobody was free to face wins by walking in. Seeded already
    // resolved so the shire-capture tally is one uniform count.
    auto: defender === null || defender === undefined,
    stage: defender ? 'awaiting_tactics' : 'resolved',
    tactic: defender ? { [attacker]: null, [defender]: null } : {},
    lead: defender ? { [attacker]: null, [defender]: null } : {},
    confirmed: defender ? { [attacker]: false, [defender]: false } : {},
    reinforcements: {},
    scouts: [],
    rolls: {},
    amendWindowEndsAt: null,
    result: defender ? null : { winner: attacker, unopposed: true },
  };
}

/** Both sides of a clash, in no particular order. */
export const sidesOf = (clash) => [clash.attacker, clash.defender].filter(Boolean);

/** The other one. */
export const opponentOf = (clash, roleId) =>
  (roleId === clash.attacker ? clash.defender : clash.attacker);

const allSubmitted = (clash, field) =>
  sidesOf(clash).every((roleId) => clash[field][roleId] !== null);

/**
 * Move a clash on if it is ready to move.
 *
 * Called after every command that touches one, so the machine advances as a
 * consequence of what people did rather than on a timer somewhere. Returns the
 * stage it settled on.
 */
export function advanceClash(clash) {
  if (clash.stage === 'awaiting_tactics' && allSubmitted(clash, 'tactic')) {
    clash.stage = 'tactics_revealed';
  }
  if (clash.stage === 'tactics_revealed') {
    // Reinforcements and scouting close the moment the cards are up: they are
    // a commitment made without knowing the outcome, not a reaction to it.
    clash.stage = 'awaiting_lead';
  }
  if (clash.stage === 'awaiting_lead' && allSubmitted(clash, 'lead')) {
    clash.stage = 'lead_revealed';
    // Anyone already leading has nothing left to decide.
    for (const roleId of sidesOf(clash)) {
      if (clash.lead[roleId]) clash.confirmed[roleId] = true;
    }
  }
  if (clash.stage === 'lead_revealed'
      && sidesOf(clash).every((roleId) => clash.confirmed[roleId])) {
    clash.stage = 'rolling';
  }
  return clash.stage;
}

/**
 * Change a leadership declaration after the reveal.
 *
 * Only upward. Switching to leading gives the other side something new to
 * answer, so their confirmation is withdrawn — but since each fighter can only
 * ever go from not-leading to leading, at most two such moves exist and the
 * exchange always settles.
 *
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function amendLead(clash, roleId, lead) {
  if (clash.stage !== 'lead_revealed') return { ok: false, reason: 'too late to change your mind' };
  if (!lead) {
    return { ok: false, reason: 'you can join the charge, but you cannot leave it' };
  }
  if (clash.lead[roleId]) return { ok: false, reason: 'you are already leading' };

  clash.lead[roleId] = true;
  clash.confirmed[roleId] = true;
  const other = opponentOf(clash, roleId);
  // They now have something to answer, unless they are already in the front
  // rank themselves.
  if (!clash.lead[other]) clash.confirmed[other] = false;
  return { ok: true };
}

/** Stand pat: decline to join the charge. */
export function confirmLead(clash, roleId) {
  if (clash.stage !== 'lead_revealed') return { ok: false, reason: 'there is nothing to confirm' };
  clash.confirmed[roleId] = true;
  return { ok: true };
}

/** The leadership bonus for a roll, and whether it wounds the other side. */
export function leadership(data, roll, leading) {
  const table = leading ? data.meta.leadership.lead : data.meta.leadership.normal;
  return {
    bonus: table[String(roll)],
    woundsOpponent: Boolean(data.meta.leadership.woundOnSix) && roll === 6,
  };
}

/**
 * One side's battle score, before the dice.
 *
 * The card, plus the defender's bonus where the shire is well held, plus one
 * for each soldier a reinforcing player threw in.
 */
export function battleScore(clash, data, roleId, { defendedSettlements = 0 } = {}) {
  const card = data.tactics.tactics[clash.tactic[roleId]];
  let score = card ? card.score : 0;
  if (roleId === clash.defender && defendedSettlements >= DEFENDED_FOR_BONUS) score += 1;
  if (roleId === clash.defender) {
    score += Object.values(clash.reinforcements).reduce((n, soldiers) => n + soldiers, 0);
  }
  return score;
}

/**
 * Casualties for one side.
 *
 * Your opponent's losses dealt, plus your own losses received. Withdrawing and
 * defending both carry a negative, and the printed rule is emphatic that a
 * negative total does not hand you soldiers — it just means nobody died.
 */
export function casualtiesFor(clash, data, roleId) {
  const mine = data.tactics.tactics[clash.tactic[roleId]];
  const theirs = data.tactics.tactics[clash.tactic[opponentOf(clash, roleId)]];
  if (!mine || !theirs) return 0;
  return Math.max(0, theirs.lossesDealt + mine.lossesReceived);
}

/**
 * Feeding, after the fighting.
 *
 * Everyone feeds the soldiers they committed less the ones they lost, a food
 * each. Anything that cannot be fed starves, which is how a player who wins a
 * battle can still come out of it smaller.
 */
export function feed({ committed, casualties, food }) {
  const mouths = Math.max(0, committed - casualties);
  const fed = Math.min(mouths, food);
  return { foodSpent: fed, starved: mouths - fed };
}

/**
 * Resolve a clash whose dice are in.
 *
 * Pure: it reads the clash and returns what happened, so the reducer can apply
 * it and a test can check it against the worked example in the rulebook.
 */
export function resolveClash(clash, data, { defendedSettlements = 0, food = {} } = {}) {
  const [a, b] = [clash.attacker, clash.defender];
  const outcome = { scores: {}, leadership: {}, wounds: {}, casualties: {}, feeding: {} };

  for (const roleId of [a, b]) {
    const rolled = leadership(data, clash.rolls[roleId], clash.lead[roleId]);
    outcome.leadership[roleId] = rolled;
    outcome.scores[roleId] = battleScore(clash, data, roleId, { defendedSettlements })
      + rolled.bonus;
    outcome.wounds[roleId] = 0;
  }

  for (const roleId of [a, b]) {
    // A six wounds whoever you were fighting, whether or not you led.
    if (outcome.leadership[roleId].woundsOpponent) {
      outcome.wounds[opponentOf(clash, roleId)] += 1;
    }
    // Leading and being outshone by the other side costs you as well, which is
    // how one bad clash can leave a character with two wounds.
    if (clash.lead[roleId]
        && outcome.leadership[roleId].bonus <= outcome.leadership[opponentOf(clash, roleId)].bonus) {
      outcome.wounds[roleId] += 1;
    }
  }

  // Attackers win ties.
  outcome.winner = outcome.scores[a] >= outcome.scores[b] ? a : b;

  for (const roleId of [a, b]) {
    const casualties = casualtiesFor(clash, data, roleId);
    outcome.casualties[roleId] = casualties;
    outcome.feeding[roleId] = feed({
      committed: data.tactics.tactics[clash.tactic[roleId]]?.score ?? 0,
      casualties,
      food: food[roleId] ?? 0,
    });
  }

  return outcome;
}
