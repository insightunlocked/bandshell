// Sound engine: per-track Tone.js instruments, transport, metronome,
// cycle looping, and recording. "Song beats" are positions in the song;
// the Tone transport runs from 0 each time playback starts, offset by
// the count-in and the start position.

import * as Tone from "tone";
import * as state from "./state.js";
import * as clips from "./clips.js";
import { buildInstrument } from "./instruments.js";
import { SNAP, BEATS_PER_BAR } from "./state.js";

const COUNT_IN_BEATS = 4; // one bar, like GarageBand's default count-in

let audioBuilt = false;
let click = null;
let opToken = 0; // invalidates stale awaited play/record calls

let mode = "stopped"; // "stopped" | "playing" | "recording"
let playheadBeat = 0; // song position while stopped
let startBeatAtPlay = 0; // song beat where playback began
let countIn = 0; // count-in beats prepended to the transport
let metronomeOn = true;
let cycleOn = false;

const trackNodes = new Map(); // trackId -> instrument wrapper
const heldPreview = new Map(); // midi -> instrument wrapper that is sounding it
const recordHeld = new Map(); // midi -> quantized song beat when pressed
const activeSources = new Set(); // playing audio-region buffer sources
let audioRec = null; // { trackId, stream, recorder, chunks, clipOffsetSec }

// Note: not cached as a single promise — if Tone.start() is called outside
// a user gesture it can stay pending forever, and caching that would wedge
// every later call. Re-attempt until the context is actually running.
export async function ensureAudio() {
  if (Tone.getContext().state !== "running") await Tone.start();
  if (!audioBuilt) {
    audioBuilt = true;
    click = new Tone.Synth({
      oscillator: { type: "triangle" },
      envelope: { attack: 0.001, decay: 0.06, sustain: 0, release: 0.02 },
    }).toDestination();
    click.volume.value = -12;
  }
}

// --- instruments ---
// Patches and kits live in instruments.js; re-exported here because the WAV
// renderer builds its own voices against the same factory.
export { buildInstrument };

function nodeFor(track) {
  let entry = trackNodes.get(track.id);
  if (!entry || entry.type !== track.instrument) {
    entry?.dispose();
    entry = buildInstrument(track.instrument);
    trackNodes.set(track.id, entry);
  }
  return entry;
}

function sweepNodes() {
  const alive = new Set(state.getSong().tracks.map((t) => t.id));
  for (const [tid, node] of trackNodes) {
    if (!alive.has(tid)) {
      node.dispose();
      trackNodes.delete(tid);
    }
  }
}

// Which tracks sound right now, honoring solo-overrides-mute.
export function audibleTracks(song) {
  const anySolo = song.tracks.some((t) => t.solo);
  return song.tracks.filter((t) => (anySolo ? t.solo : !t.muted));
}

// Checked at trigger time so mute/solo apply mid-playback.
function isAudible(track) {
  const anySolo = state.getSong().tracks.some((t) => t.solo);
  return anySolo ? track.solo : !track.muted;
}

// --- transport state ---

export function getMode() {
  return mode;
}

export function isMetronomeOn() {
  return metronomeOn;
}

export function toggleMetronome() {
  metronomeOn = !metronomeOn;
}

export function isCycleOn() {
  return cycleOn;
}

export function toggleCycle() {
  cycleOn = !cycleOn;
}

// The loop span (the active region), or null when cycle is off / nothing
// is selected.
export function getCycleRange() {
  if (!cycleOn) return null;
  const found = state.getActiveRegion();
  if (!found) return null;
  return {
    start: found.region.startBeat,
    end: found.region.startBeat + found.region.lengthBeats,
  };
}

function spb() {
  return 60 / state.getSong().tempo; // seconds per beat
}

function transportBeats() {
  return Tone.getTransport().seconds / spb();
}

export function getPlayheadBeat() {
  if (mode === "stopped") return playheadBeat;
  // During the count-in the playhead sits at the start position.
  return Math.max(startBeatAtPlay, transportBeats() - countIn + startBeatAtPlay);
}

export function setPlayheadBeat(beat) {
  beat = Math.max(0, beat);
  if (mode === "stopped") {
    playheadBeat = beat;
    return;
  }
  const wasRecording = mode === "recording";
  stop();
  playheadBeat = beat;
  if (wasRecording) record();
  else play();
}

// --- play / record / stop ---

export async function play() {
  const token = ++opToken;
  await ensureAudio();
  await clips.ensureBuffersFor(state.getSong());
  if (token !== opToken) return; // superseded while waiting for audio
  if (mode !== "stopped") stop();
  const t = Tone.getTransport();
  const range = getCycleRange();
  if (range) playheadBeat = range.start; // cycle playback starts at the loop
  startBeatAtPlay = playheadBeat;
  countIn = 0;
  mode = "playing";
  scheduleSong();
  if (range) {
    t.loop = true;
    t.loopStart = 0;
    t.loopEnd = (range.end - range.start) * spb();
  } else {
    t.loop = false;
  }
  t.start();
}

