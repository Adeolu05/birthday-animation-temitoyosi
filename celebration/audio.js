// All sound is synthesised live with the Web Audio API — no audio files needed.

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

export class Sound {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.volume = 0.85;
  }

  init() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.25;
    this.master.connect(comp).connect(ctx.destination);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.makeImpulse(3.2, 2.6);
    const wet = ctx.createGain();
    wet.gain.value = 0.9;
    this.reverb.connect(wet).connect(this.master);

    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    ctx.resume();
  }

  get ready() { return !!this.ctx; }
  get now() { return this.ctx ? this.ctx.currentTime : 0; }

  makeImpulse(seconds, decay) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  // route a node to the dry bus + reverb send
  out(node, wet = 0.35) {
    node.connect(this.master);
    if (wet > 0) {
      const s = this.ctx.createGain();
      s.gain.value = wet;
      node.connect(s).connect(this.reverb);
    }
  }

  setMuted(m) {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.now, 0.05);
  }

  // ---------------------------------------------------------------- instruments

  // Music-box / celesta bell
  bell(midi, t = this.now, dur = 1.8, vol = 0.22, wet = 0.45) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const f = mtof(midi);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const partials = [[1, 1], [2, 0.32], [3.01, 0.12], [4.17, 0.06], [5.43, 0.025]];
    for (const [ratio, amp] of partials) {
      const o = ctx.createOscillator();
      const og = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f * ratio;
      og.gain.value = amp;
      o.connect(og).connect(g);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
    this.out(g, wet);
  }

  // Soft warm pad chord
  pad(midis, t = this.now, dur = 2.5, vol = 0.045) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1100;
    lp.Q.value = 0.4;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + Math.min(0.8, dur * 0.35));
    g.gain.setValueAtTime(vol, t + dur * 0.7);
    g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.6);
    lp.connect(g);
    for (const m of midis) {
      for (const det of [-7, 7]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = mtof(m);
        o.detune.value = det;
        o.connect(lp);
        o.start(t);
        o.stop(t + dur + 0.7);
      }
    }
    this.out(g, 0.6);
  }

  bass(midi, t, dur, vol = 0.12) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'triangle';
    o.frequency.value = mtof(midi);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    o.start(t);
    o.stop(t + dur + 0.05);
    this.out(g, 0.15);
  }

  noiseBurst({ t = this.now, dur = 1, vol = 0.3, type = 'lowpass', f0 = 1200, f1 = 200, q = 0.7, wet = 0.3, attack = 0.005 }) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.Q.value = q;
    filt.frequency.setValueAtTime(f0, t);
    filt.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filt).connect(g);
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
    this.out(g, wet);
  }

  // ---------------------------------------------------------------- effects

  chime() {
    const t = this.now;
    [72, 76, 79, 84, 88].forEach((m, i) => this.bell(m, t + i * 0.07, 2.2, 0.12));
  }

  sparkle(t = this.now, vol = 0.07) {
    const scale = [84, 86, 88, 91, 93, 96, 98, 100];
    for (let i = 0; i < 9; i++) this.bell(scale[(Math.random() * scale.length) | 0], t + i * 0.055, 1.2, vol, 0.6);
  }

  ting(i = 0) {
    const notes = [72, 74, 76, 79, 81, 84, 86, 88, 91, 93, 96, 98];
    this.bell(notes[i % notes.length], this.now, 1.4, 0.13);
  }

  heartbeat(t) {
    for (const [dt, v] of [[0, 1], [0.22, 0.7]]) {
      if (!this.ctx) return;
      const ctx = this.ctx;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(70, t + dt);
      o.frequency.exponentialRampToValueAtTime(38, t + dt + 0.18);
      g.gain.setValueAtTime(0.0001, t + dt);
      g.gain.linearRampToValueAtTime(0.35 * v, t + dt + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.25);
      o.connect(g);
      o.start(t + dt);
      o.stop(t + dt + 0.3);
      this.out(g, 0.1);
    }
  }

  whoosh() {
    this.noiseBurst({ dur: 0.9, vol: 0.05, type: 'bandpass', f0: 400, f1: 3000, q: 1.2, attack: 0.25, wet: 0.2 });
  }

  boom(size = 1) {
    if (!this.ctx) return;
    const t = this.now + 0.03;
    this.noiseBurst({ t, dur: 1.6 * size, vol: 0.32 * size, f0: 1600, f1: 120, wet: 0.5 });
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(35, t + 0.5);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.4 * size, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    o.connect(g);
    o.start(t);
    o.stop(t + 0.65);
    this.out(g, 0.2);
  }

  crackle(count = 14) {
    const t0 = this.now + 0.5;
    for (let i = 0; i < count; i++) {
      this.noiseBurst({ t: t0 + Math.random() * 0.9, dur: 0.05, vol: 0.05, type: 'highpass', f0: 4000, f1: 6000, wet: 0.4, attack: 0.002 });
    }
  }

  blow() {
    this.noiseBurst({ dur: 1.1, vol: 0.28, type: 'bandpass', f0: 900, f1: 500, q: 0.5, attack: 0.08, wet: 0.2 });
  }

  pop() {
    this.noiseBurst({ dur: 0.12, vol: 0.2, type: 'highpass', f0: 1500, f1: 800, wet: 0.2, attack: 0.002 });
  }

  // ---------------------------------------------------------------- music

  // Soft felt-piano voice: slightly inharmonic partials, hammer-bright attack that mellows.
  piano(midi, t, dur, vol = 0.2) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const f = mtof(midi);
    const ring = Math.max(dur * 1.6, 2.2 + (72 - midi) * 0.04);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.006);
    g.gain.exponentialRampToValueAtTime(vol * 0.35, t + 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t + ring);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(Math.min(9000, f * 9), t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(500, f * 2.2), t + 1.2);
    lp.connect(g);
    const B = 0.00035;
    [[1, 1], [2, 0.42], [3, 0.16], [4, 0.08], [5, 0.035]].forEach(([n, a]) => {
      const o = ctx.createOscillator();
      const og = ctx.createGain();
      o.type = n === 1 ? 'triangle' : 'sine';
      o.frequency.value = f * n * Math.sqrt(1 + B * n * n);
      o.detune.value = (Math.random() - 0.5) * 3;
      og.gain.value = a;
      o.connect(og).connect(lp);
      o.start(t);
      o.stop(t + ring + 0.05);
    });
    this.out(g, 0.55);
  }

  // Bowed string ensemble swell
  strings(midis, t, dur, vol = 0.03) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1700;
    lp.Q.value = 0.3;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + dur * 0.45);
    g.gain.linearRampToValueAtTime(vol * 0.7, t + dur);
    g.gain.linearRampToValueAtTime(0.0001, t + dur + 1.2);
    lp.connect(g);
    for (const m of midis) for (const det of [-9, 0, 9]) {
      const o = ctx.createOscillator();
      const vib = ctx.createOscillator();
      const vg = ctx.createGain();
      o.type = 'sawtooth';
      o.frequency.value = mtof(m);
      o.detune.value = det;
      vib.frequency.value = 4.6 + Math.random();
      vg.gain.value = 2.2;
      vib.connect(vg).connect(o.frequency);
      o.connect(lp);
      o.start(t); vib.start(t);
      o.stop(t + dur + 1.3); vib.stop(t + dur + 1.3);
    }
    this.out(g, 0.7);
  }

  // An original piano ballad (Am – F – C – G), written for this page.
  // Returns its length in seconds.
  theme({ bars = 16, vol = 1, strings = false, bpm = 66 } = {}) {
    const beat = 60 / bpm;
    if (!this.ctx) return bars * 4 * beat;
    const t0 = this.now + 0.1;
    const Am = [45, 52, 57, 60], F = [41, 48, 53, 57], C = [48, 55, 60, 64], G = [43, 50, 55, 59], Em = [40, 47, 52, 55];
    const chords = [Am, F, C, G, Am, F, C, G, F, G, Em, Am, F, G, C, C];
    const melody = [
      [[76, 1.5], [74, 0.5], [72, 1], [71, 1]],
      [[69, 2], [72, 1], [77, 1]],
      [[76, 1.5], [74, 0.5], [76, 1], [79, 1]],
      [[74, 2], [71, 1], [74, 1]],
      [[76, 1.5], [74, 0.5], [72, 1], [76, 1]],
      [[81, 2], [79, 1], [77, 1]],
      [[76, 1], [79, 1], [84, 1.5], [83, 0.5]],
      [[83, 2], [81, 0.5], [79, 1.5]],
      [[81, 1.5], [79, 0.5], [77, 1], [76, 1]],
      [[74, 1.5], [76, 0.5], [77, 1], [79, 1]],
      [[79, 1.5], [76, 0.5], [71, 1], [76, 1]],
      [[72, 2], [76, 1], [81, 1]],
      [[81, 1.5], [79, 0.5], [77, 1], [81, 1]],
      [[79, 1.5], [77, 0.5], [74, 1], [71, 1]],
      [[76, 1], [74, 1], [72, 2]],
      [[72, 4]],
    ];
    const playBar = (b) => {
      if (!this.ctx) return;
      const bt = t0 + b * 4 * beat;
      const ch = chords[b % 16];
      const last = b === bars - 1;
      // left hand: rolling broken chord in eighths
      const pattern = last ? [0, 1, 2, 3] : [0, 1, 2, 3, 2, 1, 2, 3];
      const step = last ? beat : beat / 2;
      pattern.forEach((k, i) => {
        const swell = 0.75 + 0.25 * Math.sin((i / pattern.length) * Math.PI);
        this.piano(ch[k], bt + i * step + Math.random() * 0.01, step * 2, 0.07 * vol * swell);
      });
      this.piano(ch[0] - 12, bt, beat * 4, 0.075 * vol);
      // right hand melody (bars 1–4 are played an octave lower and softer, so it builds)
      let mt = 0;
      const soft = b < 4 && bars > 8 ? 0.75 : 1;
      for (const [m, len] of melody[b % 16]) {
        const human = (Math.random() - 0.5) * 0.02 + (mt === 0 ? 0 : 0.01);
        this.piano(m - (b < 4 && bars > 8 ? 12 : 0), bt + mt * beat + human, len * beat, 0.14 * vol * soft);
        mt += len;
      }
      if (strings && b >= 4) this.strings([ch[1] + 12, ch[2] + 12, ch[3] + 12], bt, beat * 4, (b >= 8 ? 0.026 : 0.016) * vol);
    };
    // schedule each bar ~2s ahead on the audio clock, rather than thousands of nodes at once
    for (let b = 0; b < bars; b++) setTimeout(() => playBar(b), Math.max(0, (b * 4 * beat - 2) * 1000));
    return bars * 4 * beat + 2;
  }

  // Gentle chord bed: C – Am – F – G
  ambience(bars = 8, barDur = 2.4) {
    if (!this.ctx) return;
    const chords = [[60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62]];
    const t0 = this.now + 0.05;
    for (let i = 0; i < bars; i++) {
      const c = chords[i % 4];
      this.pad(c, t0 + i * barDur, barDur, 0.035);
      this.bass(c[0] - 12, t0 + i * barDur, barDur * 0.9, 0.06);
    }
  }

  // "Happy Birthday" (public domain) on music box with pads.
  // Returns line start times (seconds from now) for karaoke captions.
  song({ beat = 0.52, vol = 1, octave = 0 } = {}) {
    if (!this.ctx) return { lines: [0, 3.1, 6.2, 9.4], duration: 13.5 };
    const line1 = [[67, 0.75], [67, 0.25], [69, 1], [67, 1], [72, 1], [71, 2]];
    const line2 = [[67, 0.75], [67, 0.25], [69, 1], [67, 1], [74, 1], [72, 2]];
    const line3 = [[67, 0.75], [67, 0.25], [79, 1], [76, 1], [72, 1], [71, 1], [69, 1]];
    const line4 = [[77, 0.75], [77, 0.25], [76, 1], [72, 1], [74, 1], [72, 3]];
    const t0 = this.now + 0.15;
    const lineStarts = [];
    let b = 0;
    for (const line of [line1, line2, line3, line4]) {
      lineStarts.push(b * beat + 0.15);
      for (const [m, len] of line) {
        const swing = (Math.random() - 0.5) * 0.012;
        this.bell(m + octave, t0 + b * beat + swing, Math.max(1.2, len * beat * 2.2), 0.2 * vol);
        b += len;
      }
    }
    // chords on each bar (pickup = 1 beat, then 8 bars of 3)
    const C = [60, 64, 67], G = [55, 59, 62], F = [53, 57, 60];
    const bars = [C, G, G, C, C, F, G, C];
    const bassN = [48, 43, 43, 48, 48, 41, 43, 48];
    bars.forEach((ch, i) => {
      const t = t0 + (1 + i * 3) * beat;
      const len = i === 7 ? 4 * beat : 3 * beat;
      this.pad(ch, t, len, 0.03 * vol);
      this.bass(bassN[i], t, len * 0.9, 0.1 * vol);
      this.bell(ch[1] + octave - 12, t + beat, 0.9, 0.05 * vol, 0.3);
      this.bell(ch[2] + octave - 12, t + 2 * beat, 0.9, 0.05 * vol, 0.3);
    });
    return { lines: lineStarts, duration: b * beat + 0.15 };
  }

  fanfare() {
    if (!this.ctx) return;
    const t = this.now + 0.05;
    [60, 64, 67, 72, 76, 79, 84].forEach((m, i) => this.bell(m, t + i * 0.06, 2.6, 0.12));
    this.pad([60, 64, 67, 72], t, 4, 0.05);
    this.bass(36, t, 3, 0.12);
  }

  // ---------------------------------------------------------------- microphone

  async startMic() {
    this.init();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const src = this.ctx.createMediaStreamSource(stream);
    const an = this.ctx.createAnalyser();
    an.fftSize = 1024;
    src.connect(an); // not connected to the speakers
    const buf = new Float32Array(an.fftSize);
    return {
      level() {
        an.getFloatTimeDomainData(buf);
        let s = 0;
        for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
        return Math.sqrt(s / buf.length);
      },
      stop() {
        stream.getTracks().forEach((t) => t.stop());
        src.disconnect();
      },
    };
  }
}
