import requests, json, re

token = re.search(r'AMAZON_MUSIC_TOKEN=(\S+)', open('.env', encoding='utf-8').read()).group(1)
H = {'Authorization': f'Bearer {token}', 'Accept': 'application/json'}
G = 'https://amz.dezalty.com'

def show(name, r):
    print(f'--- {name}: {r.status_code} ---')
    try:
        print(json.dumps(r.json(), indent=1)[:2000])
    except Exception:
        print(r.text[:500])

r = requests.get(f'{G}/session', headers=H, timeout=15)
show('session', r)

r = requests.get(f'{G}/search', params={'query': 'eminem', 'content_type': 'album', 'max_results': 3}, headers=H, timeout=30)
show('search album', r)

r = requests.get(f'{G}/search', params={'query': 'eminem', 'content_type': 'artist', 'max_results': 3}, headers=H, timeout=30)
show('search artist', r)

# album detail + artist detail using real ASINs from search
r = requests.get(f'{G}/albums/B001NYCW7Q', headers=H, timeout=30)
show('album detail', r)

r = requests.get(f'{G}/artists/B000S2JA4W', headers=H, timeout=30)
show('artist detail', r)
