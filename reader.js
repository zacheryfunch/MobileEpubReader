// EPUB Reader - reads EPUB files right in the window.
// Chapters are shown as one scrolling page each (no pagination), so there are
// never blank pages. The book is unpacked in the page with JSZip; nothing in a
// book can run code (scripts are stripped and the page's security policy
// blocks them anyway).
/* global JSZip */
'use strict';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

// ---------- settings ----------
const settings = Object.assign({ size: 19, theme: 'auto', font: 'serif', width: '38em', rate: 1, voice: '' }, store.get('epubr-settings', {}));
function applySettings() {
  const r = document.documentElement;
  r.dataset.theme = settings.theme;
  r.dataset.font = settings.font;
  r.style.setProperty('--size', settings.size + 'px');
  r.style.setProperty('--measure', settings.width);
  $('sizeVal').textContent = settings.size + ' px';
  Speech.opts.rate = settings.rate;
  Speech.opts.voiceURI = settings.voice;
  $('rate').value = settings.rate;
  $('rateVal').textContent = settings.rate.toFixed(2).replace(/0$/, '') + '×';
  $('rateBtn').textContent = settings.rate.toFixed(1) + '×';
  document.querySelector('meta[name=theme-color]').content = getComputedStyle(r).getPropertyValue('--bg').trim() || '#f6f4ef';
  for (const b of document.querySelectorAll('#themes button')) b.classList.toggle('on', b.dataset.theme === settings.theme);
  for (const b of document.querySelectorAll('#fonts button')) b.classList.toggle('on', b.dataset.font === settings.font);
  for (const b of document.querySelectorAll('#widths button')) b.classList.toggle('on', b.dataset.width === settings.width);
  store.set('epubr-settings', settings);
}
function changeSetting(fn) {
  const frac = scrollFrac();
  fn();
  applySettings();
  if (book) restoreFrac(frac);
}
$('smaller').onclick = () => changeSetting(() => { settings.size = Math.max(12, settings.size - 1); });
$('bigger').onclick = () => changeSetting(() => { settings.size = Math.min(36, settings.size + 1); });
document.querySelectorAll('#themes button').forEach((b) => { b.onclick = () => changeSetting(() => { settings.theme = b.dataset.theme; }); });
document.querySelectorAll('#fonts button').forEach((b) => { b.onclick = () => changeSetting(() => { settings.font = b.dataset.font; }); });
document.querySelectorAll('#widths button').forEach((b) => { b.onclick = () => changeSetting(() => { settings.width = b.dataset.width; }); });
applySettings();

// ---------- EPUB unpacking ----------
let book = null;   // { key, title, author, zip, spine:[{path,title}], images:Map }
let current = 0;

function resolvePath(base, rel) {
  // base: path of the file the link is in, e.g. "OEBPS/ch1.xhtml"
  const u = new URL(rel, 'http://book/' + base);
  return decodeURIComponent(u.pathname.slice(1));
}
function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  return doc.getElementsByTagName('parsererror').length ? null : doc;
}
const byLocal = (root, name) => [...root.getElementsByTagNameNS('*', name)];

