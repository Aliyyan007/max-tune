#!/usr/bin/env python3
# Downloads a Spotify track's real audio via librespot-python.
# Auth: --creds <file> (stored session) or --username + --password (first run,
# afterwards the session blob is written back to --creds for reuse).
# Prints a single JSON line: {"file","size","format"} on success, {"error":...} on failure.

import argparse
import base64
import json
import os
import sys

import librespot.core
from librespot.audio.decoders import AudioQuality, VorbisOnlyAudioQuality
from librespot.metadata import TrackId

QUALITY_MAP = {
    'normal': AudioQuality.NORMAL,
    'high': AudioQuality.HIGH,
    'very_high': AudioQuality.VERY_HIGH,
    'lossless': AudioQuality.LOSSLESS,
}


def fail(msg):
    print(json.dumps({'error': msg}))
    sys.exit(1)


def build_session(args):
    # match zotify's proven path: default builder conf + stored(b64) + create()
    builder = librespot.core.Session.Builder()
    if os.path.isfile(args.creds):
        obj = json.load(open(args.creds))
        builder.stored(base64.b64encode(json.dumps(obj).encode('ascii')))
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('track', help='spotify track id (base62) or uri')
    ap.add_argument('output', help='output file path')
    ap.add_argument('--quality', default='very_high', choices=list(QUALITY_MAP))
    ap.add_argument('--creds', required=True)
    ap.add_argument('--username')
    ap.add_argument('--password')
    args = ap.parse_args()

    session = build_session(args)

    tid = args.track.strip()
    if ':' not in tid:
        tid = 'spotify:track:' + tid
    try:
        track_id = TrackId.from_uri(tid)
    except Exception:
        try:
            track_id = TrackId.from_base62(args.track.strip())
        except Exception as e:
            fail('bad_track_id: ' + str(e))

    quality = VorbisOnlyAudioQuality(QUALITY_MAP[args.quality])
    try:
        stream = session.content_feeder().load(track_id, quality, False, None)
    except Exception as e:
        msg = str(e) or type(e).__name__
        if 'audio key' in msg.lower() or 'premium' in msg.lower():
            fail('premium_required: Spotify denies audio keys to free accounts')
        fail(msg)

    stream_in = stream.input_stream.stream()
    total = 0
    if args.output == '-':
        # stream mode: audio bytes on stdout, diagnostics on stderr
        while True:
            chunk = stream_in.read(1 << 17)
            if not chunk:
                break
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
            total += len(chunk)
    else:
        with open(args.output, 'wb') as f:
            while True:
                chunk = stream_in.read(1 << 17)
                if not chunk:
                    break
                f.write(chunk)
                total += len(chunk)
    stream_in.close()
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
