"""Web server for the game, plus the party-mode relay.

Serves this folder with caching disabled (so edits to JavaScript modules always
load fresh) and relays party-mode messages over a WebSocket at /ws: a host
creates a room and gets a 4-letter code, up to four more players join with it
(or pick it from the room list), and every message from one player goes to
the others, marked with the sender's slot (1-5; the host is 1).

    python serve.py [port]           this computer only (127.0.0.1)
    python serve.py [port] --lan     reachable from other computers on your network
    python serve.py --public         the same, on all interfaces, for a server on
                                     the internet (the port can also come from $PORT)

Standard library only.
"""

import base64
import functools
import hashlib
import http.server
import json
import os
import queue
import random
import secrets
import socket
import struct
import sys
import threading
import time
import zipfile

WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
MUSIC = ('.j2b', '.it', '.mod', '.s3m', '.xm', '.ogg', '.mp3', '.mo3')
LIBRARY = MUSIC + ('.j2v',)   # music and cinematics: other packs borrow them
MAX_FRAME = 64 * 1024  # party messages are small; anything bigger ends the connection
# Room-code letters: no I/O (look like 1/0) and no M/P (the game's mute and
# pause keys, which players type while entering a code).
CODE_LETTERS = 'ABCDEFGHJKLNQRSTUVWXYZ'
MAX_PLAYERS = 5
# Hosts answer a "JAZZO?" broadcast on this UDP port with their web port and
# open games, so the Android app lists them without an address being typed.
DISCOVERY_PORT = 8870
# A guest who drops out of a game in play (their Wi-Fi blinked, the app was
# put away) keeps their place for this long, and what the others send
# meanwhile is kept for their return.
REJOIN_SECONDS = 60
MAX_MISSED = 3000               # messages kept for a player who is away
MAX_MISSED_BYTES = 256 * 1024
# Not worth keeping: where everyone was, and shots long since landed.
PASSING = ('s', 'shot', 'ishot', 'zap', 'boom')
# A player who has stopped taking messages is dropped once this much is
# waiting for them, rather than holding everyone else up.
MAX_WAITING = 1500              # messages
MAX_WAITING_BYTES = 512 * 1024
# In a game in play, a guest heard nothing from for this long has lost their
# connection (the game asks "ping" every two seconds).
SILENT_SECONDS = 10
# code -> {'players': {slot: player}, 'title', 'password', 'playing', 'mode'}
# player: {'conn' (None while away), 'name', 'key', 'away', 'missed', 'bytes'}
rooms = {}
rooms_lock = threading.RLock()


def room_info(code, room):
    """What the room list shows about a room."""
    return {'code': code, 'title': room['title'], 'players': len(room['players']), 'max': MAX_PLAYERS,
            'locked': bool(room['password']), 'playing': room['playing'], 'mode': room['mode']}


def roster(room):
    return [{'id': slot, 'name': p['name']} for slot, p in sorted(room['players'].items())]


def player(conn, name, key=''):
    return {'conn': conn, 'name': name, 'key': key, 'away': None, 'missed': [], 'bytes': 0}


def tell(code, room, text, kind, skip=None, to=None):
    """Send `text` to the room's players (all but `skip`, or only `to`). For
    one who is away it is kept for their return; with too much kept, they
    are out. Call with rooms_lock held."""
    for slot, p in list(room['players'].items()):
        if slot == skip or (to is not None and to != slot):
            continue
        if p['conn'] is not None:
            p['conn'].send(text)
        elif kind not in PASSING:
            p['missed'].append(text)
            p['bytes'] += len(text)
            if len(p['missed']) > MAX_MISSED or p['bytes'] > MAX_MISSED_BYTES:
                remove(code, slot)


def remove(code, slot):
    """A player is out of the room for good: the others are told, and the
    host going ends the room. Call with rooms_lock held."""
    room = rooms.get(code)
    if not room or slot not in room['players']:
        return
    del room['players'][slot]
    if slot == 1 or not room['players']:
        rooms.pop(code, None)
    tell(code, room, json.dumps({'t': 'left', 'id': slot, 'closed': slot == 1}), 'left')


def expire(code, slot, since):
    """The time to come back is up."""
    with rooms_lock:
        room = rooms.get(code)
        p = room and room['players'].get(slot)
        if p and p['conn'] is None and p['away'] == since:
            remove(code, slot)


def clean(text, limit):
    return ''.join(ch for ch in str(text or '') if ch.isprintable())[:limit].strip()


def lan_addresses(port):
    """Best-effort list of this machine's LAN URLs, shown to the host."""
    found = set()
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(('10.255.255.255', 1))
            found.add(s.getsockname()[0])
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            found.add(info[4][0])
    except OSError:
        pass
    return [f'http://{ip}:{port}/' for ip in sorted(found) if not ip.startswith('127.')]


