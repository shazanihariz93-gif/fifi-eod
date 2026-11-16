// FiFi EOD Report Builder — app logic
'use strict';

/* ---------- storage ---------- */
const KEY = 'fifi-eod-v1';
let S = { reports: [] };
function load() { try { const v = localStorage.getItem(KEY); if (v) S = JSON.parse(v); } catch (e) {} }
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); S._fail = false; } catch (e) { S._fail = true; } }
const lk = n => n.replace('.', '_');
const uid = () => Math.random().toString(36).slice(2, 10);

function newDrill(n) {
  return { type: n === 0 ? 'galley' : 'workshop', loc: '', crew: '', improved: n === 1,
    tr: [0, 1, 2].map(() => ({ lv: 'mixed', x: '' })), vals: {}, picks: {}, prev: {},
    extra: Object.fromEntries(PHASES.map(p => [p.id, { h: '', s: '' }])), photos: [] };
}
function newLesson() { return { on: true, crew: '', lv: 'average', pts: {}, fds: {}, sgs: {}, vals: {}, xr: '', xh: '', xs: '', photos: [] }; }
function newReport() {
  return { id: uid(), vessel: '', from: '', to: '', trainers: ['', ''], created: Date.now(),
    drills: [newDrill(0), newDrill(1)], lessons: Object.fromEntries(LESSONS.map(l => [lk(l.n), newLesson()])) };
}

/* ---------- photo store (IndexedDB, stays on this phone) ---------- */
let DB = null;
function idb() {
  if (DB) return DB;
  DB = new Promise((res, rej) => { try { const q = indexedDB.open('fifi-eod-photos', 1); q.onupgradeneeded = () => q.result.createObjectStore('p'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); } catch (e) { rej(e); } });
  return DB;
}
async function pPut(id, blob) { const d = await idb(); return new Promise((res, rej) => { const t = d.transaction('p', 'readwrite'); t.objectStore('p').put(blob, id); t.oncomplete = res; t.onerror = () => rej(t.error); }); }
async function pGet(id) { const d = await idb(); return new Promise(res => { const q = d.transaction('p').objectStore('p').get(id); q.onsuccess = () => res(q.result); q.onerror = () => res(null); }); }
async function pDel(id) { try { const d = await idb(); d.transaction('p', 'readwrite').objectStore('p').delete(id); } catch (e) {} }
// Shrink a phone photo to max 1600 px JPEG (about 200-400 KB)
async function shrink(file) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
  const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(img.src);
  const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.8));
  return { blob, w: c.width, h: c.height };
}
function photosOf(r) { const all = []; r.drills.forEach(d => all.push(...d.photos)); Object.values(r.lessons).forEach(x => all.push(...x.photos)); return all; }

/* ---------- text helpers ---------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PH = /\{([^{}]+)\}/g;
const phs = (...strs) => [...new Set(strs.filter(Boolean).join(' ').match(PH) || [])].map(m => m.slice(1, -1));
function opts(key) {
  if (key === 'Squad') return SQUADS;
  if (key === 'rank') return RANKS;
  if (key.includes(' / ')) return key.split(' / ');
  return null;
}
function fill(str, vals) {
  return String(str || '').replace(PH, (m, k) => {
    const o = opts(k); let v = vals[k];
    if (!v && o) v = o[0];
    return v ? v : '[' + k + ']';
  });
}
const cap1 = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
const joinList = a => a.length <= 1 ? (a[0] || '') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
const sentence = s => { s = (s || '').trim(); if (!s) return ''; s = cap1(s); return /[.!?]$/.test(s) ? s : s + '.'; };

/* ---------- report text generation ---------- */
// Output: list of blocks {k:'h1'|'h2'|'h3'|'p', runs:[{t, free}]}
function drillTitle(d, i) {
  const t = DRILL_TYPES.find(x => x.id === d.type) || DRILL_TYPES[0];
  const title = t.id === 'other' ? 'Fire In ' + (d.loc || '[location]') : t.title + (t.loc ? ' (' + t.loc + ')' : '');
  return '3.' + (i + 1) + '. ' + title;
}
function picked(d, ph) { return OBS[ph].map((o, i) => ({ o, i, p: d.picks[ph + ':' + i] })).filter(x => x.p); }
function obsVals(d, ph, i) { return Object.assign({}, d.vals[ph + ':' + i] || {}); }

