# v2 LITE — rombak jadi sederhana (menggantikan cakupan fitur di SPEC.md)

Keputusan user: aplikasi terlalu kompleks. Sisakan HANYA 4 fitur:
1. **TTS** (teks → suara, ElevenLabs `eleven_v4_turbo`, audio tag, tune, unduh mp3, riwayat singkat)
2. **Clone Voice** (upload/rekam sampel → Instant Voice Clone, daftar suara, preview, hapus)
3. **Voice Changer** (BARU: upload/rekam audio → diubah ke suara lain = ElevenLabs speech-to-speech, unduh mp3)
4. **Chat AI Persona** (chat dengan persona; opsional dibacakan TTS dengan suara pilihan)

Tetap dipertahankan (infrastruktur): login Google + kode undangan (1–4 pemakaian) + sesi, kuota per user, panel Admin MINIMAL (buat/cabut kode, daftar user, suspend, override kuota), sync settings, build/deploy files.

DIBUANG dari UI dan server: layar Coffee/agent, Voice call, Roleplay klasik (digantikan Chat Persona), halaman Settings besar (cukup sheet kecil), endpoint `/api/llm` generik. Jangan hapus permanen kode yang dibuang: PINDAHKAN ke `v2/_archive/` (di luar build, di luar tsconfig/vite include) supaya bisa dihidupkan lagi.

## Desain (hal terpenting)
- Bersih, minimalis, banyak ruang kosong, satu aksen warna, tipografi jelas, tanpa emoji (ikon SVG), light/dark otomatis + toggle.
- **Mobile first** (390px): bottom tab bar 4 tab (Chat, Suara/TTS, Changer, Voices) + avatar akun di pojok atas; satu kolom, target sentuh ≥44px, aman dari notch/keyboard (`env(safe-area-inset-*)`, `100dvh`), tidak ada scroll horizontal. Desktop (≥900px): tab bar jadi sidebar kiri ramping, konten dibatasi lebar nyaman (≈ 760px; Chat boleh dua kolom: daftar persona + percakapan).
- Alur satu langkah per layar; tidak ada panel pengaturan yang menumpuk — opsi lanjutan dalam bagian "Lanjutan" yang tertutup default.
- Skeleton/loading, error ramah (pesan Indonesia), empty state yang jelas, animasi halus dan singkat (hormati prefers-reduced-motion).

## Persona Chat
Persona bawaan (ambil dari `../characters.js` dan persona Coffee lama di `v2/web/src/screens/coffee/prompts.ts`): Barista, Pewawancara galak (tool `end_interview` tetap), Detektif, Teman, Tsundere, Mr. Wolf (karismatik), Bandit Heeler-ish (ramah santai) — tanpa nama merek berhak cipta di UI bila ragu, cukup "gaya"-nya. Pengguna bisa **buat persona sendiri** (nama, deskripsi/sifat, aksen, bahasa, suara default) — disimpan per user via `/api/settings`. Bahasa default Inggris, bisa diganti. Audio tag `[..]` dan disfluency natural (uh, umm) tetap ada bila "Bacakan" nyala; tag tidak ditampilkan di layar. Streaming balasan + TTS streaming per kalimat seperti sebelumnya (pakai `player.ts`).

## Voice Changer (kontrak API baru)
`POST /api/vc` multipart: `file` (audio ≤ `MAX_VC_UPLOAD_MB`=15, ≤ ~5 menit), `voiceId` (premade/library atau milik sendiri), `model` (default `eleven_multilingual_sts_v2`; opsi `eleven_english_sts_v2`), `removeBackgroundNoise` (bool), `stability`, `similarity`, `style` (opsional) → `audio/mpeg` (attachment bila `?download=1`). Upstream: ElevenLabs `POST /v1/speech-to-speech/{voice_id}` (periksa dokumentasi terbaru; pakai `output_format=mp3_44100_128`). Kuota baru `QUOTA_VC_SEC_PER_DAY=600` (detik audio masukan; hitung dari durasi kasar: ukuran/bitrate atau minta klien kirim `durationSec`, validasi sisi server sebaik mungkin) → 429 `{error:'quota',kind:'vc'}`. `/api/me` quota menyertakan `vc`. Validasi voice milik user sama seperti TTS. Tambahkan tabel/kolom usage `vc_sec` (migrasi aman untuk DB yang ada). Voice Changer UI: pilih sumber (upload / rekam dari mic dengan tombol besar), pilih suara target, tombol Ubah, putar hasil dan unduh, audio asli vs hasil bisa dibandingkan.

## Aturan kerja
- Hanya kerja di `v2/`. Jangan cetak/commit nilai rahasia. Uji dengan DEV_FAKE_LOGIN, port milikmu sendiri (backend 3300, Vite 5300), matikan hanya proses yang kamu mulai. Server preview user di port 3000 (DB `data/preview.db`) boleh dimatikan di awal oleh agent frontend setelah selesai membangun, lalu dijalankan ulang di akhir dengan perintah yang sama:
  `DB_FILE=data/preview.db QUOTA_LLM_REQ_PER_DAY=1000000 QUOTA_TTS_CHARS_PER_DAY=100000000 QUOTA_VC_SEC_PER_DAY=1000000 MAX_CLONES_PER_USER=20 npx tsx --env-file=.env server/index.ts` (setelah `npm run build:web`).
- Voice clone/changer: hanya dengan suara/sampel milik sendiri; consent checkbox tetap. Jangan membuat clone dari suara orang lain saat tes — tes Voice Changer pakai audio yang dihasilkan TTS sendiri; tes clone cukup validasi + (opsional) sampel TTS dari premade voice yang langsung dihapus setelah tes bila memang perlu.
- Laporkan jujur: terverifikasi vs tidak, perintah menjalankan.
