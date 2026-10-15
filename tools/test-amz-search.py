import requests, json, datetime, random, string

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
HOST = 'eu.mesk.skill.music.a2z.com'
DH = {
    'authority': HOST,
    'accept': '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'content-type': 'text/plain;charset=UTF-8',
    'origin': 'https://music.amazon.com',
    'priority': 'u=1, i',
    'referer': 'https://music.amazon.com/',
    'sec-ch-ua': '"Chromium";v="125", "Not.A/Brand";v="24"',
    'sec-ch-ua-mobile': '?1',
    'sec-ch-ua-platform': '"Android"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'cross-site',
    'user-agent': UA,
}

sess = requests.Session()
cr = sess.get('https://music.amazon.com/config.json', headers=DH, timeout=10)
print('config cookies:', dict(sess.cookies))
c = cr.json()
csrf = c.get('csrf', {})
rand13 = ''.join(random.choice(string.digits + string.ascii_lowercase) for _ in range(13))

inner = json.dumps({
    'x-amzn-authentication': json.dumps({'interface': 'ClientAuthenticationInterface.v1_0.ClientTokenElement', 'accessToken': c['accessToken']}),
    'x-amzn-device-model': 'WEBPLAYER',
    'x-amzn-device-width': '1920',
    'x-amzn-device-family': 'WebPlayer',
    'x-amzn-device-id': c['deviceId'],
    'x-amzn-user-agent': UA,
    'x-amzn-session-id': c['sessionId'],
    'x-amzn-device-height': '1080',
    'x-amzn-request-id': rand13,
    'x-amzn-device-language': 'en_US',
    'x-amzn-currency-of-preference': 'USD',
    'x-amzn-os-version': '1.0',
    'x-amzn-application-version': c.get('version', ''),
    'x-amzn-device-time-zone': 'Asia/Calcutta',
    'x-amzn-timestamp': str(int(datetime.datetime.now().timestamp() * 1000)),
    'x-amzn-csrf': json.dumps({'interface': 'CSRFInterface.v1_0.CSRFHeaderElement', 'token': csrf.get('token', ''), 'timestamp': str(csrf.get('ts', '')), 'rndNonce': str(csrf.get('rnd', ''))}),
    'x-amzn-music-domain': 'music.amazon.com',
    'x-amzn-referer': 'music.amazon.com',
    'x-amzn-affiliate-tags': '',
    'x-amzn-ref-marker': '',
    'x-amzn-page-url': 'https://music.amazon.com/search/eminem/songs',
    'x-amzn-weblab-id-overrides': '',
    'x-amzn-video-player-token': '',
    'x-amzn-feature-flags': 'hd-supported,uhd-supported',
    'x-amzn-has-profile-id': '',
    'x-amzn-age-band': '',
})

body = {'keyword': 'eminem', 'userHash': json.dumps({'level': 'LIBRARY_MEMBER'}), 'headers': inner}
r = sess.post(f'https://{HOST}/api/searchCatalogTracks', json=body, headers=DH, timeout=15)
print(HOST, '->', r.status_code)
d = r.json()
items = d.get('methods', [{}])[0].get('template', {}).get('widgets', [{}])[0].get('items', [])
print('items:', len(items))
if items:
    print(json.dumps(items[0])[:800])
    nex = d.get('methods', [{}])[0].get('onEndOfWidget')
    print('next-token url:', (nex[0].get('url', '')[:150] if nex else None))
else:
    print(json.dumps(d)[:400])

# Try artist + album search endpoints too
for ep, kw in [('searchCatalogArtists', 'eminem'), ('searchCatalogAlbums', 'eminem')]:
    body2 = {'keyword': kw, 'userHash': json.dumps({'level': 'LIBRARY_MEMBER'}), 'headers': inner}
    r2 = sess.post(f'https://{HOST}/api/{ep}', json=body2, headers=DH, timeout=15)
    d2 = r2.json()
    items2 = d2.get('methods', [{}])[0].get('template', {}).get('widgets', [{}])[0].get('items', [])
    print(ep, '->', r2.status_code, '| items:', len(items2))
    if items2:
        print('  ', json.dumps(items2[0])[:500])