// Trainers' Remarks are written from the observations: all good = good, mostly needs work = needs, else mixed
function autoLevel(g, b) { if (!g && !b) return null; if (!b) return 'good'; if (!g && b >= 3) return 'needs'; return 'mixed'; }
function sugCands(d, ph) {
  const c = picked(d, ph).filter(x => x.o.k === 'f' && x.o.s).map(x => ({ id: 'o' + x.i, t: fill(x.o.s, obsVals(d, ph, x.i)) }));
  d.extra[ph].s.split('\n').map(s => s.trim()).filter(Boolean).forEach((s, n) => c.push({ id: 'x' + n, t: s, free: true }));
  return c;
}
function sugChosen(d, ph) {
  const c = sugCands(d, ph), sel = (d.sug && d.sug[ph]) || [];
  const chosen = c.filter(x => sel.includes(x.id));
  for (const x of c) { if (chosen.length >= 2) break; if (!chosen.includes(x)) chosen.push(x); }
  return chosen.slice(0, 2);
}
function genDrill(d, i) {
  const B = [];
  B.push({ k: 'h2', runs: [{ t: drillTitle(d, i) }] });
  B.push({ k: 'h3', runs: [{ t: "Crews' Remarks" }] });
  B.push({ k: 'p', runs: [{ t: d.crew.trim() || '[Crew remark]', free: true }] });
  B.push({ k: 'h3', runs: [{ t: "Trainers' Remarks" }] });
  TR_HEADS.forEach((h, hi) => {
    const good = [], bad = [];
    PHASES.filter(p => p.tr === hi).forEach(p => picked(d, p.id).forEach(x => (x.o.k === 't' ? good : bad).push(fill(x.o.c, obsVals(d, p.id, x.i)))));
    const lv = autoLevel(good.length, bad.length);
    B.push({ k: 'p', runs: [{ t: (hi + 1) + '. ' + h.name, b: true }] });
    if (!lv) { B.push({ k: 'p', runs: [{ t: '[No observations tapped for this heading]', free: true }] }); return; }
    let t = (hi === 0 && i === 1 && d.improved && lv !== 'needs') ? 'Noticeable improvement was observed compared with the earlier drill. ' : '';
    t += h[lv];
    if (lv === 'good') { if (good.length) t += ' Good practice was observed, including ' + joinList(good) + '.'; if (bad.length) t += ' Minor intervention was required regarding ' + joinList(bad) + '.'; }
    else if (lv === 'mixed') { if (good.length) t += ' Positive aspects included ' + joinList(good) + '.'; if (bad.length) t += ' However, several issues were observed, including ' + joinList(bad) + '.'; }
    else { if (bad.length) t += ' Issues observed included ' + joinList(bad) + '.'; if (good.length) t += ' Positive practice was observed in ' + joinList(good) + '.'; }
    B.push({ k: 'p', runs: [{ t }] });
  });
  // Highlighted Points
  B.push({ k: 'h3', runs: [{ t: 'Highlighted Points' }] });
  let n = 0;
  PHASES.forEach(p => {
    const runs = [];
    picked(d, p.id).forEach(x => {
      const v = obsVals(d, p.id, x.i);
      runs.push({ t: (runs.length ? ' ' : '') + cap1(fill(x.o.h, v)) });
      const pv = d.prev[p.id + ':' + x.i];
      if (pv) runs.push({ t: ' The ' + pv + ' had attended previous ST Engineering training.' });
    });
    if (d.extra[p.id].h.trim()) runs.push({ t: (runs.length ? ' ' : '') + sentence(d.extra[p.id].h), free: true });
    if (!runs.length) return;
    B.push({ k: 'p', runs: [{ t: (++n) + '. ' + p.name, b: true }] });
    B.push({ k: 'p', runs });
  });
  if (!n) B.push({ k: 'p', runs: [{ t: '[No observations selected]', free: true }] });
  // Suggestions
  B.push({ k: 'h3', runs: [{ t: 'Suggestions For Improvement Points' }] });
  n = 0;
  PHASES.forEach(p => {
    const list = sugChosen(d, p.id);
    if (!list.length) return;
    B.push({ k: 'p', runs: [{ t: (++n) + '. ' + p.name, b: true }] });
    list.slice(0, 2).forEach((s, j) => B.push({ k: 'p', ind: true, runs: [{ t: 'abcd'[j] + '. ' + sentence(s.t), free: s.free }] }));
  });
  if (!n) B.push({ k: 'p', runs: [{ t: '[No suggestions selected]', free: true }] });
  genPhotos(B, d.photos, drillTitle(d, i).split(' ')[0].replace(/\.$/, ''));
  return B;
}

function genPhotos(B, photos, prefix) {
  if (!photos.length) return;
  B.push({ k: 'h3', runs: [{ t: 'Photos' }] });
  photos.forEach((ph, j) => {
    if (ph.id) B.push({ k: 'img', id: ph.id, w: ph.w, h: ph.h, runs: [] });
    B.push({ k: 'p', runs: [{ t: 'Photo ' + prefix + '-' + (j + 1) + ': ', b: true }, { t: sentence(ph.cap) || '[caption]', free: ph.free }] });
  });
}

