#!/usr/bin/env python3
import asyncio
import websockets
import json
import uuid
import sys

TOKEN = "354a7d93f10c13948d552fb5745ca1012117a8d10110734f"
WS_URL = f"ws://10.1.16.11:18789/api/gateway?token={TOKEN}"
PHONE = "+819030684797"

async def send_whatsapp(message: str):
    async with websockets.connect(WS_URL) as ws:
        await ws.recv()  # challenge
        await ws.send(json.dumps({
            "type": "req", "id": "1", "method": "connect",
            "params": {
                "minProtocol": 3, "maxProtocol": 3,
                "client": {"id": "gateway-client", "version": "dev", "platform": "linux", "mode": "backend"},
                "role": "operator",
                "scopes": ["operator.admin", "operator.approvals", "operator.pairing"],
                "caps": [], "auth": {"token": TOKEN},
                "userAgent": "claude-code", "locale": "ja-JP"
            }
        }))
        await ws.recv()  # hello-ok

        req_id = str(uuid.uuid4())
        await ws.send(json.dumps({
            "type": "req", "id": req_id, "method": "send",
            "params": {
                "to": PHONE,
                "message": message,
                "idempotencyKey": str(uuid.uuid4()),
                "channel": "whatsapp"
            }
        }))

        while True:
            resp = json.loads(await ws.recv())
            if resp.get("id") == req_id:
                return resp

msg = sys.argv[1] if len(sys.argv) > 1 else "テスト"
result = asyncio.run(send_whatsapp(msg))
if result.get("ok"):
    print("✅ 送信成功")
else:
    print(f"❌ 失敗: {result}")
