// Audio clip store. Clip payloads (mic recordings) deliberately live
// OUTSIDE the song model: undo snapshots and autosave JSON stay small, and
// regions just reference a clipId. Blobs persist to IndexedDB for autosave
// and embed as base64 when saving a song file.

import * as Tone from "tone";
import { processAutotune } from "./dsp/autotune.js";

const clips = new Map(); // id -> { id, mime, blob, buffer?, decoding? }
const tuned = new Map(); // `${clipId}@${amount}` -> AudioBuffer
const readyListeners = new Set();

// Fires whenever a clip's audio finishes decoding (or arrives from disk) —
// views re-render waveforms on it.
export function onClipsReady(fn) {
  readyListeners.add(fn);
}

function notifyReady() {
  for (const fn of readyListeners) fn();
}

export function putClip({ id, mime, blob, buffer = null }) {
  clips.set(id, { id, mime, blob, buffer });
  return id;
}

export function getClip(id) {
  return clips.get(id) ?? null;
}

export function getBuffer(id) {
  return clips.get(id)?.buffer ?? null;
}

export async function ensureBuffer(id) {
  const clip = clips.get(id);
  if (!clip) return null;
  if (clip.buffer) return clip.buffer;
  clip.decoding ??= (async () => {
    const ab = await clip.blob.arrayBuffer();
    clip.buffer = await Tone.getContext().rawContext.decodeAudioData(ab);
    notifyReady();
    return clip.buffer;
  })();
  return clip.decoding;
}

export async function ensureBuffersFor(song) {
  const jobs = [];
  for (const track of song.tracks) {
    for (const region of track.regions) {
      if (region.clipId) jobs.push(ensureBuffer(region.clipId));
    }
  }
  await Promise.all(jobs);
  // Pitch-corrected renders for any track with autotune engaged.
  const tuneJobs = [];
  for (const track of song.tracks) {
    if (!track.autotune) continue;
    for (const region of track.regions) {
      if (region.clipId) tuneJobs.push(ensureTuned(region.clipId, track.autotune));
    }
  }
  await Promise.all(tuneJobs);
}

// --- pitch correction ---

const tuneKey = (id, amount) => `${id}@${amount}`;

// The buffer that should actually sound: pitch-corrected when available,
// otherwise the raw take.
export function getPlayBuffer(id, amount = 0) {
  if (amount > 0) {
    const t = tuned.get(tuneKey(id, amount));
    if (t) return t;
  }
  return getBuffer(id);
}

export async function ensureTuned(id, amount) {
  if (!amount) return null;
  const key = tuneKey(id, amount);
  const cached = tuned.get(key);
  if (cached) return cached;
  const raw = await ensureBuffer(id);
  if (!raw) return null;
  // Yield first so callers can paint a "tuning…" state before this blocks.
  await new Promise((r) => setTimeout(r, 0));
  const result = processAutotune(raw, amount / 100);
  tuned.set(key, result);
  notifyReady();
  return result;
}

// Peak amplitude (0..1) per bucket for a window of the clip. Returns null
// while the clip is still decoding (and kicks the decode off).
export function peaks(id, offsetSec, durSec, buckets) {
  const buffer = getBuffer(id);
  if (!buffer) {
    ensureBuffer(id);
    return null;
  }
  const data = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const start = Math.floor(offsetSec * sr);
  const len = Math.max(1, Math.floor(durSec * sr));
  const out = new Float32Array(buckets);
  const per = len / buckets;
  for (let b = 0; b < buckets; b++) {
    let peak = 0;
    const s0 = start + Math.floor(b * per);
    const s1 = Math.min(data.length, start + Math.floor((b + 1) * per));
    for (let i = s0; i < s1; i += 8) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
    }
    out[b] = peak;
  }
  return out;
}

// --- IndexedDB persistence (the autosave for audio) ---

const DB_NAME = "bandshell-clips";
const STORE = "clips";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function persistClip(id) {
  const clip = clips.get(id);
  if (!clip) return;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ id: clip.id, mime: clip.mime, blob: clip.blob });
    await new Promise((res, rej) => {
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  } catch {
    // best-effort; the in-memory clip still works this session
  }
}

export async function loadPersistedClips() {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readonly");
    const all = await new Promise((res, rej) => {
      const q = tx.objectStore(STORE).getAll();
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
    db.close();
    for (const rec of all) if (!clips.has(rec.id)) putClip(rec);
    if (all.length) notifyReady();
  } catch {
    // best-effort
  }
}

// --- base64 (for embedding clips in saved song files) ---

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",", 2)[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export function base64ToBlob(base64, mime) {
  const bin = atob(base64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
