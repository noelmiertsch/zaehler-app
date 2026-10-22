/* Zählerablesung Burgkemnitzer Straße 6 – lokale PWA, Daten bleiben auf dem Gerät */
'use strict';
const APP_VERSION = '1.0.0';
const ICON = { 'Wasser': '💧', 'Wärme': '🔥', 'Strom': '⚡', 'Heizöl': '🛢️' };
const ART_ORDER = ['Wasser', 'Wärme', 'Strom', 'Heizöl'];

/* ---------- IndexedDB ---------- */
let dbp;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open('zaehler-buke6', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('kv');
      const s = d.createObjectStore('readings', { keyPath: 'id', autoIncrement: true });
      s.createIndex('date', 'date');
      d.createObjectStore('photos');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then(v => { out = v; });
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
  });
}
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const kvGet = k => tx('kv', 'readonly', s => req(s.get(k)));
const kvSet = (k, v) => tx('kv', 'readwrite', s => { s.put(v, k); });
const allReadings = () => tx('readings', 'readonly', s => req(s.getAll()));
const putReading = r => tx('readings', 'readwrite', s => req(s.put(r)));
const delReading = id => tx('readings', 'readwrite', s => { s.delete(id); });
const getPhoto = id => tx('photos', 'readonly', s => req(s.get(id)));
const putPhoto = (id, b) => tx('photos', 'readwrite', s => { s.put(b, id); });
const delPhoto = id => tx('photos', 'readwrite', s => { s.delete(id); });

/* ---------- Helfer ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
const deDate = iso => iso ? iso.split('-').reverse().join('.') : '';
const days = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5);
const fmt = (v, d = 3) => (v === null || v === undefined || v === '') ? '–' : Number(v).toLocaleString('de-DE', { maximumFractionDigits: d });
function parseNum(s) {
  s = String(s).trim().replace(/\s/g, '');
  if (!s) return NaN;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  return Number(s);
}
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

/* ---------- Zustand ---------- */
let meters = [];   // {nr, messstelle, name, art, einheit, ort, order, aktiv, historie:[[date,value]]}
let stichtag = today();
async function loadState() {
  meters = (await kvGet('meters')) || [];
  stichtag = (await kvGet('stichtag')) || today();
}
const saveMeters = () => kvSet('meters', meters);
const activeMeters = () => meters.filter(m => m.aktiv !== false).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

/* Verlauf eines Zählers: Import-Historie + App-Ablesungen, nach Datum */
function seriesFor(m, readings, excludeId) {
  const pts = (m.historie || []).map(([d, v]) => ({ date: d, value: Number(v), src: 'import' }));
  readings.filter(r => r.nr === m.nr && r.id !== excludeId).forEach(r => pts.push({ date: r.date, value: r.value, src: 'app' }));
  const byDate = new Map(); pts.forEach(p => byDate.set(p.date, p));
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
function check(m, value, date, readings, excludeId) {
  const s = seriesFor(m, readings, excludeId).filter(p => p.date < date);
  const prev = s[s.length - 1], prev2 = s[s.length - 2];
  if (!prev) return { cls: 'ok', text: 'Keine Vorablesung – erste Erfassung für diesen Zähler.' };
  const diff = value - prev.value, d = Math.max(1, days(prev.date, date));
  const u = m.einheit || '';
  if (m.art === 'Heizöl') {
    if (diff > 50) return { cls: 'wa', text: `Tank +${fmt(diff, 0)} L seit ${deDate(prev.date)} – Lieferung? Bitte im Blatt „Heizöl“ eintragen.`, flag: 'Lieferung?' };
    return { cls: 'ok', text: `Verbrauch ${fmt(-diff, 0)} L in ${d} Tagen (≈ ${fmt(-diff / d, 1)} L/Tag).` };
  }
  if (diff < 0) return { cls: 'wa', text: `Kleiner als die letzte Ablesung (${fmt(prev.value)} ${u} am ${deDate(prev.date)}). Zählerwechsel oder Tippfehler?`, flag: 'kleiner als vorher' };
  const rate = diff / d;
  let txt = `+${fmt(diff)} ${u} in ${d} Tagen (≈ ${fmt(rate, 2)} ${u}/Tag`;
  if (prev2) {
    const r2 = (prev.value - prev2.value) / Math.max(1, days(prev2.date, prev.date));
    if (r2 > 0) {
      txt += `, vorher ${fmt(r2, 2)}`;
      if (rate > r2 * 3 && diff > 0) return { cls: 'wa', text: `Ungewöhnlich hoch: ${txt}). Bitte prüfen.`, flag: 'ungewöhnlich hoch' };
      if (rate < r2 / 4 && d > 14 && m.art !== 'Wärme') return { cls: 'wa', text: `Ungewöhnlich niedrig: ${txt}). Bitte prüfen.`, flag: 'ungewöhnlich niedrig' };
    }
  }
  return { cls: 'ok', text: `✓ Plausibel: ${txt}).` };
}
function photoName(m, date, readings, selfId) {
  const base = `Zählerstand ${m.messstelle || m.nr}`;
  const taken = new Set(readings.filter(r => r.date === date && r.id !== selfId && r.photo).map(r => r.photo));
  let n = `${base}_${date}.jpg`, i = 2;
  while (taken.has(n)) n = `${base} ${i++}_${date}.jpg`;
  return n;
}
async function shrink(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const max = 1600, k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise(res => c.toBlob(res, 'image/jpeg', 0.82));
  } finally { URL.revokeObjectURL(url); }
}

