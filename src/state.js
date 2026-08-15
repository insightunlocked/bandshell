// Song data model. Times are in beats (1 beat = one quarter note),
// pitches are MIDI note numbers (60 = middle C).
// Songs hold tracks; tracks hold regions (blocks on the timeline);
// regions hold notes whose startBeat is relative to the region.

export const SNAP = 0.25; // sixteenth-note grid
export const BEATS_PER_BAR = 4; // 4/4 only for now

// Every instrument a track can play, grouped into families for the picker.
// `kind` drives the editor: "melodic" gets the piano roll, "drums" the kit
// grid, "audio" the waveform + pitch-correction view.
export const INSTRUMENTS = {
  piano: { label: "Grand Piano", icon: "\u{1F3B9}", kind: "melodic", family: "Keyboards" },
  epiano: { label: "Electric Piano", icon: "\u{1F3B9}", kind: "melodic", family: "Keyboards" },
  organ: { label: "Organ", icon: "\u{1F3B9}", kind: "melodic", family: "Keyboards" },
  synth: { label: "Synth Lead", icon: "\u{1F39B}️", kind: "melodic", family: "Synths" },
  pad: { label: "Synth Pad", icon: "\u{1F39B}️", kind: "melodic", family: "Synths" },
  pluck: { label: "Pluck", icon: "\u{1F39B}️", kind: "melodic", family: "Synths" },
  bells: { label: "Bells", icon: "\u{1F514}", kind: "melodic", family: "Synths" },
  bass: { label: "Electric Bass", icon: "\u{1F3B8}", kind: "melodic", family: "Bass" },
  synthbass: { label: "Synth Bass", icon: "\u{1F3B8}", kind: "melodic", family: "Bass" },
  strings: { label: "Strings", icon: "\u{1F3BB}", kind: "melodic", family: "Orchestral" },
  brass: { label: "Brass", icon: "\u{1F3BA}", kind: "melodic", family: "Orchestral" },
  drums: { label: "Acoustic Kit", icon: "\u{1F941}", kind: "drums", family: "Drums" },
  drums808: { label: "808 Kit", icon: "\u{1F941}", kind: "drums", family: "Drums" },
  drumslofi: { label: "Lo-Fi Kit", icon: "\u{1F941}", kind: "drums", family: "Drums" },
  audio: { label: "Audio", icon: "\u{1F3A4}", kind: "audio", family: "Audio" },
};

// Picker order, and the families offered when adding a track.
export const INSTRUMENT_FAMILIES = [
  "Keyboards",
  "Synths",
  "Bass",
  "Orchestral",
  "Drums",
  "Audio",
];

export function instrumentsInFamily(family) {
  return Object.entries(INSTRUMENTS).filter(([, ins]) => ins.family === family);
}

// Drum-kit rows for the editor and key map (General MIDI note numbers).
export const DRUM_KIT = [
  { midi: 36, name: "Kick" },
  { midi: 38, name: "Snare" },
  { midi: 39, name: "Clap" },
  { midi: 42, name: "Cl Hat" },
  { midi: 46, name: "Op Hat" },
  { midi: 45, name: "Tom" },
  { midi: 49, name: "Crash" },
  { midi: 51, name: "Ride" },
];

import * as clips from "./clips.js";

const STORAGE_KEY = "bandshell-song-v1";
const MAX_UNDO = 200;
const DEFAULT_REGION_BEATS = 16; // 4 bars

let song = load() || defaultSong();
let selectedTrackId = song.tracks[0].id;
let selectedRegionId = song.tracks[0].regions[0]?.id ?? null;
const noteSelection = new Set(); // selected note ids (within the active region)
const listeners = new Set();
const undoStack = [];
const redoStack = [];
let batchBefore = null;
let saveTimer = null;
let clipboard = null; // copied region contents
let takeTrackId = null;
let takeStartBeat = 0;
let takeRegionId = null;

function defaultSong() {
  const track = makeTrack("piano", "Piano");
  track.regions.push(makeRegion(0, DEFAULT_REGION_BEATS));
  return { tempo: 120, tracks: [track] };
}

function makeTrack(instrument, name) {
  return { id: id(), name, instrument, muted: false, solo: false, autotune: 0, regions: [] };
}

