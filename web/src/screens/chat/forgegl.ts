/* Renderer of the persona forge (forge.ts): ONE full-screen canvas showing the persona's orb as a sphere of radius 1
   at the origin, seen by a pinhole camera that can orbit it and dolly INTO it.
   The orb is drawn with THE SAME fragment shader as every 2D orb of the app (ui/orb.ts ORB_FS, turned into a function
   here, same uniforms / palette / pattern / phase / shape): one source of truth. Mapping:
   - k = 0 (rest): orb coordinates come straight from the screen position relative to the sphere's screen centre and
     radius, exactly like a 2D orb of that size (orthographic, front view): pixel-identical to the DOM orb.
   - k = 1: they come from the hit point on the sphere expressed in the camera frame AT REST, so the pattern sticks to
     the sphere and turns with it; perspective, the inside view and the glass (grid, rim, reflection; `glass`) can then
     fade in. The silhouette blends from the orb's own edge to the sphere's.
   A second copy of the orb function (uniforms *B) lets a changed persona look cross-dissolve (morph) instead of cutting.
   Canvas 2D fallback (no WebGL): background + grid only; forge.ts lays a real DOM orb under it. */
import { ORB_FS, orbSoftness, shapeHarmonics, type OrbSpec, type Rgb } from '../../ui/orb';

export type V3 = [number, number, number];
export interface ForgeCam { pos: V3; yaw: number; pitch: number; f: number }
export interface Ripple { dir: V3; t0: number; c: Rgb }
export interface ForgeFrame {
  cam: ForgeCam; T: number;
  spec: OrbSpec; time: number;
  /** previous look while morphing (0..1 = how much of the NEW look is shown) */
  specB?: OrbSpec | null; timeB?: number; morph?: number;
  /** 0 = flat 2D orb at the sphere's screen place, 1 = mapped on the sphere */
  k: number;
  /** screen radius of the orb at rest (css px) and the screen position of its centre relative to the canvas centre */
  rS: number; ctr: [number, number];
  glass: number; scan: number; flash: number;
  squash: V3; ripples: Ripple[]; bgA: Rgb; bgB: Rgb;
  /** camera basis at rest (the orb's frame) */
  rest: { R: V3; Up: V3; Fw: V3 };
}

const VS = 'attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}';
const ORB_U = ['uSize', 'uTime', 'uAmp', 'uPat', 'uTwist', 'uK', 'uWarp', 'uN', 'uC0', 'uC1', 'uC2', 'uC3', 'uC4', 'uSeed', 'uScale', 'uStir', 'uTurb', 'uOff', 'uFlow', 'uA1', 'uA2', 'uB1', 'uB2'];
/** ORB_FS as `vec4 orbX(vec2 v)` (premultiplied rgba). Copy B renames its uniforms (*B) and `sm` and drops the shared
    helpers. Returns null if the source changed shape (then the forge falls back to 2D). */
