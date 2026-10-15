#!/usr/bin/env node
/* i18n helper for the web UI (no dependencies).
   Keys are the Indonesian source strings passed to t('...') in web/src/**\/*.ts; English lives in web/src/i18n/en.json.

     node scripts/i18n.mjs check [--strict]   report missing / unused / placeholder mismatches / empty / dynamic keys
     node scripts/i18n.mjs todo               write web/src/i18n/todo.json = { "<missing key>": "" } (keeps filled ones)
     node scripts/i18n.mjs merge              merge filled entries of todo.json into en.json (validated), drop them from todo
     node scripts/i18n.mjs keys               print every key found in code (one JSON string per line)

   --strict: exit 1 when keys are missing, placeholders differ, values are empty or a t() call is not a plain literal.
   A t() call whose first argument is not a single literal ('..', "..", or `..` without ${}) is reported as dynamic;
   put `// i18n-ignore` on that line if it is intentional. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'web', 'src');
const EN = path.join(SRC, 'i18n', 'en.json');
const TODO = path.join(SRC, 'i18n', 'todo.json');

/* ---------- source scan ---------- */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const ESC = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
/** Read a quoted literal starting at src[i] (the quote). Returns { value, end, interp } (end = index after the quote). */
function readLiteral(src, i) {
  const q = src[i]; let v = '', j = i + 1, interp = false;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') {
      const n = src[j + 1];
      if (n === 'u') {
        if (src[j + 2] === '{') { const k = src.indexOf('}', j); v += String.fromCodePoint(parseInt(src.slice(j + 3, k), 16)); j = k + 1; }
        else { v += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)); j += 6; }
      } else if (n === 'x') { v += String.fromCharCode(parseInt(src.slice(j + 2, j + 4), 16)); j += 4; }
      else if (n === '\r' || n === '\n') { j += n === '\r' && src[j + 2] === '\n' ? 3 : 2; }   // line continuation
      else { v += ESC[n] ?? n; j += 2; }
      continue;
    }
    if (c === q) return { value: v, end: j + 1, interp };
    if (q === '`' && c === '$' && src[j + 1] === '{') interp = true;
    if (q !== '`' && (c === '\n' || c === '\r')) break;   // unterminated
    v += c; j++;
  }
  return { value: v, end: j, interp };
}

const REGEX_PREV = new Set([...'(,=:[!&|?{};+-*%<>~^']);
const REGEX_KW = /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|void|yield|await)\s*$/;

/** Find t( calls in one file. Comments, strings, templates and regex literals are skipped. */
function scanFile(file) {
  const src = fs.readFileSync(file, 'utf8');
  const calls = [];
  const stack = [];                 // '{' = code brace, '`' = template expression
  let i = 0, lastSig = '';
  const lineAt = (k) => { let n = 1; for (let x = 0; x < k; x++) if (src[x] === '\n') n++; return n; };
  // template body reader used both at a backtick and when a ${ } closes
  const readTemplateBody = (k) => {
    while (k < src.length) {
      const c = src[k];
      if (c === '\\') { k += 2; continue; }
      if (c === '`') return k + 1;
      if (c === '$' && src[k + 1] === '{') { stack.push('`'); return k + 2; }
      k++;
    }
    return k;
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '\n' || c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === '\'' || c === '"') { i = readLiteral(src, i).end; lastSig = 'x'; continue; }
    if (c === '`') { i = readTemplateBody(i + 1); lastSig = 'x'; continue; }
    if (c === '{') { stack.push('{'); i++; lastSig = '{'; continue; }
    if (c === '}') { const top = stack.pop(); i++; if (top === '`') { i = readTemplateBody(i); lastSig = 'x'; } else lastSig = '}'; continue; }
    if (c === '/') {
      const before = src.slice(Math.max(0, i - 12), i);
      if (!lastSig || REGEX_PREV.has(lastSig) || REGEX_KW.test(before)) {
        let j = i + 1, cls = false;
        while (j < src.length && src[j] !== '\n') {
          const d = src[j];
          if (d === '\\') { j += 2; continue; }
          if (d === '[') cls = true; else if (d === ']') cls = false; else if (d === '/' && !cls) break;
          j++;
        }
        i = j + 1; while (/[a-z]/.test(src[i] || '')) i++;
        lastSig = 'x'; continue;
      }
      i++; lastSig = '/'; continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i; while (j < src.length && /[\w$]/.test(src[j])) j++;
      const word = src.slice(i, j);
      if (word === 't' && src[i - 1] !== '.' ) {
        let k = j; while (src[k] === ' ' || src[k] === '\t') k++;
        const prevWord = /(\w+)\s*$/.exec(src.slice(Math.max(0, i - 20), i))?.[1];
        if (src[k] === '(' && prevWord !== 'function') {
          let a = k + 1; while (/\s/.test(src[a] || '')) a++;
          const lineText = src.slice(src.lastIndexOf('\n', i) + 1, src.indexOf('\n', i) < 0 ? src.length : src.indexOf('\n', i));
          const ignore = lineText.includes('i18n-ignore');
          const q = src[a];
          let ok = false, key = '';
          if (q === '\'' || q === '"' || q === '`') {
            const lit = readLiteral(src, a);
            let b = lit.end; while (/\s/.test(src[b] || '')) b++;
            if (!lit.interp && (src[b] === ',' || src[b] === ')')) { ok = true; key = lit.value.replace(/\r\n/g, '\n'); }
          }
          calls.push({ file, line: lineAt(i), key, ok, ignore });
        }
      }
      i = j; lastSig = 'x'; continue;
    }
    lastSig = c; i++;
  }
  return calls;
}

