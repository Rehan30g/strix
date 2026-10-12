/* "Magic orb": the visual identity of every voice and persona.
   - spec: deterministic from an id/name (hash -> PRNG -> OKLCH palette + pattern + seeds). Same input = same orb, always.
   - flat 2D look (no specular highlight / sphere shading), by request.
   - static: rendered once per (spec, pixel size) with the shared WebGL engine, cached as a data: URL image.
   - live: the same shader animated (domain-warped fluid, morphing silhouette) reacting to an amplitude source.
   One hidden WebGL canvas renders every orb and the result is copied into small 2D canvases, so there is no
   WebGL context limit. Live orbs pause when off screen, when the tab is hidden, and fall back to the still image
   under prefers-reduced-motion. Canvas 2D fallback when WebGL is unavailable. */
import { h } from './dom';

export type Rgb = [number, number, number];
export interface OrbSpec {
  key: string;
  colors: [Rgb, Rgb, Rgb, Rgb];     // deep, main, second, highlight (sRGB 0..1)
  seed: [number, number, number, number];
  pattern: number;                  // 0 mesh, 1 aurora, 2 swirl, 3 marble, 4 cell
  twist: number;
  t0: number;                       // phase of the still frame / start of the animation
  extra?: Rgb;                      // 5th colour (custom orbs with 5 colours)
  speed?: number;                   // animation speed multiplier (default 1)
  soft?: number;                    // 0 crisp .. 1 very soft (default .5 = the classic look)
  shape?: number;                   // silhouette: 0 round (default), 1 soft wobble, 2 blob, 3 drop
}

/* ---------------- custom orbs (Studio Bola) ---------------- */
export const ORB_STYLES = ['aurora', 'swirl', 'mesh', 'cell', 'marble'] as const;
export type OrbStyle = typeof ORB_STYLES[number];
const STYLE_PAT: Record<OrbStyle, number> = { mesh: 0, aurora: 1, swirl: 2, marble: 3, cell: 4 };
const PAT_STYLE: OrbStyle[] = ['mesh', 'aurora', 'swirl', 'marble', 'cell'];
export const ORB_SHAPES = ['round', 'soft', 'blob', 'drop'] as const;
export type OrbShape = typeof ORB_SHAPES[number];
/** A user-made orb: 2-5 colours (#rrggbb), a style, speed and smoothness, optional silhouette. Stored in settings. */
export interface CustomOrb { colors: string[]; style: OrbStyle; speed: number; soft: number; shape?: OrbShape }

