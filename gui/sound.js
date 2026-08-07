/**
 * gui/sound.js — the two noises this app is allowed to make.
 *
 * Synthesised rather than sampled. A beep is a tone and a fade, which the Web
 * Audio API already knows how to make, and the alternative is a pair of audio
 * files to fetch, publish and get 404s from on a laptop with no signal at a
 * venue. Nothing to load means nothing to fail to load.
 *
 * Everything here is best-effort and silent about it. A browser with no audio,
 * a tab that has never been clicked in, a device with the volume down: none of
 * those are errors a facilitator can do anything about mid-game, and none of
 * them should show up as a broken console. The clock still says what it says;
 * the sound is a second way of noticing, never the only one.
 */

/** A short tone. Long enough to hear across a room, short enough to repeat. */
const BEEP_MS = 140;
const GAP_MS = 190;

/**
 * A beeper, or something that behaves like one when there is no audio to be
 * had.
 *
 * The context is made on the first beep rather than at import: a page that
 * never beeps should not hold an audio device open for three hours, and a
 * context created before the user has clicked anything starts suspended
 * anyway.
 */
export function createBeeper({ Ctx = globalThis.AudioContext ?? globalThis.webkitAudioContext } = {}) {
  let ctx = null;

  const ready = () => {
    if (!Ctx) return null;
    if (!ctx) {
      try { ctx = new Ctx(); } catch { return null; }
    }
    // Suspended until the page has been clicked in, which is the browser's
    // rule and not a thing to work around. Both consoles have been clicked in
    // long before they beep — a facilitator has started a game, a player has
    // taken a seat — so this is really only for a tab restored from the back
    // button.
    if (ctx.state === 'suspended') ctx.resume?.().catch(() => {});
    return ctx.state === 'closed' ? null : ctx;
  };

  /**
   * @param {number} count how many tones
   * @param {number} hz    pitch; the two callers use different ones so a
   *                       facilitator can tell their own clock from the noise
   *                       a player's laptop is making next to them
   */
  const beep = (count = 1, hz = 880) => {
    const audio = ready();
    if (!audio) return;
    try {
      for (let i = 0; i < count; i += 1) {
        const at = audio.currentTime + (i * (BEEP_MS + GAP_MS)) / 1000;
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        osc.type = 'sine';
        osc.frequency.value = hz;
        // Ramped rather than switched. A gain that steps from 0 to 1 clicks,
        // and a click is what a broken speaker sounds like.
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.3, at + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + BEEP_MS / 1000);
        osc.connect(gain).connect(audio.destination);
        osc.start(at);
        osc.stop(at + BEEP_MS / 1000 + 0.02);
      }
    } catch {
      // A browser that has an AudioContext but will not play from it. Nothing
      // to say and nothing to do.
    }
  };

  return { beep, close: () => { ctx?.close?.().catch(() => {}); ctx = null; } };
}

/**
 * A noise when the facilitator moves the game on, and at no other time.
 *
 * Players are talking to each other, not watching a clock. The phase changing
 * is the one thing that happens *to* them rather than because of them, and
 * missing it costs a whole phase of a five-phase turn.
 *
 * Silent on the first projection a seat ever sees, which is the whole of the
 * logic worth testing. Arriving at a game that is in the Battle Phase is not
 * the Battle Phase starting; nor is a laptop waking up and being told where
 * the game got to. Both would be a seat announcing history as news.
 *
 * Keyed on the turn as well as the phase, so turn 2's Team Phase is heard even
 * though it has the same name as turn 1's.
 */
export function createPhaseAnnouncer({ beeper, count = 2, hz = 740 } = {}) {
  let heard = null;
  return (phase) => {
    if (!phase) return;
    const at = `${phase.turn}/${phase.name}`;
    const moved = heard !== null && at !== heard;
    heard = at;
    if (moved) beeper?.beep(count, hz);
  };
}
