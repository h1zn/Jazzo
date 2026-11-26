package com.realabs.kipsgemrush;

import android.content.res.AssetManager;
import android.util.Base64;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Random;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * serve.py for the phone: when this device hosts a party game it serves the
 * game to browsers on the network (so a computer can join by opening this
 * device's address) and relays party messages over a WebSocket at /ws, the
 * same protocol as serve.py: a host makes a room and gets a 4-letter code, up
 * to four more players join it, and every message from one player goes to
 * the others marked with the sender's slot (1-5; the host is 1).
 */
final class PartyServer {
    private static final String TAG = "KipsGemRush";
    private static final String WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    private static final int MAX_FRAME = 64 * 1024;     // party messages are small
    private static final int MAX_HEADER = 16 * 1024;
    // A player who has stopped taking messages (out of Wi-Fi range, the app
    // put away) is dropped once this much is waiting for them, rather than
    // holding everyone else up: about ten seconds of a full game.
    private static final int MAX_WAITING = 1500;            // messages
    private static final int MAX_WAITING_BYTES = 512 * 1024;
    // A guest who drops out of a game in play (their Wi-Fi blinked, the app
    // was put away) keeps their place for this long, and what the others
    // send meanwhile is kept for their return (as in serve.py).
    private static final int REJOIN_SECONDS = 60;
    private static final int MAX_MISSED = 3000;             // messages kept for a player who is away
    private static final int MAX_MISSED_BYTES = 256 * 1024;
    // Not worth keeping: where everyone was, and shots long since landed.
    private static final java.util.Set<String> PASSING = new java.util.HashSet<>(java.util.Arrays.asList("s", "shot", "ishot", "zap", "boom"));
    // In a game in play, a guest heard nothing from for this long has lost
    // their connection (the game asks "ping" every two seconds).
    private static final int SILENT_MS = 10_000;
    // Room-code letters: no I/O (look like 1/0) and no M/P (as in serve.py).
    private static final String CODE_LETTERS = "ABCDEFGHJKLNQRSTUVWXYZ";
    private static final int MAX_PLAYERS = 5;
    static final int DEFAULT_PORT = 8870;

    private static final class Player {
        Conn conn;                  // null while away
        final String name;
        final String key;           // lets this player, and nobody else, back into their place ("": the host)
        long away;                  // when they dropped out (0: here)
        final List<String> missed = new ArrayList<>();
        int missedBytes;

        Player(Conn conn, String name, String key) { this.conn = conn; this.name = name; this.key = key; }
    }

    private static final class Room {
        final TreeMap<Integer, Player> players = new TreeMap<>();
        String title = "";
        String password = "";
        boolean playing;
        Object mode = "treasure";
    }

    private final AssetManager assets;
    private final Map<String, Room> rooms = new HashMap<>();   // guarded by itself
    private final Random random = new Random();
    private final ExecutorService pool = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "party-conn");
        t.setDaemon(true);
        return t;
    });
    private final ScheduledExecutorService timers = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "party-timers");
        t.setDaemon(true);
        return t;
    });
    private final java.security.SecureRandom secure = new java.security.SecureRandom();
    private ServerSocket listener;
    private java.net.DatagramSocket beacon;
    private volatile boolean running;

    PartyServer(AssetManager assets) {
        this.assets = assets;
    }

    /** Listen on the usual port, or the next free one after it. */
    void start() throws IOException {
        IOException last = null;
        for (int port = DEFAULT_PORT; port < DEFAULT_PORT + 20; port++) {
            try {
                ServerSocket s = new ServerSocket();
                s.setReuseAddress(true);
                s.bind(new InetSocketAddress(port), 128);
                listener = s;
                break;
            } catch (IOException e) {
                last = e;
            }
        }
        if (listener == null) throw last != null ? last : new IOException("No free port");
        running = true;
        Thread t = new Thread(this::acceptLoop, "party-accept");
        t.setDaemon(true);
        t.start();
        Thread b = new Thread(this::answerSearches, "party-beacon");
        b.setDaemon(true);
        b.start();
    }

    /**
     * Answers the search other phones make for hosts (HostFinder): a "JAZZO?"
     * broadcast on UDP gets this server's port and its open games back, so
     * they list this host without anyone typing its address.
     */
    private void answerSearches() {
        try {
            java.net.DatagramSocket s = new java.net.DatagramSocket(null);
            s.setReuseAddress(true);
            s.setBroadcast(true);
            s.bind(new InetSocketAddress(HostFinder.PORT));
            beacon = s;
        } catch (IOException | RuntimeException e) {
            Log.w(TAG, "No answering searches (UDP " + HostFinder.PORT + "): " + e.getMessage());
            return;
        }
        byte[] buf = new byte[256];
        // A search asks twice; nobody needs more than a few answers a second
        // (and a question with a forged sender can't be used to flood them).
        Map<String, int[]> recent = new HashMap<>();        // sender -> { answers this second, the second }
        while (running) {
            try {
                java.net.DatagramPacket in = new java.net.DatagramPacket(buf, buf.length);
                beacon.receive(in);
                String asked = new String(in.getData(), in.getOffset(), in.getLength(), StandardCharsets.US_ASCII);
                if (!asked.startsWith("JAZZO?")) continue;
                int now = (int) (System.nanoTime() / 1_000_000_000L);
                if (recent.size() > 256) recent.clear();
                String who = in.getAddress().getHostAddress();
                int[] count = recent.get(who);
                if (count == null || count[1] != now) { count = new int[] { 0, now }; recent.put(who, count); }
                if (++count[0] > 6) continue;
                JSONArray listing = new JSONArray();
                synchronized (rooms) {
                    for (Map.Entry<String, Room> e : rooms.entrySet()) {
                        if (listing.length() < 12) listing.put(roomInfo(e.getKey(), e.getValue()));
                    }
                }
                byte[] reply = new JSONObject().put("jazzo", 1).put("port", port()).put("name", clean(android.os.Build.MODEL, 24))
                        .put("rooms", listing).toString().getBytes(StandardCharsets.UTF_8);
                beacon.send(new java.net.DatagramPacket(reply, reply.length, in.getAddress(), in.getPort()));
            } catch (IOException | JSONException e) {
                if (!running) break;
            } catch (RuntimeException e) {
                break;
            }
        }
    }

    void stop() {
        running = false;
        try { if (listener != null) listener.close(); } catch (IOException ignored) { /* closing */ }
        if (beacon != null) beacon.close();
        timers.shutdownNow();
        pool.shutdownNow();
    }

    int port() {
        return listener.getLocalPort();
    }

    /** This device's addresses on the network, as the URLs friends open. */
    List<String> lanAddresses() {
        TreeSet<String> found = new TreeSet<>();
        try {
            for (NetworkInterface nic : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!nic.isUp() || nic.isLoopback()) continue;
                for (InetAddress a : Collections.list(nic.getInetAddresses())) {
                    if (a instanceof Inet4Address && !a.isLoopbackAddress()) found.add(a.getHostAddress());
                }
            }
        } catch (SocketException | RuntimeException ignored) {
            // No list: the host's lobby just doesn't show an address.
        }
        List<String> urls = new ArrayList<>();
        for (String ip : found) urls.add("http://" + ip + ":" + port() + "/");
        return urls;
    }

    private void acceptLoop() {
        while (running) {
            try {
                Socket socket = listener.accept();
                pool.execute(() -> serve(socket));
            } catch (IOException e) {
                if (running) Log.w(TAG, "Party server accept: " + e.getMessage());
            } catch (RuntimeException e) {
                break;      // the pool has shut down
            }
        }
    }

    // ------------------------------------------------------------ http

    private void serve(Socket socket) {
        try (Socket s = socket) {
            s.setTcpNoDelay(true);
            InputStream in = new BufferedInputStream(s.getInputStream());
            OutputStream out = new BufferedOutputStream(s.getOutputStream());
            String head = readHead(in);
            if (head == null) return;
            String[] lines = head.split("\r\n");
            String[] request = lines[0].split(" ");
            if (request.length < 2) return;
            Map<String, String> headers = new HashMap<>();
            for (int i = 1; i < lines.length; i++) {
                int colon = lines[i].indexOf(':');
                if (colon > 0) headers.put(lines[i].substring(0, colon).trim().toLowerCase(Locale.ROOT), lines[i].substring(colon + 1).trim());
            }
            String method = request[0];
            String target = request[1];
            int q = target.indexOf('?');
            String path = q < 0 ? target : target.substring(0, q);
            if (path.equals("/ws") && "websocket".equalsIgnoreCase(headers.get("upgrade"))) {
                relay(new Conn(s, in, out), headers.get("sec-websocket-key"));
                return;
            }
            if (!method.equals("GET") && !method.equals("HEAD")) {
                respond(out, "405 Method Not Allowed", "text/plain", "Method not allowed".getBytes(StandardCharsets.UTF_8), true);
                return;
            }
            sendFile(out, path, method.equals("GET"));
        } catch (IOException | RuntimeException e) {
            // A browser that went away mid-request.
        }
    }

    /** The request line and headers (up to the blank line), or null. */
    private static String readHead(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        int state = 0;      // how much of \r\n\r\n has been seen
        while (buf.size() < MAX_HEADER) {
            int b = in.read();
            if (b < 0) return null;
            buf.write(b);
            if (b == '\r') state = state == 2 ? 3 : 1;
            else if (b == '\n') state = state == 1 ? 2 : state == 3 ? 4 : 0;
            else state = 0;
            if (state == 4) return new String(buf.toByteArray(), StandardCharsets.ISO_8859_1);
        }
        return null;
    }

    private static void respond(OutputStream out, String status, String type, byte[] body, boolean withBody) throws IOException {
        String head = "HTTP/1.1 " + status + "\r\nContent-Type: " + type + "\r\nContent-Length: " + body.length
                + "\r\nCache-Control: no-store, must-revalidate\r\nConnection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.ISO_8859_1));
        if (withBody) out.write(body);
        out.flush();
    }

    private void sendFile(OutputStream out, String urlPath, boolean withBody) throws IOException {
        String decoded;
        try {
            // Only percent-escapes: a + in a file name stays a +.
            decoded = java.net.URLDecoder.decode(urlPath.replace("+", "%2B"), "UTF-8");
        } catch (IllegalArgumentException e) {
            decoded = null;
        }
        String path = MainActivity.assetPath(decoded);
        InputStream file = null;
        if (path != null) {
            try { file = MainActivity.openAsset(assets, path); } catch (IOException e) { file = null; }
        }
        if (file == null) {
            respond(out, "404 Not Found", "text/plain", "Not found".getBytes(StandardCharsets.UTF_8), withBody);
            return;
        }
        try (InputStream f = file) {
            String mime = MainActivity.mimeOf(path);
            if (MainActivity.isText(mime)) mime += "; charset=utf-8";
            String head = "HTTP/1.1 200 OK\r\nContent-Type: " + mime + "\r\nContent-Length: " + f.available()
                    + "\r\nCache-Control: no-store, must-revalidate\r\nConnection: close\r\n\r\n";
            out.write(head.getBytes(StandardCharsets.ISO_8859_1));
            if (withBody) {
                byte[] chunk = new byte[64 * 1024];
                int n;
                while ((n = f.read(chunk)) > 0) out.write(chunk, 0, n);
            }
            out.flush();
        }
    }

    // ------------------------------------------------------------ websocket

    /** A minimal server-side WebSocket (RFC 6455): text frames, ping, close. */
    private static final class Conn {
        private final Socket socket;
        private final InputStream in;
        private final OutputStream out;
        // What is waiting to go out. Each connection writes from its own
        // thread, so one player's slow or dead connection never blocks the
        // thread relaying another player's messages.
        private final LinkedBlockingQueue<byte[]> outbox = new LinkedBlockingQueue<>();
        private final AtomicInteger waiting = new AtomicInteger();
        volatile boolean closed;

        Conn(Socket socket, InputStream in, OutputStream out) { this.socket = socket; this.in = in; this.out = out; }

        /** Send what is queued, in order, until the connection ends. */
        void writeLoop() {
            try {
                while (!closed) {
                    byte[] frame = outbox.poll(1, TimeUnit.SECONDS);
                    if (frame == null) continue;
                    do {
                        waiting.addAndGet(-frame.length);
                        out.write(frame);
                    } while ((frame = outbox.poll()) != null);
                    out.flush();
                }
            } catch (IOException | InterruptedException | RuntimeException e) {
                // The other end has gone.
            } finally {
                close();
            }
        }

        /** End the connection: the reader (blocked in recv) wakes up and tidies the room. */
        void close() {
            closed = true;
            outbox.clear();
            try { socket.close(); } catch (IOException ignored) { /* closing */ }
        }

        private byte[] readExact(int n) throws IOException {
            byte[] buf = new byte[n];
            int got = 0;
            while (got < n) {
                int k = in.read(buf, got, n - got);
                if (k < 0) return null;
                got += k;
            }
            return buf;
        }

        /** The next text message, or null when the connection has ended. */
        String recv() throws IOException {
            while (true) {
                byte[] head = readExact(2);
                if (head == null) return null;
                int opcode = head[0] & 0x0F;
                long length = head[1] & 0x7F;
                if (length == 126) {
                    byte[] ext = readExact(2);
                    if (ext == null) return null;
                    length = ((ext[0] & 0xFF) << 8) | (ext[1] & 0xFF);
                } else if (length == 127) {
                    byte[] ext = readExact(8);
                    if (ext == null) return null;
                    length = 0;
                    for (byte b : ext) length = (length << 8) | (b & 0xFF);
                }
                if (length < 0 || length > MAX_FRAME) return null;
                byte[] mask = (head[1] & 0x80) != 0 ? readExact(4) : new byte[4];
                byte[] data = readExact((int) length);
                if (mask == null || data == null) return null;
                for (int i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
                if (opcode == 8) return null;
                if (opcode == 9) { send(data, 10); continue; }
                if (opcode == 1) return new String(data, StandardCharsets.UTF_8);
            }
        }

        void send(String text) {
            send(text.getBytes(StandardCharsets.UTF_8), 1);
        }

        void send(byte[] payload, int opcode) {
            if (closed) return;
            int n = payload.length;
            ByteArrayOutputStream frame = new ByteArrayOutputStream(n + 10);
            frame.write(0x80 | opcode);
            if (n < 126) {
                frame.write(n);
            } else if (n < 65536) {
                frame.write(126);
                frame.write(n >> 8);
                frame.write(n & 0xFF);
            } else {
                frame.write(127);
                for (int shift = 56; shift >= 0; shift -= 8) frame.write((int) (((long) n >> shift) & 0xFF));
            }
            frame.write(payload, 0, n);
            byte[] bytes = frame.toByteArray();
            // Too far behind to ever catch up: let them go.
            if (outbox.size() >= MAX_WAITING || waiting.addAndGet(bytes.length) > MAX_WAITING_BYTES) { close(); return; }
            outbox.add(bytes);
        }
    }

    private static String clean(Object text, int limit) {
        if (text == null || text == JSONObject.NULL) return "";
        StringBuilder sb = new StringBuilder();
        String s = String.valueOf(text);
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            if (!Character.isISOControl(ch)) sb.append(ch);
        }
        String out = sb.toString();
        if (out.length() > limit) out = out.substring(0, limit);
        return out.trim();
    }

    private static JSONArray roster(Room room) throws JSONException {
        JSONArray list = new JSONArray();
        for (Map.Entry<Integer, Player> e : room.players.entrySet()) {
            list.put(new JSONObject().put("id", e.getKey()).put("name", e.getValue().name));
        }
        return list;
    }

    private static JSONObject roomInfo(String code, Room room) throws JSONException {
        return new JSONObject().put("code", code).put("title", room.title).put("players", room.players.size())
                .put("max", MAX_PLAYERS).put("locked", !room.password.isEmpty()).put("playing", room.playing).put("mode", room.mode);
    }

    private String newCode() {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 4; i++) sb.append(CODE_LETTERS.charAt(random.nextInt(CODE_LETTERS.length())));
        return sb.toString();
    }

    private String newKey() {
        byte[] bytes = new byte[8];
        secure.nextBytes(bytes);
        StringBuilder sb = new StringBuilder();
        for (byte b : bytes) sb.append(String.format(Locale.ROOT, "%02x", b & 0xFF));
        return sb.toString();
    }

    /** A short notice about one player: {"t": kind, "id": slot} (and "closed" for a leaver). */
    private static String note(String kind, int slot) {
        try {
            JSONObject o = new JSONObject().put("t", kind).put("id", slot);
            if (kind.equals("left")) o.put("closed", slot == 1);
            return o.toString();
        } catch (JSONException e) {
            return "{}";
        }
    }

    /**
     * Send `text` to the room's players (all but `skip`; `to` above 0: only
     * that one, below 0: nobody). For one who is away it is kept for their
     * return; with too much kept, they are out. Call holding `rooms`.
     */
    private void tell(String code, Room room, String text, String kind, int skip, int to) {
        for (Map.Entry<Integer, Player> e : new ArrayList<>(room.players.entrySet())) {
            int slot = e.getKey();
            Player p = e.getValue();
            if (slot == skip || (to != 0 && to != slot)) continue;
            if (p.conn != null) {
                p.conn.send(text);
            } else if (!PASSING.contains(kind)) {
                p.missed.add(text);
                p.missedBytes += text.length();
                if (p.missed.size() > MAX_MISSED || p.missedBytes > MAX_MISSED_BYTES) remove(code, slot);
            }
        }
    }

    /**
     * A player is out of the room for good: the others are told, and the
     * host going ends the room. Call holding `rooms`.
     */
    private void remove(String code, int slot) {
        Room room = rooms.get(code);
        if (room == null || !room.players.containsKey(slot)) return;
        room.players.remove(slot);
        if (slot == 1 || room.players.isEmpty()) rooms.remove(code);
        tell(code, room, note("left", slot), "left", 0, 0);
    }

    private void relay(Conn ws, String key) throws IOException {
        String accept;
        try {
            MessageDigest sha = MessageDigest.getInstance("SHA-1");
            accept = Base64.encodeToString(sha.digest(((key == null ? "" : key) + WS_GUID).getBytes(StandardCharsets.ISO_8859_1)), Base64.NO_WRAP);
        } catch (java.security.NoSuchAlgorithmException e) {
            return;
        }
        ws.out.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "
                + accept + "\r\n\r\n").getBytes(StandardCharsets.ISO_8859_1));
        ws.out.flush();
        try {
            pool.execute(ws::writeLoop);
        } catch (RuntimeException e) {
            return;         // the server is stopping
        }
        String code = null;
        int slot = 0;
        boolean timed = false;      // the silence limit is on (see SILENT_MS)
        try {
            while (true) {
                String text;
                try {
                    text = ws.recv();
                } catch (IOException e) {
                    break;          // gone, or silent for too long
                }
                if (text == null) break;
                JSONObject msg;
                try {
                    msg = new JSONObject(text);
                } catch (JSONException e) {
                    continue;
                }
                try {
                    String kind = msg.optString("t", "");
                    if (kind.equals("ping")) {
                        // "Are you there?": answered here, not passed on. A
                        // guest in a game in play who stops asking has lost
                        // their connection, and is noticed within seconds.
                        ws.send("{\"t\":\"pong\"}");
                        if (!timed && code != null && slot != 1) {
                            boolean playing;
                            synchronized (rooms) {
                                Room room = rooms.get(code);
                                playing = room != null && room.playing;
                            }
                            if (playing) {
                                try { ws.socket.setSoTimeout(SILENT_MS); } catch (SocketException ignored) { /* closing */ }
                                timed = true;
                            }
                        }
                    } else if (kind.equals("rooms")) {
                        JSONArray listing = new JSONArray();
                        synchronized (rooms) {
                            for (Map.Entry<String, Room> e : rooms.entrySet()) listing.put(roomInfo(e.getKey(), e.getValue()));
                        }
                        ws.send(new JSONObject().put("t", "rooms").put("list", listing).toString());
                    } else if (kind.equals("host") && code == null) {
                        String name = clean(msg.opt("name"), 12);
                        if (name.isEmpty()) name = "PLAYER 1";
                        JSONArray players;
                        synchronized (rooms) {
                            code = newCode();
                            while (rooms.containsKey(code)) code = newCode();
                            Room room = new Room();
                            room.players.put(1, new Player(ws, name, ""));
                            room.title = clean(msg.opt("title"), 24);
                            if (room.title.isEmpty()) room.title = name + "'s game";
                            room.password = clean(msg.opt("password"), 12);
                            if (msg.has("mode") && !msg.isNull("mode")) room.mode = msg.get("mode");
                            rooms.put(code, room);
                            players = roster(room);
                        }
                        slot = 1;
                        ws.send(new JSONObject().put("t", "hosted").put("code", code).put("id", 1).put("players", players)
                                .put("urls", new JSONArray(lanAddresses())).toString());
                    } else if (kind.equals("join") && code == null) {
                        String want = msg.optString("code", "").toUpperCase(Locale.ROOT);
                        String why = null;
                        synchronized (rooms) {
                            Room room = rooms.get(want);
                            if (room == null) why = "No room with that code.";
                            else if (!room.password.isEmpty() && !clean(msg.opt("password"), 12).equals(room.password)) why = "Wrong password.";
                            else if (room.playing) why = "That game has already started.";
                            else if (room.players.size() >= MAX_PLAYERS) why = "That room is full.";
                            else {
                                int got = 0;
                                for (int i = 2; i <= MAX_PLAYERS; i++) {
                                    if (!room.players.containsKey(i)) { got = i; break; }
                                }
                                String name = clean(msg.opt("name"), 12);
                                if (name.isEmpty()) name = "PLAYER " + got;
                                String mine = newKey();
                                room.players.put(got, new Player(ws, name, mine));
                                JSONArray players = roster(room);
                                slot = got;
                                code = want;
                                ws.send(new JSONObject().put("t", "joined").put("code", code).put("id", slot).put("players", players).put("key", mine).toString());
                                tell(code, room, new JSONObject().put("t", "peer").put("id", slot).put("name", name).put("players", players).toString(), "peer", slot, 0);
                            }
                        }
                        if (why != null) ws.send(new JSONObject().put("t", "error").put("why", why).toString());
                    } else if (kind.equals("rejoin") && code == null) {
                        // Back after a lost connection: the same place, and
                        // everything missed meanwhile, in order.
                        String want = msg.optString("code", "").toUpperCase(Locale.ROOT);
                        int who = msg.optInt("id", 0);
                        Conn old = null;
                        synchronized (rooms) {
                            Room room = rooms.get(want);
                            Player p = room == null ? null : room.players.get(who);
                            if (p == null || who == 1 || p.key.isEmpty() || !p.key.equals(msg.optString("key", ""))) {
                                ws.send(new JSONObject().put("t", "error").put("why", "That game is over.").put("gone", true).toString());
                            } else {
                                old = p.conn;
                                JSONArray missed = new JSONArray();
                                for (String m : p.missed) missed.put(new JSONObject(m));
                                p.conn = ws;
                                p.away = 0;
                                p.missed.clear();
                                p.missedBytes = 0;
                                code = want;
                                slot = who;
                                ws.send(new JSONObject().put("t", "rejoined").put("code", code).put("id", slot).put("players", roster(room))
                                        .put("missed", missed).toString());
                                tell(code, room, note("returned", slot), "returned", slot, 0);
                            }
                        }
                        if (old != null) old.close();       // the old connection, not yet known to be dead
                    } else if (code != null && kind.equals("password")) {
                        // The host locks (or opens) the room.
                        if (slot == 1) {
                            synchronized (rooms) {
                                Room room = rooms.get(code);
                                if (room != null) room.password = clean(msg.opt("password"), 12);
                            }
                        }
                    } else if (code != null) {
                        // Everything else goes to the room, marked with the
                        // sender; `to` sends it to one player only.
                        msg.put("from", slot);
                        synchronized (rooms) {
                            Room room = rooms.get(code);
                            if (room != null) {
                                if (slot == 1 && (kind.equals("start") || kind.equals("lobby") || kind.equals("settings"))) {
                                    room.playing = kind.equals("start");
                                    if (msg.has("mode") && !msg.isNull("mode") && !"".equals(msg.opt("mode"))) room.mode = msg.get("mode");
                                }
                                Player me = room.players.get(slot);
                                if (me != null && me.conn == ws) {
                                    boolean all = !msg.has("to") || msg.isNull("to");
                                    int to = msg.optInt("to", -1);
                                    tell(code, room, msg.toString(), kind, slot, all ? 0 : to > 0 ? to : -1);
                                }
                            }
                        }
                    }
                } catch (JSONException e) {
                    // A message we can't make sense of: skip it.
                }
            }
        } finally {
            ws.close();
            if (code != null) {
                final String room0 = code;
                final int slot0 = slot;
                synchronized (rooms) {
                    Room room = rooms.get(code);
                    Player p = room == null ? null : room.players.get(slot);
                    // (Not if this connection was replaced by the player coming back.)
                    if (p != null && p.conn == ws) {
                        if (slot != 1 && room.playing && !p.key.isEmpty()) {
                            // A guest dropped out of a game in play: their place waits.
                            p.conn = null;
                            p.away = System.nanoTime();
                            p.missed.clear();
                            p.missedBytes = 0;
                            tell(code, room, note("away", slot), "away", slot, 0);
                            final long since = p.away;
                            try {
                                timers.schedule(() -> {
                                    // The time to come back is up.
                                    synchronized (rooms) {
                                        Room r = rooms.get(room0);
                                        Player q = r == null ? null : r.players.get(slot0);
                                        if (q != null && q.conn == null && q.away == since) remove(room0, slot0);
                                    }
                                }, REJOIN_SECONDS, TimeUnit.SECONDS);
                            } catch (RuntimeException e) {
                                remove(code, slot);     // the server is stopping
                            }
                        } else {
                            remove(code, slot);
                        }
                    }
                }
            }
        }
    }
}
