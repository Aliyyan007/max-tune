"""
Amazon Music Widevine key resolver.

Usage: python tools/amz-license.py <pssh_b64> --rid <request_id> --asin <asin> [--wvd <path>]

Builds a Widevine license challenge from the PSSH with pywidevine and exchanges
it at Amazon's getLicenseForPlaybackV2 endpoint (the mobile app's license call).
Auth uses the exported session's ADP token/private-key request signature plus its
website cookies.

Requires a Widevine device file (.wvd) at data/amazon-device.wvd and a session
export at data/amazon-session.json.
"""

import argparse, base64, datetime, json, os, sys, uuid

import requests
from Crypto.Hash import SHA256
from Crypto.PublicKey import RSA
from Crypto.Signature import pkcs1_15

GATEWAY = "https://amz.dezalty.com"


def load_session() -> dict:
    session_file = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "amazon-session.json")
    if not os.path.exists(session_file):
        raise SystemExit("No data/amazon-session.json — export your Amazon session first")
    return json.load(open(session_file, encoding="utf-8"))


def signed_adp_headers(method: str, raw_path: str, body: str, session: dict) -> dict:
    adp_token = session.get("adp_token") or ""
    private_key_pem = session.get("device_private_key_pem") or ""
    if not adp_token or not private_key_pem:
        raise SystemExit("Amazon session is missing adp_token/device_private_key_pem — re-export the mobile session")
    date = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    data = f"{method}\n{raw_path}\n{date}\n{body}\n{adp_token}"
    key = RSA.import_key(private_key_pem)
    signature = base64.b64encode(pkcs1_15.new(key).sign(SHA256.new(data.encode()))).decode()
    return {
        "x-adp-token": adp_token,
        "x-adp-alg": "SHA256withRSA:1.0",
        "x-adp-signature": f"{signature}:{date}",
    }


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
    if not customer_id:
        raise SystemExit("Amazon session missing customer_id — re-export data/amazon-session.json")

    # Build Widevine challenge from the PSSH
    device = Device.load(args.wvd)
    cdm = Cdm.from_device(device)
    session_id = cdm.open()
    challenge = cdm.get_license_challenge(session_id, PSSH(args.pssh))

    # Digital Music License Service — the Android app's signed license call.
    # Amazon validates x-adp-signature over the exact bytes transmitted below.
    application_version = "22.15.12"
    harley_version = "3.12.3.86"
    asin = args.asin or "unknown"
    raw_path = f"/{region}/api/dmls/getLicenseForPlaybackV2"
    lic_url = f"https://music.amazon.{tld}{raw_path}"
    body = {
        "DrmType": "WIDEVINE",
        "appInfo": {"musicAgent": f"Harley/{harley_version} Harley/{application_version} ( {uuid.uuid4()} {asin} )"},
        "deviceToken": {"deviceId": device_id, "deviceTypeId": device_type},
        "licenseChallenge": base64.b64encode(challenge).decode(),
        "persistent": False,
    }
    raw_body = json.dumps(body, separators=(",", ":"))
    headers = {
        "User-Agent": "Mozilla/5.0 (Linux; Android 11; Pixel 5 Build/RD2A.211001.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/108.0.5359.128 Mobile Safari/537.36",
        "android-app-version": application_version,
        "content-encoding": "amz-1.0",
        "accept": "application/json",
        "accept-encoding": "gzip",
        "accept-charset": "utf-8",
        "content-type": "application/json; charset=UTF-8",
        "X-Amz-requestid": str(uuid.uuid4()),
        "X-Amz-Target": "com.amazon.digitalmusiclocator.DigitalMusicLocatorServiceExternal.getLicenseForPlaybackV2",
        "Origin": f"https://music.amazon.{tld}",
        "Referer": f"https://music.amazon.{tld}/",
    }
    headers.update(signed_adp_headers("POST", raw_path, raw_body, exp))
    r = requests.post(lic_url, data=raw_body.encode(), headers=headers, cookies=cookies, timeout=30)
    if r.status_code != 200:
        denial = ""
        try:
            denial = r.json().get("denialReason") or ""
        except Exception:
            pass
        # Amazon's raw error embeds customer/device/key/request identifiers. Keep
        # the machine-useful denial class without propagating those identifiers.
        raise SystemExit(f"License request failed: {r.status_code} {denial or 'Amazon rejected the license request'}")

    payload = r.json()
    lic_b64 = payload.get("license")
    if not lic_b64:
        raise SystemExit(f"License response has no license field: {r.text[:400]}")
    cdm.parse_license(session_id, lic_b64)
    for key in cdm.get_keys(session_id):
        if key.type == "CONTENT":
            print(f"{key.kid.hex}:{key.key.hex()}")
            cdm.close(session_id)
            return 0
    cdm.close(session_id)
    raise SystemExit("No content key in license response")


if __name__ == "__main__":
    sys.exit(main())
