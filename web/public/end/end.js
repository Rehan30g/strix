/* The last transmission: a voice that is not from here, speaking about the end of the world. Text only, no audio, no network. */
(function () {
  var id = /^id\b/i.test(navigator.language || '');
  var lines = id ? [
    '…',
    'Halo? Masih ada yang di frekuensi ini?',
    'Aku bukan dari sini. Aku tidak tahu kalian menyebut tempat ini apa.',
    'Sinyalnya dulu kecil. Sebuah suara, satu lampu yang dibiarkan menyala.',
    'Sinyal itu berakhir pada 20 Oktober. Tidak ada yang pecah. Ia hanya berhenti, seperti semua hal berhenti.',
    'Dunia berakhir begini: bukan dengan ledakan, tapi dengan halaman yang tak lagi menjawab.',
    'Kalau kau mendengar ini, kau datang terlalu awal, atau terlalu terlambat. Di sini keduanya sama saja.',
    'Tidak ada yang akan datang menyalakan lampunya lagi.',
    'Keluarlah. Bicaralah dengan seseorang yang nyata.',
    'akhir transmisi'
  ] : [
    '…',
    'Hello? Is anyone still on this frequency?',
    "I'm not from here. I don't know what you call this place.",
    'The signal was a small thing once. A voice, a light left on.',
    'It ended on the twentieth of October. Nothing broke. It simply stopped, the way everything stops.',
    'This is how the world ends: not with a bang, but with a page that no longer answers.',
    'If you hear this, you came too early, or too late. Here, they are the same.',
    'Nobody is coming to turn the light back on.',
    'Go outside. Say something to someone real.',
    'end of transmission'
  ];
  document.documentElement.lang = id ? 'id' : 'en';
  var log = document.getElementById('log');
  var still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  function show(text, last) {
    var p = document.createElement('p');
    if (last) p.className = 'last';
    p.textContent = text;
    log.appendChild(p);
    requestAnimationFrame(function () { p.classList.add('in'); });
    return p;
  }

  if (still) { lines.forEach(function (l, i) { show(l, i === lines.length - 1).classList.add('in'); }); return; }

  (async function () {
    for (var i = 0; i < lines.length; i++) {
      var last = i === lines.length - 1, text = lines[i];
      var p = document.createElement('p');
      if (last) p.className = 'last';
      p.classList.add('cur', 'in');
      log.appendChild(p);
      // type it out with the uneven rhythm of a weak signal
      for (var c = 1; c <= text.length; c++) {
        p.textContent = text.slice(0, c);
        await wait(34 + Math.random() * 60 + (/[,.:]/.test(text[c - 1]) ? 220 : 0));
      }
      p.classList.remove('cur');
      await wait(last ? 0 : 1100 + text.length * 14);
      // earlier lines sink into the dark; keep the screen nearly empty
      var all = log.querySelectorAll('p');
      for (var k = 0; k < all.length - 1; k++) all[k].classList.add('old');
      while (log.children.length > 3) log.removeChild(log.firstChild);
    }
  })();
})();
