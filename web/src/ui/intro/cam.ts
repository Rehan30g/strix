/* The tour's 3D camera, done by hand so the DOM panels (CSS matrix3d) and the canvas orbs share ONE projection.
   World units = CSS px of a panel at scale 1; x right, y down, z into the screen. A pinhole camera with focal length
   f (px) and principal point (cx, cy): screen = (cx + f*x/z, cy + f*y/z) in view space.
   Panels are flat cards placed on an arc; each gets a full projective matrix3d (no CSS perspective, no preserve-3d),
   so a panel can tilt, recede and blur while every orb is drawn separately on the canvas at its projected centre and
   stays a perfect circle. */
export type V3 = [number, number, number];
export interface Pose { p: V3; yaw: number; pitch: number; tgt: V3 }
export interface View { W: number; H: number; cx: number; cy: number; f: number; C: V3; R: V3; D: V3; F: V3 }
export interface Place { c: V3; a: number; w: number; h: number }
export interface Rect { x: number; y: number; w: number; h: number }

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const mix = (a: V3, b: V3, k: number): V3 => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** camera basis for yaw (around y) and pitch (positive = looking down) */
export function view(pose: Pose, W: number, H: number, cx: number, cy: number, f: number): View {
  const cp = Math.cos(pose.pitch), sp = Math.sin(pose.pitch), cyw = Math.cos(pose.yaw), syw = Math.sin(pose.yaw);
  const F: V3 = [syw * cp, sp, cyw * cp];
  const R: V3 = [cyw, 0, -syw];
  const D = cross(F, R);
  return { W, H, cx, cy, f, C: pose.p, R, D, F };
}
/** panel axes: right, down, forward (the panel's front faces -forward) */
export function axes(a: number): [V3, V3, V3] {
  return [[Math.cos(a), 0, -Math.sin(a)], [0, 1, 0], [Math.sin(a), 0, Math.cos(a)]];
}
/** world point of panel-local (u, v) measured from the panel's top-left, z towards the viewer */
export function local(pl: Place, u: number, v: number, z = 0): V3 {
  const [R, D, F] = axes(pl.a);
  return add(add(add(pl.c, mul(R, u - pl.w / 2)), mul(D, v - pl.h / 2)), mul(F, -z));
}
export function toView(v: View, P: V3): V3 { const d = sub(P, v.C); return [dot(d, v.R), dot(d, v.D), dot(d, v.F)]; }
/** screen position + scale (px per world unit) of a world point; null when behind the camera */
export function project(v: View, P: V3): { x: number; y: number; z: number; s: number } | null {
  const q = toView(v, P);
  if (q[2] < 1) return null;
  return { x: v.cx + (v.f * q[0]) / q[2], y: v.cy + (v.f * q[1]) / q[2], z: q[2], s: v.f / q[2] };
}
/** CSS matrix3d (column-major) that maps the panel element (transform-origin 0 0 at the layer's top-left) onto the
    screen; null when any corner is behind / too close to the camera */
export function matrix(v: View, pl: Place): string | null {
  const [Rp, Dp, Fp] = axes(pl.a);
  const o = sub(add(add(pl.c, mul(Rp, -pl.w / 2)), mul(Dp, -pl.h / 2)), v.C);
  const row = (B: V3): [number, number, number, number] => [dot(Rp, B), dot(Dp, B), -dot(Fp, B), dot(o, B)];
  const X = row(v.R), Y = row(v.D), Z = row(v.F);
  for (const [u, w] of [[0, 0], [pl.w, 0], [0, pl.h], [pl.w, pl.h]]) if (Z[0] * u + Z[1] * w + Z[3] < 8) return null;
  const f = v.f, cx = v.cx, cy = v.cy;
  const M = [0, 1, 2, 3].map((j) => [f * X[j] + cx * Z[j], f * Y[j] + cy * Z[j], j === 2 ? 1 : 0, Z[j]]);
  return 'matrix3d(' + M.flat().map((n) => +n.toFixed(6)).join(',') + ')';
}
/** the camera pose that frames `rect` (panel-local) at `s` px per world unit, looking straight at the panel */
export function frame(pl: Place, rect: Rect, s: number, f: number): Pose {
  const tgt = local(pl, rect.x + rect.w / 2, rect.y + rect.h / 2);
  const [, , F] = axes(pl.a);
  return { p: sub(tgt, mul(F, f / s)), yaw: pl.a, pitch: 0, tgt };
}
/** pose blend; `arc` pulls the camera back (dolly out) and dips it (pedestal) in the middle of a flight */
export function blend(a: Pose, b: Pose, k: number, arc = 0, f = 1000): Pose {
  const bump = Math.sin(Math.PI * k);
  const yaw = a.yaw + (b.yaw - a.yaw) * k, pitch = a.pitch + (b.pitch - a.pitch) * k + arc * 0.00011 * bump;
  const F: V3 = [Math.sin(yaw), 0, Math.cos(yaw)];
  return { p: add(mix(a.p, b.p, k), add(mul(F, -arc * bump), [0, -arc * 0.18 * bump * (f / 1000), 0])), yaw, pitch, tgt: mix(a.tgt, b.tgt, k) };
}
/** is the screen point inside the projected quad of a panel (for orb occlusion) */
export function inQuad(v: View, pl: Place, x: number, y: number): boolean {
  const c = [local(pl, 0, 0), local(pl, pl.w, 0), local(pl, pl.w, pl.h), local(pl, 0, pl.h)].map((P) => project(v, P));
  if (c.some((p) => !p)) return false;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = c[i]!, b = c[(i + 1) % 4]!;
    const cr = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    const sg = Math.sign(cr);
    if (sg && sign && sg !== sign) return false;
    if (sg) sign = sg;
  }
  return true;
}