function orbFunctions(): string | null {
  const src = ORB_FS.replace(/^precision highp float;\s*varying vec2 v;\s*/, '');
  const A0 = 'void main(){', A1 = 'if(a<=0.){gl_FragColor=vec4(0.);return;}', A2 = 'gl_FragColor=vec4(clamp(c,0.,1.)*a,a);';
  if (![A0, A1, A2].every((x) => src.includes(x)) || src === ORB_FS) return null;
  const fnA = src.replace(A0, 'vec4 orbA(vec2 v){').replace(A1, 'if(a<=0.)return vec4(0.);').replace(A2, 'return vec4(clamp(c,0.,1.)*a,a);');
  // copy B: uniforms + sm renamed, helpers (hs / ns / fbm / rot) shared with A
  const iH = fnA.indexOf('float hs('), iM = fnA.indexOf('vec4 orbA(');
  if (iH < 0 || iM < iH) return null;
  let fnB = fnA.slice(0, iH) + fnA.slice(iM);
  const re = new RegExp('\\b(' + ORB_U.join('|') + ')\\b', 'g');
  fnB = fnB.replace(re, '$1B').replace(/\bsm\(/g, 'smB(').replace('vec4 orbA(', 'vec4 orbB(');
  return fnA + '\n' + fnB;
}

const fs = (orbs: string) => `precision highp float;
${orbs}
uniform vec2 fRes,fCtr;uniform float fT,fF,fRS,fKk,fGlass,fScan,fFlash,fYaw,fMorph;
uniform vec3 fPos,fR,fU,fFw,fSq,fBgA,fBgB,fRR,fRU,fRF;
uniform vec4 fRip[4];uniform vec3 fRipC[4];
float fh(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
vec2 sph(vec3 ro,vec3 rd){vec3 o=ro/fSq,d=rd/fSq;float a=dot(d,d),b=dot(o,d),c=dot(o,o)-1.,h=b*b-a*c;if(h<0.)return vec2(1e9,-1e9);h=sqrt(h);return vec2((-b-h)/a,(-b+h)/a);}
float ripple(vec3 n,out vec3 rc){float s=0.;rc=vec3(0.);
 for(int i=0;i<4;i++){vec4 r=fRip[i];float age=fT-r.w;if(age<0.||age>5.)continue;
  float ang=acos(clamp(dot(n,r.xyz),-1.,1.));float fr=age*.85;
  s+=sin((ang-fr)*24.)*exp(-pow((ang-fr)*3.6,2.))*exp(-age*1.05);
  rc+=fRipC[i]*exp(-ang*ang*7./(.15+age))*exp(-age*.6);}
 return s;}
float gline(float x,float w){float g=abs(fract(x+.5)-.5);return 1.-smoothstep(w*.6,w*1.7,g);}
// line width from the pixel footprint (no derivatives: they are undefined inside branches on some GPUs)
float grid(vec3 n,float rp,float pw,float cv){
 float lat=asin(clamp(n.y,-1.,1.)),lon=atan(n.z,n.x);
 float k=12./3.14159;
 float a=lat*k+rp*.22,b=lon*k+rp*.22;
 float wa=clamp(k*.85*pw/max(.2,cv),.002,.5),wb=clamp(wa/max(.12,cos(lat)),.002,.5);
 return max(gline(a,wa),gline(b,wb)*smoothstep(.03,.3,cos(lat)));}
vec4 orbAt(vec2 p){vec4 o=orbA(p*.5+.5);if(fMorph<.999){vec4 b=orbB(p*.5+.5);o=mix(b,o,fMorph);}return o;}
void main(){
 vec2 sp=gl_FragCoord.xy-fRes*.5;
 vec2 q=gl_FragCoord.xy/fRes;
 float inside=step(length(fPos),1.);
 vec3 rd=normalize(fR*(sp.x-fCtr.x)+fU*(sp.y-fCtr.y)+fFw*fF);
 if(fFlash>.001){vec2 w=sp/fF;rd=normalize(rd+fFlash*.09*vec3(sin(w.y*9.+fT*3.),sin(w.x*8.-fT*2.4),0.));}
 vec3 col=mix(fBgB,fBgA,q.y);
 // the flat 2D orb (rest): screen offset over the screen radius, .88 = the orb's silhouette radius in its own units
 vec2 p2=(sp-fCtr)/max(1.,fRS)*.88;
 vec2 h=sph(fPos,rd);
 bool hit=h.y>0.;
 vec3 nF=vec3(0.,0.,-1.),nN=nF;vec3 rc=vec3(0.);float rp=0.;
 vec2 p3=p2;
 if(hit){
  nF=normalize((fPos+rd*h.y)/fSq);
  nN=inside>.5?nF:normalize((fPos+rd*max(h.x,0.))/fSq);
  rp=ripple(nN,rc);
  vec3 m=vec3(dot(nN,fRR),dot(nN,fRU),-dot(nN,fRF));   // the hit point in the orb frame (camera at rest)
  // the orb's own edge wobbles down to ~.86: stay inside it (the far half of the sphere mirrors the front)
  vec2 mx=m.xy;float ml=length(mx);if(ml>.955)mx*=.955/ml;
  p3=mx*.88;
 }
 // ripples also stir the flat orb a little
 p2+=normalize(p2+1e-5)*rp*.015;
 if(inside<.5){
  // the persona's orb: 2D at rest, wrapped on the sphere when k -> 1
  vec4 o=orbAt(mix(p2,p3,fKk));
  // the silhouette in the same (squashed) space as the hit point the colours come from: one object
  vec3 so=fPos/fSq,sd=normalize(rd/fSq);
  float b=dot(so,sd),c=dot(so,so)-b*b;
  float mask=1.-smoothstep(1.-1.2/max(1.,fRS),1.+1.2/max(1.,fRS),sqrt(max(c,0.)));
  float al=mix(o.a,mask,fKk);
  vec3 oc=o.a>.002?o.rgb/o.a:vec3(0.);
  col=col*(1.-al)+oc*al;
  if(hit&&fGlass>.001){
   float gN=grid(nN,rp,max(h.x,.1)/fF,-dot(rd,nN)),gF=grid(nF,rp,h.y/fF,abs(dot(rd,nF)));
   float fres=pow(1.-clamp(-dot(rd,nN),0.,1.),2.6);
   vec3 gc=vec3(.86,.88,.92);
   col=mix(col,col*.86,.5*fGlass);
   col+=(gc*gN*(.32+.4*fres)+gc*gF*.05+rc*.45+gc*max(0.,rp)*.15)*fGlass;
   col+=vec3(.9,.92,.95)*fres*.25*fGlass;
   vec3 L1=normalize(vec3(-.5,.65,-.6));
   col+=vec3(1.)*pow(max(dot(reflect(rd,nN),L1),0.),48.)*.35*fGlass;
  }
 } else {
  // inside: the far wall is the same orb, dimmed, curving away; grid + specks give the depth
  vec4 o=orbAt(p3);
  vec3 oc=o.a>.002?o.rgb/o.a:vec3(.2);
  float depth=smoothstep(.9,1.6,h.y);
  col=oc*(.42-.2*depth)*(.75+.25*(1.-abs(nF.y)));
  vec3 gc=mix(vec3(.8,.82,.86),oc,.25);
  float gF=grid(nF,rp,h.y/fF,abs(dot(rd,nF)));
  col+=gc*gF*mix(.5,.15,depth)*fGlass+rc*.5;
  float bl=sin(fT*1.4)*.75;
  col+=oc*exp(-pow((nF.y-bl)*40.,2.))*fScan*.9+gc*gF*exp(-pow((nF.y-bl)*5.,2.))*fScan*.5;
  for(int k=0;k<3;k++){float fk=float(k);vec2 g=gl_FragCoord.xy/(fRes.y*(.055+fk*.035))+vec2(fYaw*(2.+fk*2.5)*3.,fT*(.05+fk*.03));
   vec2 id=floor(g),f=fract(g)-.5;float r=fh(id+fk*7.);if(r>.86){vec2 o2=vec2(fh(id+3.1),fh(id+5.7))-.5;float dd=length(f-o2*.6);col+=gc*(1.-smoothstep(.015,.05+fk*.02,dd))*(.1+fk*.04);}}
  col*=1.-dot(q-.5,q-.5)*1.5;
 }
 col+=vec3(.8,.82,.86)*fFlash*.18;
 gl_FragColor=vec4(clamp(col,0.,1.),1.);
}`;

const FU = ['fRes', 'fCtr', 'fT', 'fF', 'fRS', 'fKk', 'fGlass', 'fScan', 'fFlash', 'fYaw', 'fMorph', 'fPos', 'fR', 'fU', 'fFw', 'fSq', 'fBgA', 'fBgB', 'fRR', 'fRU', 'fRF', 'fRip', 'fRipC'];

/** camera basis: yaw around y, pitch up / down; forward = (sin yaw cos pitch, sin pitch, cos yaw cos pitch) */
export function basis(c: { yaw: number; pitch: number }): { R: V3; Up: V3; Fw: V3 } {
  const cy = Math.cos(c.yaw), sy = Math.sin(c.yaw), cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
  const Fw: V3 = [sy * cp, sp, cy * cp];
  const R: V3 = [cy, 0, -sy];
  const Up: V3 = [Fw[1] * R[2] - Fw[2] * R[1], Fw[2] * R[0] - Fw[0] * R[2], Fw[0] * R[1] - Fw[1] * R[0]];   // cross(Fw, R): world up = screen up
  return { R, Up, Fw };
}

export class ForgeGL {
  readonly canvas: HTMLCanvasElement;
  readonly kind: 'webgl' | '2d';
  private gl: WebGLRenderingContext | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private u: Record<string, WebGLUniformLocation | null> = {};
  dpr = 1; w = 0; h = 0;
  constructor(noGL = false) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'pf-gl';
    this.canvas.setAttribute('aria-hidden', 'true');
    let gl: WebGLRenderingContext | null = null;
    const orbs = orbFunctions();
    if (!noGL && orbs) try {
      gl = this.canvas.getContext('webgl', { antialias: false, alpha: false, premultipliedAlpha: false, powerPreference: 'high-performance' }) as WebGLRenderingContext | null;
      if (gl) {
        const sh = (t: number, s: string) => { const x = gl!.createShader(t)!; gl!.shaderSource(x, s); gl!.compileShader(x); if (!gl!.getShaderParameter(x, gl!.COMPILE_STATUS)) throw new Error(gl!.getShaderInfoLog(x) || 'shader'); return x; };
        const p = gl.createProgram()!;
        gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs(orbs))); gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link');
        gl.useProgram(p);
        const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        const loc = gl.getAttribLocation(p, 'a'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        for (const n of FU) this.u[n] = gl.getUniformLocation(p, n);
        for (const n of ORB_U) { this.u[n] = gl.getUniformLocation(p, n); this.u[n + 'B'] = gl.getUniformLocation(p, n + 'B'); }
      }
    } catch (e) { console.warn('forge: WebGL off', (e as Error).message); gl = null; }
    this.gl = gl;
    if (!gl) this.ctx = this.canvas.getContext('2d');
    this.kind = gl ? 'webgl' : '2d';
  }
  /** Device pixel ratio: the same as the app's 2D orbs use (so the rest frame matches them pixel for pixel), capped. */
  resize(w: number, h: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w; this.h = h; this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(w * dpr)); this.canvas.height = Math.max(1, Math.round(h * dpr));
  }
  private setOrb(suffix: '' | 'B', s: OrbSpec, time: number, sizePx: number): void {
    const gl = this.gl!, u = this.u, n = (x: string) => u[x + suffix];
    gl.uniform1f(n('uSize'), sizePx); gl.uniform1f(n('uTime'), time); gl.uniform1f(n('uAmp'), 0);
    gl.uniform1f(n('uPat'), s.pattern); gl.uniform1f(n('uTwist'), s.twist);
    const sf = orbSoftness(s); gl.uniform1f(n('uK'), sf.k); gl.uniform1f(n('uWarp'), sf.warp);
    gl.uniform1f(n('uN'), s.extra ? 5 : 4);
    gl.uniform3fv(n('uC0'), s.colors[0]); gl.uniform3fv(n('uC1'), s.colors[1]); gl.uniform3fv(n('uC2'), s.colors[2]); gl.uniform3fv(n('uC3'), s.colors[3]); gl.uniform3fv(n('uC4'), s.extra || s.colors[2]);
    gl.uniform4fv(n('uSeed'), s.seed);
    gl.uniform1f(n('uScale'), 1); gl.uniform1f(n('uStir'), 0); gl.uniform1f(n('uTurb'), 0);
    gl.uniform2f(n('uOff'), 0, 0); gl.uniform2f(n('uFlow'), 0, 0);
    const sh = shapeHarmonics(s.shape, time), Z = new Float32Array(4);
    gl.uniform4fv(n('uA1'), sh ? sh.A.subarray(0, 4) : Z); gl.uniform4fv(n('uA2'), sh ? sh.A.subarray(4, 8) : Z);
    gl.uniform4fv(n('uB1'), sh ? sh.B.subarray(0, 4) : Z); gl.uniform4fv(n('uB2'), sh ? sh.B.subarray(4, 8) : Z);
  }
  draw(f: ForgeFrame): void {
    if (this.ctx) return this.draw2d(f);
    const gl = this.gl!; if (gl.isContextLost()) return;
    const u = this.u, k = this.dpr, B = basis(f.cam);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.uniform2f(u.fRes, this.canvas.width, this.canvas.height);
    gl.uniform2f(u.fCtr, f.ctr[0] * k, -f.ctr[1] * k);
    gl.uniform1f(u.fT, f.T); gl.uniform1f(u.fF, f.cam.f * k); gl.uniform1f(u.fRS, f.rS * k); gl.uniform1f(u.fKk, f.k);
    gl.uniform1f(u.fGlass, f.glass); gl.uniform1f(u.fScan, f.scan); gl.uniform1f(u.fFlash, f.flash); gl.uniform1f(u.fYaw, f.cam.yaw);
    gl.uniform1f(u.fMorph, f.specB ? f.morph ?? 1 : 1);
    gl.uniform3fv(u.fPos, f.cam.pos); gl.uniform3fv(u.fR, B.R); gl.uniform3fv(u.fU, B.Up); gl.uniform3fv(u.fFw, B.Fw); gl.uniform3fv(u.fSq, f.squash);
    gl.uniform3fv(u.fBgA, f.bgA); gl.uniform3fv(u.fBgB, f.bgB);
    gl.uniform3fv(u.fRR, f.rest.R); gl.uniform3fv(u.fRU, f.rest.Up); gl.uniform3fv(u.fRF, f.rest.Fw);
    // the orb's own size in device px (its antialiasing): a 2D orb of diameter 2r is drawn on a canvas of 2r / .88
    const size = Math.max(4, (2 * f.rS * k) / 0.88);
    this.setOrb('', f.spec, f.time, size);
    if (f.specB) this.setOrb('B', f.specB, f.timeB ?? f.time, size);
    const rip = new Float32Array(16), rc = new Float32Array(12);
    for (let i = 0; i < 4; i++) {
      const r = f.ripples[f.ripples.length - 1 - i];
      if (r) { rip.set([r.dir[0], r.dir[1], r.dir[2], r.t0], i * 4); rc.set(r.c, i * 3); } else rip.set([0, 1, 0, -99], i * 4);
    }
    gl.uniform4fv(u.fRip, rip); gl.uniform3fv(u.fRipC, rc);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /* ---------- Canvas 2D fallback: background + grid polylines (the orb is a DOM element under the canvas) ---------- */
  private draw2d(f: ForgeFrame): void {
    const c = this.ctx!, k = this.dpr, W = this.w, H = this.h;
    c.setTransform(k, 0, 0, k, 0, 0);
    c.clearRect(0, 0, W, H);
    const B = basis(f.cam), P = f.cam.pos;
    const inside = Math.hypot(P[0], P[1], P[2]) < 1;
    if (inside) {
      const s = f.spec.colors;
      const rgb = (x: Rgb, a = 1) => `rgba(${Math.round(x[0] * 255)},${Math.round(x[1] * 255)},${Math.round(x[2] * 255)},${a})`;
      const rg = c.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.7);
      rg.addColorStop(0, rgb(s[1], 0.35)); rg.addColorStop(1, rgb(s[0], 0.25));
      c.fillStyle = '#08090b'; c.fillRect(0, 0, W, H); c.fillStyle = rg; c.fillRect(0, 0, W, H);
    }
    if (f.glass < 0.01) return;
    const proj = (x: number, y: number, z: number): [number, number] | null => {
      const d: V3 = [x - P[0], y - P[1], z - P[2]];
      const vz = d[0] * B.Fw[0] + d[1] * B.Fw[1] + d[2] * B.Fw[2];
      if (vz < 0.02) return null;
      const vx = d[0] * B.R[0] + d[1] * B.R[1] + d[2] * B.R[2], vy = d[0] * B.Up[0] + d[1] * B.Up[1] + d[2] * B.Up[2];
      return [W / 2 + f.ctr[0] + (f.cam.f * vx) / vz, H / 2 + f.ctr[1] - (f.cam.f * vy) / vz];
    };
    c.lineWidth = 1;
    const line = (pts: Array<[number, number, number]>) => {
      for (let i = 1; i < pts.length; i++) {
        const [x, y, z] = pts[i - 1], [x2, y2, z2] = pts[i];
        const front = !inside && (x + x2) * P[0] + (y + y2) * P[1] + (z + z2) * P[2] > 0;
        if (!inside && !front) continue;
        const a = proj(x, y, z), b = proj(x2, y2, z2);
        if (!a || !b) continue;
        c.strokeStyle = `rgba(220,222,228,${(inside ? 0.4 : 0.45) * f.glass})`;
        c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke();
      }
    };
    for (let la = -75; la <= 75; la += 15) { const t = (la * Math.PI) / 180, pts: Array<[number, number, number]> = []; for (let i = 0; i <= 48; i++) { const o = (i / 48) * Math.PI * 2; pts.push([Math.cos(t) * Math.cos(o), Math.sin(t), Math.cos(t) * Math.sin(o)]); } line(pts); }
    for (let lo = 0; lo < 360; lo += 15) { const o = (lo * Math.PI) / 180, pts: Array<[number, number, number]> = []; for (let i = 0; i <= 24; i++) { const t = -Math.PI / 2 + (i / 24) * Math.PI; pts.push([Math.cos(t) * Math.cos(o), Math.sin(t), Math.cos(t) * Math.sin(o)]); } line(pts); }
    if (f.flash > 0.01) { c.fillStyle = `rgba(210,212,218,${f.flash * 0.2})`; c.fillRect(0, 0, W, H); }
  }
  /** css px on screen of a world point (null behind the camera) */
  static project(cam: ForgeCam, W: number, H: number, ctr: [number, number], p: V3): [number, number] | null {
    const B = basis(cam), d: V3 = [p[0] - cam.pos[0], p[1] - cam.pos[1], p[2] - cam.pos[2]];
    const vz = d[0] * B.Fw[0] + d[1] * B.Fw[1] + d[2] * B.Fw[2]; if (vz < 0.02) return null;
    const vx = d[0] * B.R[0] + d[1] * B.R[1] + d[2] * B.R[2], vy = d[0] * B.Up[0] + d[1] * B.Up[1] + d[2] * B.Up[2];
    return [W / 2 + ctr[0] + (cam.f * vx) / vz, H / 2 + ctr[1] - (cam.f * vy) / vz];
  }
  /** screen radius of the sphere seen from outside (0 inside) */
  static radius(cam: ForgeCam): number { const d = Math.hypot(...cam.pos); return d > 1.001 ? cam.f / Math.sqrt(d * d - 1) : 0; }
}