function makeRegion(startBeat, lengthBeats) {
  return { id: id(), startBeat, lengthBeats, notes: [] };
}

function id() {
  return Math.random().toString(36).slice(2, 10);
}

function uniqueName(base, exceptTrackId = null) {
  const names = new Set(
    song.tracks.filter((t) => t.id !== exceptTrackId).map((t) => t.name)
  );
  if (!names.has(base)) return base;
  let i = 2;
  while (names.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

export function getSong() {
  return song;
}

export function onChange(fn) {
  listeners.add(fn);
}

function emit() {
  for (const fn of listeners) fn();
  scheduleSave();
}

// Exposed for live drag gestures that mutate objects directly.
export function notifyLiveChange() {
  emit();
}

// --- persistence (autosave + files) ---

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(song));
    } catch {
      // storage full or unavailable; autosave is best-effort
    }
  }, 400);
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalize(JSON.parse(raw));
  } catch {
    // corrupted save; start fresh
  }
  return null;
}

export function serialize() {
  return JSON.stringify({ app: "bandshell", version: 2, song }, null, 2);
}

// Full song file including embedded audio clips (base64).
export async function serializeSongFile() {
  const used = new Set();
  for (const track of song.tracks) {
    for (const region of track.regions) {
      if (region.clipId) used.add(region.clipId);
    }
  }
  const clipsOut = {};
  for (const cid of used) {
    const clip = clips.getClip(cid);
    if (clip) clipsOut[cid] = { mime: clip.mime, data: await clips.blobToBase64(clip.blob) };
  }
  return JSON.stringify({ app: "bandshell", version: 3, song, clips: clipsOut });
}

// Load a parsed song file (or raw song object). Returns false if invalid.
export function loadFromData(data) {
  const normalized = normalize(data?.song ?? data);
  if (!normalized) return false;
  if (data?.clips && typeof data.clips === "object") {
    for (const [cid, c] of Object.entries(data.clips)) {
      if (!c || typeof c.data !== "string") continue;
      if (clips.getClip(cid)) continue; // already in memory (clips are immutable)
      try {
        const mime = String(c.mime || "audio/webm");
        clips.putClip({ id: cid, mime, blob: clips.base64ToBlob(c.data, mime) });
        clips.persistClip(cid);
      } catch {
        // skip malformed clip; its regions will simply be silent
      }
    }
  }
  const before = snapshot();
  song = normalized;
  fixSelection();
  commitUndo(before);
  return true;
}

// Coerce untrusted/older data into a valid song, dropping anything malformed.
function normalize(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.tracks)) return null;
  const out = { tempo: clampTempo(num(raw.tempo, 120)), tracks: [] };
  for (const t of raw.tracks) {
    if (!t || typeof t !== "object") continue;
    const instrument = INSTRUMENTS[t.instrument] ? t.instrument : "piano";
    const track = {
      id: String(t.id ?? id()),
      name: String(t.name ?? INSTRUMENTS[instrument].label),
      instrument,
      muted: !!t.muted,
      solo: !!t.solo,
      autotune: Math.min(100, Math.max(0, Math.round(num(t.autotune, 0)))),
      regions: [],
    };
    for (const r of Array.isArray(t.regions) ? t.regions : []) {
      // Audio regions reference a clip instead of holding notes.
      if (typeof r?.clipId === "string") {
        track.regions.push({
          id: String(r.id ?? id()),
          startBeat: Math.max(0, num(r.startBeat, 0)),
          lengthBeats: Math.max(1, num(r.lengthBeats, BEATS_PER_BAR)),
          clipId: r.clipId,
          clipOffset: Math.max(0, num(r.clipOffset, 0)),
        });
        continue;
      }
      const region = {
        id: String(r?.id ?? id()),
        startBeat: Math.max(0, num(r?.startBeat, 0)),
        lengthBeats: Math.max(BEATS_PER_BAR, num(r?.lengthBeats, DEFAULT_REGION_BEATS)),
        notes: [],
      };
      for (const n of Array.isArray(r?.notes) ? r.notes : []) {
        const pitch = Math.round(num(n?.pitch, NaN));
        const startBeat = num(n?.startBeat, NaN);
        const durationBeats = num(n?.durationBeats, NaN);
        if (![pitch, startBeat, durationBeats].every(Number.isFinite)) continue;
        region.notes.push({
          id: String(n.id ?? id()),
          pitch,
          startBeat: Math.max(0, startBeat),
          durationBeats: Math.max(SNAP, durationBeats),
          velocity: Math.min(127, Math.max(1, Math.round(num(n?.velocity, 100)))),
        });
      }
      track.regions.push(region);
    }
    out.tracks.push(track);
  }
  return out.tracks.length ? out : null;
}

