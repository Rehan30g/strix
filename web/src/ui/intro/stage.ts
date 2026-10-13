/* A full-screen orb canvas for the tour (two are used: one behind the 3D panels, one transparent in front of them).
   ONE WebGL context each, up to three passes per frame:
   1. background (skipped when bg is null = transparent layer): soft gradient + two glows + film grain + vignette,
   2. "dots": many small balls (the voice sea, bokeh, rings) in ONE instanced draw call,
   3. "rich" balls: the real orb shader of ui/orb.ts (one draw each, a handful per frame), patched with depth-of-field
      blur, opacity and a liquid colour wipe A -> B.
   Every ball is a perfect circle in device pixels: the quads are square in pixels (uRect / uRes are both in device
   px), the rich shader's rim wobble and jelly harmonics are removed, and there is no motion-blur stretch (speed is
   shown as extra defocus instead). Canvas 2D fallback (no WebGL / no instancing): same layout with radial gradients.
   `probe()` (test hook) draws each ball alone and measures its alpha bounding box from a pixel readback. */
import { ORB_FS, ORB_JELLY_SCALE, orbSoftness, type OrbSpec, type Rgb } from '../orb';
import { buildProgram } from '../glprog';

export interface Rich {
  id: string; x: number; y: number; r: number;          // css px, r = orb radius
  spec: OrbSpec; to?: OrbSpec | null; wipe?: number;     // colour wipe A -> B (0..1)
  wipeDir?: [number, number];
  blur?: number; alpha?: number; amp?: number; time?: number;
  z?: number;                                            // draw order (higher = later)
}
export interface Dot {
  x: number; y: number; r: number; blur?: number; alpha?: number;
  c0: Rgb; c1: Rgb; c2: Rgb; seed?: number;
  mode?: 0 | 1;                                          // 0 ball, 1 ring
}
export interface Bg { top: Rgb; bot: Rgb; glow: Rgb; glow2: Rgb; g: [number, number, number]; g2: [number, number, number]; fade?: number }
export interface Probe { kind: 'rich' | 'dot'; id: string; r: number; w: number; h: number; ratio: number; elong?: number; skipped?: string }