/* ---------- Navigation ---------- */
let tab = 'rundgang';
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => go(b.dataset.tab)));
function go(t, arg) {
  if (['rundgang', 'verlauf', 'export', 'zaehler'].includes(t)) {
    tab = t;
    document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  }
  window.scrollTo(0, 0);
  ({ rundgang: vRundgang, ablesen: vAblesen, verlauf: vVerlauf, export: vExport, zaehler: vZaehler, zaehlerEdit: vZaehlerEdit })[t](arg);
}

/* ---------- Ansicht: Rundgang ---------- */
async function vRundgang() {
  const view = $('#view');
  if (!meters.length) {
    view.innerHTML = `<h1>Zählerstände</h1><div class="sub">Burgkemnitzer Str. 6</div>
      <div class="empty">Noch keine Zähler vorhanden.<br>Importiere die Zählerliste<br><b>Zählerliste BuKe 6.json</b> (liegt in 06_Nebenkosten).</div>
      <button class="btn" id="imp0">Zählerliste importieren</button>`;
    $('#imp0').onclick = () => go('zaehler');
    return;
  }
  const rs = await allReadings();
  const am = activeMeters();
  const at = new Map(rs.filter(r => r.date === stichtag).map(r => [r.nr, r]));
  const done = am.filter(m => at.has(m.nr)).length;
  let html = `<h1>Zählerstände</h1>
    <div class="row"><label class="field"><span class="lab">Stichtag (gilt für alle Ablesungen dieses Rundgangs)</span><input type="date" id="st" value="${stichtag}"></label></div>
    <div class="prog"><b>${done} / ${am.length}</b><div class="bar"><i style="width:${am.length ? done / am.length * 100 : 0}%"></i></div><span class="unit" style="font-size:12px">abgelesen</span></div>`;
  const groups = [...new Set(am.map(m => m.ort ? `${m.art} · ${m.ort}` : m.art))];
  const gsort = g => ART_ORDER.indexOf(g.split(' · ')[0]);
  groups.sort((a, b) => gsort(a) - gsort(b));
  for (const g of groups) {
    html += `<div class="grp">${esc(g)}</div><div class="card">`;
    for (const m of am.filter(x => (x.ort ? `${x.art} · ${x.ort}` : x.art) === g)) {
      const r = at.get(m.nr);
      const s = seriesFor(m, rs).filter(p => p.date < stichtag);
      const last = s[s.length - 1];
      html += `<button class="it ${r ? (r.flag ? 'done warn' : 'done') : ''}" data-nr="${esc(m.nr)}">
        <div class="ic ${esc(m.art)}">${ICON[m.art] || '•'}</div>
        <div class="nm"><b>${esc(m.name || m.messstelle)}</b><span>${esc(m.nr)}${m.einheit ? ' · ' + esc(m.einheit) : ''}</span></div>
        <div class="val">${r ? `<b>${fmt(r.value)} ${esc(m.einheit)}</b>${r.flag ? '⚠ ' + esc(r.flag) : 'erfasst'}` : `<b>–</b>${last ? 'zuletzt ' + fmt(last.value) : ''}`}</div>
        <div class="chk"></div></button>`;
    }
    html += `</div>`;
  }
  if (done === am.length && am.length) html += `<div class="hint ok">Alle Zähler abgelesen. Weiter im Tab „Export“.</div>`;
  view.innerHTML = html;
  $('#st').onchange = async e => { stichtag = e.target.value || today(); await kvSet('stichtag', stichtag); vRundgang(); };
  view.querySelectorAll('.it').forEach(b => b.onclick = () => go('ablesen', { nr: b.dataset.nr }));
}

