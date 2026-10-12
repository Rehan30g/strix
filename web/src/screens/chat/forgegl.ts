/* Renderer of the persona "forge" (forge.ts): ONE full-screen canvas showing a glass sphere of radius 1 at the origin,
   seen by a pinhole camera that can orbit it from outside and dolly straight INTO it.
   - Outside: thin glowing latitude / longitude grid on the front surface AND on the far wall seen through the glass
     (depth), fresnel rim, a soft reflection, the "liquid" inside (a gyroid ink field below a wavy level = fill), drops of
     colour that land with ripples on the surface.
   - Inside: the same sphere from within: the far wall is a concave dome whose grid bulges away from the viewer (strong
     perspective), vignette, light from within, floating specks like in water, a scanning band while Strix researches.
   - Crossing the surface: the membrane distorts the rays (refraction) and flashes softly.
   Everything is analytic (ray / sphere), so the silhouette is always a perfect circle. Canvas 2D fallback (no WebGL):
   the same camera projects grid polylines + a gradient fill. */
import type { Rgb } from '../../ui/orb';

export type V3 = [number, number, number];
export interface ForgeCam { pos: V3; yaw: number; pitch: number; f: number }
export interface Ripple { dir: V3; t0: number; c: Rgb }
export interface ForgeFrame {
  cam: ForgeCam; T: number;
  colors: [Rgb, Rgb, Rgb, Rgb]; fill: number; pat: number; scan: number; flash: number;
  squash: V3; ripples: Ripple[]; bgA: Rgb; bgB: Rgb;
  /** screen position of the sphere centre relative to the canvas centre (css px, y down) */
  ctr: [number, number];
  /** 1 = glass (grid, rim, reflection); 0 = only the coloured ink (the persona's ball, when leaving) */
  glass: number;
}

