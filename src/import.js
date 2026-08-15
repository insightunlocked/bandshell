// Drag-and-drop import. Audio files (mp3, wav, m4a, …) land on the timeline
// as audio regions where you drop them; a saved .bandshell.json opens as a
// project.

import * as Tone from "tone";
import * as state from "./state.js";
import * as clips from "./clips.js";
import { ensureAudio } from "./audio.js";
import { BEATS_PER_BAR, INSTRUMENTS } from "./state.js";
import { pointToTimeline } from "./ui/arrange.js";

const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|aif|aiff|webm)$/i;

let overlayEl = null;
let depth = 0; // dragenter/dragleave fire per child; count to know when we exit

export function initImport(appEl) {
  overlayEl = document.createElement("div");
  overlayEl.className = "drop-overlay";
  overlayEl.innerHTML = `<div class="drop-card">
      <b>Drop to import</b>
      <span>Audio files become takes on the timeline · .bandshell.json opens a song</span>
    </div>`;
  appEl.appendChild(overlayEl);

  appEl.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    overlayEl.classList.add("on");
  });
  appEl.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  appEl.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    if (--depth <= 0) {
      depth = 0;
      overlayEl.classList.remove("on");
    }
  });
  appEl.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlayEl.classList.remove("on");
    handleDrop(e);
  });
}

function hasFiles(e) {
  return [...(e.dataTransfer?.types ?? [])].includes("Files");
}

async function handleDrop(e) {
  const files = [...(e.dataTransfer?.files ?? [])];
  if (!files.length) return;

  // Where on the timeline the pointer was — null when dropped elsewhere.
  const at = pointToTimeline(e.clientX, e.clientY);
  let beat = at ? Math.max(0, Math.floor(at.beat / BEATS_PER_BAR) * BEATS_PER_BAR) : 0;
  let trackId = at?.trackId ?? null;

  for (const file of files) {
    if (/\.json$/i.test(file.name)) {
      await importProject(file);
      return; // a project replaces everything; ignore the rest of the drop
    }
    if (AUDIO_EXT.test(file.name) || file.type.startsWith("audio/")) {
      const region = await importAudioFile(file, trackId, beat);
      if (region) {
        // Stack multiple files end to end rather than on top of each other.
        beat += region.lengthBeats;
        trackId = state.findRegion(region.id)?.track.id ?? trackId;
      }
    } else {
      alert(`"${file.name}" isn't an audio file or a Bandshell song.`);
    }
  }
}

async function importProject(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!state.loadFromData(data)) throw new Error("invalid");
  } catch {
    alert(`Couldn't open "${file.name}" — it doesn't look like a Bandshell song.`);
  }
}

async function importAudioFile(file, trackId, beat) {
  try {
    await ensureAudio();
    const buffer = await Tone.getContext().rawContext.decodeAudioData(await file.arrayBuffer());
    const clipId = "clip-" + Math.random().toString(36).slice(2, 10);
    clips.putClip({ id: clipId, mime: file.type || "audio/*", blob: file, buffer });
    clips.persistClip(clipId);

    const track = targetTrack(trackId, file.name);
    const beatsPerSec = state.getSong().tempo / 60;
    const lengthBeats = Math.max(1, Math.ceil(buffer.duration * beatsPerSec));
    return state.addAudioRegion(track.id, beat, lengthBeats, clipId, 0);
  } catch (err) {
    console.error("Import failed:", err);
    alert(`Couldn't read "${file.name}" — the browser can't decode that audio format.`);
    return null;
  }
}

// Drop onto an audio track to use it; anything else gets a new audio track
// named after the file, so an instrument track is never overwritten.
function targetTrack(trackId, fileName) {
  const song = state.getSong();
  const dropped = song.tracks.find((t) => t.id === trackId);
  if (dropped && INSTRUMENTS[dropped.instrument].kind === "audio") return dropped;
  const track = state.addTrack("audio");
  state.renameTrack(track.id, fileName.replace(/\.[^.]+$/, "").slice(0, 28));
  return track;
}
