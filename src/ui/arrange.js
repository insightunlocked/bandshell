// Arrangement view: track headers (with mute/solo and add/remove), bar
// ruler with the cycle strip, region blocks you can drag / option-drag to
// duplicate / move across tracks, and the playhead.

import * as state from "../state.js";
import * as engine from "../audio.js";
import * as clips from "../clips.js";
import { BEATS_PER_BAR, INSTRUMENTS } from "../state.js";

const PX = 16; // px per beat
const LANE_H = 64;
const RULER_H = 26;

let timelineEl, innerEl, rulerEl, barsEl, cycleEl, lanesEl, playheadEl, recEl, recWaveEl;
let headersEl, thScrollEl, addMenuEl;
let lastTotal = -1;
let lastCycleKey = "";
let drag = null;

export function initArrange(headers, timeline) {
  headersEl = headers;
  timelineEl = timeline;

  headers.innerHTML = `
    <div class="ruler-spacer">
      <button class="add-track" title="Add a track">+</button>
    </div>
    <div class="th-viewport"><div class="th-scroll"></div></div>
  `;
  thScrollEl = headers.querySelector(".th-scroll");
  const addBtn = headers.querySelector(".add-track");

  addBtn.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    openInstrumentMenu(addBtn, null, (key) => state.addTrack(key));
  });

  // Track header actions happen on mousedown (a selection re-render between
  // mousedown and click would otherwise swallow the click).
  thScrollEl.addEventListener("pointerdown", (e) => {
    const header = e.target.closest(".track-header");
    if (!header) return;
    const id = header.dataset.id;
    const btn = e.target.closest(".th-btn");
    if (btn) {
      if (btn.dataset.act === "mute") state.toggleMute(id);
      else if (btn.dataset.act === "solo") state.toggleSolo(id);
      else if (btn.dataset.act === "del") state.removeTrack(id);
      return;
    }
    // Clicking the icon or the instrument name opens the sound picker.
    const picker = e.target.closest(".track-instrument");
    if (picker) {
      e.stopPropagation();
      state.selectTrack(id);
      const track = state.getSong().tracks.find((t) => t.id === id);
      openInstrumentMenu(picker, track, (key) => state.setTrackInstrument(id, key));
      return;
    }
    state.selectTrack(id);
  });

  timeline.innerHTML = `
    <div class="tl-inner">
      <div class="tl-ruler">
        <div class="tl-bars"></div>
        <div class="cycle-strip" style="display:none"></div>
      </div>
      <div class="tl-lanes"></div>
      <div class="rec-region"><canvas class="rec-wave"></canvas></div>
      <div class="tl-playhead"></div>
    </div>
  `;
  innerEl = timeline.querySelector(".tl-inner");
  rulerEl = timeline.querySelector(".tl-ruler");
  barsEl = timeline.querySelector(".tl-bars");
  cycleEl = timeline.querySelector(".cycle-strip");
  lanesEl = timeline.querySelector(".tl-lanes");
  playheadEl = timeline.querySelector(".tl-playhead");
  recEl = timeline.querySelector(".rec-region");
  recWaveEl = timeline.querySelector(".rec-wave");

  rulerEl.addEventListener("pointerdown", (e) => {
    const rect = barsEl.getBoundingClientRect();
    const beat = Math.max(0, Math.round((e.clientX - rect.left) / PX));
    engine.setPlayheadBeat(beat);
  });

  // Keep the header column in step with vertical timeline scrolling.
  timeline.addEventListener("scroll", () => {
    thScrollEl.style.transform = `translateY(${-timeline.scrollTop}px)`;
  });

  lanesEl.addEventListener("pointerdown", onLaneMouseDown);

  state.onChange(render);
  clips.onClipsReady(render);
  render();
}

// --- instrument picker ---
// One floating menu reused for "add track" and "change this track's sound".
// When `track` is given it filters to instruments that track can become:
// audio tracks hold waveforms, so they never mix with the MIDI instruments.