const VS = 'attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}';
const fs = (deriv: boolean) => `${deriv ? '#extension GL_OES_standard_derivatives : enable\n#define HAS_D 1\n' : ''}precision highp float;
uniform vec2 uRes,uCtr;uniform float uT,uF,uFill,uPat,uScan,uFlash,uYaw,uGlass;
uniform vec3 uPos,uR,uU,uFw,uSq,uC0,uC1,uC2,uC3,uBgA,uBgB;
uniform vec4 uRip[4];uniform vec3 uRipC[4];
float hs(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
vec2 sph(vec3 ro,vec3 rd){vec3 o=ro/uSq,d=rd/uSq;float a=dot(d,d),b=dot(o,d),c=dot(o,o)-1.,h=b*b-a*c;if(h<0.)return vec2(1e9,-1e9);h=sqrt(h);return vec2((-b-h)/a,(-b+h)/a);}
float ripple(vec3 n,out vec3 rc){float s=0.;rc=vec3(0.);
 for(int i=0;i<4;i++){vec4 r=uRip[i];float age=uT-r.w;if(age<0.||age>5.)continue;
  float ang=acos(clamp(dot(n,r.xyz),-1.,1.));float fr=age*.85;
  s+=sin((ang-fr)*24.)*exp(-pow((ang-fr)*3.6,2.))*exp(-age*1.05);
  rc+=uRipC[i]*exp(-ang*ang*7./(.15+age))*exp(-age*.6);}
 return s;}
float gline(float x,float w){float g=abs(fract(x+.5)-.5);return 1.-smoothstep(w*.6,w*1.7,g);}
float grid(vec3 n,float rp){
 float lat=asin(clamp(n.y,-1.,1.)),lon=atan(n.z,n.x);
 float k=12./3.14159;
 float a=lat*k+rp*.22,b=lon*k+rp*.22,b2=(lon<0.?lon+6.28318:lon)*k+rp*.22;
#ifdef HAS_D
 float wa=max(fwidth(a),1e-4),wb=max(min(fwidth(b),fwidth(b2)),1e-4);
#else
 float wa=.03,wb=.03/max(.2,cos(lat));
#endif
 float la=gline(a,wa),lb=gline(b,wb)*smoothstep(.03,.3,cos(lat));
 float eq=gline(lat*k*.5,wa*.5)*.0;
 return max(max(la,lb),eq);}
vec3 pal(float g,float y){vec3 c=mix(uC0,mix(uC1,uC2,smoothstep(-.6,.6,g)),smoothstep(-1.,.6,y+g*.35));return mix(c,uC3,smoothstep(.55,1.,g)*.55);}
void main(){
 vec2 sp=gl_FragCoord.xy-uRes*.5;
 vec2 q=gl_FragCoord.xy/uRes;
 float dist=length(uPos);
 vec3 rd=normalize(uR*(sp.x-uCtr.x)+uU*(sp.y-uCtr.y)+uFw*uF);
 // the membrane: rays bend while the camera crosses the surface
 if(uFlash>.001){vec2 w=sp/uF;rd=normalize(rd+uFlash*.09*vec3(sin(w.y*9.+uT*3.),sin(w.x*8.-uT*2.4),0.));}
 vec3 col=mix(uBgB,uBgA,q.y);
 vec2 h=sph(uPos,rd);
 float inside=step(dist,1.);
 if(h.y>0.){
  vec3 pf=uPos+rd*h.y;vec3 nf=normalize(pf/uSq);
  vec3 rcF;float rpF=ripple(nf,rcF);
  float gF=grid(nf,rpF);
  // volume: ink below the level (fill), a gyroid swirl, drops of colour falling in
  float t0=max(h.x,0.),t1=h.y;vec4 acc=vec4(0.);
  float lev=-1.+2.15*uFill;
  for(int i=0;i<10;i++){
   float t=mix(t0,t1,(float(i)+.5)/10.);vec3 x=uPos+rd*t;
   float L=lev+.05*sin(x.x*5.+uT*1.3)+.045*sin(x.z*6.-uT*1.1);
   float G=dot(sin(x*uPat+vec3(uT*.25,0.,uT*.18)),cos(x.zxy*uPat-uT*.2))/1.6;
   float d=smoothstep(0.,.07,L-x.y)*(.5+.5*G)*step(.001,uFill);
   vec3 c=pal(G,x.y);
   for(int j=0;j<4;j++){vec4 r=uRip[j];float age=uT-r.w;if(age<0.||age>4.)continue;
    vec3 ctr=r.xyz*(.82-min(age,2.2)*.3);float rr=.12+age*.16;float b=exp(-dot(x-ctr,x-ctr)/(rr*rr))*exp(-age*.5);
    d+=b*1.4;c=mix(c,uRipC[j],clamp(b*2.,0.,1.));}
   float a=clamp(d*(t1-t0)*.3,0.,1.)*mix(1.,.22,inside);
   acc.rgb+=(1.-acc.a)*c*a;acc.a+=(1.-acc.a)*a;
  }
  if(inside<.5){
   vec3 pn=uPos+rd*h.x;vec3 nn=normalize(pn/uSq);
   vec3 rcN;float rpN=ripple(nn,rcN);
   float gN=grid(nn,rpN);
   float fres=pow(1.-clamp(-dot(rd,nn),0.,1.),2.6);
   vec3 gc=mix(vec3(.80,.82,.86),uC3,.3*step(.001,uFill));
   col=mix(col,col*.8,.6*uGlass);                   // the glass darkens what is behind it a little
   col+=gc*gF*.14*uGlass;                           // far wall seen through the glass (depth)
   // the ink inside; when leaving (glass -> 0) it fills the whole ball
   vec3 ink=acc.a>.001?acc.rgb/acc.a:pal(0.,0.);
   float ia=mix(1.,acc.a,uGlass);
   col=col*(1.-ia)+ink*ia;
   col+=(gc*gN*(.38+.4*fres)+rcN*.5+gc*max(0.,rpN)*.15)*uGlass;
   col+=vec3(.85,.87,.9)*fres*.28*uGlass;          // rim
   vec3 L1=normalize(vec3(-.5,.65,-.6));
   col+=vec3(1.)*pow(max(dot(reflect(rd,nn),L1),0.),48.)*.35*uGlass;
  } else {
   // inside: the concave far wall, lit from within
   float vig=1.-dot(q-.5,q-.5)*1.5;
   vec3 base=mix(uBgB*1.2,uC0*.3+vec3(.015,.025,.06),.55);
   // the far wall is darker (depth), the walls around you catch the inner light
   float depth=smoothstep(.9,1.6,h.y);
   col=base*(1.15-.55*depth)*(.75+.25*(1.-abs(nf.y)));
   vec3 gc=mix(vec3(.80,.82,.86),uC3,.3);
   col+=gc*gF*mix(.55,.16,depth)+rcF*.5+gc*max(0.,rpF)*.15;
   col+=uC1*.12*smoothstep(.9,0.,abs(nf.y));
   // scanning band (research)
   float bl=sin(uT*1.4)*.75;
   col+=uC2*exp(-pow((nf.y-bl)*40.,2.))*uScan*.6+gc*gF*exp(-pow((nf.y-bl)*5.,2.))*uScan*.5;
   col=col*(1.-acc.a)+acc.rgb;
   // specks floating like in water (parallax with the camera yaw)
   for(int k=0;k<3;k++){float fk=float(k);vec2 g=gl_FragCoord.xy/(uRes.y*(.055+fk*.035))+vec2(uYaw*(2.+fk*2.5)*3.,uT*(.05+fk*.03));
    vec2 id=floor(g),f=fract(g)-.5;float r=hs(id+fk*7.);if(r>.86){vec2 o=vec2(hs(id+3.1),hs(id+5.7))-.5;float dd=length(f-o*.6);col+=gc*(1.-smoothstep(.015,.05+fk*.02,dd))*(.1+fk*.04);}}
   col*=vig;
  }
 }
 col+=vec3(.8,.82,.86)*uFlash*.18;
 col+=(hs(gl_FragCoord.xy+floor(uT*24.))-.5)*.02;
 gl_FragColor=vec4(clamp(col,0.,1.),1.);
}`;

