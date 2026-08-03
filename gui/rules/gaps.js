/**
 * gui/rules/gaps.js — where the printed rules are silent, and what the app does.
 *
 * A megagame's rules are written for a room with an umpire in it, so some
 * questions are simply never answered on paper: a facilitator settles them on
 * the night. An app cannot do that — it has to pick something before anybody
 * sits down — so every place it picked is recorded here, with the reading it
 * took and why.
 *
 * The facilitator console shows this list. That is the point of it: the umpire
 * should be able to see what the app decided on their behalf and overrule it
 * with the inspector, rather than discovering the ruling mid-argument.
 *
 * This is not for rules the app enforces because they are printed. It is for
 * the gaps.
 */

export const KNOWN_GAPS = [
  {
    id: 'baptism-cost',
    about: 'Baptise',
    silent: 'The Saxon Priest sheet gives Baptise no cost.',
    ruling: 'Free, but the pagan must agree.',
    because:
      'Every other action on the sheet prints a cost, so the omission reads as '
      + 'deliberate rather than lost. The real price is the negotiation, which '
      + 'happens away from the app, and the app refuses to perform one without '
      + 'the pagan\'s consent recorded.',
  },
  {
    id: 'christian-banners-cost',
    about: 'Raise Christian Banners',
    silent: 'No cost is printed for it either.',
    ruling: 'Free, once per game, and only with three churches held.',
    because:
      'It is already gated twice over. Adding a price the sheet does not print '
      + 'would make a once-a-game action that needs three churches harder still.',
  },
  {
    id: 'priest-momentum-phase',
    about: 'The priest\'s extra momentum',
    silent:
      'The Saxon Priest sheet says the ten-church bonus applies "in the Team '
      + 'Phase", while its own income block puts momentum in the Maintenance Phase.',
    ruling: 'Maintenance, with every other momentum gain.',
    because:
      'Momentum is gained in one place for everybody else, and a bonus that '
      + 'arrived a phase earlier than the momentum it adds to would be spendable '
      + 'before it existed.',
  },
  {
    id: 'contract-offer-timing',
    about: 'Making a trade contract',
    silent:
      'The card prints when a contract may be cancelled — the Team Phase — but '
      + 'not when it may be made.',
    ruling: 'Any phase but the battle, the lobby and the epilogue.',
    because:
      'It is a bargain rather than an action: it appears in no action box on any '
      + 'sheet, and the trader\'s sheet mentions contracts only where it counts '
      + 'their income. The battle is excluded because a soldier changing hands '
      + 'mid-fight would move a clash that is already being rolled.',
  },
];