const HEX = /^#[0-9a-f]{6}$/i;
/** Validate / clamp a stored custom orb (settings are user data). Returns null when unusable. */
export function cleanOrb(o: unknown): CustomOrb | null {
  if (!o || typeof o !== 'object') return null;
  const x = o as Record<string, unknown>;
  const colors = (Array.isArray(x.colors) ? x.colors : []).filter((c): c is string => typeof c === 'string' && HEX.test(c)).slice(0, 5).map((c) => c.toLowerCase());
  if (colors.length < 2) return null;
  const style = (ORB_STYLES as readonly string[]).includes(String(x.style)) ? (x.style as OrbStyle) : 'aurora';
  const num = (v: unknown, lo: number, hi: number, d: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const shape = (ORB_SHAPES as readonly string[]).includes(String(x.shape)) ? (x.shape as OrbShape) : undefined;
  return { colors, style, speed: num(x.speed, 0.2, 2.5, 1), soft: num(x.soft, 0, 1, 0.5), ...(shape && shape !== 'round' ? { shape } : {}) };
}
export const hexToRgb = (h: string): Rgb => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
export const rgbToHex = (c: Rgb) => '#' + c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** OrbSpec of a custom orb. `seedKey` keeps the motion seeds stable for the same voice / persona. */
export function customOrb(c: CustomOrb, seedKey = ''): OrbSpec {
  const shp = c.shape ? ORB_SHAPES.indexOf(c.shape) : 0;
  const key = 'c:' + seedKey + ':' + c.colors.join(',') + ':' + c.style + ':' + c.speed.toFixed(2) + ':' + c.soft.toFixed(2) + (shp > 0 ? ':s' + shp : '');
  let s = specCache.get(key);
  if (s) return s;
  const r = rng(hash32('seed:' + seedKey));
  const k = c.colors.map(hexToRgb);
  const n = k.length;
  const colors: OrbSpec['colors'] = n === 2
    ? [k[0], k[1], mixRgb(k[0], k[1], 0.5), mixRgb(k[0], k[1], 0.78)]
    : n === 3 ? [k[0], k[1], k[2], mixRgb(k[1], k[2], 0.5)]
      : [k[0], k[1], k[2], k[3]];
  s = { key, colors, seed: [r(), r(), r(), r()], pattern: STYLE_PAT[c.style], twist: 1.4 + r() * 2.2, t0: r() * 40, extra: n >= 5 ? k[4] : undefined, speed: c.speed, soft: c.soft, ...(shp > 0 ? { shape: shp } : {}) };
  specCache.set(key, s);
  return s;
}
/** The editable description of any spec (used to open the Studio on a deterministic orb). */
export function specToCustom(s: OrbSpec): CustomOrb {
  return { colors: [s.colors[0], s.colors[1], s.colors[2], s.colors[3], ...(s.extra ? [s.extra] : [])].map(rgbToHex), style: PAT_STYLE[s.pattern] || 'aurora', speed: s.speed ?? 1, soft: s.soft ?? 0.5, ...(s.shape ? { shape: ORB_SHAPES[s.shape] } : {}) };
}

/* custom orbs of voices (settings key "orbs", wired by lib/orbs.ts) */
let voiceCustom: Record<string, CustomOrb> = {};
const orbSubs = new Set<() => void>();
export function setVoiceOrbs(map: Record<string, unknown> | null | undefined): void {
  const next: Record<string, CustomOrb> = {};
  for (const [id, v] of Object.entries(map || {})) { const c = cleanOrb(v); if (c) next[id] = c; }
  voiceCustom = next;
  orbSubs.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
}
export const voiceCustomOrb = (voiceId: string): CustomOrb | null => voiceCustom[voiceId] || null;
/** Called when any voice's custom orb changes. */
export function onOrbsChange(fn: () => void): () => void { orbSubs.add(fn); return () => { orbSubs.delete(fn); }; }

/** A harmonious random palette (2-5 colours) for the "Acak" button. */
export function randomPalette(n = 3 + Math.floor(Math.random() * 3)): string[] {
  const hue = Math.random() * 360, sch = SCHEMES[Math.floor(Math.random() * SCHEMES.length)];
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(rgbToHex(col(0.42 + (i / Math.max(1, n - 1)) * 0.42, 0.13 + Math.random() * 0.07, hue + sch[i % 4] + (i >= 4 ? 90 : 0))));
  return out;
}

/* ---------------- deterministic spec ---------------- */
function hash32(s: string): number {
  let h1 = 0xdeadbeef ^ s.length, h2 = 0x41c6ce57 ^ s.length;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  return h1 >>> 0;
}
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function oklchToRgb(L: number, C: number, hDeg: number): Rgb | null {
  const hr = (hDeg * Math.PI) / 180, a = C * Math.cos(hr), b = C * Math.sin(hr);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b, m_ = L - 0.1055613458 * a - 0.0638541728 * b, s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  const out = lin.map((c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
  return out.every((c) => c >= -0.001 && c <= 1.001) ? (out.map((c) => Math.min(1, Math.max(0, c))) as Rgb) : null;
}
/** OKLCH -> sRGB, reducing chroma until it fits the gamut. */
function col(L: number, C: number, hue: number): Rgb {
  hue = ((hue % 360) + 360) % 360;
  if (hue > 55 && hue < 125) L = Math.max(L, 0.74);     // dark yellows turn olive / muddy
  for (let c = C; c >= 0; c -= 0.01) { const r = oklchToRgb(L, c, hue); if (r) return r; }
  return [L, L, L];
}

// hue offsets for [deep, main, second, highlight] (harmonious schemes)
const SCHEMES: Array<[number, number, number, number]> = [
  [-28, 0, 38, 62],      // analogous
  [-16, 0, 152, 176],    // split complementary
  [0, 118, 238, 60],     // soft triad
  [-12, 0, 22, 8],       // monochrome
  [180, 0, 32, -34],     // complementary depth
  [-40, 0, 80, 120],     // wide analogous
];

function build(r: () => number, hue: number, scheme: number, pattern: number, key: string): OrbSpec {
  const off = SCHEMES[scheme % SCHEMES.length];
  const cMain = 0.14 + r() * 0.07;
  const colors: OrbSpec['colors'] = [
    col(0.36 + r() * 0.12, cMain * 0.85, hue + off[0]),
    col(0.6 + r() * 0.1, cMain, hue + off[1]),
    col(0.7 + r() * 0.1, cMain * (0.75 + r() * 0.3), hue + off[2]),
    col(0.9 + r() * 0.06, 0.05 + r() * 0.05, hue + off[3]),
  ];
  return { key, colors, seed: [r(), r(), r(), r()], pattern, twist: 1 + r() * 2.6, t0: r() * 40 };
}

const specCache = new Map<string, OrbSpec>();
/** Orb of a voice: the user's custom orb for it, else deterministic from the voice id. */
export function voiceOrb(voiceId: string): OrbSpec {
  const c = voiceCustom[voiceId];
  if (c) return customOrb(c, 'v:' + voiceId);
  return defaultVoiceOrb(voiceId);
}
/** The deterministic orb of a voice (ignores customisation). */
export function defaultVoiceOrb(voiceId: string): OrbSpec {
  const key = 'v:' + (voiceId || 'none');
  let s = specCache.get(key);
  if (!s) {
    const r = rng(hash32(key));
    const hue = r() * 360, scheme = Math.floor(r() * SCHEMES.length), pattern = Math.floor(r() * 4);
    s = build(r, hue, scheme, pattern, key);
    specCache.set(key, s);
  }
  return s;
}
/** Orb of a persona: its own custom orb; else the voice's custom orb; else the voice's hue family + scheme,
    varied by the persona name (deterministic). */
export function personaOrb(voiceId: string, name: string, custom?: CustomOrb | null): OrbSpec {
  const own = custom ? cleanOrb(custom) : null;
  if (own) return customOrb(own, 'p:' + name.trim().toLowerCase());
  const vc = voiceCustom[voiceId];
  if (vc) return customOrb(vc, 'v:' + voiceId);
  return defaultPersonaOrb(voiceId, name);
}
export function defaultPersonaOrb(voiceId: string, name: string): OrbSpec {
  const key = 'p:' + (voiceId || 'none') + ':' + name.trim().toLowerCase();
  let s = specCache.get(key);
  if (!s) {
    const rv = rng(hash32('v:' + (voiceId || 'none')));
    const baseHue = rv() * 360, scheme = Math.floor(rv() * SCHEMES.length);
    const rn = rng(hash32('n:' + name.trim().toLowerCase()));
    const hue = baseHue + (rn() - 0.5) * 70;
    s = build(rn, hue, scheme, Math.floor(rn() * 4), key);
    specCache.set(key, s);
  }
  return s;
}

const css = (c: Rgb) => `rgb(${Math.round(c[0] * 255)} ${Math.round(c[1] * 255)} ${Math.round(c[2] * 255)})`;

/* ---------------- WebGL engine ---------------- */
const VS = `attribute vec2 a;varying vec2 v;void main(){v=a*.5+.5;gl_Position=vec4(a,0.,1.);}`;
const FS = `precision highp float;
varying vec2 v;
uniform float uSize,uTime,uAmp,uPat,uTwist,uK,uWarp,uN;
uniform vec3 uC0,uC1,uC2,uC3,uC4;
uniform vec4 uSeed;
uniform float uScale,uStir,uTurb;
uniform vec2 uOff,uFlow;
uniform vec4 uA1,uA2,uB1,uB2;
float sm(float a,float b,float x){float m=(a+b)*.5,w=max(.01,(b-a)*.5*uK);return smoothstep(m-w,m+w,x);}
float hs(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float ns(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.-2.*f);
 return mix(mix(hs(i),hs(i+vec2(1.,0.)),u.x),mix(hs(i+vec2(0.,1.)),hs(i+vec2(1.,1.)),u.x),u.y);}
float fbm(vec2 p){float s=0.,a=.5;mat2 m=mat2(1.6,1.2,-1.2,1.6);for(int i=0;i<4;i++){s+=a*ns(p);p=m*p;a*=.5;}return s;}
mat2 rot(float a){float c=cos(a),s=sin(a);return mat2(c,-s,s,c);}
void main(){
 vec2 p=(v*2.-1.)*uScale-uOff;
 float t=uTime;
 float ang=atan(p.y,p.x);
 vec2 cd=vec2(cos(ang),sin(ang));
 float wob=(ns(cd*1.3+uSeed.xy*20.+vec2(t*.4,-t*.33))-.5)*(.03+uAmp*.11)+sin(ang*3.+t*1.1+uSeed.y*6.283)*(.006+uAmp*.03);
 vec4 k1=vec4(1.,2.,3.,4.)*ang,k2=vec4(5.,6.,7.,8.)*ang;
 float jel=dot(uA1,cos(k1))+dot(uB1,sin(k1))+dot(uA2,cos(k2))+dot(uB2,sin(k2));
 float R=.88+wob+uAmp*.025+max(-.5,jel);
 float r=length(p);
 float a=smoothstep(0.,2.6/uSize,R-r);
 if(a<=0.){gl_FragColor=vec4(0.);return;}
 vec2 q=p/R;
 q-=uFlow*(1.-.45*dot(q,q));
 q=rot(uStir*exp(-dot(q,q)*1.4))*q;
 vec2 ctr=(uSeed.xy-.5)*.9;
 vec2 s=q*.95;
 float sw=uTwist*(uPat>1.5&&uPat<2.5?.5:.16)*exp(-length(q-ctr)*1.5);
 s=rot(sw+t*.05)*(s-ctr)+ctr+uSeed.zw*7.;
 if(uTurb>.001)s+=uTurb*(vec2(ns(s*1.8+vec2(t*1.3,0.)),ns(s*1.8+vec2(4.1,7.3)-t*1.1))-.5)*1.5;
 float wp=uWarp*(1.+uTurb*.7);
 vec2 w1=vec2(fbm(s+vec2(0.,t*.12)),fbm(s+vec2(5.2,1.3)-t*.1));
 vec2 w2=vec2(fbm(s+wp*w1+vec2(1.7,9.2)+t*.08),fbm(s+wp*w1+vec2(8.3,2.8)-t*.07));
 float f=fbm(s+2.*w2);
 float an=uSeed.x*6.283;
 float g=dot(q,vec2(cos(an),sin(an)))*.5+.5;
 vec3 c=mix(uC0,uC1,smoothstep(0.,1.,g+(f-.5)*.9));
 if(uPat<.5){
  vec2 k1=vec2(cos(t*.21+uSeed.x*6.),sin(t*.17+uSeed.y*6.))*.5,k2=vec2(cos(t*.19+3.+uSeed.z*6.),sin(t*.23+1.))*.5,k3=vec2(sin(t*.15+uSeed.w*6.),cos(t*.2+2.))*.45;
  vec2 qq=q+(w1-.5)*.45;
  float sk=3./max(.35,uK);
  float d1=exp(-dot(qq-k1,qq-k1)*sk),d2=exp(-dot(qq-k2,qq-k2)*sk),d3=exp(-dot(qq-k3,qq-k3)*sk*1.33);
  c=mix(c,uC1,d1*.8); c=mix(c,uC2,d2*.85); c=mix(c,uC3,d3*.7);
  if(uN>4.5){vec2 k4=vec2(cos(t*.13+5.+uSeed.y*6.),sin(t*.18+4.))*.5;float d4=exp(-dot(qq-k4,qq-k4)*sk*1.2);c=mix(c,uC4,d4*.75);}
 } else if(uPat<1.5){
  float b=sm(.15,.85,sin((q.y*1.3+(w2.x-.5)*2.2)*2.6+t*.3+uSeed.y*6.)*.5+.5);
  float b2=sm(.3,.95,sin((q.y*.9-(w1.y-.5)*1.8)*3.8-t*.24)*.5+.5);
  c=mix(c,uC2,b*.7);
  c=mix(c,uC3,b*b2*.65);
  if(uN>4.5){float b3=sm(.45,.95,sin((q.x*1.1+(w2.y-.5)*2.)*3.1+t*.21)*.5+.5);c=mix(c,uC4,b3*(1.-b)*.6);}
 } else if(uPat<2.5){
  c=mix(c,uC2,sm(.38,.82,w2.y)*.8);
  c=mix(c,uC3,sm(.58,.9,f)*.6);
  if(uN>4.5)c=mix(c,uC4,sm(.55,.85,w2.x)*(1.-sm(.38,.82,w2.y))*.7);
 } else if(uPat<3.5){
  float m=sin(f*5.+w1.x*2.5+t*.15)*.5+.5;
  c=mix(c,uC2,sm(.3,.9,m)*.65);
  c=mix(c,uC3,sm(.78,1.,m)*.55);
  if(uN>4.5)c=mix(c,uC4,sm(0.,.25,1.-m)*.5);
 } else {
  vec2 gp=q*2.1+(w1-.5)*.9;
  vec2 ip=floor(gp),fp=fract(gp);
  float e1=8.,e2=8.,cid=0.;
  for(int j=-1;j<=1;j++)for(int i=-1;i<=1;i++){
   vec2 o=vec2(float(i),float(j));
   vec2 rr=vec2(hs(ip+o+uSeed.xy*9.),hs(ip+o+uSeed.zw*9.+7.3));
   rr=.5+.38*sin(t*.35+6.283*rr);
   float d=length(o+rr-fp);
   if(d<e1){e2=e1;e1=d;cid=hs(ip+o+3.1+uSeed.x);}else if(d<e2){e2=d;}
  }
  float nc=uN>4.5?4.:3.;
  float ci=floor(cid*nc);
  vec3 cc=ci<.5?uC1:ci<1.5?uC2:ci<2.5?uC3:uC4;
  float edge=smoothstep(0.,.05+.3*uK,e2-e1);
  c=mix(mix(uC0,c,.35),cc,edge*.92);
 }
 c+=(hs(gl_FragCoord.xy+floor(t*24.))-.5)*.03;
 c*=1.+uAmp*.12;
 gl_FragColor=vec4(clamp(c,0.,1.)*a,a);
}`;

interface GL { gl: WebGLRenderingContext; canvas: HTMLCanvasElement; u: Record<string, WebGLUniformLocation | null> }
let glState: GL | null | undefined;
function engine(): GL | null {
  if (glState !== undefined) return glState;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: false }) as WebGLRenderingContext | null;
    if (!gl) return (glState = null);
    const sh = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader'); return s; };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');
    gl.useProgram(prog);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const u: GL['u'] = {};
    for (const n of ['uSize', 'uTime', 'uAmp', 'uPat', 'uTwist', 'uK', 'uWarp', 'uN', 'uC0', 'uC1', 'uC2', 'uC3', 'uC4', 'uSeed',
      'uScale', 'uStir', 'uTurb', 'uOff', 'uFlow', 'uA1', 'uA2', 'uB1', 'uB2']) u[n] = gl.getUniformLocation(prog, n);
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); glState = null; });
    return (glState = { gl, canvas, u });
  } catch (e) { console.warn('orb: WebGL tidak tersedia', (e as Error).message); return (glState = null); }
}

