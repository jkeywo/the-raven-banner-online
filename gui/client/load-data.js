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

/**
 * The two files only the map view needs.
 *
 * `geometry` is where things sit on the printed sheets — outlines and
 * settlement anchors. `cells` is where the exporter blanked the state-bearing
 * cells out of the artwork, and so where the overlay has to put them back. It
 * lives beside the art it describes rather than under `data/`, because it is a
 * fact about those pictures and is regenerated whenever they are.
 */
const MAP_EXTRAS = [
  { name: 'geometry', url: 'data/geometry.json' },
  { name: 'cells', url: 'assets/maps/cells.json' },
];

let cached = null;

/**
 * @param {object} [options]
 * @param {boolean} [options.geometry]  also load what the map view needs
 * @param {string} [options.base]
 */
export async function loadData({ geometry = false, base = 'data' } = {}) {
  if (cached && (!geometry || cached.geometry)) return cached;

  const wanted = [
    ...CORE.map((name) => ({ name, url: `${base}/${name}.json` })),
    ...(geometry ? MAP_EXTRAS : []),
  ];
  const loaded = await Promise.all(
    wanted.map(({ name, url }) => fetch(url).then((response) => {
      if (!response.ok) throw new Error(`could not load ${name} (${response.status})`);
      return response.json();
    })));

  cached = { ...cached, ...Object.fromEntries(wanted.map(({ name }, i) => [name, loaded[i]])) };
  return cached;
}
