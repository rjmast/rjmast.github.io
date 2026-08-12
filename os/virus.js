/* ===========================================================================
   Virus.exe — playful "malware" gimmick for RajaOS
   Plain classic script. Defines window.OSVirus = { start, stop }.
   Does nothing until start() is called. Paired with os/virus.css.
   Works from file:// and over a server. No network assets.
   =========================================================================== */
(function () {
  "use strict";

  if (window.OSVirus) return; // don't redefine on double-include

  var BSOD_DELAY = 10000;     // ms before the Blue Screen of Death
  var MAX_POPUPS = 40;        // cap concurrent popups; remove oldest beyond this
  var reduce = false;
  try {
    reduce = window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (e) { reduce = false; }

  // ---- content pools -------------------------------------------------------
  var MEMES = [
    { e: "😹", t: "ur computer has been YEETED", s: "0 files remaining" },
    { e: "🦠", t: "Infected with VIBES.exe", s: "spreading to your fridge…" },
    { e: "💀", t: "RIP your productivity", s: "cause of death: this popup" },
    { e: "🐛", t: "A bug crawled into the CPU", s: "it lives here now" },
    { e: "🧨", t: "Self-destruct in 3… 2… jk", s: "gotcha" },
    { e: "🍪", t: "We ate all your cookies", s: "they were delicious" },
    { e: "👾", t: "SYSTEM32 has left the chat", s: "brb deleting nothing" },
    { e: "🤡", t: "You clicked the wrong OS", s: "this is fine 🔥" },
    { e: "🧠", t: "Downloading more IQ…", s: "current: potato" },
    { e: "🪳", t: "wormware installed successfully", s: "you're welcome" },
    { e: "📈", t: "Your RAM is now 4000% cooler", s: "trust me bro" }
  ];
  var FREEBIES = [
    { e: "💾", t: "FREE RAM!!", s: "click here for 64 GB" },
    { e: "🎁", t: "You are visitor #1,000,000", s: "claim your prize now" },
    { e: "💸", t: "iPhone 27 — FREE", s: "just kidding, it's malware" },
    { e: "⚡", t: "Speed up your PC 900%", s: "one weird trick" }
  ];
  var SPINNERS = [
    "downloading more RAM…",
    "reticulating splines…",
    "yeeting your files…",
    "installing more virus…",
    "compiling memes…",
    "borrowing your CPU…"
  ];
  var BURST = ["🦠", "💀", "😹", "🔥", "👾", "🤡", "🧨", "💾", "🐛", "⚠️", "🪳", "😈", "🎉"];

  // ---- state ---------------------------------------------------------------
  var running = false;
  var layer = null;          // hosts popups + antivirus button
  var antivirusBtn = null;
  var bsod = null;
  var popups = [];           // live popup nodes (FIFO for the cap)
  var spawnTimer = null;
  var bsodTimer = null;
  var spawnDelay = reduce ? 1100 : 620;   // accelerates over time
  var keyHandler = null;

  function rand(n) { return Math.floor(Math.random() * n); }
  function pick(arr) { return arr[rand(arr.length)]; }
  function vw() { return window.innerWidth || document.documentElement.clientWidth; }
  function vh() { return window.innerHeight || document.documentElement.clientHeight; }

  // ---- popup factory -------------------------------------------------------
  function makeErrorPopup() {
    var el = document.createElement("div");
    el.className = "rv-popup";
    var barMods = ["", " rv-popup__bar--blue", " rv-popup__bar--green", " rv-popup__bar--purple"];
    var kind = rand(10);
    var content;

    if (kind < 2) {
      // spinner popup
      var sp = pick(SPINNERS);
      content =
        '<div class="rv-popup__bar' + pick(barMods) + '">' +
          '<span class="rv-popup__dot"></span>' +
          '<span class="rv-popup__title">' + esc(sp) + '</span>' +
          '<span class="rv-popup__x">×</span>' +
        '</div>' +
        '<div class="rv-popup__body">' +
          '<div class="rv-popup__spinner" aria-hidden="true"></div>' +
          '<div class="rv-popup__text">' + esc(sp) + '</div>' +
          '<div class="rv-popup__sub">please do not turn off your brain</div>' +
        '</div>';
    } else if (kind < 4) {
      // freebie / clickbait
      var f = pick(FREEBIES);
      content =
        '<div class="rv-popup__bar rv-popup__bar--green">' +
          '<span class="rv-popup__dot"></span>' +
          '<span class="rv-popup__title">Amazing Offer</span>' +
          '<span class="rv-popup__x">×</span>' +
        '</div>' +
        '<div class="rv-popup__body">' +
          '<span class="rv-popup__emoji">' + f.e + '</span>' +
          '<div class="rv-popup__text">' + esc(f.t) + '</div>' +
          '<div class="rv-popup__sub">' + esc(f.s) + '</div>' +
          '<div class="rv-popup__btn">CLAIM NOW</div>' +
        '</div>';
    } else {
      // classic error / meme dialog
      var m = pick(MEMES);
      content =
        '<div class="rv-popup__bar' + (rand(3) ? "" : pick(barMods)) + '">' +
          '<span class="rv-popup__dot"></span>' +
          '<span class="rv-popup__title">Error 0x' +
            rand(0xffff).toString(16).toUpperCase() + '</span>' +
          '<span class="rv-popup__x">×</span>' +
        '</div>' +
        '<div class="rv-popup__body">' +
          '<span class="rv-popup__emoji">' + m.e + '</span>' +
          '<div class="rv-popup__text">' + esc(m.t) + '</div>' +
          '<div class="rv-popup__sub">' + esc(m.s) + '</div>' +
        '</div>';
    }

    el.innerHTML = content;
    positionRandom(el, 366, 290);
    return el;
  }

  function makeBurst() {
    var el = document.createElement("div");
    el.className = "rv-emoji";
    el.setAttribute("aria-hidden", "true");
    el.textContent = pick(BURST);
    el.style.left = rand(vw() - 60) + "px";
    el.style.top = (vh() * 0.35 + rand(vh() * 0.55)) + "px";
    el.style.setProperty("--rv-rot", (rand(60) - 30) + "deg");
    el.style.setProperty("--rv-dx", (rand(160) - 80) + "px");
    return el;
  }

  function positionRandom(el, w, h) {
    var maxX = Math.max(4, vw() - w);
    var maxY = Math.max(30, vh() - h);
    el.style.left = rand(maxX) + "px";
    el.style.top = (24 + rand(maxY)) + "px";
    var rot = (rand(24) - 12);
    el.style.setProperty("--rv-rot", rot + "deg");
    el.style.transform = "rotate(" + rot + "deg)";
    var scale = 0.96 + Math.random() * 0.44;
    el.style.zoom = ""; // no-op guard
    el.style.transformOrigin = "center center";
    el.style.scale = scale.toFixed(2);
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // ---- spawn loop ----------------------------------------------------------
  function spawnOne() {
    if (!running || !layer) return;
    var node = rand(10) < 7 ? makeErrorPopup() : makeBurst();

    layer.appendChild(node);

    if (node.classList.contains("rv-emoji")) {
      // self-cleaning burst
      setTimeout(function () {
        if (node.parentNode) node.parentNode.removeChild(node);
      }, 2800);
    } else {
      popups.push(node);
      while (popups.length > MAX_POPUPS) {
        var old = popups.shift();
        if (old && old.parentNode) old.parentNode.removeChild(old);
      }
    }
  }

  function scheduleSpawn() {
    if (!running) return;
    spawnOne();
    // accelerate gently, floor at ~180ms (or 700ms reduced-motion)
    var floor = reduce ? 700 : 180;
    spawnDelay = Math.max(floor, spawnDelay * 0.94);
    spawnTimer = setTimeout(scheduleSpawn, spawnDelay);
  }

  // ---- antivirus notification ---------------------------------------------
  function makeAntivirus() {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "rv-antivirus";
    b.setAttribute("aria-label",
      "Your AntiVirus. Click to remove the virus and restore the system.");
    b.innerHTML =
      '<span class="rv-antivirus__shield" aria-hidden="true">🛡️</span>' +
      '<span class="rv-antivirus__txt">' +
        '<span class="rv-antivirus__title">Your AntiVirus</span>' +
        '<span class="rv-antivirus__sub">Click to yeet the virus</span>' +
      '</span>';
    b.addEventListener("click", stop);
    return b;
  }

  // ---- BSOD ----------------------------------------------------------------
  function showBSOD() {
    if (!running || bsod) return;
    bsod = document.createElement("div");
    bsod.className = "rv-bsod";
    bsod.setAttribute("role", "alertdialog");
    bsod.setAttribute("aria-label", "System crash screen. Press Escape to recover.");
    bsod.innerHTML =
      '<div class="rv-bsod__face">:(</div>' +
      '<p class="rv-bsod__msg">RajaOS ran into a problem and needs to restart. ' +
        'We’re just collecting some memes, and then we’ll restart for you.</p>' +
      '<p class="rv-bsod__pct"><span class="rv-bsod__num">0</span>% complete</p>' +
      '<div class="rv-bsod__meta">' +
        '<div class="rv-bsod__qr" aria-hidden="true"></div>' +
        '<div class="rv-bsod__details">' +
          '<p>For more information about this issue, stare into the void or ' +
            'search online later for:</p>' +
          '<p class="rv-bsod__stop">STOP CODE: TOO_MUCH_STYLE</p>' +
          '<p class="rv-bsod__hint">Press ESC to recover.</p>' +
        '</div>' +
      '</div>';

    var recover = document.createElement("button");
    recover.type = "button";
    recover.className = "rv-bsod__recover";
    recover.setAttribute("aria-label", "Recover the system and dismiss the crash screen.");
    recover.textContent = "↺ Press ESC to recover";
    recover.addEventListener("click", stop);
    bsod.appendChild(recover);

    document.body.appendChild(bsod);

    // fake progress counter
    var numEl = bsod.querySelector(".rv-bsod__num");
    var pct = 0;
    bsod._pctTimer = setInterval(function () {
      pct += rand(6) + 1;
      if (pct > 99) pct = 99;                 // never "finishes"
      if (numEl) numEl.textContent = pct;
    }, reduce ? 800 : 380);

    // move focus to the recover control for keyboard users
    try { recover.focus(); } catch (e) {}
  }

  // ---- key handling --------------------------------------------------------
  function onKey(e) {
    if (e.key === "Escape" || e.key === "Esc") {
      e.preventDefault();
      stop();
    }
  }

  // ---- public API ----------------------------------------------------------
  function start() {
    if (running) return;             // guard double-start
    running = true;

    layer = document.createElement("div");
    layer.className = "rv-layer";
    layer.setAttribute("aria-hidden", "true"); // decorative chaos
    document.body.appendChild(layer);

    antivirusBtn = makeAntivirus();
    document.body.appendChild(antivirusBtn);

    keyHandler = onKey;
    document.addEventListener("keydown", keyHandler, true);

    // kick off spawning + burst of a few immediately so it reads instantly
    spawnDelay = reduce ? 1100 : 620;
    for (var i = 0; i < (reduce ? 2 : 4); i++) spawnOne();
    spawnTimer = setTimeout(scheduleSpawn, spawnDelay);

    bsodTimer = setTimeout(showBSOD, BSOD_DELAY);
  }

  function stop() {
    if (!running) return;
    running = false;

    if (spawnTimer) { clearTimeout(spawnTimer); spawnTimer = null; }
    if (bsodTimer)  { clearTimeout(bsodTimer); bsodTimer = null; }

    if (keyHandler) {
      document.removeEventListener("keydown", keyHandler, true);
      keyHandler = null;
    }

    if (bsod) {
      if (bsod._pctTimer) clearInterval(bsod._pctTimer);
      if (bsod.parentNode) bsod.parentNode.removeChild(bsod);
      bsod = null;
    }
    if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
    layer = null;
    if (antivirusBtn && antivirusBtn.parentNode) {
      antivirusBtn.parentNode.removeChild(antivirusBtn);
    }
    antivirusBtn = null;
    popups.length = 0;
  }

  window.OSVirus = { start: start, stop: stop };
})();
