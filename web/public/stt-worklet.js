/* AudioWorklet for lib/stt.ts: mic (any context rate) -> mono PCM16 at 16 kHz, posted in ~100 ms chunks with an RMS level.
   Plain JS in public/ because the CSP (script-src 'self') does not allow blob: worklets. Keep in sync with Decimator in
   src/lib/stt.ts (ScriptProcessor fallback). */
class Pcm16Capture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.target = o.targetRate || 16000;
    this.chunk = Math.round(this.target * (o.chunkMs || 100) / 1000);
    this.buf = new Int16Array(this.chunk);
    this.n = 0; this.acc = 0; this.cnt = 0; this.phase = 0; this.sq = 0;
    this.on = true;
    this.port.onmessage = (e) => {
      if (e.data === 'flush') this.flush();
      else if (e.data === 'stop') { this.flush(); this.on = false; }
    };
  }
  flush() {
    if (!this.n) return;
    const out = this.buf.slice(0, this.n);
    const rms = Math.sqrt(this.sq / this.n);
    this.port.postMessage({ pcm: out.buffer, rms }, [out.buffer]);
    this.n = 0; this.sq = 0;
  }
  process(inputs) {
    if (!this.on) return false;
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    const rate = sampleRate, target = this.target;
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i]; this.cnt++;
      this.phase += target;
      if (this.phase >= rate) {
        this.phase -= rate;
        let v = this.acc / this.cnt; this.acc = 0; this.cnt = 0;
        if (v > 1) v = 1; else if (v < -1) v = -1;
        this.sq += v * v;
        this.buf[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        if (this.n === this.chunk) this.flush();
      }
    }
    return true;
  }
}
registerProcessor('pcm16-capture', Pcm16Capture);
