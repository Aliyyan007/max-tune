// End-to-end test: exercises every platform exactly like the browser client does.
// Usage: node test-e2e.mjs
const BASE = 'http://localhost:3000';
const SOURCES = ['qobuz', 'deezer', 'tidal', 'spotify', 'apple', 'amazon'];
let pass = 0, fail = 0, skip = 0;
const results = [];

const ok = (name, cond, extra = '') => {
    if (cond) { pass++; results.push(`  PASS  ${name} ${extra}`); }
    else { fail++; results.push(`  FAIL  ${name} ${extra}`); }
};
const info = (msg) => results.push(`  INFO  ${msg}`);

async function api(path, headers = {}) {
    const r = await fetch(`${BASE}${path}`, { headers });
    let body = null;
    try { body = await r.json(); } catch { body = await r.text().catch(() => null); }
    return { status: r.status, body, headers: r.headers };
}

// ---------- shape validation (mirrors what the UI reads) ----------
function checkTrack(t, source) {
    const problems = [];
    if (t.id === undefined || t.id === null || t.id === '') problems.push('id');
    if (typeof t.title !== 'string' || !t.title) problems.push('title');
    if (!t.album) problems.push('album (missing -> not rendered as track!)');
    else {
        if (typeof t.album.title !== 'string') problems.push('album.title');
        if (!t.album.artist || typeof t.album.artist.name !== 'string') problems.push('album.artist.name (autocomplete needs it)');
        if (!t.album.image || typeof t.album.image.small !== 'string') problems.push('album.image.small');
        if (t.album.image.small && !t.album.image.small.startsWith('/api/image-proxy') && !t.album.image.small.startsWith('http')) problems.push('album.image.small (bad url)');
        if (!t.album.genre) problems.push('album.genre');
        if (!t.album.label) problems.push('album.label');
    }
    if (typeof t.performer?.name !== 'string' || !t.performer.name) problems.push('performer.name');
    if (typeof t.duration !== 'number') problems.push('duration');
    if (typeof t.track_number !== 'number') problems.push('track_number');
    if (typeof t.parental_warning !== 'boolean') problems.push('parental_warning');
    if (typeof t.streamable !== 'boolean') problems.push('streamable');
    if (t.source !== source && !(source === 'qobuz' && t.source === undefined)) problems.push(`source stamp (${t.source} != ${source})`);
    return problems;
}
function checkAlbum(a, source) {
    const problems = [];
    if (a.id === undefined || a.id === '') problems.push('id');
    if (typeof a.title !== 'string' || !a.title) problems.push('title');
    if (!a.artist || typeof a.artist.name !== 'string') problems.push('artist.name');
    if (!a.image || typeof a.image.small !== 'string') problems.push('image.small');
    if (typeof a.tracks_count !== 'number') problems.push('tracks_count');
    if (!a.genre) problems.push('genre');
    if (!a.label) problems.push('label');
    if (typeof a.released_at !== 'number') problems.push('released_at');
    if (a.source !== source && !(source === 'qobuz' && a.source === undefined)) problems.push('source stamp');
    return problems;
}
function checkArtist(a, source) {
    const problems = [];
    if (a.id === undefined || a.id === '') problems.push('id');
    if (typeof a.name !== 'string' || !a.name) problems.push('name');
    if (!('albums_count' in a)) problems.push('albums_count (getType needs it)');
    if (a.source !== source && !(source === 'qobuz' && a.source === undefined)) problems.push('source stamp');
    return problems;
}