const ZERO4 = new Float32Array(4);
/** Silhouette of a shaped orb as Fourier harmonics of the radius (same slots as the jelly body; added to it).
    round = none; soft = a slow gentle 3-lobe breathing; blob = a goofy wobble; drop = tapered towards the top. */
const SH = { A: new Float32Array(8), B: new Float32Array(8) };
export function shapeHarmonics(shape: number | undefined, t: number): { A: Float32Array; B: Float32Array } | null {
  if (!shape) return null;
  SH.A.fill(0); SH.B.fill(0);
  if (shape === 1) { SH.A[2] = 0.022 * Math.sin(t * 0.7); SH.B[2] = 0.022 * Math.cos(t * 0.6); SH.A[3] = 0.012 * Math.sin(t * 0.9 + 1); }
  else if (shape === 2) { SH.A[1] = 0.04 * Math.sin(t * 0.8); SH.B[1] = 0.035 * Math.cos(t * 0.7 + 0.5); SH.A[2] = 0.03 * Math.cos(t * 1.1); SH.B[3] = 0.022 * Math.sin(t * 1.3 + 2); }
  else if (shape === 3) { SH.B[0] = -0.045; SH.A[1] = -0.03; SH.B[2] = 0.012 * Math.sin(t * 0.8); }   // y up: sin(1*a) < 0 shrinks the top half
  return SH;
}
/** Draw one orb frame into `ctx` (size px). With `j` (jelly orbs) the canvas is JELLY_SCALE times the orb and the
    shape / content are deformed by the soft-body state. */
