// Offline audio render: play the whole song through the same instruments
// in a Tone.Offline context (faster than real time, no speakers involved)
// and encode the result as a 16-bit WAV file.

import * as Tone from "tone";
import * as clips from "../clips.js";
import { buildInstrument, audibleTracks } from "../audio.js";

const TAIL_SECONDS = 1.5; // let releases/cymbals ring out

export function songEndBeat(song) {
  let end = 0;
  for (const track of song.tracks) {
    for (const region of track.regions) {
      end = Math.max(end, region.startBeat + region.lengthBeats);
    }
  }
  return end;
}

export async function renderSongToWav(song) {
  const secondsPerBeat = 60 / song.tempo;
  const duration = songEndBeat(song) * secondsPerBeat + TAIL_SECONDS;
  await clips.ensureBuffersFor(song); // decode mic takes before rendering

  // Render at the live context's rate so recorded clips drop in unresampled.
  const buffer = await Tone.Offline(({ transport }) => {
    // Instruments constructed here bind to the offline context.
    for (const track of audibleTracks(song)) {
      let node = null;
      for (const region of track.regions) {
        if (region.clipId) {
          const clipBuffer = clips.getPlayBuffer(region.clipId, track.autotune);
          if (!clipBuffer) continue;
          // Offline transport starts at 0, so context time == song time.
          const src = new Tone.ToneBufferSource(clipBuffer).toDestination();
          src.start(
            region.startBeat * secondsPerBeat,
            region.clipOffset ?? 0,
            region.lengthBeats * secondsPerBeat
          );
          continue;
        }
        node ??= buildInstrument(track.instrument);
        const boundNode = node;
        for (const note of region.notes) {
          const when = (region.startBeat + note.startBeat) * secondsPerBeat;
          transport.schedule((time) => {
            boundNode.play(note.pitch, note.durationBeats * secondsPerBeat, time, note.velocity / 127);
          }, when);
        }
      }
    }
    transport.start(0);
  }, duration, 2, Tone.getContext().sampleRate);

  return encodeWav(buffer.get());
}

function encodeWav(audioBuffer) {
  const numCh = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const frames = audioBuffer.length;
  const blockAlign = numCh * 2; // 16-bit
  const dataSize = frames * blockAlign;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  const channels = [];
  for (let c = 0; c < numCh; c++) channels.push(audioBuffer.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([out], { type: "audio/wav" });
}

function writeAscii(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}
