/**
 * gui/client/action-chooser.js — the small inline form an action asks through.
 *
 * Most actions are a button. A few need one more thing: which settlement,
 * which way round, how much and to whom. Rather than a modal for each, the
 * command itself describes the fields it wants — see `fields` on the specs in
 * `gui/rules/commands.js` — and this builds a form out of them.
 *
 * Only the DOM lives here. What to ask, and what the answers mean, are the
 * verb's own business and are declared beside its rules, so a dropdown can
 * never offer a choice the host would then refuse. This file could not hold
 * them even if it wanted to: the host has no DOM, and it needs the same
 * answers to decide which controls a player may use.
 */

import { fieldsFor } from '../rules/commands.js';

/** Build the form. Returns null when the action needs nothing. */
export function renderChooser(verb, view, data, doc = globalThis.document) {
  const fields = fieldsFor(verb, view, data);
  if (!fields.length) return null;

  const form = doc.createElement('form');
  form.className = 'rb-chooser';
  form.dataset.verb = verb;
  form.innerHTML = `${fields.map((field) => `
    <label>${field.label}
      ${field.kind === 'select'
    ? `<select name="${field.name}" ${field.options.length ? '' : 'disabled'}>
            ${field.options.map((o) => `<option value="${o.value}">${o.label}</option>`).join('')
            || '<option>nothing available</option>'}
          </select>`
    : `<input type="number" name="${field.name}" min="${field.min ?? 1}"
             max="${field.max ?? 99}" value="${field.value ?? 1}">`}
    </label>`).join('')}
    <div class="rb-chooser-buttons">
      <button type="submit" class="rb-primary">Do it</button>
      <button type="button" data-cancel>Cancel</button>
    </div>`;
  return form;
}

/** Read a chooser form back out. */
export function valuesFrom(form) {
  return Object.fromEntries(new FormData(form).entries());
}
