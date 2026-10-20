#!/usr/bin/env python3
# Spotify OAuth login for librespot.
#
# Modes:
#   python tools/spotify-login.py [label]                 — full interactive flow (browser + localhost callback)
#   python tools/spotify-login.py --start [label]         — prints {"url": authorize_url} and stashes the PKCE
#                                                         verifier so a DIFFERENT machine can authorize
#   python tools/spotify-login.py --finish <url> [label]  — paste the dead 127.0.0.1 redirect URL the friend
#                                                         received; exchanges the code and stores creds
#
# Stores BOTH:
#   data/spotify-<hash>.json        (librespot session creds — audio downloads)
#   data/spotify-oauth-<hash>.json  (OAuth refresh token — Web API tokens)

import hashlib
import json
import os
import re
import sys
import webbrowser

import librespot.core
from librespot.core import OAuth
from librespot.mercury import MercuryRequests

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data')
PORT = 5588
SCOPES = [
    'app-remote-control', 'playlist-modify', 'playlist-modify-private', 'playlist-modify-public',
    'playlist-read', 'playlist-read-collaborative', 'playlist-read-private', 'streaming',
    'ugc-image-upload', 'user-follow-modify', 'user-follow-read', 'user-library-modify',
    'user-library-read', 'user-modify-playback-state', 'user-modify-private', 'user-personalized',
    'user-read-birthdate', 'user-read-currently-playing', 'user-read-email', 'user-read-play-history',
    'user-read-playback-position', 'user-read-playback-state', 'user-read-private',
    'user-read-recently-played', 'user-top-read',
]


def paths(label):
    h = hashlib.sha256(label.encode()).hexdigest()[:12]
    return (
        os.path.join(DATA_DIR, 'spotify-%s.json' % h),
        os.path.join(DATA_DIR, 'spotify-oauth-%s.json' % h),
        os.path.join(DATA_DIR, 'spotify-pkce-%s.json' % h),
    )


def persist_session(oauth, creds, oauth_creds):
    """Create the librespot session from login creds and persist both cred files."""
    conf = librespot.core.Session.Configuration(
        cache_enabled=False,
        cache_dir=os.path.join(DATA_DIR, '.cache'),
        do_cache_clean_up=True,
        store_credentials=True,
        stored_credentials_file=creds,
        retry_on_chunk_error=True,
    )
    builder = librespot.core.Session.Builder(conf)
    builder.login_credentials = oauth.get_credentials()
    session = builder.create()
    user = session.username()
    oauth.save_creds(oauth_creds)
    try:
        session.close()
    except Exception:
        pass
    return user


def start(label):
    _, _, pkce = paths(label)
    redirect = 'http://%s:%d/login' % ('127.0.0.1', PORT)
    oauth = OAuth(MercuryRequests.keymaster_client_id, redirect, lambda u: None)
    oauth.set_scopes(SCOPES)
    url = oauth.get_auth_url()
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(pkce, 'w') as f:
        json.dump({'code_verifier': oauth._OAuth__code_verifier, 'redirect': redirect}, f)
    print(json.dumps({'url': url}))


def finish(redirect_url, label):
    m = re.search(r'[?&]code=([^&]+)', redirect_url)
    if not m:
        print(json.dumps({'error': 'no code found in that URL — paste the full 127.0.0.1:5588 redirect URL'}))
        sys.exit(1)
    code = m.group(1)
    creds, oauth_creds, pkce = paths(label)
    if not os.path.isfile(pkce):
        print(json.dumps({'error': 'no pending login — run --start first'}))
        sys.exit(1)
    saved = json.load(open(pkce))
    oauth = OAuth(MercuryRequests.keymaster_client_id, saved['redirect'], lambda u: None)
    oauth._OAuth__code_verifier = saved['code_verifier']
    oauth.set_code(code)
    try:
        oauth.request_token()  # exchange the auth code -> access + refresh tokens
        user = persist_session(oauth, creds, oauth_creds)
        os.remove(pkce)
        print(json.dumps({'ok': True, 'user': user, 'creds': creds}))
    except Exception as e:
        print(json.dumps({'error': str(e) or type(e).__name__}))
        sys.exit(1)


def interactive(label):
    creds, oauth_creds, _ = paths(label)
    os.makedirs(DATA_DIR, exist_ok=True)

    def on_url(url):
        print('\nOpening Spotify login in your browser...')
        print('If it does not open, visit:\n\n  %s\n' % url)
        try:
            webbrowser.open(url)
        except Exception:
            pass

    redirect = 'http://%s:%d/login' % ('127.0.0.1', PORT)
    oauth = OAuth(MercuryRequests.keymaster_client_id, redirect, on_url)
    oauth.set_scopes(SCOPES).set_listen_all(False)
    print('Waiting for Spotify authorization (localhost:%d)...' % PORT, flush=True)
    oauth.flow()
    user = persist_session(oauth, creds, oauth_creds)
    print('Logged in as:', user, flush=True)
    print('Credentials stored at', creds)
    print('OAuth token stored at', oauth_creds)


def main():
    args = sys.argv[1:]
    if args and args[0] == '--start':
        start(args[1] if len(args) > 1 else 'default')
    elif args and args[0] == '--finish':
        if len(args) < 2:
            print(json.dumps({'error': 'missing redirect url'}))
            sys.exit(1)
        finish(args[1], args[2] if len(args) > 2 else 'default')
    else:
        interactive(args[0] if args else 'default')


if __name__ == '__main__':
    main()
