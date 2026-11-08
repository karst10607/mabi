import fs from 'node:fs';
import path from 'node:path';

function createWavBuffer(sampleRate, samples) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  // fmt subchunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
  buffer.writeUInt16LE(1, 20);  // AudioFormat (1 for PCM)
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  // data subchunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // write 16-bit PCM samples
  for (let i = 0; i < samples.length; i++) {
    const val = Math.max(-1, Math.min(1, samples[i]));
    const intVal = val < 0 ? val * 0x8000 : val * 0x7FFF;
    buffer.writeInt16LE(Math.round(intVal), 44 + i * 2);
  }

  return buffer;
}

const SAMPLE_RATE = 44100;

// 1. pat.wav: High gentle chime (880Hz -> 1320Hz, 0.25s)
function generatePat() {
  const dur = 0.25;
  const totalSamples = Math.floor(SAMPLE_RATE * dur);
  const samples = new Float32Array(totalSamples);
  let phase = 0;
  for (let i = 0; i < totalSamples; i++) {
    const t = i / SAMPLE_RATE;
    // frequency ramps from 880 to 1320 in first 0.12s, then holds
    const f = t < 0.12 ? 880 + (1320 - 880) * (t / 0.12) : 1320;
    phase += (2 * Math.PI * f) / SAMPLE_RATE;
    // gain ramps down exponentially from 0.4 to 0.001
    const gain = 0.45 * Math.exp(-t * 18);
    samples[i] = Math.sin(phase) * gain;
  }
  return createWavBuffer(SAMPLE_RATE, samples);
}

// 2. feed.wav: Cute munching / happy blip (523Hz -> 784Hz -> 1046Hz, 0.25s)
function generateFeed() {
  const dur = 0.25;
  const totalSamples = Math.floor(SAMPLE_RATE * dur);
  const samples = new Float32Array(totalSamples);
  let phase = 0;
  for (let i = 0; i < totalSamples; i++) {
    const t = i / SAMPLE_RATE;
    let f = 523.25;
    if (t < 0.08) {
      f = 523.25 + (783.99 - 523.25) * (t / 0.08);
    } else if (t < 0.18) {
      f = 783.99 + (1046.5 - 783.99) * ((t - 0.08) / 0.10);
    } else {
      f = 1046.5;
    }
    phase += (2 * Math.PI * f) / SAMPLE_RATE;
    // Triangle wave approximation
    const tri = 2 * Math.abs(2 * (phase / (2 * Math.PI) - Math.floor(phase / (2 * Math.PI) + 0.5))) - 1;
    const gain = 0.4 * Math.exp(-t * 16);
    samples[i] = tri * gain;
  }
  return createWavBuffer(SAMPLE_RATE, samples);
}

// 3. pop.wav: Bubble pop (600Hz -> 1200Hz, 0.08s)
function generatePop() {
  const dur = 0.08;
  const totalSamples = Math.floor(SAMPLE_RATE * dur);
  const samples = new Float32Array(totalSamples);
  let phase = 0;
  for (let i = 0; i < totalSamples; i++) {
    const t = i / SAMPLE_RATE;
    const f = 600 + (1200 - 600) * (t / dur);
    phase += (2 * Math.PI * f) / SAMPLE_RATE;
    const gain = 0.4 * Math.exp(-t * 40);
    samples[i] = Math.sin(phase) * gain;
  }
  return createWavBuffer(SAMPLE_RATE, samples);
}

// 4. talk.wav: Soft chirp (700Hz -> 900Hz, 0.10s)
function generateTalk() {
  const dur = 0.10;
  const totalSamples = Math.floor(SAMPLE_RATE * dur);
  const samples = new Float32Array(totalSamples);
  let phase = 0;
  for (let i = 0; i < totalSamples; i++) {
    const t = i / SAMPLE_RATE;
    const f = 700 + (900 - 700) * (t / dur);
    phase += (2 * Math.PI * f) / SAMPLE_RATE;
    const gain = 0.35 * Math.exp(-t * 30);
    samples[i] = Math.sin(phase) * gain;
  }
  return createWavBuffer(SAMPLE_RATE, samples);
}

const assetsDir = path.resolve('godot/assets');
if (!fs.existsSync(assetsDir)) {
  fs.mkdirSync(assetsDir, { recursive: true });
}

fs.writeFileSync(path.join(assetsDir, 'pat.wav'), generatePat());
fs.writeFileSync(path.join(assetsDir, 'feed.wav'), generateFeed());
fs.writeFileSync(path.join(assetsDir, 'pop.wav'), generatePop());
fs.writeFileSync(path.join(assetsDir, 'talk.wav'), generateTalk());

console.log('Generated pat.wav, feed.wav, pop.wav, talk.wav in', assetsDir);