function scan() {
  const calls = [];
  for (const f of walk(SRC)) calls.push(...scanFile(f));
  return calls;
}

/* ---------- table helpers ---------- */
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { if (fs.existsSync(p)) { console.error(`cannot parse ${path.relative(ROOT, p)}: ${e.message}`); process.exit(2); } return d; } };
const sortObj = (o) => Object.fromEntries(Object.keys(o).sort((a, b) => a.localeCompare(b, 'id')).map((k) => [k, o[k]]));
const writeJson = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n'); };
const holes = (s) => [...new Set([...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort().join(',');
const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/');
const show = (s) => JSON.stringify(s.length > 90 ? s.slice(0, 87) + '...' : s);

/* ---------- commands ---------- */
const [cmd = 'check', ...flags] = process.argv.slice(2);
const strict = flags.includes('--strict');

if (cmd === 'keys') {
  const keys = [...new Set(scan().filter((c) => c.ok).map((c) => c.key))];
  for (const k of keys) console.log(JSON.stringify(k));
  process.exit(0);
}

if (cmd === 'check') {
  const calls = scan();
  const en = readJson(EN, {});
  const used = new Map();
  for (const c of calls) if (c.ok && !used.has(c.key)) used.set(c.key, c);
  const missing = [...used.keys()].filter((k) => !(k in en));
  const unused = Object.keys(en).filter((k) => !used.has(k));
  const mismatch = Object.entries(en).filter(([k, v]) => typeof v === 'string' && v && holes(k) !== holes(v));
  const empty = Object.entries(en).filter(([, v]) => typeof v !== 'string' || !v.trim());
  const dynamic = calls.filter((c) => !c.ok && !c.ignore);
  const sec = (title, list, fmt) => { if (!list.length) return; console.log(`\n${title} (${list.length})`); for (const x of list) console.log('  ' + fmt(x)); };
  sec('Missing in en.json', missing, (k) => `${show(k)}  ${rel(used.get(k).file)}:${used.get(k).line}`);
  sec('Placeholder mismatch', mismatch, ([k, v]) => `${show(k)} {${holes(k)}} -> {${holes(v)}} ${show(v)}`);
  sec('Empty value', empty, ([k]) => show(k));
  sec('Not a plain literal (dynamic key)', dynamic, (c) => `${rel(c.file)}:${c.line}`);
  sec('Unused in en.json', unused, (k) => show(k));
  console.log(`\n${used.size} keys in code, ${Object.keys(en).length} in en.json: ${missing.length} missing, ${unused.length} unused, ${mismatch.length} placeholder mismatches, ${empty.length} empty, ${dynamic.length} dynamic.`);
  if (strict && (missing.length || mismatch.length || empty.length || dynamic.length)) process.exit(1);
  process.exit(0);
}

if (cmd === 'todo') {
  const en = readJson(EN, {});
  const prev = readJson(TODO, {});
  const out = {};
  for (const c of scan()) if (c.ok && !(c.key in en) && !(c.key in out)) out[c.key] = typeof prev[c.key] === 'string' ? prev[c.key] : '';
  writeJson(TODO, out);
  console.log(`${rel(TODO)}: ${Object.keys(out).length} strings to translate.`);
  process.exit(0);
}

if (cmd === 'merge') {
  const en = readJson(EN, {});
  const todo = readJson(TODO, null);
  if (!todo) { console.error(`no ${rel(TODO)}; run "todo" first`); process.exit(2); }
  const left = {}; let added = 0, bad = 0;
  for (const [k, v] of Object.entries(todo)) {
    if (typeof v !== 'string' || !v.trim()) { left[k] = ''; continue; }
    if (holes(k) !== holes(v)) { console.error(`placeholder mismatch, kept in todo: ${show(k)} {${holes(k)}} -> {${holes(v)}}`); left[k] = v; bad++; continue; }
    en[k] = v; added++;
  }
  writeJson(EN, sortObj(en));
  if (Object.keys(left).length) writeJson(TODO, left); else fs.rmSync(TODO, { force: true });
  console.log(`merged ${added} into ${rel(EN)} (${Object.keys(en).length} keys); ${Object.keys(left).length} left in todo${bad ? `, ${bad} with placeholder errors` : ''}.`);
  process.exit(bad ? 1 : 0);
}

console.error('usage: node scripts/i18n.mjs check [--strict] | todo | merge | keys');
process.exit(2);
