// Piano-roll editor for the active region. Melodic tracks get the full
// piano range; drum tracks get one labeled row per kit piece.
// GarageBand conventions: Cmd+click (or double-click) adds a note, drag
// moves it, dragging the right edge resizes, Delete removes the selection.

import * as state from "../state.js";
import * as engine from "../audio.js";
import * as clips from "../clips.js";
import { SNAP, INSTRUMENTS, DRUM_KIT, BEATS_PER_BAR } from "../state.js";

const PXB = 40; // px per beat
const MEL_ROW = 16; // px per pitch row (melodic)
const DRUM_ROW = 26; // px per kit row
const MEL_KEYS_W = 64;
const DRUM_KEYS_W = 84;
const PITCH_MAX = 108; // C8
const PITCH_MIN = 21; // A0
const BLACK = new Set([1, 3, 6, 8, 10]);

let scrollEl, innerEl, keysEl, bodyEl, rowsEl, gridEl, notesEl, playheadEl, emptyEl;
let audioEl, audioLabelEl, audioCanvas, audioHintEl;
let tuneSliderEl, tuneValueEl;
let tuneDragBefore = null;
let tuneTrackId = null;
let rows = []; // [{pitch, label, cls}] top -> bottom
let rowIndex = new Map(); // pitch -> row index
let rowH = MEL_ROW;
let keysW = MEL_KEYS_W;
let lastMode = null; // "melodic" | "drums" | "empty"
let lastLength = -1;
let lastDuration = 1; // default length for new melodic notes, in beats
let drag = null;
let marquee = null;
let marqueeEl;

export function initPianoRoll(root) {
  root.innerHTML = `
    <div class="pr-scroll">
      <div class="pr-inner">
        <div class="pr-keys"></div>
        <div class="pr-body">
          <div class="pr-rows"></div>
          <div class="pr-grid"></div>
          <div class="pr-notes"></div>
          <div class="pr-marquee" style="display:none"></div>
          <div class="pr-playhead" style="display:none"></div>
        </div>
      </div>
    </div>
    <!-- Overlays sit outside .pr-scroll so they track the visible pane
         rather than scrolling away with the piano-roll content. -->
    <div class="pr-empty" style="display:none">
      Click a region to edit it &mdash; or press <b>R</b> to record a new take
    </div>
    <div class="pr-audio" style="display:none">
      <div class="pr-tune">
        <div class="pr-tune-title">Pitch<br>Correction</div>
        <input class="pr-tune-slider" type="range" min="0" max="100" step="1" value="0"
               orient="vertical" title="Autotune amount" />
        <div class="pr-tune-value">Off</div>
      </div>
      <div class="pr-audio-main">
        <div class="pr-audio-label"></div>
        <canvas class="pr-audio-wave"></canvas>
        <div class="pr-audio-hint"></div>
      </div>
    </div>
  `;
  scrollEl = root.querySelector(".pr-scroll");
  innerEl = root.querySelector(".pr-inner");
  keysEl = root.querySelector(".pr-keys");
  bodyEl = root.querySelector(".pr-body");
  rowsEl = root.querySelector(".pr-rows");
  gridEl = root.querySelector(".pr-grid");
  notesEl = root.querySelector(".pr-notes");
  playheadEl = root.querySelector(".pr-playhead");
  marqueeEl = root.querySelector(".pr-marquee");
  emptyEl = root.querySelector(".pr-empty");
  audioEl = root.querySelector(".pr-audio");
  audioLabelEl = root.querySelector(".pr-audio-label");
  audioCanvas = root.querySelector(".pr-audio-wave");
  audioHintEl = root.querySelector(".pr-audio-hint");
  tuneSliderEl = root.querySelector(".pr-tune-slider");
  tuneValueEl = root.querySelector(".pr-tune-value");

  wireTuneSlider();
  wireEvents();
  state.onChange(render);
  clips.onClipsReady(render);
  render();
}

