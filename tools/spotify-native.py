#!/usr/bin/env python3
# Downloads a Spotify track's real audio via librespot-python.
# Auth: --creds <file> (stored session) or --username + --password (first run,
# afterwards the session blob is written back to --creds for reuse).
#
# Single-shot mode:  spotify-native.py <track> <output> --quality q --creds f
# Daemon mode:       spotify-native.py --daemon --creds f
#   stdin  one JSON job per line:
#            {"track":"id|uri","quality":"very_high","mode":"file","out":"p.ogg"}
#            {"track":"id|uri","quality":"very_high","mode":"stream"}
#   stdout file mode   → {"file":..,"size":N,"format":"ogg"} | {"error":..}
#          stream mode → {"size":N,"format":"ogg"}\n + exactly N bytes + {"done":true}\n
#                       (size 0 → daemon falls back to a {"file":..} result)
#   One librespot Session serves every job — creation costs apresolve+handshake+
#   auth+login5 (seconds), so keeping it warm is the whole point. The daemon is
#   serialized by design: parallel sessions on one account get dropped.

import argparse
import base64
import json
import os
import sys
import tempfile

import librespot.core
from librespot.audio.decoders import AudioQuality, VorbisOnlyAudioQuality
from librespot.metadata import TrackId

# Older librespot releases lack LOSSLESS — fall back to VERY_HIGH so the module
# still loads instead of dying at import time on an AttributeError.
QUALITY_MAP = {
    'normal': AudioQuality.NORMAL,
    'high': AudioQuality.HIGH,
    'very_high': AudioQuality.VERY_HIGH,
    'lossless': getattr(AudioQuality, 'LOSSLESS', AudioQuality.VERY_HIGH),
}


_STREAM_MODE = False  # set once args are parsed; stdout carries audio then


def fail(msg):
    print(json.dumps({'error': msg}), file=sys.stderr if _STREAM_MODE else sys.stdout)
    sys.exit(1)


def build_session(args):
    # match zotify's proven path: default builder conf + stored(b64) + create()
    builder = librespot.core.Session.Builder()
    if os.path.isfile(args.creds):
        with open(args.creds) as f:
            obj = json.load(f)
        # stored() wants the base64 credential as str across librespot versions —
        # b64encode returns bytes, which some releases reject with TypeError.
        builder.stored(base64.b64encode(json.dumps(obj).encode('ascii')).decode('ascii'))
    elif args.username and args.password:
        builder.user_pass(args.username, args.password)
    else:
        fail('no_credentials')
    try:
        session = builder.create()
    except Exception as e:
        fail(str(e) or type(e).__name__)
    print('[stage] session created', file=sys.stderr, flush=True)
    return session


def load_stream(session, track, quality_name):
    tid = track.strip()
    if ':' not in tid:
        tid = 'spotify:track:' + tid
    try:
        track_id = TrackId.from_uri(tid)
    except Exception:
        track_id = TrackId.from_base62(track.strip())
    quality = VorbisOnlyAudioQuality(QUALITY_MAP[quality_name])
    try:
        return session.content_feeder().load(track_id, quality, False, None)
    except Exception as e:
        msg = str(e) or type(e).__name__
        if 'audio key' in msg.lower() or 'premium' in msg.lower():
            raise RuntimeError('premium_required: Spotify denies audio keys to free accounts')
        raise


def copy_stream(stream_in, write):
    total = 0
    while True:
        chunk = stream_in.read(1 << 17)
        if not chunk:
            break
        write(chunk)
        total += len(chunk)
    return total


def run_job(session_holder, job):
    """One download job against the live session. Returns a result dict."""
    track = job.get('track', '')
    q = job.get('quality', 'very_high')
    if q not in QUALITY_MAP:
        q = 'very_high'
    mode = job.get('mode', 'file')
    out = job.get('out') or os.path.join(tempfile.gettempdir(), 'spotify-native.ogg')

    stream = load_stream(session_holder[0], track, q)
    stream_in = stream.input_stream.stream()
    size = int(getattr(stream.input_stream, 'size', 0) or 0)

    if mode == 'stream' and size > 0:
        # framed chunks: {"size":N}\n then {"n":len}\n<bytes> per read, then
        # {"done":true,"sent":M} — a mid-stream failure emits {"error":..} instead
        # of hanging the reader waiting for promised bytes.
        outb = sys.stdout.buffer
        outb.write((json.dumps({'size': size, 'format': 'ogg'}) + '\n').encode())
        outb.flush()
        got = 0
        try:
            while True:
                chunk = stream_in.read(1 << 17)
                if not chunk:
                    break
                got += len(chunk)
                outb.write((json.dumps({'n': len(chunk)}) + '\n').encode())
                outb.write(chunk)
            stream_in.close()
            outb.write((json.dumps({'done': True, 'sent': got}) + '\n').encode())
        except Exception as e:
            try:
                stream_in.close()
            except Exception:
                pass
            outb.write((json.dumps({'error': str(e) or type(e).__name__, 'sent': got}) + '\n').encode())
        outb.flush()
        return None  # already emitted

    # file mode (and stream fallback when size is unknown)
    with open(out, 'wb') as f:
        total = copy_stream(stream_in, f.write)
    stream_in.close()
    if total < 1024:
        return {'error': 'empty_stream'}
    return {'file': out, 'size': total, 'format': 'ogg'}


def daemon_loop(args):
    session_holder = [build_session(args)]
    sys.stdout.write(json.dumps({'ready': True}) + '\n')
    sys.stdout.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            job = json.loads(line)
        except Exception:
            sys.stdout.write(json.dumps({'error': 'bad job json'}) + '\n')
            sys.stdout.flush()
            continue
        try:
            result = run_job(session_holder, job)
        except Exception as e:
            msg = str(e) or type(e).__name__
            # a dead AP socket kills the session — rebuild once and retry the job
            try:
                session_holder[0] = build_session(args)
                result = run_job(session_holder, job)
            except Exception as e2:
                result = {'error': str(e2) or type(e2).__name__}
                if 'premium' in msg or 'premium' in str(e2):
                    result = {'error': 'premium_required: Spotify denies audio keys to free accounts'}
        if result is not None:
            sys.stdout.buffer.write((json.dumps(result) + '\n').encode())
            sys.stdout.buffer.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('track', nargs='?', help='spotify track id (base62) or uri')
    ap.add_argument('output', nargs='?', help='output file path')
    ap.add_argument('--daemon', action='store_true', help='serve jobs on stdin/stdout')
    ap.add_argument('--quality', default='very_high', choices=list(QUALITY_MAP))
    ap.add_argument('--creds', required=True)
    ap.add_argument('--username')
    ap.add_argument('--password')
    args = ap.parse_args()

    if args.daemon:
        daemon_loop(args)
        return

    global _STREAM_MODE
    _STREAM_MODE = args.output == '-'

    session = build_session(args)
    try:
        stream = load_stream(session, args.track or '', args.quality)
        stream_in = stream.input_stream.stream()
        if args.output == '-':
            total = copy_stream(stream_in, lambda c: (sys.stdout.buffer.write(c), sys.stdout.buffer.flush()))
        else:
            with open(args.output, 'wb') as f:
                total = copy_stream(stream_in, f.write)
        stream_in.close()
    finally:
        try:
            session.close()
        except Exception:
            pass

    if total < 1024:
        fail('empty_stream')
    # stdout carries audio in stream mode — emit the result JSON on stderr there
    print(json.dumps({'file': args.output, 'size': total, 'format': 'ogg'}), file=sys.stderr if args.output == '-' else sys.stdout)


if __name__ == '__main__':
    main()
