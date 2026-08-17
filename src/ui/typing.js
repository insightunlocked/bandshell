// Musical Typing strip: an on-screen mirror of the GarageBand key layout
// that lights up as you play. On a drum track the white keys relabel to
// the kit. Toggle with Cmd+K.

import * as state from "../state.js";
import { DRUM_KIT, INSTRUMENTS } from "../state.js";
import * as engine from "../audio.js";
import { currentBase, DRUM_KEYS, midiForCode } from "../keyboard.js";

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
const CAP_W = 38; // desktop key width; phones scale down (see layoutKeys)
const GAP = 4;
const MIN_CAP_W = 26;
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
    <div class="mt-keys"></div>
    <div class="mt-side">Z / X shift octave<br>&#8984;K show / hide</div>
  `;
  octaveEl = root.querySelector("#mt-octave");
  const keysEl = root.querySelector(".mt-keys");

  BLACK_KEYS.forEach(([code, letter, name, pos]) => {
    keysEl.appendChild(makeCap(code, letter, name, "black-cap", pos + 0.5));
  });
  WHITE_KEYS.forEach(([code, letter, name], i) => {
    keysEl.appendChild(makeCap(code, letter, name, "white-cap", i));
  });

  wireTouchKeys(keysEl);
  layoutKeys();
  window.addEventListener("resize", layoutKeys);

  window.addEventListener("typing-note", (e) => {
    caps[e.detail.code]?.classList.toggle("down", e.detail.on);
  });
  window.addEventListener("typing-octave", () => relabel(true));
  window.addEventListener("toggle-typing-strip", () => stripEl.classList.toggle("hidden"));
  state.onChange(() => relabel(false));

  relabel(true);
}

function makeCap(code, letter, name, cls, slot) {
  const cap = document.createElement("div");
  cap.className = `mt-cap ${cls}`;
  cap.dataset.slot = slot; // position in white-key units; pixels set by layoutKeys
  cap.innerHTML = `<b>${letter}</b><i>${name}</i>`;
  cap.dataset.code = code;
  caps[code] = cap;
  return cap;
}

// Size the keys to the space available so a whole octave-and-a-half stays
// reachable on a phone instead of running off the edge.
function layoutKeys() {
  const keysEl = stripEl.querySelector(".mt-keys");
  const css = getComputedStyle(stripEl);
  const gap = parseFloat(css.gap) || 0;
  // Whatever the info and hint columns don't use is the keyboard's to fill.
  let avail = stripEl.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
  for (const sib of [".mt-info", ".mt-side"]) {
    const el = stripEl.querySelector(sib);
    if (el && el.offsetParent !== null) avail -= el.offsetWidth + gap;
  }
  const capW = Math.max(MIN_CAP_W, Math.min(CAP_W, avail / WHITE_KEYS.length - GAP));
  const step = capW + GAP;
  keysEl.style.width = WHITE_KEYS.length * step + "px";
  for (const cap of Object.values(caps)) {
    cap.style.left = Number(cap.dataset.slot) * step + "px";
    cap.style.width = capW + "px";
  }
}

// The strip is also a playable instrument — essential on phones, where there
// is no physical keyboard to type on. Pointer events give every finger its own
// pointerId, so chords work.
const touching = new Map(); // pointerId -> { code, midi }

function pressCap(pointerId, cap) {
  if (!cap || touching.has(pointerId)) return;
  const code = cap.dataset.code;
  const midi = midiForCode(code);
  if (midi == null) return; // key unused by this instrument
  touching.set(pointerId, { code, midi });
  engine.noteOn(midi);
  cap.classList.add("down");
}

function releaseCap(pointerId) {
  const held = touching.get(pointerId);
  if (!held) return;
  touching.delete(pointerId);
  engine.noteOff(held.midi);
  caps[held.code]?.classList.remove("down");
}

function wireTouchKeys(keysEl) {
  keysEl.addEventListener("pointerdown", (e) => {
    const cap = e.target.closest(".mt-cap");
    if (!cap) return;
    e.preventDefault(); // no text selection / synthetic mouse events
    pressCap(e.pointerId, cap);
  });
  // Sliding a finger across the keys plays them, like a real keyboard.
  keysEl.addEventListener("pointermove", (e) => {
    if (!touching.has(e.pointerId)) return;
    const cap = document.elementFromPoint(e.clientX, e.clientY)?.closest(".mt-cap");
    const held = touching.get(e.pointerId);
    if (cap && cap.dataset.code !== held.code) {
      releaseCap(e.pointerId);
      pressCap(e.pointerId, cap);
    }
  });
  for (const evt of ["pointerup", "pointercancel", "pointerleave"]) {
    keysEl.addEventListener(evt, (e) => releaseCap(e.pointerId));
  }
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
