package io.github.mhamzam.masjidtimes;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.window.OnBackInvokedDispatcher;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Masjid Times: the screens live in assets/app (HTML/JS). This activity hosts them and adds
 * what only native code can do: location (with fake-GPS detection), reminders, change alerts.
 */
public class MainActivity extends Activity {

    private static final String APP_URL = "file:///android_asset/app/index.html";
    private static final int REQ_LOCATION = 1, REQ_NOTIF = 2;

    private WebView web;
    private boolean pageReady = false;
    private float insetTop = 0f, insetBottom = 0f;
    private final Handler main = new Handler(Looper.getMainLooper());

    /** Location requests waiting for the permission answer: {id, fresh}. */
    private final List<int[]> waiting = new ArrayList<>();

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Reminders.channels(this);
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        if (Build.VERSION.SDK_INT >= 26) getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);

        web = new WebView(this);
        web.setBackgroundColor(0xFFF4F6F3);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setSupportZoom(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        // OpenStreetMap asks apps that show its map tiles to identify themselves.
        s.setUserAgentString(s.getUserAgentString() + " MasjidTimes/1.0 (+https://github.com/MhamzaM/masjid-times)");

        web.addJavascriptInterface(new Bridge(), "MasjidNative");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (u.toString().startsWith("file:///android_asset/")) return false;
                openExternal(u);
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pageReady = true;
                pushInsets();
            }
        });
        web.setOnApplyWindowInsetsListener((v, insets) -> {
            readInsets(insets);
            pushInsets();
            return insets;
        });
        setContentView(web);

        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        }
        web.loadUrl(APP_URL);
        Reminders.schedule(this);
        SyncJob.ensure(this);
    }

    // ------------------------------------------------------------ location

    private boolean hasLocation() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private void getLocation(int id, boolean fresh) {
        if (!hasLocation()) {
            waiting.add(new int[]{id, fresh ? 1 : 0});
            if (waiting.size() == 1) {
                requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOCATION);
            }
            return;
        }
        locate(id, fresh);
    }

    @SuppressLint("MissingPermission")
    private void locate(int id, boolean fresh) {
        LocationManager lm = getSystemService(LocationManager.class);
        if (lm == null) { deliverError(id, "LOCATION_REQUIRED"); return; }
        boolean gps = lm.isProviderEnabled(LocationManager.GPS_PROVIDER);
        boolean net = lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
        if (!gps && !net) {
            deliverError(id, "LOCATION_OFF");
            startActivity(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS));
            return;
        }

        // For browsing, a recent fix is fine. For contributing we always take a new one.
        if (!fresh) {
            Location best = null;
            for (String p : lm.getProviders(true)) {
                Location l = lm.getLastKnownLocation(p);
                if (l != null && (best == null || l.getTime() > best.getTime())) best = l;
            }
            if (best != null && System.currentTimeMillis() - best.getTime() < 2 * 60_000 && best.getAccuracy() < 500) {
                deliver(id, best);
                return;
            }
        }

        // Ask GPS and network at once. A GPS fix wins; a network fix is used if GPS is slow.
        final boolean[] done = {false};
        final Location[] network = {null};
        final List<Runnable> cleanup = new ArrayList<>();
        Runnable finishWithNetwork = () -> {
            if (done[0]) return;
            done[0] = true;
            for (Runnable r : cleanup) r.run();
            if (network[0] != null) deliver(id, network[0]);
            else deliverError(id, "LOCATION_REQUIRED");
        };
        java.util.function.Consumer<Location> onGps = l -> {
            if (done[0] || l == null) return;
            done[0] = true;
            for (Runnable r : cleanup) r.run();
            deliver(id, l);
        };
        java.util.function.Consumer<Location> onNet = l -> {
            if (done[0] || l == null) return;
            network[0] = l;
            if (!gps) finishWithNetwork.run();
        };

        if (Build.VERSION.SDK_INT >= 30) {
            CancellationSignal cs = new CancellationSignal();
            cleanup.add(cs::cancel);
            if (gps) lm.getCurrentLocation(LocationManager.GPS_PROVIDER, cs, getMainExecutor(), onGps);
            if (net) lm.getCurrentLocation(LocationManager.NETWORK_PROVIDER, cs, getMainExecutor(), onNet);
        } else {
            LocationListener lg = onGps::accept, ln = onNet::accept;
            cleanup.add(() -> { lm.removeUpdates(lg); lm.removeUpdates(ln); });
            if (gps) lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 0, 0, lg, Looper.getMainLooper());
            if (net) lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 0, 0, ln, Looper.getMainLooper());
        }
        main.postDelayed(finishWithNetwork, fresh ? 15_000 : 8_000);
    }

    @SuppressWarnings("deprecation")
    private static boolean isMock(Location l) {
        return Build.VERSION.SDK_INT >= 31 ? l.isMock() : l.isFromMockProvider();
    }

    private void deliver(int id, Location l) {
        try {
            JSONObject o = new JSONObject()
                    .put("lat", l.getLatitude()).put("lon", l.getLongitude())
                    .put("accuracy", l.hasAccuracy() ? l.getAccuracy() : 9999)
                    .put("mock", isMock(l));
            js("window.__onLocation(" + id + "," + JSONObject.quote(o.toString()) + ")");
        } catch (Exception e) {
            deliverError(id, "LOCATION_REQUIRED");
        }
    }

    private void deliverError(int id, String code) {
        js("window.__onLocation(" + id + "," + JSONObject.quote("{\"error\":\"" + code + "\"}") + ")");
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        if (requestCode == REQ_LOCATION) {
            boolean ok = hasLocation();
            List<int[]> list = new ArrayList<>(waiting);
            waiting.clear();
            for (int[] w : list) {
                if (ok) locate(w[0], w[1] == 1);
                else deliverError(w[0], "LOCATION_DENIED");
            }
        } else if (requestCode == REQ_NOTIF) {
            permissionsChanged();
        }
    }

    // ------------------------------------------------------------ permissions for reliable reminders

    private String permissionsJson() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        PowerManager pm = getSystemService(PowerManager.class);
        try {
            return new JSONObject()
                    .put("notifications", nm != null && nm.areNotificationsEnabled())
                    .put("alarms", Reminders.canExact(this))
                    .put("battery", pm != null && pm.isIgnoringBatteryOptimizations(getPackageName()))
                    .toString();
        } catch (Exception e) {
            return "{}";
        }
    }

    private void requestPermission(String which) {
        try {
            switch (which) {
                case "notifications":
                    // Ask with the system dialog while Android still allows it; after that, open the app's notification settings.
                    if (Build.VERSION.SDK_INT >= 33
                            && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                            && (!askedNotifications() || shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS))) {
                        Reminders.prefs(this).edit().putBoolean("askedNotif", true).apply();
                        requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIF);
                    } else {
                        startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()));
                    }
                    break;
                case "alarms":
                    if (Build.VERSION.SDK_INT >= 31) {
                        startActivity(new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:" + getPackageName())));
                    }
                    break;
                case "battery":
                    // The list of apps; the user picks Masjid Times and chooses "Don't optimize" / "Unrestricted".
                    startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                    break;
            }
        } catch (Exception e) {
            startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName())));
        }
    }

    private boolean askedNotifications() {
        return Reminders.prefs(this).getBoolean("askedNotif", false);
    }

    private void permissionsChanged() {
        Reminders.schedule(this);
        js("window.onPermissionsChanged && window.onPermissionsChanged()");
    }

    // ------------------------------------------------------------ plumbing

    private void openExternal(Uri u) {
        String scheme = u.getScheme();
        if (!"https".equals(scheme) && !"geo".equals(scheme)) return;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (Exception ignored) {
        }
    }

    private void js(String code) {
        main.post(() -> {
            if (web != null && pageReady) web.evaluateJavascript(code, null);
        });
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        handleBack();
    }

    private void handleBack() {
        web.evaluateJavascript("window.onAndroidBack ? window.onAndroidBack() : false", value -> {
            if (!"true".equals(value)) finish();
        });
    }

    @SuppressWarnings("deprecation")
    private void readInsets(WindowInsets insets) {
        float density = getResources().getDisplayMetrics().density;
        int top, bottom;
        if (Build.VERSION.SDK_INT >= 30) {
            android.graphics.Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            top = i.top;
            bottom = i.bottom;
        } else {
            top = insets.getSystemWindowInsetTop();
            bottom = insets.getSystemWindowInsetBottom();
        }
        insetTop = top / density;
        insetBottom = bottom / density;
    }

    private void pushInsets() {
        if (pageReady) web.evaluateJavascript("window.setInsets && window.setInsets(" + insetTop + "," + insetBottom + ")", null);
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        if (pageReady) {
            web.evaluateJavascript("window.onAndroidResume && window.onAndroidResume()", null);
            permissionsChanged();
        }
    }

    @Override
    protected void onPause() {
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        main.removeCallbacksAndMessages(null);
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    /** Called from JavaScript as window.MasjidNative. Runs on a background thread. */
    public class Bridge {
        @JavascriptInterface
        public void getLocation(int id, boolean fresh) {
            main.post(() -> MainActivity.this.getLocation(id, fresh));
        }

        @JavascriptInterface
        public void openUrl(String url) {
            main.post(() -> openExternal(Uri.parse(url)));
        }

        /** Reminder plan for the user's masjid (see Reminders). */
        @JavascriptInterface
        public void setPlan(String json) {
            Reminders.savePlan(getApplicationContext(), json);
        }

        /** Followed masjids and their timings, for the background change check. */
        @JavascriptInterface
        public void setFollowed(String json) {
            Reminders.prefs(MainActivity.this).edit().putString(Reminders.KEY_FOLLOWED, json).apply();
            SyncJob.ensure(getApplicationContext());
        }

        @JavascriptInterface
        public String permissions() {
            return permissionsJson();
        }

        @JavascriptInterface
        public void requestPermission(String which) {
            main.post(() -> MainActivity.this.requestPermission(which));
        }
    }
}