async function openBook(arrayBuffer, key, label) {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const readText = async (p) => {
    const f = zip.file(p);
    if (!f) throw new Error(`The book is missing "${p}".`);
    return f.async('string');
  };
  const container = parseXml(await readText('META-INF/container.xml'));
  const opfPath = container && byLocal(container, 'rootfile')[0]?.getAttribute('full-path');
  if (!opfPath) throw new Error('This does not look like an EPUB book.');
  const opf = parseXml(await readText(opfPath));
  if (!opf) throw new Error('The book\'s table of contents file is damaged.');

  const manifest = new Map();
  for (const it of byLocal(opf, 'item')) {
    manifest.set(it.getAttribute('id'), {
      path: resolvePath(opfPath, it.getAttribute('href')),
      type: it.getAttribute('media-type') || '',
      props: it.getAttribute('properties') || '',
    });
  }
  const spineEl = byLocal(opf, 'spine')[0];
  const spine = byLocal(opf, 'itemref')
    .filter((r) => r.getAttribute('linear') !== 'no')
    .map((r) => manifest.get(r.getAttribute('idref')))
    .filter((m) => m && /html|xml/.test(m.type))
    .map((m) => ({ path: m.path, title: '' }));
  if (!spine.length) throw new Error('This book has no chapters.');

  // Chapter titles from the book's contents list (EPUB 3 nav, else EPUB 2 NCX).
  const titles = new Map();
  try {
    const nav = [...manifest.values()].find((m) => /\bnav\b/.test(m.props));
    if (nav) {
      const doc = new DOMParser().parseFromString(await readText(nav.path), 'application/xhtml+xml');
      const tocNav = [...doc.getElementsByTagName('nav')].find((n) => /toc/.test(n.getAttribute('epub:type') || n.getAttributeNS('http://www.idpf.org/2007/ops', 'type') || '')) || doc.getElementsByTagName('nav')[0];
      for (const a of tocNav ? tocNav.getElementsByTagName('a') : []) {
        const p = resolvePath(nav.path, (a.getAttribute('href') || '').split('#')[0] || nav.path);
        if (!titles.has(p)) titles.set(p, a.textContent.replace(/\s+/g, ' ').trim());
      }
    }
    if (!titles.size) {
      const ncx = manifest.get(spineEl?.getAttribute('toc')) || [...manifest.values()].find((m) => /ncx/.test(m.type));
      if (ncx) {
        const doc = parseXml(await readText(ncx.path));
        for (const np of doc ? byLocal(doc, 'navPoint') : []) {
          const src = byLocal(np, 'content')[0]?.getAttribute('src') || '';
          const p = resolvePath(ncx.path, src.split('#')[0]);
          const t = byLocal(np, 'text')[0]?.textContent.replace(/\s+/g, ' ').trim();
          if (t && !titles.has(p)) titles.set(p, t);
        }
      }
    }
  } catch { /* titles are optional */ }
  spine.forEach((s, i) => { s.title = titles.get(s.path) || `Chapter ${i + 1}`; });

  const meta = (n) => byLocal(opf, n)[0]?.textContent.trim() || '';
  for (const u of book?.images.values() || []) URL.revokeObjectURL(u);
  book = { key, title: meta('title') || label, author: meta('creator'), lang: meta('language') || 'en', zip, spine, images: new Map() };
}

// ---------- showing a chapter ----------
const STRIP = 'script, style, link, meta, base, iframe, frame, object, embed, form, input, button, select, textarea, audio, video, noscript, template';
const IMG_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };

async function imageUrl(p) {
  if (book.images.has(p)) return book.images.get(p);
  const f = book.zip.file(p);
  if (!f) return '';
  const ext = (p.split('.').pop() || '').toLowerCase();
  const url = URL.createObjectURL(new Blob([await f.async('uint8array')], { type: IMG_TYPES[ext] || 'application/octet-stream' }));
  book.images.set(p, url);
  return url;
}