function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }
function lessonOpener(L, x, rid) {
  const evs = L.pt.filter((p, i) => x.pts[i] && p.ev).map(p => p.ev).slice(0, 3);
  if (!evs.length) return L.lv[x.lv];
  const list = LEVEL_OPENERS[x.lv];
  const k = (x.vi ?? hash((rid || '') + L.n)) % list.length;
  return list[k].replace('{tp}', L.tp).replace('{ev}', joinList(evs));
}
function genLesson(L, x, rid) {
  const B = [];
  B.push({ k: 'h2', runs: [{ t: L.n + '. ' + L.t }] });
  B.push({ k: 'h3', runs: [{ t: "Crews' Remarks" }] });
  B.push({ k: 'p', runs: [{ t: x.crew.trim() || '[Crew remark]', free: true }] });
  B.push({ k: 'h3', runs: [{ t: "Trainers' Remarks" }] });
  const r = [{ t: fill(lessonOpener(L, x, rid), x.vals) }];
  L.fd.forEach((f, i) => { if (x.fds[i]) r.push({ t: ' ' + fill(f.r, x.vals) }); });
  if (x.xr.trim()) r.push({ t: ' ' + sentence(x.xr), free: true });
  B.push({ k: 'p', runs: r });
  B.push({ k: 'h3', runs: [{ t: 'Highlighted Points' }] });
  const h = [];
  L.pt.forEach((p, i) => { if (x.pts[i]) h.push({ t: (h.length ? ' ' : '') + fill(p.x, x.vals) }); });
  L.fd.forEach((f, i) => { if (x.fds[i] && f.h) h.push({ t: (h.length ? ' ' : '') + fill(f.h, x.vals) }); });
  if (x.xh.trim()) h.push({ t: (h.length ? ' ' : '') + sentence(x.xh), free: true });
  B.push({ k: 'p', runs: h.length ? h : [{ t: '[Select teaching points]', free: true }] });
  B.push({ k: 'h3', runs: [{ t: 'Suggestions For Improvement Points' }] });
  const s = [];
  L.fd.forEach((f, i) => { if (x.fds[i] && f.s) s.push({ t: fill(f.s, x.vals) }); });
  L.sg.forEach((g, i) => { if (x.sgs[i]) s.push({ t: g }); });
  x.xs.split('\n').map(v => v.trim()).filter(Boolean).forEach(v => s.push({ t: v, free: true }));
  s.slice(0, 3).forEach((v, j) => B.push({ k: 'p', runs: [{ t: (j + 1) + '. ' + sentence(v.t), free: v.free }] }));
  if (!s.length) B.push({ k: 'p', runs: [{ t: '[Select a suggestion]', free: true }] });
  genPhotos(B, x.photos, L.n);
  return B;
}

function genReport(R) {
  const B = [];
  B.push({ k: 'h1', runs: [{ t: (R.vessel || '[Vessel]') + ' – EOD Report Draft' }] });
  B.push({ k: 'p', runs: [{ t: 'Dates: ' + (R.from || '[from]') + ' to ' + (R.to || '[to]') + '   Trainers: ' + (R.trainers.filter(Boolean).join(', ') || '[trainers]') }] });
  B.push({ k: 'p', runs: [{ t: 'Highlighted text = typed by the PTC. Vet these parts closely.', free: true }] });
  B.push({ k: 'h1', runs: [{ t: '3. DRILLS' }] });
  R.drills.forEach((d, i) => B.push(...genDrill(d, i)));
  B.push({ k: 'h1', runs: [{ t: '4. TRAININGS' }] });
  LESSONS.forEach(L => { const x = R.lessons[lk(L.n)]; if (x && x.on) B.push(...genLesson(L, x, R.id)); });
  return polish(B);
}

/* ---------- reviewer rules: glossary, double stops, abbreviations once ---------- */
function polish(B) {
  const body = B.filter(b => b.k === 'p');
  body.forEach(b => b.runs.forEach(r => {
    let t = r.t;
    GLOSSARY.forEach(([re, rep]) => { t = t.replace(re, rep); });
    ABBR.forEach(([a, full]) => { t = t.split(full + ' (' + a + ')').join(a); });
    t = t.replace(/\.{2,}/g, '.').replace(/ {2,}/g, ' ').replace(/ \./g, '.');
    r.t = t;
  }));
  ABBR.forEach(([a, full]) => {
    const re = new RegExp('\\b' + a + '(s?)\\b');
    for (const b of body) for (const r of b.runs) {
      if (re.test(r.t)) { r.t = r.t.replace(re, full + '$1 (' + a + '$1)'); return; }
    }
  });
  // fix a/an after abbreviations are spelled out (an RSE -> a Rescue Scene Evaluation (RSE))
  body.forEach(b => b.runs.forEach(r => { r.t = r.t.replace(/\b([Aa])n (?=[BCDFGJKLMNPQRSTVWXYZ][a-z])/g, '$1 ').replace(/\b([Aa]) (?=[AEIOU][a-z])/g, '$1n '); }));
  return B;
}
function blocksToText(B) { return B.filter(b => b.k !== 'img').map(b => (b.ind ? '    ' : '') + b.runs.map(r => r.t).join('')).join('\n\n'); }

