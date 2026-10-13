/* WebGL programs that never freeze the page.
   Compiling a big fragment shader (the orb shader: fbm, nested loops) can take SECONDS inside ANGLE / D3D, and the
   usual compileShader + getShaderParameter + linkProgram + getProgramParameter sequence blocks the main thread for all
   of it. Here:
   - with KHR_parallel_shader_compile, compile and link are queued and nothing asks for their status until
     COMPLETION_STATUS_KHR says they are done (polled once per frame / timer), so the page keeps running;
   - without the extension the status query (the blocking part) is deferred to an idle moment, so it never lands on a
     click or the first paint.
   Callers draw a fallback (a DOM / 2D orb) until `ready`. Test hook: window.__noParallelGL = true disables the
   extension. */
export type ProgState = 'pending' | 'ok' | 'fail';
export interface ProgJob { prog: WebGLProgram; state: ProgState; error: string; done: Promise<boolean>; parallel: boolean }

interface ParallelExt { COMPLETION_STATUS_KHR: number }
const idle = (fn: () => void) => {
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(fn, { timeout: 1500 }); else setTimeout(fn, 60);
};
/** Queue a program build; resolves `done` (true = usable) without blocking when the extension is there. */
export function buildProgram(gl: WebGLRenderingContext, vs: string, fs: string, label = 'program'): ProgJob {
  const noExt = !!(window as unknown as { __noParallelGL?: boolean }).__noParallelGL;
  const ext = noExt ? null : (gl.getExtension('KHR_parallel_shader_compile') as ParallelExt | null);
  const mk = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const v = mk(gl.VERTEX_SHADER, vs), f = mk(gl.FRAGMENT_SHADER, fs);
  const prog = gl.createProgram()!;
  gl.attachShader(prog, v); gl.attachShader(prog, f); gl.linkProgram(prog);
  let resolve: (ok: boolean) => void = () => {};
  const job: ProgJob = { prog, state: 'pending', error: '', done: new Promise<boolean>((r) => { resolve = r; }), parallel: !!ext };
  const finish = () => {
    // the only blocking query: by now the driver has finished (parallel) or we are idle (no extension)
    if (gl.isContextLost()) { job.state = 'fail'; job.error = 'context lost'; resolve(false); return; }
    const ok = !!gl.getProgramParameter(prog, gl.LINK_STATUS);
    if (!ok) {
      job.error = (gl.getShaderInfoLog(f) || '') + (gl.getShaderInfoLog(v) || '') + (gl.getProgramInfoLog(prog) || '');
      console.warn(`${label}: shader failed`, job.error.slice(0, 400));
    }
    job.state = ok ? 'ok' : 'fail';
    resolve(ok);
  };
  if (ext) {
    const poll = () => {
      if (gl.isContextLost()) { finish(); return; }
      if (gl.getProgramParameter(prog, ext.COMPLETION_STATUS_KHR)) finish();
      else if (document.hidden) setTimeout(poll, 50); else requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  } else idle(finish);
  return job;
}