// ---------- 1. search + shape contract on every platform ----------
const searchData = {};
for (const src of SOURCES) {
    const r = await api(`/api/get-music?q=${encodeURIComponent('daft punk')}&offset=0&source=${src}`);
    const d = r.body?.data;
    if (!d) { fail++; results.push(`  FAIL  [${src}] search -> ${r.status} ${r.body?.error ?? JSON.stringify(r.body).slice(0, 120)}`); searchData[src] = null; continue; }
    searchData[src] = d;
    for (const key of ['tracks', 'albums', 'artists']) {
        const s = d[key];
        if (!s || !Array.isArray(s.items)) { ok(`[${src}] search.${key} exists`, false); continue; }
        const checker = key === 'tracks' ? checkTrack : key === 'albums' ? checkAlbum : checkArtist;
        let bad = 0;
        s.items.slice(0, 10).forEach((item) => { const p = checker(item, src); if (p.length) { bad++; if (bad === 1) info(`[${src}] ${key} item problems: ${p.join(', ')}`); } });
        ok(`[${src}] ${key}: ${s.items.length} items, total=${s.total}`, bad === 0);
    }
}

// ---------- 2. pagination ----------
for (const src of ['deezer', 'tidal']) {
    const r = await api(`/api/get-music?q=${encodeURIComponent('daft punk')}&offset=10&source=${src}`);
    ok(`[${src}] pagination page2`, r.body?.data?.tracks?.items?.length > 0);
}

// ---------- 3. album info (full tracklist) ----------
const albumIds = {
    qobuz: searchData.qobuz?.albums?.items?.[0]?.id,
    deezer: searchData.deezer?.albums?.items?.[0]?.id,
    tidal: searchData.tidal?.albums?.items?.[0]?.id,
    apple: searchData.apple?.albums?.items?.[0]?.id,
    spotify: searchData.spotify?.albums?.items?.[0]?.id
};
const fetchedAlbums = {};
for (const [src, id] of Object.entries(albumIds)) {
    if (!id) { skip++; results.push(`  SKIP  [${src}] album info (no album id)`); continue; }
    const r = await api(`/api/get-album?album_id=${encodeURIComponent(id)}&source=${src}`);
    const alb = r.body?.data;
    if (!alb) { ok(`[${src}] album info`, false, r.body?.error ?? ''); fetchedAlbums[src] = null; continue; }
    const items = alb.tracks?.items ?? [];
    // client grafts album onto tracks for qobuz; normalized sources ship it server-side
    const allHaveAlbum = items.every((t) => t.album && t.album.id) || src === 'qobuz';
    const tracksOk = items.slice(0, 5).every((t) => checkTrack(t, src).length === 0 || src === 'qobuz');
    ok(`[${src}] album '${alb.title}' x${items.length} tracks`, items.length > 0 && allHaveAlbum && tracksOk, allHaveAlbum ? '' : '(track.album missing!)');
    fetchedAlbums[src] = alb;
}

// ---------- 4. artist info ----------
for (const src of ['qobuz', 'deezer', 'tidal', 'apple', 'spotify']) {
    const aid = searchData[src]?.artists?.items?.[0]?.id;
    if (!aid) { skip++; results.push(`  SKIP  [${src}] artist info`); continue; }
    const r = await api(`/api/get-artist?artist_id=${encodeURIComponent(aid)}&source=${src}`);
    const a = r.body?.data?.artist;
    ok(`[${src}] artist '${a?.name?.display ?? a?.name ?? '?'}'`, !!a && !!a.releases, a ? `releases.album.items=${a.releases?.album?.items?.length ?? 0}` : r.body?.error ?? '');
}

// ---------- 5. download resolution ----------
const dlTargets = {};
for (const src of SOURCES) {
    const t = searchData[src]?.tracks?.items?.[0];
    if (t) dlTargets[src] = { id: String(t.id), title: t.title, artist: t.performer.name, dur: t.duration, isrc: t.isrc };
}
for (const [src, t] of Object.entries(dlTargets)) {
    const r = await api(`/api/download-music?track_id=${encodeURIComponent(t.id)}&quality=5&source=${src}&title=${encodeURIComponent(t.title)}&artist=${encodeURIComponent(t.artist)}&dur=${t.dur}`);
    const url = r.body?.data?.url;
    if (!url) { ok(`[${src}] resolve`, false, r.body?.error ?? 'no url'); continue; }
    ok(`[${src}] resolve -> ${url.slice(0, 90)}`, true);
    dlTargets[src].url = url;
}

