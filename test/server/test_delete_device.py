import asyncio
import contextlib
import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'server', 'src'))

import auth
import bridge_sync
import bridge_ws

KEY = 'deployment-key'
REQUEST = SimpleNamespace(headers={'x-api-key': KEY}, url=SimpleNamespace(scheme='https'))


def test_removing_a_device_revokes_its_bridge_then_deletes_only_its_rows(monkeypatch):
    deleted, notified, revoked = [], [], []
    sessions = SimpleNamespace(
        query=lambda KeyConditionExpression, **_: {'Items': [{'sk': sk} for sk in ('SESS#Mac#p#s', 'PROJ#Mac#p', 'SESS#Mac2#p#s')
            if sk.startswith(KeyConditionExpression.get_expression()['values'][1].get_expression()['values'][1])]},
        batch_writer=lambda: contextlib.nullcontext(SimpleNamespace(delete_item=lambda Key: deleted.append(Key['sk']))))
    monkeypatch.setattr(bridge_sync, '_tables', lambda: (sessions, None))
    monkeypatch.setenv('WS_API_ENDPOINT', 'https://ws.test/v1')
    monkeypatch.setattr(bridge_ws, 'disconnect_removed_bridge', lambda *args: notified.append(args))
    monkeypatch.setattr(auth, 'list_credentials', lambda account: [
        {'sk': 'a', 'kind': 'bridge', 'device': 'Mac'}, {'sk': 'b', 'kind': 'bridge', 'device': 'Mac2'},
        {'sk': 'c', 'kind': 'app'}, {'sk': 'd', 'kind': 'master'}])
    monkeypatch.setattr(auth, 'delete_credentials', lambda items: revoked.extend(item['sk'] for item in items))
    reply = asyncio.run(bridge_sync.delete_device(bridge_sync.DeleteDeviceRequest(deviceName='Mac'), REQUEST))
    assert reply == {'ok': True, 'deletedSessions': 1}
    assert revoked == ['a']
    assert notified == [(auth.legacy_account_id(KEY), 'https://ws.test/v1', 'Mac')]
    assert deleted == ['DEV#Mac', 'SESS#Mac#p#s', 'PROJ#Mac#p']