/* ---------- Ansicht: Ablesen ---------- */
async function vAblesen({ nr, id }) {
  const rs = await allReadings();
  let existing = id ? rs.find(r => r.id === id) : rs.find(r => r.nr === nr && r.date === stichtag);
  const m = meters.find(x => x.nr === (existing ? existing.nr : nr));
  if (!m) return go('rundgang');
  const date = existing ? existing.date : stichtag;
  let blob = existing && existing.photo ? await getPhoto(existing.id) : null;
  let blobUrl = blob ? URL.createObjectURL(blob) : null;
  const s = seriesFor(m, rs, existing && existing.id).filter(p => p.date < date);
  const last = s[s.length - 1];
  const view = $('#view');
  view.innerHTML = `<button class="back" id="bk">‹ Zurück</button>
    <h1>${esc(m.name || m.messstelle)}</h1><div class="sub">${esc(m.art)} · ${esc(m.nr)} · Messstelle ${esc(m.messstelle)}</div>
    <div class="photo" id="ph">${blobUrl ? `<img src="${blobUrl}" alt="Foto">` : '📷 Foto aufnehmen'}
      <span class="ph-b">${blobUrl ? 'Neu aufnehmen' : 'Kamera'}</span>
      <input type="file" accept="image/*" capture="environment" id="cam"></div>
    <div class="m"><label class="field"><span class="lab">Zählerstand</span>
      <div style="display:flex;align-items:baseline;gap:8px"><input class="big" id="val" inputmode="decimal" autocomplete="off" placeholder="${last ? fmt(last.value) : '0'}" value="${existing ? String(existing.value).replace('.', ',') : ''}"><span class="unit">${esc(m.einheit)}</span></div></label></div>
    <div class="row"><div class="field"><span class="lab">Stichtag</span><b>${deDate(date)}</b></div>
      <div class="field"><span class="lab">Vorablesung</span><b>${last ? fmt(last.value) + ' · ' + deDate(last.date).slice(0, 6) : '–'}</b></div></div>
    <div id="chk"></div>
    <div class="m"><label class="field"><span class="lab">Bemerkung (optional)</span><input id="note" value="${esc(existing ? existing.note : '')}" placeholder="z. B. Zählerwechsel, Schätzwert"></label></div>
    <div class="small" id="pn"></div>
    <button class="btn" id="save">Speichern &amp; nächster Zähler ›</button>
    ${existing ? '<button class="btn del" id="del">Ablesung löschen</button>' : ''}`;
  const pn = photoName(m, date, rs, existing && existing.id);
  $('#pn').innerHTML = `Foto wird gespeichert als<br><b>${esc(existing && existing.photo ? existing.photo : pn)}</b>`;
  const upd = () => {
    const v = parseNum($('#val').value);
    if (isNaN(v)) { $('#chk').innerHTML = ''; return null; }
    const c = check(m, v, date, rs, existing && existing.id);
    $('#chk').innerHTML = `<div class="hint ${c.cls}">${esc(c.text)}</div>`;
    return c;
  };
  $('#val').oninput = upd; upd();
  $('#bk').onclick = () => { if (blobUrl) URL.revokeObjectURL(blobUrl); go(tab); };
  const onCam = async e => {
    const f = e.target.files[0]; if (!f) return;
    $('#ph').firstChild.textContent = 'Foto wird verarbeitet …';
    blob = await shrink(f);
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    blobUrl = URL.createObjectURL(blob);
    $('#ph').innerHTML = `<img src="${blobUrl}" alt="Foto"><span class="ph-b">Neu aufnehmen</span><input type="file" accept="image/*" capture="environment" id="cam">`;
    $('#cam').onchange = onCam;
    if (!$('#val').value) $('#val').focus();
  };
  $('#cam').onchange = onCam;
  $('#save').onclick = async () => {
    const v = parseNum($('#val').value);
    if (isNaN(v)) { toast('Bitte einen Zählerstand eintragen.'); return; }
    if (!blob && !confirm('Ohne Foto speichern?')) return;
    const c = upd();
    const r = existing || { nr: m.nr, date, createdAt: new Date().toISOString() };
    r.value = v; r.note = $('#note').value.trim(); r.flag = c && c.flag || ''; r.exported = false;
    r.photo = blob ? (existing && existing.photo ? existing.photo : pn) : '';
    const newId = await putReading(r);
    r.id = r.id || newId;
    if (blob) await putPhoto(r.id, blob);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    toast(`${m.name || m.messstelle}: ${fmt(v)} ${m.einheit} gespeichert`);
    if (id) return go('verlauf');
    const rs2 = await allReadings();
    const doneSet = new Set(rs2.filter(x => x.date === stichtag).map(x => x.nr));
    const am = activeMeters();
    const idx = am.findIndex(x => x.nr === m.nr);
    const next = [...am.slice(idx + 1), ...am.slice(0, idx)].find(x => !doneSet.has(x.nr));
    next ? go('ablesen', { nr: next.nr }) : go('rundgang');
  };
  if (existing) $('#del').onclick = async () => {
    if (!confirm('Diese Ablesung wirklich löschen?')) return;
    await delReading(existing.id); await delPhoto(existing.id);
    toast('Ablesung gelöscht'); go(tab);
  };
}