/* ---------- Word (.docx) writer, no libraries ---------- */
const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function zip(files) {
  const enc = new TextEncoder(), parts = [], cd = []; let off = 0;
  for (const [name, str] of files) {
    const nm = enc.encode(name), data = typeof str === 'string' ? enc.encode(str) : str, crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(8, 0, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, nm.length, true);
    parts.push(new Uint8Array(lh.buffer), nm, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, nm.length, true); ch.setUint32(42, off, true);
    cd.push(new Uint8Array(ch.buffer), nm);
    off += 30 + nm.length + data.length;
  }
  const cdSize = cd.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, off, true);
  return new Blob([...parts, ...cd, new Uint8Array(end.buffer)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}
function docxXml(B, imgs) {
  const x = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const size = { h1: 28, h2: 24, h3: 22, p: 22 };
  let n = 0;
  const paras = B.map(b => {
    if (b.k === 'img') {
      const im = imgs && imgs[b.id]; if (!im) return '';
      n++; const W = 3600000, H = Math.round(W * (im.h / im.w)); // 10 cm wide
      return '<w:p><w:pPr><w:spacing w:before="120" w:after="60"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="' + W + '" cy="' + H + '"/><wp:docPr id="' + n + '" name="Picture ' + n + '"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="' + n + '" name="image' + n + '.jpeg"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg' + im.n + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + W + '" cy="' + H + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
    }
    const bold = b.k !== 'p';
    const ppr = '<w:pPr><w:spacing w:before="' + (b.k === 'p' ? 0 : 200) + '" w:after="120"/>' + (b.ind ? '<w:ind w:left="567"/>' : '') + '</w:pPr>';
    const runs = b.runs.map(r => '<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/>' + (bold || r.b ? '<w:b/>' : '') + (r.free ? '<w:highlight w:val="yellow"/>' : '') + '<w:sz w:val="' + size[b.k] + '"/></w:rPr><w:t xml:space="preserve">' + x(r.t) + '</w:t></w:r>').join('');
    return '<w:p>' + ppr + runs + '</w:p>';
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>' + paras + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>';
}
// imgs: {photoId: {bytes: Uint8Array, w, h}} or null for text only
function makeDocx(B, imgs) {
  imgs = imgs || {};
  const ids = Object.keys(imgs); ids.forEach((id, i) => { imgs[id].n = i + 1; });
  const rels = ids.map(id => '<Relationship Id="rIdImg' + imgs[id].n + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image' + imgs[id].n + '.jpeg"/>').join('');
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + rels + '</Relationships>'],
    ['word/document.xml', docxXml(B, imgs)],
    ...ids.map(id => ['word/media/image' + imgs[id].n + '.jpeg', imgs[id].bytes]),
  ]);
}
async function loadImgs(r) {
  const out = {};
  for (const p of photosOf(r)) { if (!p.id) continue; const b = await pGet(p.id); if (b) out[p.id] = { bytes: new Uint8Array(await b.arrayBuffer()), w: p.w, h: p.h }; }
  return out;
}

/* ---------- send / save a file ---------- */
async function sendFile(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return 'shared'; }
  } catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
  try {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return 'downloaded';
  } catch (e) { return 'failed'; }
}

/* ---------- UI ---------- */
let V = { view: 'home' }; // {view:'home'|'report'|'drill'|'lesson'|'preview', id, i, n}
const $ = s => document.querySelector(s);
const R = () => S.reports.find(r => r.id === V.id);
function go(v) { V = v; render(); window.scrollTo(0, 0); }
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), 2600); }

function phInputs(keys, vals, path) {
  return keys.map(k => {
    const o = opts(k), v = vals[k] || '';
    if (o) return '<label class="ph"><span>' + esc(k === 'Squad' ? 'Squad' : k === 'rank' ? 'Rank' : 'Choose') + '</span><select data-ph="' + esc(path) + '" data-k="' + esc(k) + '">' + o.map(x => '<option' + (x === (v || o[0]) ? ' selected' : '') + '>' + esc(x) + '</option>').join('') + '</select></label>';
    return '<label class="ph"><span>' + esc(k) + '</span><input data-ph="' + esc(path) + '" data-k="' + esc(k) + '" value="' + esc(v) + '" placeholder="type ' + esc(k) + '"></label>';
  }).join('');
}
function seg(path, cur, list) {
  return '<div class="seg">' + list.map(([v, l]) => '<button data-act="set" data-path="' + path + '" data-v="' + v + '" class="' + (cur === v ? 'on' : '') + '">' + l + '</button>').join('') + '</div>';
}
function photoBlock(arr, path, max, capOpts) {
  let h = '<h3>Photos <small>' + arr.length + ' / ' + max + '</small></h3><p class="note">Add photos after disembarking, not at sea. Choose the photo from your gallery and write its caption in your own words: what you saw, then why it matters. The Lead Trainer will polish the wording.</p>';
  arr.forEach((p, j) => {
    h += '<div class="photo"><div class="prow">' + (p.id ? '<img class="thumb" data-thumb="' + p.id + '" alt="">' : '') + '<span class="pn">Photo ' + (j + 1) + '</span>' +
      '<button class="btn sm ghost" data-act="delphoto" data-path="' + path + '" data-j="' + j + '">Remove</button></div>' +
      '<textarea data-cap="' + path + '" data-j="' + j + '" rows="3" spellcheck="true" placeholder="e.g. Hose laid in a pile at the galley door. Kinks slowed the attack team.">' + esc(p.cap) + '</textarea></div>';
  });
  if (arr.length < max) h += '<label class="btn ghost">+ Add photo<input type="file" accept="image/*" hidden data-addphoto="' + path + '"></label>';
  else h += '<p class="note">Limit reached: ' + max + ' photos maximum.</p>';
  return h;
}
async function fillThumbs() {
  for (const im of document.querySelectorAll('img[data-thumb]')) { const b = await pGet(im.dataset.thumb).catch(() => null); if (b) im.src = URL.createObjectURL(b); }
}
const getPath = (path) => { const R0 = R(); return path.split('.').reduce((o, k) => o[k], R0); };
function setPath(path, val) { const ks = path.split('.'); const last = ks.pop(); const o = ks.reduce((o, k) => o[k], R()); o[last] = val; }