const U = ['uRes', 'uCtr', 'uGlass', 'uT', 'uF', 'uFill', 'uPat', 'uScan', 'uFlash', 'uYaw', 'uPos', 'uR', 'uU', 'uFw', 'uSq', 'uC0', 'uC1', 'uC2', 'uC3', 'uBgA', 'uBgB', 'uRip', 'uRipC'];

/** camera basis: yaw around y, pitch up / down; forward = (sin yaw cos pitch, sin pitch, cos yaw cos pitch) */
export function basis(c: ForgeCam): { R: V3; Up: V3; Fw: V3 } {
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
    if (!noGL) try {
      gl = this.canvas.getContext('webgl', { antialias: false, alpha: false, premultipliedAlpha: false, powerPreference: 'high-performance' }) as WebGLRenderingContext | null;
      if (gl) {
        const deriv = !!gl.getExtension('OES_standard_derivatives');
        const sh = (t: number, s: string) => { const x = gl!.createShader(t)!; gl!.shaderSource(x, s); gl!.compileShader(x); if (!gl!.getShaderParameter(x, gl!.COMPILE_STATUS)) throw new Error(gl!.getShaderInfoLog(x) || 'shader'); return x; };
        const p = gl.createProgram()!;
        gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs(deriv))); gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link');
        gl.useProgram(p);
        const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        const loc = gl.getAttribLocation(p, 'a'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        for (const n of U) this.u[n] = gl.getUniformLocation(p, n);
      }
    } catch (e) { console.warn('forge: WebGL off', (e as Error).message); gl = null; }
    this.gl = gl;
    if (!gl) this.ctx = this.canvas.getContext('2d');
    this.kind = gl ? 'webgl' : '2d';
  }
  resize(w: number, h: number): void {
    // a soft, full-screen shader: a modest DPR keeps phones at 60 fps
    const dpr = Math.min(window.devicePixelRatio || 1, this.gl ? (Math.min(w, h) < 600 ? 1.25 : 1.1) : 1.5);
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w; this.h = h; this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(w * dpr)); this.canvas.height = Math.max(1, Math.round(h * dpr));
  }
  draw(f: ForgeFrame): void {
    if (this.ctx) return this.draw2d(f);
    const gl = this.gl!; if (gl.isContextLost()) return;
    const u = this.u, k = this.dpr, B = basis(f.cam);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.uniform2f(u.uRes, this.canvas.width, this.canvas.height);
    gl.uniform2f(u.uCtr, f.ctr[0] * k, -f.ctr[1] * k); gl.uniform1f(u.uGlass, f.glass);
    gl.uniform1f(u.uT, f.T); gl.uniform1f(u.uF, f.cam.f * k); gl.uniform1f(u.uFill, f.fill); gl.uniform1f(u.uPat, f.pat);
    gl.uniform1f(u.uScan, f.scan); gl.uniform1f(u.uFlash, f.flash); gl.uniform1f(u.uYaw, f.cam.yaw);
    gl.uniform3fv(u.uPos, f.cam.pos); gl.uniform3fv(u.uR, B.R); gl.uniform3fv(u.uU, B.Up); gl.uniform3fv(u.uFw, B.Fw); gl.uniform3fv(u.uSq, f.squash);
    gl.uniform3fv(u.uC0, f.colors[0]); gl.uniform3fv(u.uC1, f.colors[1]); gl.uniform3fv(u.uC2, f.colors[2]); gl.uniform3fv(u.uC3, f.colors[3]);
    gl.uniform3fv(u.uBgA, f.bgA); gl.uniform3fv(u.uBgB, f.bgB);
    const rip = new Float32Array(16), rc = new Float32Array(12);
    for (let i = 0; i < 4; i++) {
      const r = f.ripples[f.ripples.length - 1 - i];
      if (r) { rip.set([r.dir[0], r.dir[1], r.dir[2], r.t0], i * 4); rc.set(r.c, i * 3); } else rip.set([0, 1, 0, -99], i * 4);
    }
    gl.uniform4fv(u.uRip, rip); gl.uniform3fv(u.uRipC, rc);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /* ---------- Canvas 2D fallback: same camera, grid polylines, gradient ink ---------- */
  private draw2d(f: ForgeFrame): void {
    const c = this.ctx!, k = this.dpr, W = this.w, H = this.h;
    c.setTransform(k, 0, 0, k, 0, 0);
    const rgb = (x: Rgb, a = 1) => `rgba(${Math.round(x[0] * 255)},${Math.round(x[1] * 255)},${Math.round(x[2] * 255)},${a})`;
    const g = c.createLinearGradient(0, 0, 0, H); g.addColorStop(0, rgb(f.bgA)); g.addColorStop(1, rgb(f.bgB));
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    const B = basis(f.cam), P = f.cam.pos;
    const dist = Math.hypot(P[0], P[1], P[2]), inside = dist < 1;
    const proj = (x: number, y: number, z: number): [number, number, number] | null => {
      const d: V3 = [x - P[0], y - P[1], z - P[2]];
      const vz = d[0] * B.Fw[0] + d[1] * B.Fw[1] + d[2] * B.Fw[2];
      if (vz < 0.02) return null;
      const vx = d[0] * B.R[0] + d[1] * B.R[1] + d[2] * B.R[2], vy = d[0] * B.Up[0] + d[1] * B.Up[1] + d[2] * B.Up[2];
      return [W / 2 + f.ctr[0] + (f.cam.f * vx) / vz, H / 2 + f.ctr[1] - (f.cam.f * vy) / vz, vz];
    };
    const cx = W / 2 + f.ctr[0], cy = H / 2 + f.ctr[1];
    if (!inside) {
      const r = f.cam.f / Math.sqrt(Math.max(0.01, dist * dist - 1));
      // ink: a clipped gradient below the level
      c.save(); c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.clip();
      c.fillStyle = 'rgba(10,14,30,.55)'; c.fillRect(cx - r, cy - r, r * 2, r * 2);
      if (f.fill > 0.001 || f.glass < 1) {
        const top = cy + r - Math.max(f.fill, 1 - f.glass) * 2 * r;
        const lg = c.createLinearGradient(0, top, 0, cy + r); lg.addColorStop(0, rgb(f.colors[2], 0.9)); lg.addColorStop(0.5, rgb(f.colors[1], 0.9)); lg.addColorStop(1, rgb(f.colors[0], 0.95));
        c.fillStyle = lg; c.beginPath(); c.moveTo(cx - r, top);
        for (let x = 0; x <= 24; x++) c.lineTo(cx - r + (x / 24) * 2 * r, top + Math.sin(x * 0.7 + f.T * 1.5) * 4);
        c.lineTo(cx + r, cy + r); c.lineTo(cx - r, cy + r); c.fill();
      }
      c.restore();
    } else {
      const rg = c.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.7);
      rg.addColorStop(0, rgb(f.colors[0], 0.35)); rg.addColorStop(1, 'rgba(0,0,0,.6)');
      c.fillStyle = rg; c.fillRect(0, 0, W, H);
      if (f.fill > 0.001) { c.fillStyle = rgb(f.colors[1], 0.18 * f.fill); c.fillRect(0, H * (1 - f.fill * 0.5), W, H); }
    }
    // grid: latitude / longitude circles, front brighter than back (outside); all of it from inside
    c.lineWidth = 1;
    const line = (pts: Array<[number, number, number]>) => {
      for (let i = 1; i < pts.length; i++) {
        const [x, y, z] = pts[i - 1], [x2, y2, z2] = pts[i];
        const front = !inside && (x + x2) * (P[0]) + (y + y2) * P[1] + (z + z2) * P[2] > 0;
        const a = proj(x, y, z), b = proj(x2, y2, z2);
        if (!a || !b) continue;
        c.strokeStyle = inside ? `rgba(205,208,215,${0.4 * f.glass})` : front ? `rgba(215,218,225,${0.5 * f.glass})` : `rgba(205,208,215,${0.14 * f.glass})`;
        c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke();
      }
    };
    for (let la = -75; la <= 75; la += 15) {
      const t = (la * Math.PI) / 180, pts: Array<[number, number, number]> = [];
      for (let i = 0; i <= 48; i++) { const o = (i / 48) * Math.PI * 2; pts.push([Math.cos(t) * Math.cos(o), Math.sin(t), Math.cos(t) * Math.sin(o)]); }
      line(pts);
    }
    for (let lo = 0; lo < 360; lo += 15) {
      const o = (lo * Math.PI) / 180, pts: Array<[number, number, number]> = [];
      for (let i = 0; i <= 24; i++) { const t = -Math.PI / 2 + (i / 24) * Math.PI; pts.push([Math.cos(t) * Math.cos(o), Math.sin(t), Math.cos(t) * Math.sin(o)]); }
      line(pts);
    }
    if (!inside) {
      const r = f.cam.f / Math.sqrt(Math.max(0.01, dist * dist - 1));
      c.strokeStyle = `rgba(220,222,228,${0.6 * f.glass})`; c.lineWidth = 1.5; c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.stroke();
    } else {
      const v = c.createRadialGradient(cx, cy, Math.min(W, H) * 0.3, cx, cy, Math.max(W, H) * 0.75);
      v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,.55)'); c.fillStyle = v; c.fillRect(0, 0, W, H);
    }
    if (f.flash > 0.01) { c.fillStyle = `rgba(210,212,218,${f.flash * 0.2})`; c.fillRect(0, 0, W, H); }
  }
  /** screen radius of the sphere seen from outside (0 inside) */
  /** css px on screen of a world point (null behind the camera) - for tests and DOM overlays */
  static project(cam: ForgeCam, W: number, H: number, ctr: [number, number], p: V3): [number, number] | null {
    const B = basis(cam), d: V3 = [p[0] - cam.pos[0], p[1] - cam.pos[1], p[2] - cam.pos[2]];
    const vz = d[0] * B.Fw[0] + d[1] * B.Fw[1] + d[2] * B.Fw[2]; if (vz < 0.02) return null;
    const vx = d[0] * B.R[0] + d[1] * B.R[1] + d[2] * B.R[2], vy = d[0] * B.Up[0] + d[1] * B.Up[1] + d[2] * B.Up[2];
    return [W / 2 + ctr[0] + (cam.f * vx) / vz, H / 2 + ctr[1] - (cam.f * vy) / vz];
  }
  static radius(cam: ForgeCam): number { const d = Math.hypot(...cam.pos); return d > 1.001 ? cam.f / Math.sqrt(d * d - 1) : 0; }
}