const VS_FULL = `attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}`;
const FS_BG = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 uRes;uniform vec3 uTop,uBot,uGlow,uGlow2,uG,uG2;uniform float uT,uGrain,uFade;
float hs(vec2 p){vec3 q=fract(vec3(p.xyx)*.1031);q+=dot(q,q.yzx+33.33);return fract((q.x+q.y)*q.z);}
void main(){
 vec2 p=vec2(gl_FragCoord.x,uRes.y-gl_FragCoord.y);
 vec3 c=mix(uTop,uBot,smoothstep(0.,1.,p.y/uRes.y));
 float d=length(p-uG.xy)/max(1.,uG.z);c+=uGlow*exp(-d*d*1.3)*.6;
 float e=length(p-uG2.xy)/max(1.,uG2.z);c+=uGlow2*exp(-e*e*1.6)*.4;
 vec2 q=p/uRes-.5;c*=1.-dot(q,q)*.7;
 c+=(hs(floor(p)+vec2(floor(uT*24.)*37.,floor(uT*24.)*11.))-.5)*uGrain;
 gl_FragColor=vec4(clamp(c,0.,1.)*uFade,uFade);
}`;

const VS_RICH = `attribute vec2 a;uniform vec4 uRect;varying vec2 v;void main(){v=a*.5+.5;gl_Position=vec4(uRect.xy+a*uRect.zw,0.,1.);}`;

/** The orb fragment shader + blur / alpha / palette wipe, with a perfectly round silhouette. Built by patching ORB_FS
    at known anchors; if an anchor is missing the shader is used as is (still drawn, just without the extras). */
function richFS(): string {
  let fs = ORB_FS;
  const A0 = 'float R=.88+wob+uAmp*.025+max(-.5,jel);';
  const A1 = 'float a=smoothstep(0.,2.6/uSize,R-r);';
  const A2 = 'float an=uSeed.x*6.283;';
  const A3 = 'gl_FragColor=vec4(clamp(c,0.,1.)*a,a);';
  if (![A0, A1, A2, A3].every((x) => fs.includes(x))) return fs;
  // round: the radius no longer depends on the angle (no wobble, no jelly harmonics); speech only grows it uniformly
  fs = fs.replace(A0, 'float R=.88+uAmp*.025;');
  fs = fs.replace('uniform vec4 uSeed;', 'uniform vec4 uSeed;\nuniform float uBlur,uAlpha,uWipe;uniform vec2 uWipeDir;uniform vec3 uD0,uD1,uD2,uD3,uD4;');
  fs = fs.replace(A1, 'float a=smoothstep(-uBlur*.55,2.6/uSize+uBlur*.55,R-r);');
  const [head, tail] = fs.split(A2);
  const wipe = `${A2}
 float wpos=dot(q,uWipeDir)*.5+.5+(f-.5)*.55;
 float wk=smoothstep(wpos-.16,wpos+.16,uWipe*1.9-.45);
 vec3 C0=mix(uC0,uD0,wk),C1=mix(uC1,uD1,wk),C2=mix(uC2,uD2,wk),C3=mix(uC3,uD3,wk),C4=mix(uC4,uD4,wk);`;
  const body = tail.replace(/uC([0-4])/g, 'C$1').replace(A3, ' c=mix(c,(C0+C1*2.+C2)*.25,clamp(uBlur*1.6,0.,.8));\n gl_FragColor=vec4(clamp(c,0.,1.)*a,a)*uAlpha;');
  return head + wipe + body;
}

const VS_DOT = `attribute vec2 a;attribute vec4 iA;attribute vec3 iC0,iC1,iC2;attribute vec3 iB;
uniform vec2 uRes;varying vec2 vUv;varying vec3 c0,c1,c2;varying vec3 vB;varying float vBlur,vR;
void main(){
 float ext=1.+iA.w*1.4+2./max(1.,iA.z);
 vec2 p=iA.xy+a*iA.z*ext;
 vUv=a*ext;c0=iC0;c1=iC1;c2=iC2;vB=iB;vBlur=iA.w;vR=iA.z;
 gl_Position=vec4(p.x/uRes.x*2.-1.,1.-p.y/uRes.y*2.,0.,1.);
}`;
const FS_DOT = `precision mediump float;
varying vec2 vUv;varying vec3 c0,c1,c2;varying vec3 vB;varying float vBlur,vR;uniform float uT;
void main(){
 float d=length(vUv);
 float w=vBlur*1.3+1.6/max(1.,vR);
 float sd=vB.y*6.283;
 vec3 c;float a;
 if(vB.z<.5){
  a=1.-smoothstep(1.-w*.5,1.+w*.5,d);
  vec2 dir=vec2(cos(sd),sin(sd));
  float g=clamp(dot(vUv,dir)*.5+.5+.14*sin(vUv.y*3.+sd*3.+uT*.7),0.,1.);
  c=mix(c0,c1,smoothstep(0.,1.,g));
  vec2 o=vec2(cos(uT*.4+sd*2.),sin(uT*.33+sd))*.38;
  c=mix(c,c2,exp(-dot(vUv-o,vUv-o)*4.)*.8);
  c=mix(c,(c0+c1+c2)/3.,clamp(vBlur,0.,1.)*.6);
  a*=mix(1.,.78+.22*smoothstep(.5,.97,d),clamp(vBlur*1.5,0.,1.));
 } else {
  float lw=1.4/max(1.,vR)+vBlur*.4;
  a=1.-smoothstep(0.,lw,abs(d-1.));
  c=mix(c0,c1,.5+.5*sin(atan(vUv.y,vUv.x)*2.+uT));
 }
 a=clamp(a,0.,1.)*vB.x;
 gl_FragColor=vec4(c*a,a);
}`;

const RICH_U = ['uSize', 'uTime', 'uAmp', 'uPat', 'uTwist', 'uK', 'uWarp', 'uN', 'uC0', 'uC1', 'uC2', 'uC3', 'uC4', 'uSeed', 'uScale', 'uStir', 'uTurb', 'uOff', 'uFlow',
  'uA1', 'uA2', 'uB1', 'uB2', 'uRect', 'uBlur', 'uAlpha', 'uWipe', 'uWipeDir', 'uD0', 'uD1', 'uD2', 'uD3', 'uD4'] as const;
const STRIDE = 16;   // floats per dot instance: iA 4, iC0 3, iC1 3, iC2 3, iB 3 (alpha, seed, mode)
const ZERO4 = new Float32Array(4);

interface Inst { drawArraysInstanced(m: number, f: number, c: number, n: number): void; vertexAttribDivisor(i: number, d: number): void }

export class Stage {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext | null = null;
  private ctx2: CanvasRenderingContext2D | null = null;
  private inst: Inst | null = null;
  private rp: WebGLProgram | null = null; private ru: Record<string, WebGLUniformLocation | null> = {};
  private dp: WebGLProgram | null = null; private du: Record<string, WebGLUniformLocation | null> = {};
  private bp: WebGLProgram | null = null; private bu: Record<string, WebGLUniformLocation | null> = {};
  private quad: WebGLBuffer | null = null; private ibuf: WebGLBuffer | null = null; private idata = new Float32Array(STRIDE * 256);
  private dloc: Record<string, number> = {}; private rloc = 0; private bloc = 0;
  dpr = 1; w = 0; h = 0;
  lost = false;
  readonly kind: 'webgl2' | 'webgl' | '2d';

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'tu-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    let kind: Stage['kind'] = '2d';
    try {
      const opt: WebGLContextAttributes = { premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' };
      const g2 = this.canvas.getContext('webgl2', opt) as WebGL2RenderingContext | null;
      if (g2) { this.gl = g2; this.inst = { drawArraysInstanced: (m, f, c, n) => g2.drawArraysInstanced(m, f, c, n), vertexAttribDivisor: (i, d) => g2.vertexAttribDivisor(i, d) }; kind = 'webgl2'; }
      else {
        const g1 = this.canvas.getContext('webgl', opt) as WebGLRenderingContext | null;
        const ext = g1?.getExtension('ANGLE_instanced_arrays');
        if (g1 && ext) { this.gl = g1; this.inst = { drawArraysInstanced: (m, f, c, n) => ext.drawArraysInstancedANGLE(m, f, c, n), vertexAttribDivisor: (i, d) => ext.vertexAttribDivisorANGLE(i, d) }; kind = 'webgl'; }
      }
      if (this.gl) this.setup();
    } catch (e) { console.warn('tour: WebGL off', (e as Error).message); this.gl = null; kind = '2d'; }
    if (!this.gl) { kind = '2d'; this.ctx2 = this.canvas.getContext('2d'); }
    this.kind = kind;
    this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
  }

  /** the three programs are built in the background (ui/glprog.ts: no main-thread freeze); nothing is drawn until then */
  ready = false;
  private setup(): void {
    const gl = this.gl!;
    const jobs = [buildProgram(gl, VS_RICH, richFS(), 'tour rich'), buildProgram(gl, VS_DOT, FS_DOT, 'tour dots'), buildProgram(gl, VS_FULL, FS_BG, 'tour bg')];
    void Promise.all(jobs.map((j) => j.done)).then((oks) => {
      if (!oks.every(Boolean) || gl.isContextLost()) { this.lost = true; return; }
      this.link(jobs[0].prog, jobs[1].prog, jobs[2].prog);
      this.ready = true;
    });
  }
  private link(rp: WebGLProgram, dp: WebGLProgram, bp: WebGLProgram): void {
    const gl = this.gl!;
    this.rp = rp;
    for (const n of RICH_U) this.ru[n] = gl.getUniformLocation(this.rp, n);
    this.rloc = gl.getAttribLocation(this.rp, 'a');
    this.dp = dp;
    for (const n of ['uRes', 'uT']) this.du[n] = gl.getUniformLocation(this.dp, n);
    for (const n of ['a', 'iA', 'iC0', 'iC1', 'iC2', 'iB']) this.dloc[n] = gl.getAttribLocation(this.dp, n);
    this.bp = bp;
    for (const n of ['uRes', 'uTop', 'uBot', 'uGlow', 'uGlow2', 'uG', 'uG2', 'uT', 'uGrain', 'uFade']) this.bu[n] = gl.getUniformLocation(this.bp, n);
    this.bloc = gl.getAttribLocation(this.bp, 'a');
    this.quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.ibuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.ibuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.idata.byteLength, gl.DYNAMIC_DRAW);
    gl.disable(gl.DEPTH_TEST);
  }

  /** Match the backing store to the css box. The SAME dpr is used on both axes (never a separate x / y scale), so a
      circle in css px stays a circle in device px; DPR is capped (1.5 on small screens) for 60 fps on phones. */
  resize(w: number, h: number): void {
    const cap = Math.min(w, h) < 600 ? 1.5 : 1.75;
    const dpr = Math.min(cap, window.devicePixelRatio || 1);
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w; this.h = h; this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(w * dpr)); this.canvas.height = Math.max(1, Math.round(h * dpr));
  }

  /** bg null = a transparent layer (orbs only, drawn over DOM content) */
  draw(bg: Bg | null, rich: Rich[], dots: Dot[], T: number, front: Dot[] = []): void {
    if (this.ctx2) return this.draw2d(bg, rich, dots.concat(front));
    const gl = this.gl; if (!gl || this.lost || !this.ready || gl.isContextLost()) return;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    if (bg) this.drawBg(bg, T);
    else { gl.disable(gl.BLEND); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.drawDots(dots, T);
    for (const b of rich.slice().sort((a, c) => (a.z ?? 0) - (c.z ?? 0))) this.drawRich(b, T);
    if (front.length) this.drawDots(front, T);
  }

  private drawBg(bg: Bg, T: number): void {
    const gl = this.gl!, u = this.bu, k = this.dpr;
    gl.disable(gl.BLEND);
    gl.useProgram(this.bp);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(this.bloc); gl.vertexAttribPointer(this.bloc, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(u.uRes, this.canvas.width, this.canvas.height);
    gl.uniform3fv(u.uTop, bg.top); gl.uniform3fv(u.uBot, bg.bot); gl.uniform3fv(u.uGlow, bg.glow); gl.uniform3fv(u.uGlow2, bg.glow2);
    gl.uniform3f(u.uG, bg.g[0] * k, bg.g[1] * k, bg.g[2] * k); gl.uniform3f(u.uG2, bg.g2[0] * k, bg.g2[1] * k, bg.g2[2] * k);
    gl.uniform1f(u.uT, T); gl.uniform1f(u.uGrain, 0.028); gl.uniform1f(u.uFade, bg.fade ?? 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private drawDots(dots: Dot[], T: number): void {
    const gl = this.gl!, I = this.inst!, L = this.dloc;
    if (!dots.length) return;
    const n = dots.length;
    if (this.idata.length < n * STRIDE) { this.idata = new Float32Array(STRIDE * Math.ceil(n * 1.5)); gl.bindBuffer(gl.ARRAY_BUFFER, this.ibuf); gl.bufferData(gl.ARRAY_BUFFER, this.idata.byteLength, gl.DYNAMIC_DRAW); }
    const d = this.idata, k = this.dpr;
    for (let i = 0; i < n; i++) {
      const o = dots[i], j = i * STRIDE;
      d[j] = o.x * k; d[j + 1] = o.y * k; d[j + 2] = Math.max(0.5, o.r * k); d[j + 3] = o.blur ?? 0;
      d[j + 4] = o.c0[0]; d[j + 5] = o.c0[1]; d[j + 6] = o.c0[2];
      d[j + 7] = o.c1[0]; d[j + 8] = o.c1[1]; d[j + 9] = o.c1[2];
      d[j + 10] = o.c2[0]; d[j + 11] = o.c2[1]; d[j + 12] = o.c2[2];
      d[j + 13] = o.alpha ?? 1; d[j + 14] = o.seed ?? 0; d[j + 15] = o.mode ?? 0;
    }
    gl.useProgram(this.dp);
    gl.uniform2f(this.du.uRes, this.canvas.width, this.canvas.height); gl.uniform1f(this.du.uT, T);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(L.a); gl.vertexAttribPointer(L.a, 2, gl.FLOAT, false, 0, 0); I.vertexAttribDivisor(L.a, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ibuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, d.subarray(0, n * STRIDE));
    const B = STRIDE * 4;
    const attr = (name: string, size: number, off: number) => { const l = L[name]; if (l < 0) return; gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, size, gl.FLOAT, false, B, off * 4); I.vertexAttribDivisor(l, 1); };
    attr('iA', 4, 0); attr('iC0', 3, 4); attr('iC1', 3, 7); attr('iC2', 3, 10); attr('iB', 3, 13);   // iB = alpha, seed, mode
    I.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
    for (const name of ['iA', 'iC0', 'iC1', 'iC2', 'iB']) { const x = L[name]; if (x >= 0) { I.vertexAttribDivisor(x, 0); gl.disableVertexAttribArray(x); } }
  }

  private drawRich(b: Rich, T: number): void {
    const gl = this.gl!, u = this.ru, k = this.dpr;
    const alpha = b.alpha ?? 1;
    if (alpha <= 0.003 || b.r < 0.5) return;
    gl.useProgram(this.rp);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(this.rloc); gl.vertexAttribPointer(this.rloc, 2, gl.FLOAT, false, 0, 0);
    // the shader's silhouette radius is .88 of the quad's unit radius at scale 1: r / .88 maps "r" to the visible radius
    const S = ORB_JELLY_SCALE, W = this.canvas.width, H = this.canvas.height;
    const unit = (b.r / 0.88) * k;
    const half = unit * S;
    gl.uniform4f(u.uRect, (b.x * k) / W * 2 - 1, 1 - (b.y * k) / H * 2, half / W * 2, half / H * 2);
    gl.uniform1f(u.uScale, S);
    gl.uniform1f(u.uSize, Math.max(4, unit * 2));
    gl.uniform1f(u.uTime, b.time ?? (b.spec.t0 + T * 0.45 * (b.spec.speed ?? 1)));
    gl.uniform1f(u.uAmp, b.amp ?? 0);
    gl.uniform2f(u.uOff, 0, 0); gl.uniform2f(u.uFlow, 0, 0);
    gl.uniform1f(u.uStir, 0); gl.uniform1f(u.uTurb, 0);
    gl.uniform4fv(u.uA1, ZERO4); gl.uniform4fv(u.uA2, ZERO4); gl.uniform4fv(u.uB1, ZERO4); gl.uniform4fv(u.uB2, ZERO4);
    const s = b.spec, to = b.to || s;
    gl.uniform1f(u.uPat, s.pattern); gl.uniform1f(u.uTwist, s.twist);
    const sf = orbSoftness(s);
    gl.uniform1f(u.uK, sf.k); gl.uniform1f(u.uWarp, sf.warp);
    gl.uniform1f(u.uN, s.extra || to.extra ? 5 : 4);
    gl.uniform3fv(u.uC0, s.colors[0]); gl.uniform3fv(u.uC1, s.colors[1]); gl.uniform3fv(u.uC2, s.colors[2]); gl.uniform3fv(u.uC3, s.colors[3]); gl.uniform3fv(u.uC4, s.extra || s.colors[2]);
    gl.uniform3fv(u.uD0, to.colors[0]); gl.uniform3fv(u.uD1, to.colors[1]); gl.uniform3fv(u.uD2, to.colors[2]); gl.uniform3fv(u.uD3, to.colors[3]); gl.uniform3fv(u.uD4, to.extra || to.colors[2]);
    gl.uniform1f(u.uWipe, b.to ? (b.wipe ?? 0) : 0);
    gl.uniform2f(u.uWipeDir, (b.wipeDir || [1, 0])[0], (b.wipeDir || [1, 0])[1]);
    gl.uniform4fv(u.uSeed, s.seed);
    gl.uniform1f(u.uBlur, b.blur ?? 0); gl.uniform1f(u.uAlpha, alpha);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private draw2d(bg: Bg | null, rich: Rich[], dots: Dot[]): void {
    const c = this.ctx2!; if (!c) return;
    const k = this.dpr;
    const rgb = (x: Rgb, a = 1) => `rgba(${Math.round(x[0] * 255)},${Math.round(x[1] * 255)},${Math.round(x[2] * 255)},${a})`;
    c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    c.setTransform(k, 0, 0, k, 0, 0);
    if (bg) this.bg2d(c, bg, rgb);
    for (const d of dots) this.dot2d(c, d, rgb);
    for (const b of rich.slice().sort((p, q) => (p.z ?? 0) - (q.z ?? 0))) this.rich2d(c, b, rgb);
    c.globalAlpha = 1;
  }
  private bg2d(c: CanvasRenderingContext2D, bg: Bg, rgb: (x: Rgb, a?: number) => string): void {
    c.globalAlpha = bg.fade ?? 1;
    const lg = c.createLinearGradient(0, 0, 0, this.h);
    lg.addColorStop(0, rgb(bg.top)); lg.addColorStop(1, rgb(bg.bot));
    c.fillStyle = lg; c.fillRect(0, 0, this.w, this.h);
    for (const [g, col, a] of [[bg.g, bg.glow, 0.6], [bg.g2, bg.glow2, 0.4]] as Array<[[number, number, number], Rgb, number]>) {
      const rg = c.createRadialGradient(g[0], g[1], 0, g[0], g[1], g[2] * 1.6);
      rg.addColorStop(0, rgb(col, a * (bg.fade ?? 1))); rg.addColorStop(1, rgb(col, 0));
      c.globalCompositeOperation = 'lighter'; c.fillStyle = rg; c.fillRect(0, 0, this.w, this.h); c.globalCompositeOperation = 'source-over';
    }
    c.globalAlpha = 1;
  }
  private dot2d(c: CanvasRenderingContext2D, d: Dot, rgb: (x: Rgb, a?: number) => string): void {
    const a = d.alpha ?? 1; if (a <= 0.01) return;
    c.globalAlpha = a;
    if (d.mode) { c.strokeStyle = rgb(d.c0); c.lineWidth = 1.5; c.beginPath(); c.arc(d.x, d.y, d.r, 0, Math.PI * 2); c.stroke(); return; }
    const R = d.r * (1 + (d.blur ?? 0) * 0.5), soft = Math.min(0.9, 0.04 + (d.blur ?? 0) * 0.6);
    const g = c.createRadialGradient(d.x - d.r * 0.3, d.y - d.r * 0.3, 0, d.x, d.y, R);
    g.addColorStop(0, rgb(d.c1)); g.addColorStop(Math.max(0.05, 1 - soft), rgb(d.c0)); g.addColorStop(1, rgb(d.c0, 0));
    c.fillStyle = g; c.beginPath(); c.arc(d.x, d.y, R, 0, Math.PI * 2); c.fill();
  }
  private rich2d(c: CanvasRenderingContext2D, b: Rich, rgb: (x: Rgb, a?: number) => string): void {
    const a = b.alpha ?? 1; if (a <= 0.01) return;
    const s = b.to && (b.wipe ?? 0) > 0.5 ? b.to : b.spec;
    const R = b.r * (1 + (b.amp ?? 0) * 0.03) * (1 + (b.blur ?? 0) * 0.4), soft = Math.min(0.9, 0.03 + (b.blur ?? 0) * 0.5);
    c.globalAlpha = a;
    const g = c.createRadialGradient(b.x - R * 0.35, b.y - R * 0.35, R * 0.1, b.x, b.y, R);
    g.addColorStop(0, rgb(s.colors[3])); g.addColorStop(0.45, rgb(s.colors[1])); g.addColorStop(Math.max(0.5, 1 - soft), rgb(s.colors[0])); g.addColorStop(1, rgb(s.colors[0], 0));
    c.fillStyle = g; c.beginPath(); c.arc(b.x, b.y, R, 0, Math.PI * 2); c.fill();
  }

  /** Test hook: draw each ball ALONE (largest first, up to `max`), read the pixels back and measure the width / height of
      the region whose alpha is >= half the ball's peak alpha. A round ball gives ratio ~1. Leaves the canvas cleared;
      the caller re-renders the frame afterwards. */
  probe(rich: Rich[], dots: Dot[], T: number, max = 40): Probe[] {
    const out: Probe[] = [];
    const k = this.dpr, CW = this.canvas.width, CH = this.canvas.height;
    const items: Array<{ kind: 'rich' | 'dot'; id: string; x: number; y: number; r: number; draw: () => void }> = [];
    const WH: Rgb = [1, 1, 1];
    for (const b0 of rich) if ((b0.alpha ?? 1) > 0.05) { const b: Rich = { ...b0, spec: { ...b0.spec, colors: [WH, WH, WH, WH], extra: undefined }, to: null }; items.push({ kind: 'rich', id: b.id, x: b.x, y: b.y, r: b.r * (1 + (b.blur ?? 0) * 0.6), draw: () => (this.ctx2 ? this.rich2d(this.ctx2, b, rgbS) : this.drawRich(b, T)) }); }
    const ds = dots.filter((d) => !d.mode && (d.alpha ?? 1) > 0.05).sort((p, q) => q.r - p.r);
    ds.slice(0, max).forEach((d, i) => items.push({ kind: 'dot', id: 'dot' + i, x: d.x, y: d.y, r: d.r * (1 + (d.blur ?? 0) * 1.5 + 2 / Math.max(1, d.r * k)), draw: () => (this.ctx2 ? this.dot2d(this.ctx2, d, rgbS) : this.drawDots([{ ...d, c0: WH, c1: WH, c2: WH }], T)) }));
    const gl = this.gl;
    for (const it of items) {
      const pad = it.r * 1.3 * k + 4;
      const x0 = Math.floor(it.x * k - pad), y0 = Math.floor(it.y * k - pad), x1 = Math.ceil(it.x * k + pad), y1 = Math.ceil(it.y * k + pad);
      if (x0 < 0 || y0 < 0 || x1 > CW || y1 > CH) { out.push({ kind: it.kind, id: it.id, r: it.r, w: 0, h: 0, ratio: 0, skipped: 'edge' }); continue; }
      const w = x1 - x0, hh = y1 - y0;
      const A = new Float32Array(w * hh);
      if (gl) {
        gl.viewport(0, 0, CW, CH); gl.disable(gl.BLEND); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        it.draw();
        // the balls are drawn white (premultiplied) on transparent black, so the red channel IS the coverage
        const px = new Uint8Array(w * hh * 4);
        gl.readPixels(x0, CH - y1, w, hh, gl.RGBA, gl.UNSIGNED_BYTE, px);
        for (let i = 0; i < w * hh; i++) A[i] = Math.max(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
      } else if (this.ctx2) {
        const c = this.ctx2; c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, CW, CH); c.setTransform(k, 0, 0, k, 0, 0);
        it.draw(); c.globalAlpha = 1;
        const px = c.getImageData(x0, y0, w, hh).data;
        for (let i = 0; i < w * hh; i++) A[i] = px[i * 4 + 3];
      }
      let peak = 0; for (const v of A) if (v > peak) peak = v;
      if (peak < 8) { out.push({ kind: it.kind, id: it.id, r: it.r, w: 0, h: 0, ratio: 0, skipped: 'faint' }); continue; }
      const th = peak * 0.5;   // the half-coverage contour (blurred balls have soft but symmetric edges)
      let minX = w, maxX = -1, minY = hh, maxY = -1;
      for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) if (A[y * w + x] >= th) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
      const bw = maxX - minX + 1, bh = maxY - minY + 1;
      // sub-pixel elongation from the coverage-weighted second moments: sqrt(l1 / l2) of the covariance (1 = a circle)
      let m = 0, mx = 0, my = 0;
      for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) { const v = A[y * w + x]; m += v; mx += v * x; my += v * y; }
      mx /= m; my /= m;
      let sxx = 0, syy = 0, sxy = 0;
      for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) { const v = A[y * w + x]; const dx = x - mx, dy = y - my; sxx += v * dx * dx; syy += v * dy * dy; sxy += v * dx * dy; }
      const tr = (sxx + syy) / m, det = (sxx * syy - sxy * sxy) / (m * m), dd = Math.sqrt(Math.max(0, tr * tr / 4 - det));
      const elong = Math.sqrt((tr / 2 + dd) / Math.max(1e-9, tr / 2 - dd));
      out.push({ kind: it.kind, id: it.id, r: +it.r.toFixed(1), w: bw, h: bh, ratio: +(bw / bh).toFixed(4), elong: +elong.toFixed(4) });
    }
    return out;
  }
}
const rgbS = (x: Rgb, a = 1) => `rgba(${Math.round(x[0] * 255)},${Math.round(x[1] * 255)},${Math.round(x[2] * 255)},${a})`;
