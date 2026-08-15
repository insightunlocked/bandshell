// Pitch correction ("autotune") for recorded audio, mirroring GarageBand's
// Pitch Correction slider: 0 leaves the take alone, 100 snaps every note
// hard onto the nearest semitone.
//
// Two stages:
//   1. Track the fundamental frequency with normalized autocorrelation on a
//      decimated copy of the signal (cheap enough to run on a whole take).
//   2. Resynthesize with TD-PSOLA — grains cut at the detected period and
//      re-spaced at the corrected period, which shifts pitch without
//      changing duration.

import * as Tone from "tone";

const MIN_F0 = 70; // Hz — below a low male voice
const MAX_F0 = 1100; // Hz — above a high female voice
const DECIM = 4; // analysis runs at sampleRate / DECIM
const VOICED_THRESHOLD = 0.4; // autocorrelation score to call a frame pitched
const UNVOICED_PERIOD = 256; // OLA period for noise/silence (ratio is 1 there)

export function processAutotune(buffer, amount) {
  if (amount <= 0) return buffer;
  const sr = buffer.sampleRate;
  const chIn = buffer.getChannelData(0);
  const { f0, hop } = trackPitch(chIn, sr);
  const tuned = psola(chIn, sr, f0, hop, amount);

  const ctx = Tone.getContext().rawContext;
  const out = ctx.createBuffer(1, tuned.length, sr);
  out.copyToChannel(tuned, 0);
  return out;
}

// --- stage 1: pitch tracking ---

function trackPitch(x, sr) {
  const dsr = sr / DECIM;
  const d = decimate(x, DECIM);
  const frame = Math.round(dsr * 0.046); // ~46 ms
  const hopD = Math.round(dsr * 0.012); // ~12 ms
  const minLag = Math.max(2, Math.floor(dsr / MAX_F0));
  const maxLag = Math.min(frame - 1, Math.floor(dsr / MIN_F0));

  const frames = Math.max(1, Math.floor((d.length - frame) / hopD) + 1);
  const f0 = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    f0[i] = detectF0(d, i * hopD, frame, dsr, minLag, maxLag);
  }
  return { f0: medianSmooth(f0), hop: hopD * DECIM };
}

function decimate(x, factor) {
  const n = Math.floor(x.length / factor);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // Box-average the discarded samples — crude but adequate anti-aliasing
    // for f0 tracking.
    let sum = 0;
    for (let k = 0; k < factor; k++) sum += x[i * factor + k];
    out[i] = sum / factor;
  }
  return out;
}

// Octave-safe threshold: plain autocorrelation scores a subharmonic (2x the
// true period) about as highly as the true period, so picking the global
// maximum lands an octave low surprisingly often. Instead take the FIRST
// peak that comes close to the best score.
const OCTAVE_GUARD = 0.86;

function detectF0(d, start, n, sr, minLag, maxLag) {
  let energy = 0;
  for (let i = 0; i < n; i++) {
    const v = d[start + i];
    energy += v * v;
  }
  if (energy < 1e-5) return 0; // silence

  const scores = new Float32Array(maxLag + 2);
  let bestScore = 0;
  let bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    let lagEnergy = 0;
    const count = n - lag;
    for (let i = 0; i < count; i++) {
      const a = d[start + i];
      const b = d[start + i + lag];
      corr += a * b;
      lagEnergy += b * b;
    }
    const score = corr / Math.sqrt(lagEnergy * energy + 1e-12);
    scores[lag] = score;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  if (bestScore < VOICED_THRESHOLD || !bestLag) return 0; // unvoiced

  const threshold = bestScore * OCTAVE_GUARD;
  let chosen = bestLag;
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (scores[lag] >= threshold && scores[lag] >= scores[lag - 1] && scores[lag] >= scores[lag + 1]) {
      chosen = lag;
      break;
    }
  }
  return sr / refineLag(scores, chosen);
}

// Parabolic interpolation around the peak. Integer lags alone quantize pitch
// far too coarsely to tune against (tens of cents at this analysis rate).
function refineLag(scores, lag) {
  const a = scores[lag - 1];
  const b = scores[lag];
  const c = scores[lag + 1];
  const denom = a - 2 * b + c;
  if (!denom) return lag;
  const shift = (0.5 * (a - c)) / denom;
  return Math.abs(shift) < 1 ? lag + shift : lag;
}

// Median filter kills the isolated octave errors that autocorrelation makes,
// which would otherwise be audible as a wrong-note blip.
function medianSmooth(f0) {
  const out = new Float32Array(f0.length);
  for (let i = 0; i < f0.length; i++) {
    const a = f0[Math.max(0, i - 1)];
    const b = f0[i];
    const c = f0[Math.min(f0.length - 1, i + 1)];
    out[i] = a + b + c - Math.min(a, b, c) - Math.max(a, b, c);
  }
  return out;
}

// --- stage 2: PSOLA resynthesis ---

function psola(x, sr, f0, hop, amount) {
  const periodAt = (pos) => {
    const f = f0[Math.min(f0.length - 1, Math.max(0, Math.floor(pos / hop)))];
    return f > 0 ? sr / f : UNVOICED_PERIOD;
  };
  const ratioAt = (pos) => {
    const f = f0[Math.min(f0.length - 1, Math.max(0, Math.floor(pos / hop)))];
    if (!f) return 1; // unvoiced: pass through
    return 1 + (snapFreq(f) / f - 1) * amount;
  };

  // Analysis pitch marks, one per detected period. Grains must be cut at
  // these marks — that's what makes re-spacing them shift the pitch instead
  // of just reconstructing the input.
  const marks = [];
  for (let t = 0; t < x.length; t += Math.max(8, periodAt(t))) marks.push(Math.round(t));

  const out = new Float32Array(x.length);
  const wsum = new Float32Array(x.length);
  let mi = 0;
  let tOut = 0;
  while (tOut < x.length) {
    // Identity time mapping (duration preserved): take the analysis mark
    // nearest the current output position.
    while (mi + 1 < marks.length && Math.abs(marks[mi + 1] - tOut) <= Math.abs(marks[mi] - tOut)) {
      mi++;
    }
    const ta = marks[mi];
    const periodIn = periodAt(ta);
    const ratio = ratioAt(ta);
    const half = Math.max(2, Math.round(periodIn));
    const center = Math.round(tOut);

    for (let k = -half; k < half; k++) {
      const si = ta + k; // read from the analysis mark
      const di = center + k; // write at the synthesis position
      if (si < 0 || si >= x.length || di < 0 || di >= out.length) continue;
      // Hann window over the 2-period grain.
      const w = 0.5 * (1 - Math.cos((Math.PI * (k + half)) / half));
      out[di] += x[si] * w;
      wsum[di] += w;
    }
    // Output spacing is the corrected period: tighter spacing = higher pitch.
    tOut += Math.max(8, periodIn / ratio);
  }

  // Normalize by accumulated window so overlap density doesn't change level.
  for (let i = 0; i < out.length; i++) {
    out[i] = wsum[i] > 1e-4 ? out[i] / wsum[i] : x[i];
  }
  return out;
}

function snapFreq(f) {
  const midi = 69 + 12 * Math.log2(f / 440);
  return 440 * Math.pow(2, (Math.round(midi) - 69) / 12);
}