function openInstrumentMenu(anchorEl, track, onPick) {
  closeInstrumentMenu();
  const current = track?.instrument ?? null;
  const audioOnly = track ? INSTRUMENTS[track.instrument].kind === "audio" : null;

  const menu = document.createElement("div");
  menu.className = "ins-menu";
  for (const family of state.INSTRUMENT_FAMILIES) {
    const items = state
      .instrumentsInFamily(family)
      .filter(([, ins]) => audioOnly === null || (ins.kind === "audio") === audioOnly);
    if (!items.length) continue;
    const group = document.createElement("div");
    group.className = "ins-group";
    group.textContent = family;
    menu.appendChild(group);
    for (const [key, ins] of items) {
      const item = document.createElement("div");
      item.className = "ins-item" + (key === current ? " current" : "");
      item.dataset.ins = key;
      item.innerHTML = `<span class="ins-icon">${ins.icon}</span><span>${ins.label}</span>`;
      menu.appendChild(item);
    }
  }

  menu.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    const item = e.target.closest(".ins-item");
    if (!item) return;
    onPick(item.dataset.ins);
    closeInstrumentMenu();
  });

  document.body.appendChild(menu);
  const r = anchorEl.getBoundingClientRect();
  // Flip upward when there isn't room below.
  const h = menu.offsetHeight;
  const top = r.bottom + h + 8 < window.innerHeight ? r.bottom + 4 : Math.max(4, r.top - h - 4);
  menu.style.top = top + "px";
  menu.style.left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 8) + "px";
  addMenuEl = menu;
  setTimeout(() => window.addEventListener("pointerdown", closeInstrumentMenu, { once: true }), 0);
}

function closeInstrumentMenu() {
  addMenuEl?.remove();
  addMenuEl = null;
}

// Map a screen point to a timeline position. Used by file drag-and-drop.
export function pointToTimeline(clientX, clientY) {
  const rect = timelineEl.getBoundingClientRect();
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
    return null;
  }
  const beat = (clientX - rect.left + timelineEl.scrollLeft) / PX;
  const y = clientY - rect.top + timelineEl.scrollTop - RULER_H;
  const idx = Math.floor(y / LANE_H);
  const tracks = state.getSong().tracks;
  return { beat: Math.max(0, beat), trackId: tracks[idx]?.id ?? null };
}

// --- rendering ---

function render() {
  const song = state.getSong();
  let needed = 64;
  for (const track of song.tracks) {
    for (const region of track.regions) {
      needed = Math.max(needed, region.startBeat + region.lengthBeats + 16);
    }
  }
  growTimeline(needed);
  renderHeaders(song);
  renderLanes(song);
  innerEl.style.height = RULER_H + song.tracks.length * LANE_H + 40 + "px";
}

function renderHeaders(song) {
  const sel = state.getSelectedTrack();
  const canDelete = song.tracks.length > 1;
  thScrollEl.innerHTML = song.tracks
    .map((t) => {
      const ins = INSTRUMENTS[t.instrument];
      return `
      <div class="track-header ${t === sel ? "sel" : ""}" data-id="${t.id}">
        <span class="track-icon track-instrument" title="Change sound">${ins.icon}</span>
        <div class="track-meta">
          <div class="track-name">${escapeHtml(t.name)}</div>
          <div class="track-kind track-instrument" title="Change sound"><span class="ins-name">${ins.label}</span><i class="caret">&#9662;</i></div>
        </div>
        <div class="th-btns">
          <button class="th-btn th-mute ${t.muted ? "on" : ""}" data-act="mute" title="Mute">M</button>
          <button class="th-btn th-solo ${t.solo ? "on" : ""}" data-act="solo" title="Solo">S</button>
          ${canDelete ? '<button class="th-btn th-del" data-act="del" title="Delete track">&times;</button>' : ""}
        </div>
      </div>`;
    })
    .join("");
}

