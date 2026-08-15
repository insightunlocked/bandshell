// Transport bar: rewind / play / record, position + tempo LCD, metronome,
// cycle, and save/open.

import * as engine from "../audio.js";
import * as state from "../state.js";
import { SNAP, BEATS_PER_BAR } from "../state.js";
import { songToMidi } from "../export/midi.js";
import { renderSongToWav, songEndBeat } from "../export/wav.js";

let posEl, tempoInput, playBtn, recBtn, metroBtn, cycleBtn, fileInput;
let lastPos = "";
let lastMode = "";
let lastCycle = null;

export function initTransport(root) {
  root.innerHTML = `
    <div class="brand">Bandshell</div>
    <div class="tp-group">
      <button id="btn-rewind" class="tp-btn" title="Go to beginning (Return)">&#9198;</button>
      <button id="btn-play" class="tp-btn" title="Play / Stop (Space)">&#9654;</button>
      <button id="btn-record" class="tp-btn record" title="Record (R)">&#9679;</button>
    </div>
    <div class="lcd">
      <div class="lcd-cell"><span id="lcd-pos">1. 1. 1</span><label>bar &middot; beat &middot; 16th</label></div>
      <div class="lcd-cell"><input id="tempo-input" type="number" min="40" max="240" step="1" /><label>tempo</label></div>
    </div>
    <button id="btn-cycle" class="tp-btn cycle" title="Cycle the selected region (C)">&#8635;</button>
    <button id="btn-metro" class="tp-btn metro" title="Metronome on/off">&#9833;</button>
    <div class="tp-file">
      <button id="btn-save" class="tp-txt" title="Save song to a file (&#8984;S)">Save</button>
      <button id="btn-open" class="tp-txt" title="Open a saved song">Open</button>
      <button id="btn-midi" class="tp-txt" title="Export MIDI &mdash; drop the .mid into GarageBand to keep working there">MIDI</button>
      <button id="btn-wav" class="tp-txt" title="Export audio as a WAV file">WAV</button>
      <input id="file-input" type="file" accept=".json,application/json" hidden />
    </div>
    <div class="hints">Space play &middot; R record &middot; C cycle &middot; Z/X octave &middot; &#8984;Z undo &middot; &#8984;C/&#8984;V copy region</div>
  `;

  posEl = root.querySelector("#lcd-pos");
  tempoInput = root.querySelector("#tempo-input");
  playBtn = root.querySelector("#btn-play");
  recBtn = root.querySelector("#btn-record");
  metroBtn = root.querySelector("#btn-metro");
  cycleBtn = root.querySelector("#btn-cycle");
  fileInput = root.querySelector("#file-input");

  root.querySelector("#btn-rewind").addEventListener("click", () => {
    if (engine.getMode() === "recording") engine.stop();
    engine.setPlayheadBeat(0);
  });
  playBtn.addEventListener("click", () => {
    if (engine.getMode() === "stopped") engine.play();
    else engine.stop();
  });
  recBtn.addEventListener("click", () => {
    if (engine.getMode() === "recording") engine.stop();
    else engine.record();
  });
  metroBtn.addEventListener("click", () => {
    engine.toggleMetronome();
    metroBtn.classList.toggle("active", engine.isMetronomeOn());
  });
  metroBtn.classList.toggle("active", engine.isMetronomeOn());
  cycleBtn.addEventListener("click", () => engine.toggleCycle());

  root.querySelector("#btn-save").addEventListener("click", saveSong);
  root.querySelector("#btn-open").addEventListener("click", () => fileInput.click());
  root.querySelector("#btn-midi").addEventListener("click", exportMidi);
  root.querySelector("#btn-wav").addEventListener("click", exportWav);
  fileInput.addEventListener("change", openSong);
  window.addEventListener("save-song", saveSong);

  tempoInput.addEventListener("change", () => state.setTempo(parseInt(tempoInput.value, 10)));
  tempoInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") tempoInput.blur();
    e.stopPropagation();
  });

  state.onChange(sync);
  sync();
}

function sync() {
  if (document.activeElement !== tempoInput) {
    tempoInput.value = state.getSong().tempo;
  }
}

function download(filename, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function saveSong() {
  download(
    "song.bandshell.json",
    new Blob([await state.serializeSongFile()], { type: "application/json" })
  );
}

function songHasContent() {
  const has = state
    .getSong()
    .tracks.some((t) => t.regions.some((r) => r.clipId || r.notes.length));
  if (!has) alert("Nothing to export yet — record or add some notes first.");
  return has;
}

function exportMidi() {
  if (!songHasContent()) return;
  const hasNotes = state
    .getSong()
    .tracks.some((t) => t.instrument !== "audio" && t.regions.some((r) => r.notes?.length));
  if (!hasNotes) {
    alert("MIDI files can only carry instrument notes — export audio recordings as WAV instead.");
    return;
  }
  download("bandshell-song.mid", new Blob([songToMidi(state.getSong())], { type: "audio/midi" }));
}

async function exportWav() {
  if (!songHasContent()) return;
  const btn = document.getElementById("btn-wav");
  btn.disabled = true;
  btn.textContent = "…";
  try {
    const blob = await renderSongToWav(state.getSong());
    download("bandshell-song.wav", blob);
  } catch (err) {
    console.error("WAV export failed:", err);
    alert("Audio export failed — check the console for details.");
  } finally {
    btn.disabled = false;
    btn.textContent = "WAV";
  }
}

async function openSong() {
  const file = fileInput.files?.[0];
  fileInput.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!state.loadFromData(data)) throw new Error("invalid");
  } catch {
    alert("Couldn't open that file — it doesn't look like a Bandshell song.");
  }
}

export function updateClock(beat, mode) {
  const bar = Math.floor(beat / BEATS_PER_BAR) + 1;
  const b = (Math.floor(beat) % BEATS_PER_BAR) + 1;
  const s = Math.floor((beat % 1) / SNAP) + 1;
  const str = `${bar}. ${b}. ${s}`;
  if (str !== lastPos) {
    posEl.textContent = str;
    lastPos = str;
  }
  if (mode !== lastMode) {
    playBtn.innerHTML = mode === "stopped" ? "&#9654;" : "&#9632;";
    playBtn.classList.toggle("on", mode !== "stopped");
    recBtn.classList.toggle("recording", mode === "recording");
    lastMode = mode;
  }
  const cyc = engine.isCycleOn();
  if (cyc !== lastCycle) {
    cycleBtn.classList.toggle("active", cyc);
    lastCycle = cyc;
  }
}
