"""
Amazon Music Widevine key resolver.

Usage: python tools/amz-license.py <pssh_b64> --rid <request_id> --asin <asin> [--wvd <path>]

Builds a Widevine license challenge from the PSSH with pywidevine and exchanges
it at Amazon's getLicenseForPlaybackV3 endpoint (the same call the web player
makes). Auth uses the stored website session's at-main token as Bearer, plus the
x-amz-music-* headers Amazon requires (rid comes from the stream's base_url).

Requires a Widevine device file (.wvd) at data/amazon-device.wvd and a session
export at data/amazon-session.json.
"""

import argparse, base64, json, os, re, sys

import requests

GATEWAY = "https://amz.dezalty.com"


def load_session() -> dict:
    session_file = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "amazon-session.json")
    if not os.path.exists(session_file):
        raise SystemExit("No data/amazon-session.json — export your Amazon session first")
    return json.load(open(session_file, encoding="utf-8"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pssh")
    ap.add_argument("--rid", default="")
    ap.add_argument("--asin", default="")
    ap.add_argument("--wvd", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "amazon-device.wvd"))
    args = ap.parse_args()

    try:
        from pywidevine import PSSH, Cdm, Device, DeviceTypes  # noqa
    except ImportError:
        raise SystemExit("pywidevine not installed — run: pip install pywidevine")

    if not os.path.exists(args.wvd):
        raise SystemExit(f"No Widevine device file at {args.wvd} — drop a .wvd there (extracted from an Android device or emulator)")

    exp = load_session()
    customer_id = exp.get("customer_id")
    device_type = exp.get("device_type")
    device_id = exp.get("device_serial")
    tld = exp.get("domain_tld", "com")
    region = exp.get("customer_info", {}).get("home_region", "NA")
    cookies = exp.get("website_cookies", {})
    if isinstance(cookies, list):
        cookies = {c.get("name"): c.get("value") for c in cookies if isinstance(c, dict)}
    bearer = cookies.get("at-main") or exp.get("access_token") or ""
    if not customer_id:
        raise SystemExit("Amazon session missing customer_id — re-export data/amazon-session.json")

    # Build Widevine challenge from the PSSH
    device = Device.load(args.wvd)
    cdm = Cdm.from_device(device)
    session_id = cdm.open()
    challenge = cdm.get_license_challenge(session_id, PSSH(args.pssh))

    # Digital Music License Vending Service — the web player's license call
    lic_url = f"https://music.amazon.{tld}/{region}/api/dmlvs/v1/getLicenseForPlaybackV3"
    body = {
        "DrmType": "WIDEVINE",
        "licenseChallenge": base64.b64encode(challenge).decode(),
        "customerId": customer_id,
        "deviceToken": {"deviceTypeId": device_type, "deviceId": device_id},
        "appInfo": {"musicAgent": "Maestro/1.0 WebCP/1.0 (mobile)"},
    }
    headers = {
        "Authorization": f"Bearer {bearer}",
        "X-Amz-Target": "com.amazon.digitalmusiclocator.DigitalMusicLocatorServiceExternal.getLicenseForPlaybackV3",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Origin": f"https://music.amazon.{tld}",
        "User-Agent": "AmazonMusic/1.0 CFNetwork/1.0",
        "x-amz-music-agent": "AmazonMusic/1.0 WebCP/1.0",
        "x-amz-music-rid": args.rid,
        "x-amz-music-asin": args.asin,
        "x-amz-music-device-type": device_type,
        "x-amz-music-device-id": device_id,
        "x-amz-music-customer-id": customer_id,
        "x-amz-music-drm-type": "WIDEVINE",
    }
    r = requests.post(lic_url, json=body, headers=headers, cookies=cookies, timeout=30)
    if r.status_code != 200:
        raise SystemExit(f"License request failed: {r.status_code} {r.text[:400]}")

    payload = r.json()
    lic_b64 = payload.get("license")
    if not lic_b64:
        raise SystemExit(f"License response has no license field: {r.text[:400]}")
    cdm.parse_license(session_id, base64.b64decode(lic_b64))
    for key in cdm.get_keys(session_id):
        if key.type == "CONTENT":
            print(f"{key.kid.hex}:{key.key.hex}")
            cdm.close(session_id)
            return 0
    cdm.close(session_id)
    raise SystemExit("No content key in license response")


if __name__ == "__main__":
    sys.exit(main())