function renderLanes(song) {
  const selRegion = state.getSelectedRegionId();
  lanesEl.innerHTML = "";
  for (const track of song.tracks) {
    const lane = document.createElement("div");
    lane.className = "tl-lane";
    lane.dataset.id = track.id;
    for (const region of track.regions) {
      lane.appendChild(buildRegionEl(track, region, region.id === selRegion));
    }
    lanesEl.appendChild(lane);
  }
}

function buildRegionEl(track, region, selected) {
  const d = document.createElement("div");
  d.className = "tl-region" + (region.clipId ? " audio" : "") + (selected ? " sel" : "");
  d.dataset.id = region.id;
  d.style.left = region.startBeat * PX + "px";
  d.style.width = region.lengthBeats * PX - 2 + "px";
  const name = document.createElement("span");
  name.className = "tl-region-name";
  name.textContent = track.name;
  d.appendChild(name);

  if (region.clipId) {
    const canvas = document.createElement("canvas");
    canvas.className = "tl-wave";
    canvas.width = Math.max(10, Math.round(region.lengthBeats * PX) - 6);
    canvas.height = LANE_H - 26;
    drawRegionWave(canvas, region);
    d.appendChild(canvas);
    return d;
  }

  const notes = document.createElement("div");
  notes.className = "tl-region-notes";
  for (const note of region.notes) {
    const m = document.createElement("div");
    m.className = "mini";
    const p = Math.min(96, Math.max(33, note.pitch));
    m.style.left = note.startBeat * PX + "px";
    m.style.width = Math.max(2, note.durationBeats * PX - 1) + "px";
    m.style.top = 14 + ((96 - p) / 63) * (LANE_H - 26) + "px";
    notes.appendChild(m);
  }
  d.appendChild(notes);
  return d;
}

function drawRegionWave(canvas, region) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const spbSec = 60 / state.getSong().tempo;
  const p = clips.peaks(
    region.clipId,
    region.clipOffset ?? 0,
    region.lengthBeats * spbSec,
    canvas.width
  );
  if (!p) return; // decoding; clips.onClipsReady re-renders
  ctx.fillStyle = "rgba(12, 24, 58, 0.8)";
  const mid = canvas.height / 2;
  for (let x = 0; x < p.length; x++) {
    const h = Math.max(1, p[x] * canvas.height);
    ctx.fillRect(x, mid - h / 2, 1, h);
  }
}

// The timeline only ever grows (bar-aligned) — like GarageBand, the ruler
// extends ahead of wherever the playhead travels.
function growTimeline(neededBeats) {
  const total = Math.max(64, lastTotal, Math.ceil(neededBeats / BEATS_PER_BAR) * BEATS_PER_BAR);
  if (total === lastTotal) return;
  lastTotal = total;
  innerEl.style.width = total * PX + "px";
  barsEl.innerHTML = "";
  for (let i = 0; i < total / BEATS_PER_BAR; i++) {
    const bar = document.createElement("div");
    bar.className = "tl-bar";
    bar.style.width = BEATS_PER_BAR * PX + "px";
    bar.textContent = i + 1;
    barsEl.appendChild(bar);
  }
}

// --- region dragging ---

function onLaneMouseDown(e) {
  if (e.button !== 0) return;
  const regionEl = e.target.closest(".tl-region");
  if (regionEl) {
    let regionId = regionEl.dataset.id;
    const before = state.snapshot();
    if (e.altKey) {
      regionId = state.duplicateRegionLive(regionId)?.id ?? regionId; // option-drag copies
    } else {
      state.selectRegion(regionId);
    }
    const found = state.findRegion(regionId);
    if (!found) return;
    drag = {
      regionId,
      before,
      x0: e.clientX,
      y0: e.clientY,
      startBeat0: found.region.startBeat,
      trackIdx0: state.getSong().tracks.indexOf(found.track),
      moved: false,
    };
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragUp);
    e.preventDefault();
    return;
  }

  const lane = e.target.closest(".tl-lane");
  if (!lane) return;
  if (e.detail === 2) {
    // Double-click on empty lane: new empty region at that bar.
    const rect = lane.getBoundingClientRect();
    const beat = Math.max(
      0,
      Math.floor((e.clientX - rect.left) / PX / BEATS_PER_BAR) * BEATS_PER_BAR
    );
    state.addRegion(lane.dataset.id, beat);
  } else {
    state.selectTrack(lane.dataset.id);
  }
}

