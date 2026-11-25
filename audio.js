'use strict';

/**
 * يحول PCM (48kHz, استيريو, 16-bit) إلى WAV (16kHz, مونو, 16-bit)
 * ويرجع أيضاً مستوى الصوت (rms) ومدة المقطع بالثواني.
 */
function toWav16kMono(pcm) {
  const frames = Math.floor(pcm.length / 4);
  const outLen = Math.floor(frames / 3);
  const mono = new Int16Array(outLen);

  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < outLen; i++) {
    let acc = 0;
    for (let k = 0; k < 3; k++) {
      const off = (i * 3 + k) * 4;
      acc += pcm.readInt16LE(off) + pcm.readInt16LE(off + 2);
    }
    const s = Math.round(acc / 6);
    mono[i] = s;
    sumSq += s * s;
    const a = Math.abs(s);
    if (a > peak) peak = a;
  }

  const rms = outLen ? Math.sqrt(sumSq / outLen) : 0;
  const seconds = outLen / 16000;

  // رفع الصوت الخافت (حد أقصى 6 أضعاف) لتحسين دقة التعرف
  let gain = 1;
  if (peak > 0 && peak < 12000) gain = Math.min(6, 12000 / peak);

  const data = Buffer.alloc(outLen * 2);
  for (let i = 0; i < outLen; i++) {
    const v = Math.max(-32768, Math.min(32767, Math.round(mono[i] * gain)));
    data.writeInt16LE(v, i * 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);

  return { wav: Buffer.concat([header, data]), rms, seconds };
}

module.exports = { toWav16kMono };


