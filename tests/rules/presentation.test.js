/**
 * Every verb carries its own presentation, and cannot quietly stop.
 *
 * A verb used to be described in three places: its rules in `commands.js`, the
 * questions it asks in `action-chooser.js`, and its name, its note and whether
 * it asks anything at all in `rb-action-list.js`. Nothing held the three
 * together, so a verb could be added to the registry and render as its own id,
 * or be left out of the "needs a choice" set and dispatch an empty payload at a
 * rule that needed one — silently, and with the whole suite green.
 *
 * These are the checks that make forgetting cost a red build, in the same
 * spirit as `redaction.test.js`'s "every path is classified": the default for
 * something new is failure, not silence.
 */
import { describe, it, expect } from 'vitest';
import { loadData } from '../helpers/load-data.js';
import { createInitialState } from '../../gui/rules/state.js';
import {
  COMMANDS, fieldsFor, probeFor, payloadFrom,
} from '../../gui/rules/commands.js';

const data = await loadData();

const state = createInitialState({ joinCode: 'RAVEN7Z', seed: 1, data });
const ROLES = Object.keys(state.roles);

/**
 * Verbs whose payload is gathered by a control of their own rather than by the
 * generic chooser, named so that a verb arriving here by accident is obvious.
 *
 * This list is the point of the test. A new verb that reads `cmd.payload` and
 * declares no `fields` has to be argued for by adding a line here, which is a
 * thing a reviewer sees, rather than shipping as a button that sends nothing.
 */
const OWN_CONTROL = {
  'claim-role': 'the lobby role picker',
  // Fields all the same, because they are what tells the map which shires to
  // highlight — but the payload is the shire that was clicked.
  'declare-initiative-target': "the map's Target button",
  'cast-vote': '<rb-ballot>',
  'answer-consent': '<rb-consent-panel>',
  'envoy-message': '<rb-envoy-channel>',
  'join-battle': '<rb-clash-panel>',
  'submit-tactic': '<rb-clash-panel>',
  'declare-lead': '<rb-clash-panel>',
  'confirm-lead': '<rb-clash-panel>',
  'submit-roll': '<rb-clash-panel>',
  reinforce_clash: '<rb-clash-panel>',
  scout: '<rb-clash-panel>',
  'name-new-steward': '<rb-clash-panel>, beside the battle it is about',
};

/**
 * The set `rb-action-list` used to keep by hand as NEEDS_CHOICE, kept here as
 * an assertion instead. Every one of these opened a form before the refactor
 * and must still open one, because the ellipsis on the button and the form
 * behind it are now both read off `fields`.
 */
const ASKS_SOMETHING = [
  'trade', 'give', 'reinforce', 'transfer-stewardship',
  'swear-allegiance',
  'raid-settlement', 'defensive-fleet', 'rebuild-settlement', 'send-envoy',
  'missionary-expedition', 'rousing-sermon', 'baptise',
  'request-settle', 'drive-out-missionaries',
  'offer-contract', 'answer-contract', 'cancel-contract',
  'request-allegiance', 'claim-crown', 'request-rebel', 'use-mercenary',
];

describe('a verb cannot ship without a way to ask its question', () => {
  it('gives every player command that reads a payload somewhere to get one', () => {
    const orphans = Object.entries(COMMANDS)
      .filter(([, spec]) => spec.actor === 'player')
      // A command that never looks at `cmd.payload` is a bare button, and a
      // bare button is complete as it stands.
      .filter(([, spec]) => /\bpayload\b/.test(String(spec.admit)))
      .filter(([verb, spec]) => !spec.fields && !OWN_CONTROL[verb])
      .map(([verb]) => verb);
    expect(orphans).toEqual([]);
  });

  it('still asks for a choice everywhere the old hand-kept set said one was needed', () => {
    for (const verb of ASKS_SOMETHING) {
      expect(typeof COMMANDS[verb]?.fields, verb).toBe('function');
    }
  });

  it('asks a real question, not an empty one', () => {
    // Declaring `fields: () => []` would satisfy every check above while
    // reopening exactly the hole this file exists to close: a button that
    // sends an empty payload and earns a refusal nobody can read. So a verb
    // that declares fields has to produce at least one, for somebody,
    // somewhere. Not for every role — `request-rebel` legitimately asks a
    // landless player nothing — but for someone.
    const silent = [];
    for (const [verb, spec] of Object.entries(COMMANDS)) {
      if (!spec.fields) continue;
      const speaks = ROLES.some((roleId) => fieldsFor(verb, state, data, roleId).length > 0);
      if (!speaks) silent.push(verb);
    }
    expect(silent).toEqual([]);
  });

  it('names every verb that a console will put on a button', () => {
    // A verb with fields is a verb with a form, and a form headed by a wire id
    // is one no player can read. The verbs a bespoke control owns are exempt:
    // their own panel writes the words on their own buttons.
    const unnamed = Object.entries(COMMANDS)
      .filter(([verb, spec]) => spec.fields && !spec.label && !OWN_CONTROL[verb])
      .map(([verb]) => verb);
    expect(unnamed).toEqual([]);
  });
});

describe('a field cannot ask for something nothing reads', () => {
  it('produces only payload keys the command\'s own admit looks at', () => {
    // The other half of the guarantee. A field named for a key `admit` never
    // reads is a question asked of a player for nothing, and would have been
    // invisible while the two lived in different files.
    const strays = [];
    for (const [verb, spec] of Object.entries(COMMANDS)) {
      if (!spec.fields) continue;
      const admit = String(spec.admit);
      for (const roleId of ROLES) {
        // The fields' OWN keys, run through the same rewrite the form uses.
        // Reading `probeFor` here would have short-circuited to a
        // hand-written `probe` wherever one exists — which is precisely the
        // eight trickiest verbs, the ones carrying both — and left their
        // fields unchecked.
        const answered = Object.fromEntries(fieldsFor(verb, state, data, roleId)
          .map((field) => [field.name, field.options?.[0]?.value ?? field.value ?? field.min]));
        for (const key of Object.keys(payloadFrom(verb, answered))) {
          if (!admit.includes(key)) strays.push(`${verb} offers ${key}`);
        }
      }
    }
    expect([...new Set(strays)]).toEqual([]);
  });

  it('describes its fields as data, so anything may render them', () => {
    for (const [verb, spec] of Object.entries(COMMANDS)) {
      if (!spec.fields) continue;
      for (const roleId of ROLES) {
        for (const field of fieldsFor(verb, state, data, roleId)) {
          expect(typeof field.name, verb).toBe('string');
          expect(typeof field.label, verb).toBe('string');
          expect(['select', 'number'], verb).toContain(field.kind);
          if (field.kind !== 'select') continue;
          expect(Array.isArray(field.options), `${verb}.${field.name}`).toBe(true);
          for (const option of field.options) {
            expect(typeof option.value, `${verb}.${field.name}`).toBe('string');
            expect(typeof option.label, `${verb}.${field.name}`).toBe('string');
          }
        }
      }
    }
  });
});
