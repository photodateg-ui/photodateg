#!/usr/bin/env python3
"""GitHub Secretsを設定するスクリプト"""
import base64
import requests
from nacl import encoding, public

import os
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
REPO = "photodateg-ui/photodateg"

def encrypt_secret(public_key_b64, secret_value):
    public_key_bytes = base64.b64decode(public_key_b64)
    pk = public.PublicKey(public_key_bytes)
    box = public.SealedBox(pk)
    encrypted = box.encrypt(secret_value.encode("utf-8"))
    return base64.b64encode(encrypted).decode("utf-8")

def get_public_key():
    url = f"https://api.github.com/repos/{REPO}/actions/secrets/public-key"
    headers = {"Authorization": f"Bearer {GITHUB_TOKEN}", "Accept": "application/vnd.github+json"}
    r = requests.get(url, headers=headers)
    r.raise_for_status()
    return r.json()

def set_secret(secret_name, secret_value, key_id, public_key):
    url = f"https://api.github.com/repos/{REPO}/actions/secrets/{secret_name}"
    headers = {"Authorization": f"Bearer {GITHUB_TOKEN}", "Accept": "application/vnd.github+json"}
    encrypted = encrypt_secret(public_key, secret_value)
    data = {"encrypted_value": encrypted, "key_id": key_id}
    r = requests.put(url, headers=headers, json=data)
    if r.status_code in (201, 204):
        print(f"✅ {secret_name} を設定しました")
    else:
        print(f"❌ {secret_name} 失敗: {r.status_code} {r.text}")

# p8ファイルをbase64エンコード
with open("AuthKey_YZVCS947PA.p8", "rb") as f:
    asc_key_b64 = base64.b64encode(f.read()).decode()

# p12ファイルをbase64エンコード
with open("ios_dist.p12", "rb") as f:
    p12_b64 = base64.b64encode(f.read()).decode()

# mobileprovisionをbase64エンコード
with open("photodategdistribution.mobileprovision", "rb") as f:
    profile_b64 = base64.b64encode(f.read()).decode()

secrets = {
    "ASC_KEY_ID": "YZVCS947PA",
    "ASC_KEY_ISSUER_ID": "69a6de88-de89-47e3-e053-5b8c7c11a4d1",
    "ASC_KEY_CONTENT_BASE64": asc_key_b64,
    "CERTIFICATE_P12_BASE64": p12_b64,
    "CERTIFICATE_PASSWORD": "photodateg2026",
    "PROVISIONING_PROFILE_BASE64": profile_b64,
}

print("GitHub Secretsを設定中...")
key_info = get_public_key()
for name, value in secrets.items():
    set_secret(name, value, key_info["key_id"], key_info["key"])

print("\n完了！")
