// ============================================================================
// paperAudio.js — Tiny procedural paper foley (no audio files, no network):
//   pickup rustle, hand-speed sliding rustle, crisp crease press, snap tick.
// Everything is synthesized from filtered noise with Web Audio and is silent
// until the first user gesture (browser autoplay rules).
// ============================================================================

export function createPaperAudio(isEnabled = () => true) {
  let ac = null;
  let noiseBuf = null;
  let master = null;
  let rustleSrc = null;
  let rustleGain = null;
  let rustleFilter = null;

  function ensure() {
    if (!isEnabled()) return null;
    if (typeof window === 'undefined') return null;
    try {
      if (!ac) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ac = new AC();
        master = ac.createGain();
        master.gain.value = 0.9;
        master.connect(ac.destination);
        const len = Math.floor(ac.sampleRate * 1.5);
        noiseBuf = ac.createBuffer(1, len, ac.sampleRate);
        const data = noiseBuf.getChannelData(0);
        // Slightly "crinkly" noise: white noise with sparse crackle impulses
        let seed = 1337;
        const rnd = () => {
          seed = (seed * 1664525 + 1013904223) >>> 0;
          return seed / 4294967296;
        };
        for (let i = 0; i < len; i++) {
          let v = rnd() * 2 - 1;
          if (rnd() < 0.0035) v *= 3.2;
          data[i] = v * 0.6;
        }
      }
      if (ac.state === 'suspended') ac.resume();
      return ac;
    } catch {
      return null;
    }
  }

  function burst({ dur = 0.06, freq = 2400, q = 0.8, gain = 0.05, type = 'bandpass', attack = 0.003, offset = 0 }) {
    const ctx = ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + offset;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.frequency.value = freq;
    filt.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filt).connect(g).connect(master);
    src.start(t0, Math.random() * 1.2);
    src.stop(t0 + dur + 0.02);
  }

  function thump({ dur = 0.08, from = 150, to = 70, gain = 0.08, offset = 0 }) {
    const ctx = ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + offset;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(from, t0);
    osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  return {
    /** Corner pinched & lifted off the table. */
    pickup() {
      burst({ dur: 0.09, freq: 2600, q: 0.7, gain: 0.045 });
      burst({ dur: 0.05, freq: 5200, q: 1.2, gain: 0.02, offset: 0.012 });
    },
    /** Start the continuous sliding rustle (volume follows hand speed). */
    startRustle() {
      const ctx = ensure();
      if (!ctx || rustleSrc) return;
      try {
        rustleSrc = ctx.createBufferSource();
        rustleSrc.buffer = noiseBuf;
        rustleSrc.loop = true;
        rustleFilter = ctx.createBiquadFilter();
        rustleFilter.type = 'bandpass';
        rustleFilter.frequency.value = 3000;
        rustleFilter.Q.value = 0.55;
        rustleGain = ctx.createGain();
        rustleGain.gain.value = 0.0001;
        rustleSrc.connect(rustleFilter).connect(rustleGain).connect(master);
        rustleSrc.start();
      } catch {
        rustleSrc = null;
      }
    },
    /** speed in [0, 1] */
    rustle(speed) {
      if (!ac || !rustleGain) return;
      const s = Math.max(0, Math.min(1, speed || 0));
      const t = ac.currentTime;
      rustleGain.gain.setTargetAtTime(isEnabled() ? 0.0001 + s * s * 0.05 : 0.0001, t, 0.04);
      rustleFilter.frequency.setTargetAtTime(2200 + s * 2600, t, 0.06);
    },
    stopRustle() {
      if (!rustleSrc) return;
      const src = rustleSrc, g = rustleGain;
      rustleSrc = null;
      rustleGain = null;
      rustleFilter = null;
      try {
        const t = ac.currentTime;
        g.gain.setTargetAtTime(0.0001, t, 0.03);
        src.stop(t + 0.15);
      } catch {
        // already stopped
      }
    },
    /** Crisp crease: paper slaps the table, then a fingernail runs along the fold. */
    crease(strength = 1) {
      const k = Math.max(0.2, Math.min(1, strength));
      thump({ dur: 0.07, from: 170, to: 75, gain: 0.07 * k });
      burst({ dur: 0.035, freq: 4200, q: 0.9, gain: 0.09 * k, type: 'highpass', attack: 0.001 });
      burst({ dur: 0.16, freq: 1900, q: 1.4, gain: 0.035 * k, offset: 0.03 });
    },
    /** Paper opening back up. */
    unfold() {
      burst({ dur: 0.2, freq: 1500, q: 0.8, gain: 0.04 });
    },
    /** Tiny magnetic snap tick. */
    snapTick() {
      burst({ dur: 0.018, freq: 5600, q: 2.5, gain: 0.03, attack: 0.001 });
    },
  };
}