function viewHome() {
  let h = '<header><h1>FiFi EOD Report Builder</h1></header><main>';
  h += '<button class="btn big" data-act="new">+ New report</button>';
  if (!S.reports.length) h += '<p class="note">No reports yet. Your reports are saved on this device only.</p>';
  S.reports.slice().sort((a, b) => b.created - a.created).forEach(r => {
    h += '<div class="card"><div class="ct" data-act="open" data-id="' + r.id + '"><b>' + esc(r.vessel || 'Untitled vessel') + '</b><span>' + esc([r.from, r.to].filter(Boolean).join(' – ') || 'No dates') + '</span></div>' +
      (V.del === r.id ? '<button class="btn sm danger" data-act="delyes" data-id="' + r.id + '">Delete?</button><button class="btn sm ghost" data-act="delno">Keep</button>' : '<button class="btn sm ghost" data-act="del" data-id="' + r.id + '">Delete</button>') + '</div>';
  });
  h += '<label class="btn ghost">Open a draft copy<input type="file" accept=".json,application/json" hidden id="restore"></label>';
  return h + '</main>';
}

function viewReport() {
  const r = R();
  let h = '<header><button class="back" data-act="home">‹</button><h1>' + esc(r.vessel || 'New report') + '</h1></header><main>' +
    '<p class="note">Everything saves on this phone as you go. You can close the app and continue another day. Saved automatically.</p>';
  h += '<div class="card col"><label>Vessel<input data-bind="vessel" value="' + esc(r.vessel) + '" placeholder="e.g. CMA CGM CEDRUS"></label>' +
    '<div class="two"><label>From<input type="date" data-bind="from" value="' + esc(r.from) + '"></label><label>To<input type="date" data-bind="to" value="' + esc(r.to) + '"></label></div>' +
    [0, 1].map(j => '<label>Trainer ' + (j + 1) + '<input data-bind="trainers.' + j + '" value="' + esc(r.trainers[j] || '') + '" placeholder="Full name" autocomplete="off"></label>').join('') + '</div>';
  h += '<h2>Drills</h2>';
  r.drills.forEach((d, i) => {
    const cnt = Object.keys(d.picks).filter(k => d.picks[k]).length;
    h += '<div class="card" data-act="drill" data-i="' + i + '"><div class="ct"><b>' + esc(drillTitle(d, i)) + '</b><span>' + cnt + ' observations · ' + d.photos.length + '/' + PHOTO_CAP.drill + ' photos</span></div><span class="chev">›</span></div>';
  });
  h += '<h2>Lessons</h2>';
  LESSONS.forEach(L => {
    const x = r.lessons[lk(L.n)];
    const done = x.on ? (Object.values(x.pts).some(Boolean) ? 'Ready' : 'To do') : 'Not conducted';
    h += '<div class="card" data-act="lesson" data-n="' + L.n + '"><div class="ct"><b>' + L.n + ' ' + esc(L.t) + '</b><span class="st ' + (done === 'Ready' ? 'ok' : '') + '">' + done + '</span></div><span class="chev">›</span></div>';
  });
  h += '<div class="bar"><button class="btn big" data-act="preview">Preview & export Word</button><button class="btn ghost" data-act="backup">Send draft copy</button><p class="note">You do not need to press save: every tap is saved on this phone automatically. "Send draft copy" makes a small file of this report (without photos) that you can send to yourself or the Lead Trainer as a spare. It can be opened in this app on any phone.</p></div>';
  return h + '</main>';
}

