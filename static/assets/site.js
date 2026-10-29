(function () {
  'use strict';
  var BASE = document.body.getAttribute('data-base') || '';

  // old WordPress search links (?s=...) -> the new search page
  var sp = new URLSearchParams(location.search);
  if (sp.get('s') && !document.getElementById('search-results')) {
    location.replace(BASE + '/search/?q=' + encodeURIComponent(sp.get('s')));
    return;
  }

  // header search toggle
  var toggle = document.querySelector('.search-toggle');
  var box = document.getElementById('search-container');
  if (toggle && box) {
    toggle.addEventListener('click', function (e) {
      e.preventDefault();
      var open = box.classList.toggle('hide') === false;
      toggle.classList.toggle('active', open);
      toggle.querySelector('a').setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) { var f = box.querySelector('.search-field'); if (f) f.focus(); }
    });
  }

  // mobile menu
  var nav = document.getElementById('primary-navigation');
  var mt = nav && nav.querySelector('.menu-toggle');
  if (mt) {
    mt.addEventListener('click', function () {
      var on = nav.classList.toggle('toggled-on');
      mt.setAttribute('aria-expanded', on ? 'true' : 'false');
    });
  }

  // simple lightbox for links that point straight at an image
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('.entry-content a');
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey) return;
    var href = a.getAttribute('href') || '';
    if (!/\.(jpe?g|png|gif|webp|avif)(\?.*)?$/i.test(href) || !a.querySelector('img')) return;
    e.preventDefault();
    var lb = document.createElement('div');
    lb.className = 'mv-lightbox';
    var img = document.createElement('img');
    img.src = a.href;
    img.alt = '';
    lb.appendChild(img);
    lb.addEventListener('click', function () { lb.remove(); });
    document.addEventListener('keydown', function esc(ev) {
      if (ev.key === 'Escape') { lb.remove(); document.removeEventListener('keydown', esc); }
    });
    document.body.appendChild(lb);
  });

  // site search (search page only)
  var results = document.getElementById('search-results');
  if (!results) return;
  var params = new URLSearchParams(location.search);
  var q = (params.get('q') || '').trim();
  var input = document.querySelector('.search-page .search-field');
  if (input) input.value = q;
  if (!q) return;
  var title = document.getElementById('search-title');
  title.textContent = 'תוצאות חיפוש עבור: ' + q;
  document.title = 'חיפוש: ' + q + ' | ' + document.title.split(' | ').pop();
  results.innerHTML = '<p>מחפש…</p>';

  function norm(s) {
    return (s || '').toLowerCase()
      .replace(/[֑-ׇ]/g, '')                 // Hebrew points
      .replace(/["'`״׳“”„‘’\-–—:.,!?()\[\]]/g, ' ')
      .replace(/\s+/g, ' ');
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var months = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
  function hebDate(d) {
    var p = d.split('-');
    return +p[2] + ' ב' + months[+p[1] - 1] + ' ' + p[0];
  }

  fetch(BASE + '/search-index.json').then(function (r) { return r.json(); }).then(function (idx) {
    var terms = norm(q).split(' ').filter(Boolean);
    var hits = [];
    idx.forEach(function (p) {
      var t = norm(p.t), all = t + ' ' + norm(p.x) + ' ' + norm(p.c) + ' ' + norm(p.g);
      var score = 0;
      for (var i = 0; i < terms.length; i++) {
        if (all.indexOf(terms[i]) === -1) return;
        score += t.indexOf(terms[i]) !== -1 ? 3 : 1;
      }
      hits.push({ p: p, s: score });
    });
    hits.sort(function (a, b) { return b.s - a.s || (a.p.d < b.p.d ? 1 : -1); });
    if (!hits.length) {
      results.innerHTML = '<p>לא נמצאו תוצאות. אפשר לנסות מילים אחרות.</p>';
      return;
    }
    var shown = 0;
    function more() {
      var html = '';
      hits.slice(shown, shown + 30).forEach(function (h) {
        var p = h.p;
        html += '<div class="search-result">' +
          (p.i ? '<a href="' + esc(BASE + p.u) + '" tabindex="-1"><img loading="lazy" src="' + esc(p.i) + '" alt=""></a>' : '') +
          '<div><h2><a href="' + esc(BASE + p.u) + '">' + esc(p.t) + '</a></h2>' +
          '<p>' + hebDate(p.d) + ' · ' + esc(p.x.slice(0, 140)) + (p.x.length > 140 ? '…' : '') + '</p></div></div>';
      });
      shown += 30;
      var btn = results.querySelector('.search-more');
      if (btn) btn.remove();
      results.insertAdjacentHTML('beforeend', html);
      if (shown < hits.length) {
        results.insertAdjacentHTML('beforeend', '<button class="search-submit search-more">עוד תוצאות</button>');
        results.querySelector('.search-more').addEventListener('click', more);
      }
    }
    results.innerHTML = '<p>נמצאו ' + hits.length + ' תוצאות</p>';
    more();
  }).catch(function () {
    results.innerHTML = '<p>החיפוש לא זמין כרגע.</p>';
  });
})();
