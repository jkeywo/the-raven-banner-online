# Domain vocabulary

The words the paper game uses. Code uses these words and no synonyms — a
`stewardRoleId` is never an "owner", a `Clash` is never a "fight".

## People

**Role** — one of the sixteen named characters (King Alfred, Halfdan Ragnarsson,
Abbess Wenyld…). A role is a fixed thing defined in `data/roles.json`. It exists
whether or not anyone is playing it.

**Seat** — a connected human, identified by a 32-hex token that survives a page
refresh. A seat may claim a role; a role may be held by at most one connected
seat. Seats are runtime, roles are data. Keeping them separate is what makes
reconnection and facilitator reassignment work.

**Archetype** — which action sheet a role uses. Four of them: Saxon Warrior
(seven roles), Saxon Priest (two), Danish Warrior (six), Danish Trader (one,
Frida). An archetype determines what a player *can* do; the phase determines
when.

**Team** — one of the four starting tables: Kingdom of Wessex, Kingdom of Mercia,
Great Heathen Army, Great Summer Army. Fixed at setup.

**Faction** — a political grouping, which starts equal to the team but can be
created and disbanded mid-game by facilitator adjudication. Support boxes on the
map name factions, not teams.

**Liege / vassal** — a Saxon may swear allegiance to another, which matters
because you have support in a shire if you *or your liege* hold a crown listed
there. Danes may switch liege freely in the Team Phase.

**Steward** — the role that controls a shire. One per shire. Stewardship is
transferred by capture, by agreement in the Team Phase, or by facilitator fiat.

**Facilitator** — the umpire. Two of them. They run the clock, pair clashes,
roleplay the four non-played factions, and adjudicate anything the rules leave
to judgement.

## The board

**Shire** — one of the eighteen territories, six on each of the three maps
(Northern, Western, Eastern England). Has a steward, a support box, a castle
count, settlements, and possibly a ship cost and a missionary cross.

**Settlement** — a Farm (1 food), Town (2 silver) or Church (no income) inside a
shire. May be *defended*, which protects it from raiding and contributes to the
defender's battle bonus. May be *destroyed*, permanently, by a raid. There are
74 at the start of the game.

**Support** — whether a faction's claim to a shire is legitimate. Saxons have
support where they or their liege hold a listed crown; Danes have support only
in shires they have Settled. **Without support, defended settlements pay no
income**, and the shire counts toward Disorder in the endgame tally.

**Castle** — how many clashes an attacker must win to take the shire. Two to
four. Capturing a shire crosses one off, to a floor of two.

**Adjacency** — which shires you may attack from. Drawn as double-headed arrows,
sometimes across maps. Support grants it automatically; a coastal shire can also
be reached for one turn by paying its ship cost.

**Missionary cross** — a marker placed by a Saxon Priest in a Danish shire. It
keeps the shire out of the Paganism count and lets the priest reinforce there.

## Play

**Turn** — five of them, twenty-five minutes each, made of four phases: **Team**
(5 min, locked to your team), **Battle** (5 min), **Maintenance** (5 min, income
and trading), **Encounter** (10 min, free negotiation).

**Initiative Token** — three of them. White chooses its battle target first,
black second, and a temporary third token goes to any faction that neither
attacked nor was attacked last turn. Holding one is how you start a battle.

**Clash** — a single paired duel inside a battle. Both sides secretly choose a
tactic card (A/2/3/4/5), reveal simultaneously, optionally declare **Lead the
Charge**, roll a d6, and compare. Attackers win ties. A battle is several
clashes; a shire falls when the attackers win as many as it has castles.

**Momentum** — the currency of special actions. Caps at four. Cannot be traded.

**Wound** — taken by rolling a six against you, or by leading the charge badly.
Three kills the character, which the facilitator then adjudicates.

**The Aftermath** — the endgame. There is no winner. Four counters (Paganism,
Danelaw, Disorder, Prosperity) plus the facilitator's read on Foreign Influence
determine what the epilogue says happened to England. Each player judges their
own success against their private brief.