async function renderChapter(i, where = 'top') {
  i = Math.max(0, Math.min(book.spine.length - 1, i));
  current = i;
  const ch = book.spine[i];
  const text = await book.zip.file(ch.path)?.async('string');
  let doc = text && new DOMParser().parseFromString(text, 'application/xhtml+xml');
  if (!doc || doc.getElementsByTagName('parsererror').length) doc = new DOMParser().parseFromString(text || '', 'text/html');
  const body = doc.body || doc.getElementsByTagName('body')[0] || doc.documentElement;

  // Clean: no scripts, no styles from the book, no event handlers.
  body.querySelectorAll(STRIP).forEach((n) => n.remove());
  for (const el of body.querySelectorAll('*')) {
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase();
      // (ids are kept: in-book links jump to them)
      if (n.startsWith('on') || n === 'style' || n === 'class') el.removeAttribute(a.name);
    }
  }
  // Pictures come out of the book file.
  for (const img of body.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    if (/^(https?:|data:)/i.test(src)) { if (!/^data:image\//i.test(src)) img.remove(); continue; }
    img.setAttribute('src', await imageUrl(resolvePath(ch.path, src)));
    img.removeAttribute('srcset');
  }
  for (const im of body.getElementsByTagNameNS('http://www.w3.org/2000/svg', 'image')) {
    const href = im.getAttribute('href') || im.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
    if (href && !/^(https?:|data:)/i.test(href)) {
      const u = await imageUrl(resolvePath(ch.path, href));
      im.setAttribute('href', u); im.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', u);
    }
  }
  // Links: inside the book → jump to that chapter; outside → open in a new window.
  for (const a of body.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (/^https?:/i.test(href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; continue; }
    if (/^[a-z]+:/i.test(href)) { a.removeAttribute('href'); continue; }
    const [file, frag] = href.split('#');
    const p = file ? resolvePath(ch.path, file) : ch.path;
    const idx = book.spine.findIndex((s) => s.path === p);
    a.setAttribute('href', '#');
    a.dataset.goto = String(idx >= 0 ? idx : i);
    if (frag) a.dataset.frag = frag;
  }

  const page = $('page');
  page.replaceChildren(...[...body.childNodes].map((n) => document.importNode(n, true)));
  $('where').textContent = `${book.title} · ${ch.title}`;
  $('count').textContent = `${i + 1} / ${book.spine.length}`;
  $('prevBtn').disabled = i === 0;
  $('nextBtn').disabled = i === book.spine.length - 1;
  $('nextBtn').textContent = i === book.spine.length - 1 ? 'The end' : 'Next chapter →';
  document.title = `${ch.title} – ${book.title}`;
  markToc();
  Speech.prepare(page, book.lang);
  updateMedia();

  if (where === 'bottom') window.scrollTo(0, document.documentElement.scrollHeight);
  else if (typeof where === 'number') restoreFrac(where);
  else if (typeof where === 'string' && where !== 'top') {
    const t = document.getElementById(where) || page.querySelector(`[name="${CSS.escape(where)}"]`);
    if (t) t.scrollIntoView(); else window.scrollTo(0, 0);
  } else window.scrollTo(0, 0);
  savePos();
  return true;
}

// ---------- position (remembered per book) ----------
function scrollFrac() {
  const max = document.documentElement.scrollHeight - innerHeight;
  return max > 0 ? scrollY / max : 0;
}
function restoreFrac(f) {
  // Reading scrollHeight makes the browser lay the new text out first.
  const max = document.documentElement.scrollHeight - innerHeight;
  window.scrollTo(0, Math.round(f * Math.max(0, max)));
}
function savePos() {
  if (!book) return;
  store.set('epubr-pos:' + book.key, { i: current, f: scrollFrac(), s: Speech.index, n: book.spine.length, t: Date.now() });
}
let saveTimer = 0;
addEventListener('scroll', () => {
  if (!book || $('reader').hidden) return;
  $('progress').style.width = ((current + scrollFrac()) / book.spine.length * 100).toFixed(2) + '%';
  clearTimeout(saveTimer); saveTimer = setTimeout(savePos, 300);
  // Hide the top bar while reading downwards, show it when scrolling up.
  const y = scrollY;
  $('bar').classList.toggle('hide', y > lastY && y > 80 && $('settings').hidden);
  lastY = y;
}, { passive: true });
let lastY = 0;
addEventListener('beforeunload', savePos);

// ---------- table of contents ----------
function buildToc() {
  $('tocTitle').textContent = book.title;
  const ol = $('tocList');
  ol.replaceChildren(...book.spine.map((s, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = s.title; b.title = s.title;
    b.onclick = () => { showToc(false); renderChapter(i); };
    li.append(b); return li;
  }));
}
function markToc() {
  [...$('tocList').querySelectorAll('button')].forEach((b, i) => b.classList.toggle('cur', i === current));
}
function showToc(on) {
  $('toc').hidden = !on; $('scrim').hidden = !on;
  if (on) $('tocList').querySelectorAll('button')[current]?.scrollIntoView({ block: 'center' });
}

// ---------- opening / closing ----------
let engine = false;     // true on the PC, when the EPUB Reader engine is running
let listened = false;   // read-aloud used since the page opened

async function startReading(getBuffer, key, label, kind) {
  Speech.stop();
  $('shelfMsg').textContent = `Opening “${label}”…`;
  try {
    await openBook(await getBuffer(), key, label);
  } catch (err) {
    $('shelfMsg').textContent = `Could not open “${label}”: ${err.message}`;
    return;
  }
  $('shelfMsg').textContent = '';
  if (kind === 'saved') BooksDB.setTitle(key, book.title, book.author).catch(() => {});
  buildToc();
  fillVoices();
  $('shelf').hidden = true; $('reader').hidden = false;
  $('player').hidden = !Speech.supported;
  const pos = store.get('epubr-pos:' + key, null);
  await renderChapter(pos ? pos.i : 0, pos ? pos.f : 'top');
  if (pos && pos.s > 0 && pos.s < Speech.count && Speech.onScreen(pos.s)) Speech.choose(pos.s);
  history.replaceState(null, '', location.pathname + (kind === 'saved' ? '?saved=' + encodeURIComponent(key) : kind === 'downloads' ? '?book=' + encodeURIComponent(label) : ''));
  $('page').focus({ preventScroll: true });
}
function openFromDownloads(name, size) {
  return startReading(async () => {
    const r = await fetch('api/book?name=' + encodeURIComponent(name));
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.arrayBuffer();
  }, `${name}|${size}`, name, 'downloads');
}
function openSaved(m) {
  return startReading(() => BooksDB.get(m.key), m.key, m.title || m.name, 'saved');
}
/** A book picked or dropped: keep it in the app, then open it. */
async function addFile(file) {
  if (!file) return;
  if (!/\.epub$/i.test(file.name) && file.type !== 'application/epub+zip') {
    $('shelfMsg').textContent = `“${file.name}” is not an EPUB book.`; return;
  }
  if (BooksDB.available) {
    try {
      $('shelfMsg').textContent = `Saving “${file.name}”…`;
      const key = await BooksDB.add(file);
      return openSaved({ key, name: file.name, title: '' });
    } catch { /* storage full or refused: just open it */ }
  }
  return startReading(() => file.arrayBuffer(), `${file.name}|${file.size}`, file.name, 'file');
}
function backToShelf() {
  Speech.stop();
  savePos();
  showToc(false); $('settings').hidden = true;
  $('reader').hidden = true; $('shelf').hidden = false;
  document.title = 'MobileEpubReader';
  history.replaceState(null, '', location.pathname);
  loadShelf();
}

// ---------- bookshelf ----------
const fmtSize = (b) => b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB';
function bookItem(title, metaText, key, onOpen, onDelete) {
  const li = document.createElement('li');
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'open';
  const name = document.createElement('span'); name.className = 'bname'; name.textContent = title;
  const meta = document.createElement('span'); meta.className = 'bmeta'; meta.textContent = metaText;
  const prog = document.createElement('span'); prog.className = 'bprog';
  const pos = store.get('epubr-pos:' + key, null);
  prog.textContent = pos ? `Reading: chapter ${pos.i + 1} of ${pos.n}` : 'Not started';
  btn.append(name, meta, prog);
  btn.onclick = onOpen;
  li.append(btn);
  if (onDelete) {
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'del'; del.textContent = '✕';
    del.title = `Remove “${title}” from this app`;
    del.setAttribute('aria-label', del.title);
    del.onclick = onDelete;
    li.append(del);
  }
  return li;
}
async function loadShelf() {
  let saved = [], dl = null;
  if (BooksDB.available) { try { saved = await BooksDB.list(); } catch { /* storage blocked */ } }
  $('saved').replaceChildren(...saved.map((m) => bookItem(
    m.title || m.name.replace(/\.epub$/i, ''),
    `${fmtSize(m.size)} · added ${new Date(m.added).toLocaleDateString()}`,
    m.key, () => openSaved(m),
    async () => {
      if (!confirm(`Remove “${m.title || m.name}” from this app?\n\nIt is deleted from this app only, not from your Files or Downloads.`)) return;
      await BooksDB.remove(m.key);
      loadShelf();
    })));
  $('savedHead').hidden = !saved.length;

  if (engine) { try { dl = await (await fetch('api/library')).json(); } catch { dl = null; } }
  const books = dl?.books || [];
  $('books').replaceChildren(...books.map((b) => bookItem(
    b.name.replace(/\.epub$/i, ''),
    `${fmtSize(b.size)} · ${new Date(b.mtime).toLocaleDateString()}`,
    `${b.name}|${b.size}`, () => openFromDownloads(b.name, b.size))));
  $('dlHead').hidden = !books.length;

  if (!saved.length && !books.length) {
    $('shelfMsg').textContent = engine
      ? `No EPUB files in ${dl?.folder || 'your Downloads folder'} yet. Use “Add a book” to pick one from elsewhere.`
      : 'No books yet. Tap “Add a book” and choose an EPUB file (for example from Files or iCloud Drive).';
  } else if (!/^Opening|^Could not|^Saving|is not an EPUB/.test($('shelfMsg').textContent)) {
    $('shelfMsg').textContent = '';
  }
  return { saved, dl };
}

// ---------- read aloud ----------
function sayMsg(text, ms = 4000) {
  const m = $('speakMsg');
  m.textContent = text; m.hidden = false;
  clearTimeout(sayMsg.t); sayMsg.t = setTimeout(() => { m.hidden = true; }, ms);
}
function fillVoices() {
  const sel = $('voiceSel');
  const list = Speech.voicesFor(book?.lang);
  if (!list.length) { sel.replaceChildren(new Option('No voices found on this device', '')); return; }
  sel.replaceChildren(...list.map((v) => new Option(`${v.name} (${v.lang})`, v.voiceURI)));
  sel.value = list.some((v) => v.voiceURI === settings.voice) ? settings.voice : list[0].voiceURI;
}
async function togglePlay() {
  if (!Speech.supported || !book) return;
  listened = true;
  if (Speech.playing) { Speech.pause(); return; }
  if (!Speech.count) {
    // A picture-only page (like a cover): start at the next page with words.
    Speech.unlock();
    while (!Speech.count && current < book.spine.length - 1) await renderChapter(current + 1);
    if (!Speech.count) { sayMsg('There is nothing to read aloud here.'); return; }
    Speech.play(0); return;
  }
  Speech.play(Speech.onScreen(Speech.index) ? Speech.index : Speech.firstVisible());
}
Speech.setHooks({
  onState(on) {
    $('playBtn').textContent = on ? '⏸ Pause' : '▶ Read';
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = on ? 'playing' : 'paused';
  },
  onSentence() { clearTimeout(saveTimer); saveTimer = setTimeout(savePos, 500); },
  async onChapterEnd() {
    if (current >= book.spine.length - 1) { sayMsg('That was the end of the book.'); return; }
    do { await renderChapter(current + 1); } while (!Speech.count && current < book.spine.length - 1);
    if (Speech.count) Speech.play(0);
  },
  onError(code) { sayMsg(`The voice stopped (${code}). Try another voice under Aa.`, 6000); },
});
Speech.onVoicesChanged(() => { if (book) fillVoices(); });
function updateMedia() {
  if (!('mediaSession' in navigator) || !book || !window.MediaMetadata) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: book.spine[current].title, artist: book.author || '', album: book.title });
  } catch { /* ignore */ }
}
if ('mediaSession' in navigator) {
  const on = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch { /* not offered */ } };
  on('play', () => { if (!Speech.playing) togglePlay(); });
  on('pause', () => Speech.pause());
  on('nexttrack', () => Speech.skip(1));
  on('previoustrack', () => Speech.skip(-1));
}
$('playBtn').onclick = togglePlay;
$('backBtn').onclick = () => { listened = true; Speech.skip(-1); };
$('fwdBtn').onclick = () => { listened = true; Speech.skip(1); };
const RATES = [0.8, 0.9, 1, 1.1, 1.2, 1.35, 1.5, 1.75, 2];
$('rateBtn').onclick = () => {
  settings.rate = RATES.find((r) => r > settings.rate + 0.01) || RATES[0];
  applySettings();
  if (Speech.playing) Speech.play(Speech.index);
};
$('rate').oninput = () => { settings.rate = Number($('rate').value); applySettings(); };
$('rate').onchange = () => { if (Speech.playing) Speech.play(Speech.index); };
$('voiceSel').onchange = () => {
  settings.voice = $('voiceSel').value; applySettings();
  if (Speech.playing) Speech.play(Speech.index);
};
$('voiceSet').hidden = !Speech.supported;