def discovery(port):
    """Answer the Android app's search for hosts on the network (UDP)."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(('', DISCOVERY_PORT))
    except OSError as e:
        print(f'Phones will not find this host by themselves (UDP {DISCOVERY_PORT}: {e}); they can type its address.')
        return
    name = clean(socket.gethostname(), 24)
    # A search asks twice; nobody needs more than a few answers a second. The
    # limit keeps this from being used to flood someone else with answers
    # (a question with a forged sender).
    recent = {}     # sender's address -> [answers this second, the second]
    while True:
        try:
            data, addr = s.recvfrom(256)
            if not data.startswith(b'JAZZO?'):
                continue
            now = int(time.monotonic())
            if len(recent) > 256:
                recent.clear()
            count = recent.get(addr[0])
            if count is None or count[1] != now:
                count = recent[addr[0]] = [0, now]
            count[0] += 1
            if count[0] > 6:
                continue
            with rooms_lock:
                listing = [room_info(c, r) for c, r in rooms.items()]
            s.sendto(json.dumps({'jazzo': 1, 'port': port, 'name': name, 'rooms': listing[:12]}).encode(), addr)
        except OSError:
            continue


class WebSocket:
    """A minimal server-side WebSocket (RFC 6455): text frames, ping, close.
    Messages go out from the connection's own thread (see writer), so one
    player's slow or dead connection never holds up the thread relaying
    another player's messages."""

    def __init__(self, rfile, wfile, sock=None):
        self.rfile, self.wfile, self.sock = rfile, wfile, sock
        self.out = queue.Queue()
        self.lock = threading.Lock()
        self.waiting = 0
        self.closed = False
        self.place = None       # (room code, slot) once this connection is a player

    def read_exact(self, n):
        """Exactly n bytes, or None if the connection ended first."""
        buf = b''
        while len(buf) < n:
            chunk = self.rfile.read(n - len(buf))
            if not chunk:
                return None
            buf += chunk
        return buf

    def recv(self):
        while True:
            head = self.read_exact(2)
            if head is None:
                return None
            opcode = head[0] & 0x0F
            length = head[1] & 0x7F
            if length == 126:
                ext = self.read_exact(2)
                if ext is None:
                    return None
                length = struct.unpack('>H', ext)[0]
            elif length == 127:
                ext = self.read_exact(8)
                if ext is None:
                    return None
                length = struct.unpack('>Q', ext)[0]
            if length > MAX_FRAME:
                return None
            mask = self.read_exact(4) if head[1] & 0x80 else bytes(4)
            raw = self.read_exact(length)
            if mask is None or raw is None:
                return None
            data = bytearray(raw)
            for i in range(len(data)):
                data[i] ^= mask[i % 4]
            if opcode == 8:
                return None
            if opcode == 9:
                self.send(bytes(data), opcode=10)
                continue
            if opcode == 1:
                return data.decode('utf-8', 'replace')

    def send(self, payload, opcode=1):
        """Queue a message; it never waits on the network."""
        if isinstance(payload, str):
            payload = payload.encode('utf-8')
        n = len(payload)
        head = bytes([0x80 | opcode])
        if n < 126:
            head += bytes([n])
        elif n < 65536:
            head += bytes([126]) + struct.pack('>H', n)
        else:
            head += bytes([127]) + struct.pack('>Q', n)
        frame = head + payload
        with self.lock:
            if self.closed:
                return
            self.waiting += len(frame)
            behind = self.out.qsize() >= MAX_WAITING or self.waiting > MAX_WAITING_BYTES
        if behind:
            self.close()        # too far behind to ever catch up
        else:
            self.out.put(frame)

    def writer(self):
        """Send what is queued, in order, until the connection ends."""
        try:
            while True:
                frame = self.out.get()
                if frame is None or self.closed:
                    break
                with self.lock:
                    self.waiting -= len(frame)
                self.wfile.write(frame)
                self.wfile.flush()
        except (OSError, ValueError):
            pass
        finally:
            self.close()

    def close(self):
        """End the connection, and see to its player's place in the room.
        (Not left to the thread reading from it: on Windows a shutdown does
        not wake a read that is waiting, so a dead connection's reader may
        never get there.)"""
        with self.lock:
            if self.closed:
                return
            self.closed = True
        self.out.put(None)
        if self.sock is not None:
            try:
                self.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        over(self)


