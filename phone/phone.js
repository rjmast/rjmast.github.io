/* ===========================================================================
   RajaOS — Mobile runtime
   Home grid + dock · one full-screen app at a time · no windows, no drag.
   Iconography (glyph + TILES) copied from os/os.js to stay one product.
   =========================================================================== */
(() => {
  'use strict';
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (s, r = document) => r.querySelector(s);

  /* ---- Iconography (mirrors os/os.js) ---------------------------------- */
  const TILES = {
    about:     'linear-gradient(160deg,#22334d,#111b2e)',
    projects:  'linear-gradient(160deg,#0d4bab,#08306b)',
    documents: 'linear-gradient(160deg,#ffffff,#eef2f8)',
    recipes:   'linear-gradient(160deg,#f2913f,#df611a)',
    github:    'linear-gradient(160deg,#3b444f,#1b2027)',
    x:         'linear-gradient(160deg,#34353b,#0a0a0c)',
    linkedin:  'linear-gradient(160deg,#2f80e8,#0a66c2)',
    email:     'linear-gradient(160deg,#f2913f,#df611a)',
  };
  function glyph(id, s) {
    const open = `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">`;
    switch (id) {
      case 'about':
        return `${open}<path d="M5 8l4 4-4 4" stroke="#4fd6ff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 16h7" stroke="#f6923c" stroke-width="1.9" stroke-linecap="round"/></svg>`;
      case 'github':
        return `${open}<path fill="#fff" d="M12 1.7A10.3 10.3 0 0 0 8.74 21.8c.51.1.7-.22.7-.49v-1.9c-2.86.62-3.47-1.2-3.47-1.2-.47-1.2-1.14-1.52-1.14-1.52-.93-.64.07-.63.07-.63 1.03.07 1.57 1.06 1.57 1.06.92 1.57 2.4 1.12 2.99.85.09-.66.36-1.12.65-1.37-2.29-.26-4.69-1.14-4.69-5.09 0-1.12.4-2.04 1.06-2.76-.11-.26-.46-1.31.1-2.72 0 0 .86-.28 2.83 1.05a9.8 9.8 0 0 1 5.15 0c1.96-1.33 2.82-1.05 2.82-1.05.56 1.41.21 2.46.1 2.72.66.72 1.06 1.64 1.06 2.76 0 3.96-2.41 4.83-4.7 5.08.37.32.7.95.7 1.92v2.85c0 .28.19.6.71.49A10.3 10.3 0 0 0 12 1.7Z"/></svg>`;
      case 'x':
        return `${open}<path fill="#fff" d="M17.9 3h3.1l-6.77 7.73L22.2 21h-6.2l-4.86-6.35L5.58 21H2.46l7.24-8.27L2 3h6.36l4.39 5.8L17.9 3Zm-1.09 16.13h1.72L7.28 4.78H5.44l11.37 14.35Z"/></svg>`;
      case 'linkedin':
        return `${open}<path fill="#fff" d="M6.94 5A1.94 1.94 0 1 1 3.06 5a1.94 1.94 0 0 1 3.88 0ZM3.3 8.5h3.26V21H3.3V8.5Zm5.32 0h3.13v1.71h.04c.44-.82 1.5-1.69 3.09-1.69 3.3 0 3.91 2.17 3.91 5v6.48h-3.26v-5.74c0-1.37-.02-3.13-1.9-3.13-1.91 0-2.2 1.49-2.2 3.03V21H8.62V8.5Z"/></svg>`;
      case 'email':
        return `${open}<rect x="2.9" y="4.8" width="18.2" height="14.4" rx="2.6" fill="none" stroke="#fff" stroke-width="1.7"/><path d="m3.4 6.2 8.6 6.2 8.6-6.2" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      case 'projects':
        return `${open}<g stroke="rgba(255,255,255,.8)" stroke-width="1.1"><path d="M4 8h16M4 12h16M4 16h16M8 4v16M12 4v16M16 4v16"/></g><path d="M5.5 18.5 18.5 18.5 18.5 6.5Z" fill="rgba(242,107,29,.92)" stroke="#fff" stroke-width="1.1" stroke-linejoin="round"/></svg>`;
      case 'documents':
        return `${open}<path d="M6.5 3.2h6.6L17.5 7.4V20.8H6.5Z" fill="#fff" stroke="#0b5fd6" stroke-width="1.5" stroke-linejoin="round"/><path d="M13.1 3.2v4.2h4.4" fill="#fff2e8" stroke="#f26b1d" stroke-width="1.3" stroke-linejoin="round"/><path d="M9 12h5.6M9 14.8h5.6M9 17.6h3.4" stroke="#0b5fd6" stroke-width="1.25" stroke-linecap="round"/></svg>`;
      case 'recipes':
        return `${open}<rect x="5.2" y="3.6" width="13.6" height="16.8" rx="1.6" fill="#fff8ee" stroke="#ffffff" stroke-width="1.3"/><path d="M8.4 8.6h7M8.4 11.4h7M8.4 14.2h5" stroke="#df611a" stroke-width="1.15" stroke-linecap="round"/><rect x="13.4" y="2.6" width="2.5" height="18.8" fill="rgba(20,32,46,.5)"/></svg>`;
      case 'mark':
        return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8" stroke="#fff" stroke-width="1.7"/><path d="M12 4.5v15M4.5 12h15" stroke="#fff" stroke-width="1.1" opacity=".55"/><circle cx="12" cy="12" r="2.3" fill="#f6923c"/></svg>`;
      default: return '';
    }
  }
  function tileHTML(id, size) {
    return `<span class="icon-tile" style="background:${TILES[id]}">${glyph(id, Math.round(size * 0.56))}</span>`;
  }

  /* ---- App / link registry --------------------------------------------- */
  // `src` → opens full-screen iframe; `href` → opens a new tab / mailto.
  const APPS = [
    { id: 'about',     label: 'About',    src: '../apps/about/index.html' },
    { id: 'projects',  label: 'Projects', src: '../apps/projects/index.html' },
    { id: 'documents', label: 'Résumé', title: 'Résumé', src: '../apps/documents/index.html#resume' },
    { id: 'recipes',   label: 'Recipes',  src: '../apps/recipes/index.html' },
  ];
  const LINKS = [
    { id: 'github',   label: 'GitHub',   href: 'https://github.com/rjmast' },
    { id: 'x',        label: 'X',        href: 'https://x.com/rajapandiyan_a' },
    { id: 'linkedin', label: 'LinkedIn', href: 'https://www.linkedin.com/in/rajapandiyan-arivazhagan-03530392/' },
    { id: 'email',    label: 'Email',    href: 'mailto:rajapandiyanar@gmail.com' },
  ];
  const APP = Object.fromEntries(APPS.map(a => [a.id, a]));

  /* ---- Build an icon button -------------------------------------------- */
  function makeIcon(item, size) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'app-icon';
    btn.dataset.id = item.id;
    btn.setAttribute('aria-label', item.href
      ? (item.href.startsWith('mailto:') ? 'Email Raja' : 'Open ' + item.label + ' (new tab)')
      : 'Open ' + item.label);
    btn.innerHTML = tileHTML(item.id, size) +
      (size >= 58 ? `<span class="icon-label">${item.label}</span>` : '');
    btn.addEventListener('click', () => activate(item, btn));
    return btn;
  }

  function activate(item, btn) {
    if (item.href) {
      if (item.href.startsWith('mailto:')) location.href = item.href;
      else window.open(item.href, '_blank', 'noopener');
      return;
    }
    openApp(item, btn);
  }

  /* ---- Full-screen app open / close ------------------------------------ */
  const layer = $('#app-layer');
  const stage = $('#app-stage');
  const barTitle = $('#app-bar-title');
  let openId = null;

  function openApp(app, fromBtn) {
    if (openId === app.id) return;
    openId = app.id;
    barTitle.textContent = app.title || app.label;

    stage.innerHTML = '';
    const frame = document.createElement('iframe');
    frame.title = app.label;
    frame.src = app.src;
    frame.loading = 'eager';
    stage.append(frame);

    layer.classList.add('open');
    layer.setAttribute('aria-hidden', 'false');

    if (!REDUCED) {
      // grow from the tapped icon's position
      const t = fromBtn ? fromBtn.querySelector('.icon-tile').getBoundingClientRect() : null;
      const s = layer.getBoundingClientRect();
      if (t) {
        const ox = ((t.left + t.width / 2 - s.left) / s.width) * 100;
        const oy = ((t.top + t.height / 2 - s.top) / s.height) * 100;
        layer.style.transformOrigin = `${ox}% ${oy}%`;
      }
      layer.animate(
        [{ transform: 'scale(.35)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }],
        { duration: 340, easing: 'cubic-bezier(.16,1,.3,1)' });
    }
    $('#app-close').focus({ preventScroll: true });
  }

  function closeApp() {
    if (!openId) return;
    const done = () => {
      layer.classList.remove('open');
      layer.setAttribute('aria-hidden', 'true');
      stage.innerHTML = '';
      const prev = document.querySelector(`.app-icon[data-id="${openId}"]`);
      openId = null;
      prev?.focus({ preventScroll: true });
    };
    if (REDUCED) return done();
    layer.animate(
      [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(.4)', opacity: 0 }],
      { duration: 220, easing: 'cubic-bezier(.4,0,1,1)' }).onfinish = done;
  }

  $('#app-close').addEventListener('click', closeApp);
  addEventListener('keydown', e => { if (e.key === 'Escape') closeApp(); });

  /* ---- Assemble home + dock -------------------------------------------- */
  function build() {
    const grid = $('#grid');
    [...APPS, ...LINKS].forEach(it => grid.append(makeIcon(it, 58)));

    const dock = $('#dock');
    ['about', 'projects', 'documents', 'recipes']
      .forEach(id => dock.append(makeIcon(APP[id], 56)));

    $('#wm-mark').innerHTML = glyph('mark', 16);
  }

  /* ---- Live clock ------------------------------------------------------ */
  function tick() {
    $('#sb-clock').textContent =
      new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  build();
  tick();
  setInterval(tick, 10000);
})();