export async function record() {
  if (state.getSelectedTrack()?.instrument === "audio") return recordAudio();
  const token = ++opToken;
  await ensureAudio();
  await clips.ensureBuffersFor(state.getSong());
  if (token !== opToken) return; // superseded while waiting for audio
  if (mode !== "stopped") stop();
  // Punch in from the top of the playhead's bar, after a one-bar count-in.
  playheadBeat = Math.floor(playheadBeat / BEATS_PER_BAR) * BEATS_PER_BAR;
  startBeatAtPlay = playheadBeat;
  countIn = COUNT_IN_BEATS;
  mode = "recording";
  recordHeld.clear();
  state.beginTake(state.getSelectedTrack().id, playheadBeat);
  scheduleSong();
  const t = Tone.getTransport();
  t.loop = false; // no cycle while recording
  t.start();
}

// Mic recording onto an audio track. The recorder starts with the count-in,
// so the region's clipOffset marks where beat 1 lives inside the clip.
async function recordAudio() {
  const track = state.getSelectedTrack();
  const token = ++opToken;
  await ensureAudio();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    alert("Bandshell needs microphone access to record onto an Audio track.");
    return;
  }
  if (token !== opToken) {
    stream.getTracks().forEach((tr) => tr.stop());
    return;
  }
  await clips.ensureBuffersFor(state.getSong());
  if (mode !== "stopped") stop();
  playheadBeat = Math.floor(playheadBeat / BEATS_PER_BAR) * BEATS_PER_BAR;
  startBeatAtPlay = playheadBeat;
  countIn = COUNT_IN_BEATS;
  mode = "recording";

  // Analysis tap for the live waveform — never routed to the speakers
  // (that would feed back).
  const rawCtx = Tone.getContext().rawContext;
  const srcNode = rawCtx.createMediaStreamSource(stream);
  const analyser = rawCtx.createAnalyser();
  analyser.fftSize = 512;
  srcNode.connect(analyser);

  const rec = {
    trackId: track.id,
    stream,
    recorder: new MediaRecorder(stream),
    chunks: [],
    srcNode,
    analyser,
    timeData: new Uint8Array(analyser.fftSize),
    peaks: [], // live waveform buckets, REC_WAVE_RES beats each
    countInSec: COUNT_IN_BEATS * spb(),
    startCtx: 0,
    startedAtCtx: null,
  };
  // IMPORTANT: close over `rec`, not the module-level audioRec — the final
  // data arrives AFTER stop() has already cleared audioRec, and referencing
  // the module variable here silently discarded whole takes.
  rec.recorder.ondataavailable = (e) => rec.chunks.push(e.data);
  rec.recorder.onstart = () => {
    rec.startedAtCtx = rawCtx.currentTime;
  };
  audioRec = rec;
  scheduleSong();
  const t = Tone.getTransport();
  t.loop = false;
  rec.recorder.start();
  rec.startCtx = Tone.now(); // the context time the transport will start at
  t.start();
}

export const REC_WAVE_RES = 0.125; // beats per live-waveform bucket

// Sample the mic level into the current bucket; returns all buckets so far.
// Called from the animation frame while recording.
export function getRecordWave(beat) {
  const rec = audioRec;
  if (!rec?.analyser) return null;
  rec.analyser.getByteTimeDomainData(rec.timeData);
  let peak = 0;
  for (let i = 0; i < rec.timeData.length; i++) {
    const v = Math.abs(rec.timeData[i] - 128) / 128;
    if (v > peak) peak = v;
  }
  const idx = Math.max(0, Math.floor((beat - startBeatAtPlay) / REC_WAVE_RES));
  rec.peaks[idx] = Math.max(rec.peaks[idx] ?? 0, peak);
  for (let i = 0; i < idx; i++) rec.peaks[i] ??= 0;
  return rec.peaks;
}

export function getRecordStart() {
  return startBeatAtPlay;
}

export function isAudioRecording() {
  return mode === "recording" && audioRec !== null;
}

function finishAudioTake(rec, startBeat, endBeat) {
  rec.recorder.onstop = async () => {
    try {
      rec.srcNode.disconnect();
      rec.stream.getTracks().forEach((tr) => tr.stop());
      const blob = new Blob(rec.chunks, { type: rec.recorder.mimeType || "audio/webm" });
      if (!blob.size || endBeat <= startBeat) return;
      const clipId = "clip-" + Math.random().toString(36).slice(2, 10);
      clips.putClip({ id: clipId, mime: blob.type, blob });
      await clips.ensureBuffer(clipId);
      clips.persistClip(clipId);
      // Where beat 1 lives inside the clip: the count-in, plus the measured
      // gap between the recorder actually starting and the transport start.
      const startGap =
        rec.startedAtCtx != null
          ? Math.max(0, rec.startCtx - rec.startedAtCtx)
          : Tone.getContext().lookAhead;
      const clipOffset = rec.countInSec + startGap;
      const lengthBeats = Math.max(1, Math.ceil(endBeat - startBeat));
      state.addAudioRegion(rec.trackId, startBeat, lengthBeats, clipId, clipOffset);
    } catch (err) {
      console.error("Audio take failed:", err);
      alert("Couldn't process that recording — the take was lost. Details are in the console.");
    }
  };
  rec.recorder.stop();
}