// ---------- controls ----------
$('openFile').onclick = () => $('fileInput').click();
$('fileInput').onchange = (e) => { addFile(e.target.files[0]); e.target.value = ''; };
$('shelfBtn').onclick = backToShelf;
$('tocBtn').onclick = () => showToc($('toc').hidden);
$('scrim').onclick = () => showToc(false);
$('setBtn').onclick = () => { $('settings').hidden = !$('settings').hidden; };
$('prevBtn').onclick = () => renderChapter(current - 1);
$('nextBtn').onclick = () => renderChapter(current + 1);
$('page').addEventListener('click', (e) => {
  const a = e.target.closest('a[data-goto]');
  if (a) {
    e.preventDefault();
    const idx = Number(a.dataset.goto);
    if (idx === current && a.dataset.frag) document.getElementById(a.dataset.frag)?.scrollIntoView();
    else renderChapter(idx, a.dataset.frag || 'top');
    return;
  }
  if (e.target.closest('a') || String(window.getSelection?.() || '')) return;
  // Tap a sentence: read from there (or mark it as the starting point).
  const si = Speech.sentenceOf(e.target);
  if (si < 0) return;
  if (Speech.playing) Speech.play(si);
  else if (listened) Speech.choose(si);
});
document.addEventListener('click', (e) => {
  if (!$('settings').hidden && !e.target.closest('#settings, #setBtn')) $('settings').hidden = true;
});

