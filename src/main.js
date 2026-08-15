import "./style.css";
import * as state from "./state.js";
import * as engine from "./audio.js";
import { initKeyboard } from "./keyboard.js";
import { initTransport, updateClock } from "./ui/transport.js";
import { initArrange, setArrangePlayhead } from "./ui/arrange.js";
import { initPianoRoll, setRollPlayhead } from "./ui/pianoroll.js";
import { initTypingStrip } from "./ui/typing.js";
import { initImport } from "./import.js";

initTransport(document.getElementById("transport"));
initArrange(document.getElementById("track-headers"), document.getElementById("timeline"));
initPianoRoll(document.getElementById("editor"));
initTypingStrip(document.getElementById("typing-strip"));
initKeyboard();
initImport(document.getElementById("app"));

// Console debug handle (also used by automated tests).
import { songToMidi } from "./export/midi.js";
import { renderSongToWav, songEndBeat } from "./export/wav.js";
import * as clips from "./clips.js";
window.bandshell = { engine, state, clips, songToMidi, renderSongToWav, songEndBeat };

// Restore any mic recordings persisted by earlier sessions, then repaint
// waveforms (clips.onClipsReady listeners handle the repaint).
clips.loadPersistedClips();

function frame() {
  const beat = engine.getPlayheadBeat();
  updateClock(beat, engine.getMode());
  setArrangePlayhead(beat);
  setRollPlayhead(beat);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