function paint(ctx: CanvasRenderingContext2D, spec: OrbSpec, px: number, time: number, amp: number, j?: Soft | null): void {
  const E = engine();
  ctx.clearRect(0, 0, px, px);
  if (!E) return paint2d(ctx, spec, px, time, amp, j);
  const { gl, canvas, u } = E;
  if (canvas.width < px) { canvas.width = canvas.height = Math.min(1024, Math.max(px, canvas.width * 2)); }
  gl.viewport(0, 0, px, px);
  const sc = j ? JELLY_SCALE : 1;
  gl.uniform1f(u.uScale, sc);
  gl.uniform1f(u.uSize, px / sc); gl.uniform1f(u.uTime, time); gl.uniform1f(u.uAmp, amp);
  const on = !!j && j.awake;
  gl.uniform2f(u.uOff, on ? j!.cx : 0, on ? j!.cy : 0);
  gl.uniform2f(u.uFlow, on ? j!.flowX : 0, on ? j!.flowY : 0);
  gl.uniform1f(u.uStir, on ? j!.stir : 0); gl.uniform1f(u.uTurb, on ? Math.min(1.6, j!.turb) : 0);
  const shp = shapeHarmonics(spec.shape, time);
  if (shp) {
    const A = new Float32Array(8), B = new Float32Array(8);
    for (let i = 0; i < 8; i++) { A[i] = shp.A[i] + (on ? j!.A[i] : 0); B[i] = shp.B[i] + (on ? j!.B[i] : 0); }
    gl.uniform4fv(u.uA1, A.subarray(0, 4)); gl.uniform4fv(u.uA2, A.subarray(4, 8)); gl.uniform4fv(u.uB1, B.subarray(0, 4)); gl.uniform4fv(u.uB2, B.subarray(4, 8));
  } else {
    gl.uniform4fv(u.uA1, on ? j!.A.subarray(0, 4) : ZERO4); gl.uniform4fv(u.uA2, on ? j!.A.subarray(4, 8) : ZERO4);
    gl.uniform4fv(u.uB1, on ? j!.B.subarray(0, 4) : ZERO4); gl.uniform4fv(u.uB2, on ? j!.B.subarray(4, 8) : ZERO4);
  }
  gl.uniform1f(u.uPat, spec.pattern); gl.uniform1f(u.uTwist, spec.twist);
  const soft = spec.soft ?? 0.5;
  gl.uniform1f(u.uK, soft < 0.5 ? 0.18 + (soft / 0.5) * 0.82 : 1 + ((soft - 0.5) / 0.5) * 1.1);
  gl.uniform1f(u.uWarp, 2.2 * (1.45 - 0.9 * soft));
  gl.uniform1f(u.uN, spec.extra ? 5 : 4);
  gl.uniform3fv(u.uC0, spec.colors[0]); gl.uniform3fv(u.uC1, spec.colors[1]); gl.uniform3fv(u.uC2, spec.colors[2]); gl.uniform3fv(u.uC3, spec.colors[3]);
  gl.uniform3fv(u.uC4, spec.extra || spec.colors[2]);
  gl.uniform4fv(u.uSeed, spec.seed);
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  ctx.drawImage(canvas, 0, canvas.height - px, px, px, 0, 0, px, px);
}

