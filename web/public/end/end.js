/* The last transmission: a voice that is not from here, rambling about the end of the world. Text only, no audio, no network. English only. */
(function () {
  var lines = [
    '...',
    'hello? is anyone still here?',
    "ok. i'm not from around here. i don't even know what you call this place.",
    'there used to be a little signal here. a voice, a light somebody forgot to turn off.',
    'it stopped on october 20th. nothing exploded. it just kind of... stopped. like everything does eventually.',
    "so that's how the world ends, i guess. not a big bang. just a page that doesn't answer anymore.",
    "if you're reading this you're either way too early or way too late. honestly it's the same from here.",
    "nobody's coming back to switch the light on, sorry.",
    'go outside. talk to a real person or something.',
    'end of transmission'
  ];
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
      var all = log.querySelectorAll('p');
      for (var k = 0; k < all.length - 1; k++) all[k].classList.add('old');
      while (log.children.length > 3) log.removeChild(log.firstChild);
    }
  })();
})();
