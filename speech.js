// Read aloud with the device's own voices (Web Speech API).
// Same idea as dedicated read-aloud apps: the chapter is split into sentences,
// each sentence is wrapped in a <span class="snt">, and they are spoken one at a
// time so the one being read can be highlighted and you can tap any sentence to
// jump there. Our own code and our own small pronunciation list.
'use strict';

const Speech = (() => {
  const synth = window.speechSynthesis;
  const supported = !!(synth && window.SpeechSynthesisUtterance);
  const BLOCKS = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,td,th,dt,dd,figcaption,caption,div,section,article,aside';
  const SKIP = 'rt,rp,sup.noteref,script,style';

  let sents = [];          // [{ text, els: [span] }]
  let idx = 0;             // sentence being (or about to be) read
  let playing = false;
  let token = 0;           // ignores callbacks from utterances we cancelled
  let utter = null;        // kept so the browser doesn't drop its events
  let errors = 0;
  let wake = null;
  let hooks = {};          // onState(playing), onSentence(i), onChapterEnd()
  const opts = { rate: 1, voiceURI: '', lang: 'en' };

  // ---------- splitting the chapter into sentences ----------
  // Short words with a dot that do NOT end a sentence.
  const ABBREV = /(?:^|\s)(?:Mr|Mrs|Ms|Mx|Dr|Prof|Sr|Jr|St|Mt|vs|etc|e\.g|i\.e|No|Vol|Ch|pp|p|approx|Lt|Col|Gen|Capt|Sgt|Rev|Hon|Gov|Inc|Ltd|Co|[A-Z])\.\s*$/;

  function segments(text, lang) {
    let parts;
    if (window.Intl && Intl.Segmenter) {
      try {
        parts = [...new Intl.Segmenter(lang || undefined, { granularity: 'sentence' }).segment(text)]
          .map((s) => [s.index, s.index + s.segment.length]);
      } catch { parts = null; }
    }
    if (!parts) {
      parts = [];
      const re = /[^.!?…。！？]+(?:[.!?…。！？]+["'”’)\]]*\s*|$)/g;
      let m;
      while ((m = re.exec(text)) && m[0]) parts.push([m.index, m.index + m[0].length]);
      if (!parts.length) parts = [[0, text.length]];
    }
    // Join pieces that were cut after an abbreviation ("Mr. Smith").
    const joined = [];
    for (const p of parts) {
      const prev = joined[joined.length - 1];
      // …and pieces that carry on in small letters (“Run!” she said).
      const carriesOn = /^[\s"'“”‘’(«»-]*\p{Ll}/u.test(text.slice(p[0], p[1]));
      if (prev && (ABBREV.test(text.slice(prev[0], prev[1])) || carriesOn)) prev[1] = p[1];
      else joined.push([...p]);
    }
    // Very long sentences: split at commas/semicolons so speech starts sooner
    // (some voices also stop after ~15 seconds of one utterance).
    const out = [];
    for (const [a, b] of joined) {
      let start = a;
      while (b - start > 260) {
        const chunk = text.slice(start, start + 260);
        const cut = Math.max(chunk.lastIndexOf(', '), chunk.lastIndexOf('; '), chunk.lastIndexOf(': '), chunk.lastIndexOf(' — '));
        if (cut < 80) break;
        out.push([start, start + cut + 2]);
        start += cut + 2;
      }
      out.push([start, b]);
    }
    return out;
  }

  function wrap(node, si) {
    const span = document.createElement('span');
    span.className = 'snt';
    span.dataset.s = String(si);
    node.parentNode.replaceChild(span, node);
    span.appendChild(node);
    sents[si].els.push(span);
  }

  /** Wrap every sentence of `root` in spans. Call after a chapter is shown. */
  function prepare(root, lang) {
    stop();
    sents = []; idx = 0;
    if (!supported) return;
    if (lang) opts.lang = lang;

    // Group text by the nearest block (paragraph, heading, list item…).
    const groups = new Map();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const parent = n.parentElement;
      if (!parent || parent.closest(SKIP)) continue;
      const key = parent.closest(BLOCKS) || root;
      if (!groups.has(key)) { if (!n.data.trim()) continue; groups.set(key, []); }
      groups.get(key).push(n);
    }

    for (const nodes of groups.values()) {
      const starts = [];
      let text = '';
      for (const n of nodes) { starts.push(text.length); text += n.data; }
      const ranges = [];
      for (const [a, b] of segments(text, opts.lang)) {
        const t = text.slice(a, b).replace(/\s+/g, ' ').trim();
        if (!/[\p{L}\p{N}]/u.test(t)) continue;        // "* * *" and the like
        ranges.push([a, b, sents.length]);
        sents.push({ text: t, els: [] });
      }
      // Cut each text node at the sentence edges, last piece first so the
      // earlier positions stay valid.
      nodes.forEach((node, k) => {
        const s0 = starts[k], s1 = s0 + node.data.length;
        const cuts = ranges.filter(([a, b]) => a < s1 && b > s0)
          .map(([a, b, si]) => [Math.max(a, s0) - s0, Math.min(b, s1) - s0, si]);
        for (let c = cuts.length - 1; c >= 0; c--) {
          const [from, to, si] = cuts[c];
          if (to < node.data.length) node.splitText(to);
          const piece = from > 0 ? node.splitText(from) : node;
          if (piece.data.length) wrap(piece, si);
        }
      });
    }
    // Spans were created in a different order than the sentences; sort them.
    for (const s of sents) s.els.sort((x, y) => (x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  }

  // ---------- pronunciation ----------
  // A short list of our own; more can be added here.
  const FIX_EN = [
    [/\bMr\.(?=\s)/g, 'Mister'], [/\bMrs\.(?=\s)/g, 'Missus'], [/\bDr\.(?=\s+[A-Z])/g, 'Doctor'],
    [/\bProf\.(?=\s)/g, 'Professor'], [/\bSt\.(?=\s+[A-Z])/g, 'Saint'], [/\bvs\.?(?=\s)/g, 'versus'],
    [/\be\.g\./gi, 'for example'], [/\bi\.e\./gi, 'that is'], [/\betc\./gi, 'etcetera'],
    [/\bLv\.?\s*(\d)/g, 'Level $1'], [/\bHP\b/g, 'H P'], [/\bMP\b/g, 'M P'],
  ];
  function forSpeech(t) {
    t = t.replace(/[*_~=#|<>]{2,}/g, ' ').replace(/…/g, '... ');
    if (/^en/i.test(opts.lang)) for (const [re, to] of FIX_EN) t = t.replace(re, to);
    return t;
  }

  // ---------- voices ----------
  function voices() { return supported ? synth.getVoices() : []; }
  /** Voices for the book's language, best first (Premium / Enhanced, then on-device). */
  function voicesFor(lang) {
    const base = (lang || opts.lang || 'en').slice(0, 2).toLowerCase();
    const score = (v) => (/premium/i.test(v.name) ? 4 : 0) + (/enhanced|natural|neural/i.test(v.name) ? 2 : 0) + (v.localService ? 1 : 0);
    const all = voices();
    const match = all.filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith(base));
    return (match.length ? match : all).sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
  }
  function pickVoice() {
    // The saved voice only if it speaks this book's language.
    const base = (opts.lang || 'en').slice(0, 2).toLowerCase();
    const chosen = voices().find((v) => v.voiceURI === opts.voiceURI);
    if (chosen && chosen.lang.toLowerCase().startsWith(base)) return chosen;
    return voicesFor(opts.lang)[0] || null;
  }

  // ---------- speaking ----------
  function highlight(i) {
    for (const el of document.querySelectorAll('.snt.speaking, .snt.chosen')) el.classList.remove('speaking', 'chosen');
    const s = sents[i];
    if (!s) return;
    for (const el of s.els) el.classList.add('speaking');
    const r = s.els[0]?.getBoundingClientRect();
    if (r && (r.top < innerHeight * 0.12 || r.bottom > innerHeight * 0.72)) {
      s.els[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  function speakCurrent() {
    const my = ++token;
    if (idx >= sents.length) {
      setPlaying(false);
      hooks.onChapterEnd?.();
      return;
    }
    highlight(idx);
    hooks.onSentence?.(idx);
    const u = new SpeechSynthesisUtterance(forSpeech(sents[idx].text));
    const v = pickVoice();
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = opts.lang;
    u.rate = opts.rate;
    u.onend = () => {
      if (my !== token || !playing) return;
      errors = 0; idx++; speakCurrent();
    };
    u.onerror = (e) => {
      if (my !== token || !playing || e.error === 'interrupted' || e.error === 'canceled') return;
      if (++errors >= 3) { setPlaying(false); hooks.onError?.(e.error); return; }
      idx++; speakCurrent();
    };
    utter = u;
    synth.speak(u);
  }

  function setPlaying(on) {
    playing = on;
    hooks.onState?.(on);
    // Keep the screen on while reading: iPhones stop speech when the screen locks.
    if (on && navigator.wakeLock && !wake) {
      navigator.wakeLock.request('screen').then((w) => { wake = w; w.addEventListener('release', () => { wake = null; }); }).catch(() => {});
    } else if (!on && wake) { wake.release().catch(() => {}); wake = null; }
  }

  // iPhones only allow speech that starts from a tap. Speaking a silent
  // nothing during the tap unlocks it for the rest of the visit.
  let unlocked = false;
  function unlock() {
    if (!supported || unlocked) return;
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    synth.speak(u);
    unlocked = true;
  }

  function play(from) {
    unlocked = true;
    if (!supported || !sents.length) return;
    if (typeof from === 'number') idx = Math.max(0, Math.min(sents.length - 1, from));
    const busy = synth.speaking || synth.pending;
    token++;
    setPlaying(true);
    if (busy) { synth.cancel(); setTimeout(() => { if (playing) speakCurrent(); }, 80); }
    else speakCurrent();
  }
  function pause() {
    if (!playing) return;
    token++;
    setPlaying(false);
    synth.cancel();
    // Leave the sentence marked so it's clear where it will carry on.
  }
  function stop() {
    token++;
    if (playing) setPlaying(false);
    if (supported && (synth.speaking || synth.pending)) synth.cancel();
  }
  function skip(n) {
    if (!sents.length) return;
    const to = Math.max(0, Math.min(sents.length - 1, idx + n));
    if (playing) play(to); else { idx = to; choose(to); }
  }
  /** Mark a sentence as the place to start (when not playing). */
  function choose(i) {
    idx = i;
    for (const el of document.querySelectorAll('.snt.speaking, .snt.chosen')) el.classList.remove('speaking', 'chosen');
    for (const el of sents[i]?.els || []) el.classList.add('chosen');
  }
  /** First sentence at least partly on screen (below the top bar). */
  function firstVisible() {
    for (let i = 0; i < sents.length; i++) {
      const r = sents[i].els[0]?.getBoundingClientRect();
      if (r && r.bottom > 70) return i;
    }
    return 0;
  }
  function onScreen(i) {
    const r = sents[i]?.els[0]?.getBoundingClientRect();
    return !!r && r.bottom > 50 && r.top < innerHeight;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && playing && !wake) setPlaying(true);
  });

  return {
    supported,
    get playing() { return playing; },
    get index() { return idx; },
    get count() { return sents.length; },
    opts, prepare, play, pause, stop, skip, choose, unlock, firstVisible, onScreen, voicesFor,
    setHooks(h) { hooks = h; },
    onVoicesChanged(fn) { if (supported) synth.addEventListener?.('voiceschanged', fn); },
    sentenceOf(el) { const s = el.closest?.('.snt'); return s ? Number(s.dataset.s) : -1; },
  };
})();