// Keyboard: → / Space / PageDown read on (next chapter at the end),
// ← / PageUp go back, C = chapters, R = read aloud / pause, Esc closes panels.
addEventListener('keydown', (e) => {
  if (!book || $('reader').hidden || e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.target.closest && e.target.closest('input, select, textarea')) return;
  const atBottom = scrollY + innerHeight >= document.documentElement.scrollHeight - 4;
  const atTop = scrollY <= 2;
  const step = innerHeight - 80;
  if (e.key === 'Escape') { showToc(false); $('settings').hidden = true; return; }
  if (e.key === 'c' || e.key === 'C') { showToc($('toc').hidden); return; }
  if (e.key === 'r' || e.key === 'R') { togglePlay(); return; }
  if (!$('toc').hidden) return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey)) {
    e.preventDefault();
    if (atBottom) { if (current < book.spine.length - 1) renderChapter(current + 1); }
    else window.scrollBy({ top: step, behavior: 'smooth' });
  } else if (e.key === 'ArrowLeft' || e.key === 'PageUp' || (e.key === ' ' && e.shiftKey)) {
    e.preventDefault();
    if (atTop) { if (current > 0) renderChapter(current - 1, 'bottom'); }
    else window.scrollBy({ top: -step, behavior: 'smooth' });
  }
});

