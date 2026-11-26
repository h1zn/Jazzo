package com.realabs.kipsgemrush;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

/**
 * Keeps a party going while the host's phone is put away (home, the screen
 * off, a call). A foreground service: Android then leaves the app, its page
 * and its relay running, and the shade shows that a game is being hosted
 * (tap it to come back). The CPU and the Wi-Fi are held awake meanwhile.
 * The game asks for it through the bridge when it hosts (Bridge.hosting),
 * with how many are in the game, and 0 when hosting ends; the page itself
 * keeps the game ticking while hidden (src/main.js, hostOn).
 */
public final class HostService extends Service {
    private static final String TAG = "KipsGemRush";
    private static final String CHANNEL = "hosting";
    private static final int NOTICE = 1;
    private static final String PLAYERS = "players";
    private static final long AT_MOST_MS = 6 * 60 * 60 * 1000L;     // a wake lock never held for ever

    private static HostService current;
    private PowerManager.WakeLock cpu;
    private WifiManager.WifiLock wifi;

    /**
     * Show (or update) the notice for `players` in the game, starting the
     * service if it isn't running: that is only allowed while the app is in
     * front, so MainActivity calls this at once when hosting starts.
     */
    static void update(Context ctx, int players) {
        if (current != null) { current.show(players); return; }
        Intent i = new Intent(ctx, HostService.class).putExtra(PLAYERS, players);
        try {
            ctx.startForegroundService(i);
        } catch (RuntimeException e) {
            // Android 12+ refuses a start from the background: the game
            // goes on, just without the phone kept awake.
            Log.w(TAG, "Could not start the hosting service: " + e);
        }
    }

    static void stop(Context ctx) {
        if (current != null) current.stopSelf();
        else ctx.stopService(new Intent(ctx, HostService.class));
    }

    static boolean running() {
        return current != null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        current = this;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        int players = intent == null ? 1 : intent.getIntExtra(PLAYERS, 1);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTICE, notice(players), ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
            } else {
                startForeground(NOTICE, notice(players));
            }
        } catch (RuntimeException e) {
            // Not allowed here (a start from the background), or the kind of
            // service refused: without it the game still goes on in front.
            Log.w(TAG, "Could not keep hosting in the background: " + e);
            stopSelf();
            return START_NOT_STICKY;
        }
        hold();
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        if (cpu != null && cpu.isHeld()) cpu.release();
        if (wifi != null && wifi.isHeld()) wifi.release();
        cpu = null;
        wifi = null;
        stopForeground(STOP_FOREGROUND_REMOVE);
        if (current == this) current = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /** The CPU on and the Wi-Fi at full speed with the screen off, as long as the service lives. */
    @SuppressWarnings("deprecation")
    private void hold() {
        try {
            if (cpu == null) {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                cpu = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "jazzo:hosting");
                cpu.setReferenceCounted(false);
            }
            if (!cpu.isHeld()) cpu.acquire(AT_MOST_MS);
            if (wifi == null) {
                WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                // (The low-latency mode only works with the app in front; high performance keeps the radio up.)
                if (wm != null) wifi = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "jazzo:hosting");
                if (wifi != null) wifi.setReferenceCounted(false);
            }
            if (wifi != null && !wifi.isHeld()) wifi.acquire();
        } catch (RuntimeException e) {
            Log.w(TAG, "Could not keep the phone awake: " + e);
        }
    }

    /** The notice in the shade: what is hosted, how many are in, and a tap brings the game back. */
    private Notification notice(int players) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel c = new NotificationChannel(CHANNEL, getString(R.string.hosting_channel), NotificationManager.IMPORTANCE_LOW);
            c.setShowBadge(false);
            nm.createNotificationChannel(c);
        }
        Intent open = new Intent(this, MainActivity.class).setAction(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        PendingIntent tap = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_notice)
                .setColor(0xFFFFB02E)
                .setContentTitle(getString(R.string.hosting_title))
                .setContentText(getResources().getQuantityString(R.plurals.hosting_players, players, players))
                .setContentIntent(tap)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setCategory(Notification.CATEGORY_SERVICE)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .build();
    }

    private void show(int players) {
        try {
            getSystemService(NotificationManager.class).notify(NOTICE, notice(players));
        } catch (RuntimeException e) {
            Log.w(TAG, "Could not update the hosting notice: " + e);
        }
    }
}