// ---------- 6. actual stream fetch (HEAD + first bytes) ----------
// youtube-family (apple/amazon) and qobuz (direct CDN url)
for (const src of ['qobuz', 'apple', 'amazon']) {
    const t = dlTargets[src];
    if (!t?.url) { skip++; results.push(`  SKIP  [${src}] stream fetch`); continue; }
    try {
        const full = t.url.startsWith('/') ? `${BASE}${t.url}` : t.url;
        const head = await fetch(full, { method: 'HEAD' });
        const fmt = head.headers.get('x-audio-format') ?? '';
        const len = parseInt(head.headers.get('content-length') ?? '0');
        // fetch first 1MB of actual bytes to prove it's real audio
        const get = await fetch(full, { headers: { Range: 'bytes=0-2000000' } });
        const buf = Buffer.from(await get.arrayBuffer());
        const magic = buf.subarray(4, 12).toString('latin1');
        const isAudio = magic.includes('ftyp') || magic.includes('OggS') || buf.subarray(0, 4).toString('latin1') === 'fLaC' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) || magic.includes('RIFF');
        ok(`[${src}] stream bytes (fmt=${fmt} len=${len} first=${magic.slice(0, 11).replace(/[^\x20-\x7E]/g, '.')})`, buf.length > 10000 && isAudio);
    } catch (e) {
        ok(`[${src}] stream fetch`, false, String(e).slice(0, 100));
    }
}

// deezer/tidal streams - test error path without tokens
for (const src of ['deezer', 'tidal']) {
    const t = dlTargets[src];
    if (!t?.url) continue;
    const r = await api(t.url.replace(`${BASE}`, ''));
    const hasCreds = r.status === 200;
    info(`[${src}] stream-audio: ${hasCreds ? 'RESOLVED' : `error path -> ${r.body?.error ?? r.status}`}`);
    if (!hasCreds) { skip++; }
    else { pass++; }
}

// ---------- 7. image proxy ----------
{
    const imgUrl = searchData.deezer?.albums?.items?.[0]?.image?.small;
    if (imgUrl) {
        const r = await fetch(`${BASE}${imgUrl}`);
        const buf = Buffer.from(await r.arrayBuffer());
        const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
        const isPng = buf[0] === 0x89 && buf[1] === 0x50;
        ok(`image-proxy deezer cover (${buf.length}b)`, r.status === 200 && (isJpeg || isPng));
    }
    const bad = await fetch(`${BASE}/api/image-proxy?url=${encodeURIComponent('https://example.com/evil.jpg')}`);
    ok('image-proxy blocks foreign host', bad.status === 403);
}

// ---------- 8. qobuz regression (real CDN url) ----------
{
    const t = dlTargets.qobuz;
    if (t?.url) {
        const head = await fetch(t.url, { method: 'HEAD' }).catch(() => null);
        ok('[qobuz] CDN url reachable', !!head && head.status === 200, head ? `HTTP ${head.status}` : 'fetch failed');
    }
}

// ---------- 9. invalid input handling ----------
{
    const r = await api(`/api/get-music?q=&offset=0&source=deezer`);
    ok('empty query -> clean error', r.status === 400 && r.body?.success === false);
    const r2 = await api(`/api/get-music?q=test&offset=0&source=nonsense`);
    ok('bad source defaults to qobuz', r2.status === 200 && r2.body?.data?.tracks?.items?.length > 0);
}

console.log('\n===== TEST RESULTS =====');
console.log(results.join('\n'));
console.log(`\n===== ${pass} passed, ${fail} failed, ${skip} skipped =====`);
process.exit(fail > 0 ? 1 : 0);
