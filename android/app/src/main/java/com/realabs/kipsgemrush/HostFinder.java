package com.realabs.kipsgemrush;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Finds the party hosts on the network, so nobody types an address: it
 * broadcasts "JAZZO?" on UDP {@link #PORT} and every host there (a phone's
 * PartyServer, a computer's serve.py --lan) answers with its web port and
 * its open games. A search takes about a second and a half; the page asks
 * for what has been found so far while it runs.
 */
final class HostFinder {
    /** The UDP port hosts listen on for the search (serve.py: DISCOVERY_PORT). */
    static final int PORT = 8870;
    static final byte[] QUESTION = "JAZZO?1".getBytes(StandardCharsets.US_ASCII);
    private static final int SEARCH_MS = 1500;

    private final Map<String, JSONObject> hosts = new LinkedHashMap<>();   // address -> host; guarded by itself
    private volatile boolean searching;

    /** Start a search (one at a time; a second call while one runs joins it). */
    void start() {
        synchronized (hosts) {
            if (searching) return;
            searching = true;
            hosts.clear();
        }
        Thread t = new Thread(this::search, "host-finder");
        t.setDaemon(true);
        t.start();
    }

    /** {"done": bool, "hosts": [{"address": "ip:port", "name": "...", "rooms": [...]}]}. */
    String found() {
        JSONObject out = new JSONObject();
        try {
            JSONArray list = new JSONArray();
            synchronized (hosts) {
                for (JSONObject h : hosts.values()) list.put(h);
                out.put("done", !searching);
            }
            out.put("hosts", list);
        } catch (JSONException ignored) {
            // plain values
        }
        return out.toString();
    }

    /** Everywhere a broadcast can go: the whole-network address and each interface's own. */
    private static Set<InetAddress> targets() {
        Set<InetAddress> out = new LinkedHashSet<>();
        try {
            out.add(InetAddress.getByName("255.255.255.255"));
            for (NetworkInterface nic : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!nic.isUp() || nic.isLoopback()) continue;
                for (InterfaceAddress a : nic.getInterfaceAddresses()) {
                    if (a.getBroadcast() != null) out.add(a.getBroadcast());
                }
            }
        } catch (IOException | RuntimeException ignored) {
            // No list of interfaces: the whole-network address alone.
        }
        return out;
    }

    private void search() {
        try (DatagramSocket socket = new DatagramSocket()) {
            socket.setBroadcast(true);
            socket.setSoTimeout(200);
            List<InetAddress> targets = new ArrayList<>(targets());
            long start = System.currentTimeMillis();
            long asked = -1000;
            byte[] buf = new byte[32 * 1024];
            while (System.currentTimeMillis() - start < SEARCH_MS) {
                // Ask twice, half a second apart: a broadcast can get lost.
                long now = System.currentTimeMillis();
                if (now - asked >= 500) {
                    asked = now;
                    for (InetAddress to : targets) {
                        try { socket.send(new DatagramPacket(QUESTION, QUESTION.length, to, PORT)); } catch (IOException ignored) { /* that way is closed */ }
                    }
                }
                DatagramPacket in = new DatagramPacket(buf, buf.length);
                try {
                    socket.receive(in);
                } catch (SocketTimeoutException quiet) {
                    continue;
                }
                try {
                    JSONObject reply = new JSONObject(new String(in.getData(), in.getOffset(), in.getLength(), StandardCharsets.UTF_8));
                    int port = reply.optInt("port", 0);
                    if (reply.optInt("jazzo", 0) != 1 || port <= 0 || port > 65535) continue;
                    String address = in.getAddress().getHostAddress() + ":" + port;
                    JSONObject host = new JSONObject().put("address", address).put("name", reply.optString("name", ""))
                            .put("rooms", reply.optJSONArray("rooms") != null ? reply.optJSONArray("rooms") : new JSONArray());
                    synchronized (hosts) { hosts.put(address, host); }
                } catch (JSONException ignored) {
                    // Not an answer of ours.
                }
            }
        } catch (IOException | RuntimeException ignored) {
            // No network to search.
        } finally {
            searching = false;
        }
    }
}