function currentMode() {
  const found = state.getActiveRegion();
  if (found?.region.clipId) return { mode: "audio", found, track: found.track };
  // An audio track shows its controls even before anything is recorded.
  const track = found?.track ?? state.getSelectedTrack();
  const kind = INSTRUMENTS[track?.instrument]?.kind ?? "melodic";
  if (kind === "audio") return { mode: "audio", found: null, track };
  if (!found) return { mode: "empty", found: null, track };
  return { mode: kind === "drums" ? "drums" : "melodic", found, track };
}

function buildRows(mode) {
  rows = [];
  if (mode === "drums") {
    rowH = DRUM_ROW;
    keysW = DRUM_KEYS_W;
    for (const piece of [...DRUM_KIT].sort((a, b) => b.midi - a.midi)) {
      rows.push({ pitch: piece.midi, label: piece.name, cls: "drum" });
    }
  } else {
    rowH = MEL_ROW;
    keysW = MEL_KEYS_W;
    for (let p = PITCH_MAX; p >= PITCH_MIN; p--) {
      rows.push({
        pitch: p,
        label: p % 12 === 0 ? "C" + (p / 12 - 1) : "",
        cls: BLACK.has(p % 12) ? "black" : "white",
      });
    }
  }
  rowIndex = new Map(rows.map((r, i) => [r.pitch, i]));

  keysEl.innerHTML = "";
  rowsEl.innerHTML = "";
  keysEl.style.width = keysW + "px";
  bodyEl.style.left = keysW + "px";
  innerEl.style.height = rows.length * rowH + "px";
  for (const row of rows) {
    const key = el("div", `pr-key ${row.cls}`);
    key.style.height = rowH + "px";
    key.textContent = row.label;
    key.addEventListener("pointerdown", () => engine.previewNote(row.pitch, 0.4));
    keysEl.appendChild(key);
    const stripe = el("div", `pr-row ${row.cls}`);
    stripe.style.height = rowH + "px";
    rowsEl.appendChild(stripe);
  }
  if (mode === "drums") {
    scrollEl.scrollTop = 0;
  } else {
    scrollEl.scrollTop = (PITCH_MAX - 81) * rowH; // octaves around middle C
  }
}

function render() {
  const { mode, found, track } = currentMode();
  if (mode !== lastMode) {
    if (mode === "melodic" || mode === "drums") buildRows(mode);
    emptyEl.style.display = mode === "empty" ? "" : "none";
    audioEl.style.display = mode === "audio" ? "" : "none";
    innerEl.style.visibility = mode === "empty" || mode === "audio" ? "hidden" : "";
    lastMode = mode;
    lastLength = -1;
  }
  if (mode === "empty") {
    notesEl.innerHTML = "";
    return;
  }
  if (mode === "audio") {
    notesEl.innerHTML = "";
    renderAudioView(found, track);
    return;
  }
  const region = found.region;
  if (region.lengthBeats !== lastLength) {
    lastLength = region.lengthBeats;
    const w = region.lengthBeats * PXB;
    bodyEl.style.width = w + "px";
    innerEl.style.width = keysW + w + "px";
    buildGridlines(region.lengthBeats);
  }
  renderNotes(region);
}

function renderAudioView(found, track) {
  tuneTrackId = track?.id ?? null;
  syncTuneSlider(track);

  const w = Math.max(200, audioEl.clientWidth - 88 - 40);
  const h = Math.max(70, audioEl.clientHeight - 80);
  audioCanvas.width = w;
  audioCanvas.height = h;
  const ctx = audioCanvas.getContext("2d");
  ctx.clearRect(0, 0, w, h);

  if (!found) {
    audioLabelEl.textContent = `${track?.name ?? "Audio"} — no takes yet`;
    audioHintEl.textContent = "Press R to record from your microphone.";
    return;
  }
  const region = found.region;
  const bars = Math.ceil(region.lengthBeats / BEATS_PER_BAR);
  audioLabelEl.textContent = `${track.name} — audio take, ${bars} bar${bars === 1 ? "" : "s"}`;
  audioHintEl.textContent = "";

  const spbSec = 60 / state.getSong().tempo;
  const p = clips.peaks(region.clipId, region.clipOffset ?? 0, region.lengthBeats * spbSec, w);
  if (!p) return; // still decoding; clips.onClipsReady re-renders
  ctx.fillStyle = track.autotune > 0 ? "#8fd0c4" : "#7f9fd6";
  const mid = h / 2;
  for (let x = 0; x < p.length; x++) {
    const barH = Math.max(1, p[x] * h * 0.92);
    ctx.fillRect(x, mid - barH / 2, 1, barH);
  }
}