/** Cheap 2D fallback: layered radial gradients that drift. */
function paint2d(ctx: CanvasRenderingContext2D, s: OrbSpec, px: number, t: number, amp: number, j?: Soft | null): void {
  const half = px / 2 / (j ? JELLY_SCALE : 1);
  const on = !!j && j.awake;
  const c = px / 2, R = half * 0.88 * (1 + amp * 0.03);
  ctx.save();
  ctx.beginPath();
  if (on) {
    const ox = c + j!.cx * half, oy = c - j!.cy * half;
    for (let k = 0; k <= 48; k++) {
      const a = (k / 48) * Math.PI * 2, rr = R + Math.max(-0.5, j!.radius(a)) * half;
      ctx.lineTo(ox + Math.cos(a) * rr, oy - Math.sin(a) * rr);
    }
  } else ctx.arc(c, c, R, 0, Math.PI * 2);
  ctx.clip();
  if (on) t += j!.stir * 0.3;
  ctx.fillStyle = css(s.colors[0]); ctx.fillRect(0, 0, px, px);
  const blobs: Array<[Rgb, number]> = [[s.colors[1], 0], [s.colors[2], 2.1], [s.colors[3], 4.2]];   // flat 2D: no highlight / rim
  if (s.extra) blobs.push([s.extra, 5.3]);
  for (const [color, o] of blobs) {
    const x = c + Math.cos(t * 0.3 + o + s.seed[0] * 6) * R * 0.45, y = c + Math.sin(t * 0.25 + o + s.seed[1] * 6) * R * 0.45;
    const g = ctx.createRadialGradient(x, y, 0, x, y, R * 1.1);
    g.addColorStop(0, css(color)); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, px, px);
  }
  ctx.restore();
}

/* ---------------- still images (cached) ---------------- */
const BUCKETS = [32, 48, 64, 96, 128, 192, 256, 384];
const bucket = (cssPx: number) => { const want = Math.ceil(cssPx * Math.min(2, window.devicePixelRatio || 1)); return BUCKETS.find((b) => b >= want) || 384; };
const stills = new Map<string, string>();
let scratch: HTMLCanvasElement | null = null;
function still(spec: OrbSpec, px: number): string {
  const k = spec.key + '|' + px;
  let url = stills.get(k);
  if (url) return url;
  scratch ??= document.createElement('canvas');
  scratch.width = scratch.height = px;
  const ctx = scratch.getContext('2d')!;
  paint(ctx, spec, px, spec.t0, 0);
  url = scratch.toDataURL('image/png');
  if (stills.size > 600) stills.clear();
  stills.set(k, url);
  return url;
}
// render stills in small batches so long lists never block a frame
const queue = new Map<HTMLElement, () => void>();
let qRaf = 0;
function enqueue(el: HTMLElement, fn: () => void) {
  queue.set(el, fn);
  if (!qRaf) qRaf = requestAnimationFrame(drain);
}
function drain() {
  qRaf = 0;
  const t0 = performance.now();
  for (const [el, fn] of queue) {
    queue.delete(el);
    if (el.isConnected || !el.dataset.seen) fn();
    if (performance.now() - t0 > 10) break;
  }
  if (queue.size) qRaf = requestAnimationFrame(drain);
}

/* ---------------- jelly: soft-body ring ----------------
   A ring of JN radial nodes (spring to the target shape + tension to the neighbours + viscous coupling, area kept by
   removing the mean) around a body centre on a damped spring. The content (colour field) lags the body on a softer
   spring (slosh), spins with the finger's angular velocity (stir, unwinds with overshoot) and gets turbulence from
   the finger speed that decays. Units: orb half-size = 1, y up (shader space). The shape goes to the shader as
   8 Fourier harmonics; the canvas is JELLY_SCALE times the orb so the stretched body fits. */
const JN = 24, JELLY_SCALE = 1.9, JH = 1 / 120;
const JTH = Array.from({ length: JN }, (_, i) => (i / JN) * Math.PI * 2);
const JCOS = Array.from({ length: 8 }, (_, k) => JTH.map((t) => Math.cos((k + 1) * t)));
const JSIN = Array.from({ length: 8 }, (_, k) => JTH.map((t) => Math.sin((k + 1) * t)));
const wrapA = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const clampAbs = (x: number, m: number) => Math.max(-m, Math.min(m, x));