function num(v, dflt) {
  return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}

function clampTempo(bpm) {
  return Math.min(240, Math.max(40, Math.round(bpm)));
}

// --- undo / redo ---

export function snapshot() {
  return JSON.stringify(song);
}

// Push `before` as an undo step if the song actually changed since then.
export function commitUndo(before) {
  if (before === snapshot()) return;
  undoStack.push(before);
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;
  emit();
}

export function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  song = JSON.parse(undoStack.pop());
  fixSelection();
  emit();
}

export function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  song = JSON.parse(redoStack.pop());
  fixSelection();
  emit();
}

// --- lookup helpers ---

function trackById(idT) {
  return song.tracks.find((t) => t.id === idT) ?? null;
}

// Returns {track, region} or null.
export function findRegion(idR) {
  for (const track of song.tracks) {
    const region = track.regions.find((r) => r.id === idR);
    if (region) return { track, region };
  }
  return null;
}

// --- selection ---

export function getSelectedTrack() {
  return trackById(selectedTrackId) ?? song.tracks[0];
}

export function selectTrack(idT) {
  if (idT === selectedTrackId || !trackById(idT)) return;
  selectedTrackId = idT;
  const found = findRegion(selectedRegionId);
  if (!found || found.track.id !== idT) {
    selectedRegionId = trackById(idT).regions[0]?.id ?? null;
  }
  noteSelection.clear();
  emit();
}

export function getSelectedRegionId() {
  return selectedRegionId;
}

// The region shown in the editor. Returns {track, region} or null.
export function getActiveRegion() {
  return findRegion(selectedRegionId);
}

export function selectRegion(idR) {
  const found = findRegion(idR);
  if (!found) return;
  selectedRegionId = idR;
  selectedTrackId = found.track.id;
  noteSelection.clear();
  emit();
}

export function getSelection() {
  return noteSelection;
}

export function selectNote(noteId, additive = false) {
  if (!additive) noteSelection.clear();
  noteSelection.add(noteId);
  emit();
}

export function clearSelection() {
  if (!noteSelection.size) return;
  noteSelection.clear();
  emit();
}

function fixSelection() {
  if (!trackById(selectedTrackId)) selectedTrackId = song.tracks[0].id;
  const found = findRegion(selectedRegionId);
  if (!found) {
    selectedRegionId = getSelectedTrack().regions[0]?.id ?? null;
  } else {
    selectedTrackId = found.track.id;
  }
  const active = getActiveRegion();
  const ids = new Set(active?.region.notes?.map((n) => n.id) ?? []); // audio regions hold no notes
  for (const nId of [...noteSelection]) if (!ids.has(nId)) noteSelection.delete(nId);
}

// --- track operations ---

export function addTrack(instrument) {
  if (!INSTRUMENTS[instrument]) return null;
  const before = snapshot();
  const track = makeTrack(instrument, uniqueName(INSTRUMENTS[instrument].label));
  song.tracks.push(track);
  selectedTrackId = track.id;
  selectedRegionId = null;
  noteSelection.clear();
  commitUndo(before);
  return track;
}

export function removeTrack(idT) {
  if (song.tracks.length <= 1) return; // keep at least one track
  const idx = song.tracks.findIndex((t) => t.id === idT);
  if (idx < 0) return;
  const before = snapshot();
  song.tracks.splice(idx, 1);
  if (selectedTrackId === idT) {
    selectedTrackId = song.tracks[Math.max(0, idx - 1)].id;
    selectedRegionId = getSelectedTrack().regions[0]?.id ?? null;
    noteSelection.clear();
  }
  fixSelection();
  commitUndo(before);
}