def over(ws):
    """A connection has ended: its player is away (a guest in a game in
    play, whose place waits) or out of the room."""
    with rooms_lock:
        if ws.place is None:
            return
        code, slot = ws.place
        room = rooms.get(code)
        p = room and room['players'].get(slot)
        # (Not if this connection was replaced by the player coming back.)
        if not p or p['conn'] is not ws:
            return
        if slot != 1 and room['playing'] and p['key']:
            p.update(conn=None, away=time.monotonic(), missed=[], bytes=0)
            tell(code, room, json.dumps({'t': 'away', 'id': slot}), 'away', skip=slot)
            timer = threading.Timer(REJOIN_SECONDS, expire, (code, slot, p['away']))
            timer.daemon = True
            timer.start()
        else:
            remove(code, slot)


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        if '/ws' in (self.path or ''):
            return
        super().log_message(fmt, *args)

    def do_GET(self):
        if self.path.split('?')[0] == '/ws' and self.headers.get('Upgrade', '').lower() == 'websocket':
            return self.relay()
        if self.path.split('?')[0] == '/levels.json':
            return self.level_list()
        return super().do_GET()

    def level_list(self):
        """The JJ2 level packs in Levels/: each folder's (or zip's) .j2l and .j2t files.
        A folder or zip of tile sets, music or cinematics only is a library other packs can borrow from."""
        packs = []
        root = os.path.join(self.directory, 'Levels')
        if os.path.isdir(root):
            for name in sorted(os.listdir(root)):
                folder = os.path.join(root, name)
                if name.lower().endswith('.zip') and os.path.isfile(folder):
                    # A zipped pack: the game reads the files out of the zip itself.
                    try:
                        with zipfile.ZipFile(folder) as z:
                            files = sorted({n.split('/')[-1] for n in z.namelist() if n.split('/')[-1]})
                    except (zipfile.BadZipFile, OSError):
                        continue
                    levels = [f for f in files if f.lower().endswith('.j2l') and '-mlle-data-' not in f.lower()]
                    tilesets = [f for f in files if f.lower().endswith('.j2t')]
                    if levels:
                        packs.append({'zip': name, 'levels': levels, 'files': files, 'tilesets': tilesets})
                    elif tilesets or any(f.lower().endswith(LIBRARY) for f in files):
                        # Tile sets, music or cinematics only: a library the other packs borrow from.
                        packs.append({'zip': name, 'library': True, 'levels': [], 'files': files, 'tilesets': tilesets})
                    continue
                if not os.path.isdir(folder):
                    continue
                files = sorted(os.listdir(folder))
                levels = [f for f in files if f.lower().endswith('.j2l') and '-mlle-data-' not in f.lower()]
                tilesets = [f for f in files if f.lower().endswith('.j2t')]
                if levels:
                    packs.append({'dir': name, 'levels': levels, 'files': files, 'tilesets': tilesets})
                elif tilesets or any(f.lower().endswith(LIBRARY) for f in files):
                    packs.append({'dir': name, 'library': True, 'levels': [], 'files': files, 'tilesets': tilesets})
        body = json.dumps(packs).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def relay(self):
        key = self.headers.get('Sec-WebSocket-Key', '')
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        self.send_response_only(101)
        self.send_header('Upgrade', 'websocket')
        self.send_header('Connection', 'Upgrade')
        self.send_header('Sec-WebSocket-Accept', accept)
        http.server.BaseHTTPRequestHandler.end_headers(self)
        ws = WebSocket(self.rfile, self.wfile, self.connection)
        threading.Thread(target=ws.writer, daemon=True).start()
        code, slot = None, None
        timed = False       # the silence limit is on (see SILENT_SECONDS)
        try:
            while not ws.closed:
                try:
                    text = ws.recv()
                except (OSError, ValueError):
                    break
                if text is None:
                    break
                try:
                    msg = json.loads(text)
                except ValueError:
                    continue
                if not isinstance(msg, dict):
                    continue
                kind = msg.get('t')
                if kind == 'ping':
                    # "Are you there?": answered here, not passed on. A guest
                    # in a game in play who stops asking has lost their
                    # connection, and is noticed within seconds.
                    ws.send('{"t": "pong"}')
                    if not timed and code is not None and slot != 1:
                        with rooms_lock:
                            playing = code in rooms and rooms[code]['playing']
                        if playing:
                            self.connection.settimeout(SILENT_SECONDS)
                            timed = True
                elif kind == 'rooms':
                    with rooms_lock:
                        listing = [room_info(c, r) for c, r in rooms.items()]
                    ws.send(json.dumps({'t': 'rooms', 'list': listing}))
                elif kind == 'host' and code is None:
                    name = clean(msg.get('name'), 12) or 'PLAYER 1'
                    with rooms_lock:
                        code = ''.join(random.choice(CODE_LETTERS) for _ in range(4))
                        while code in rooms:
                            code = ''.join(random.choice(CODE_LETTERS) for _ in range(4))
                        rooms[code] = {'players': {1: player(ws, name)}, 'title': clean(msg.get('title'), 24) or f"{name}'s game",
                                       'password': clean(msg.get('password'), 12), 'playing': False, 'mode': msg.get('mode', 'treasure')}
                        players = roster(rooms[code])
                        slot = 1
                        ws.place = (code, slot)
                    ws.send(json.dumps({'t': 'hosted', 'code': code, 'id': 1, 'players': players,
                                        'urls': lan_addresses(self.server.server_address[1])}))
                elif kind == 'join' and code is None:
                    want = str(msg.get('code', '')).upper()
                    why = None
                    with rooms_lock:
                        room = rooms.get(want)
                        if room is None:
                            why = 'No room with that code.'
                        elif room['password'] and clean(msg.get('password'), 12) != room['password']:
                            why = 'Wrong password.'
                        elif room['playing']:
                            why = 'That game has already started.'
                        elif len(room['players']) >= MAX_PLAYERS:
                            why = 'That room is full.'
                        else:
                            slot = next(i for i in range(2, MAX_PLAYERS + 1) if i not in room['players'])
                            name = clean(msg.get('name'), 12) or f'PLAYER {slot}'
                            # `key`: what lets this player, and nobody else, back into their place.
                            key = secrets.token_hex(8)
                            room['players'][slot] = player(ws, name, key)
                            players = roster(room)
                            code = want
                            ws.place = (code, slot)
                            ws.send(json.dumps({'t': 'joined', 'code': code, 'id': slot, 'players': players, 'key': key}))
                            tell(code, room, json.dumps({'t': 'peer', 'id': slot, 'name': name, 'players': players}), 'peer', skip=slot)
                    if why:
                        ws.send(json.dumps({'t': 'error', 'why': why}))
                        slot = None
                elif kind == 'rejoin' and code is None:
                    # Back after a lost connection: the same place, and
                    # everything missed meanwhile, in order.
                    want = str(msg.get('code', '')).upper()
                    who = msg.get('id')
                    with rooms_lock:
                        room = rooms.get(want)
                        p = room['players'].get(who) if room and isinstance(who, int) else None
                        if p is None or who == 1 or not p['key'] or msg.get('key') != p['key']:
                            ws.send(json.dumps({'t': 'error', 'why': 'That game is over.', 'gone': True}))
                        else:
                            old, missed = p['conn'], p['missed']
                            p.update(conn=ws, away=None, missed=[], bytes=0)
                            code, slot = want, who
                            ws.place = (code, slot)
                            head = json.dumps({'t': 'rejoined', 'code': code, 'id': slot, 'players': roster(room)})
                            ws.send(head[:-1] + ', "missed": [' + ', '.join(missed) + ']}')
                            tell(code, room, json.dumps({'t': 'returned', 'id': slot}), 'returned', skip=slot)
                            if old is not None:
                                old.close()     # the old connection, not yet known to be dead
                elif code is not None and kind == 'password':
                    # The host locks (or opens) the room.
                    if slot == 1:
                        with rooms_lock:
                            if code in rooms:
                                rooms[code]['password'] = clean(msg.get('password'), 12)
                elif code is not None:
                    # Everything else goes to the room, marked with the sender;
                    # `to` sends it to one player only.
                    msg['from'] = slot
                    with rooms_lock:
                        room = rooms.get(code)
                        if room and slot == 1 and kind in ('start', 'lobby', 'settings'):
                            room['playing'] = kind == 'start'
                            if msg.get('mode'):
                                room['mode'] = msg['mode']
                        if room and room['players'].get(slot, {}).get('conn') is ws:
                            tell(code, room, json.dumps(msg), kind, skip=slot, to=msg.get('to'))
        finally:
            ws.close()
            over(ws)        # (again, should the place have been taken as the connection closed)
            self.close_connection = True


class Server(http.server.ThreadingHTTPServer):
    # Five browsers loading the game at once open dozens of connections; the
    # default backlog of 5 refuses some of them.
    request_queue_size = 128
    daemon_threads = True


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    lan = '--lan' in sys.argv or '--public' in sys.argv
    port = int(args[0]) if args else int(os.environ.get('PORT', 8770))
    root = os.path.dirname(os.path.abspath(__file__))
    handler = functools.partial(Handler, directory=root)
    with Server(('0.0.0.0' if lan else '127.0.0.1', port), handler) as server:
        print(f'Serving on http://localhost:{port}/')
        if lan:
            for url in lan_addresses(port):
                print(f'Party mode: other players open {url}')
            # On a home network only: a server out on the internet (--public)
            # has no neighbours to be found by.
            if '--public' not in sys.argv:
                print('The Android app finds this host by itself (JOIN A GAME).')
                threading.Thread(target=discovery, args=(port,), daemon=True).start()
        server.serve_forever()


if __name__ == '__main__':
    main()