/* ---------- Ansicht: Verlauf ---------- */
async function vVerlauf() {
  const rs = (await allReadings()).sort((a, b) => b.date.localeCompare(a.date) || a.nr.localeCompare(b.nr));
  const view = $('#view');
  if (!rs.length) { view.innerHTML = `<h1>Verlauf</h1><div class="empty">Noch keine Ablesungen in der App.</div>`; return; }
  let html = `<h1>Verlauf</h1><div class="sub">Antippen zum Bearbeiten</div>`;
  for (const d of [...new Set(rs.map(r => r.date))]) {
    const list = rs.filter(r => r.date === d);
    html += `<div class="grp">Stichtag ${deDate(d)} · ${list.length} Ablesungen</div><div class="card">`;
    for (const r of list) {
      const m = meters.find(x => x.nr === r.nr) || { name: r.nr, einheit: '', art: '' };
      html += `<button class="it" data-id="${r.id}"><img class="thumb" data-ph="${r.photo ? r.id : ''}" alt="">
        <div class="nm"><b>${esc(m.name || m.messstelle)}</b><span>${esc(r.nr)}${r.flag ? ' · ⚠ ' + esc(r.flag) : ''}</span></div>
        <div class="val"><b>${fmt(r.value)} ${esc(m.einheit)}</b>${r.exported ? 'exportiert' : 'neu'}</div></button>`;
    }
    html += `</div>`;
  }
  view.innerHTML = html;
  view.querySelectorAll('.it').forEach(b => b.onclick = () => go('ablesen', { id: Number(b.dataset.id) }));
  for (const im of view.querySelectorAll('img[data-ph]')) {
    if (!im.dataset.ph) { im.style.visibility = 'hidden'; continue; }
    const b = await getPhoto(Number(im.dataset.ph));
    if (b) im.src = URL.createObjectURL(b);
  }
}

