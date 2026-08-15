// Musical Typing strip: an on-screen mirror of the GarageBand key layout
// that lights up as you play. On a drum track the white keys relabel to
// the kit. Toggle with Cmd+K.

import * as state from "../state.js";
import { DRUM_KIT, INSTRUMENTS } from "../state.js";
import { currentBase, DRUM_KEYS } from "../keyboard.js";

const WHITE_KEYS = [
  ["KeyA", "A", "C"],
  ["KeyS", "S", "D"],
  ["KeyD", "D", "E"],
  ["KeyF", "F", "F"],
  ["KeyG", "G", "G"],
  ["KeyH", "H", "A"],
  ["KeyJ", "J", "B"],
  ["KeyK", "K", "C"],
  ["KeyL", "L", "D"],
  ["Semicolon", ";", "E"],
  ["Quote", "'", "F"],
];
const BLACK_KEYS = [
  ["KeyW", "W", "C#", 0.5],
  ["KeyE", "E", "D#", 1.5],
  ["KeyT", "T", "F#", 3.5],
  ["KeyY", "Y", "G#", 4.5],
  ["KeyU", "U", "A#", 5.5],
  ["KeyO", "O", "C#", 7.5],
  ["KeyP", "P", "D#", 8.5],
];
const CAP_W = 38;
const GAP = 4;
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

let stripEl, octaveEl;
let lastKind = null;
const caps = {}; // key code -> element
const kitNames = new Map(DRUM_KIT.map((p) => [p.midi, p.name]));

export function initTypingStrip(root) {
  stripEl = root;
  root.innerHTML = `
    <div class="mt-info">
      <b>Musical Typing</b>
      <span id="mt-octave"></span>
    </div>
    <div class="mt-keys" style="width:${WHITE_KEYS.length * (CAP_W + GAP)}px"></div>
    <div class="mt-side">Z / X shift octave<br>&#8984;K show / hide</div>
  `;
  octaveEl = root.querySelector("#mt-octave");
  const keysEl = root.querySelector(".mt-keys");

  BLACK_KEYS.forEach(([code, letter, name, pos]) => {
    keysEl.appendChild(
      makeCap(code, letter, name, "black-cap", pos * (CAP_W + GAP) + (CAP_W + GAP) / 2)
    );
  });
  WHITE_KEYS.forEach(([code, letter, name], i) => {
    keysEl.appendChild(makeCap(code, letter, name, "white-cap", i * (CAP_W + GAP)));
  });

  window.addEventListener("typing-note", (e) => {
    caps[e.detail.code]?.classList.toggle("down", e.detail.on);
  });
  window.addEventListener("typing-octave", () => relabel(true));
  window.addEventListener("toggle-typing-strip", () => stripEl.classList.toggle("hidden"));
  state.onChange(() => relabel(false));

  relabel(true);
}

function makeCap(code, letter, name, cls, left) {
  const cap = document.createElement("div");
  cap.className = `mt-cap ${cls}`;
  cap.style.left = left + "px";
  cap.innerHTML = `<b>${letter}</b><i>${name}</i>`;
  caps[code] = cap;
  return cap;
}

function relabel(force) {
  const kind = INSTRUMENTS[state.getSelectedTrack()?.instrument]?.kind ?? "melodic";
  if (!force && kind === lastKind) return;
  lastKind = kind;

  for (const [code, , note] of WHITE_KEYS) {
    const cap = caps[code];
    if (kind === "drums") {
      const midi = DRUM_KEYS[code];
      cap.querySelector("i").textContent = midi ? kitNames.get(midi) : "";
      cap.classList.toggle("unused", !midi);
    } else {
      cap.querySelector("i").textContent = note;
      cap.classList.toggle("unused", kind === "audio");
    }
  }
  for (const [code] of BLACK_KEYS) {
    caps[code].classList.toggle("unused", kind !== "melodic");
  }
  octaveEl.textContent =
    kind === "drums"
      ? "Drum Kit"
      : kind === "audio"
        ? "Audio track — R records the mic"
        : `${midiName(currentBase())} – ${midiName(currentBase() + 17)}`;
}

function midiName(midi) {
  return NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
}
