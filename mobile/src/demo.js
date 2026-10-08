// 연습 모드: AI 없이 폰 안에서 연습용 노래를 만든다 (무료, 인터넷 없이). 연습용 그림·주인공은 공용 demo-data 와 C2/C3 가 이어서 만든다.

/** 박자가 분명한 연습용 음악 (킥 드럼 + 하이햇 + 화음) → WAV */
export async function demoSong({ seconds = 60, bpm = 120 } = {}) {
  const sr = 22050;
  const ctx = new OfflineAudioContext(1, Math.round(sr * seconds), sr);
  const beat = 60 / bpm;
  const master = ctx.createGain();
  master.gain.value = 0.8;
  master.connect(ctx.destination);
  for (let t = 0, i = 0; t < seconds; t += beat, i++) {
    // 킥
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(i % 4 === 0 ? 0.95 : 0.6, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + 0.3);
    // 하이햇 (엇박)
    const n = ctx.createOscillator();
    const ng = ctx.createGain();
    n.type = 'square';
    n.frequency.value = 6800;
    ng.gain.setValueAtTime(0.03, t + beat / 2);
    ng.gain.exponentialRampToValueAtTime(0.0005, t + beat / 2 + 0.04);
    n.connect(ng).connect(master);
    n.start(t + beat / 2);
    n.stop(t + beat / 2 + 0.05);
  }
  // 마디마다 바뀌는 화음
  const chords = [[261.63, 329.63, 392.0], [220.0, 277.18, 329.63], [174.61, 220.0, 261.63], [196.0, 246.94, 293.66]];
  for (let t = 0, b = 0; t < seconds; t += beat * 4, b++) {
    for (const f of chords[b % chords.length]) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'triangle';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.05, t + 0.05);
      g.gain.linearRampToValueAtTime(0.03, t + beat * 4 - 0.05);
      g.gain.linearRampToValueAtTime(0.0001, t + beat * 4);
      o.connect(g).connect(master);
      o.start(t);
      o.stop(Math.min(seconds, t + beat * 4));
    }
  }
  const buf = await ctx.startRendering();
  return new Blob([wav(buf)], { type: 'audio/wav' });
}

function wav(buf) {
  const data = buf.getChannelData(0);
  const out = new DataView(new ArrayBuffer(44 + data.length * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  out.setUint32(4, 36 + data.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, buf.sampleRate, true);
  out.setUint32(28, buf.sampleRate * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  str(36, 'data');
  out.setUint32(40, data.length * 2, true);
  for (let i = 0; i < data.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, data[i])) * 0x7fff, true);
  return out.buffer;
}
