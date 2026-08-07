/**
 * <rb-phase-clock> — the turn, the phase, and how long is left.
 *
 * Counts down from a deadline rather than by accumulating ticks. A tab that
 * has been in the background has had its timers throttled to roughly once a
 * second, and a clock built by adding up intervals comes back minutes wrong —
 * which, in a game of five-minute phases, is the difference between having
 * time to act and not. So every tick just asks what time it is.
 *
 * It runs past zero into overtime rather than stopping, because a phase ends
 * when the facilitator says it does. That is how the paper game works: the
 * clock is there to tell everyone how they are doing, and every negotiation
 * overruns a little. An app that cut one off mid-sentence would be wrong about
 * the game and infuriating besides.
 */

const PHASE_NAMES = {
  lobby: 'Waiting to begin',
  team: 'Team Phase',
  battle: 'Battle Phase',
  maintenance: 'Maintenance Phase',
  encounter: 'Encounter Phase',
  epilogue: 'The Aftermath',
};

/** What each phase is for, for anyone who has not run one before. */
const PHASE_NOTES = {
  team: 'Talk to your own team only. Declare targets, transfer stewardship.',
  battle: 'Targets are announced. Join a battle as attacker or defender.',
  maintenance: 'Collect income and take maintenance actions. Trade freely.',
  encounter: 'Talk to anyone. Take encounter actions.',
};

export class RbPhaseClock extends HTMLElement {
  /** The `phase` block from a projection. */
  set phase(value) {
    this._phase = value;
    this._render();
    this._ensureTicking();
  }

  /** Injectable so a test does not have to wait for a real second. */
  set now(fn) { this._now = fn; }

  connectedCallback() {
    if (!this._built) {
      this._built = true;
      this.innerHTML = `
        <div class="rb-clock-turn"></div>
        <div class="rb-clock-time"><time></time></div>
        <div class="rb-clock-note"></div>`;
    }
    this._render();
    this._ensureTicking();
  }

  disconnectedCallback() {
    clearInterval(this._timer);
    this._timer = null;
  }

  _ensureTicking() {
    if (this._timer || !this.isConnected) return;
    this._timer = setInterval(() => this._render(), 500);
  }

  _render() {
    if (!this._built || !this._phase) return;
    const phase = this._phase;
    const now = (this._now ?? Date.now)();

    const named = PHASE_NAMES[phase.name] ?? phase.name;
    const counted = phase.name !== 'lobby' && phase.name !== 'epilogue';
    this.querySelector('.rb-clock-turn').textContent =
      counted ? `Turn ${phase.turn} · ${named}` : named;

    const left = phase.paused
      ? (phase.pausedRemainingMs ?? 0)
      : (phase.endsAt === null ? null : phase.endsAt - now);

    const time = this.querySelector('time');
    if (left === null) {
      time.textContent = '';
      time.removeAttribute('datetime');
      this.dataset.state = 'idle';
    } else {
      const over = left < 0;
      time.textContent = (over ? '+' : '') + formatDuration(Math.abs(left));
      time.setAttribute('datetime', `PT${Math.round(Math.abs(left) / 1000)}S`);
      this.dataset.state = phase.paused ? 'paused' : over ? 'over' : left < 60_000 ? 'soon' : 'running';
    }

    this.querySelector('.rb-clock-note').textContent = phase.paused
      ? 'Paused by the facilitator'
      : (left !== null && left < 0)
        ? 'Over time — the facilitator will call it'
        : PHASE_NOTES[phase.name] ?? '';

    this._announce(phase, left);
  }

  /**
   * Says when the clock crosses a line. It does not decide what that is worth.
   *
   * Both consoles mount this component and only one of them makes a noise, so
   * the knowledge that a phase has run out belongs here and the choice to beep
   * about it belongs to the page — the same split as everywhere else.
   *
   * Counted in whole ten-second steps of overtime rather than by elapsed
   * ticks, and at most one event per render however many steps went by. A tab
   * in the background has its timers throttled to about once a second and can
   * come back a long way behind; a facilitator who alt-tabs to Discord for
   * three minutes should hear one beep on their return, not eighteen.
   */
  _announce(phase, left) {
    const deadline = phase.paused ? null : phase.endsAt;
    if (deadline !== this._deadline) {
      // A new phase, or a pause: whatever was counted was counted against a
      // clock that no longer exists.
      this._deadline = deadline;
      this._step = null;
    }
    if (deadline === null || left === null || left >= 0) return;

    const step = Math.floor(-left / 10_000);
    if (this._step === null) {
      this._step = step;
      this.dispatchEvent(new CustomEvent('rb-time-up', {
        bubbles: true, detail: { overMs: -left },
      }));
      return;
    }
    if (step > this._step) {
      this._step = step;
      this.dispatchEvent(new CustomEvent('rb-overtime', {
        bubbles: true, detail: { overMs: -left },
      }));
    }
  }
}

/** m:ss, which is the only shape a five-minute phase ever needs. */
export function formatDuration(ms) {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

customElements.define('rb-phase-clock', RbPhaseClock);