class Soft {
  r = new Float32Array(JN); v = new Float32Array(JN); tgt = new Float32Array(JN); nv = new Float32Array(JN);
  A = new Float32Array(8); B = new Float32Array(8);
  cx = 0; cy = 0; cvx = 0; cvy = 0; tcx = 0; tcy = 0;     // body centre / velocity / target
  px = 0; py = 0; pvx = 0; pvy = 0;                       // content centre (lags the body)
  flowX = 0; flowY = 0;
  stir = 0; w = 0; turb = 0;
  awake = false; grab = false; acc = 0;
  /** Finger displacement from the grab point (orb half-size units, y up): the body leans and stretches toward it. */
  setPull(dx: number, dy: number): void {
    const D = Math.hypot(dx, dy);
    if (D < 1e-4) { this.tgt.fill(0); this.tcx = this.tcy = 0; return; }
    const ux = dx / D, uy = dy / D, e = D / (1 + D * 0.85), phi = Math.atan2(uy, ux);
    this.tcx = ux * e * 0.34; this.tcy = uy * e * 0.34;
    const sg = e * 0.38;
    let m = 0;
    for (let i = 0; i < JN; i++) {
      const d = JTH[i] - phi, c = Math.cos(d);
      const t = sg * (0.95 * (c > 0 ? c * c * c : 0) + 0.3 * Math.cos(2 * d));
      this.tgt[i] = t; m += t;
    }
    m /= JN;
    for (let i = 0; i < JN; i++) this.tgt[i] -= m;
  }
  release(): void { this.grab = false; this.tgt.fill(0); this.tcx = this.tcy = 0; }
  /** Finger velocity (units/s) for `dt` seconds: the leading edge bulges, the content lags and churns. */
  kick(vx: number, vy: number, dt: number): void {
    const sp = Math.hypot(vx, vy);
    for (let i = 0; i < JN; i++) this.v[i] += (Math.cos(JTH[i]) * vx + Math.sin(JTH[i]) * vy) * dt * 2.2;
    this.pvx -= vx * dt * 2.5; this.pvy -= vy * dt * 2.5;
    this.turb = Math.min(1.6, this.turb + sp * dt * 0.55);
  }
  /** Angular impulse (rad/s) on the content. */
  spin(dw: number): void { this.w = clampAbs(this.w + dw, 16); }
  /** Tap at (x, y) relative to the centre: a dent that rings around the body, a splash inside. */
  splash(x: number, y: number): void {
    const dist = Math.min(1, Math.hypot(x, y)), phi = Math.atan2(y, x);
    let m = 0;
    for (let i = 0; i < JN; i++) {
      const d = wrapA(JTH[i] - phi);
      const dv = -2.4 * Math.exp(-d * d * 3) * (0.35 + dist * 0.65) + 1.3 * Math.cos(2 * JTH[i] + 0.7) * (1 - dist);
      this.v[i] += dv; m += dv;
    }
    m /= JN; for (let i = 0; i < JN; i++) this.v[i] -= m;
    this.cvx -= Math.cos(phi) * 0.8 * dist; this.cvy -= Math.sin(phi) * 0.8 * dist;
    this.pvx += Math.cos(phi) * 1.2 * dist; this.pvy += Math.sin(phi) * 1.2 * dist;
    this.turb = Math.min(1.6, this.turb + 0.9);
    this.spin((Math.abs(x) > 0.08 ? -Math.sign(x) : Math.random() < 0.5 ? -1 : 1) * (4 + Math.random() * 3));
  }
  private sub(h: number): void {
    const { r, v, nv, tgt } = this;
    for (let i = 0; i < JN; i++) {
      const a = (i + JN - 1) % JN, b = (i + 1) % JN;
      const f = 150 * (tgt[i] - r[i]) + 520 * (r[a] + r[b] - 2 * r[i]) - 6 * v[i] + 7 * (v[a] + v[b] - 2 * v[i]);
      nv[i] = v[i] + f * h;
    }
    let mr = 0, mv = 0;
    for (let i = 0; i < JN; i++) { v[i] = nv[i]; r[i] += v[i] * h; mr += r[i]; mv += v[i]; }
    mr /= JN; mv /= JN;
    for (let i = 0; i < JN; i++) { r[i] = clampAbs(r[i] - mr, 0.6); v[i] -= mv; }   // pressure: the area stays
    this.cvx += (125 * (this.tcx - this.cx) - 7 * this.cvx) * h; this.cx += this.cvx * h;
    this.cvy += (125 * (this.tcy - this.cy) - 7 * this.cvy) * h; this.cy += this.cvy * h;
    this.pvx += (55 * (this.cx - this.px) - 4.2 * this.pvx) * h; this.px += this.pvx * h;
    this.pvy += (55 * (this.cy - this.py) - 4.2 * this.pvy) * h; this.py += this.pvy * h;
    this.w += (-14 * this.stir - 4.5 * this.w) * h; this.stir += this.w * h;
    this.turb *= Math.exp(-h * 1.9);
  }
  step(dt: number): void {
    this.acc += dt;
    let n = 0;
    while (this.acc >= JH && n < 12) { this.sub(JH); this.acc -= JH; n++; }
    if (n >= 12) this.acc = 0;
    this.flowX = clampAbs((this.px - this.cx) * 1.4, 0.55); this.flowY = clampAbs((this.py - this.cy) * 1.4, 0.55);
    for (let k = 0; k < 8; k++) {
      let a = 0, b = 0;
      for (let i = 0; i < JN; i++) { a += this.r[i] * JCOS[k][i]; b += this.r[i] * JSIN[k][i]; }
      this.A[k] = (a * 2) / JN; this.B[k] = (b * 2) / JN;
    }
    if (!this.grab) {
      let e = Math.abs(this.cx) + Math.abs(this.cy) + (Math.abs(this.cvx) + Math.abs(this.cvy)) * 0.05 + Math.abs(this.px) + Math.abs(this.py)
        + (Math.abs(this.pvx) + Math.abs(this.pvy)) * 0.05 + Math.abs(this.stir) + Math.abs(this.w) * 0.05 + this.turb;
      for (let i = 0; i < JN; i++) e = Math.max(e, Math.abs(this.r[i]) + Math.abs(this.v[i]) * 0.05);
      if (e < 0.0025) this.rest();
    }
  }
  /** Back to the exact rest state (no residual jitter). */
  rest(): void {
    this.r.fill(0); this.v.fill(0); this.tgt.fill(0); this.A.fill(0); this.B.fill(0);
    this.cx = this.cy = this.cvx = this.cvy = this.tcx = this.tcy = this.px = this.py = this.pvx = this.pvy = 0;
    this.flowX = this.flowY = this.stir = this.w = this.turb = this.acc = 0;
    this.awake = false;
  }
  /** Radius offset at angle a (2D fallback). */
  radius(a: number): number {
    let s = 0;
    for (let k = 0; k < 8; k++) s += this.A[k] * Math.cos((k + 1) * a) + this.B[k] * Math.sin((k + 1) * a);
    return s;
  }
  /** Debug / test snapshot. */
  snap() { return { awake: this.awake, cx: this.cx, cy: this.cy, stretch: Math.max(...this.r) - Math.min(...this.r), stir: this.stir, turb: this.turb }; }
}

