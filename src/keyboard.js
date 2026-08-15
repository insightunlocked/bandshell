// Global key handling: GarageBand's Musical Typing layout plus transport keys.
// A-row = white keys, W/E/T/Y/U/O/P = black keys, Z/X shift the octave.
// On a drum track the white-key row plays the kit instead.

import * as engine from "./audio.js";
import * as state from "./state.js";
import { INSTRUMENTS } from "./state.js";

const NOTE_KEYS = {
  KeyA: 0, // C
  KeyW: 1, // C#
  KeyS: 2, // D
  KeyE: 3, // D#
  KeyD: 4, // E
  KeyF: 5, // F
  KeyT: 6, // F#
  KeyG: 7, // G
  KeyY: 8, // G#
  KeyH: 9, // A
  KeyU: 10, // A#
  KeyJ: 11, // B
  KeyK: 12, // C
  KeyO: 13, // C#
  KeyL: 14, // D
  KeyP: 15, // D#
  Semicolon: 16, // E
  Quote: 17, // F
};

// White-key row -> kit pieces when the selected track is drums.
export const DRUM_KEYS = {
  KeyA: 36, // Kick
  KeyS: 38, // Snare
  KeyD: 39, // Clap
  KeyF: 42, // Closed hat
  KeyG: 46, // Open hat
  KeyH: 45, // Tom
  KeyJ: 49, // Crash
  KeyK: 51, // Ride
};

let baseMidi = 60; // the A key = middle C, like GarageBand's default octave
const down = new Map(); // key code -> midi currently held

export function currentBase() {
  return baseMidi;
}

export function initKeyboard() {
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", releaseAll);
}

// Some environments deliver key events without a physical `code`
// (on-screen keyboards, synthetic input) — reconstruct it from `key`.
function keyCode(e) {
  if (e.code) return e.code;
  const k = e.key;
  if (k === " ") return "Space";
  if (k === ";") return "Semicolon";
  if (k === "'") return "Quote";
  if (/^[a-z]$/i.test(k)) return "Key" + k.toUpperCase();
  return k; // "Enter", "Escape", "Backspace", "Delete" match already
}

function midiForCode(code) {
  const kind = INSTRUMENTS[state.getSelectedTrack()?.instrument]?.kind ?? "melodic";
  if (kind === "drums") return DRUM_KEYS[code] ?? null;
  if (kind !== "melodic") return null; // audio tracks: keys don't play notes
  return code in NOTE_KEYS ? baseMidi + NOTE_KEYS[code] : null;
}

function onKeyDown(e) {
  if (e.target?.matches?.("input, textarea")) return;
  const code = keyCode(e);

  if (e.metaKey || e.ctrlKey) {
    switch (code) {
      case "KeyZ":
        e.preventDefault();
        if (e.shiftKey) state.redo();
        else state.undo();
        break;
      case "KeyK":
        e.preventDefault();
        dispatch("toggle-typing-strip");
        break;
      case "KeyS":
        e.preventDefault();
        dispatch("save-song");
        break;
      case "KeyC":
        e.preventDefault();
        state.copyActiveRegion();
        break;
      case "KeyV":
        e.preventDefault();
        state.pasteRegion(engine.getPlayheadBeat());
        break;
    }
    return;
  }

  switch (code) {
    case "Space":
      e.preventDefault();
      if (!e.repeat) {
        if (engine.getMode() === "stopped") engine.play();
        else engine.stop();
      }
      return;
    case "Enter":
      if (!e.repeat) {
        if (engine.getMode() === "recording") engine.stop();
        engine.setPlayheadBeat(0);
      }
      return;
    case "KeyR":
      if (!e.repeat) {
        if (engine.getMode() === "recording") engine.stop();
        else engine.record();
      }
      return;
    case "KeyC":
      if (!e.repeat) engine.toggleCycle();
      return;
    case "KeyZ":
      shiftOctave(-12);
      return;
    case "KeyX":
      shiftOctave(12);
      return;
    case "Backspace":
    case "Delete":
      e.preventDefault();
      state.deleteSelected();
      return;
    case "Escape":
      state.clearSelection();
      return;
  }

  if (!e.repeat && !down.has(code)) {
    const midi = midiForCode(code);
    if (midi != null) {
      down.set(code, midi);
      engine.noteOn(midi);
      dispatch("typing-note", { code, midi, on: true });
    }
  }
}

function onKeyUp(e) {
  const code = keyCode(e);
  if (down.has(code)) {
    const midi = down.get(code);
    down.delete(code);
    engine.noteOff(midi);
    dispatch("typing-note", { code, midi, on: false });
  }
}

function shiftOctave(delta) {
  const next = Math.min(84, Math.max(24, baseMidi + delta));
  if (next === baseMidi) return;
  // Release anything held so no note gets stuck across the shift.
  releaseAll();
  baseMidi = next;
  dispatch("typing-octave", { base: baseMidi });
}

function releaseAll() {
  for (const [code, midi] of [...down]) {
    down.delete(code);
    engine.noteOff(midi);
    dispatch("typing-note", { code, midi, on: false });
  }
}

function dispatch(name, detail = {}) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}
