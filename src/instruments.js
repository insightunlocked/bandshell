// Every playable sound in Bandshell, and the factory that turns an
// instrument key into a voice. Each wrapper exposes the same small surface:
//   play(midi, durSec, time, vel) · attack(midi) · release(midi)
//   releaseAll() · dispose()
// so the engine never cares whether it is driving a synth or a drum kit.

import * as Tone from "tone";

function freq(midi) {
  return Tone.Frequency(midi, "midi").toFrequency();
}

// --- pitched patches: [VoiceClass, options, volume dB] ---

const MELODIC_PATCHES = {
  piano: [
    Tone.FMSynth,
    {
      harmonicity: 3,
      modulationIndex: 6,
      envelope: { attack: 0.004, decay: 0.5, sustain: 0.15, release: 0.7 },
      modulationEnvelope: { attack: 0.002, decay: 0.35, sustain: 0.05, release: 0.4 },
    },
    -10,
  ],
  epiano: [
    Tone.FMSynth,
    {
      harmonicity: 2,
      modulationIndex: 11,
      oscillator: { type: "sine" },
      envelope: { attack: 0.003, decay: 1.4, sustain: 0.1, release: 1.1 },
      modulationEnvelope: { attack: 0.004, decay: 0.6, sustain: 0.02, release: 0.6 },
    },
    -11,
  ],
  organ: [
    Tone.Synth,
    {
      // Drawbar-style additive partials, and no decay — organs just hold.
      oscillator: { type: "custom", partials: [1, 0.55, 0.35, 0.22, 0.13, 0.08] },
      envelope: { attack: 0.012, decay: 0.05, sustain: 1, release: 0.12 },
    },
    -16,
  ],
  synth: [
    Tone.Synth,
    {
      oscillator: { type: "fatsawtooth", count: 3, spread: 18 },
      envelope: { attack: 0.01, decay: 0.25, sustain: 0.5, release: 0.35 },
    },
    -14,
  ],
  pad: [
    Tone.Synth,
    {
      oscillator: { type: "fatsine", count: 4, spread: 45 },
      envelope: { attack: 0.7, decay: 1.2, sustain: 0.85, release: 2.2 },
    },
    -15,
  ],
  pluck: [
    Tone.Synth,
    {
      oscillator: { type: "triangle" },
      envelope: { attack: 0.002, decay: 0.35, sustain: 0, release: 0.25 },
    },
    -9,
  ],
  bells: [
    Tone.AMSynth,
    {
      harmonicity: 3.01,
      oscillator: { type: "sine" },
      envelope: { attack: 0.002, decay: 1.6, sustain: 0, release: 1.4 },
      modulation: { type: "square" },
      modulationEnvelope: { attack: 0.002, decay: 0.3, sustain: 0.1, release: 0.4 },
    },
    -14,
  ],
  bass: [
    Tone.MonoSynth,
    {
      oscillator: { type: "square" },
      envelope: { attack: 0.004, decay: 0.15, sustain: 0.5, release: 0.2 },
      filterEnvelope: {
        attack: 0.003,
        decay: 0.12,
        sustain: 0.35,
        release: 0.2,
        baseFrequency: 110,
        octaves: 2.5,
      },
    },
    -8,
  ],
  synthbass: [
    Tone.MonoSynth,
    {
      oscillator: { type: "sawtooth" },
      envelope: { attack: 0.006, decay: 0.3, sustain: 0.7, release: 0.25 },
      filter: { Q: 4, type: "lowpass" },
      filterEnvelope: {
        attack: 0.004,
        decay: 0.22,
        sustain: 0.2,
        release: 0.3,
        baseFrequency: 60,
        octaves: 3.2,
      },
    },
    -9,
  ],
  strings: [
    Tone.Synth,
    {
      oscillator: { type: "fatsawtooth", count: 3, spread: 28 },
      envelope: { attack: 0.22, decay: 0.3, sustain: 0.8, release: 1.1 },
    },
    -16,
  ],
  brass: [
    Tone.FMSynth,
    {
      harmonicity: 1,
      modulationIndex: 9,
      envelope: { attack: 0.06, decay: 0.2, sustain: 0.75, release: 0.3 },
      modulationEnvelope: { attack: 0.09, decay: 0.2, sustain: 0.6, release: 0.3 },
    },
    -15,
  ],
};

// --- drum kits ---
// Each kit maps the shared kit note numbers (see DRUM_KIT in state.js) onto
// synthesized pieces, so switching kits keeps every programmed beat intact.