// --- pitch-correction slider ---

function tuneLabel(v) {
  if (v === 0) return "Off";
  if (v >= 95) return `${v} · Hard`;
  if (v >= 60) return `${v} · Tight`;
  return `${v} · Subtle`;
}

function syncTuneSlider(track) {
  const v = track?.autotune ?? 0;
  if (document.activeElement !== tuneSliderEl) tuneSliderEl.value = String(v);
  if (!tuneSliderEl.dataset.busy) tuneValueEl.textContent = tuneLabel(v);
  tuneSliderEl.classList.toggle("on", v > 0);
}

function wireTuneSlider() {
  tuneSliderEl.addEventListener("pointerdown", () => {
    tuneDragBefore = state.snapshot();
  });
  tuneSliderEl.addEventListener("input", () => {
    if (!tuneTrackId) return;
    tuneDragBefore ??= state.snapshot(); // keyboard adjustment, no pointerdown
    state.setTrackAutotuneLive(tuneTrackId, Number(tuneSliderEl.value));
  });
  tuneSliderEl.addEventListener("change", async () => {
    if (!tuneTrackId) return;
    if (tuneDragBefore !== null) {
      state.commitUndo(tuneDragBefore);
      tuneDragBefore = null;
    }
    await retuneTrack(tuneTrackId);
  });
  // Keep the slider from stealing transport keys (Space, R, C...).
  tuneSliderEl.addEventListener("keydown", (e) => e.stopPropagation());
}

// Render pitch-corrected audio for every take on the track.
async function retuneTrack(trackId) {
  const track = state.getSong().tracks.find((t) => t.id === trackId);
  if (!track) return;
  const amount = track.autotune;
  const ids = track.regions.map((r) => r.clipId).filter(Boolean);
  if (!amount || !ids.length) return;
  tuneSliderEl.dataset.busy = "1";
  tuneValueEl.textContent = "Tuning…";
  try {
    for (const cid of ids) await clips.ensureTuned(cid, amount);
  } catch (err) {
    console.error("Pitch correction failed:", err);
  } finally {
    delete tuneSliderEl.dataset.busy;
    tuneValueEl.textContent = tuneLabel(state.getSong().tracks.find((t) => t.id === trackId)?.autotune ?? 0);
  }
}

function buildGridlines(lengthBeats) {
  gridEl.innerHTML = "";
  const count = Math.round(lengthBeats / SNAP);
  for (let i = 1; i < count; i++) {
    const cls = i % 16 === 0 ? "bar" : i % 4 === 0 ? "beat" : "sub";
    const line = el("div", `pr-line ${cls}`);
    line.style.left = i * SNAP * PXB + "px";
    gridEl.appendChild(line);
  }
}

function renderNotes(region) {
  notesEl.innerHTML = "";
  const sel = state.getSelection();
  const isDrums = lastMode === "drums";
  for (const note of region.notes) {
    const idx = rowIndex.get(note.pitch);
    if (idx === undefined) continue; // pitch outside this view (e.g. non-kit note)
    const d = el("div", "pr-note" + (isDrums ? " drum" : "") + (sel.has(note.id) ? " sel" : ""));
    d.dataset.id = note.id;
    d.style.left = note.startBeat * PXB + "px";
    d.style.top = idx * rowH + 1 + "px";
    d.style.width = Math.max(4, note.durationBeats * PXB - 1) + "px";
    d.style.height = rowH - 3 + "px";
    notesEl.appendChild(d);
  }
}

// --- interaction ---