function viewDrill() {
  const r = R(), i = V.i, d = r.drills[i], P = 'drills.' + i;
  let h = '<header><button class="back" data-act="report">‹</button><h1>Drill ' + (i + 1) + '</h1></header><main>';
  h += '<div class="card col"><label>Drill<select data-bind="' + P + '.type">' + DRILL_TYPES.map(t => '<option value="' + t.id + '"' + (t.id === d.type ? ' selected' : '') + '>' + esc(t.id === 'other' ? 'Other location…' : t.title + ' – ' + t.loc) + '</option>').join('') + '</select></label>' +
    (d.type === 'other' ? '<label>Location<input data-bind="' + P + '.loc" value="' + esc(d.loc) + '" placeholder="e.g. Accommodation (Ship Office)"></label>' : '') +
    (i === 1 ? '<label class="chk"><input type="checkbox" data-bindchk="' + P + '.improved"' + (d.improved ? ' checked' : '') + '> Improved since Drill 1</label>' : '') + '</div>';
  h += '<h2>Crews\' Remarks</h2><div class="starters">' + CREW_STARTERS.map(s => '<button class="chip" data-act="starter" data-path="' + P + '.crew" data-v="' + esc(s) + '">' + esc(s.trim()) + '…</button>').join('') + '</div>' +
    '<textarea data-bind="' + P + '.crew" rows="3" spellcheck="true" placeholder="Dictate or type the crew member\'s words">' + esc(d.crew) + '</textarea>';
  h += '<p class="note">Trainers\' Remarks are written for you from the observations you tap below.</p>';
  h += '<h2>Observations</h2><p class="note">Tap what you saw. ✓ = done well, ✗ = needs work. Each tap writes the remarks, highlighted point, suggestion and caption.</p>';
  PHASES.forEach(p => {
    const n = OBS[p.id].filter((o, j) => d.picks[p.id + ':' + j]).length;
    const open = V.open === p.id;
    h += '<div class="acc"><button class="acch" data-act="acc" data-v="' + p.id + '"><span>' + p.name + '</span><span class="cnt">' + (n || '') + '</span><span>' + (open ? '−' : '+') + '</span></button>';
    if (open) {
      h += '<div class="accb">';
      OBS[p.id].forEach((o, j) => {
        const key = p.id + ':' + j, on = !!d.picks[key];
        h += '<div class="obs ' + (on ? 'on ' : '') + o.k + '"><button data-act="pick" data-key="' + key + '"><span class="ic">' + (o.k === 't' ? '✓' : '✗') + '</span>' + esc(o.l) + '</button>';
        if (on) {
          const ks = phs(o.c, o.h, o.s, o.p);
          if (ks.length) h += '<div class="phs">' + phInputs(ks, d.vals[key] || {}, P + '.vals.' + key) + '</div>';
          h += '<div class="prev">' + esc(fill(o.h, d.vals[key] || {})) + '</div>';
          if (o.k === 't') h += '<label class="ph"><span>Prev. ST Eng training</span><select data-prev="' + key + '"><option value="">No</option>' + RANKS.map(rk => '<option' + (d.prev[key] === rk ? ' selected' : '') + '>' + esc(rk) + '</option>').join('') + '</select></label>';
        }
        h += '</div>';
      });
      h += '<label>Other highlighted point (optional)<textarea data-bind="' + P + '.extra.' + p.id + '.h" rows="2" spellcheck="true">' + esc(d.extra[p.id].h) + '</textarea></label>' +
        '<label>Other suggestion, one per line (optional)<textarea data-bind="' + P + '.extra.' + p.id + '.s" rows="2" spellcheck="true">' + esc(d.extra[p.id].s) + '</textarea></label>';
      const cands = sugCands(d, p.id);
      if (cands.length > 2) {
        const ch = sugChosen(d, p.id).map(x => x.id);
        h += '<p class="warn">The report allows 2 suggestions per heading. Pick the 2 that matter most:</p>' +
          cands.map(x => '<button class="tog ' + (ch.includes(x.id) ? 'on' : '') + '" data-act="sug" data-ph="' + p.id + '" data-id="' + x.id + '">' + esc(x.t) + '</button>').join('');
      }
      h += '</div>';
    }
    h += '</div>';
  });
  const caps = []; PHASES.forEach(p => OBS[p.id].forEach((o, j) => { if (d.picks[p.id + ':' + j] && o.p) caps.push(fill(o.p, d.vals[p.id + ':' + j] || {})); }));
  V.caps = caps;
  h += photoBlock(d.photos, P + '.photos', PHOTO_CAP.drill, caps);
  return h + '<div class="bar"><button class="btn big" data-act="report">Done</button></div></main>';
}