const KITS = {
  drums: {
    filter: 18000,
    kick: { pitchDecay: 0.04, octaves: 6, decay: 0.35, note: "C1", vol: -6 },
    tom: { pitchDecay: 0.06, octaves: 3, decay: 0.25, note: "A2", vol: -8 },
    snare: { noise: "white", decay: 0.17, vol: -10 },
    clap: { noise: "pink", decay: 0.1, vol: -9 },
    hatC: { decay: 0.05, vol: -18 },
    hatO: { decay: 0.3, vol: -18 },
    crash: { decay: 1.1, vol: -16 },
    ride: { decay: 0.5, vol: -19 },
    metal: { harmonicity: 5.1, resonance: 4000, octaves: 1.5 },
  },
  drums808: {
    filter: 18000,
    // The 808 signature: a long pitch sweep and a kick that rings.
    kick: { pitchDecay: 0.18, octaves: 8, decay: 1.1, note: "C1", vol: -4 },
    tom: { pitchDecay: 0.14, octaves: 4, decay: 0.6, note: "G2", vol: -9 },
    snare: { noise: "white", decay: 0.11, vol: -12 },
    clap: { noise: "white", decay: 0.14, vol: -8 },
    hatC: { decay: 0.03, vol: -16 },
    hatO: { decay: 0.42, vol: -17 },
    crash: { decay: 0.9, vol: -18 },
    ride: { decay: 0.35, vol: -20 },
    metal: { harmonicity: 8.5, resonance: 6500, octaves: 2 },
  },
  drumslofi: {
    filter: 2600, // the whole kit through a lowpass: dusty, boom-bap
    kick: { pitchDecay: 0.05, octaves: 5, decay: 0.4, note: "B0", vol: -5 },
    tom: { pitchDecay: 0.05, octaves: 3, decay: 0.3, note: "G2", vol: -9 },
    snare: { noise: "brown", decay: 0.2, vol: -8 },
    clap: { noise: "pink", decay: 0.13, vol: -10 },
    hatC: { decay: 0.045, vol: -14 },
    hatO: { decay: 0.25, vol: -15 },
    crash: { decay: 0.8, vol: -14 },
    ride: { decay: 0.4, vol: -17 },
    metal: { harmonicity: 4.2, resonance: 2200, octaves: 1.2 },
  },
};

function buildKit(cfg) {
  const bus = new Tone.Filter(cfg.filter, "lowpass").toDestination();

  const membrane = (c) => {
    const s = new Tone.MembraneSynth({
      pitchDecay: c.pitchDecay,
      octaves: c.octaves,
      envelope: { attack: 0.001, decay: c.decay, sustain: 0 },
    }).connect(bus);
    s.volume.value = c.vol;
    return s;
  };
  const noise = (c) => {
    const s = new Tone.NoiseSynth({
      noise: { type: c.noise },
      envelope: { attack: 0.001, decay: c.decay, sustain: 0 },
    }).connect(bus);
    s.volume.value = c.vol;
    return s;
  };
  const metal = (c) => {
    const s = new Tone.MetalSynth({
      envelope: { attack: 0.001, decay: c.decay, release: 0.05 },
      harmonicity: cfg.metal.harmonicity,
      modulationIndex: 32,
      resonance: cfg.metal.resonance,
      octaves: cfg.metal.octaves,
    }).connect(bus);
    s.volume.value = c.vol;
    return s;
  };

  const kick = membrane(cfg.kick);
  const tom = membrane(cfg.tom);
  const snare = noise(cfg.snare);
  const clap = noise(cfg.clap);
  const hatC = metal(cfg.hatC);
  const hatO = metal(cfg.hatO);
  const crash = metal(cfg.crash);
  const ride = metal(cfg.ride);

  const pieces = {
    36: (t, v) => kick.triggerAttackRelease(cfg.kick.note, cfg.kick.decay, t, v),
    38: (t, v) => snare.triggerAttackRelease(cfg.snare.decay, t, v),
    39: (t, v) => clap.triggerAttackRelease(cfg.clap.decay, t, v),
    42: (t, v) => hatC.triggerAttackRelease("G5", cfg.hatC.decay, t, v * 0.8),
    46: (t, v) => hatO.triggerAttackRelease("G5", cfg.hatO.decay, t, v * 0.8),
    45: (t, v) => tom.triggerAttackRelease(cfg.tom.note, cfg.tom.decay, t, v),
    49: (t, v) => crash.triggerAttackRelease("C5", cfg.crash.decay, t, v * 0.7),
    51: (t, v) => ride.triggerAttackRelease("D5", cfg.ride.decay, t, v * 0.6),
  };
  const all = [kick, tom, snare, clap, hatC, hatO, crash, ride, bus];

  return {
    play(midi, durSec, time, vel) {
      pieces[midi]?.(time, vel);
    },
    attack(midi) {
      pieces[midi]?.(Tone.now(), 0.9);
    },
    release() {},
    releaseAll() {},
    dispose() {
      all.forEach((n) => n.dispose());
    },
  };
}

export function buildInstrument(type) {
  if (KITS[type]) return { type, ...buildKit(KITS[type]) };

  const [Voice, opts, vol] = MELODIC_PATCHES[type] ?? MELODIC_PATCHES.piano;
  const synth = new Tone.PolySynth(Voice, opts).toDestination();
  synth.volume.value = vol;
  return {
    type,
    play(midi, durSec, time, vel) {
      synth.triggerAttackRelease(freq(midi), durSec, time, vel);
    },
    attack(midi) {
      synth.triggerAttack(freq(midi), Tone.now(), 0.8);
    },
    release(midi) {
      synth.triggerRelease(freq(midi), Tone.now());
    },
    releaseAll() {
      synth.releaseAll();
    },
    dispose() {
      synth.dispose();
    },
  };
}
