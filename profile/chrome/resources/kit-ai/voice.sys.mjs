// Voice input for the assistant: the window records the microphone, whisper.cpp
// (whisper-cli) turns it into text on this computer. Set up with bin/voice setup.
//
//   const rec = await startRecording(window, {
//     onLevel: level => …,     // 0…1, for the button
//     onEnd: heard => …,       // a pause after speech (true) or no speech at all (false)
//   });
//   const wav = await rec.stop();                           // or rec.cancel()
//   const text = await transcribe(wav, findRepo());

import { Subprocess } from "resource://gre/modules/Subprocess.sys.mjs";

const RATE = 16000; // whisper.cpp takes 16 kHz mono WAV
const MODEL_NAME = "ggml-large-v3-turbo-q5_0.bin";
// When a phrase is over: the level is measured against the room's noise in the first moments.
const NOISE_MS = 250; // the noise level is taken from this start of the recording
const SPEECH_MS = 200; // this much sound above the noise counts as speech
const PAUSE_MS = 1500; // silence after speech that ends the phrase
const WAIT_MS = 8000; // no speech this long — nothing to wait for
const SETUP = "Voice input needs whisper.cpp and its model: run bin/voice setup in the Zendo folder.";

function searchPath() {
  const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
  return [PathUtils.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");
}

async function findWhisper() {
  const pref = Services.prefs.getStringPref("kit.ai.voice-whisper", "");
  if (pref) {
    return pref;
  }
  try {
    return await Subprocess.pathSearch("whisper-cli", { PATH: searchPath() });
  } catch (e) {
    return null;
  }
}

function modelPath(repo) {
  const pref = Services.prefs.getStringPref("kit.ai.voice-model", "");
  return pref || (repo ? PathUtils.join(repo, ".kit", "whisper", MODEL_NAME) : null);
}

// Is everything for voice input in place? → null or what to do.
export async function missing(repo) {
  const model = modelPath(repo);
  if (!(await findWhisper()) || !model || !(await IOUtils.exists(model))) {
    return SETUP;
  }
  return null;
}

// Records from the default microphone until stop() or cancel().
export async function startRecording(win, { onLevel, onEnd } = {}) {
  const stream = await win.navigator.mediaDevices.getUserMedia({ audio: true });
  const ctx = new win.AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  // ScriptProcessor: no worklet file to load, and the chunks are small
  const node = ctx.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  let elapsed = 0;
  let noise = 0;
  let noiseChunks = 0;
  let speech = 0;
  let silence = 0;
  let ended = false;
  node.onaudioprocess = e => {
    const data = e.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(data));
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      sum += data[i] * data[i];
    }
    const rms = Math.sqrt(sum / data.length);
    const ms = (data.length / ctx.sampleRate) * 1000;
    elapsed += ms;
    onLevel?.(Math.min(1, rms * 8));

    if (elapsed <= NOISE_MS) {
      noise = (noise * noiseChunks + rms) / ++noiseChunks;
      return;
    }
    if (rms > Math.max(0.02, noise * 3)) {
      speech += ms;
    }
    silence = rms > Math.max(0.012, noise * 2) ? 0 : silence + ms;
    if (!ended && onEnd) {
      const heard = speech >= SPEECH_MS;
      if ((heard && silence >= PAUSE_MS) || (!heard && elapsed >= WAIT_MS)) {
        ended = true;
        onEnd(heard);
      }
    }
  };
  source.connect(node);
  node.connect(ctx.destination); // a ScriptProcessor only runs when connected; it outputs silence

  const finish = () => {
    node.onaudioprocess = null;
    source.disconnect();
    node.disconnect();
    stream.getTracks().forEach(t => t.stop());
    const rate = ctx.sampleRate;
    ctx.close();
    return rate;
  };
  return {
    async stop() {
      const rate = finish();
      return wav(resample(join(chunks), rate, RATE), RATE);
    },
    cancel() {
      finish();
    },
  };
}

function join(chunks) {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// Down to 16 kHz: the average of the source samples that fall into each output one.
function resample(data, from, to) {
  if (from === to) {
    return data;
  }
  const ratio = from / to;
  const out = new Float32Array(Math.floor(data.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(data.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) {
      sum += data[j];
    }
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

function wav(samples, rate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (at, s) => [...s].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

// WAV bytes → text. The language is detected by whisper itself.
export async function transcribe(bytes, repo) {
  const whisper = await findWhisper();
  const model = modelPath(repo);
  if (!whisper || !model || !(await IOUtils.exists(model))) {
    throw new Error(SETUP);
  }
  const file = PathUtils.join(PathUtils.tempDir, `kit-ai-voice-${Date.now()}.wav`);
  await IOUtils.write(file, bytes);
  try {
    const proc = await Subprocess.call({
      command: whisper,
      arguments: ["-m", model, "-f", file, "-l", "auto", "-nt", "-np"],
      environment: { PATH: searchPath() },
      environmentAppend: true,
      stderr: "pipe",
    });
    let out = "";
    let err = "";
    const read = async (pipe, add) => {
      let chunk;
      while ((chunk = await pipe.readString())) {
        add(chunk);
      }
    };
    await Promise.all([read(proc.stdout, c => (out += c)), read(proc.stderr, c => (err += c))]);
    const { exitCode } = await proc.wait();
    if (exitCode !== 0) {
      throw new Error(`whisper-cli failed: ${err.trim().split("\n").pop() || exitCode}`);
    }
    // whisper marks silence and noise as [BLANK_AUDIO], (music) and the like
    return out
      .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  } finally {
    IOUtils.remove(file).catch(() => {});
  }
}