function viewLesson() {
  const r = R(), L = LESSONS.find(l => l.n === V.n), x = r.lessons[lk(L.n)], P = 'lessons.' + lk(L.n);
  let h = '<header><button class="back" data-act="report">‹</button><h1>' + L.n + ' ' + esc(L.t) + '</h1></header><main>';
  h += '<label class="chk card"><input type="checkbox" data-bindchk="' + P + '.on"' + (x.on ? ' checked' : '') + '> Lesson conducted</label>';
  if (!x.on) return h + '</main>';
  h += '<h2>Crews\' Remarks</h2><div class="starters">' + CREW_STARTERS.slice(0, 2).map(s => '<button class="chip" data-act="starter" data-path="' + P + '.crew" data-v="' + esc(s) + '">' + esc(s.trim()) + '…</button>').join('') + '</div>' +
    '<textarea data-bind="' + P + '.crew" rows="3" spellcheck="true" placeholder="Dictate or type the crew member\'s words">' + esc(x.crew) + '</textarea>';
  h += '<h2>Crew level</h2>' + seg(P + '.lv', x.lv, [['strong', 'Strong'], ['average', 'Average'], ['needs', 'Needs work']]);
  const op = lessonOpener(L, x, r.id);
  const lks = phs(op); if (lks.length) h += phInputs(lks, x.vals, P + '.vals');
  h += '<div class="prev">' + esc(fill(op, x.vals)) + '</div><button class="btn sm ghost" data-act="vary">Other wording</button>';
  h += '<h2>Teaching points covered</h2>' + L.pt.map((p, i) => '<button class="tog ' + (x.pts[i] ? 'on' : '') + '" data-act="tog" data-path="' + P + '.pts.' + i + '">' + esc(p.l) + '</button>').join('');
  h += '<h2>Ship findings</h2>' + L.fd.map((f, i) => {
    let s = '<button class="tog ' + (x.fds[i] ? 'on' : '') + '" data-act="tog" data-path="' + P + '.fds.' + i + '">' + esc(f.l) + '</button>';
    if (x.fds[i]) { const ks = phs(f.r, f.h, f.s); if (ks.length) s += '<div class="phs">' + phInputs(ks, x.vals, P + '.vals') + '</div>'; }
    return s;
  }).join('');
  const all = (x.fds ? L.fd.filter((f, i) => x.fds[i] && f.s).length : 0);
  h += '<h2>Suggestions <small>pick 1–3</small></h2>' + (all ? '<p class="note">' + all + ' added from ship findings.</p>' : '') + L.sg.map((g, i) => '<button class="tog ' + (x.sgs[i] ? 'on' : '') + '" data-act="tog" data-path="' + P + '.sgs.' + i + '">' + esc(g) + '</button>').join('');
  h += '<h2>Extra (optional)</h2><label>Trainers\' Remarks<textarea data-bind="' + P + '.xr" rows="2" spellcheck="true">' + esc(x.xr) + '</textarea></label>' +
    '<label>Highlighted Points<textarea data-bind="' + P + '.xh" rows="2" spellcheck="true">' + esc(x.xh) + '</textarea></label>' +
    '<label>Suggestions, one per line<textarea data-bind="' + P + '.xs" rows="2" spellcheck="true">' + esc(x.xs) + '</textarea></label>';
  V.caps = L.cap.slice();
  h += photoBlock(x.photos, P + '.photos', PHOTO_CAP.lesson, V.caps);
  return h + '<div class="bar"><button class="btn big" data-act="report">Done</button></div></main>';
}

function viewPreview() {
  const B = genReport(R());
  let h = '<header><button class="back" data-act="report">‹</button><h1>Preview</h1></header><main>';
  const np = photosOf(R()).filter(p => p.id).length;
  h += '<div class="bar top"><button class="btn big" data-act="export">Send Word file (text only)</button><p class="note">Small file. Works at sea over WhatsApp or email.</p>' +
    (np ? '<button class="btn big ghost" data-act="exportp">Send Word file with ' + np + (np === 1 ? ' photo' : ' photos') + '</button><p class="note">About ' + Math.max(1, Math.round(np * 0.3)) + ' MB. Send this after disembarking.</p>' : '') +
    '<button class="btn ghost" data-act="copy">Copy text</button></div>';
  const missing = blocksToText(B).match(/\[[^\]]+\]/g) || [];
  if (missing.length) h += '<p class="warn">' + missing.length + ' gaps still to fill, shown in [brackets].</p>';
  h += '<div class="doc">' + B.map(b => (b.k === 'img' ? '<p class="note">[photo]</p>' : '<' + (b.k === 'p' ? 'p' : b.k) + (b.ind ? ' class="ind"' : '') + '>' + b.runs.map(r => (r.free ? '<mark>' : '') + (r.b ? '<b>' : '') + esc(r.t) + (r.b ? '</b>' : '') + (r.free ? '</mark>' : '')).join('') + '</' + (b.k === 'p' ? 'p' : b.k) + '>')).join('') + '</div>';
  return h + '</main>';
}

function render() {
  const app = $('#app');
  const y = window.scrollY;
  app.innerHTML = { home: viewHome, report: viewReport, drill: viewDrill, lesson: viewLesson, preview: viewPreview }[V.view]();
  if (V.keep) { window.scrollTo(0, y); V.keep = false; }
  fillThumbs().catch(() => {});
}
const rerender = () => { V.keep = true; render(); };