/* ---------- Ansicht: Export ---------- */
function rowsFor(list, sep, decComma) {
  return list.map(r => [deDate(r.date), r.nr, decComma ? String(r.value).replace('.', ',') : String(r.value), r.photo || '', [r.note, r.flag && '⚠ ' + r.flag].filter(Boolean).join(' · ')]
    .map(x => sep === ';' && /[;"\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x).join(sep));
}
async function vExport() {
  const rs = await allReadings();
  const dates = [...new Set(rs.map(r => r.date))].sort().reverse();
  const view = $('#view');
  if (!dates.length) { view.innerHTML = `<h1>Export</h1><div class="empty">Noch keine Ablesungen zum Exportieren.</div>`; return; }
  let sel = dates.includes(stichtag) ? stichtag : dates[0];
  const render = () => {
    const list = rs.filter(r => r.date === sel).sort((a, b) => {
      const ma = meters.find(m => m.nr === a.nr), mb = meters.find(m => m.nr === b.nr);
      return ((ma && ma.order) ?? 999) - ((mb && mb.order) ?? 999);
    });
    const flags = list.filter(r => r.flag);
    const missing = activeMeters().filter(m => !list.some(r => r.nr === m.nr));
    const year = sel.slice(0, 4);
    view.innerHTML = `<h1>Export</h1>
      <div class="row"><label class="field"><span class="lab">Stichtag</span><select id="sel">${dates.map(d => `<option value="${d}" ${d === sel ? 'selected' : ''}>${deDate(d)}</option>`).join('')}</select></label></div>
      <div class="sum">
        <div><span>Ablesungen</span><b>${list.length}</b></div>
        <div><span>Fotos</span><b>${list.filter(r => r.photo).length}</b></div>
        <div><span>Noch nicht exportiert</span><b>${list.filter(r => !r.exported).length}</b></div>
        ${missing.length ? `<div><span>Nicht abgelesen</span><b style="color:var(--warn)">${missing.length}</b></div>` : ''}
        ${flags.length ? `<div><span>Auffälligkeiten</span><b style="color:var(--warn);text-align:right">${flags.map(r => esc((meters.find(m => m.nr === r.nr) || {}).name || r.nr) + ': ' + esc(r.flag)).join('<br>')}</b></div>` : ''}
      </div>
      <button class="btn" id="share">Ablesungen + Fotos sichern</button>
      <div class="small">Im Teilen-Menü „In Dateien sichern“ wählen → iCloud Drive › Private Dokumente › 002_… › 01_Burgkemnitzer Straße 6 › 06_Nebenkosten › ${year} › Zählerfotos. Die Datei <b>Ablesungen_${sel}.csv</b> kommt mit in den Ordner.</div>
      <button class="btn sec" id="copy">Für Excel kopieren</button>
      <div class="small">→ In der Objektmappe, Blatt „Ablesungen“, in Spalte A in die erste freie Zeile einfügen.</div>
      <pre>${esc(['Datum\tZählernummer\tStand\tFoto\tBemerkung', ...rowsFor(list, '\t', true)].join('\n'))}</pre>`;
    $('#sel').onchange = e => { sel = e.target.value; render(); };
    $('#copy').onclick = async () => {
      const txt = rowsFor(list, '\t', true).join('\n');
      try { await navigator.clipboard.writeText(txt); toast('Kopiert – jetzt in Excel einfügen'); }
      catch { prompt('Text kopieren:', txt); }
    };
    $('#share').onclick = async () => {
      const csv = '﻿' + ['Datum;Zählernummer;Stand;Foto;Bemerkung', ...rowsFor(list, ';', true)].join('\r\n');
      const files = [new File([csv], `Ablesungen_${sel}.csv`, { type: 'text/csv' })];
      for (const r of list) if (r.photo) { const b = await getPhoto(r.id); if (b) files.push(new File([b], r.photo, { type: 'image/jpeg' })); }
      try {
        if (navigator.canShare && navigator.canShare({ files })) {
          await navigator.share({ files, title: `Zählerstände ${deDate(sel)}` });
        } else {
          for (const f of files) { const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; a.click(); await new Promise(r => setTimeout(r, 300)); }
        }
        for (const r of list) { r.exported = true; await putReading(r); }
        toast('Exportiert ✓'); vExport();
      } catch (e) { if (e.name !== 'AbortError') toast('Teilen fehlgeschlagen: ' + e.message); }
    };
  };
  render();
}

/* ---------- Ansicht: Zähler ---------- */
async function vZaehler() {
  const view = $('#view');
  const ms = [...meters].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  let html = `<h1>Zähler</h1><div class="sub">${meters.length} Zähler · Reihenfolge = Reihenfolge im Rundgang</div>
    <button class="btn" id="imp">Zählerliste importieren</button>
    <input type="file" id="impf" accept=".json,application/json" class="hidden">
    <div class="small">Datei „Zählerliste BuKe 6.json“ aus 06_Nebenkosten wählen. Vorhandene Ablesungen bleiben erhalten. Eine Datensicherung (siehe unten) lässt sich hier ebenfalls wieder einlesen.</div>`;
  if (ms.length) {
    html += `<div class="grp">Zählerliste</div><div class="card">`;
    ms.forEach((m, i) => {
      html += `<div class="it" style="${m.aktiv === false ? 'opacity:.45' : ''}"><div class="ic ${esc(m.art)}">${ICON[m.art] || '•'}</div>
        <div class="nm"><b>${esc(m.name || m.messstelle)}</b><span>${esc(m.nr)} · ${esc(m.messstelle)}${m.aktiv === false ? ' · ausgebaut' : ''}</span></div>
        <div class="mini"><button data-up="${i}">↑</button><button data-dn="${i}">↓</button><button data-ed="${esc(m.nr)}">✎</button></div></div>`;
    });
    html += `</div>`;
  }
  html += `<button class="btn sec" id="add">Zähler hinzufügen (Zählerwechsel)</button>
    <button class="btn sec" id="bak">Datensicherung exportieren</button>
    <div class="small">Sichert Zählerliste und alle Ablesungen (ohne Fotos) als JSON-Datei. Fotos sichert der normale Export.</div>
    <div class="small">Speicher: <span id="pers">…</span><br>App-Version ${APP_VERSION}</div>`;
  view.innerHTML = html;
  $('#imp').onclick = () => $('#impf').click();
  $('#impf').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { await importJson(JSON.parse(await f.text())); } catch (err) { toast('Import fehlgeschlagen: ' + err.message, 4000); }
  };
  view.querySelectorAll('[data-up],[data-dn]').forEach(b => b.onclick = async () => {
    const i = Number(b.dataset.up ?? b.dataset.dn), j = b.dataset.up !== undefined ? i - 1 : i + 1;
    if (j < 0 || j >= ms.length) return;
    [ms[i], ms[j]] = [ms[j], ms[i]]; ms.forEach((m, k) => m.order = k);
    await saveMeters(); vZaehler();
  });
  view.querySelectorAll('[data-ed]').forEach(b => b.onclick = () => go('zaehlerEdit', b.dataset.ed));
  $('#add').onclick = () => go('zaehlerEdit', null);
  $('#bak').onclick = async () => {
    const data = { typ: 'datensicherung', app: APP_VERSION, erstellt: new Date().toISOString(), zaehler: meters, ablesungen: (await allReadings()).map(r => ({ ...r })) };
    const f = new File([JSON.stringify(data, null, 1)], `Zähler-App Datensicherung_${today()}.json`, { type: 'application/json' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [f] })) await navigator.share({ files: [f] });
      else { const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; a.click(); }
    } catch (e) { if (e.name !== 'AbortError') toast(e.message); }
  };
  if (navigator.storage && navigator.storage.persisted) navigator.storage.persisted().then(p => { $('#pers').textContent = p ? 'dauerhaft (wird nicht automatisch geleert)' : 'normal – nach jedem Rundgang exportieren'; });
  else $('#pers').textContent = 'unbekannt';
}
async function importJson(d) {
  const list = d.zaehler || d.meters;
  if (!Array.isArray(list)) throw new Error('keine Zählerliste in der Datei');
  const old = new Map(meters.map(m => [m.nr, m]));
  meters = list.map((z, i) => ({
    nr: String(z.nr), messstelle: z.messstelle || '', name: z.name || z.bezeichnung || '', art: z.art || '', einheit: z.einheit || '',
    ort: z.ort || '', order: z.order ?? i, aktiv: z.aktiv !== false, historie: z.historie || (old.get(String(z.nr)) || {}).historie || []
  }));
  for (const m of old.values()) if (!meters.some(x => x.nr === m.nr)) meters.push({ ...m, aktiv: false, order: 900 + meters.length });
  await saveMeters();
  let n = 0;
  if (Array.isArray(d.ablesungen)) {
    const have = new Set((await allReadings()).map(r => r.nr + '|' + r.date));
    for (const r of d.ablesungen) {
      if (have.has(r.nr + '|' + r.date)) continue;
      const { id, ...rest } = r; await putReading(rest); n++;
    }
  }
  toast(`${meters.length} Zähler importiert${n ? `, ${n} Ablesungen` : ''}`);
  vZaehler();
}
async function vZaehlerEdit(nr) {
  const m = nr ? meters.find(x => x.nr === nr) : null;
  const arts = ART_ORDER.map(a => `<option ${m && m.art === a ? 'selected' : ''}>${a}</option>`).join('');
  const msList = [...new Set(meters.map(x => x.messstelle).filter(Boolean))];
  $('#view').innerHTML = `<button class="back" id="bk">‹ Zurück</button>
    <h1>${m ? 'Zähler bearbeiten' : 'Neuer Zähler'}</h1>
    ${m ? '' : '<div class="small">Bei Zählerwechsel: neuen Zähler mit derselben Messstelle anlegen, den alten danach als „ausgebaut“ markieren. Den Endstand des alten Zählers vorher noch ablesen. In der Objektmappe (Blatt Zähler) genauso nachtragen.</div>'}
    <div class="m"><label class="field"><span class="lab">Zählernummer</span><input id="f-nr" value="${esc(m ? m.nr : '')}" ${m ? 'readonly' : ''}></label></div>
    <div class="m"><label class="field"><span class="lab">Messstelle</span><input id="f-ms" list="msl" value="${esc(m ? m.messstelle : '')}"><datalist id="msl">${msList.map(x => `<option value="${esc(x)}">`).join('')}</datalist></label></div>
    <div class="m"><label class="field"><span class="lab">Bezeichnung</span><input id="f-name" value="${esc(m ? m.name : '')}"></label></div>
    <div class="row"><label class="field"><span class="lab">Art</span><select id="f-art">${arts}</select></label>
      <label class="field"><span class="lab">Einheit</span><input id="f-eh" value="${esc(m ? m.einheit : '')}" placeholder="m³, kWh, MWh, L"></label></div>
    <div class="m"><label class="field"><span class="lab">Ort (Gruppe im Rundgang, optional)</span><input id="f-ort" value="${esc(m ? m.ort : '')}" placeholder="z. B. Keller, Heizungsraum"></label></div>
    ${m ? '' : `<div class="row"><label class="field"><span class="lab">Einbaudatum</span><input type="date" id="f-ed" value="${today()}"></label>
      <label class="field"><span class="lab">Startstand</span><input id="f-ss" inputmode="decimal" placeholder="0"></label></div>`}
    ${m ? `<div class="m"><label class="field" style="display:flex;justify-content:space-between;align-items:center"><span>Ausgebaut (nicht mehr im Rundgang)</span><input type="checkbox" id="f-aus" style="width:auto" ${m.aktiv === false ? 'checked' : ''}></label></div>` : ''}
    <button class="btn" id="sv">Speichern</button>`;
  $('#bk').onclick = () => go('zaehler');
  $('#sv').onclick = async () => {
    const z = m || { nr: $('#f-nr').value.trim(), historie: [], order: meters.length };
    if (!z.nr) return toast('Zählernummer fehlt');
    if (!m && meters.some(x => x.nr === z.nr)) return toast('Zählernummer gibt es schon');
    z.messstelle = $('#f-ms').value.trim(); z.name = $('#f-name').value.trim(); z.art = $('#f-art').value;
    z.einheit = $('#f-eh').value.trim(); z.ort = $('#f-ort').value.trim();
    if (m) z.aktiv = !$('#f-aus').checked;
    else {
      z.aktiv = true;
      const ss = parseNum($('#f-ss').value);
      if (!isNaN(ss)) z.historie = [[$('#f-ed').value || today(), ss]];
      const pred = meters.filter(x => x.messstelle === z.messstelle && x.aktiv !== false);
      if (pred.length) z.order = pred[0].order + 0.5;
      meters.push(z);
    }
    activeMeters(); [...meters].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).forEach((x, k) => x.order = k);
    await saveMeters(); toast('Gespeichert'); go('zaehler');
  };
}

/* ---------- Service Worker + Update-Banner ---------- */
function setupSW() {
  if (!('serviceWorker' in navigator)) return;
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (refreshing) return; refreshing = true; location.reload(); });
  navigator.serviceWorker.register('sw.js').then(reg => {
    const show = w => { $('#update').classList.remove('hidden'); $('#btn-update').onclick = () => w.postMessage('SKIP_WAITING'); };
    if (reg.waiting && navigator.serviceWorker.controller) show(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w && w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) show(w); });
    });
    reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => {});
}

(async () => { await loadState(); setupSW(); go('rundgang'); })();
