/**
 * Tiny dependency-free audio sniffing + duration probing for uploads (Voice Changer).
 * Durations are best effort: exact for WAV/FLAC/Ogg/MP4, header-based for MP3 (Xing/VBRI or CBR),
 * null when unknown (e.g. MediaRecorder WebM without a Duration element).
 */

export type AudioKind = 'mp3' | 'wav' | 'ogg' | 'webm' | 'flac' | 'mp4' | 'aac';

const ascii = (b: Buffer, at: number, len: number) => (b.length >= at + len ? b.toString('latin1', at, at + len) : '');

/* ---------------- MP3 ---------------- */
const BITRATES: Record<string, number[]> = {
  // [versionGroup][layer] -> kbps by index
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const SAMPLE_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

interface MpegFrame { at: number; len: number; bitrate: number; sampleRate: number; spf: number; version: number; mono: boolean }

function mpegFrame(b: Buffer, i: number): MpegFrame | null {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const version = (b[i + 1] >> 3) & 3; // 0=2.5 1=reserved 2=v2 3=v1
  const layerBits = (b[i + 1] >> 1) & 3; // 1=III 2=II 3=I 0=reserved
  const brIdx = b[i + 2] >> 4;
  const srIdx = (b[i + 2] >> 2) & 3;
  if (version === 1 || layerBits === 0 || brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
  const layer = 4 - layerBits; // 1..3
  const vg = version === 3 ? '1' : '2';
  const table = BITRATES[`${vg}-${vg === '2' && layer > 1 ? 2 : layer}`];
  const bitrate = table[brIdx] * 1000;
  const sampleRate = SAMPLE_RATES[version][srIdx];
  const pad = (b[i + 2] >> 1) & 1;
  const spf = layer === 1 ? 384 : layer === 2 || version === 3 ? 1152 : 576;
  const len = layer === 1 ? (Math.floor((12 * bitrate) / sampleRate) + pad) * 4 : Math.floor(((spf / 8) * bitrate) / sampleRate) + pad;
  if (len < 24) return null;
  return { at: i, len, bitrate, sampleRate, spf, version, mono: (b[i + 3] >> 6) === 3 };
}

function id3Skip(b: Buffer) {
  if (ascii(b, 0, 3) !== 'ID3' || b.length < 10) return 0;
  const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
  return 10 + size + (b[5] & 0x10 ? 10 : 0);
}

/** First MPEG audio frame that is followed by another valid frame (avoids false syncs). */
function firstMpegFrame(b: Buffer): MpegFrame | null {
  const start = id3Skip(b);
  const end = Math.min(b.length - 4, start + 64 * 1024);
  for (let i = start; i < end; i++) {
    const f = mpegFrame(b, i);
    if (!f) continue;
    const next = f.at + f.len;
    if (next + 4 > b.length || mpegFrame(b, next)) return f;
  }
  return null;
}

function mp3Duration(b: Buffer, f: MpegFrame): number | null {
  // Xing/Info (VBR or LAME CBR) header in the first frame
  const sideInfo = f.version === 3 ? (f.mono ? 17 : 32) : (f.mono ? 9 : 17);
  const x = f.at + 4 + sideInfo;
  const tag = ascii(b, x, 4);
  if ((tag === 'Xing' || tag === 'Info') && b.length >= x + 12 && (b.readUInt32BE(x + 4) & 1)) {
    const frames = b.readUInt32BE(x + 8);
    if (frames > 0) return (frames * f.spf) / f.sampleRate;
  }
  if (ascii(b, f.at + 36, 4) === 'VBRI' && b.length >= f.at + 36 + 18) {
    const frames = b.readUInt32BE(f.at + 36 + 14);
    if (frames > 0) return (frames * f.spf) / f.sampleRate;
  }
  // assume CBR
  let audioBytes = b.length - f.at;
  if (ascii(b, b.length - 128, 3) === 'TAG') audioBytes -= 128;
  return (audioBytes * 8) / f.bitrate;
}

/* ---------------- MP3 frame splitting / joining (dialogue concat, no decoding) ---------------- */
export interface Mp3Audio {
  /** audio frames only (ID3v1/v2 tags and the Xing/Info/VBRI header frame removed) */
  frames: Buffer[];
  sampleRate: number;
  /** samples per frame (1152 for MPEG-1 Layer III) */
  spf: number;
  /** a copy of the first audio frame's 4-byte header (template for silent frames) */
  header: Buffer;
  mono: boolean;
  bitrate: number;
  version: number;
}

const isInfoFrame = (b: Buffer, f: MpegFrame) => {
  const sideInfo = f.version === 3 ? (f.mono ? 17 : 32) : (f.mono ? 9 : 17);
  const tag = ascii(b, f.at + 4 + sideInfo, 4);
  return tag === 'Xing' || tag === 'Info' || ascii(b, f.at + 36, 4) === 'VBRI';
};

/**
 * Split an MP3 into its frames (decode-less). Strips ID3v2 / ID3v1 tags and the Xing/Info header frame so several
 * files can be joined into one valid stream. Throws when the buffer is not a parseable MPEG audio stream.
 */
export function splitMp3(b: Buffer): Mp3Audio {
  const first = firstMpegFrame(b);
  if (!first) throw new Error('not an mp3 stream');
  let end = b.length;
  if (ascii(b, b.length - 128, 3) === 'TAG') end -= 128;
  const frames: Buffer[] = [];
  let i = first.at;
  let ref: MpegFrame | null = null;
  while (i + 4 <= end) {
    const f = mpegFrame(b, i);
    if (!f || (ref && (f.sampleRate !== ref.sampleRate || f.version !== ref.version))) {
      // resync (garbage between frames); stop at the first trailing junk we can't skip
      let j = i + 1;
      while (j + 4 <= end && !mpegFrame(b, j)) j++;
      if (j + 4 > end) break;
      i = j;
      continue;
    }
    if (f.at + f.len > end) break; // truncated last frame: drop it
    if (frames.length || !isInfoFrame(b, f)) {
      if (!ref) ref = f;
      frames.push(b.subarray(f.at, f.at + f.len));
    }
    i = f.at + f.len;
  }
  if (!ref || !frames.length) throw new Error('mp3 stream has no audio frames');
  return { frames, sampleRate: ref.sampleRate, spf: ref.spf, header: Buffer.from(b.subarray(ref.at, ref.at + 4)), mono: ref.mono, bitrate: ref.bitrate, version: ref.version };
}

/**
 * One valid SILENT frame with the same format as `header` (Layer III): header (padding off, no CRC), all-zero side
 * info (part2_3_length = 0, global gain 0, main_data_begin = 0) and zero main data -> decodes to digital silence and
 * never references the bit reservoir, so it can sit between frames of independently encoded files.
 */
export function silentMp3Frame(header: Buffer): Buffer {
  const h = Buffer.from(header);
  h[1] |= 0x01; // protection bit 1 = no CRC
  h[2] &= ~0x02; // padding off
  const f = mpegFrame(Buffer.concat([h, Buffer.alloc(64)]), 0);
  if (!f) throw new Error('bad mp3 header template');
  const out = Buffer.alloc(f.len);
  h.copy(out, 0);
  return out;
}

/* ---------------- WAV ---------------- */
function wavDuration(b: Buffer): number | null {
  let byteRate = 0;
  let dataSize = 0;
  let dataAt = 0;
  for (let i = 12; i + 8 <= b.length;) {
    const id = ascii(b, i, 4);
    const size = b.readUInt32LE(i + 4);
    if (id === 'fmt ' && i + 20 <= b.length) byteRate = b.readUInt32LE(i + 16);
    if (id === 'data') { dataSize = size; dataAt = i + 8; break; }
    i += 8 + size + (size & 1);
  }
  if (!byteRate || !dataAt) return null;
  const available = b.length - dataAt;
  if (!dataSize || dataSize === 0xffffffff || dataSize > available) dataSize = available; // streamed/truncated header
  return dataSize / byteRate;
}

/* ---------------- Ogg (Opus / Vorbis) ---------------- */
function oggDuration(b: Buffer): number | null {
  let rate = 0;
  let preSkip = 0;
  const opus = b.indexOf('OpusHead', 0, 'latin1');
  if (opus >= 0 && opus < 512 && b.length >= opus + 12) { rate = 48000; preSkip = b.readUInt16LE(opus + 10); }
  const vorbis = b.indexOf('\x01vorbis', 0, 'latin1');
  if (!rate && vorbis >= 0 && vorbis < 512 && b.length >= vorbis + 16) rate = b.readUInt32LE(vorbis + 12);
  if (!rate) return null;
  // granule position of the last page
  const last = b.lastIndexOf('OggS', b.length - 27, 'latin1');
  if (last < 0) return null;
  const granule = Number(b.readBigUInt64LE(last + 6));
  if (!Number.isFinite(granule) || granule <= 0 || granule > 2 ** 52) return null;
  return Math.max(0, granule - preSkip) / rate;
}

/* ---------------- FLAC ---------------- */
function flacDuration(b: Buffer): number | null {
  const d = 8; // "fLaC" + metadata block header; STREAMINFO is always first
  if (b.length < d + 18) return null;
  const sr = (b[d + 10] << 12) | (b[d + 11] << 4) | (b[d + 12] >> 4);
  const total = (b[d + 13] & 0x0f) * 2 ** 32 + b.readUInt32BE(d + 14);
  return sr && total ? total / sr : null;
}

/* ---------------- MP4 / M4A ---------------- */
function mp4Duration(b: Buffer): number | null {
  const i = b.indexOf('mvhd', 0, 'latin1');
  if (i < 4 || b.length < i + 32) return null;
  const v = b[i + 4];
  const scale = v === 1 ? b.readUInt32BE(i + 24) : b.readUInt32BE(i + 16);
  const dur = v === 1 ? Number(b.readBigUInt64BE(i + 28)) : b.readUInt32BE(i + 20);
  return scale && dur && dur !== 0xffffffff ? dur / scale : null;
}

/* ---------------- WebM (Segment Info Duration, rarely present for MediaRecorder) ---------------- */
function webmDuration(b: Buffer): number | null {
  const head = b.subarray(0, Math.min(b.length, 64 * 1024));
  let scale = 1_000_000; // TimecodeScale default (ns)
  const ts = head.indexOf(Buffer.from([0x2a, 0xd7, 0xb1]));
  if (ts >= 0) {
    const len = head[ts + 3] & 0x7f; // 1-byte vint size (0x8N)
    if ((head[ts + 3] & 0x80) && len >= 1 && len <= 8) scale = head.readUIntBE(ts + 4, Math.min(len, 6));
  }
  const du = head.indexOf(Buffer.from([0x44, 0x89]));
  if (du < 0) return null;
  const size = head[du + 2];
  let ticks: number | null = null;
  if (size === 0x88 && head.length >= du + 11) ticks = head.readDoubleBE(du + 3);
  else if (size === 0x84 && head.length >= du + 7) ticks = head.readFloatBE(du + 3);
  if (ticks == null || !Number.isFinite(ticks) || ticks <= 0) return null;
  return (ticks * scale) / 1e9;
}

/** Identify the container/codec from magic bytes. null = not a supported audio file. */
export function sniffAudio(b: Buffer): AudioKind | null {
  if (b.length < 12) return null;
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WAVE') return 'wav';
  if (ascii(b, 0, 4) === 'OggS') return 'ogg';
  if (ascii(b, 0, 4) === 'fLaC') return 'flac';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
  if (ascii(b, 4, 4) === 'ftyp') return 'mp4';
  if (ascii(b, 0, 3) === 'ID3' || firstMpegFrame(b)) return 'mp3';
  if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return 'aac'; // ADTS
  return null;
}

/** Best-effort duration in seconds, or null when the container doesn't say. */
export function probeDuration(b: Buffer, kind: AudioKind): number | null {
  try {
    let d: number | null = null;
    switch (kind) {
      case 'mp3': { const f = firstMpegFrame(b); d = f ? mp3Duration(b, f) : null; break; }
      case 'wav': d = wavDuration(b); break;
      case 'ogg': d = oggDuration(b); break;
      case 'flac': d = flacDuration(b); break;
      case 'mp4': d = mp4Duration(b); break;
      case 'webm': d = webmDuration(b); break;
      default: d = null;
    }
    return d != null && Number.isFinite(d) && d > 0 && d < 24 * 3600 ? d : null;
  } catch {
    return null;
  }
}