/* ---------- events ---------- */
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const a = el.dataset.act, r = R();
  if (a === 'new') { const nr = newReport(); S.reports.push(nr); save(); go({ view: 'report', id: nr.id }); }
  else if (a === 'open') go({ view: 'report', id: el.dataset.id });
  else if (a === 'home') go({ view: 'home' });
  else if (a === 'report') go({ view: 'report', id: V.id });
  else if (a === 'del') { V.del = el.dataset.id; rerender(); }
  else if (a === 'delno') { V.del = null; rerender(); }
  else if (a === 'delyes') { const dr = S.reports.find(x => x.id === el.dataset.id); if (dr) photosOf(dr).forEach(p => p.id && pDel(p.id)); S.reports = S.reports.filter(x => x.id !== el.dataset.id); V.del = null; save(); rerender(); }
  else if (a === 'drill') go({ view: 'drill', id: V.id, i: +el.dataset.i, open: 'ppe' });
  else if (a === 'lesson') go({ view: 'lesson', id: V.id, n: el.dataset.n });
  else if (a === 'preview') go({ view: 'preview', id: V.id });
  else if (a === 'set') { setPath(el.dataset.path, el.dataset.v); save(); rerender(); }
  else if (a === 'vary') { const L = LESSONS.find(l => l.n === V.n), x = r.lessons[lk(L.n)]; x.vi = ((x.vi ?? hash(r.id + L.n)) + 1) % 3; save(); rerender(); }
  else if (a === 'tog') { setPath(el.dataset.path, !getPath(el.dataset.path)); save(); rerender(); }
  else if (a === 'acc') { V.open = V.open === el.dataset.v ? null : el.dataset.v; rerender(); }
  else if (a === 'sug') {
    const d = r.drills[V.i]; d.sug = d.sug || {}; const ph = el.dataset.ph;
    let cur = sugChosen(d, ph).map(x => x.id); const id = el.dataset.id;
    if (cur.includes(id)) cur = cur.filter(x => x !== id); else { cur.push(id); if (cur.length > 2) cur.shift(); }
    d.sug[ph] = cur; save(); rerender();
  }
  else if (a === 'pick') { const d = r.drills[V.i]; d.picks[el.dataset.key] = !d.picks[el.dataset.key]; save(); rerender(); }
  else if (a === 'starter') { const cur = getPath(el.dataset.path) || ''; setPath(el.dataset.path, (cur ? cur.trim() + ' ' : '') + el.dataset.v); save(); rerender(); const t = document.querySelector('textarea[data-bind="' + el.dataset.path + '"]'); if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } }
  else if (a === 'delphoto') { const arr = getPath(el.dataset.path); const [p] = arr.splice(+el.dataset.j, 1); if (p && p.id) pDel(p.id); save(); rerender(); }
  else if (a === 'export' || a === 'exportp') {
    const withP = a === 'exportp';
    const name = (r.vessel || 'Vessel').replace(/[^\w -]+/g, '').trim() + (withP ? ' EOD draft with photos.docx' : ' EOD draft.docx');
    let imgs = null; if (withP) { toast('Preparing photos…'); imgs = await loadImgs(r).catch(() => ({})); }
    const res = await sendFile(makeDocx(genReport(r), imgs), name);
    toast(res === 'failed' ? 'Could not save here. Use Copy text instead.' : res === 'cancelled' ? 'Cancelled' : 'Word file ready: ' + name);
  }
  else if (a === 'copy') { try { await navigator.clipboard.writeText(blocksToText(genReport(r))); toast('Report text copied'); } catch (err) { toast('Copy blocked on this device'); } }
  else if (a === 'backup') {
    const blob = new Blob([JSON.stringify({ app: 'fifi-eod', v: 1, report: r })], { type: 'application/json' });
    const res = await sendFile(blob, (r.vessel || 'report').replace(/[^\w -]+/g, '').trim() + ' draft copy.json');
    toast(res === 'failed' ? 'Draft copy could not be sent here' : 'Draft copy ready');
  }
});

document.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.bind) { setPath(t.dataset.bind, t.value); save(); if (t.tagName === 'SELECT') rerender(); }
  else if (t.dataset.cap) { const p = getPath(t.dataset.cap)[+t.dataset.j]; p.cap = t.value; p.free = true; save(); }
  else if (t.dataset.ph && t.tagName === 'INPUT') { phSet(t); }
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.bindchk) { setPath(t.dataset.bindchk, t.checked); save(); rerender(); }
  else if (t.dataset.ph && t.tagName === 'SELECT') { phSet(t); rerender(); }
  else if (t.dataset.prev) { R().drills[V.i].prev[t.dataset.prev] = t.value; save(); }
  else if (t.dataset.capsel !== undefined && t.value !== '') { const p = getPath(t.dataset.capsel)[+t.dataset.j]; p.cap = V.caps[+t.value]; p.free = false; save(); rerender(); }
  else if (t.dataset.addphoto && t.files[0]) {
    const path = t.dataset.addphoto;
    shrink(t.files[0]).then(async ({ blob, w, h }) => { const id = uid(); await pPut(id, blob); getPath(path).push({ id, w, h, cap: '', free: true }); save(); rerender(); })
      .catch(() => toast('Could not add that photo here'));
  }
  else if (t.id === 'restore' && t.files[0]) {
    t.files[0].text().then(txt => {
      try { const j = JSON.parse(txt); if (j.app !== 'fifi-eod') throw 0; const rep = j.report; S.reports = S.reports.filter(x => x.id !== rep.id); S.reports.push(rep); save(); go({ view: 'report', id: rep.id }); toast('Draft opened'); }
      catch (err) { toast('That file is not a FiFi EOD draft copy'); }
    });
  }
});
function phSet(t) {
  const ks = t.dataset.ph.split('.'); const last = ks.pop();
  const base = ks.reduce((o, k) => o[k], R());
  if (!base[last]) base[last] = {};
  base[last][t.dataset.k] = t.value; save();
}

/* ---------- start ---------- */
load(); render();
try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
if ('serviceWorker' in navigator) { try { navigator.serviceWorker.register('sw.js').catch(() => {}); } catch (e) {} }
