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
    id: 'crownless-kingdom-support',
    about: 'Support in a kingdom with no king',
    silent:
      'The Aftermath tracker starts Disorder at three, but the Players Guide\'s '
      + 'own support examples imply seven — Wenyld has no claim on Mercia and so '
      + 'no support in South Mercia, and the same is true of three more shires.',
    ruling:
      'While a crown is unworn, everyone in that kingdom speaks for it. Once it '
      + 'has a king, only he and his vassals do.',
    because:
      'It reproduces the printed tracker exactly, which is the number the game '
      + 'is scored from. It also makes an election worth holding: the moment '
      + 'Ceowulf is crowned, Gainbeald is a lord with land he cannot tax until '
      + 'he swears to the man who beat him. The alternative readings either '
      + 'contradict the tracker or make Claim Crown change nothing.',
  },
  {
    id: 'crown-vote-tie',
    about: 'A tied election',
    silent: 'The Facilitators Guide gives the electorate and the weights, but not how to break a tie.',
    ruling: 'A tie fails. The crown stays unworn and may be contested again.',
    because:
      'Any tiebreaker the app invented would be the app deciding who rules '
      + 'England on a rule nobody wrote down. Failing leaves it with the room, '
      + 'which is where it belongs.',
  },
  {
    id: 'claim-crown-phase',
    about: 'When a crown may be claimed',
    silent: 'The feudal actions are printed without a phase.',
    ruling: 'The Team Phase, though voting stays open until it is counted.',
    because:
      'Every other change to who follows whom happens in the Team Phase. The '
      + 'vote itself outlives the phase because a negotiation that the clock '
      + 'interrupts should not be lost.',
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
