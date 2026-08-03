/**
 * gui/client/load-data.js — the static dataset, fetched once.
 *
 * Both consoles need it: the projection carries what has *changed* about the
 * board, but the names, support boxes, printed castle counts and shire
 * outlines never change and so are never sent. Sending eighteen shire names
 * sixteen times a turn would be silly.
 *
 * Fetched rather than imported so the JSON stays JSON. With no build step,
 * import assertions are a compatibility question nobody needs to answer.
 */

const CORE = ['shires', 'adjacency', 'roles', 'briefs', 'archetypes',
  'tactics', 'factions', 'meta', 'scaling'];

/** Where things sit on the printed maps. Only the map view needs it. */
const GEOMETRY = 'geometry';

let cached = null;

/**
 * @param {object} [options]
 * @param {boolean} [options.geometry]  also load the map outlines
 * @param {string} [options.base]
 */
export async function loadData({ geometry = false, base = 'data' } = {}) {
  if (cached && (!geometry || cached.geometry)) return cached;

  const names = geometry ? [...CORE, GEOMETRY] : CORE;
  const loaded = await Promise.all(
    names.map((name) => fetch(`${base}/${name}.json`).then((response) => {
      if (!response.ok) throw new Error(`could not load ${name}.json (${response.status})`);
      return response.json();
    })));

  cached = { ...cached, ...Object.fromEntries(names.map((name, i) => [name, loaded[i]])) };
  return cached;
}
