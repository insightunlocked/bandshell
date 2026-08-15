// Standard MIDI File (format 1) writer. The point of this file: a song
// exported here drops straight into GarageBand (or Logic, or any DAW) and
// keeps its tracks, names, tempo, and — because the drum kit already uses
// General MIDI note numbers on channel 10 — its drum mapping.

import { BEATS_PER_BAR } from "../state.js";

const TPQ = 480; // ticks per quarter note

// General MIDI program numbers for our melodic instruments.
const GM_PROGRAM = {
  piano: 0, // Acoustic Grand Piano
  synth: 81, // Lead 2 (sawtooth)
  bass: 38, // Synth Bass 1
  strings: 48, // String Ensemble 1
};

const DRUM_CHANNEL = 9; // MIDI channel 10, the GM drum channel

export function songToMidi(song) {
  const bytes = [];

  // MIDI can only carry note data — audio tracks are skipped.
  const midiTracks = song.tracks.filter((t) => t.instrument !== "audio");

  // Header: format 1, tempo track + one track per song track.
  const ntrks = midiTracks.length + 1;
  bytes.push(
    ...chunk("MThd", [0, 1, (ntrks >> 8) & 0xff, ntrks & 0xff, (TPQ >> 8) & 0xff, TPQ & 0xff])
  );

  // Tempo track: tempo + 4/4 time signature.
  const mpq = Math.round(60_000_000 / song.tempo);
  bytes.push(
    ...trackChunk([
      { tick: 0, ord: 0, data: [0xff, 0x51, 0x03, (mpq >> 16) & 0xff, (mpq >> 8) & 0xff, mpq & 0xff] },
      { tick: 0, ord: 0, data: [0xff, 0x58, 0x04, BEATS_PER_BAR, 2, 24, 8] },
    ])
  );

  let melodicChannel = 0;
  for (const track of midiTracks) {
    const isDrums = track.instrument === "drums";
    let ch;
    if (isDrums) {
      ch = DRUM_CHANNEL;
    } else {
      if (melodicChannel === DRUM_CHANNEL) melodicChannel++;
      ch = melodicChannel % 16;
      melodicChannel++;
    }

    const events = [];
    const name = new TextEncoder().encode(track.name).slice(0, 127);
    events.push({ tick: 0, ord: 0, data: [0xff, 0x03, name.length, ...name] });
    if (!isDrums) {
      events.push({ tick: 0, ord: 0, data: [0xc0 | ch, GM_PROGRAM[track.instrument] ?? 0] });
    }

    for (const region of track.regions) {
      if (region.clipId) continue; // audio region dragged onto a MIDI track
      for (const note of region.notes) {
        const startTick = Math.round((region.startBeat + note.startBeat) * TPQ);
        const endTick = Math.max(
          startTick + 1,
          Math.round((region.startBeat + note.startBeat + note.durationBeats) * TPQ)
        );
        const pitch = clamp(note.pitch, 0, 127);
        const vel = clamp(note.velocity, 1, 127);
        events.push({ tick: startTick, ord: 2, data: [0x90 | ch, pitch, vel] });
        events.push({ tick: endTick, ord: 1, data: [0x80 | ch, pitch, 0] });
      }
    }

    // Sort by time; at equal ticks, note-offs before note-ons.
    events.sort((a, b) => a.tick - b.tick || a.ord - b.ord);
    bytes.push(...trackChunk(events));
  }

  return new Uint8Array(bytes);
}

function trackChunk(events) {
  const data = [];
  let lastTick = 0;
  for (const ev of events) {
    data.push(...vlq(ev.tick - lastTick), ...ev.data);
    lastTick = ev.tick;
  }
  data.push(...vlq(0), 0xff, 0x2f, 0x00); // end of track
  return chunk("MTrk", data);
}

function chunk(type, data) {
  const len = data.length;
  return [
    ...[...type].map((c) => c.charCodeAt(0)),
    (len >>> 24) & 0xff,
    (len >>> 16) & 0xff,
    (len >>> 8) & 0xff,
    len & 0xff,
    ...data,
  ];
}

// Variable-length quantity (MIDI delta times).
function vlq(n) {
  const out = [n & 0x7f];
  while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, Math.round(v)));
}