export function stop() {
  opToken++; // cancel any play/record still waiting on audio startup
  if (mode === "stopped") return;
  const now = getPlayheadBeat();
  if (mode === "recording") {
    if (audioRec) {
      const rec = audioRec;
      audioRec = null;
      finishAudioTake(rec, startBeatAtPlay, now); // async; region appears on decode
    } else {
      for (const [midi, startBeat] of recordHeld) finalizeRecordedNote(midi, startBeat, now);
      recordHeld.clear();
      state.endTake();
    }
  }
  const t = Tone.getTransport();
  t.stop();
  t.cancel();
  t.loop = false;
  for (const node of trackNodes.values()) node.releaseAll();
  for (const src of activeSources) {
    try {
      src.stop();
      src.dispose();
    } catch {
      // already ended/disposed
    }
  }
  activeSources.clear();
  heldPreview.clear();
  playheadBeat = now;
  mode = "stopped";
}

function scheduleSong() {
  const t = Tone.getTransport();
  t.cancel();
  t.bpm.value = state.getSong().tempo;
  const s = spb();
  sweepNodes();

  for (const track of state.getSong().tracks) {
    let node = null;
    for (const region of track.regions) {
      if (region.clipId) {
        scheduleAudioRegion(t, track, region, s);
        continue;
      }
      node ??= nodeFor(track);
      const boundNode = node;
      for (const note of region.notes) {
        const beat = region.startBeat + note.startBeat;
        if (beat < startBeatAtPlay) continue;
        const when = (beat - startBeatAtPlay + countIn) * s;
        t.schedule((time) => {
          if (!isAudible(track)) return;
          boundNode.play(note.pitch, note.durationBeats * s, time, note.velocity / 127);
        }, when);
      }
    }
  }

  // Metronome: always during the count-in, otherwise when enabled.
  t.scheduleRepeat(
    (time) => {
      const beatIndex = Math.round(time / s);
      const inCountIn = beatIndex < countIn;
      if (!inCountIn && !metronomeOn) return;
      const songBeat = beatIndex - countIn + startBeatAtPlay;
      const accent = (inCountIn ? beatIndex : songBeat) % BEATS_PER_BAR === 0;
      click.triggerAttackRelease(accent ? 880 : 660, 0.03, time, accent ? 0.9 : 0.5);
    },
    s,
    0
  );
}

// An audio region plays its clip slice, joined mid-region if playback
// starts inside it.
function scheduleAudioRegion(t, track, region, s) {
  const regionEnd = region.startBeat + region.lengthBeats;
  if (regionEnd <= startBeatAtPlay) return;
  const playStart = Math.max(region.startBeat, startBeatAtPlay);
  const when = (playStart - startBeatAtPlay + countIn) * s;
  const offset = (region.clipOffset ?? 0) + (playStart - region.startBeat) * s;
  const dur = (regionEnd - playStart) * s;
  t.schedule((time) => {
    if (!isAudible(track)) return;
    const buffer = clips.getPlayBuffer(region.clipId, track.autotune);
    if (!buffer) return; // still decoding (or clip missing)
    const src = new Tone.ToneBufferSource(buffer).toDestination();
    activeSources.add(src);
    src.onended = () => {
      activeSources.delete(src);
      src.dispose();
    };
    src.start(time, offset, dur);
  }, when);
}

// --- live input (musical typing, piano-key clicks) ---

export async function noteOn(midi) {
  const track = state.getSelectedTrack();
  if (track?.instrument === "audio") return;
  await ensureAudio();
  if (heldPreview.has(midi)) return;
  const node = nodeFor(track);
  heldPreview.set(midi, node);
  node.attack(midi);
  if (mode === "recording") {
    recordHeld.set(midi, Math.max(0, quantize(getPlayheadBeat())));
  }
}

export function noteOff(midi) {
  const node = heldPreview.get(midi);
  if (node) {
    heldPreview.delete(midi);
    node.release(midi);
  }
  if (mode === "recording" && recordHeld.has(midi)) {
    const startBeat = recordHeld.get(midi);
    recordHeld.delete(midi);
    finalizeRecordedNote(midi, startBeat, getPlayheadBeat());
  }
}

export async function previewNote(midi, durationBeats = 0.5) {
  const found = state.getActiveRegion();
  const track = found ? found.track : state.getSelectedTrack();
  if (track?.instrument === "audio") return;
  await ensureAudio();
  nodeFor(track).play(midi, durationBeats * spb(), Tone.now(), 0.8);
}

function quantize(beat) {
  return Math.round(beat / SNAP) * SNAP;
}

function finalizeRecordedNote(midi, startBeat, endBeat) {
  const duration = Math.max(SNAP, quantize(endBeat) - startBeat);
  state.addTakeNote(midi, startBeat, duration);
}