function wireEvents() {
  bodyEl.addEventListener("pointerdown", onMouseDown);
  bodyEl.addEventListener("dblclick", onDblClick);
}

function posFromEvent(e) {
  const rect = bodyEl.getBoundingClientRect();
  const idx = Math.floor((e.clientY - rect.top) / rowH);
  return {
    beat: (e.clientX - rect.left) / PXB,
    row: Math.min(rows.length - 1, Math.max(0, idx)),
  };
}

function onMouseDown(e) {
  if (e.button !== 0 || lastMode === "empty" || lastMode === "audio") return;
  const noteEl = e.target.closest(".pr-note");
  if (noteEl) {
    const nid = noteEl.dataset.id;
    // Measure BEFORE selecting: selecting re-renders the notes, which detaches
    // this element and makes its rect all zeros — which read as "grabbed the
    // right edge" and turned every first drag into a resize.
    const rect = noteEl.getBoundingClientRect();
    const resize = lastMode !== "drums" && e.clientX > rect.right - 7;
    if (!state.getSelection().has(nid)) state.selectNote(nid, e.shiftKey);
    startDrag(e, resize ? "resize" : "move");
    e.preventDefault();
  } else if (e.metaKey) {
    const p = posFromEvent(e);
    if (createNote(p.beat, rows[p.row].pitch)) {
      if (lastMode !== "drums") startDrag(e, "resize"); // pencil-drag sets length
    }
    e.preventDefault();
  } else if (e.pointerType === "touch") {
    // On touch, an empty-grid drag pans the editor — box select is a
    // pointer-device gesture, and stealing the drag would strand phone users
    // with no way to scroll.
    state.clearSelection();
  } else {
    startMarquee(e); // drag on empty grid = box select
    e.preventDefault();
  }
}

// --- box (marquee) select ---
// Drag across empty grid to select every note the box touches. Shift adds to
// the current selection; a click without dragging just clears it.

function startMarquee(e) {
  const rect = bodyEl.getBoundingClientRect();
  marquee = {
    x0: e.clientX - rect.left,
    y0: e.clientY - rect.top,
    x1: e.clientX - rect.left,
    y1: e.clientY - rect.top,
    additive: e.shiftKey,
    base: e.shiftKey ? new Set(state.getSelection()) : new Set(),
    moved: false,
  };
  window.addEventListener("pointermove", onMarqueeMove);
  window.addEventListener("pointerup", onMarqueeUp);
}

function onMarqueeMove(e) {
  const rect = bodyEl.getBoundingClientRect();
  marquee.x1 = e.clientX - rect.left;
  marquee.y1 = e.clientY - rect.top;
  if (Math.abs(marquee.x1 - marquee.x0) + Math.abs(marquee.y1 - marquee.y0) > 3) {
    marquee.moved = true;
  }
  if (!marquee.moved) return;

  const box = marqueeBox();
  marqueeEl.style.display = "";
  marqueeEl.style.left = box.left + "px";
  marqueeEl.style.top = box.top + "px";
  marqueeEl.style.width = box.width + "px";
  marqueeEl.style.height = box.height + "px";
  applyMarqueeSelection(box);
}

function onMarqueeUp() {
  window.removeEventListener("pointermove", onMarqueeMove);
  window.removeEventListener("pointerup", onMarqueeUp);
  marqueeEl.style.display = "none";
  if (!marquee.moved) state.clearSelection(); // plain click on empty space
  marquee = null;
}

function marqueeBox() {
  return {
    left: Math.min(marquee.x0, marquee.x1),
    top: Math.min(marquee.y0, marquee.y1),
    width: Math.abs(marquee.x1 - marquee.x0),
    height: Math.abs(marquee.y1 - marquee.y0),
  };
}

function applyMarqueeSelection(box) {
  const found = state.getActiveRegion();
  if (!found) return;
  const hits = new Set(marquee.base);
  for (const note of found.region.notes) {
    const idx = rowIndex.get(note.pitch);
    if (idx === undefined) continue;
    const nx = note.startBeat * PXB;
    const nw = Math.max(4, note.durationBeats * PXB);
    const ny = idx * rowH;
    // Standard rectangle overlap — a note counts if the box touches it at all.
    if (nx < box.left + box.width && nx + nw > box.left && ny < box.top + box.height && ny + rowH > box.top) {
      hits.add(note.id);
    }
  }
  state.setSelection(hits);
}