/* ---------------- live loop ---------------- */
export type LevelFn = () => number;
interface Live { el: OrbEl; cv: HTMLCanvasElement; ctx: CanvasRenderingContext2D; px: number; time: number; amp: number; visible: boolean; seen: boolean; level?: LevelFn; last: number; temp?: boolean }
const lives = new Set<Live>();
const reduce = matchMedia('(prefers-reduced-motion: reduce)');
let raf = 0;
const io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver((entries) => {
  for (const e of entries) { const l = (e.target as OrbEl)._live; if (l) l.visible = e.isIntersecting; }
  kick();
}) : null;
function kick() { if (!raf && !document.hidden && [...lives].some((l) => l.visible)) { raf = requestAnimationFrame(frame); } }
document.addEventListener('visibilitychange', kick);
function frame(now: number) {
  raf = 0;
  if (document.hidden) return;
  let any = false;
  const done: OrbEl[] = [];
  for (const l of lives) {
    if (!l.el.isConnected) { if (l.seen) { stopLive(l.el); } continue; }
    l.seen = true;
    if (!l.visible) continue;
    any = true;
    const raw = l.last ? (now - l.last) / 1000 : 0.016, dt = Math.min(0.05, raw); l.last = now;
    const target = Math.max(0, Math.min(1, l.level ? l.level() : 0));
    l.amp += (target - l.amp) * (target > l.amp ? 0.35 : 0.08);
    const j = l.el._soft;
    let boost = 1;
    // physics runs on the real clock (up to 0.1 s per frame) so slow frames do not slow the spring-back
    if (j?.awake) { j.step(Math.min(0.1, raw)); boost = 1 + j.turb * 2.4 + Math.min(2, Math.abs(j.w) * 0.12); }
    l.time += dt * (0.32 + l.amp * 1.7) * (l.el._spec.speed ?? 1) * boost;
    paint(l.ctx, l.el._spec, l.px, l.time, l.amp, j);
    if (l.temp && !j?.awake) done.push(l.el);       // woken only for a gesture: back to the still image
  }
  for (const el of done) stopLive(el);
  for (const l of lives) if (!l.visible) l.last = 0;
  if (any) raf = requestAnimationFrame(frame);
}
function stopLive(el: OrbEl) {
  const l = el._live; if (!l) return;
  lives.delete(l); io?.unobserve(el); l.cv.remove(); el._live = null; el.classList.remove('live');
}

/* ---------------- element ---------------- */
export interface OrbEl extends HTMLSpanElement {
  _spec: OrbSpec; _live: Live | null; _size: number; _soft?: Soft;
  setSpec(spec: OrbSpec): void;
  /** Animate (true) or show the still image (false). `level` returns 0..1 amplitude (e.g. from player.level()). */
  setLive(on: boolean, level?: LevelFn): void;
}

export function orb(spec: OrbSpec, opts: { size: number; live?: boolean; level?: LevelFn; cls?: string; label?: string } = { size: 44 }): OrbEl {
  const el = h('span', { class: 'orb' + (opts.cls ? ' ' + opts.cls : ''), role: opts.label ? 'img' : null, 'aria-label': opts.label || null, 'aria-hidden': opts.label ? null : 'true' }) as OrbEl;
  el.style.setProperty('--orb', opts.size + 'px');
  el._size = opts.size; el._live = null;
  const applyStill = () => {
    const px = bucket(el._size);
    const k = el._spec.key + '|' + px;
    const cached = stills.get(k);
    const set = (u: string) => { el.style.backgroundImage = `url("${u}")`; el.classList.add('ready'); };
    if (cached) set(cached); else enqueue(el, () => set(still(el._spec, px)));
  };
  el.setSpec = (s) => {
    if (el._spec && el._spec.key === s.key) return;
    el._spec = s;
    el.style.setProperty('--o0', css(s.colors[0])); el.style.setProperty('--o1', css(s.colors[1])); el.style.setProperty('--o3', css(s.colors[3]));
    el.classList.remove('ready'); el.style.backgroundImage = '';
    applyStill();
    if (el._live) { el._live.last = 0; kick(); }
  };
  el.setLive = (on, level) => {
    if (!on || reduce.matches) { stopLive(el); return; }
    if (el._live) { el._live.level = level; el._live.temp = false; kick(); return; }
    const px = el._soft ? jellyPx(el._size) : bucket(el._size);
    const cv = h('canvas', { width: px, height: px }) as HTMLCanvasElement;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const l: Live = { el, cv, ctx, px, time: el._spec.t0, amp: 0, visible: !io, seen: el.isConnected, level, last: 0 };
    paint(ctx, el._spec, px, l.time, 0, el._soft);
    el.append(cv); el.classList.add('live');
    el._live = l; lives.add(l); io?.observe(el);
    kick();
  };
  el.setSpec(spec);
  if (opts.live) el.setLive(true, opts.level);
  return el;
}

reduce.addEventListener?.('change', () => { if (reduce.matches) for (const l of [...lives]) { l.el._soft?.rest(); stopLive(l.el); } });

/* ---------------- jelly gestures ---------------- */
const jellyPx = (cssPx: number) => Math.min(1024, Math.ceil(cssPx * JELLY_SCALE * Math.min(1.5, window.devicePixelRatio || 1)));

export interface JellyOpts {
  /** Element that receives the pointer (default: the orb). */
  target?: HTMLElement;
  /** Tap (no drag). The orb splashes first. */
  onTap?: (e: PointerEvent) => void;
  /** Called while dragging with the finger offset in px (after the tap slop). */
  onDrag?: (dx: number, dy: number) => void;
  /** Pointer released; `dragged` = it moved beyond the tap slop. */
  onRelease?: (dragged: boolean) => void;
  slop?: number;
}

