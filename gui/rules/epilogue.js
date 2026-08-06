/**
 * gui/rules/epilogue.js — the ending, assembled for one reader at one moment.
 *
 * `derive.js` answers questions about the board that anything in the game may
 * ask: what a shire pays, who has support there, how far an army reaches. This
 * asks nothing of the sort. It builds a report — the four counters with the
 * sentence printed under each band, every player's holdings and resources, the
 * factions as they finished, the ledger of what was promised abroad, and what
 * the umpire changed along the way — for a facilitator to read out loud, and
 * for the Debrief tab to show, marked provisional, while the game is still
 * running.
 *
 * It is its own module because it is going to grow — a narrative per player, a
 * comparison against how the evening started — and because none of that
 * belongs in the file every other rule in the game depends on. Nothing here is
 * imported by the rules; the traffic runs one way, into it.
 *
 * Derived rather than stored, like everything in `derive.js`. An epilogue that
 * could disagree with the map it describes would be worse than none.
 */

import { aftermath } from './derive.js';

/**
 * The debrief, assembled from the board.
 *
 * "In the debrief you should give an overview of the state of the island, both
 * the political and military situation at the end of the game as well as
 * summarising the outcomes from England in the Aftermath." That is a lot to
 * hold in your head after five turns of running four foreign courts, so this
 * puts it in order: the four counters with the sentence printed under each
 * band, what every player ended holding, who ended up wearing what, and the
 * whole ledger of what was promised abroad.
 */
export function epilogue(state, data) {
  const counters = aftermath(state, data);
  const named = (which) => {
    const printed = data.meta.aftermath[which];
    const counter = counters[which];
    return {
      ...counter,
      title: which,
      sentence: printed.sentences?.[counter.band] ?? '',
      start: printed.start,
    };
  };

  const players = Object.values(state.roles)
    .map((role) => ({
      id: role.id,
      name: data.roles.roles[role.id]?.name ?? role.id,
      teamId: role.teamId,
      factionId: role.factionId,
      liegeId: role.liegeId,
      generation: role.generation ?? 0,
      baptised: Boolean(role.baptised),
      crowns: Object.keys(state.crownHolders ?? {})
        .filter((crown) => state.crownHolders[crown] === role.id).sort(),
      shires: Object.keys(state.shires)
        .filter((id) => state.shires[id].stewardRoleId === role.id).sort(),
      // What is left in front of them, which is the other half of "how did
      // they do" and is nobody's secret once the game is over.
      resources: {
        silver: role.silver, food: role.food, soldiers: role.soldiers, ships: role.ships,
      },
    }))
    .sort((a, b) => b.shires.length - a.shires.length || a.name.localeCompare(b.name));

  // Factions as they ended rather than as they began. Somebody who rebelled in
  // turn three is their own faction of one, and that is the story.
  const factions = {};
  for (const player of players) {
    const faction = factions[player.factionId] ??= {
      id: player.factionId, members: [], shires: 0, crowns: [],
    };
    faction.members.push(player.id);
    faction.shires += player.shires.length;
    faction.crowns.push(...player.crowns);
  }

  return {
    turn: state.phase.turn,
    counters: {
      paganism: named('paganism'),
      danelaw: named('danelaw'),
      disorder: named('disorder'),
      prosperity: named('prosperity'),
    },
    foreignInfluence: {
      prose: state.aftermath.foreignInfluence,
      note: data.meta.aftermath.foreignInfluence?.note ?? '',
      // Kept promises first, then broken ones — the debrief wants the deals
      // before the betrayals.
      promises: Object.values(state.concessions ?? {})
        .sort((a, b) => Number(b.kept) - Number(a.kept) || a.turn - b.turn),
    },
    players,
    factions: Object.values(factions)
      .sort((a, b) => b.shires - a.shires || String(a.id).localeCompare(String(b.id))),
    notes: state.facilitatorNotes ?? {},
  };
}
