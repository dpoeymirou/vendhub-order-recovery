"""Fixed assessment fixture. Treat this service as an external supplier."""
import json
import os
import socket
import sqlite3
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

DB = os.environ.get('SUPPLIER_DB', '/tmp/vendhub-exercise-supplier.sqlite')
Path(DB).parent.mkdir(parents=True, exist_ok=True)

def connect():
    connection = sqlite3.connect(DB, timeout=10)
    connection.row_factory = sqlite3.Row
    return connection

with connect() as db:
    db.executescript('''
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS supplier_orders (
      supplier_order_id TEXT PRIMARY KEY,
      idempotency_key TEXT UNIQUE,
      order_ref TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS faults (
      order_ref TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      consumed INTEGER NOT NULL DEFAULT 0
    );
    ''')

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, payload):
        value = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(value)))
        self.end_headers()
        self.wfile.write(value)

    def read_json(self):
        size = int(self.headers.get('Content-Length', '0'))
        if size > 16384:
            raise ValueError('Request too large')
        return json.loads(self.rfile.read(size) or b'{}')

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == '/health':
            return self.reply(200, {'ok': True})
        if url.path == '/orders':
            ref = parse_qs(url.query).get('order_ref', [None])[0]
            with connect() as db:
                rows = db.execute('SELECT supplier_order_id, order_ref, payload FROM supplier_orders' + (' WHERE order_ref = ?' if ref is not None else ''), (ref,) if ref is not None else ()).fetchall()
            return self.reply(200, [{**json.loads(row['payload']), 'supplier_order_id': row['supplier_order_id']} for row in rows])
        return self.reply(404, {'error': 'Not found'})

    def do_POST(self):
        try:
            value = self.read_json()
            if not isinstance(value, dict):
                return self.reply(400, {'error': 'Expected object'})
            if self.path == '/_test/reset':
                with connect() as db:
                    db.execute('DELETE FROM supplier_orders')
                    db.execute('DELETE FROM faults')
                return self.reply(200, {'reset': True})
            if self.path == '/_test/mode':
                if value.get('mode') not in ('normal', 'unavailable', 'reject', 'accept_then_disconnect_once') or not isinstance(value.get('order_ref'), str):
                    return self.reply(400, {'error': 'Invalid mode or order_ref'})
                with connect() as db:
                    db.execute('INSERT INTO faults(order_ref, mode, consumed) VALUES (?, ?, 0) ON CONFLICT(order_ref) DO UPDATE SET mode=excluded.mode, consumed=0', (value['order_ref'], value['mode']))
                return self.reply(200, {'configured': True})
            if self.path != '/orders':
                return self.reply(404, {'error': 'Not found'})
            if set(value) != {'order_ref', 'sku', 'quantity'} or not isinstance(value['order_ref'], str) or not value['order_ref'] or not isinstance(value['sku'], str) or not value['sku'] or type(value['quantity']) is not int or value['quantity'] <= 0:
                return self.reply(422, {'error': 'Expected order_ref, sku and positive integer quantity'})
            payload = json.dumps(value, sort_keys=True, separators=(',', ':'))
            key = self.headers.get('Idempotency-Key') or None
            drop = False
            with connect() as db:
                db.execute('BEGIN IMMEDIATE')
                previous = db.execute('SELECT * FROM supplier_orders WHERE idempotency_key = ?', (key,)).fetchone() if key else None
                if previous:
                    if previous['payload'] != payload:
                        return self.reply(409, {'error': 'Idempotency key reused with different payload'})
                    return self.reply(200, {'supplier_order_id': previous['supplier_order_id'], 'order_ref': value['order_ref']})
                fault = db.execute('SELECT * FROM faults WHERE order_ref = ?', (value['order_ref'],)).fetchone()
                mode = fault['mode'] if fault else 'normal'
                if mode == 'unavailable':
                    return self.reply(503, {'error': 'Supplier temporarily unavailable'})
                if mode == 'reject':
                    return self.reply(422, {'error': 'Supplier rejected this order'})
                supplier_id = 'SUP-' + uuid.uuid4().hex[:12]
                db.execute('INSERT INTO supplier_orders VALUES (?, ?, ?, ?)', (supplier_id, key, value['order_ref'], payload))
                if mode == 'accept_then_disconnect_once' and not fault['consumed']:
                    drop = True
                    db.execute('UPDATE faults SET consumed=1 WHERE order_ref=?', (value['order_ref'],))
            if drop:
                self.close_connection = True
                try:
                    self.connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                self.connection.close()
                return
            return self.reply(201, {'supplier_order_id': supplier_id, 'order_ref': value['order_ref']})
        except (ValueError, KeyError, TypeError) as exc:
            return self.reply(400, {'error': str(exc)})

if __name__ == '__main__':
    server = ThreadingHTTPServer(('0.0.0.0', int(os.environ.get('PORT', '4001'))), Handler)
    print('Supplier fixture ready', flush=True)
    server.serve_forever()
