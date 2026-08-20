/**
 * Amazon Prime Video — Subtitle Security Audit Script (v4)
 * ==========================================================
 * Fetches and downloads the RAW subtitle file exactly as Amazon serves it,
 * pretty-printed so it is human-readable in any text editor or browser.
 *
 * Usage: Paste into DevTools Console on an Amazon Prime Video episode page.
 *        Script auto-runs on paste. Also exposed as subtitleAudit.run()
 *
 * Downloads TWO files:
 *   1. subtitles_<lang>_<show>_<date>.ttml  — raw XML (pretty-printed, original data)
 *   2. subtitles_<lang>_<show>_<date>.txt   — clean human-readable text with timestamps
 */
(function () {
  'use strict';

  const TTML_NS = 'http://www.w3.org/ns/ttml';

  // ─── Pretty-print XML string ───────────────────────────────────────────────
  function prettyXML(xmlString) {
    // Use browser's built-in XML serializer on a parsed doc for clean output
    try {
      const doc = new DOMParser().parseFromString(xmlString, 'application/xml');
      const err = doc.querySelector('parsererror');
      if (err) return xmlString; // return as-is if unparseable
      return new XMLSerializer().serializeToString(doc)
        .replace(/></g, '>\n<')         // newline between tags
        .replace(/(<[^/][^>]*[^/]>)\n</g, '$1\n  <') // basic indent children
        .replace(/\n\s*\n/g, '\n');     // collapse blank lines
    } catch (e) {
      return xmlString;
    }
  }

  // ─── Time formatting ───────────────────────────────────────────────────────
  function pad(n, len) { return String(Math.floor(n)).padStart(len || 2, '0'); }

  function toReadableTime(s) {
    return pad(Math.floor(s / 3600)) + ':' +
           pad(Math.floor((s % 3600) / 60)) + ':' +
           pad(Math.floor(s % 60)) + '.' +
           pad(Math.round((s % 1) * 1000), 3);
  }

  function parseTTMLTime(t, tickRate) {
    tickRate = tickRate || 10000000;
    if (!t) return 0;
    var m;
    m = t.match(/^(\d+)t$/); if (m) return +m[1] / tickRate;
    m = t.match(/^(\d+):(\d+):(\d+)[.,](\d+)$/);
    if (m) return +m[1]*3600 + +m[2]*60 + +m[3] + +m[4]/Math.pow(10,m[4].length);
    m = t.match(/^(\d+):(\d+):(\d+):(\d+)$/);
    if (m) return +m[1]*3600 + +m[2]*60 + +m[3] + +m[4]/24;
    m = t.match(/^(\d+):(\d+):(\d+)$/);
    if (m) return +m[1]*3600 + +m[2]*60 + +m[3];
    return parseFloat(t) || 0;
  }

  // ─── URL Discovery ─────────────────────────────────────────────────────────
  function findTTML2Urls() {
    return performance.getEntriesByType('resource')
      .filter(e =>
        e.name.includes('.ttml2') || e.name.includes('.ttml') ||
        e.name.includes('cf-timedtext') || e.name.includes('timedtext') ||
        e.name.includes('subtitle')
      )
      .map(e => e.name);
  }

  function findMPDUrl() {
    const e = performance.getEntriesByType('resource').filter(e => e.name.includes('.mpd'));
    return e.length ? e[0].name : null;
  }

  // ─── MPD parsing ──────────────────────────────────────────────────────────
  async function fetchAndParseMPD(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('MPD fetch failed: ' + r.status);
    return new DOMParser().parseFromString(await r.text(), 'application/xml');
  }

  function extractSubtitleTracksFromMPD(mpdDoc, base) {
    const tracks = [];
    for (const as of mpdDoc.querySelectorAll('AdaptationSet')) {
      const ct    = as.getAttribute('contentType');
      const mime  = as.getAttribute('mimeType') || '';
      const codec = as.getAttribute('codecs') || '';
      const lang  = as.getAttribute('lang') || 'unknown';
      const label = as.getAttribute('label') || lang;
      if (!(ct === 'text' || mime.includes('ttml') || (mime.includes('mp4') && codec === 'stpp'))) continue;
      let url = null;
      const rep = as.querySelector('Representation');
      if (rep) { const bu = rep.querySelector('BaseURL'); if (bu) { url = bu.textContent.trim(); if (!url.startsWith('http')) url = new URL(url, base).href; } }
      if (!url) { const asb = as.querySelector(':scope > BaseURL'); if (asb) { url = asb.textContent.trim(); if (!url.startsWith('http')) url = new URL(url, base).href; } }
      tracks.push({ lang, label, url, codec, mime });
    }
    return tracks;
  }

  // ─── Extract MP4/stpp payloads ────────────────────────────────────────────
  function extractMdatPayloads(buf) {
    const view = new DataView(buf), payloads = [];
    const CONTAINERS = new Set(['moov','trak','mdia','minf','stbl','moof','traf']);
    let off = 0;
    while (off < buf.byteLength - 8) {
      let size = view.getUint32(off);
      const type = String.fromCharCode(view.getUint8(off+4),view.getUint8(off+5),view.getUint8(off+6),view.getUint8(off+7));
      if (size === 0) break;
      if (size === 1 && off+16 <= buf.byteLength) size = view.getUint32(off+8)*0x100000000 + view.getUint32(off+12);
      if (type === 'mdat') payloads.push(buf.slice(off+8, off+size));
      if (CONTAINERS.has(type)) payloads.push(...extractMdatPayloads(buf.slice(off+8, off+size)));
      off += size;
    }
    return payloads;
  }

  // ─── CORE: fetch raw bytes + raw text from a subtitle URL ─────────────────
  async function fetchRaw(url) {
    console.log('[Audit] Fetching: ...' + url.slice(-80));
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('Fetch failed: ' + resp.status + ' ' + resp.statusText);

    const ct = resp.headers.get('content-type') || '';
    const isXML = ct.includes('xml') || ct.includes('ttml') ||
                  url.endsWith('.ttml2') || url.endsWith('.ttml') || url.endsWith('.dfxp');

    if (isXML) {
      const raw = await resp.text();
      return { rawXML: raw, buffer: null };
    }

    // Binary (MP4 container or unknown) — peek first bytes
    const buffer = await resp.arrayBuffer();
    const peek = new TextDecoder().decode(new Uint8Array(buffer.slice(0, 30)));

    if (peek.includes('<?xml') || peek.includes('<tt')) {
      const raw = new TextDecoder().decode(buffer);
      return { rawXML: raw, buffer: null };
    }

    // Extract TTML fragments from MP4 mdat boxes and concatenate
    const payloads = extractMdatPayloads(buffer);
    const xmlParts = [];
    for (const p of payloads) {
      const text = new TextDecoder().decode(p);
      if (text.includes('<') && (text.includes('tt') || text.includes('<p'))) {
        xmlParts.push(text);
      }
    }
    // Wrap fragments in a root tt element so it's valid XML
    const combined = xmlParts.length === 1
      ? xmlParts[0]
      : `<?xml version="1.0" encoding="UTF-8"?>\n<tt xmlns="http://www.w3.org/ns/ttml">\n<body><div>\n` +
        xmlParts.join('\n') +
        `\n</div></body></tt>`;

    return { rawXML: combined, buffer };
  }

  // ─── Parse TTML raw XML → human-readable timestamped lines ───────────────
  function ttmlToReadableTxt(xmlString, showName) {
    const doc = new DOMParser().parseFromString(xmlString, 'application/xml');
    const tt = doc.querySelector('tt') || doc.documentElement;
    let tickRate = 10000000;
    if (tt) {
      const tr = tt.getAttribute('ttp:tickRate') ||
                 tt.getAttributeNS('http://www.w3.org/ns/ttml#parameter', 'tickRate');
      if (tr) tickRate = parseInt(tr);
    }

    let paragraphs = doc.getElementsByTagNameNS(TTML_NS, 'p');
    if (!paragraphs.length) paragraphs = doc.querySelectorAll('p');

    const cues = [];
    for (const p of paragraphs) {
      const begin = p.getAttribute('begin');
      const end   = p.getAttribute('end');
      let text = '';
      function ex(node) {
        for (const c of node.childNodes) {
          if (c.nodeType === Node.TEXT_NODE) text += c.textContent;
          else if (c.localName === 'br') text += '\n';
          else if (c.nodeType === Node.ELEMENT_NODE) ex(c);
        }
      }
      ex(p);
      text = text.trim().replace(/[ \t]{2,}/g, ' ');
      if (text && begin) {
        cues.push({
          b: parseTTMLTime(begin, tickRate),
          e: parseTTMLTime(end, tickRate),
          t: text
        });
      }
    }

    // Sort and deduplicate
    cues.sort((a, b) => a.b - b.b);
    const deduped = [];
    for (const c of cues) {
      const last = deduped[deduped.length - 1];
      if (last && last.t === c.t && Math.abs(last.b - c.b) < 0.15) continue;
      deduped.push(c);
    }

    // Build readable text output
    const sep = '='.repeat(60);
    const header = [
      sep,
      'AMAZON PRIME VIDEO — SUBTITLE EXTRACTION',
      'Show    : ' + (showName || document.title || 'Unknown'),
      'Date    : ' + new Date().toISOString(),
      'Cues    : ' + deduped.length,
      sep,
      ''
    ].join('\n');

    const body = deduped.map(c =>
      '[' + toReadableTime(c.b) + ' --> ' + toReadableTime(c.e) + ']\n' + c.t
    ).join('\n\n');

    return { text: header + body, cues: deduped };
  }

  // ─── Trigger download ─────────────────────────────────────────────────────
  function download(content, filename) {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    console.log('[Audit] ✅ Downloaded: ' + filename);
  }

  // ─── Show/episode slug from page title ────────────────────────────────────
  function getSlug() {
    return (document.title || '')
      .replace(/Amazon Prime Video/i, '')
      .replace(/[^a-zA-Z0-9 ]/g, '')
      .trim().split(/\s+/).slice(0, 4).join('_').toLowerCase() || 'episode';
  }

  // ─── Print summary to console ─────────────────────────────────────────────
  function printSummary(cues, files, method) {
    console.log('='.repeat(60));
    console.log('[Audit] ✅ EXTRACTION COMPLETE');
    console.log('  Method  : ' + method);
    console.log('  Cues    : ' + cues.length);
    if (cues.length) {
      console.log('  Start   : ' + toReadableTime(cues[0].b) + ' — "' + cues[0].t.slice(0,50) + '"');
      console.log('  End     : ' + toReadableTime(cues[cues.length-1].e) + ' — "' + cues[cues.length-1].t.slice(0,50) + '"');
    }
    files.forEach(f => console.log('  File    : ' + f));
    console.log('='.repeat(60));
  }

  // ─── Core: fetch URL, download raw + readable ─────────────────────────────
  async function processUrl(url, lang, method) {
    const slug = getSlug();
    const date = new Date().toISOString().slice(0, 10);
    const base = 'subtitles_' + (lang || 'en') + '_' + slug + '_' + date;

    const { rawXML } = await fetchRaw(url);
    if (!rawXML || !rawXML.trim()) {
      console.error('[Audit] ❌ No XML content retrieved.');
      return;
    }

    // File 1: pretty-printed raw TTML (the actual file Amazon serves)
    const prettyRaw = prettyXML(rawXML);
    const rawFile   = base + '.ttml';
    download(prettyRaw, rawFile);

    // File 2: human-readable plain text with timestamps
    const showName = document.title.replace(/Amazon Prime Video/i,'').trim();
    const { text, cues } = ttmlToReadableTxt(rawXML, showName);
    const txtFile = base + '.txt';
    download(text, txtFile);

    printSummary(cues, [rawFile, txtFile], method);
    return { cues, rawXML: prettyRaw, text };
  }

  // ─── Main auto-detect entry ───────────────────────────────────────────────
  async function run(langFilter) {
    console.log('='.repeat(60));
    console.log('[Audit] Amazon Prime Video — Subtitle Audit v4');
    console.log('[Audit] Lang filter: ' + (langFilter || 'auto (English preferred)'));
    console.log('='.repeat(60));

    // === Approach 1: Direct TTML URLs in resource timing ===
    const ttmlUrls = findTTML2Urls();
    if (ttmlUrls.length > 0) {
      console.log('[Audit] ✅ Found ' + ttmlUrls.length + ' TTML URL(s):');
      ttmlUrls.forEach((u, i) => console.log('  [' + i + '] ' + u.slice(-80)));

      let target = ttmlUrls[0];
      if (langFilter && ttmlUrls.length > 1) {
        const m = ttmlUrls.find(u => u.toLowerCase().includes(langFilter.toLowerCase()));
        if (m) target = m;
      }

      try {
        return await processUrl(target, langFilter || 'en', 'TTML2 direct URL');
      } catch (e) {
        console.warn('[Audit] ⚠ TTML fetch failed: ' + e.message);
      }
    }

    // === Approach 2: MPD manifest ===
    console.log('[Audit] Trying MPD manifest...');
    const mpdUrl = findMPDUrl();
    if (mpdUrl) {
      console.log('[Audit] ✅ Found MPD.');
      const base   = mpdUrl.substring(0, mpdUrl.lastIndexOf('/') + 1);
      const mpdDoc = await fetchAndParseMPD(mpdUrl);
      const tracks = extractSubtitleTracksFromMPD(mpdDoc, base);

      if (tracks.length > 0) {
        console.log('[Audit] ✅ Found ' + tracks.length + ' subtitle track(s):');
        tracks.forEach((t, i) => console.log('  [' + i + '] ' + t.lang + ' — ' + t.label + ' (' + (t.codec || t.mime) + ')'));

        let sel = langFilter ? tracks.find(t => t.lang.toLowerCase().startsWith(langFilter.toLowerCase())) : null;
        if (!sel) sel = tracks.find(t => t.lang.startsWith('en')) || tracks[0];

        if (sel && sel.url) {
          console.log('[Audit] Selected: ' + sel.lang + ' — ' + sel.label);
          return await processUrl(sel.url, sel.lang, 'MPD manifest');
        } else {
          console.warn('[Audit] ⚠ Tracks found but no direct URL. Use subtitleAudit.listTracks()');
        }
      }
    }

    // === Fallback ===
    console.error('[Audit] ❌ Could not auto-discover subtitle URLs.');
    console.log('[Audit] Manual steps:');
    console.log('  1. Open Network tab → filter "ttml" or "timedtext"');
    console.log('  2. Copy the .ttml2 URL');
    console.log('  3. Run: subtitleAudit.fetchUrl("paste-url-here")');
  }

  // ─── Manual: fetch a specific URL ─────────────────────────────────────────
  async function fetchUrl(url, lang) {
    console.log('[Audit] Fetching manual URL...');
    return await processUrl(url, lang || 'manual', 'manual URL');
  }

  // ─── List available tracks ────────────────────────────────────────────────
  async function listTracks() {
    const urls = findTTML2Urls();
    console.log('Direct TTML URLs (' + urls.length + '):');
    urls.forEach((u, i) => console.log('  [' + i + '] ' + u));

    const mpdUrl = findMPDUrl();
    if (mpdUrl) {
      const base   = mpdUrl.substring(0, mpdUrl.lastIndexOf('/') + 1);
      const tracks = extractSubtitleTracksFromMPD(await fetchAndParseMPD(mpdUrl), base);
      console.log('MPD tracks (' + tracks.length + '):');
      tracks.forEach((t, i) => console.log('  [' + i + '] ' + t.lang + ' — ' + t.label + ' → ' + (t.url || 'NO URL')));
      return tracks;
    }
  }

  // ─── Expose API ───────────────────────────────────────────────────────────
  window.subtitleAudit = {
    run,
    fetchUrl,
    listTracks,
    findTTML2: findTTML2Urls,
    findMPD:   findMPDUrl,
    help: () => console.log(`
╔══════════════════════════════════════════════════════════╗
║  Amazon Subtitle Audit v4 — Help                         ║
╠══════════════════════════════════════════════════════════╣
║                                                          ║
║  subtitleAudit.run()          Auto-detect, download 2    ║
║                               files: raw .ttml + .txt    ║
║  subtitleAudit.run('es')      Spanish subtitles          ║
║  subtitleAudit.fetchUrl(url)  Fetch a specific URL       ║
║  subtitleAudit.listTracks()   List all found tracks      ║
║  subtitleAudit.findTTML2()    Show TTML URLs in timing   ║
║  subtitleAudit.findMPD()      Show MPD URL               ║
║                                                          ║
║  Downloads:                                              ║
║   • .ttml  — raw XML exactly as Amazon serves it         ║
║   • .txt   — readable text with timestamps               ║
╚══════════════════════════════════════════════════════════╝
    `)
  };

  console.log('[Audit] ✅ Subtitle Audit v4 loaded.');
  console.log('[Audit] Auto-running... (or call subtitleAudit.run() manually)');

  // Auto-run on paste
  run();

})();