// Drag an EPUB onto the window to read it.
addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
addEventListener('drop', (e) => {
  e.preventDefault(); document.body.classList.remove('dragging');
  const f = [...(e.dataTransfer?.files || [])].find((x) => /\.epub$/i.test(x.name));
  if (f) { if (!$('reader').hidden) savePos(); addFile(f); }
});

// Works offline once opened (and can be added to an iPhone home screen).
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

async function detectEngine() {
  // The engine only ever runs on this PC; the online copy never asks for it.
  if (!/^https?:$/.test(location.protocol) || !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return false;
  try {
    const r = await fetch('api/ping', { cache: 'no-store' });
    return r.ok && (await r.json()).ok === true;
  } catch { return false; }
}

// Start: show the shelf, or reopen the book named in the address.
(async () => {
  engine = await detectEngine();
  if (engine) {
    $('shelfSub').textContent = 'Books in your Downloads folder, and books you added. Click one to read; it opens where you left off.';
    setInterval(() => fetch('api/ping').catch(() => {}), 60000);   // keep the engine awake
  }
  const iOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const installed = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  $('install').hidden = !(iOS && !installed);

  const { saved, dl } = await loadShelf();
  const q = new URLSearchParams(location.search);
  const s = q.get('saved') && saved.find((m) => m.key === q.get('saved'));
  if (s) { openSaved(s); return; }
  const hit = q.get('book') && dl?.books.find((b) => b.name === q.get('book'));
  if (hit) openFromDownloads(hit.name, hit.size);
})();
