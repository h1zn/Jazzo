package com.realabs.kipsgemrush;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.res.AssetManager;
import android.graphics.Color;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.util.Log;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * The whole app: a full-screen WebView showing the web game, whose files are
 * packed in the app's assets (www/) and served to the page from a fixed
 * https origin, so modules, fetch, audio worklets and saved games all work
 * as they do from serve.py on a computer.
 */
public class MainActivity extends Activity {
    private static final String TAG = "KipsGemRush";
    /** The origin the game's page lives at (never reached over the network). */
    static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/index.html";
    static final String WWW = "www";

    private WebView web;
    private FrameLayout root;
    private View cover;         // the loading picture over the WebView until its page has drawn (LoadingView)
    private PartyServer server;
    private final HostFinder finder = new HostFinder();
    private android.net.wifi.WifiManager.MulticastLock wifiLock;
    private OnBackInvokedCallback backCallback;
    private boolean resumed;        // the activity is in front
    private boolean hosting;        // the page hosts a party (Bridge.hosting): it goes on while the app is put away
    private int hostingPlayers;
    private boolean askedNotices;   // the notification permission was asked for once

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window window = getWindow();
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setVolumeControlStream(AudioManager.STREAM_MUSIC);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            // Draw under the camera cutout: the game keeps its own safe margins.
            WindowManager.LayoutParams lp = window.getAttributes();
            lp.layoutInDisplayCutoutMode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                    ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                    : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            window.setAttributes(lp);
        }

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        setContentView(root, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        createWebView();
        hideSystemBars();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            backCallback = this::handleBack;
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, backCallback);
        }
    }

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    private void createWebView() {
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        WebView.setWebContentsDebuggingEnabled(debuggable);
        setHosting(0);          // a fresh page hosts nothing (yet)

        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setVerticalScrollBarEnabled(false);
        web.setHorizontalScrollBarEnabled(false);
        web.setHapticFeedbackEnabled(true);
        web.setLongClickable(false);
        web.setOnLongClickListener(v -> true);          // no text-selection menus
        web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, true);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);                    // saved games and options
        s.setMediaPlaybackRequiresUserGesture(false);    // music starts by itself
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);
        s.setSupportMultipleWindows(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);       // the files are local: always the app's own
        // Party mode joins a host on the home network over plain ws://.
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        web.setWebViewClient(new Client());
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                if (debuggable || m.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                    Log.println(m.messageLevel() == ConsoleMessage.MessageLevel.ERROR ? Log.ERROR : Log.DEBUG, TAG,
                            m.message() + " (" + m.sourceId() + ":" + m.lineNumber() + ")");
                }
                return true;
            }
        });
        web.addJavascriptInterface(new Bridge(), "KipAndroid");
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.requestFocus();
        showCover();
        web.loadUrl(START_URL);
    }

    // ------------------------------------------------------------ loading

    /**
     * The loading picture, up from the app's first frame: a WebView takes a
     * moment (on a slow phone, seconds) to draw its page, and until then
     * there would be nothing to see but black.
     */
    private void showCover() {
        if (cover != null) return;
        cover = new LoadingView(this);
        root.addView(cover, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    /** The page has drawn (its own loading screen, the same picture, or the game): fade ours away. */
    private void hideCover() {
        final View v = cover;
        if (v == null) return;
        cover = null;
        v.animate().alpha(0f).setDuration(220).withEndAction(() -> root.removeView(v)).start();
    }

    // ------------------------------------------------------------ full screen

    private void hideSystemBars() {
        Window window = getWindow();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false);
            WindowInsetsController c = window.getInsetsController();
            if (c != null) {
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                c.hide(WindowInsets.Type.systemBars());
            }
        } else {
            window.getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    // ------------------------------------------------------------ life cycle

    @Override
    protected void onPause() {
        resumed = false;
        // The page pauses the game and silences its audio (it also hears
        // about it through visibilitychange). A page hosting a party is not
        // put to sleep: it keeps the others' game going (see setHosting).
        if (web != null) {
            web.evaluateJavascript("window.kipAppPaused&&window.kipAppPaused(true)", null);
            if (!hosting) web.onPause();
        }
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        resumed = true;
        if (web != null) {
            web.onResume();
            web.evaluateJavascript("window.kipAppPaused&&window.kipAppPaused(false)", null);
        }
        hideSystemBars();
    }

    @Override
    protected void onDestroy() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && backCallback != null) {
            getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backCallback);
        }
        HostService.stop(this);
        if (server != null) server.stop();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        destroyWebView();
        super.onDestroy();
    }

    private void destroyWebView() {
        if (web == null) return;
        root.removeView(web);
        web.removeJavascriptInterface("KipAndroid");
        web.destroy();
        web = null;
    }

    /**
     * Let broadcasts through on Wi-Fi while the app hosts or searches (many
     * phones drop them otherwise, to save power). Held until the app closes.
     */
    private synchronized void openWifiBroadcasts() {
        try {
            if (wifiLock == null) {
                android.net.wifi.WifiManager wifi = (android.net.wifi.WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                if (wifi == null) return;
                wifiLock = wifi.createMulticastLock("jazzo-party");
                wifiLock.setReferenceCounted(false);
            }
            if (!wifiLock.isHeld()) wifiLock.acquire();
        } catch (RuntimeException e) {
            Log.w(TAG, "No Wi-Fi broadcast lock: " + e.getMessage());
        }
    }

    // ------------------------------------------------------------ hosting

    /**
     * The page hosts a party for `players` (0: not any more). While it
     * does, the app put away must not stop it: the page is left running
     * (onPause), its renderer keeps its priority, and HostService keeps the
     * phone awake with a notice in the shade.
     */
    private void setHosting(int players) {
        boolean on = players > 0;
        if (web != null && on != hosting) web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, !on);
        hosting = on;
        hostingPlayers = players;
        if (!on) { HostService.stop(this); return; }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !askedNotices
                && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            // Without it the service still runs, just with no notice shown.
            askedNotices = true;
            requestPermissions(new String[] { android.Manifest.permission.POST_NOTIFICATIONS }, 1);
        }
        // (A service can only be started with the app in front; hosting
        // always starts there, from the HOST screen.)
        if (HostService.running() || resumed) HostService.update(this, players);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        // Allowed now: show the notice after all.
        if (requestCode == 1 && hosting && HostService.running()) HostService.update(this, hostingPlayers);
    }

    // ------------------------------------------------------------ back

    /** BACK goes to the game first (pause, close a menu); it says when to leave. */
    private void handleBack() {
        if (web == null) { finish(); return; }
        web.evaluateJavascript("(window.kipBack?window.kipBack():false)===true", value -> {
            if (!"true".equals(value)) finish();
        });
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        handleBack();
    }

    // ------------------------------------------------------------ the page's files

    private static final Map<String, String> MIME = new HashMap<>();
    static {
        MIME.put("html", "text/html");
        MIME.put("css", "text/css");
        MIME.put("js", "text/javascript");
        MIME.put("mjs", "text/javascript");
        MIME.put("json", "application/json");
        MIME.put("txt", "text/plain");
        MIME.put("png", "image/png");
        MIME.put("jpg", "image/jpeg");
        MIME.put("jpeg", "image/jpeg");
        MIME.put("gif", "image/gif");
        MIME.put("svg", "image/svg+xml");
        MIME.put("ico", "image/x-icon");
        MIME.put("wav", "audio/wav");
        MIME.put("mp3", "audio/mpeg");
        MIME.put("ogg", "audio/ogg");
        MIME.put("wasm", "application/wasm");
    }

    static String mimeOf(String path) {
        int dot = path.lastIndexOf('.');
        String ext = dot < 0 ? "" : path.substring(dot + 1).toLowerCase(Locale.ROOT);
        String mime = MIME.get(ext);
        return mime != null ? mime : "application/octet-stream";
    }

    static boolean isText(String mime) {
        return mime.startsWith("text/") || mime.equals("application/json") || mime.equals("image/svg+xml");
    }

    /** The asset path for a URL path ("/src/main.js" -> "www/src/main.js"), or null if it isn't a plain path. */
    static String assetPath(String urlPath) {
        if (urlPath == null || urlPath.isEmpty() || urlPath.equals("/")) urlPath = "/index.html";
        if (!urlPath.startsWith("/")) return null;
        for (String part : urlPath.split("/")) {
            if (part.equals("..") || part.equals(".")) return null;
        }
        if (urlPath.endsWith("/")) return null;
        return WWW + urlPath;
    }

    private static final Map<String, String[]> LISTINGS = new HashMap<>();

    /**
     * Open an asset. Windows (serve.py) doesn't mind the case of file names
     * and assets do, so a miss is looked up again ignoring case.
     */
    static InputStream openAsset(AssetManager assets, String path) throws IOException {
        try {
            return assets.open(path, AssetManager.ACCESS_STREAMING);
        } catch (IOException missing) {
            String[] parts = path.split("/");
            StringBuilder real = new StringBuilder();
            for (String part : parts) {
                String dir = real.toString();
                String[] names;
                synchronized (LISTINGS) {
                    names = LISTINGS.get(dir);
                    if (names == null) {
                        names = assets.list(dir);
                        if (names == null) names = new String[0];
                        LISTINGS.put(dir, names);
                    }
                }
                String found = null;
                for (String n : names) {
                    if (n.equals(part)) { found = n; break; }
                    if (found == null && n.equalsIgnoreCase(part)) found = n;
                }
                if (found == null) throw missing;
                if (real.length() > 0) real.append('/');
                real.append(found);
            }
            if (real.toString().equals(path)) throw missing;
            return assets.open(real.toString(), AssetManager.ACCESS_STREAMING);
        }
    }

    /** A stream that ends after `limit` bytes (for Range requests). */
    static final class Limited extends FilterInputStream {
        private long left;

        Limited(InputStream in, long limit) { super(in); left = limit; }

        @Override
        public int read() throws IOException {
            if (left <= 0) return -1;
            int b = super.read();
            if (b >= 0) left--;
            return b;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            if (left <= 0) return -1;
            int n = super.read(b, off, (int) Math.min(len, left));
            if (n > 0) left -= n;
            return n;
        }

        @Override
        public int available() throws IOException {
            return (int) Math.min(super.available(), left);
        }
    }

    static void skipFully(InputStream in, long n) throws IOException {
        while (n > 0) {
            long k = in.skip(n);
            if (k <= 0) {
                if (in.read() < 0) break;
                k = 1;
            }
            n -= k;
        }
    }

    private static WebResourceResponse plain(int status, String reason, String text) {
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Cache-Control", "no-store");
        return new WebResourceResponse("text/plain", "UTF-8", status, reason, headers,
                new ByteArrayInputStream(text.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
    }

    private final class Client extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (!HOST.equalsIgnoreCase(url.getHost())) return null;
            String path = assetPath(url.getPath());
            if (path == null) return plain(404, "Not Found", "Not found");
            InputStream in;
            try {
                in = openAsset(getAssets(), path);
            } catch (IOException e) {
                return plain(404, "Not Found", "Not found");
            }
            try {
                long total = in.available();
                String mime = mimeOf(path);
                Map<String, String> headers = new LinkedHashMap<>();
                headers.put("Cache-Control", "no-store");
                headers.put("Accept-Ranges", "bytes");
                String range = null;
                for (Map.Entry<String, String> h : request.getRequestHeaders().entrySet()) {
                    if ("range".equalsIgnoreCase(h.getKey())) range = h.getValue();
                }
                int status = 200;
                String reason = "OK";
                long length = total;
                if (range != null && range.startsWith("bytes=") && !range.contains(",")) {
                    String[] ends = range.substring(6).trim().split("-", -1);
                    try {
                        long from;
                        long to = total - 1;
                        if (ends[0].isEmpty()) {
                            from = Math.max(0, total - Long.parseLong(ends[1]));   // the last N bytes
                        } else {
                            from = Long.parseLong(ends[0]);
                            if (ends.length > 1 && !ends[1].isEmpty()) to = Math.min(to, Long.parseLong(ends[1]));
                        }
                        if (from > to || from >= total) {
                            in.close();
                            headers.put("Content-Range", "bytes */" + total);
                            return new WebResourceResponse(mime, null, 416, "Range Not Satisfiable", headers, new ByteArrayInputStream(new byte[0]));
                        }
                        skipFully(in, from);
                        length = to - from + 1;
                        in = new Limited(in, length);
                        status = 206;
                        reason = "Partial Content";
                        headers.put("Content-Range", "bytes " + from + "-" + to + "/" + total);
                    } catch (NumberFormatException ignored) {
                        // Not a range we understand: the whole file.
                    }
                }
                headers.put("Content-Length", String.valueOf(length));
                return new WebResourceResponse(mime, isText(mime) ? "UTF-8" : null, status, reason, headers, in);
            } catch (IOException e) {
                try { in.close(); } catch (IOException ignored) { /* closing */ }
                return plain(500, "Error", "Could not read the file");
            }
        }

        @Override
        public void onPageCommitVisible(WebView view, String url) {
            // The page's first picture is on screen.
            hideCover();
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            // The game never leaves its own page.
            return !HOST.equalsIgnoreCase(request.getUrl().getHost());
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // The page's process died (low memory): start the page again
            // rather than take the app down with it.
            Log.w(TAG, "The page's process is gone (crashed: " + detail.didCrash() + "); starting again");
            destroyWebView();
            createWebView();
            return true;
        }
    }

    // ------------------------------------------------------------ what the page can ask for

    private final class Bridge {
        /** Leave the app (BACK twice on the title screen). */
        @JavascriptInterface
        public void exit() {
            runOnUiThread(MainActivity.this::finish);
        }

        /** A light tick for a touch button (0) or a short buzz when hurt (1). */
        @JavascriptInterface
        public void haptic(int kind) {
            if (kind == 0) {
                runOnUiThread(() -> { if (web != null) web.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP); });
                return;
            }
            try {
                Vibrator v;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    VibratorManager vm = (VibratorManager) getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
                    v = vm == null ? null : vm.getDefaultVibrator();
                } else {
                    v = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
                }
                if (v != null && v.hasVibrator()) v.vibrate(VibrationEffect.createOneShot(kind == 2 ? 70 : 35, VibrationEffect.DEFAULT_AMPLITUDE));
            } catch (RuntimeException e) {
                Log.w(TAG, "No vibration: " + e.getMessage());
            }
        }

        /**
         * Start the party server on this device (the game for browsers on
         * the network, and the relay). Returns {"port": n, "urls": [...]} or
         * {"error": "..."}.
         */
        @JavascriptInterface
        public String startServer() {
            JSONObject out = new JSONObject();
            openWifiBroadcasts();
            try {
                synchronized (MainActivity.this) {
                    if (server == null) {
                        PartyServer s = new PartyServer(getAssets());
                        s.start();
                        server = s;
                    }
                }
                out.put("port", server.port());
                out.put("urls", new JSONArray(server.lanAddresses()));
            } catch (Exception e) {
                Log.w(TAG, "Party server: " + e);
                try { out.put("error", String.valueOf(e.getMessage())); } catch (org.json.JSONException ignored) { /* a string */ }
            }
            return out.toString();
        }

        /** The game is up (its first frame is drawn): nothing of ours should still cover it. */
        @JavascriptInterface
        public void ready() {
            runOnUiThread(MainActivity.this::hideCover);
        }

        /**
         * This phone hosts a party for `players` (0: not any more): the
         * game goes on while the app is put away, with a notice in the shade.
         */
        @JavascriptInterface
        public void hosting(int players) {
            runOnUiThread(() -> setHosting(Math.max(0, players)));
        }

        /** Start looking for party hosts on the network (about a second and a half). */
        @JavascriptInterface
        public void findHosts() {
            openWifiBroadcasts();
            finder.start();
        }

        /** What the search has found so far: {"done": bool, "hosts": [{address, name, rooms}]}. */
        @JavascriptInterface
        public String foundHosts() {
            return finder.found();
        }

        @JavascriptInterface
        public String version() {
            return BuildConfig.VERSION_NAME;
        }
    }
}