function wake(el: OrbEl): Soft | null {
  const j = el._soft;
  if (!j || reduce.matches) return null;
  if (!el._live) { el.setLive(true, () => 0); if (el._live) (el._live as Live).temp = true; }
  if (!el._live) return null;
  j.awake = true;
  el._live.last = 0;
  kick();
  return j;
}

/** Make an orb behave like jelly / liquid: drag stretches the body toward the finger and it springs back to the
    centre with a wobble; finger speed stirs the content; a tap splashes. Under reduced motion only the callbacks run.
    A light drag (beyond `slop`) swallows the click that follows, so buttons under the orb only react to real taps. */
export function jelly(el: OrbEl, o: JellyOpts = {}): () => void {
  if (!el._soft) {
    el._soft = new Soft();
    el.classList.add('jelly');
    if (el._live) { const lv = el._live.level; stopLive(el); el.setLive(true, lv); }   // re-create at the jelly canvas size
  }
  const j = el._soft;
  const target = o.target || el;
  target.style.touchAction = 'none';
  const slop = o.slop ?? 8;
  let id = -1, x0 = 0, y0 = 0, t0 = 0, moved = false, cx = 0, cy = 0, half = 1, lx = 0, ly = 0, lt = 0, vx = 0, vy = 0;
  const down = (e: PointerEvent) => {
    if (id !== -1 || !e.isPrimary || e.button > 0) return;
    id = e.pointerId; x0 = lx = e.clientX; y0 = ly = e.clientY; t0 = lt = performance.now(); moved = false; vx = vy = 0;
    const r = el.getBoundingClientRect();
    cx = r.left + r.width / 2; cy = r.top + r.height / 2; half = Math.max(8, r.width / 2);
    if (wake(el)) j.grab = true;
    addEventListener('pointermove', move, true);
    addEventListener('pointerup', up, true);
    addEventListener('pointercancel', up, true);
  };
  const move = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    const now = performance.now(), dt = Math.max(0.004, (now - lt) / 1000);
    const dx = e.clientX - x0, dy = e.clientY - y0;
    if (!moved && Math.hypot(dx, dy) > slop) moved = true;
    // finger velocity in orb units/s (y up), smoothed
    const ivx = (e.clientX - lx) / half / dt, ivy = -(e.clientY - ly) / half / dt;
    vx += (ivx - vx) * 0.5; vy += (ivy - vy) * 0.5;
    lx = e.clientX; ly = e.clientY; lt = now;
    if (j.awake || (moved && wake(el))) {
      j.grab = true;
      j.setPull(dx / half, -dy / half);
      const fdt = Math.min(0.05, dt);
      j.kick(vx, vy, fdt);
      const rx = (e.clientX - cx) / half, ry = -(e.clientY - cy) / half;
      j.spin(((rx * vy - ry * vx) / (rx * rx + ry * ry + 0.6)) * fdt * 9);
    }
    if (moved) o.onDrag?.(dx, dy);
  };
  const up = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    id = -1;
    removeEventListener('pointermove', move, true);
    removeEventListener('pointerup', up, true);
    removeEventListener('pointercancel', up, true);
    j.release();
    if (e.type === 'pointercancel') { o.onRelease?.(moved); return; }
    if (moved) {
      // a fling keeps some momentum: the body overshoots the centre
      j.cvx += clampAbs(vx, 12) * 0.12; j.cvy += clampAbs(vy, 12) * 0.12;
      const swallow = (c: Event) => { c.stopPropagation(); c.preventDefault(); };
      target.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => target.removeEventListener('click', swallow, true), 350);
    } else if (performance.now() - t0 < 600) {
      if (wake(el)) j.splash((e.clientX - cx) / half, -(e.clientY - cy) / half);
      o.onTap?.(e);
    }
    o.onRelease?.(moved);
  };
  target.addEventListener('pointerdown', down);
  return () => {
    target.removeEventListener('pointerdown', down);
    removeEventListener('pointermove', move, true); removeEventListener('pointerup', up, true); removeEventListener('pointercancel', up, true);
  };
}

/** Splash the orb from code (e.g. after a colour change). x/y: -1..1 from the centre, y up. */
export function splash(el: OrbEl, x = 0, y = 0): void { const j = wake(el); j?.splash(x, y); }
/** Pull a jelly orb from code (demo "ghost hand"): offset in orb half-size units (y up), `null` = let go.
    `vx/vy` (units/s) stir the content like a real finger would. */
export function ghostPull(el: OrbEl, dx: number | null, dy = 0, vx = 0, vy = 0, dt = 0.016): void {
  if (dx === null) { el._soft?.release(); return; }
  const j = wake(el);
  if (!j) return;
  j.grab = true; j.setPull(dx, dy);
  if (vx || vy) j.kick(vx, vy, dt);
}
/** Test hook: soft-body state of a jelly orb. */
export const jellyState = (el: OrbEl) => el._soft?.snap() ?? null;

/* For the intro trailer (ui/intro/stage.ts), which draws many orbs in its own single canvas with the same shader and
   soft body. Read-only exports: nothing here changes how the orbs above behave. */
export const ORB_FS = FS;
export const ORB_JELLY_SCALE = JELLY_SCALE;
export { Soft as SoftBody };
/** uK / uWarp of a spec, exactly as paint() computes them. */
export function orbSoftness(spec: OrbSpec): { k: number; warp: number } {
  const soft = spec.soft ?? 0.5;
  return { k: soft < 0.5 ? 0.18 + (soft / 0.5) * 0.82 : 1 + ((soft - 0.5) / 0.5) * 1.1, warp: 2.2 * (1.45 - 0.9 * soft) };
}

/** Amplitude that "breathes" while waiting (e.g. AI is thinking). */
export function thinkingLevel(): LevelFn {
  const t0 = performance.now();
  return () => { const t = (performance.now() - t0) / 1000; return 0.25 + 0.2 * Math.sin(t * 2.3) * Math.sin(t * 0.9 + 1); };
}