function onDragMove(e) {
  const found = state.findRegion(drag.regionId);
  if (!found) return;
  const tracks = state.getSong().tracks;
  const dBeat = Math.round((e.clientX - drag.x0) / PX);
  const dTrack = Math.round((e.clientY - drag.y0) / LANE_H);
  const targetIdx = Math.min(tracks.length - 1, Math.max(0, drag.trackIdx0 + dTrack));
  if (tracks[targetIdx].id !== found.track.id) {
    state.moveRegionToTrackLive(drag.regionId, tracks[targetIdx].id);
  }
  const newStart = Math.max(0, drag.startBeat0 + dBeat);
  if (newStart !== found.region.startBeat) {
    found.region.startBeat = newStart;
  }
  drag.moved = true;
  state.notifyLiveChange();
}

function onDragUp() {
  window.removeEventListener("pointermove", onDragMove);
  window.removeEventListener("pointerup", onDragUp);
  state.commitUndo(drag.before);
  drag = null;
}

// --- playhead + cycle strip (driven from the animation frame) ---

export function setArrangePlayhead(beat) {
  if (beat > lastTotal - 8) growTimeline(beat + 32);
  const x = beat * PX;
  playheadEl.style.transform = `translateX(${x}px)`;
  if (engine.getMode() !== "stopped") {
    const view = timelineEl.clientWidth;
    const sl = timelineEl.scrollLeft;
    if (x < sl || x > sl + view - 40) timelineEl.scrollLeft = Math.max(0, x - 40);
  }

  // Live red take with a growing waveform while recording onto an audio track.
  if (engine.isAudioRecording()) {
    const idx = state.getSong().tracks.indexOf(state.getSelectedTrack());
    const start = engine.getRecordStart();
    const widthPx = Math.max(2, (beat - start) * PX);
    recEl.style.display = "";
    recEl.style.top = RULER_H + idx * LANE_H + 3 + "px";
    recEl.style.height = LANE_H - 6 + "px";
    recEl.style.left = start * PX + "px";
    recEl.style.width = widthPx + "px";
    const peaks = engine.getRecordWave(beat);
    if (peaks) {
      const bucketPx = engine.REC_WAVE_RES * PX;
      const w = Math.max(1, Math.round(widthPx) - 2);
      const h = LANE_H - 10;
      if (recWaveEl.width !== w) recWaveEl.width = w;
      if (recWaveEl.height !== h) recWaveEl.height = h;
      const ctx = recWaveEl.getContext("2d");
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "rgba(255, 120, 114, 0.95)";
      const mid = h / 2;
      for (let i = 0; i < peaks.length; i++) {
        const barH = Math.max(1, peaks[i] * h * 0.9);
        ctx.fillRect(i * bucketPx, mid - barH / 2, Math.max(1, bucketPx - 0.5), barH);
      }
    }
  } else if (recEl.style.display !== "none") {
    recEl.style.display = "none";
  }

  const range = engine.getCycleRange();
  const key = range ? `${range.start}:${range.end}` : "";
  if (key !== lastCycleKey) {
    lastCycleKey = key;
    if (range) {
      cycleEl.style.display = "";
      cycleEl.style.left = range.start * PX + "px";
      cycleEl.style.width = (range.end - range.start) * PX + "px";
    } else {
      cycleEl.style.display = "none";
    }
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