function onDblClick(e) {
  if (lastMode === "empty" || lastMode === "audio") return;
  if (!e.target.closest(".pr-note")) {
    const p = posFromEvent(e);
    createNote(p.beat, rows[p.row].pitch);
  }
}

function createNote(beat, pitch) {
  const start = Math.floor(beat / SNAP) * SNAP;
  if (start < 0) return null;
  const duration = lastMode === "drums" ? SNAP : lastDuration;
  const note = state.addNote(pitch, start, duration);
  if (!note) return null;
  state.selectNote(note.id);
  engine.previewNote(pitch, Math.min(0.5, duration));
  return note;
}

function findNote(nid) {
  const found = state.getActiveRegion();
  return found?.region.notes.find((n) => n.id === nid) ?? null;
}

function startDrag(e, dragMode) {
  const items = [...state.getSelection()]
    .map((nid) => {
      const n = findNote(nid);
      return n && { n, beat: n.startBeat, row: rowIndex.get(n.pitch) ?? 0, dur: n.durationBeats };
    })
    .filter(Boolean);
  if (!items.length) return;
  drag = {
    mode: dragMode,
    x0: e.clientX,
    y0: e.clientY,
    items,
    before: state.snapshot(),
    lastDRow: 0,
  };
  window.addEventListener("pointermove", onDragMove);
  window.addEventListener("pointerup", onDragUp);
}

function onDragMove(e) {
  let dBeat = Math.round((e.clientX - drag.x0) / PXB / SNAP) * SNAP;

  if (drag.mode === "move") {
    let dRow = Math.round((e.clientY - drag.y0) / rowH);
    const minBeat = Math.min(...drag.items.map((i) => i.beat));
    const minRow = Math.min(...drag.items.map((i) => i.row));
    const maxRow = Math.max(...drag.items.map((i) => i.row));
    dBeat = Math.max(dBeat, -minBeat);
    dRow = Math.min(Math.max(dRow, -minRow), rows.length - 1 - maxRow);
    for (const it of drag.items) {
      it.n.startBeat = it.beat + dBeat;
      it.n.pitch = rows[it.row + dRow].pitch;
    }
    if (dRow !== drag.lastDRow) {
      engine.previewNote(drag.items[0].n.pitch, 0.3);
      drag.lastDRow = dRow;
    }
  } else {
    for (const it of drag.items) {
      it.n.durationBeats = Math.max(SNAP, it.dur + dBeat);
    }
    lastDuration = drag.items[0].n.durationBeats;
  }

  const maxEnd = Math.max(...drag.items.map((i) => i.n.startBeat + i.n.durationBeats));
  state.ensureRegionLength(maxEnd);
  state.notifyLiveChange();
}

function onDragUp() {
  window.removeEventListener("pointermove", onDragMove);
  window.removeEventListener("pointerup", onDragUp);
  state.commitUndo(drag.before);
  drag = null;
}

export function setRollPlayhead(beat) {
  const found = state.getActiveRegion();
  if (!found || found.region.clipId) {
    playheadEl.style.display = "none";
    return;
  }
  const region = found.region;
  const rel = beat - region.startBeat;
  if (rel < 0 || rel > region.lengthBeats) {
    playheadEl.style.display = "none";
    return;
  }
  playheadEl.style.display = "";
  playheadEl.style.transform = `translateX(${rel * PXB}px)`;
  if (engine.getMode() !== "stopped") {
    const x = rel * PXB;
    const view = scrollEl.clientWidth - keysW;
    const sl = scrollEl.scrollLeft;
    if (x < sl || x > sl + view - 60) scrollEl.scrollLeft = Math.max(0, x - 60);
  }
}

function el(tag, cls) {
  const d = document.createElement(tag);
  d.className = cls;
  return d;
}
