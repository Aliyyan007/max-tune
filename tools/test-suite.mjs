// Production-grade verification suite — hits a RUNNING server (BASE env or :3000).
// Exercises every platform: search → album/artist info parity → download →
// container/artwork validation → progress stages → admin auth → zip.
//
//   node tools/test-suite.mjs                # against localhost:3000
//   BASE=https://max-tune.onrender.com node tools/test-suite.mjs
//
// A non-zero exit code means something regressed.

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, statSync } from 'node:fs';
import ffmpegPath from 'ffmpeg-static';
import path from 'node:path';

const BASE = (process.env.BASE || 'http://localhost:3000').replace(/\/$/, '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'aliyyan132580';
const OUT = path.join(process.cwd(), 'data', 'test-out');
mkdirSync(OUT, { recursive: true });

const PLATFORMS = ['qobuz', 'deezer', 'tidal', 'spotify', 'apple', 'amazon'];
const SEARCH_Q = process.env.Q || 'faded alan walker';

let pass = 0,
    fail = 0;
const failures = [];
function check(name, cond, extra = '') {
    if (cond) {
        pass++;
        console.log(`  ✓ ${name}`);
    } else {
        fail++;
        failures.push(`${name} ${extra}`);
        console.log(`  ✗ ${name} ${extra}`);
    }
}

const api = async (p, opts = {}) => {
    const res = await fetch(`${BASE}${p}`, opts);
    let json = null;
    try {
        json = await res.json();
    } catch {}
    return { status: res.status, json };
};

function ffprobe(file) {
    try {
        return execFileSync(ffmpegPath, ['-hide_banner', '-i', file], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    } catch (e) {
        return e.stderr?.toString() ?? e.stdout?.toString() ?? '';
    }
}
const magic = (buf) => buf.slice(0, 4).toString('latin1');

async function downloadJob(spec, tag, { minBytes = 50_000, expectPreview = false } = {}) {
    const created = await api('/api/download-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spec)
    });
    check(`${tag}: job created`, created.status === 200 && created.json?.data?.job, JSON.stringify(created.json).slice(0, 200));
    const job = created.json?.data?.job;
    if (!job) return null;

    // collect progress stages while streaming
    const stages = [];
    const ctrl = new AbortController();
    const poller = (async () => {
        while (!ctrl.signal.aborted) {
            try {
                const p = (await api(`/api/job-status?id=${job}`)).json?.data;
                if (p) stages.push(p.stage);
                if (p?.stage === 'done' || p?.stage === 'error') return;
            } catch {}
            await new Promise((r) => setTimeout(r, 400));
        }
    })();

    const res = await fetch(`${BASE}/api/download-file?job=${job}`);
    const buf = Buffer.from(await res.arrayBuffer());
    ctrl.abort();
    await poller.catch(() => {});

    // 'done' lands right after the response drains — give it a beat
    let last = await api(`/api/job-status?id=${job}`);
    for (let i = 0; i < 10 && last.json?.data?.stage !== 'done' && last.json?.data?.stage !== 'error'; i++) {
        await new Promise((r) => setTimeout(r, 300));
        last = await api(`/api/job-status?id=${job}`);
    }
    const finalStage = last.json?.data?.stage;
    const err = last.json?.data?.error;

    if (res.status !== 200) {
        // entitlement failures are honest platform rejections, not bugs
        if (expectPreview === 'entitled' && /eligible|entitle|premium|unlimited|subscription|token/i.test(err ?? '')) {
            check(`${tag}: entitlement error surfaced (expected on free tier)`, true);
            return null;
        }
        check(`${tag}: HTTP 200`, false, `${res.status} ${buf.slice(0, 200).toString('latin1')}`);
        return null;
    }
    if (expectPreview) {
        check(`${tag}: audio bytes (preview ok)`, buf.length > 20_000 && !magic(buf).startsWith('{'), `len=${buf.length}`);
    } else {
        check(`${tag}: HTTP 200 + real bytes`, buf.length > minBytes, `len=${buf.length}`);
    }
    check(`${tag}: not JSON`, !magic(buf).startsWith('{') && !magic(buf).startsWith('['), magic(buf));
    check(`${tag}: job stage reached done`, finalStage === 'done', `stage=${finalStage} err=${(err || '').slice(0, 120)}`);
    check(`${tag}: progress pipeline ran`, stages.length > 1, `stages=${[...new Set(stages)].join('>')}`);
    return { buf, job };
}

async function main() {
    console.log(`\n== max-tune verification suite → ${BASE} ==\n`);

    // ---- reachability ----
    const home = await fetch(BASE);
    check('homepage 200', home.status === 200);

    // ---- per-platform: search → track fields → album → artist/releases ----
    const per = {};
    for (const src of PLATFORMS) {
        console.log(`\n-- ${src} --`);
        const r = await api(`/api/get-music?q=${encodeURIComponent(SEARCH_Q)}&source=${src}&offset=0`);
        const tracks = r.json?.data?.tracks?.items ?? [];
        check(`${src}: search ok`, r.status === 200 && tracks.length > 0, `status=${r.status} n=${tracks.length} err=${(r.json?.error || '').slice(0, 100)}`);
        if (!tracks.length) continue;
        const t = tracks[0];
        check(`${src}: track has title+duration`, !!t.title && (t.duration ?? 0) > 0, `dur=${t.duration}`);
        const art = t.album?.image?.large ?? t.image?.large;
        check(`${src}: track has art`, !!art, '');
        per[src] = { track: t, art };

        const albumId = t.album?.id;
        if (albumId) {
            const a = await api(`/api/get-album?album_id=${albumId}&source=${src}`);
            const alb = a.json?.data;
            check(`${src}: album info`, a.status === 200 && !!alb?.title, `err=${(a.json?.error || '').slice(0, 100)}`);
            check(`${src}: album duration>0`, (alb?.duration ?? 0) > 0, `dur=${alb?.duration} tc=${alb?.tracks_count}`);
            check(`${src}: album tracks_count>0`, (alb?.tracks_count ?? 0) > 0, '');
            per[src].album = alb;
        }
        const artistId = (t.artists?.[0]?.id ?? t.album?.artists?.[0]?.id ?? t.performer?.id ?? t.artist?.id) || null;
        if (artistId) {
            const ar = await api(`/api/get-artist?artist_id=${encodeURIComponent(artistId)}&artist_name=${encodeURIComponent(t.artists?.[0]?.name ?? t.performer?.name ?? '')}&source=${src}&limit=5`);
            const artist = ar.json?.data?.artist ?? ar.json?.data;
            // releases buckets vary per source: releases.{album,epSingle,live}.items
            const buckets = artist?.releases ?? artist?.albums?.items ?? {};
            let relCount = 0;
            if (Array.isArray(buckets)) relCount = buckets.length;
            else for (const b of Object.values(buckets)) relCount = Math.max(relCount, (b?.items?.length ?? (Array.isArray(b) ? b.length : 0)));
            check(`${src}: artist releases>0`, relCount > 0, `status=${ar.status} count=${relCount} keys=${Object.keys(buckets).join(',')}`);
            per[src].artist = artist;
        } else {
            check(`${src}: track exposes artist id`, false, 'no artist id on track');
        }
    }

    // ---- downloads (SOURCE/original format + art) ----
    console.log('\n-- downloads --');
    const dlSpec = (src, t, extra = {}) => ({
        source: src,
        id: String(t.id),
        quality: '27',
        title: t.title ?? 't',
        artist: (t.artists?.[0]?.name ?? t.album?.artist?.name ?? t.performer?.name ?? 'x'),
        album: t.album?.title ?? 'x',
        filename: `test-${src}`,
        applyMeta: true,
        codec: 'SOURCE',
        artUrl: per[src]?.art,
        tokens: {},
        country: 'US',
        duration: t.duration ?? 200,
        ...extra
    });

    const files = {};
    for (const src of ['qobuz', 'deezer', 'spotify', 'apple', 'tidal', 'amazon']) {
        const t = per[src]?.track;
        if (!t) continue;
        // apple without entitlement → 30s preview; amazon/tidal free-tier → may 502 with an eligibility error
        const expect = src === 'apple' ? true : ['amazon', 'tidal'].includes(src) ? 'entitled' : false;
        const r = await downloadJob(dlSpec(src, t), `download ${src}`, { expectPreview: expect });
        if (r?.buf?.length) {
            const file = path.join(OUT, `${src}-${t.id}`);
            writeFileSync(file, r.buf);
            files[src] = file;
            const info = ffprobe(file);
            const hasAudio = /Audio:\s*(vorbis|flac|aac|mp3|alac|opus|pcm|eac3)/i.test(info);
            check(`${src}: valid audio container`, hasAudio, info.match(/Audio:\s*\w+/)?.[0] ?? 'no audio stream');
            const hasArt = /attached_pic|mjpeg|png\s|METADATA_BLOCK_PICTURE|Video:.*(mjpeg|png)/i.test(info);
            check(`${src}: artwork embedded`, hasArt, 'no attached picture in ffprobe output');
        }
    }

    // ---- admin auth ----
    console.log('\n-- admin --');
    const bad = await api('/api/admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'wrong', action: 'stats' }) });
    check('admin rejects wrong password', bad.status === 401);
    const ok = await api('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: ADMIN_PASSWORD, action: 'stats' })
    });
    check('admin stats ok', ok.status === 200 && ok.json?.data?.stats?.uptimeSec != null, JSON.stringify(ok.json).slice(0, 150));

    // ---- zip flow ----
    if (per.qobuz?.album) {
        console.log('\n-- album zip --');
        const created = await api('/api/album-zip', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                albumId: String(per.qobuz.album.id),
                source: 'qobuz',
                quality: '27',
                codec: 'SOURCE',
                applyMeta: true,
                tokens: {},
                zipName: 'test-album',
                trackNamePattern: '{artists} - {name}'
            })
        });
        const job = created.json?.data?.job;
        check('zip job created', !!job);
        if (job) {
            const res = await fetch(`${BASE}/api/album-zip?job=${job}`);
            const buf = Buffer.from(await res.arrayBuffer());
            check('zip 200 + PK magic', res.status === 200 && magic(buf).startsWith('PK'), `status=${res.status} len=${buf.length} magic=${magic(buf)}`);
            const entryCount = (buf.toString('latin1').match(/PK\u0001\u0002/g) || []).length;
            check('zip has entries', entryCount >= 2, `entries=${entryCount}`);
        }
    }

    // ---- summary ----
    console.log(`\n================ ${pass} passed, ${fail} failed ================`);
    if (failures.length) {
        console.log('FAILURES:');
        failures.forEach((f) => console.log('  -', f));
        process.exit(1);
    }
    console.log('All green.\n');
}

main().catch((e) => {
    console.error('suite crashed:', e);
    process.exit(1);
});