// Swap a track's sound. MIDI instruments (melodic/drums) interchange freely
// and keep their notes — the kit grid and piano roll share note numbers, so
// a bassline can become a drum pattern and back. Audio tracks hold recorded
// waveforms, so they can't cross over.
export function setTrackInstrument(idT, key) {
  const track = trackById(idT);
  const next = INSTRUMENTS[key];
  if (!track || !next || track.instrument === key) return false;
  const isAudio = (k) => INSTRUMENTS[k].kind === "audio";
  if (isAudio(track.instrument) !== isAudio(key)) return false;

  const before = snapshot();
  const oldLabel = INSTRUMENTS[track.instrument].label;
  track.instrument = key;
  // Rename only if the track still carries its default name, so a track the
  // user named "Chorus" keeps that name.
  if (track.name === oldLabel || new RegExp(`^${escapeRe(oldLabel)} \\d+$`).test(track.name)) {
    track.name = uniqueName(next.label, track.id);
  }
  commitUndo(before);
  return true;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function renameTrack(idT, name) {
  const track = trackById(idT);
  const clean = String(name ?? "").trim();
  if (!track || !clean || track.name === clean) return;
  const before = snapshot();
  track.name = uniqueName(clean, idT);
  commitUndo(before);
}

export function toggleMute(idT) {
  const track = trackById(idT);
  if (!track) return;
  const before = snapshot();
  track.muted = !track.muted;
  commitUndo(before);
}

// Pitch-correction amount, 0-100 (GarageBand's Pitch Correction slider).
// Live during a drag; the caller commits one undo step on release.
export function setTrackAutotuneLive(idT, amount) {
  const track = trackById(idT);
  if (!track) return;
  const next = Math.min(100, Math.max(0, Math.round(amount)));
  if (next === track.autotune) return;
  track.autotune = next;
  emit();
}

export function toggleSolo(idT) {
  const track = trackById(idT);
  if (!track) return;
  const before = snapshot();
  track.solo = !track.solo;
  commitUndo(before);
}

// --- region operations ---

export function addRegion(trackId, startBeat, lengthBeats = DEFAULT_REGION_BEATS) {
  const track = trackById(trackId);
  if (!track) return null;
  const before = snapshot();
  const region = makeRegion(Math.max(0, startBeat), lengthBeats);
  track.regions.push(region);
  selectedTrackId = trackId;
  selectedRegionId = region.id;
  noteSelection.clear();
  commitUndo(before);
  return region;
}

export function deleteRegion(idR) {
  const found = findRegion(idR);
  if (!found) return;
  const before = snapshot();
  found.track.regions = found.track.regions.filter((r) => r.id !== idR);
  fixSelection();
  commitUndo(before);
}

// The copyable payload of a region (notes for MIDI, clip reference for
// audio — clips are immutable, so copies can share one).
function cloneRegionContents(region) {
  return region.clipId
    ? { lengthBeats: region.lengthBeats, clipId: region.clipId, clipOffset: region.clipOffset }
    : { lengthBeats: region.lengthBeats, notes: region.notes.map((n) => ({ ...n, id: id() })) };
}

// Clone a region in place (for option-drag). No undo step here — the drag
// gesture that follows commits one step covering clone + move.
export function duplicateRegionLive(idR) {
  const found = findRegion(idR);
  if (!found) return null;
  const clone = {
    id: id(),
    startBeat: found.region.startBeat,
    ...cloneRegionContents(found.region),
  };
  found.track.regions.push(clone);
  selectedRegionId = clone.id;
  selectedTrackId = found.track.id;
  noteSelection.clear();
  emit();
  return clone;
}

// Reparent a region during a drag (live, no undo step).
export function moveRegionToTrackLive(idR, targetTrackId) {
  const found = findRegion(idR);
  const target = trackById(targetTrackId);
  if (!found || !target || found.track === target) return;
  found.track.regions = found.track.regions.filter((r) => r.id !== idR);
  target.regions.push(found.region);
  selectedTrackId = targetTrackId;
  emit();
}

export function copyActiveRegion() {
  const found = getActiveRegion();
  if (!found) return false;
  clipboard = JSON.parse(JSON.stringify(cloneRegionContents(found.region)));
  return true;
}

export function pasteRegion(atBeat) {
  if (!clipboard) return;
  const track = getSelectedTrack();
  const before = snapshot();
  const region = {
    id: id(),
    startBeat: Math.max(0, Math.floor(atBeat / BEATS_PER_BAR) * BEATS_PER_BAR),
    ...JSON.parse(JSON.stringify(clipboard)),
  };
  if (region.notes) region.notes = region.notes.map((n) => ({ ...n, id: id() }));
  track.regions.push(region);
  selectedRegionId = region.id;
  selectedTrackId = track.id;
  noteSelection.clear();
  commitUndo(before);
}

// --- note operations (target the active region) ---

export function addNote(pitch, startBeat, durationBeats) {
  const found = getActiveRegion();
  if (!found || found.region.clipId) return null; // audio regions hold no notes
  const note = { id: id(), pitch, startBeat, durationBeats, velocity: 100 };
  const before = snapshot();
  found.region.notes.push(note);
  extendRegion(found.region, startBeat + durationBeats);
  commitUndo(before);
  return note;
}

// Delete follows GarageBand's focus rules: selected notes first, else the
// selected region.
// A finished mic take becomes an audio region referencing its clip.
export function addAudioRegion(trackId, startBeat, lengthBeats, clipId, clipOffset) {
  const track = trackById(trackId);
  if (!track) return null;
  const before = snapshot();
  const region = {
    id: id(),
    startBeat: Math.max(0, startBeat),
    lengthBeats: Math.max(1, lengthBeats),
    clipId,
    clipOffset: Math.max(0, clipOffset),
  };
  track.regions.push(region);
  selectedTrackId = trackId;
  selectedRegionId = region.id;
  noteSelection.clear();
  commitUndo(before);
  return region;
}

export function deleteSelected() {
  if (noteSelection.size) {
    const found = getActiveRegion();
    if (!found || found.region.clipId) return;
    const before = snapshot();
    found.region.notes = found.region.notes.filter((n) => !noteSelection.has(n.id));
    noteSelection.clear();
    commitUndo(before);
  } else if (selectedRegionId) {
    deleteRegion(selectedRegionId);
  }
}

// Grow the active region to the next bar boundary that fits endBeat.
// No emit — drag gestures batch their own updates.
export function ensureRegionLength(endBeat) {
  const found = getActiveRegion();
  if (found && !found.region.clipId) extendRegion(found.region, endBeat);
}

function extendRegion(region, endBeat) {
  const needed = Math.ceil(endBeat / BEATS_PER_BAR) * BEATS_PER_BAR;
  if (needed > region.lengthBeats) region.lengthBeats = needed;
}

// --- recording takes ---
// A take records into a fresh region on the target track (created lazily on
// the first note, so an empty take leaves nothing behind), and undoes as a
// single step.

export function beginTake(trackId, startBeat) {
  batchBefore = snapshot();
  takeTrackId = trackId;
  takeStartBeat = startBeat;
  takeRegionId = null;
}

export function addTakeNote(pitch, songBeat, durationBeats) {
  const track = trackById(takeTrackId);
  if (!track) return;
  let region = track.regions.find((r) => r.id === takeRegionId);
  if (!region) {
    region = makeRegion(takeStartBeat, BEATS_PER_BAR);
    track.regions.push(region);
    takeRegionId = region.id;
    selectedRegionId = region.id;
    selectedTrackId = track.id;
    noteSelection.clear();
  }
  const rel = Math.max(0, songBeat - region.startBeat);
  region.notes.push({ id: id(), pitch, startBeat: rel, durationBeats, velocity: 100 });
  extendRegion(region, rel + durationBeats);
  emit();
}

export function endTake() {
  if (batchBefore !== null) {
    commitUndo(batchBefore);
    batchBefore = null;
  }
  takeTrackId = null;
  takeRegionId = null;
}

// --- tempo ---

export function setTempo(bpm) {
  if (!bpm) return;
  bpm = clampTempo(bpm);
  if (bpm === song.tempo) return;
  const before = snapshot();
  song.tempo = bpm;
  commitUndo(before);
}
