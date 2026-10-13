package com.dshmobile.app;

import android.app.Activity;
import android.app.UiModeManager;
import android.content.Intent;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.TextUtils;
import android.util.Log;
import android.view.GestureDetector;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.animation.DecelerateInterpolator;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

/**
 * DSH mobile shell: a WebView around the host's Web GUI, plus the pairing screen.
 *
 * Deliberately dependency-free — only the Android framework is referenced — so the APK
 * can be produced by aapt2 + javac + d8 without Gradle.
 *
 * Rebuilt after an encoding mistake destroyed the previous revision's comments. Every
 * user-visible string below was read back from the last working APK's dex rather than
 * retyped, so the wording matches what the device already shows.
 */
public class MainActivity extends Activity {

    private static final String PREFS = "dshmobile";
    private static final String KEY_URL = "url";
    /** Optional second origin, tried when the primary does not answer. */
    private static final String KEY_URL2 = "url2";
    private static final String KEY_TOKEN = "token";
    /** One-time key that lets an unpaired device pair itself instead of scanning. */
    private static final String KEY_SECRET = "secret";
    /**
     * The port the LAN sweep probes.
     *
     * Kept separately from the URLs because the sweep needs a port *before* it has a host, and
     * because the operator may run the host somewhere other than 19387. The value is normally
     * written by discovery itself, from the port the host reports.
     */
    private static final String KEY_PORT = "port";
    /**
     * View preferences, added in 2.1.
     *
     * `fontPercent` is a percentage of the system font size rather than an absolute
     * `textZoom`, so a user who already enlarged text system-wide is not reset by this app.
     * `theme` is 0 system / 1 light / 2 dark; `immersive` hides the shell's top bar.
     */
    private static final String KEY_FONT = "fontPercent";
    private static final String KEY_THEME = "theme";
    private static final String KEY_IMMERSIVE = "immersive";
    /**
     * Whether the top bar steps out of the way while the page is scrolled.
     *
     * A preference rather than always-on: hiding chrome the user did not ask to hide is the
     * kind of thing that feels broken rather than slick, and this way it can be turned off
     * the moment it annoys someone.
     */
    private static final String KEY_MOTION = "barMotion";
    /** Whether the WebView has a page loaded, so returning to the app does not reload it. */
    private static final String KEY_WEB_LOADED = "webLoaded";
    /**
     * The app version the stored caches belong to.
     *
     * Every build ships changed scripts, and the WebView keeps the previous copy of each one.
     * Comparing this on launch is what makes an upgrade actually take effect instead of
     * serving the old assets out of the cache indefinitely.
     */
    private static final String KEY_CACHE_VERSION = "cacheVersion";

    /** When the caches were last swept on a schedule, so "once a day" survives a restart. */
    private static final String KEY_CACHE_SWEPT_AT = "cacheSweptAt";

    /**
     * How long the cached client may go before it is dropped and refetched.
     *
     * A day. Shorter would mean paying for a full re-download on most launches, longer would let a stale
     * client survive a host update for that much longer. A fixed interval is used rather than a check
     * against the host's version because the page cannot be asked before it is loaded, and the whole point
     * is to decide before loading it.
     */
    private static final long CACHE_SWEEP_INTERVAL_MS = 24L * 60 * 60 * 1000;

    /**
     * The origin a session was last known to live on, written only after a load succeeded.
     *
     * A second copy of the address, kept because the address field alone was not durable: when it is
     * lost, a device the host still recognises looks unconfigured and gets asked to pair again. This
     * one is only ever written from an origin that demonstrably worked.
     */
    private static final String KEY_SESSION_ORIGIN = "sessionOrigin";

    /**
     * The host's MagicDNS name, kept alongside its `100.x` address rather than instead of it.
     *
     * Both reach the same computer but they are different origins, and a session cookie belongs to
     * one. Keeping the name in its own key means learning it can never displace the address the
     * pairing actually used — which is what happened when the name was written into the same spare
     * field the IP occupied.
     */
    private static final String KEY_TS_NAME = "tailscaleName";

    /**
     * Additional origins to try, one per line: the host's other addresses.
     *
     * Kept in its own key rather than packed into the fallback text field. Packing was tried and it
     * broke the app: `\n` is not a separator anywhere in the URL path, so a two-address field
     * produced a malformed URL — observed in logcat as
     * `http::19387:19387:19387//yunannian.tail951e59.ts.net:19387` followed by
     * `probe -> MalformedURLException` — and every candidate was lost, including the working one.
     * A field holds one address; anything else lives here.
     */
    private static final String KEY_EXTRA_ORIGINS = "extraOrigins";

    /** Above this, the caches are trimmed on launch rather than left to keep growing. */
    private static final long CACHE_CEILING_BYTES = 400L * 1024 * 1024;

    /**
     * Written once the first-run guide has been seen through (or skipped).
     *
     * The guide explains where the pairing code lives, which is the one thing a new user cannot
     * guess; showing it on every launch would turn a one-time explanation into a nag.
     */
    /**
     * How long the mark stays in front of the pairing menu on a launch with nothing to load.
     *
     * Matches the minimum a page launch holds (SplashView.MIN_VISIBLE_MS) so both openings feel like
     * the same app. Long enough to register as a deliberate opening, short enough not to be a wait.
     */
    private static final long BRANDED_OPENING_MS = 2800;

    /**
     * True while the mark is deliberately in front of the pairing menu.
     *
     * It only changes one decision: `showPairingScreen()` normally dismisses the opening frame
     * because a settings screen has nothing to wait for — but during the branded opening the menu is
     * *meant* to be behind the mark, and dismissing there would cancel the timed fade.
     */
    private boolean brandedOpening;

    /**
     * Set when the user pressed 「手动输入地址」, so the address field is unlocked for it.
     *
     * The field is normally read-only once an address is stored — typing over it while the stored value
     * still won on launch produced a screen that disagreed with reality. The manual button is the one
     * case where replacing it is the whole point.
     */
    private boolean manualAddressEntry;

    /**
     * The address the last probe run actually reached.
     *
     * Kept because a probe is a sample, not a state: on a Tailscale path that moves between direct and
     * relay, the same address can answer one second and not the next. When a later step needs to try
     * something (pairing over Tailscale), this is the address with evidence behind it, and re-probing
     * everything again is what made the app conclude "no address answered" seconds after one had.
     */
    private String lastReachableOrigin;

    /** Set once the address screen has been offered as a last resort, so it is not offered repeatedly. */
    private boolean manualOfferShown;

    /**
     * Set while the user is pairing over Tailscale, so the LAN address is left out of the candidates.
     *
     * Pressing 「Tailscale 配对」 states an intent: this phone is not on the host's network. Probing the LAN
     * address anyway costs a timeout, and — worse — it is the address that appears in the failure message
     * and is retried on the next attempt, so the app behaved as if the user had never chosen Tailscale.
     * Cleared once a page has loaded, so the stored LAN address goes back to being the fast path at home.
     */
    private boolean tailscaleOnly;

    /** Whether the launch decision has been made; it runs from two lifecycle points. */
    private boolean launchInitialized;

    /**
     * Tailscale's Android package, used to detect it and to open it.
     */
    private static final String TAILSCALE_PACKAGE = "com.tailscale.ipn";

    /**
     * Whether the phone currently has a Wi-Fi connection.
     *
     * Every network is inspected, not just the active one, because **a VPN is the active network**.
     * With Tailscale connected, `getActiveNetwork()` returns the tunnel and its capabilities carry
     * `TRANSPORT_VPN` and nothing else — so asking only the active network answered "not on Wi-Fi" for a
     * phone that was sitting on Wi-Fi the whole time. Measured: the VPN icon present, the phone on
     * 192.168.31.166, and the app logging `connect: off Wi-Fi, so Tailscale addresses lead` with the LAN
     * address in the list and unreachable results for it.
     *
     * Used only to decide the order in which stored addresses are tried and whether a LAN sweep is worth
     * running. Both addresses are always probed, so a wrong answer costs a failed probe rather than a
     * failed connection — but "always off Wi-Fi" also disabled the branch that offers manual entry, which
     * is not a cost that can be absorbed.
     */
    private boolean isOnWifi() {
        try {
            android.net.ConnectivityManager manager =
                    (android.net.ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            if (manager == null) return false;
            for (android.net.Network network : manager.getAllNetworks()) {
                android.net.NetworkCapabilities capabilities = manager.getNetworkCapabilities(network);
                if (capabilities != null
                        && capabilities.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI)) {
                    return true;
                }
            }
            return false;
        } catch (Exception e) {
            Log.i(TAG, "isOnWifi: " + e.getClass().getSimpleName() + " (assuming no)");
            return false;
        }
    }

    /**
     * Tailscale status line and its "open the app" button, on the address screen.
     *
     * The line says whether the tunnel is up, because a 100.x address cannot work without it and
     * that fact is otherwise invisible. The button appears only when it is down — the one moment it
     * has a purpose — and opens the Tailscale app so its switch can be turned on without hunting for
     * the icon.
     */
    private TextView tailscaleState;
    private Button openTailscaleBtn;
    /** Logcat tag; the deep-link and load decisions are logged for diagnosis. */
    private static final String TAG = "DSHMobile";
    /**
     * Tag given to the WebView.
     *
     * Required before `addJavascriptInterface` on API 17+, and deliberately a fixed literal
     * rather than the URL: a page could otherwise choose its own tag and inherit the bridge.
     */
    private static final String WEBVIEW_TAG = "dsh-shell";
    /** Request codes: the in-app QR scanner, and the file picker. */
    private static final int REQUEST_SCAN = 1001;
    private static final int REQUEST_FILE = 1002;
    /** How long to stop trying after the host refuses the auto-pair key. */
    private static final long AUTO_PAIR_PAUSE_MS = 5 * 60 * 1000;

    /** The way in: scan a code, or type an address. This is the launch screen. */
    private View pairingPanel;
    /** The address path, kept on its own screen so it stays one decision. */
    private View ipPanel;
    /** The Tailscale guide: the one part of setup that happens outside this app. */
    private View tailscalePanel;
    /**
     * True when the Tailscale guide was opened by the 「Tailscale 配对」 button.
     *
     * The install guide belongs to the moment the user asks for Tailscale: someone who pressed that
     * button needs the app installed before pairing can work, and putting the instructions here means
     * they arrive with the need rather than on a first launch, where they read as one more screen to
     * get past. Finishing the guide continues straight into pairing instead of returning to a menu.
     */
    private boolean guideLeadsToTailscalePairing;

    /**
     * True while the app is waiting for the user to return from the Tailscale app.
     *
     * They left to turn the switch on; when they come back the pairing continues by itself. Asking
     * them to press the button again would be asking them to repeat a step that just succeeded.
     */
    private boolean awaitingTailscaleReturn;

    /**
     * True while an authentication recovery is in flight.
     *
     * The load-failure callback fires straight after the 401 and would otherwise retry the very
     * address that just failed, putting the auth page back before recovery could mint a session.
     */
    private boolean recovering;

    /**
     * The pairing request currently waiting on the desktop, or null.
     *
     * Kept only so a second discovery does not silently start a second request — the host allows a
     * few per address, and two prompts for the same phone is just noise for the operator.
     */
    private String pairRequestId;

    /**
     * Set while the user is pairing through the Tailscale button.
     *
     * It changes one decision in discovery: which of the two addresses the host offers becomes the
     * primary field. The Tailscale entry exists because that address is the one that works away from
     * home, so when the user asked for Tailscale it should not be pushed into the fallback slot —
     * discovery's default preference is LAN, which is right for the generic button and wrong here.
     */
    private boolean preferTailscaleAfterDiscovery;

    /** Connection settings: fallback address, token, key, display options. */
    private View configPanel;
    private View webPanel;
    private EditText urlInput;
    private EditText urlInput2;
    /** Port used by the LAN sweep. Written from the host's reported port when discovery runs. */
    private EditText portInput;
    private EditText tokenInput;
    private EditText secretInput;
    private TextView statusText;
    private TextView hostText;
    private TextView discoverText;
    private TextView loadHint;
    private TextView cacheText;
    private SplashView splash;
    private CheckBox immersiveCheck;
    private CheckBox motionCheck;
    private View topBar;
    /** The retracted bar's tab: shown in place of the bar while the page is being read. */
    private android.view.View barTab;
    /** Settings, from the expanded bar.") */
    private ImageButton barSettingsBtn;
    private ProgressBar progress;
    private WebView webView;
    private SharedPreferences prefs;

    /** True while a LAN sweep is already running, so one scan cannot stack on another. */
    private boolean discovering;

    /** True once the current load has already been retried with the one-time key. */
    private boolean autoPairTried;

    /** True between onResume and onPause: distinguishes a real return from a fresh start. */
    private boolean resumed;

    /**
     * True when returning to the app must not re-download the page.
     *
     * The point of keeping the WebView alive is that a backgrounded session comes back
     * exactly as it was; reloading here was what made every return cost a full
     * re-download of the app shell.
     *
     * Only ever set by a load that actually finished in *this* process. Reading it back from
     * storage was a real defect: after the host (and with it the WebView's renderer) went
     * away, the remembered flag said a page was showing while the view was in fact empty, so
     * the one load that would have restored it was skipped and the screen stayed black.
     */
    private boolean pageAlive;

    /**
     * Whether the last session ended with the page on screen.
     *
     * Persisted and used only to decide what to show on launch, never to skip a load.
     */
    private boolean pageWasShowing;

    /** The origin currently loaded in the WebView, so a reconnect can be skipped. */
    private String lastLoadedOrigin;

    /** Origins already retried once after a failure, to stop a reload loop. */
    private final java.util.Set<String> reloadRetriedFor = new java.util.HashSet<>();

    /** Origins already recovered from a spent pairing link, for the same reason. */
    private final java.util.Set<String> redeemRecoveredFor = new java.util.HashSet<>();

    /**
     * Origins the probe could not reach on this connect.
     *
     * Recovery must not be sent to one of these: a load against a dead address neither succeeds
     * nor calls back for a long time, so the whole recovery sits waiting for an error that a dead
     * host never sends. Remembering the probe's answer is what lets recovery skip straight to
     * minting a fresh session.
     */
    private final java.util.Set<String> unreachableOrigins = new java.util.HashSet<>();

    /**
     * The `/m/pair?t=` link to load verbatim, or null when there is none.
     *
     * Held rather than rebuilt: `connect()` re-derives its target from the input fields, and
     * those hold the split-apart origin and token, so the original URL is otherwise lost.
     */
    private String pairingLink;

    /** Whether the Tailscale guide was opened from the address screen, so back returns there. */
    private boolean tailscaleReturnToIp;

    /** How many native touch events have been logged, so the log cannot flood. */
    private int touchLogCount;

    /**
     * Whether the top bar is currently slid out of the way, or null before the page ever
     * reported a scroll. The null state matters: without it the first scroll event would
     * animate the bar before the shell knows where the page is.
     */
    private Boolean barAutoHidden = Boolean.FALSE;

    /** Last scroll offset reported by the page, or -1 when unknown. */
    private int lastScrollY = -1;

    /** Movement accumulated in one direction, in pixels, since the last bar change. */
    private int travel;

    /**
     * How far from the left edge a swipe must start to count as "go home".
     *
     * Narrow on purpose: a wider band starts competing with the page's own horizontal gestures, and a
     * left-edge swipe is a deliberate action — a user aiming for it starts at the very edge.
     */
    private static final int LEFT_EDGE_SWIPE_START_DP = 24;

    /** Travel needed to hide the bar: scrolling down means the user is reading. */
    private static final int HIDE_TRAVEL_PX = 48;
    /** Travel needed to bring it back. Larger, so a small correction does not move it. */
    private static final int SHOW_TRAVEL_PX = 64;

    /**
     * Wall-clock time before which automatic pairing is skipped.
     *
     * Set after the host refuses the key, because a refusal will not change on retry.
     */
    private long autoPairPausedUntil;

    /**
     * Origins to try for the current connection, in order.
     *
     * Held per connection rather than recomputed so auto-pairing asks the same address the
     * page came from, and falls through the same list when it does not answer.
     */
    private java.util.List<String> origins = new java.util.ArrayList<>();

    /** Pending file-chooser callback; must be answered exactly once per request. */
    private ValueCallback<Uri[]> filePathCallback;

    /**
     * Whether an authority is only reachable on a local network: RFC1918 private ranges,
     * 100.64.0.0/10 (Tailscale's shared address space), Tailscale's own MagicDNS names, or loopback.
     *
     * The harness serves these over plain HTTP, so defaulting them to https would produce
     * a connection failure rather than a working session.
     */
    private static boolean isLocalAuthority(String host) {
        if (host == null || host.isEmpty()) return false;
        if ("localhost".equals(host) || "127.0.0.1".equals(host) || "::1".equals(host)) return true;
        // Tailscale's MagicDNS domain. Checked because the host advertises its tunnel address as this
        // name, and it is *not* shape-detectable as an address: without this the app composed
        // `https://yunannian.tail951e59.ts.net:19387` and every Tailscale candidate failed its
        // reachability probe, which took the session down with it — the IP carrying the session was
        // marked unreachable and skipped. Observed on device as
        // `on Wi-Fi, LAN addresses lead: [https://yunannian.…:19387, http://100.82.206.124:19387]`.
        if (host.toLowerCase(java.util.Locale.ROOT).endsWith(".ts.net")) return true;
        String[] parts = host.split("\\.");
        if (parts.length != 4) return false;
        try {
            int a = Integer.parseInt(parts[0]);
            int b = Integer.parseInt(parts[1]);
            if (a == 10) return true;
            if (a == 192 && b == 168) return true;
            if (a == 172 && b >= 16 && b <= 31) return true;
            if (a == 100 && b >= 64 && b <= 127) return true; // Tailscale
        } catch (NumberFormatException ignored) {
            return false;
        }
        return false;
    }

    /** Normalize user input into a usable absolute URL, or null when it is not one. */
    private static String normalizeUrl(String raw) {
        if (raw == null) return null;
        String value = raw.trim();
        if (value.isEmpty()) return null;
        // A URL never contains whitespace, so anything that does is not one — and accepting it built a
        // malformed address out of two: a value holding two origins separated by a newline reached
        // `Uri.parse` and came back looking like a URL, which is how every candidate was lost. Rejecting
        // is the safe direction here: callers treat null as "nothing usable" and fall through.
        for (int i = 0; i < value.length(); i++) {
            if (Character.isWhitespace(value.charAt(i))) {
                Log.w(TAG, "normalizeUrl: refusing a value containing whitespace");
                return null;
            }
        }
        if (!value.startsWith("http://") && !value.startsWith("https://")) {
            // Split off the authority before deciding, because the scheme depends on it.
            String authority = value.split("[/?#]", 2)[0];
            String host = authority.split(":")[0];
            value = (isLocalAuthority(host) ? "http://" : "https://") + value;
        }
        try {
            Uri parsed = Uri.parse(value);
            if (parsed.getHost() == null || parsed.getHost().isEmpty()) return null;
            return value;
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Append the host port when the address has none.
     *
     * `normalizeUrl` adds a scheme but leaves the port alone, so a bare address becomes
     * `http://100.82.206.124` and the WebView fetches **port 80** while the host listens on 19387.
     * That is not a hypothetical: "copy the IP out of the Tailscale app" is the natural way to fill
     * this field, and the Tailscale app shows an address with no port. Observed in logcat as
     * `connect: loading http://100.82.206.124` followed by a load failure against a host that was
     * answering perfectly on 19387.
     *
     * The port is taken from the field the operator can edit, so a host moved to another port still
     * works; `scanPort()` falls back to the stored value and then to 19387.
     */
    private String withDefaultPort(String value) {
        if (value == null || value.isEmpty()) return value;
        String scheme;
        String rest;
        if (value.startsWith("http://")) { scheme = "http://"; rest = value.substring(7); }
        else if (value.startsWith("https://")) { scheme = "https://"; rest = value.substring(8); }
        else return value;
        String authority = rest.split("[/?#]", 2)[0];
        if (authority.isEmpty()) return value;
        String hostPart = authority;
        String afterHost = rest.substring(authority.length());
        if (hostPart.startsWith("[")) {
            // IPv6 literal: the port, if any, follows the closing bracket.
            int close = hostPart.indexOf(']');
            if (close < 0) return value;
            if (hostPart.length() > close + 1 && hostPart.charAt(close + 1) == ':') return value;
            return scheme + hostPart + ":" + scanPort() + afterHost;
        }
        if (hostPart.contains(":")) {
            String port = hostPart.substring(hostPart.indexOf(':') + 1);
            if (!port.isEmpty() && port.chars().allMatch(Character::isDigit)) return value;
        }
        return scheme + hostPart + ":" + scanPort() + afterHost;
    }

    /** The origin (`scheme://host[:port]`) of a URL, or the input when unparseable. */
    private static String originOf(String url) {
        try {
            Uri parsed = Uri.parse(url);
            String host = parsed.getHost();
            if (host == null || host.isEmpty()) return url;
            int port = parsed.getPort();
            return parsed.getScheme() + "://" + host + (port > 0 ? ":" + port : "");
        } catch (Exception e) {
            return url;
        }
    }

    private static final class Target {
        final String url;
        final String token;
        /**
         * The `/m/pair` link exactly as it arrived, or null.
         *
         * Kept so redemption loads the original URL rather than one rebuilt from the origin:
         * rebuilding appended a second `/m/pair?t=` onto a link that already had one, and the
         * host answered 403 to that — which looks exactly like an expired code.
         */
        final String rawLink;
        /** One-time key travelling with the link, or null. */
        final String secret;
        /** Second address travelling with the link, or null. */
        final String url2;
        /**
         * True when the token came from a `/m/pair` link and must be redeemed by visiting
         * that route again.
         *
         * The two token forms are not interchangeable: the harness ignores
         * `?dsh_token=` on the origin (it answers 401 without setting any cookie), whereas
         * `/m/pair?t=` runs the redemption that mints the device cookie and redirects to a
         * launch-token URL the harness accepts.
         */
        final boolean pairing;

        Target(String url, String token, boolean pairing) {
            this(url, token, pairing, null, null, null);
        }

        Target(String url, String token, boolean pairing, String rawLink,
               String secret, String url2) {
            this.url = url;
            this.token = token;
            this.pairing = pairing;
            this.rawLink = rawLink;
            this.secret = secret;
            this.url2 = url2;
        }
    }

    private static Target resolveTarget(String raw, String explicitToken) {
        if (raw == null) return null;
        String normalized = normalizeUrl(raw);
        if (normalized == null) return null;
        Uri parsed = Uri.parse(normalized);
        String token = explicitToken == null ? "" : explicitToken.trim();
        boolean pairing = false;
        String rawLink = null;
        // A link that carries its own key and fallback address is a complete hand-off, so
        // both travel with the target instead of being dropped.
        String secret = parsed.getQueryParameter("secret");
        String url2 = parsed.getQueryParameter("url2");
        if (parsed.getPath() != null && parsed.getPath().startsWith("/m/pair")) {
            token = parsed.getQueryParameter("t");
            token = token == null ? "" : token.trim();
            rawLink = normalized;
            normalized = originOf(normalized);
            pairing = true;
        }
        return new Target(normalized, token, pairing, rawLink,
                secret == null || secret.trim().isEmpty() ? null : secret.trim(),
                url2 == null || url2.trim().isEmpty() ? null : url2.trim());
    }

    /**
     * Counts taps without consuming them.
     *
     * <p>Deliberately not a long-click listener: this observes touches and always returns
     * false, so the view's own click handling — and the WebView's text selection — are left
     * exactly as they would be without it. The count resets when the taps stop.
     */
    private static final class TapCounter implements View.OnTouchListener {

        private final int target;
        private final Runnable action;
        private int count;
        private long lastTap;

        TapCounter(int target, Runnable action) {
            this.target = target;
            this.action = action;
        }

        @Override
        public boolean onTouch(View view, MotionEvent event) {
            if (event.getAction() != MotionEvent.ACTION_UP) return false;
            long now = System.currentTimeMillis();
            if (now - lastTap > 700) count = 0;
            lastTap = now;
            count++;
            if (count >= target) {
                count = 0;
                view.post(action);
            }
            return false;
        }
    }

    /**
     * The URL to actually load.
     *
     * A token is always redeemed through `/m/pair?t=`, never as `?dsh_token=` on the origin:
     * the harness ignores the latter and answers 401 without setting any cookie.
     *
     * The link that arrived is loaded verbatim when there is one. Rebuilding it from the
     * origin was a real defect: a link whose host already carried a path produced
     * `http://host:19387/m/pair?t=OLD/m/pair?t=NEW`, which the host answers 403 — and that
     * is indistinguishable, to the user, from an expired code.
     */
    private static String loadUrlFor(Target target) {
        if (!TextUtils.isEmpty(target.rawLink)) {
            return target.rawLink;
        }
        if (!target.token.isEmpty()) {
            // Only an origin here, so appending is safe. `originOf` guards against a stored
            // field that somehow holds more than that.
            return originOf(target.url) + "/m/pair?t=" + Uri.encode(target.token);
        }
        return target.url;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        // Read before the first frame: the inset handler is registered below and consults
        // the immersive flag, so it must already hold the stored value by then.
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        immersiveActive = prefs.getBoolean(KEY_IMMERSIVE, false);

        // Draw edge to edge and fit the insets here, rather than letting the window reserve
        // space for the bars. Reserving that space is what left a black strip along the top:
        // the strip is the window background showing through the area the system had taken,
        // and on Android 15+ the window is edge-to-edge regardless, so the two rules fought
        // each other. Drawing behind the bars and insetting only the parts that need it
        // (the top bar, and the page below it) removes the strip and lets the page reflow.
        setDecorFitsSystemWindows(false);
        applyLightBarIcons();

        final View root = findViewById(android.R.id.content);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            applyInsets(insets);
            return insets;
        });
        root.requestApplyInsets();

        pairingPanel = findViewById(R.id.pairingPanel);
        ipPanel = findViewById(R.id.ipPanel);
        configPanel = findViewById(R.id.configPanel);
        webPanel = findViewById(R.id.webPanel);
        // Bound here rather than looked up on demand: the first-run guide shows this screen
        // without any click, so it has to exist as state rather than as a lookup inside a handler.
        tailscalePanel = findViewById(R.id.tailscalePanel);
        urlInput = findViewById(R.id.urlInput);
        urlInput2 = findViewById(R.id.urlInput2);
        portInput = findViewById(R.id.portInput);
        tokenInput = findViewById(R.id.tokenInput);
        secretInput = findViewById(R.id.secretInput);
        statusText = findViewById(R.id.statusText);
        hostText = findViewById(R.id.hostText);
        discoverText = findViewById(R.id.discoverText);
        loadHint = findViewById(R.id.loadHint);
        cacheText = findViewById(R.id.cacheText);
        splash = findViewById(R.id.splash);
        // Keep the opening frame only for a launch that is about to load a page.
        //
        // It used to be dismissed unconditionally here, on the reasoning that the layer is the last
        // child of the layout and would otherwise cover the settings screens. That reasoning is
        // sound for a launch with nothing to load, but `dismissImmediately` sets the permanent
        // `dismissed` flag, so `showWebScreen()` — which asks `isShowing()` before playing the
        // animation — never played it. The splash has therefore never been visible on any launch
        // that did load a page, which is the one case it exists for. Measured on device: the window
        // sat on a plain black frame for a few hundred milliseconds and then showed the *page's*
        // own "Loading plugins…" screen, with no app icon anywhere.
        //
        // The screens are still protected: every path that shows a panel calls `dismissImmediately`
        // itself (showPairingScreen, showIpScreen, showConfigScreen, showTailscaleGuide), so the
        // cover is gone before the first settings frame either way.
        splash.setVisibility(TextUtils.isEmpty(prefs.getString(KEY_URL, "")) ? View.GONE : View.VISIBLE);
        splash.setDismissed(false);
        immersiveCheck = findViewById(R.id.immersiveCheck);
        motionCheck = findViewById(R.id.motionCheck);
        topBar = findViewById(R.id.topBar);
        barTab = findViewById(R.id.barTab);
        barSettingsBtn = findViewById(R.id.barSettingsBtn);
        progress = findViewById(R.id.progress);
        webView = findViewById(R.id.webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        // Allow the page to read a file the user just picked. Not enabled on every target
        // SDK, and a page's upload control silently fails without it.
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setUserAgentString(settings.getUserAgentString() + " DSHMobile/16.9");

        // The scroll listener is delivered to this object. A WebView tag is required for
        // that on API 17+, and it is set once here so the context stays the app's own page.
        webView.setTag(WEBVIEW_TAG);
        webView.addJavascriptInterface(new MotionBridge(), "DSHMotion");

        webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_BOUND, false);
        webView.setOverScrollMode(View.OVER_SCROLL_IF_CONTENT_SCROLLS);
        webView.setScrollBarStyle(View.SCROLLBARS_INSIDE_OVERLAY);
        webView.setVerticalScrollbarOverlay(true);
        // No forced opaque background: setting black to "avoid a blend layer" also paints
        // over Chromium's own network-error page, so a failed load looks like a dead black
        // screen instead of "site can't be reached".

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // Keep every navigation inside the shell.
                return false;
            }

            /**
             * A new document means the old scroll position is meaningless and the history
             * buttons have new state, so both are refreshed here.
             */
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                lastScrollY = -1;
                travel = 0;
                updateNavButtons();
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progress.setVisibility(View.GONE);
                pageAlive = true;
                prefs.edit().putBoolean(KEY_WEB_LOADED, true).apply();
                updateNavButtons();
                // The page is on screen now, so the download hint has done its job. It is
                // hidden here rather than at its first paint because a blank rectangle over
                // a half-rendered shell looks worse than the hint itself.
                view.postDelayed(() -> showLoadHint(false, null), 120);
                // Start reporting scrolls so the top bar can step out of the way.
                injectScrollMotion();
                // Detect the host's authentication page by its text as well as by status
                // code. onReceivedHttpError is not reliable for a main-frame 401 on every
                // WebView (observed here: the callback did not fire while the page really
                // was the auth challenge), whereas the body text is fixed.
                // Two page kinds mean "not authenticated": the host's challenge, and its answer to a
                // redemption that lost the race (the token was already spent). Both are triggers for
                // the same recovery, and `loadPairingLink` guarantees the replacement is redeemed
                // exactly once — which is what makes acting on the second one safe.
                view.evaluateJavascript(
                        "(function(){try{var b=(document.body&&document.body.innerText)||'';"
                        + "if(b.indexOf('dsh web authentication required')>=0)return 'auth';"
                        + "if(b.indexOf('配对链接无效或已过期')>=0)return 'spent';"
                        + "return 'ok';}catch(e){return 'ok';}})()",
                        value -> {
                            if (value != null && value.contains("auth")) {
                                Log.i(TAG, "onPageFinished: page is the auth challenge");
                                maybeAutoPair();
                            } else if (value != null && value.contains("spent")) {
                                Log.i(TAG, "onPageFinished: the redemption was refused as spent");
                                startRecovery();
                            } else if (value != null) {
                                // The page really loaded. A recovery that got this far has
                                // succeeded, so its guard is released — holding it would make the
                                // next authentication failure unrecoverable, which is a worse bug
                                // than the loop it prevents.
                                if (recovering) {
                                    Log.i(TAG, "onPageFinished: recovery succeeded");
                                    recovering = false;
                                }
                                // Ask the host for the current auto-pair key: it may have been
                                // rotated since this device stored one, and a stale key is
                                // only discovered later, when the session finally expires.
                                syncSecretFromHost();
                                // Learn the host's Tailscale address while we can still reach it.
                                // This is the only moment the app is guaranteed to be able to ask:
                                // once the user is away from home, the LAN is gone and the sweep
                                // cannot help, so a value not captured here has to be typed in by
                                // hand from a screen the user may not be looking at.
                                rememberTailscaleAddress();
                                // And remember the origin itself, on the only evidence that counts:
                                // a page that loaded. This is the copy that survives losing the
                                // address field, which left a paired device looking unconfigured and
                                // sent it back to the pairing menu.
                                rememberSessionOrigin(originOf(url));
                                // A load that worked ends the Tailscale-only intent: whatever address it
                                // used is good, and the LAN address is allowed back for the next launch.
                                tailscaleOnly = false;
                            }
                        });
            }

            /**
             * Secondary auth hint: a 401/403 on the main frame. Kept because when it fires
             * it is the earliest signal, but it is not the only trigger (see above).
             */
            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request,
                                            WebResourceResponse errorResponse) {
                if (request == null || !request.isForMainFrame()) return;
                int status = errorResponse == null ? 0 : errorResponse.getStatusCode();
                if (status != 401 && status != 403) return;
                Log.i(TAG, "onReceivedHttpError status=" + status);
                maybeAutoPair();
            }

            /**
             * A failed main-frame load would otherwise leave the user on Chromium's bare
             * error page with no way forward, so fall back to the settings screen with an
             * explanation and keep the address in the field so it can be corrected.
             */
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request != null && !request.isForMainFrame()) return;
                String reason = error == null ? "" : String.valueOf(error.getDescription());
                pageAlive = false;
                // A recovery is already in flight. Retrying the address here is what defeated it:
                // this callback arrives right after the 401 on the bare address, and `connect()`
                // picked the same cookieless address again, so the auth page came back and the
                // phone never reached the flow that mints a fresh session.
                if (recovering) {
                    Log.i(TAG, "onReceivedError: recovery in flight, not retrying the address");
                    return;
                }
                // Retry the whole address choice once. The previous code went straight to
                // the settings screen, so a momentary network blip (or the wrong address
                // being picked before a probe had run) cost the user a manual reconnect.
                String origin = lastLoadedOrigin;
                if (!TextUtils.isEmpty(origin) && reloadRetriedFor.add(origin)) {
                    Log.i(TAG, "onReceivedError: retrying the address choice after " + reason);
                    statusText.setText("连接失败（" + reason + "），正在重试…");
                    showLoadHint(true, "连接失败，正在重试…");
                    connect();
                    return;
                }
                showConfigScreen();
                statusText.setText("连接失败：" + reason
                        + "\n请检查地址是否可达（宿主是否在运行、地址是否已因重启而变化）。");
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progress.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
                progress.setProgress(newProgress);
                // Reveal the page as soon as it is mostly there: waiting for 100% on a slow
                // link holds the hint over an already usable interface.
                if (newProgress >= 70) {
                    showLoadHint(false, null);
                    // The opening frame is NOT dismissed here. Progress 70% means the document
                    // arrived; the harness then spends a noticeable moment loading its plugins and
                    // painting its own "Loading plugins…" screen. Fading out on progress revealed
                    // that screen and then replaced it, which is the abrupt hand-off this avoids —
                    // see revealWhenBooted() for what is waited for instead.
                    revealWhenBooted();
                }
            }

            /**
             * Let the page open the phone's file picker.
             *
             * A WebView does not implement this by default, so a page's "attach" or
             * "upload image" control does nothing without it. ACTION_GET_CONTENT also
             * surfaces the system photo picker on modern Android, so no storage permission
             * prompt is needed for the common case.
             */
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = callback;

                Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType("*/*");
                // Only ask for images when the page asked for images, so a page that wants a
                // PDF still gets the full browser.
                String[] accept = params == null ? null : params.getAcceptTypes();
                if (accept != null) {
                    for (String type : accept) {
                        if (type != null && type.startsWith("image/")) {
                            pick.setType("image/*");
                            break;
                        }
                    }
                }
                if (params != null && params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                    pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                }
                try {
                    startActivityForResult(Intent.createChooser(pick, "选择文件"), REQUEST_FILE);
                } catch (Exception e) {
                    filePathCallback = null;
                    Log.w(TAG, "file chooser failed: " + e);
                    Toast.makeText(MainActivity.this, "无法打开文件选择器：" + e.getMessage(),
                            Toast.LENGTH_LONG).show();
                    return false;
                }
                Log.i(TAG, "onShowFileChooser: launched picker");
                return true;
            }
        });

        Button connectBtn = findViewById(R.id.connectBtn);
        Button scanBtn = findViewById(R.id.scanBtn);
        Button discoverBtn = findViewById(R.id.discoverBtn);
        Button discoverBtnIp = findViewById(R.id.discoverBtnIp);
        Button pasteBtn = findViewById(R.id.pasteBtn);
        tailscaleState = findViewById(R.id.tailscaleState);
        openTailscaleBtn = findViewById(R.id.openTailscaleBtn);
        if (openTailscaleBtn != null) openTailscaleBtn.setOnClickListener(v -> openTailscaleApp());
        Button pairScanBtn = findViewById(R.id.pairScanBtn);
        Button pairTailscaleBtn = findViewById(R.id.pairTailscaleBtn);
        Button ipBackBtn = findViewById(R.id.ipBackBtn);
        Button ipContinueBtn = findViewById(R.id.ipContinueBtn);

        connectBtn.setOnClickListener(v -> connect());
        discoverBtn.setOnClickListener(v -> discoverHost());
        discoverBtnIp.setOnClickListener(v -> discoverHost());
        pairScanBtn.setOnClickListener(v -> launchScanner());
        pairTailscaleBtn.setOnClickListener(v -> startTailscalePairing());
        ipBackBtn.setOnClickListener(v -> showPairingScreen(true));
        ipContinueBtn.setOnClickListener(v -> showConfigScreen());
        scanBtn.setOnClickListener(v -> launchScanner());

        // The Tailscale guide. Its own entry points are the pairing button (which needs the install
        // instructions before it can work) and, for someone already on the address screen, the link
        // there. It is never forced on anyone.
        Button howBtnIp = findViewById(R.id.tailscaleHowBtnIp);
        Button guideBackBtn = findViewById(R.id.guideBackBtn);
        Button guideDoneBtn = findViewById(R.id.guideDoneBtn);
        Button tailscaleDownloadBtn = findViewById(R.id.tailscaleDownloadBtn);
        if (howBtnIp != null) howBtnIp.setOnClickListener(v -> showTailscaleGuide());
        if (guideBackBtn != null) guideBackBtn.setOnClickListener(v -> closeTailscaleGuide());
        if (guideDoneBtn != null) guideDoneBtn.setOnClickListener(v -> closeTailscaleGuide());
        if (tailscaleDownloadBtn != null) {
            tailscaleDownloadBtn.setOnClickListener(v -> openTailscaleDownload());
        }


        Button clearCacheBtn = findViewById(R.id.clearCacheBtn);
        if (clearCacheBtn != null) {
            clearCacheBtn.setOnClickListener(v -> {
                clearAppCaches(true);
                updateCacheText();
            });
        }

        if (pasteBtn != null) {
            pasteBtn.setOnClickListener(v -> fillFromClipboard(secretInput.getText().toString().trim()));
        }
        // The settings button now sits in the middle of the bar, where the history arrows were.
        if (barSettingsBtn != null) {
            barSettingsBtn.setOnClickListener(v -> {
                Log.i(TAG, "bar: settings from the top bar");
                showConfig();
            });
        }
        // The retracted tab: the arrow restores the bar, and settings stays reachable from it —
        // otherwise retracting the bar would take away the only entry point to the address screen.
        android.view.View expandBtn = findViewById(R.id.barExpandBtn);
        if (expandBtn != null) {
            expandBtn.setOnClickListener(v -> {
                Log.i(TAG, "bar: expand tapped");
                setBarAutoHidden(false);
            });
        }
        android.view.View tabSettings = findViewById(R.id.barTabSettingsBtn);
        if (tabSettings != null) {
            tabSettings.setOnClickListener(v -> {
                Log.i(TAG, "bar: opening the pairing menu from the tab");
                showPairingScreen(true);
            });
        }
        // The two ends of the settings detour: the menu offers the display options, and those options
        // offer the way back. Without the second, leaving them depends on the system back gesture.
        android.view.View pairingDisplay = findViewById(R.id.pairingDisplayBtn);
        if (pairingDisplay != null) {
            pairingDisplay.setOnClickListener(v -> {
                Log.i(TAG, "pairing menu: opening the display and storage settings");
                showConfig();
            });
        }
        // Manual entry from the menu itself, so it never depends on an automatic attempt failing first.
        //
        // It used to be reachable only as a consequence: the Tailscale button opened the address screen
        // when it found nothing stored, and nothing else did. A user holding the address already, or
        // whose Tailscale could not be reached at all, therefore had no way to type it — reported as
        // 「现在我没法进入手动连接的界面啊」.
        android.view.View pairingManual = findViewById(R.id.pairingManualBtn);
        if (pairingManual != null) {
            pairingManual.setOnClickListener(v -> {
                Log.i(TAG, "pairing menu: manual address entry");
                // The field is locked once an address is stored, so arriving here has to unlock it —
                // otherwise the button does nothing visible on exactly the devices that have a stale
                // address to replace.
                manualAddressEntry = true;
                showIpScreen();
            });
        }
        android.view.View configBack = findViewById(R.id.configBackBtn);
        if (configBack != null) {
            configBack.setOnClickListener(v -> {
                Log.i(TAG, "config: back to the pairing menu");
                showPairingScreen(true);
            });
        }
        updateNavButtons();

        // The bar is no longer a tap target. It used to carry a click handler on the whole strip, and
        // that made every swipe that began on it a click instead — observed as the app jumping to the
        // pairing menu when a scroll gesture was started near the top of the page. The two buttons on
        // the bar are the controls; the space between them belongs to the page.
        //
        // "返回主页" is still one tap away (the right-hand button), the settings button sits in the
        // middle, and the gesture that replaces the removed whole-bar click is a swipe in from the left
        // edge, which cannot be confused with a scroll.
        // Both bar controls go to the same place from here: the pairing menu *is* the settings screen.
        //
        // Asked for as 「点击设置后进入配对菜单页面」. The menu already carries the settings a user
        // needs mid-session — 「Tailscale 配对」 when away, 「扫码 / 配对链接」 to re-pair, and
        // 「在同一 WIFI 下自动发现宿主」 — so a separate settings panel beside it would be a second
        // front door to the same room. The gear opens it; 返回主页 leaves it.
        // The gear opens the settings menu; the button on the right leaves it.
        //
        // Both were "settings" for a moment, which is what made the bar confusing. With the menu as the
        // settings screen, the only useful thing left for the right-hand button is the way back to the
        // page — and a way back is exactly what a menu opened over a live session needs.
        if (barSettingsBtn != null) {
            barSettingsBtn.setOnClickListener(v -> {
                Log.i(TAG, "bar: gear -> the pairing menu");
                showPairingScreen(true);
            });
        }
        if (topBar != null) {
            // Explicitly not clickable: the default for a LinearLayout is false, and setting it to
            // true here previously made the whole bar swallow page gestures.
            topBar.setClickable(false);
            topBar.setOnClickListener(null);
            topBar.setOnLongClickListener(null);
            topBar.setOnTouchListener(null);
        }
        // Long-press on the page belongs to the page: that is how text is selected and how
        // Chromium's copy/paste menu opens. Nothing in the shell may claim it, so no
        // long-click listener is attached to the WebView at all.

        // Display options. Each group is built here rather than declared in XML: three
        // mutually exclusive buttons are easier to keep in step in code, and the layout
        // stays free of a fixed set of ids.
        buildOptionGroup(findViewById(R.id.fontGroup), new String[]{
                getString(R.string.option_font_small),
                getString(R.string.option_font_normal),
                getString(R.string.option_font_large)},
                new int[]{85, 100, 120},
                () -> prefs.getInt(KEY_FONT, 100),
                value -> {
                    prefs.edit().putInt(KEY_FONT, value).apply();
                    applyFontPreference();
                });
        buildOptionGroup(findViewById(R.id.themeGroup), new String[]{
                getString(R.string.option_theme_system),
                getString(R.string.option_theme_light),
                getString(R.string.option_theme_dark)},
                new int[]{0, 1, 2},
                () -> prefs.getInt(KEY_THEME, 0),
                value -> {
                    prefs.edit().putInt(KEY_THEME, value).apply();
                    applyThemePreference();
                    // A night-mode change only takes effect on a fresh theme, so the
                    // activity is restarted. The page flag keeps the WebView from
                    // re-downloading, so this reads as a redraw rather than a reload.
                    recreate();
                });

        immersiveCheck.setChecked(prefs.getBoolean(KEY_IMMERSIVE, false));
        immersiveCheck.setOnCheckedChangeListener((button, checked) -> {
            prefs.edit().putBoolean(KEY_IMMERSIVE, checked).apply();
            applyImmersivePreference();
        });

        motionCheck.setChecked(prefs.getBoolean(KEY_MOTION, true));
        motionCheck.setOnCheckedChangeListener((button, checked) -> {
            prefs.edit().putBoolean(KEY_MOTION, checked).apply();
            if (!checked) resetBarAutoHide();
        });

        // In immersive mode the bar is hidden, so a swipe down from the top edge brings it
        // back. Without this there would be no way out of the mode on-device.
        final GestureDetector gestures = new GestureDetector(this,
                new GestureDetector.SimpleOnGestureListener() {
                    @Override
                    public boolean onDown(MotionEvent e) {
                        return true;
                    }

                    @Override
                    public boolean onFling(MotionEvent from, MotionEvent to, float vx, float vy) {
                        if (from == null || to == null) return false;
                        // Every fling is logged while this is being tuned: a gesture that produces no
                        // log at all is a different problem from one that is logged and not matched,
                        // and the two were indistinguishable here — a left-edge swipe and a top-edge
                        // swipe both left the log empty, which said the events were never arriving
                        // rather than that the conditions were wrong.
                        Log.i(TAG, "onFling: from=" + Math.round(from.getX()) + "," + Math.round(from.getY())
                                + " to=" + Math.round(to.getX()) + "," + Math.round(to.getY()));
                        // The horizontal swipe -> home gesture is deliberately NOT handled here.
                        //
                        // It existed so the pairing menu (the app's home) stayed reachable even when
                        // the top bar was retracted, and it worked from either edge in both
                        // directions. On a real phone it turned out to fire during ordinary use:
                        // a horizontal drag inside the page — selecting text, nudging a wide table
                        // or code block, an imprecise vertical scroll — was read as "go home" and
                        // threw the user out of the session. Reported as 「把侧滑返回关了」.
                        //
                        // The menu did not lose its only door: the gear (barSettingsBtn) opens it,
                        // and the system back gesture reaches handleBack(), which routes to the
                        // pairing menu from the page. Both are intentional taps, so neither can be
                        // triggered by a stray drag.
                        //
                        // The top-edge pull below is kept: without it immersive mode has no exit.
                        boolean downward = to.getY() - from.getY() > 60;
                        if (downward && from.getY() < 160) {
                            Log.i(TAG, "immersive: swipe from the top reveals the bar");
                            setImmersiveMode(false);
                            return true;
                        }
                        return false;
                    }
                });
        // The detector is attached to the page rather than to the root layout on purpose:
        // a touch listener on a parent sees ACTION_DOWN before its children, so it would
        // swallow every tap meant for the settings controls. Nothing is inside the WebView,
        // so listening there is safe.
        //
        // The listener must return false. Consuming ACTION_DOWN hands the whole sequence to
        // this view, so the page receives neither a click nor a scroll — which is exactly how
        // touch stopped working, and why the page's own counters stayed at zero while the
        // native log showed events arriving. The gesture detector still sees its events;
        // returning false only means the WebView is not robbed of them.
        webView.setOnTouchListener((view, event) -> {
            gestures.onTouchEvent(event);
            // Every touch while this is being tuned, not the first twelve. The cap was there to stop a
            // drag flooding the log, but it also meant that by the time a gesture was tested the
            // counter was long spent — and "no log" was then misread as "no touch reached the app".
            Log.i(TAG, "touch: action=" + event.getActionMasked()
                    + " at " + Math.round(event.getX()) + "," + Math.round(event.getY()));
            return false;
        });

        applyThemePreference();

        String savedUrl = prefs.getString(KEY_URL, "");
        String savedUrl2 = prefs.getString(KEY_URL2, "");
        String savedToken = prefs.getString(KEY_TOKEN, "");
        String savedSecret = prefs.getString(KEY_SECRET, "");
        // Repair stored state before it is read or written back. A 1.x build saved the whole
        // pairing link into the address field, so the stored "address" can be
        // `http://host/m/pair?t=OLD`; loading that on every launch redeems a token that was
        // spent long ago and the host answers 403 — indistinguishable to the user from a
        // broken app, and impossible to clear from inside the UI.
        String[] repaired = migrateStoredTarget(savedUrl, savedToken);
        // A pairing token is single-use by design, so a stored one is spent by definition:
        // redeeming it again can only produce 403. Nothing is lost by discarding it, because
        // the flows that do work never rely on it — a scan carries a fresh token inside the
        // link it hands over, and a paired device authenticates with its session cookie.
        if (!savedToken.isEmpty()) {
            Log.i(TAG, "onCreate: discarding the stored single-use token (len="
                    + savedToken.length() + ")");
            savedToken = "";
        }
        Log.i(TAG, "onCreate storage: url='" + redactSecret(savedUrl)
                + "' secretLen=" + savedSecret.length()
                + " | address after repair='" + redactSecret(repaired[0]) + "'");
        savedUrl = repaired[0];
        urlInput.setText(savedUrl);
        urlInput2.setText(savedUrl2);
        tokenInput.setText(savedToken);
        secretInput.setText(savedSecret);

        // Clear any link the system restored into the field before a new intent is handled.
        // `pairingLink` holds a single-use token, and a recreated activity (a theme switch,
        // for instance) brings the old value back; loading it again redeems a token the host
        // has already consumed. `handleIntent` and the scan flow set a fresh one below.
        pairingLink = null;

        handleIntent(getIntent());

        applyPreferences();
        // What the previous session left on screen, for deciding what to show. Deliberately
        // not the same thing as "the WebView has a live page": in a fresh process it does not,
        // whatever the previous one recorded.
        pageWasShowing = prefs.getBoolean(KEY_WEB_LOADED, false);
        pageAlive = false;
        hideAllScreens();
        refreshRestoreState();

        // Cache housekeeping, before the first load so a stale copy is never served.
        setBrowserCacheLimits();
        maintainCachesOnLaunch();

        // One decision, made once, for a launch that was not handed a link.
        //
        // These were two fragments in two places — a branch here and a branch in onResume — and they
        // disagreed: onResume connected whenever the previous session had shown a page, while this
        // showed the pairing menu whenever the stored address was empty, and the two together
        // produced a launch with neither an address nor a page. `url=null bodyLen=0` on device.
        initializeLaunch();
        // Registered last, once every panel exists: the callback can fire the moment it is
        // registered, and handleBack() reads the panels' visibility.
        registerBackCallback();
    }

    /**
     * Whether this app holds a pairing cookie for any address it knows about.
     *
     * Used at launch to tell "a paired device that has lost its address" from "a brand new device".
     * The cookie is the evidence: the host writes it when a pairing is redeemed and it lives in the
     * WebView's store, so it outlives the address field.
     */
    private boolean hasAnyDeviceCookie() {
        return firstOriginWithSession() != null;
    }

    /**
     * Leave the settings menu for the page, if there is one to return to.
     *
     * The distinction matters: a session that has already loaded a page just needs the panel revealed
     * again, while a launch that never connected must actually connect. Reloading blindly would throw
     * away a live page, and only showing it would leave a device that never connected staring at an
     * empty one.
     */
    private void returnHome() {
        if (pageAlive && webView != null && webView.getUrl() != null) {
            Log.i(TAG, "returnHome: revealing the page that is already loaded");
            showWebScreen();
            return;
        }
        if (!TextUtils.isEmpty(urlInput.getText().toString())) {
            Log.i(TAG, "returnHome: connecting");
            connect();
            return;
        }
        Log.i(TAG, "returnHome: nothing to return to, finding the host");
        showWebScreen();
        discoverHost();
    }

    /**
     * Decide what a launch that was handed no link should show, and start it.
     *
     * Written as one method because the decision was previously split between `onCreate` and
     * `onResume`, and the two halves disagreed. `onCreate` showed the pairing menu whenever the stored
     * address was empty; `onResume` connected whenever the previous session had shown a page. On a
     * device whose address preference was empty but whose `KEY_WEB_LOADED` flag was still true — which
     * is exactly what a preference wipe leaves behind — the result was a launch that connected to
     * nothing and showed nothing: observed on device as `url=null bodyLen=0` with a black screen.
     *
     * Order matters, and it is by how much each source proves:
     *   1. A stored address is the normal case and is tried first.
     *   2. Otherwise a session cookie, which is durable and is proof of a completed pairing, decides
     *      the address — re-pairing a paired device is the bug this fixes.
     *   3. Only with neither is this genuinely a first run, and the pairing menu is the answer.
     */
    private void initializeLaunch() {
        if (launchInitialized) return;             // Runs from onCreate and onResume; only once.
        launchInitialized = true;
        repairTailscaleScheme();
        if (getIntent().getData() != null) return; // A link will drive this launch.
        if (pageAlive) return;                     // A live page needs no decision.

        if (!TextUtils.isEmpty(urlInput.getText().toString())) {
            connect();
            return;
        }
        final String known = firstOriginWithSession();
        if (known != null) {
            Log.i(TAG, "initializeLaunch: no stored address, but a session exists for " + known
                    + " — reconnecting instead of pairing again");
            urlInput.setText(known);
            connect();
            return;
        }
        // Nothing points at a host. The pairing menu is the home screen, and it is shown *while* the
        // search runs behind it.
        //
        // Asked for as 「先显示菜单，同时后台自动搜索，找到就自动连上」, and the shape suits both
        // audiences: a returning user sees the app open on something familiar and is taken to the page a
        // moment later without touching anything, while a first-time user gets the explanation and the
        // choices immediately instead of watching a spinner with no context. Searching first and then
        // deciding what to show would make everyone wait for a sweep that usually answers in well under a
        // second and, when it fails, has nothing to report but the delay.
        //
        // A first-run guide used to come before the menu — Tailscale install instructions, then "how
        // this works", then the menu. It was removed because it answered a question the user had not
        // asked yet. The install guide belongs to the moment someone chooses Tailscale, which is why the
        // 「Tailscale 配对」 entry shows it now; three screens became one.
        //
        // The mark still comes first: this launch has no page to load, so without it the app opens on a
        // bare menu with no indication of what opened. Same icon and timing as a page launch, so the two
        // read as one app rather than two behaviours.
        Log.i(TAG, "initializeLaunch: nothing stored and no session — menu, with discovery behind it");
        splash.playIntro();
        brandedOpening = true;
        splash.dismissAfter(BRANDED_OPENING_MS);
        showPairingScreen(false);
        // Cleared after the mark is gone, so a later return to this menu (back from a guide, for
        // instance) dismisses instantly as it always did.
        splash.postDelayed(() -> { brandedOpening = false; }, BRANDED_OPENING_MS + 400);
        statusText.setText(R.string.discovering);
        discoverText.setText(R.string.discovering);
        discoveryAttempted = true;
        discoverHost();
    }

    /**
     * Rewrite stored `https://` addresses that should be `http://`.
     *
     * A repair rather than a migration: the bug that wrote them is fixed, but the value it wrote
     * survives in preferences, and a device carrying it cannot connect at all. Reinstalling does not
     * help — preferences persist across an upgrade — so the wrong address has to be corrected in
     * place, once, on the way in.
     *
     * Only Tailscale-shaped hosts are touched: `.ts.net` names and `100.64/10` literals. An address
     * the user deliberately gave as https (a reverse proxy, a public tunnel) is left alone.
     */
    private void repairTailscaleScheme() {
        // Fields holding more than one address, from the build that packed them with a newline. Only
        // the first is kept: a field holds one address, and the rest are re-learned from the host.
        for (String key : new String[]{KEY_URL, KEY_URL2, KEY_TS_NAME}) {
            String stored = prefs.getString(key, "");
            if (stored == null || stored.indexOf('\n') < 0) continue;
            String first = stored.split("\n")[0].trim();
            Log.i(TAG, "repairTailscaleScheme: " + key + " held several addresses, keeping " + first);
            prefs.edit().putString(key, first).apply();
            if (KEY_URL.equals(key)) urlInput.setText(first);
            if (KEY_URL2.equals(key)) urlInput2.setText(first);
        }
        for (String key : new String[]{KEY_URL, KEY_URL2, KEY_TS_NAME}) {
            String stored = prefs.getString(key, "");
            if (stored == null || !stored.startsWith("https://")) continue;
            String host = originOf(stored).replaceFirst("^https?://", "");
            int colon = host.lastIndexOf(':');
            if (colon > 0) host = host.substring(0, colon);
            if (!isTailscaleHostName(host)) continue;
            String fixed = "http://" + stored.substring("https://".length());
            Log.i(TAG, "repairTailscaleScheme: " + key + " https -> http for " + host);
            prefs.edit().putString(key, fixed).apply();
            if (KEY_URL.equals(key)) urlInput.setText(fixed);
            if (KEY_URL2.equals(key)) urlInput2.setText(fixed);
        }
    }

    /** Whether a host is a Tailscale MagicDNS name or a `100.64/10` literal. */
    private static boolean isTailscaleHostName(String host) {
        if (host == null || host.isEmpty()) return false;
        if (host.toLowerCase(java.util.Locale.ROOT).endsWith(".ts.net")) return true;
        String[] parts = host.split("\\.");
        if (parts.length != 4) return false;
        try {
            return Integer.parseInt(parts[0]) == 100
                    && Integer.parseInt(parts[1]) >= 64
                    && Integer.parseInt(parts[1]) <= 127;
        } catch (NumberFormatException ignored) {
            return false;
        }
    }

    /**
     * Fade the opening frame once the page has actually painted its interface.
     *
     * Why not on load progress: progress reports the *document*, and the harness boots after that —
     * it loads plugins and shows its own "Loading plugins…" screen for a while. Dismissing the mark
     * at that point revealed that screen, which then changed again: two hand-offs where the user
     * should see one. Reported as "太快了" and "进 harness 的时候也这样改".
     *
     * The signal used is whether the harness's own interface has been laid out with a real size. An
     * earlier attempt tested for a `__dshBoot` global, and that was wrong: searching the harness
     * bundle for the identifier finds no definition anywhere, so the probe could only succeed by
     * accident and the mark stayed up until the deadline — which is why the reveal got *slower*, not
     * smoother. What holds regardless of version is that a painted shell fills the viewport while
     * "Loading plugins…" does not: the boot screen is a centred placeholder, so the document stays
     * small until the app itself is on screen.
     *
     * If the probe never succeeds — an older host, a page that is not the harness at all, a failed
     * load — the deadline fires and the mark fades anyway, so this can delay a reveal but never
     * withhold one. The splash's own watchdog is the final backstop.
     */
    private void revealWhenBooted() {
        if (splash == null || !splash.isShowing()) return;
        final long started = System.currentTimeMillis();
        splash.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (splash == null || !splash.isShowing()) return;
                if (System.currentTimeMillis() - started > BOOT_REVEAL_DEADLINE_MS) {
                    Log.i(TAG, "revealWhenBooted: deadline reached, revealing anyway");
                    splash.dismiss();
                    return;
                }
                if (webView == null) {
                    splash.dismiss();
                    return;
                }
                webView.evaluateJavascript(
                        "(function(){try{"
                        + "var b=document.body;if(!b)return '0';"
                        + "return (b.scrollHeight>window.innerHeight*0.7&&b.scrollWidth>200)?'1':'0';"
                        + "}catch(e){return '0'}})()",
                        value -> {
                            if (value != null && value.contains("1")) {
                                Log.i(TAG, "revealWhenBooted: the interface filled the viewport");
                                if (splash != null) splash.dismiss();
                            } else {
                                splash.postDelayed(this, BOOT_POLL_MS);
                            }
                        });
            }
        }, BOOT_POLL_MS);
    }

    /** How often the boot probe runs while the opening frame is up. */
    private static final long BOOT_POLL_MS = 250;
    /**
     * How long the boot probe waits before revealing regardless.
     *
     * Short on purpose: it is a fallback for the probe failing, not a budget for the load. If the
     * interface has not filled the viewport within this window, holding the mark over it helps nobody
     * and reads as a hang — the page keeps loading behind it either way.
     */
    private static final long BOOT_REVEAL_DEADLINE_MS = 6000;

    /**
     * The Tailscale APK this project mirrors, for phones that cannot reach Google Play.
     *
     * Why a mirror exists: Google Play is unreachable from mainland China, and Tailscale's own
     * download page leads there for Android. The official direct APK (pkgs.tailscale.com) does work
     * from China, so this is not a rescue — it is a second, version-pinned copy, published as a
     * release asset because the file is 100.6 MB and a repository refuses anything over 100 MB.
     * It is the official universal build, unmodified; the SHA-256 is in the release notes.
     */
    private static final String TAILSCALE_APK_MIRROR =
            "https://github.com/Yunnianan/dsh-mobile/releases/download/"
            + "tailscale-android-1.104.1/tailscale-android-universal-1.104.1.apk";
    /** Tailscale's own package host: same file, and reachable from China. */
    private static final String TAILSCALE_APK_OFFICIAL =
            "https://pkgs.tailscale.com/stable/tailscale-android-universal-1.104.1.apk";

    /**
     * Start the Tailscale download.
     *
     * The APK link rather than a product page, because the product page sends Android to Google Play,
     * and for a large part of this app's audience that is a dead end. The mirror is tried first: it
     * is version-pinned to what this release documented, so the file a user installs is the file the
     * SHA-256 was published for.
     *
     * A store link was tried in an earlier revision and a vendor ROM handed the `market://` scheme to
     * the browser instead of the store, so the "clever" route was the unpredictable one — a plain
     * HTTPS URL is what every Android build already knows how to follow.
     */
    private void openTailscaleDownload() {
        Log.i(TAG, "openTailscaleDownload: opening the mirrored APK");
        if (!openInBrowser(TAILSCALE_APK_MIRROR)) {
            // Only reached when no browser could take an https URL at all, which is rare — but the
            // official host is the same bytes and costs nothing to fall back to.
            Log.w(TAG, "openTailscaleDownload: mirror did not open, trying the official host");
            openInBrowser(TAILSCALE_APK_OFFICIAL);
        }
    }


    /**
     * Whether the Tailscale app is installed.
     *
     * Checked so the install step can be skipped: someone who already runs Tailscale does not need
     * to be told to install it, and being told anyway reads as the app not paying attention.
     */
    private boolean isTailscaleInstalled() {
        try {
            getPackageManager().getApplicationInfo(TAILSCALE_PACKAGE, 0);
            Log.i(TAG, "isTailscaleInstalled: yes");
            return true;
        } catch (android.content.pm.PackageManager.NameNotFoundException absent) {
            Log.i(TAG, "isTailscaleInstalled: no (" + absent.getMessage() + ")");
            return false;
        } catch (Exception other) {
            // Logged rather than swallowed: a lookup that fails for some other reason must not be
            // indistinguishable from a device that genuinely does not have the app.
            Log.w(TAG, "isTailscaleInstalled: lookup failed, assuming absent: " + other);
            return false;
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        // `resumed` distinguishes a real return to the app from the first resume, which
        // happens immediately after onCreate and must not be treated as "coming back".
        boolean returning = resumed;
        resumed = true;
        if (!returning) {
            // A fresh process has no page, whatever the previous session recorded, so the launch
            // decision is made here — once, by the method that owns it. `onResume` used to call
            // connect() on its own, which is how a launch with an empty address ended up connecting
            // to nothing at all.
            initializeLaunch();
            return;
        }
        applyImmersivePreference();
        refreshRestoreState();
        // Coming back from the Tailscale app: the switch the user went to turn on is the only thing
        // that was missing, so continue the pairing instead of making them press the button again.
        if (awaitingTailscaleReturn) {
            awaitingTailscaleReturn = false;
            updateTailscaleState();
            if (isTailscaleTunnelUp()) {
                Log.i(TAG, "onResume: returned from Tailscale with the tunnel up, continuing");
                statusText.setText("Tailscale 已连接，正在配对…");
                revealStatus();
                connect();
            } else {
                Log.i(TAG, "onResume: returned from Tailscale but the tunnel is still down");
                statusText.setText(getString(R.string.tailscale_off));
                revealStatus();
            }
            return;
        }
        if (!pageAlive) {
            Log.i(TAG, "onResume: no live page in this process, restoring it");
            restoreWebPage();
        } else {
            Log.i(TAG, "onResume: keeping the live page (no reload)");
            // The key may have been rotated while the app was away, so only the stored
            // copy is refreshed; the page itself is left exactly as it was.
            syncSecretFromHost();
        }
    }

    @Override
    protected void onPause() {
        resumed = false;
        // Stop sampling the page's scroll position: nothing is visible to retract a bar for, and a
        // background WebView answering JavaScript every 250ms is pure battery.
        webPageGone = true;
        scrollWatchStarted = false;
        // Remember that a page is on screen, so the next launch can judge whether a
        // reload is actually needed. The WebView itself keeps its DOM and scroll
        // position; this flag is only about the download.
        prefs.edit().putBoolean(KEY_WEB_LOADED,
                pageAlive && webView != null && webView.getUrl() != null).apply();
        super.onPause();
    }

    /**
     * Restore the page after the WebView lost its content (process death or a renderer
     * kill), without pretending to be a fresh connection.
     */
    private void restoreWebPage() {
        String url = prefs.getString(KEY_URL, "");
        if (TextUtils.isEmpty(url)) return;
        Log.i(TAG, "restore: reloading " + url);
        showLoadHint(true, "正在恢复上次的页面…");
        connect();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    /** Accept a pairing link handed over by a scanner or another app. */
    private void handleIntent(Intent intent) {
        if (intent == null || intent.getData() == null) return;
        Uri data = intent.getData();
        // Housekeeping commands. Useful on their own (`dshmobile://clearcache` is quicker than
        // opening settings, and works from adb), and they make the cache path testable on a
        // device without a debuggable build.
        if ("dshmobile".equals(data.getScheme())) {
            String command = data.getHost() == null ? data.getPath() : data.getHost();
            command = command == null ? "" : command.replace("/", "");
            if (command.equalsIgnoreCase("clearcache")) {
                Log.i(TAG, "handleIntent: clearcache requested");
                clearAppCaches(true);
                return;
            }
            if (command.equalsIgnoreCase("diag")) {
                // Report what the page thinks is wrong. The host keeps no log file and the
                // plugins that fail are client-side, so their errors exist only in the
                // browser console — this reads that back into logcat.
                Log.i(TAG, "handleIntent: diag requested");
                runPageDiagnostics();
                return;
            }
            if (command.equalsIgnoreCase("onboard")) {
                // Kept as a way back to the pairing menu from adb: some vendor builds refuse
                // `pm clear` (HyperOS does), so there is no other way to reach it on a device that
                // is already paired. It used to reopen the first-run guide, which no longer exists.
                Log.i(TAG, "handleIntent: onboard requested, showing the pairing menu");
                hideEveryPanel();
                showPairingScreen(true);
                return;
            }
        }
        String url = data.getQueryParameter("url");
        // A second address may travel with the link so a single scan configures both the
        // reachable-anywhere address and the fast-on-this-network one.
        String url2 = data.getQueryParameter("url2");
        String token = data.getQueryParameter("token");
        // A one-time auto-pair key may travel with the link, so a device can be set up in a
        // single hand-off instead of typing the key on the phone.
        String secret = data.getQueryParameter("secret");

        // A link that carries setup details is already the result of the pairing step, so the
        // first-run guide must not get in front of it: the user has been told what to do and has
        // done it. Skipping it also marks the guide as seen, because this hand-off is proof the
        // user knows the flow.
        if (url != null || secret != null || token != null) {
            Log.i(TAG, "handleIntent: a pairing hand-off arrived");
        }
        if (url == null && ("http".equals(data.getScheme()) || "https".equals(data.getScheme()))) {
            url = data.toString();
        }
        if (url2 != null && !url2.trim().isEmpty()) {
            String normalized2 = normalizeUrl(url2);
            if (normalized2 != null) {
                urlInput2.setText(normalized2);
                prefs.edit().putString(KEY_URL2, normalized2).apply();
                Log.i(TAG, "handleIntent: fallback address supplied with the link");
            }
        }
        if (secret != null && !secret.trim().isEmpty()) {
            secretInput.setText(secret.trim());
            prefs.edit().putString(KEY_SECRET, secret.trim()).apply();
            Log.i(TAG, "handleIntent: auto-pair key supplied with the link");
        }
        Target target = resolveTarget(url, token);
        if (target == null) {
            Log.w(TAG, "handleIntent: unusable url=" + url);
            return;
        }
        Log.i(TAG, "handleIntent: raw=" + url
                + " -> url=" + target.url
                + " tokenLen=" + target.token.length()
                + " pairing=" + target.pairing);
        // The incoming link is authoritative, including when it carries no token. Leaving a
        // previously stored token in place made a plain-address deep link reuse an
        // already-spent token, which the host answers with "link expired".
        tokenInput.setText(target.token);
        urlInput.setText(target.url);
        prefs.edit().putString(KEY_URL, target.url)
                .putString(KEY_TOKEN, target.token).apply();
        connect();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_FILE) {
            // The callback must be answered exactly once — with null when nothing was
            // chosen — or the page's input stays permanently disabled.
            if (filePathCallback == null) return;
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    result = new Uri[count];
                    for (int i = 0; i < count; i++) {
                        result[i] = data.getClipData().getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    result = new Uri[]{data.getData()};
                }
            }
            Log.i(TAG, "file chooser result: " + (result == null ? "cancelled" : result.length + " item(s)"));
            filePathCallback.onReceiveValue(result);
            filePathCallback = null;
            return;
        }
        if (requestCode == REQUEST_SCAN && resultCode == RESULT_OK && data != null) {
            String contents = data.getStringExtra("SCAN_RESULT");
            // Log what was scanned, redacting the key. Without this a scan is ambiguous
            // after the fact: several codes look alike once rendered, and a stale one is
            // indistinguishable from a current one except by the token it carries.
            Log.i(TAG, "scanned: " + redactSecret(contents));
            // A scanned code is normally a pairing link, so it goes through the same split:
            // origin into the address field, token into the token field — and, unlike the
            // earlier revision, the key and fallback address it carries are kept too. Dropping
            // the key meant a rescan fell back to the *stored* key, which is stale as soon as
            // the host rotates it, and the host answers that with 403.
            Target target = resolveTarget(contents, null);
            if (target == null) {
                Log.w(TAG, "scanned code is not a usable pairing link");
                return;
            }
            Log.i(TAG, "scanned token=" + target.token + " origin=" + target.url
                    + " hasKey=" + (target.secret != null)
                    + " hasFallback=" + (target.url2 != null));
            if (!target.token.isEmpty()) tokenInput.setText(target.token);
            urlInput.setText(target.url);
            if (target.secret != null) {
                secretInput.setText(target.secret);
                prefs.edit().putString(KEY_SECRET, target.secret).apply();
                // The code is current and authoritative, so an earlier refusal must not
                // stand in its way.
                autoPairPausedUntil = 0;
            }
            if (target.url2 != null) {
                String normalized2 = normalizeUrl(target.url2);
                if (normalized2 != null) {
                    urlInput2.setText(normalized2);
                    prefs.edit().putString(KEY_URL2, normalized2).apply();
                }
            }
            // The scanned link's token is spent by this very navigation, so the settings
            // fields keep only the origin and the token goes into the saved value, which is
            // what the auto-pair fallback then uses if the redemption is refused.
            prefs.edit().putString(KEY_TOKEN, target.token).apply();
            connect();
        }
    }

    /** Replace the auto-pair key in a URL with a marker, for logging. */
    private static String redactSecret(String raw) {
        if (raw == null) return "null";
        return raw.replaceAll("secret=[^&]*", "secret=…");
    }

    /**
     * Repair a stored address that is really a whole pairing link.
     *
     * <p>An earlier build saved the link verbatim into the address field. That value is then
     * loaded on every launch, redeeming a one-time token that was consumed the first time, so
     * the host answers 403 forever and the app has no way to clear it from its own UI.
     *
     * <p>Split apart here: the origin is what belongs in the address field, and the token is
     * only worth keeping if it is not already the one embedded in the URL — in which case it
     * is the stale one and is dropped, leaving the key-based path as the way back in.
     *
     * @return {address, token}
     */
    private static String[] migrateStoredTarget(String url, String token) {
        String address = url == null ? "" : url.trim();
        String storedToken = token == null ? "" : token.trim();
        if (address.isEmpty()) return new String[]{"", storedToken};

        String normalized = normalizeUrl(address);
        Uri parsed = Uri.parse(normalized == null ? address : normalized);
        boolean looksLikePairLink = parsed.getPath() != null
                && parsed.getPath().startsWith("/m/pair");
        boolean hasQuery = parsed.getQuery() != null && !parsed.getQuery().isEmpty();
        if (!looksLikePairLink && !hasQuery) {
            // A plain origin: nothing to repair.
            return new String[]{address, storedToken};
        }

        String linkToken = parsed.getQueryParameter("t");
        String origin = originOf(address);
        if (linkToken != null && !linkToken.trim().isEmpty()) {
            // The token inside the URL is the one that was already spent, so the preserved
            // token is deliberately not it.
            android.util.Log.i(TAG, "migrateStoredTarget: address was a pairing link -> " + origin);
            return new String[]{origin, ""};
        }
        android.util.Log.i(TAG, "migrateStoredTarget: stripped query from the address -> " + origin);
        return new String[]{origin, storedToken};
    }

    /**
     * Fill the address and key fields from the clipboard.
     *
     * <p>Accepts all three shapes a user is likely to have copied — a full pairing link, a
     * bare address, or just the key — and routes them through the same
     * {@link #resolveTarget} path the deep link uses, so a pasted pairing link cannot
     * reintroduce the "link stored as an address" bug.
     */
    private void fillFromClipboard(String knownSecret) {
        ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard == null || !clipboard.hasPrimaryClip()
                || clipboard.getPrimaryClip() == null
                || clipboard.getPrimaryClip().getItemCount() == 0) {
            statusText.setText(R.string.paste_empty);
            return;
        }
        ClipData.Item item = clipboard.getPrimaryClip().getItemAt(0);
        CharSequence text = item.getText();
        String raw = text == null ? "" : text.toString().trim();
        if (raw.isEmpty()) {
            statusText.setText(R.string.paste_empty);
            return;
        }
        Log.i(TAG, "paste: " + redactSecret(raw));

        Target target = resolveTarget(raw, null);
        if (target != null && !TextUtils.isEmpty(target.url)) {
            urlInput.setText(target.url);
            if (!target.token.isEmpty()) tokenInput.setText(target.token);
            // A pairing link carries the key too; taking it saves finding it separately.
            String key = Uri.parse(raw).getQueryParameter("secret");
            secretInput.setText(key == null || key.trim().isEmpty() ? knownSecret : key.trim());
            statusText.setText(R.string.paste_filled);
            return;
        }

        // Not a URL: most likely just the one-time key, which is the only bare value the
        // settings screen asks for besides an address.
        secretInput.setText(raw);
        statusText.setText(R.string.paste_filled);
    }

    /**
     * Build one row of mutually exclusive option buttons.
     *
     * @param selected supplies the current value so the right button starts highlighted
     * @param onPick   receives the chosen value
     */
    private void buildOptionGroup(LinearLayout group, String[] labels, int[] values,
                                  java.util.concurrent.Callable<Integer> selected,
                                  java.util.function.IntConsumer onPick) {
        if (group == null) return;
        group.removeAllViews();
        final Button[] buttons = new Button[labels.length];
        for (int i = 0; i < labels.length; i++) {
            final int value = values[i];
            Button button = new Button(this);
            button.setText(labels[i]);
            button.setTextSize(14f);
            button.setAllCaps(false);
            button.setMinHeight(dp(44));
            button.setBackgroundResource(R.drawable.option_button);
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                    0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
            if (i > 0) params.setMarginStart(dp(8));
            button.setLayoutParams(params);
            button.setOnClickListener(v -> {
                onPick.accept(value);
                refreshOptionSelection(group, values, selected);
            });
            buttons[i] = button;
            group.addView(button);
        }
        refreshOptionSelection(group, values, selected);
    }

    /** Highlight the option that matches the stored value. */
    private void refreshOptionSelection(LinearLayout group, int[] values,
                                        java.util.concurrent.Callable<Integer> selected) {
        if (group == null) return;
        int current;
        try {
            Integer value = selected.call();
            current = value == null ? values[0] : value;
        } catch (Exception e) {
            current = values[0];
        }
        for (int i = 0; i < group.getChildCount() && i < values.length; i++) {
            group.getChildAt(i).setSelected(values[i] == current);
        }
    }

    private int dp(int value) {
        return Math.round(getResources().getDisplayMetrics().density * value);
    }

    // --- cache ----------------------------------------------------------------------

    /**
     * Cap what the page is allowed to keep on disk.
     *
     * A WebView leaves its HTTP cache and its script storage unbounded by default, and this
     * app runs a heavy client: every session it ever loaded stays behind. These limits are
     * far above what one copy of the client needs, so normal use never hits them — they exist
     * so that "eventually" has a ceiling.
     */
    private void setBrowserCacheLimits() {
        String stored = prefs.getString(KEY_URL, "");
        String origin = originOf(stored == null ? "" : stored);
        // Only meaningful once an origin is known; the quota is per origin, so an empty
        // string would apply it to nothing.
        if (TextUtils.isEmpty(origin) || !origin.startsWith("http")) return;
        try {
            android.webkit.WebStorage.getInstance().setQuotaForOrigin(origin, 100L * 1024 * 1024);
            Log.i(TAG, "cache: script-storage quota set for " + origin);
        } catch (Throwable t) {
            Log.w(TAG, "cache: cannot set the script-storage quota: " + t);
        }
    }

    /**
     * Cache housekeeping that runs by itself.
     *
     * Two cases, both of which otherwise mean an old copy of the client is served forever:
     * the app was upgraded (its scripts changed), or the caches simply grew too large.
     */
    private void maintainCachesOnLaunch() {
        int versionCode = versionCode();
        int known = prefs.getInt(KEY_CACHE_VERSION, 0);
        boolean upgraded = known != versionCode;
        long size = cacheSizeBytes();
        boolean oversized = size > CACHE_CEILING_BYTES;
        // Once a day, whatever the size.
        //
        // The other two triggers are both rare: an upgrade happens when a build is installed, and the
        // ceiling only trips at 400 MB. Between them the client can serve a copy of itself from weeks ago,
        // because a page whose assets are cached is never fetched again even after the host's build has
        // moved on — and "why is the phone showing the old behaviour" has no visible cause.
        //
        // Asked for as 「每天自动清缓存」. Daily is the interval that separates a session's in-memory page
        // from the cost of re-fetching: the page is untouched (only the on-disk copy goes), and at most
        // one launch a day pays for reloading the client.
        long now = System.currentTimeMillis();
        long lastSweep = prefs.getLong(KEY_CACHE_SWEPT_AT, 0L);
        boolean dueForSweep = now - lastSweep >= CACHE_SWEEP_INTERVAL_MS;

        if (!upgraded && !oversized && !dueForSweep) {
            Log.i(TAG, "cache: kept (" + (size / 1024) + " KB, version " + versionCode
                    + ", recorded " + known + ", swept " + ((now - lastSweep) / 60000) + " min ago)");
            updateCacheText();
            return;
        }
        // Each of the three says the copy on disk may not match the host: a different build wrote it, it
        // has grown too large, or a day has passed. All three are answered the same way.
        Log.i(TAG, "cache: clearing (recorded=" + known + " installed=" + versionCode
                + " oversized=" + oversized + " dueForSweep=" + dueForSweep
                + " size=" + (size / 1024) + "KB)");
        clearAppCaches(false);
        // Recorded only after a clear has been requested, so a failure here is retried on the next launch
        // instead of leaving the stale assets in place for good. The sweep time is recorded for the same
        // reason: a clear that did not happen must not be remembered as having happened.
        prefs.edit()
                .putInt(KEY_CACHE_VERSION, versionCode)
                .putLong(KEY_CACHE_SWEPT_AT, now)
                .apply();
        updateCacheText();
    }

    /**
     * Drop the cached page data.
     *
     * Deliberately not `CookieManager.removeAllCookies`: the device cookie is the pairing,
     * and clearing it would make an already-paired phone start over. Cache only.
     */
    private void clearAppCaches(boolean manual) {
        long before = cacheSizeBytes();
        Log.i(TAG, "cache: before clear, " + cacheBreakdown());
        try {
            // WebStorage also drops IndexedDB and the service worker's Cache Storage, which
            // is where a modern client keeps the bulk of its assets. Cookies live in
            // CookieManager and are untouched.
            android.webkit.WebStorage.getInstance().deleteAllData();
        } catch (Throwable t) {
            Log.w(TAG, "cache: WebStorage clear failed: " + t);
        }
        if (webView != null) {
            webView.clearCache(true);
            webView.freeMemory();
        }
        // The live page keeps whatever it already loaded in memory; only the on-disk copy is
        // gone, so this is a re-fetch next time rather than a blank screen now.
        //
        // The deletion is asynchronous inside Chromium, so the size is read on a later frame.
        // Reading it immediately reported "15881 KB -> 15880 KB" and made a working clear look
        // like a no-op.
        if (statusText != null || cacheText != null) {
            View anchor = cacheText != null ? cacheText : statusText;
            anchor.postDelayed(() -> {
                long after = cacheSizeBytes();
                Log.i(TAG, "cache: cleared, " + (before / 1024) + " KB -> " + (after / 1024)
                        + " KB, " + cacheBreakdown());
                if (manual) {
                    Toast.makeText(this, "缓存已清除（" + fmtBytes(before) + " → " + fmtBytes(after)
                            + "），配对不受影响", Toast.LENGTH_LONG).show();
                }
                updateCacheText();
            }, 1200);
        }
    }

    /** Refresh the storage row on the settings screen. */
    private void updateCacheText() {
        if (cacheText == null) return;
        long size = cacheSizeBytes();
        cacheText.setText("已用缓存：" + fmtBytes(size)
                + (size > CACHE_CEILING_BYTES ? "（超过上限，下次启动自动清理）" : ""));
    }

    /** Everything this app keeps on disk for the page: HTTP cache plus script storage. */
    private long cacheSizeBytes() {
        return directorySize(getCacheDir()) + directorySize(webViewDataDir());
    }

    /** Chromium's profile directory: script storage, service worker caches, its HTTP cache. */
    private java.io.File webViewDataDir() {
        java.io.File files = getFilesDir();
        java.io.File dataDir = files == null ? null : files.getParentFile();
        return dataDir == null ? null : new java.io.File(dataDir, "app_webview");
    }

    /** A short breakdown, for the log only: guessing which directory grew is not diagnosis. */
    private String cacheBreakdown() {
        java.io.File web = webViewDataDir();
        return "cacheDir=" + (directorySize(getCacheDir()) / 1024) + "KB"
                + " app_webview=" + (directorySize(web) / 1024) + "KB"
                + " present=" + (web != null && web.exists());
    }

    private static long directorySize(java.io.File dir) {
        if (dir == null || !dir.exists()) return 0L;
        long total = 0L;
        java.io.File[] children = dir.listFiles();
        if (children == null) return 0L;
        for (java.io.File child : children) {
            total += child.isDirectory() ? directorySize(child) : child.length();
        }
        return total;
    }

    private static String fmtBytes(long bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return (bytes / 1024) + " KB";
        return String.format(java.util.Locale.US, "%.1f MB", bytes / 1048576.0);
    }

    /** The installed version code, or 0 when it cannot be read. */
    private int versionCode() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionCode;
        } catch (Exception e) {
            return 0;
        }
    }

    /** Apply every stored display preference. Safe to call before the WebView exists. */
    private void applyPreferences() {
        applyFontPreference();
        applyThemePreference();
        applyImmersivePreference();
        applyShellColors();
    }

    /**
     * Give the shell's own screens their surface and text colours explicitly.
     *
     * The labels used to inherit their colour from the activity theme. That is fine until a
     * UI skin plugin rewrites the theme attributes this profile resolves against, at which
     * point the shell's labels can end up the same colour as their background — the app looks
     * broken while the page inside the WebView is perfectly fine, because the page carries
     * its own styling. Setting them here makes the shell independent of whatever the theme
     * has been turned into.
     *
     * Children are walked rather than relying on inheritance, because `EditText` and
     * `CheckBox` resolve their text colour at construction and keep it.
     */
    private void applyShellColors() {
        int surface = color(R.color.shell_surface, 0xFFFFFFFF);
        int text = color(R.color.shell_text, 0xFF1B1B1B);
        int dim = color(R.color.shell_text_dim, 0xFF5A5A5A);

        for (View screen : setupScreens()) {
            if (screen == null) continue;
            screen.setBackgroundColor(surface);
            paintText(screen, text, dim);
        }
        // The page's own bar. It is not in `setupScreens()` on purpose — the panel behind it is the
        // page, so painting a shell background there would cover the page — and that exclusion also
        // meant its labels were never recoloured. "返回主页" therefore kept the borderless button
        // colour from the platform theme and read as washed out against the light bar.
        //
        // `hostText` is skipped: it sits at 75% alpha by design, as the address is context rather
        // than a control. Everything else on the bar takes the primary colour, so the button is as
        // legible as the settings screens' own buttons, in both light and dark.
        if (topBar instanceof android.view.ViewGroup) {
            android.view.ViewGroup bar = (android.view.ViewGroup) topBar;
            for (int i = 0; i < bar.getChildCount(); i++) {
                View child = bar.getChildAt(i);
                if (!(child instanceof TextView)) continue;
                if (child == hostText) continue;
                ((TextView) child).setTextColor(text);
            }
        }
        // The status line is the one place the user reads while something is wrong, so it
        // keeps the dimmer colour explicitly rather than inheriting the brighter one.
        if (statusText != null) statusText.setTextColor(dim);
    }

    /** A colour already resolved against the current night mode. */
    @SuppressWarnings("deprecation")
    private int color(int resId, int fallback) {
        try {
            return getResources().getColor(resId, getTheme());
        } catch (Exception e) {
            return fallback;
        }
    }

    /**
     * Recolour every label under a view.
     *
     * The three views that carry secondary text keep a dimmer colour; everything else that
     * shows text gets the primary one. Buttons and fields are included on purpose — they are
     * as capable of inheriting a broken theme colour as a plain label is.
     */
    private void paintText(View view, int text, int dim) {
        if (view instanceof TextView) {
            // Anything without an id is one of the explanatory lines in the layouts — the
            // introductory paragraphs and the address note — so it takes the softer colour.
            // Buttons and fields all carry ids, so they keep the primary one.
            boolean secondary = view.getId() == View.NO_ID
                    || view == discoverText || view == statusText;
            ((TextView) view).setTextColor(secondary ? dim : text);
        }
        if (!(view instanceof ViewGroup)) return;
        ViewGroup group = (ViewGroup) view;
        for (int i = 0; i < group.getChildCount(); i++) {
            paintText(group.getChildAt(i), text, dim);
        }
    }

    /**
     * Font size, expressed against the system's own scale.
     *
     * `setTextZoom` takes a percentage of the *default* size, so the system scale is
     * folded in here; otherwise a user who enlarged text system-wide would see this app
     * shrink it back.
     */
    private void applyFontPreference() {
        int percent = prefs.getInt(KEY_FONT, 100);
        int system = Math.round(getResources().getConfiguration().fontScale * 100f);
        int zoom = Math.max(50, Math.min(200, Math.round(system * percent / 100f)));
        if (webView != null) {
            webView.getSettings().setTextZoom(zoom);
        }
        LinearLayout group = findViewById(R.id.fontGroup);
        if (group != null) {
            refreshOptionSelection(group, new int[]{85, 100, 120}, () -> prefs.getInt(KEY_FONT, 100));
        }
        Log.i(TAG, "font: system=" + system + "% local=" + percent + "% -> zoom=" + zoom + "%");
    }

    /** Light/dark follows the stored choice; the activity theme carries it to the WebView. */
    @SuppressWarnings("deprecation")
    private void applyThemePreference() {
        int theme = prefs.getInt(KEY_THEME, 0);
        UiModeManager manager = (UiModeManager) getSystemService(UI_MODE_SERVICE);
        if (manager != null) {
            // 0 means follow the system, expressed as clearing the app's own override. That
            // also means a later change to the system setting reaches this app, which is what
            // "follow the system" has to mean.
            int mode = Configuration.UI_MODE_NIGHT_UNDEFINED;
            if (theme == 1) mode = Configuration.UI_MODE_NIGHT_NO;
            if (theme == 2) mode = Configuration.UI_MODE_NIGHT_YES;
            manager.setNightMode(mode);
        }
        LinearLayout group = findViewById(R.id.themeGroup);
        if (group != null) {
            refreshOptionSelection(group, new int[]{0, 1, 2}, () -> prefs.getInt(KEY_THEME, 0));
        }
    }

    /** Store and apply the immersive flag, then relayout so the insets follow. */
    private void applyImmersivePreference() {
        setImmersiveMode(prefs.getBoolean(KEY_IMMERSIVE, false));
    }

    /**
     * Named `setImmersiveMode` rather than `setImmersive` on purpose: the framework's
     * Activity already declares `setImmersive(boolean)`, and an instance method with that
     * signature fails to compile against it.
     */
    private void setImmersiveMode(boolean immersive) {
        immersiveActive = immersive;
        prefs.edit().putBoolean(KEY_IMMERSIVE, immersive).apply();
        if (immersiveCheck != null && immersiveCheck.isChecked() != immersive) {
            immersiveCheck.setChecked(immersive);
        }
        if (topBar != null) {
            topBar.setVisibility(immersive ? View.GONE : View.VISIBLE);
        }
        applySystemBars(immersive);
        // The page behind the bars decides whether the bar icons must go dark; the scrim
        // itself is always off, since a scrim over this UI reads as a stray band.
        applyLightBarIcons();
        // Both the live padding and the insets that are still stored change with the mode,
        // so one pass is applied immediately and another is requested for the redraw.
        applyInsets(null);
        View root = findViewById(android.R.id.content);
        if (root != null) root.requestApplyInsets();
    }

    /** Cached immersive flag, read by the inset listener before `prefs` exists. */
    private boolean immersiveActive;

    /** The last insets seen, so a mode change can re-apply them without waiting for one. */
    private WindowInsets lastInsets;

    /**
     * Let the window draw behind the system bars.
     *
     * `Window#setDecorFitsSystemWindows` covers API 30+, and the platform attribute covers
     * the rest, so no androidx dependency is needed. The bar colours are cleared at the same
     * time: left as they are, the platform paints a grey band along the top of a light page,
     * which is the same complaint as the black strip in a lighter shade.
     */
    @SuppressWarnings("deprecation")
    private void setDecorFitsSystemWindows(boolean fits) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(fits);
        } else {
            getWindow().getDecorView().setSystemUiVisibility(fits
                    ? View.SYSTEM_UI_FLAG_VISIBLE
                    : View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
        if (!fits) {
            getWindow().setStatusBarColor(android.graphics.Color.TRANSPARENT);
            getWindow().setNavigationBarColor(android.graphics.Color.TRANSPARENT);
        }
    }

    /** Whether the current configuration is a dark theme, which decides the bar icons. */
    private boolean isNightMode() {
        int mode = getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        return mode == Configuration.UI_MODE_NIGHT_YES;
    }

    /**
     * Choose bar icons that can be seen against the shell's own background, and keep the
     * platform's own scrim off.
     *
     * When the window draws behind the bars, the platform normally paints a translucent
     * scrim so its icons stay legible; against a light page that scrim reads as a grey band
     * along the top — the same complaint as the black strip, in a lighter colour. The icon
     * colour comes from the theme, so this is correct in both themes and after a switch.
     */
    private void applyLightBarIcons() {
        setBarIconAppearance(!isNightMode());
    }

    /**
     * Apply the light/dark icon appearance to both system bars.
     *
     * @param darkIcons true when the bars sit on a light background, so the icons must be dark
     */
    @SuppressWarnings("deprecation")
    private void setBarIconAppearance(boolean darkIcons) {
        View decor = getWindow().getDecorView();
        // Below API 30 there is no WindowInsetsController, so the legacy flags are the only
        // way to ask for dark icons on a light bar.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            int flags = decor.getSystemUiVisibility();
            flags = darkIcons
                    ? (flags | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                            | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR)
                    : (flags & ~(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                            | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR));
            decor.setSystemUiVisibility(flags);
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return;
        WindowInsetsController controller = decor.getWindowInsetsController();
        if (controller == null) return;
        int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
        controller.setSystemBarsAppearance(darkIcons ? mask : 0, mask);
    }

    /**
     * The system's light/dark setting changed while the app is running.
     *
     * `uiMode` is declared in configChanges, so the activity is not recreated; the things
     * that do not follow from resources on their own — the bar icons and the splash layer's
     * background colour — are re-applied here. The window background and the settings
     * controls follow from the theme, and the page follows through the WebView.
     */
    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        boolean night = (newConfig.uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
        Log.i(TAG, "configuration changed: night=" + night + " — re-applying shell colours");
        // Follow the system again if that is the stored choice; an explicit choice was
        // already applied when it was picked.
        applyThemePreference();
        setBarIconAppearance(!night);
        if (splash != null) splash.applyThemeColors();
        applyShellColors();
        applyFontPreference();
    }

    /**
     * Put the system-bar insets where they belong: below the status bar for the top bar,
     * and around the page for the content.
     *
     * The WebView is given the inset as padding rather than having its content pushed by an
     * outer container, because padding on the view itself shrinks the page's viewport and
     * makes the web content reflow — which is what "shrink to fit" should mean. The window
     * background is light (see `AppTheme`), so the padded bands match the page instead of
     * showing up as black strips.
     *
     * @param insets fresh insets, or null to re-use the last ones
     */
    private void applyInsets(WindowInsets insets) {
        if (insets != null) lastInsets = insets;
        WindowInsets current = lastInsets;

        // In immersive mode the bars are gone, so every inset is dropped and the page uses
        // the whole panel. This runs before the null check so the padding is always reset.
        if (immersiveActive) {
            if (topBar != null) topBar.setPadding(dp(16), 0, dp(16), 0);
            if (webView != null) webView.setPadding(0, 0, 0, 0);
            for (View screen : setupScreens()) {
                if (screen != null) screen.setPadding(dp(24), dp(24), dp(24), dp(24));
            }
            return;
        }
        if (current == null) return;

        int top;
        int bottom;
        int left;
        int right;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            android.graphics.Insets bars = current.getInsets(WindowInsets.Type.systemBars());
            top = bars.top;
            bottom = bars.bottom;
            left = bars.left;
            right = bars.right;
        } else {
            top = current.getSystemWindowInsetTop();
            bottom = current.getSystemWindowInsetBottom();
            left = current.getSystemWindowInsetLeft();
            right = current.getSystemWindowInsetRight();
        }

        if (topBar != null) {
            topBar.setPadding(dp(16) + left, top, dp(16) + right, 0);
        }
        if (webView != null) {
            // No top padding: the page already starts below the bar. The bottom inset keeps
            // the last line clear of the navigation bar.
            webView.setPadding(0, 0, 0, bottom);
        }
        for (View screen : setupScreens()) {
            if (screen != null) {
                screen.setPadding(dp(24) + left, dp(24) + top, dp(24) + right, dp(24) + bottom);
            }
        }
    }

    /**
     * Hide the status and navigation bars for real full screen.
     *
     * Only the status bar is hidden at first level; both go when immersive is on, because
     * the shell's own top bar is gone then and nothing else indicates the mode.
     */
    private void applySystemBars(boolean immersive) {
        View decor = getWindow().getDecorView();
        if (immersive) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                WindowInsetsController controller = decor.getWindowInsetsController();
                if (controller != null) {
                    controller.hide(WindowInsets.Type.statusBars()
                            | WindowInsets.Type.navigationBars());
                    controller.setSystemBarsBehavior(
                            WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                }
            } else {
                decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
            }
        } else {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                WindowInsetsController controller = decor.getWindowInsetsController();
                if (controller != null) {
                    controller.show(WindowInsets.Type.statusBars()
                            | WindowInsets.Type.navigationBars());
                }
            } else {
                decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
            }
        }
    }

    /**
     * Find the host on this network and connect to it.
     *
     * Runs on a background thread: the sweep is a few hundred milliseconds of socket work
     * and must not block the UI. The discovered host goes into the *fallback* field when a
     * primary address already exists, so the existing probe logic keeps preferring the
     * reachable-anywhere address and the LAN path stays a fast option.
     */
    private void discoverHost() {
        // On mobile data there is no home network to sweep, so the sweep is skipped and the Tailscale
        // route is taken instead.
        //
        // Measured: `discover: local ipv4=10.53.135.94` then `nothing found in 24088ms` — twenty-four
        // seconds of scanning a carrier subnet that cannot contain the host, before the app got to the
        // one address that might answer. The network type is known in advance, so the user should not
        // pay for the wrong answer to be discovered.
        // Off Wi-Fi, the Tailscale route is taken directly — no second probe to check it first.
        //
        // It used to be gated on `tailscaleReachable()`, and that gate is what broke the case it was
        // written for. Measured, WiFi off: `connect: chose http://100.82.206.124:19387 (reachable=true)`
        // — the address had *just* answered — then, two seconds later, `tryTailscalePairing:
        // 100.82.206.124 did not answer`, and the sweep ran for 24 seconds over the carrier subnet.
        // A Tailscale path is not a steady thing: it moves between direct and relay, and a probe is a
        // single sample of it. Checking twice doubles the chance of sampling a moment that misses, and
        // the failure mode is the worst one — the app abandons the only address that can work and
        // reports that there is no host.
        //
        // The network type is the fact worth using: off Wi-Fi, no LAN address can answer, so there is
        // nothing to lose by trying Tailscale immediately and nothing to gain by confirming it first.
        if (!isOnWifi()) {
            Log.i(TAG, "discover: off Wi-Fi — taking the Tailscale route instead of sweeping");
            discovering = false;
            // The menu stays up while this is arranged. Switching to the page area before there is a
            // session shows an empty page — asked for as 「未连接上时显示配置菜单，连接上才变 Harness」.
            showWebScreen();
            if (tryTailscalePairing()) return;
            promptForTailscaleAddress();
            return;
        }
        if (discovering) return;
        discovering = true;
        Log.i(TAG, "discover: starting");
        discoverText.setText(R.string.discovering);
        // The other line is set here too, so the two never describe different attempts — that mismatch
        // was the visible symptom: 「正在扫描同WiFi设备」 above 「正在连接」, from two runs.
        if (statusText != null) statusText.setText(R.string.discovering);
        new Thread(() -> {
            String phoneIp = localIpv4();
            Log.i(TAG, "discover: local ipv4=" + phoneIp);
            // The sweep is given the port from the field, which discovery itself fills in from the
            // host's status response. See scanPort() for the fallback order.
            int wantedPort = scanPort();
            LanScanner scanner = new LanScanner(wantedPort, message -> Log.i(TAG, message));
            LanScanner.Found found = scanner.scan(phoneIp);
            runOnUiThread(() -> {
                discovering = false;
                if (found == null) {
                    // Nothing on this network — the expected answer on mobile data. Before reporting
                    // that, try the one route that works from outside: the host's Tailscale address.
                    //
                    // This is the case the whole Tailscale path exists for, and it was not being used.
                    // Measured on device, away from home: the sweep ran for 24 seconds over the
                    // carrier's subnet and reported nothing, while `100.82.206.124` and the MagicDNS
                    // name were both answering 200 — the app had the working address in hand and never
                    // tried to pair over it. A request that arrives over Tailscale is approved by the
                    // host on tailnet identity alone, so this needs no click on the desktop.
                    if (tryTailscalePairing()) {
                        discoverText.setText("正在通过 Tailscale 配对…");
                        return;
                    }
                    // Nothing on this network, and no Tailscale address answered either. Saying only
                    // "没有找到" leaves the user with nowhere to go, so the app offers the one screen that
                    // can accept an address.
                    //
                    // Asked for as 「tailscale状态下没跳到填IP区域啊」. The Tailscale path is the one tried
                    // from outside the house, so when it does not answer — the tunnel is down, still
                    // coming up, or the relay is unreachable — the address screen is the only place the
                    // user can act, and it is also where the Tailscale address is entered in the first
                    // place. Off Wi-Fi belongs here too: the stored LAN address cannot answer from
                    // there, so nothing else on offer would work either.
                    if (preferTailscaleAfterDiscovery || !isOnWifi()) {
                        promptForTailscaleAddress();
                        return;
                    }
                    discoverText.setText(R.string.err_no_host);
                    return;
                }
                // The port is part of the address, not a detail of the probe.
                //
                // `LanScanner.Found.host` is deliberately a bare IP (it is used as a connect
                // target, and the scanner treats the port as its own constant), so building the URL
                // from it without appending the port produced `http://192.168.31.56` — which the
                // WebView dutifully fetched on port 80 and reported as a load failure, while the
                // host was listening perfectly well on 19387. Observed after an APK upgrade cleared
                // the stored address, which sent the app down this discovery path.
                String origin = "http://" + found.host + ":" + found.port;
                if (found.port != wantedPort) {
                    Log.i(TAG, "discover: the host listens on " + found.port + ", not " + wantedPort);
                }
                adoptDiscoveredPort(found.port);
                // Re-validate before using it: a sweep result can be a few seconds old by
                // the time the user acts on it.
                //
                // `found.host` — a bare IP — is the right argument here, and getting this wrong twice
                // is why the liveness check kept reporting a healthy host as dead:
                //
                //   * passing only the host was thought to be the bug, because the probe "must be
                //     using the wrong port". It is not: `looksLikeHost(ip, port)` builds the request
                //     itself and takes the port separately.
                //   * so the "fix" was to pass the full origin instead, which made it try to resolve a
                //     host literally named `http://192.168.31.56:19387` — an immediate failure, and
                //     `alive=false` on a host that was answering 200. That also stopped the pairing
                //     step below from ever running, because `alive` gates the message and the address
                //     path, so the user still landed on the auth page.
                // No liveness re-check.
                //
                // There used to be one — `looksLikeHost(found.host, found.port)` — and it caused
                // more harm than good. Its budget is a single connection with 600 ms to connect and
                // 700 ms to answer, which is right for a sweep probe but too tight for a host that
                // is busy, and it was observed reporting `alive=false` on a host that was answering
                // perfectly. Since the sweep had *just* received a valid status response from this
                // exact address, the re-check could only ever contradict a fresher fact, and when
                // it did the user was sent down the "no longer responding" path for a working host.
                // The address is used as discovered; if it has genuinely gone stale, the page load
                // that follows is what discovers that, with a real error rather than a guess.
                discoverText.setText("已找到 " + origin
                        + (found.tailscaleOrigin == null ? "" : "（该宿主也提供 " + found.tailscaleOrigin + "）"));

                String primary = normalizeUrl(urlInput.getText().toString());
                String tail = found.tailscaleOrigin == null
                        ? null : normalizeUrl(found.tailscaleOrigin);
                if (preferTailscaleAfterDiscovery && tail != null) {
                    // The user asked for Tailscale by name. Both addresses are still stored and both
                    // get probed, so being at home still takes the faster LAN path — but the
                    // Tailscale one goes in the field that is tried first, because away from home it
                    // is the only one that answers.
                    preferTailscaleAfterDiscovery = false;
                    urlInput.setText(tail);
                    urlInput2.setText(origin);
                    Log.i(TAG, "discover: Tailscale pairing asked for it, "
                            + tail + " is primary and " + origin + " is the fallback");
                } else if (TextUtils.isEmpty(primary)) {
                    // Nothing configured yet: the discovered host becomes the primary
                    // address, and the tunnel address the host advertises (if any) becomes
                    // the fallback so the pair also works away from this network.
                    urlInput.setText(origin);
                    if (tail != null && !tail.equals(origin)) urlInput2.setText(tail);
                } else {
                    // A primary address already exists, so the discovered host goes into
                    // the fallback field and the existing probe keeps preferring the
                    // reachable-anywhere address.
                    urlInput2.setText(origin);
                }
                // A device that is already paired to the discovered host needs no pairing at all.
                //
                // This check comes first because everything below it is a *re*-pairing path, and the
                // code used to run them unconditionally: with a live session it still fetched the
                // auto-pair key, minted a link and redeemed it. When that redemption did not come
                // back the screen sat on "正在完成配对…" indefinitely — with a perfectly usable address
                // one line away. Reported as 「WIFI自动搜索模式下又无法连接了，显示正在完成配对」.
                // The session cookie is the evidence that the work is already done, and it is scoped
                // to this exact origin, so finding one here is conclusive.
                if (hasSessionFor(origin)) {
                    Log.i(TAG, "discover: this device already has a session for " + origin
                            + ", connecting instead of pairing again");
                    if (TextUtils.isEmpty(urlInput.getText().toString())) urlInput.setText(origin);
                    connect();
                    return;
                }
                // A discovered address is not a paired device.
                //
                // Discovery only proves the host is there; it does not settle the session. Loading
                // the address alone therefore lands on the host's "authentication required" page,
                // which reads as a black screen — the report that produced this code. Pairing needs
                // the auto-pair key, and discovery cannot invent one.
                String secret = secretInput.getText().toString().trim();
                if (!secret.isEmpty() && pairingLink == null) {
                    Log.i(TAG, "discover: a key is stored, completing the pairing");
                    statusText.setText("已找到 " + origin + "，正在配对…");
                    // The key may be stale — the host rotates it, and a phone that has been away can
                    // be holding a value the host no longer recognises, which it answers with 403.
                    // The retry loop lives in the retry state, not here: this is the user asking to
                    // pair, so a refusal is reported and followed by the one recovery that works
                    // without them knowing a secret was wrong (asking the desktop).
                    remindForPairing(secret, () -> askDesktopToPair(origin));
                    return;
                }
                // No key in the fields. Before giving up, ask the WebView whether this device still
                // holds a session — a device that is still paired can read the current key from
                // `/m/api/session`, and that is a real recovery rather than a re-scan. The fetch is
                // asynchronous, so it continues on its own; the address load below is unaffected.
                Log.i(TAG, "discover: no key in the fields, trying to recover one from the session");
                recoverSecretFromSession(origin, recovered -> {
                    if (recovered != null && !recovered.isEmpty()) {
                        Log.i(TAG, "discover: recovered the key from the session, pairing");
                        statusText.setText("已找到 " + origin + "，正在配对…");
                        remindForPairing(recovered);
                        return;
                    }
                    // Nothing to reuse. Ask the desktop instead: a request appears in the panel and
                    // becomes a link only when a human clicks Allow there. That click is the point —
                    // being on the same network proves nothing, because every other device on the
                    // Wi-Fi is too.
                    //
                    // The menu stays up. It carries the status text and, more importantly, the buttons
                    // that offer an alternative while the desktop click is pending — showing the page
                    // area here would replace a screen that can still act with an empty one. Asked for
                    // as 「未连接上时显示配置菜单，等连接上时才变成 Harness」.
                    Log.i(TAG, "discover: found the host, asking the desktop (menu stays up)");
                    askDesktopToPair(origin);
                });
            });
        }).start();
    }

    /**
     * Pair over the host's Tailscale address, if one of them answers.
     *
     * The route that works from outside the house, and the only one that needs nothing from the
     * desktop: the host asks its own tailnet who the requesting address belongs to, and a device in the
     * operator's tailnet has already been authenticated by Tailscale. The LAN paths all need something
     * that is back home — the QR code, the auto-pair key, or a click on the panel.
     *
     * Returns true when a candidate answered and the request has been started, so the caller does not
     * also report "host not found" for a host that was in fact found.
     */
    private boolean tryTailscalePairing() {
        // The probes run on a background thread, and the result comes back to the UI thread.
        //
        // This is not tidiness. `probe()` opens a connection, and Android throws
        // NetworkOnMainThreadException for that on the main thread — measured:
        // `probe http://100.82.206.124:19387 -> NetworkOnMainThreadException: null`, twice, from the
        // calls made here. The exception was caught and read as "the address did not answer", so the
        // Tailscale route reported itself unavailable every single time it was tried from a UI-thread
        // caller. This method had never been able to succeed through those paths.
        new Thread(() -> {
            // The address that answered most recently is tried first, because it is the only one with
            // evidence behind it. A Tailscale path moves between direct and relay, so a probe is a
            // sample rather than a state — and the earlier this runs, the closer it is to the
            // successful sample that caused it to run.
            java.util.List<String> candidates = tailscaleAddresses();
            String last = lastReachableOrigin;
            if (last != null && candidates.contains(last)) {
                candidates.remove(last);
                candidates.add(0, last);
                Log.i(TAG, "tryTailscalePairing: trying the address that just answered first: " + last);
            }
            String found = null;
            for (String candidate : candidates) {
                if (probe(candidate)) {
                    Log.i(TAG, "tryTailscalePairing: " + candidate + " answered — pairing over Tailscale");
                    found = candidate;
                    break;
                }
                Log.i(TAG, "tryTailscalePairing: " + candidate + " did not answer");
            }
            // Nothing answered on this pass. The address the earlier probe chose is still worth asking:
            // it answered once, moments ago, and a request costs one round trip.
            if (found == null && lastReachableOrigin != null && !lastReachableOrigin.isEmpty()) {
                Log.i(TAG, "tryTailscalePairing: nothing answered, but " + lastReachableOrigin
                        + " answered earlier — asking it to pair anyway");
                found = lastReachableOrigin;
            }
            if (found == null) {
                Log.i(TAG, "tryTailscalePairing: no Tailscale address answered");
                return;
            }
            final String candidate = found;
            runOnUiThread(() -> {
                // The menu stays up: the page area is for a session that exists. See discoverHost.
                urlInput.setText(candidate);
                statusText.setText("正在通过 Tailscale 配对…（按 tailnet 身份自动确认，无需在电脑上点）");
                revealStatus();
                askDesktopToPair(candidate);
            });
        }).start();
        // Reported as started: the caller's job was to choose this route, and the outcome arrives
        // asynchronously through askDesktopToPair.
        return true;
    }

    /**
     * The port the LAN sweep should probe.
     *
     * Order: what the field says, then the last value discovery filled in, then the default. Reading
     * the field first means a deliberately typed port wins; falling back to the stored value means a
     * port learned from the host survives an app restart.
     */
    private int scanPort() {
        String typed = portInput == null ? "" : portInput.getText().toString().trim();
        if (typed.isEmpty()) typed = prefs.getString(KEY_PORT, "");
        try {
            int port = Integer.parseInt(typed.trim());
            if (port > 0 && port <= 65535) return port;
        } catch (NumberFormatException ignored) {
            // Anything unparseable falls through to the default rather than failing the sweep.
        }
        return LanScanner.DEFAULT_PORT;
    }

    /**
     * Show the port discovery just learned, and remember it.
     *
     * This is the "read the port out by itself and fill it in" half: the sweep probes a ladder of
     * ports, the host answers with the port it is actually listening on, and that value lands here —
     * so the next sweep starts from the right port instead of guessing again.
     */
    private void adoptDiscoveredPort(int port) {
        if (port <= 0 || port > 65535) return;
        if (portInput != null) portInput.setText(String.valueOf(port));
        prefs.edit().putString(KEY_PORT, String.valueOf(port)).commit();
        Log.i(TAG, "discover: adopted port " + port);
    }

    /** Store whatever port the field currently holds, so a typed value is not lost. */
    private void rememberScanPort() {
        int port = scanPort();
        prefs.edit().putString(KEY_PORT, String.valueOf(port)).commit();
    }

    /**
     * Whether an address belongs to Tailscale's range, 100.64.0.0/10.
     *
     * Duplicated from the plugin rather than shared: the two live on different machines and in
     * different languages, and this is twelve lines of range check that the plugin's own tests pin
     * down on its side.
     */
    private static boolean isTailscaleOrigin(String origin) {
        if (origin == null) return false;
        java.util.regex.Matcher matcher = java.util.regex.Pattern
                .compile("^https?://(\\d{1,3})\\.(\\d{1,3})\\.").matcher(origin.trim());
        if (!matcher.find()) return false;
        try {
            int first = Integer.parseInt(matcher.group(1));
            int second = Integer.parseInt(matcher.group(2));
            return first == 100 && second >= 64 && second <= 127;
        } catch (NumberFormatException notAnAddress) {
            return false;
        }
    }

    /**
     * Whether an origin reaches the host over Tailscale: a `100.64/10` literal or a MagicDNS name.
     *
     * Both count, because they are two ways to the same machine and the session cookie belongs to
     * whichever one the pairing used. `isTailscaleOrigin` only recognises the literal, which is not
     * enough for deciding "is this address a Tailscale one" — a MagicDNS name would be classified as
     * an ordinary LAN host and kept in Tailscale mode.
     */
    private static boolean isTailscaleAddress(String origin) {
        if (isTailscaleOrigin(origin)) return true;
        if (origin == null) return false;
        String host = origin.replaceFirst("^https?://", "");
        int slash = host.indexOf('/');
        if (slash >= 0) host = host.substring(0, slash);
        int colon = host.lastIndexOf(':');
        if (colon > 0) host = host.substring(0, colon);
        return isTailscaleHostName(host);
    }

    /**
     * The 「Tailscale 配对」 button: show the install guide first, then pair.
     *
     * Pressing this button means two things at once — "I want to connect from outside" and, usually,
     * "I have not installed Tailscale yet". Pairing first would fail with a message about an
     * unreachable address, which explains nothing. So the guide comes first, and its last button
     * continues into pairing, which keeps it to one decision for the user instead of two screens
     * they have to find their way between.
     */
    private void startTailscalePairing() {
        Log.i(TAG, "tailscale pairing: showing the install guide first");
        guideLeadsToTailscalePairing = true;
        showTailscaleGuide();
    }

    /**
     * Pair over Tailscale: the mode that works from anywhere.
     *
     * On this network the host approves by identity — a device in the operator's own tailnet is
     * already authenticated by Tailscale — so neither the QR code, nor the key, nor a click on the
     * desktop is involved. That is the whole point: all three of those live at home, and the user
     * this exists for is somewhere else.
     *
     * A Tailscale address is presented as the primary address rather than being forced. Both stored
     * addresses are probed and whichever answers is used, so a phone that happens to be at home
     * still takes the faster LAN path instead of insisting on the tunnel.
     */
    private void performTailscalePairing() {
        java.util.List<String> tailscale = tailscaleAddresses();
        if (!tailscale.isEmpty()) {
            // Every Tailscale form is kept, not just the first, because the session cookie belongs to
            // one host: pairing over the IP does not authenticate the name, and the two are different
            // origins even though they reach the same computer. Keeping both lets the probe pick
            // whichever answers *and* carries the session, which is what `candidateOrigins` is for.
            String primary = tailscale.get(0);
            Log.i(TAG, "tailscale pairing: candidates " + tailscale);
            // The non-primary forms go to the extra list, not into a field. A field holds exactly one
            // address: putting two there produced a malformed URL and cost every candidate, including
            // the working one (see KEY_EXTRA_ORIGINS).
            for (int i = 1; i < tailscale.size(); i++) {
                rememberExtraOrigin(tailscale.get(i));
            }
            // Anything that is not a Tailscale address is kept as a fallback too: a LAN address is
            // still the faster path when the phone happens to be at home.
            for (String field : new String[]{urlInput.getText().toString(), urlInput2.getText().toString()}) {
                String url = normalizeUrl(field);
                if (url == null || isTailscaleOrigin(url) || tailscale.contains(url)) continue;
                rememberExtraOrigin(url);
            }
            urlInput.setText(primary);
            // The choice is recorded so `connect()` honours it. Without this the candidates were rebuilt
            // from every stored address and the LAN one came back — see the note in connect().
            tailscaleOnly = true;
            statusText.setText("正在连接 Tailscale 地址…");
            connect();
            return;
        }
        // Nothing stored yet.
        //
        // A LAN sweep is deliberately *not* attempted here, even though it is how the address would
        // normally be learned. That works at home and nowhere else, and this button exists for
        // someone who is not at home: on mobile data the sweep scans the carrier's /24, finds
        // nothing, and spends 24 seconds doing it — measured in logcat as
        // `discover: local ipv4=10.53.135.94` followed by `nothing found in 24098ms`. Reporting a
        // failure after a pointless wait is worse than asking immediately.
        //
        // What remains is to ask for the value, once. It is then remembered, so this screen is seen
        // once per device rather than every time.
        Log.i(TAG, "tailscale pairing: no tailscale address stored, asking for it");
        promptForTailscaleAddress();
    }

    /**
     * Ask for the host's Tailscale address, on the one screen that can accept it.
     *
     * The field is unlocked for this (see `showIpScreen`) because the stored primary address is
     * usually a LAN address — the very thing that stopped working when the user left the house — and
     * a locked field here would be a dead end.
     */
    private void promptForTailscaleAddress() {
        preferTailscaleAfterDiscovery = true;
        showPairingScreen(true);
        discoverText.setText("这台手机还没存过电脑的 Tailscale 地址。\n\n"
                + "请在「输入地址」页填入，格式：\n"
                + "http://100.x.x.x:19387\n\n"
                + "电脑上打开 DSH，左下角面板会显示这个地址（或它的 "
                + "xxx.ts.net 名字），点「复制」发到手机即可。\n"
                + "填一次就会被记住，以后在外面点「Tailscale 配对」直接就连。");
        showIpScreen();
        preferTailscaleAfterDiscovery = false;
        // Open Tailscale on the way, so the address is one copy away.
        //
        // Asked for as 「不应该是会跳转到tailscale并且让我复制IP地址的吗？」. The address screen alone asks the
        // user to type an address they cannot see, and the moment they need it is the moment the tunnel
        // is not answering — so the app opens the app that holds it. Android's IPN client shows its own
        // tunnel address and offers no API to read it (verified: no exported provider or service), so
        // this hands over the only route that exists: the user's eyes and clipboard.
        //
        // Only when Tailscale is installed and not already up: an installed-and-connected tunnel that
        // still did not answer has a different problem, and opening Tailscale would replace the screen
        // they need with one that cannot help.
        if (isTailscaleAppInstalled() && !isTailscaleTunnelUp()) {
            Log.i(TAG, "promptForTailscaleAddress: opening Tailscale so the address can be copied");
            Toast.makeText(this, "请在 Tailscale 里复制电脑的 IP（100.x.x.x），回来粘贴",
                    Toast.LENGTH_LONG).show();
            openTailscaleApp();
        } else {
            Log.i(TAG, "promptForTailscaleAddress: Tailscale installed=" + isTailscaleAppInstalled()
                    + " tunnelUp=" + isTailscaleTunnelUp() + " — not opening it");
        }
    }

    /**
     * Whether a Tailscale tunnel is up on this device.
     *
     * Read from the interfaces rather than asked of Tailscale, because it cannot be asked: the
     * Android app exposes no query API (verified — no exported provider or service; details in
     * `features/TAILSCALE-APK.md`). What it does leave behind is an interface holding an address in
     * 100.64.0.0/10, which is exactly the fact that matters here: without it, no 100.x address can
     * be reached at all, so pairing is pointless until it appears.
     */
    private boolean isTailscaleTunnelUp() {
        try {
            java.util.Enumeration<java.net.NetworkInterface> interfaces =
                    java.net.NetworkInterface.getNetworkInterfaces();
            while (interfaces != null && interfaces.hasMoreElements()) {
                java.net.NetworkInterface candidate = interfaces.nextElement();
                java.util.Enumeration<java.net.InetAddress> addresses = candidate.getInetAddresses();
                while (addresses.hasMoreElements()) {
                    java.net.InetAddress address = addresses.nextElement();
                    byte[] raw = address.getAddress();
                    if (raw != null && raw.length == 4
                            && (raw[0] & 0xFF) == 100
                            && (raw[1] & 0xFF) >= 64 && (raw[1] & 0xFF) <= 127) {
                        return true;
                    }
                }
            }
        } catch (Exception e) {
            Log.i(TAG, "isTailscaleTunnelUp: " + e.getClass().getSimpleName() + " (treated as down)");
        }
        return false;
    }

    /** Whether the Tailscale app is installed at all. */
    private boolean isTailscaleAppInstalled() {
        try {
            getPackageManager().getPackageInfo(TAILSCALE_PACKAGE, 0);
            return true;
        } catch (Exception notInstalled) {
            return false;
        }
    }

    /**
     * Refresh the Tailscale line and its button on the address screen.
     *
     * Shown only in Tailscale pairing mode: on the plain address screen a tunnel the user does not
     * intend to use is noise, and the button would invite them away from what they were doing.
     */
    private void updateTailscaleState() {
        if (tailscaleState == null || openTailscaleBtn == null) return;
        if (!preferTailscaleAfterDiscovery && !isTailscaleOrigin(urlInput.getText().toString())) {
            tailscaleState.setVisibility(View.GONE);
            openTailscaleBtn.setVisibility(View.GONE);
            return;
        }
        if (!isTailscaleAppInstalled()) {
            tailscaleState.setText(getString(R.string.tailscale_absent));
            tailscaleState.setVisibility(View.VISIBLE);
            openTailscaleBtn.setVisibility(View.GONE);
            return;
        }
        boolean up = isTailscaleTunnelUp();
        tailscaleState.setText(getString(up ? R.string.tailscale_on : R.string.tailscale_off));
        tailscaleState.setVisibility(View.VISIBLE);
        // The button is only useful when the switch is off; leaving it visible while everything
        // works would suggest something is still missing.
        openTailscaleBtn.setVisibility(up ? View.GONE : View.VISIBLE);
    }

    /**
     * Open the Tailscale app, so its switch can be turned on without hunting for the icon.
     *
     * Nothing is read from it — the Android app offers no API to read (see isTailscaleTunnelUp).
     * What this removes is the step of finding the app in a drawer, which is the whole difficulty
     * when the user is somewhere else and needs the tunnel on now.
     */
    private void openTailscaleApp() {
        Log.i(TAG, "openTailscaleApp: launching " + TAILSCALE_PACKAGE);
        // Explicit component first: Tailscale's launcher activity is known and stable, and an
        // explicit intent cannot be answered by something else with a similar filter.
        Intent direct = new Intent(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .setComponent(new android.content.ComponentName(
                        TAILSCALE_PACKAGE, TAILSCALE_PACKAGE + ".MainActivity"));
        direct.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            startActivity(direct);
            awaitingTailscaleReturn = true;
            return;
        } catch (Exception e) {
            Log.w(TAG, "openTailscaleApp: explicit launch failed (" + e + "), trying the package");
        }
        try {
            Intent byPackage = getPackageManager().getLaunchIntentForPackage(TAILSCALE_PACKAGE);
            if (byPackage == null) throw new Exception("no launcher activity");
            byPackage.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(byPackage);
            awaitingTailscaleReturn = true;
        } catch (Exception e) {
            Log.w(TAG, "openTailscaleApp: cannot open Tailscale: " + e);
            Toast.makeText(this, "打不开 Tailscale，请在手机上手动打开它", Toast.LENGTH_LONG).show();
        }
    }

    /**
     * Learn and store the host's Tailscale address, while the host is reachable.
     *
     * Every pairing route that works away from home needs this value, and none of them can obtain it
     * from off-site: the LAN sweep cannot see the host, and the address is a fact only the host
     * knows. So it is captured opportunistically — on any successful page load — and written to the
     * same field the IP screen shows and the Tailscale button reads.
     *
     * The host may offer either a MagicDNS name (`host.tailnet.ts.net`) or a `100.x` literal; the
     * name is preferred because it survives a reassigned tunnel address and can be read by a human.
     * Asking from whatever origin the page loaded on means a device on the LAN learns the tunnel
     * address without the user doing anything.
     */
    private void rememberTailscaleAddress() {
        final String current = webView == null ? null : webView.getUrl();
        if (current == null) return;
        final String origin = originOf(current);
        if (origin.isEmpty()) return;
        new Thread(() -> {
            java.net.HttpURLConnection connection = null;
            try {
                connection = (java.net.HttpURLConnection)
                        new java.net.URL(origin + "/m/api/status").openConnection();
                connection.setConnectTimeout(6000);
                connection.setReadTimeout(8000);
                connection.setRequestProperty("Accept", "application/json");
                String cookie = CookieManager.getInstance().getCookie(origin);
                if (cookie != null && !cookie.isEmpty()) {
                    connection.setRequestProperty("Cookie", cookie);
                }
                if (connection.getResponseCode() != 200) return;
                String body = readAll(connection.getInputStream());
                String name = firstGroup(body, "\"tailscaleName\"\\s*:\\s*\"([^\"]+)\"");
                String url = firstGroup(body, "\"tailscaleUrl\"\\s*:\\s*\"([^\"]+)\"");
                // The host's own spelling of both forms, each kept: the URL (a `100.x` literal) and
                // the MagicDNS name. Keeping only one is what broke this — the name was written over
                // the field that held the IP, and since a session cookie is scoped to one host, the
                // pairing done over the IP stopped being sent and the page fell back to the auth
                // screen (`bodyLen=133`) with the address itself still answering 200.
                final String nameUrl = name == null ? null : "http://" + name + ":" + scanPort();
                final String addrUrl = url == null ? null : withDefaultPort(normalizeUrl(url));
                final String discovered = addrUrl != null ? addrUrl : nameUrl;
                if (discovered == null || discovered.isEmpty()) {
                    Log.i(TAG, "rememberTailscaleAddress: the host reports no Tailscale address");
                    return;
                }
                final String currentPrimary = normalizeUrl(urlInput.getText().toString());
                // Record the name separately, always. It is a second way to reach the same host, not a
                // replacement for the first, and it is the durable one: it survives the tunnel address
                // changing.
                if (nameUrl != null && !nameUrl.equals(prefs.getString(KEY_TS_NAME, ""))) {
                    Log.i(TAG, "rememberTailscaleAddress: recorded the name " + nameUrl);
                    prefs.edit().putString(KEY_TS_NAME, nameUrl).apply();
                }
                if (discovered.equals(normalizeUrl(urlInput2.getText().toString()))
                        || discovered.equals(currentPrimary)) {
                    return;
                }

                // A Tailscale address we already hold is now stale — the host reports a different one.
                // That is exactly what replacing the computer looks like from here: the plugin on the
                // new machine reports the new name, and the old one stops resolving. Replacing it in
                // place (rather than pushing the new value into the spare field) is what keeps the
                // ordering honest: the stale address would otherwise stay in the field that is tried
                // first, and every connection would pay for a probe that cannot succeed.
                boolean primaryIsStale = isTailscaleOrigin(currentPrimary);
                Log.i(TAG, "rememberTailscaleAddress: storing " + discovered
                        + (primaryIsStale ? " (replacing the stale " + currentPrimary + ")" : ""));
                runOnUiThread(() -> {
                    if (primaryIsStale) {
                        // Replace the stale primary, and keep whatever it was as an extra rather than
                        // discarding it: the two forms are different origins for cookie purposes, so
                        // dropping one can drop the session with it.
                        rememberExtraOrigin(currentPrimary);
                        urlInput.setText(discovered);
                        prefs.edit().putString(KEY_URL, discovered).commit();
                    } else {
                        // The primary is a LAN address, which is still the faster path at home; the
                        // Tailscale address belongs in the fallback field.
                        urlInput2.setText(discovered);
                        prefs.edit().putString(KEY_URL2, discovered).commit();
                    }
                    // The name is always kept as well — it is the durable form, and a second way to
                    // reach the same host rather than a replacement for the address.
                    if (nameUrl != null && !nameUrl.equals(discovered)) rememberExtraOrigin(nameUrl);
                });
            } catch (Exception e) {
                Log.i(TAG, "rememberTailscaleAddress: " + e.getClass().getSimpleName() + " (ignored)");
            } finally {
                if (connection != null) connection.disconnect();
            }
        }).start();
    }

    /** First capture group of `pattern` in `text`, or null. */
    private static String firstGroup(String text, String pattern) {
        java.util.regex.Matcher matcher = java.util.regex.Pattern.compile(pattern).matcher(text);
        return matcher.find() ? matcher.group(1).replace("\\/", "/") : null;
    }

    private interface SecretCallback {
        void onResult(String secret);
    }

    /**
     * Ask the desktop to approve this device, then wait for the link it hands back.
     *
     * The request itself carries nothing sensitive: a name to show the operator and an id the app
     * keeps. It cannot obtain a credential on its own — the host answers "pending" until someone
     * clicks Allow in the panel, which is what keeps this from being a way for any device on the
     * network to walk into the host.
     */
    private void askDesktopToPair(final String origin) {
        if (pairRequestId != null) {
            Log.i(TAG, "askDesktopToPair: a request is already waiting (" + pairRequestId + ")");
            statusText.setText("已在等待这台电脑的确认。\n如果用的是 Tailscale，会自动确认；否则请在这台电脑的面板上点「允许」。");
            revealStatus();
            return;
        }
        final String deviceName = deviceLabel();
        // Worded to cover both paths, because which one applies is not known until the answer comes
        // back: over Tailscale the host approves by identity, on the same WiFi it waits for a click.
        statusText.setText("已找到 " + origin + "，正在请求配对…\n"
                + "（Tailscale 连接会自动确认；同一 WiFi 下请在这台电脑的面板上点「允许」）");
        revealStatus();
        new Thread(() -> {
            String id = null;
            String failure = null;
            boolean approvedByTailscale = false;
            java.net.HttpURLConnection connection = null;
            try {
                connection = (java.net.HttpURLConnection)
                        new java.net.URL(origin + "/m/api/pair-request").openConnection();
                connection.setRequestMethod("POST");
                connection.setConnectTimeout(8000);
                connection.setReadTimeout(10000);
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                connection.setRequestProperty("Accept", "application/json");
                byte[] payload = ("{\"name\":\"" + deviceName.replace("\"", "'") + "\"}")
                        .getBytes("UTF-8");
                connection.setFixedLengthStreamingMode(payload.length);
                connection.getOutputStream().write(payload);
                int status = connection.getResponseCode();
                if (status != 200) {
                    failure = "HTTP " + status;
                } else {
                    String body = readAll(connection.getInputStream());
                    java.util.regex.Matcher matcher = java.util.regex.Pattern
                            .compile("\"id\"\\s*:\\s*\"([^\"]+)\"").matcher(body);
                    if (matcher.find()) {
                        id = matcher.group(1);
                        pairRequestId = id;
                    } else {
                        failure = "响应里没有 id";
                    }
                    // The host approves by itself when the request arrives over Tailscale from a
                    // device in the operator's own tailnet — which is the only way to pair from
                    // outside the house, since the QR code, the key and the panel are all back home.
                    // Knowing which happened matters for the message: telling a user away from home
                    // to go click something on the desktop would be telling them to do the impossible.
                    approvedByTailscale = body.contains("\"approved\":true")
                            && body.contains("\"via\":\"tailscale\"");
                }
            } catch (Exception e) {
                failure = e.getClass().getSimpleName();
            } finally {
                if (connection != null) connection.disconnect();
            }
            if (approvedByTailscale) {
                Log.i(TAG, "pair-request: approved by Tailscale identity, no click needed");
                runOnUiThread(() -> {
                    statusText.setText("已通过 Tailscale 身份确认，正在配对…");
                    revealStatus();
                });
            }
            if (id == null) {
                final String why = failure == null ? "未知错误" : failure;
                Log.w(TAG, "pair-request failed: " + why);
                runOnUiThread(() -> {
                    statusText.setText("无法请求配对（" + why + "）。\n"
                            + "请点「扫码 / 配对链接」扫一次桌面面板左下角的二维码。");
                    revealStatus();
                    // Nothing was arranged, so the screen that can still help is the address screen —
                    // that is where the Tailscale IP goes, and Tailscale is opened alongside it so the
                    // value can be copied. Without this the failure was reported and then nothing
                    // happened, which is the dead end reported as 「我没法进入手动连接的界面」.
                    maybeOfferManualAddress();
                });
                return;
            }
            pollPairRequest(origin, id);
        }).start();
    }

    /**
     * Poll until the desktop decides, or the request expires.
     *
     * The timeout matches the host's own request TTL, so the app stops asking at about the same
     * moment the host forgets the request — waiting longer would only produce a 404 to interpret.
     */
    private void pollPairRequest(final String origin, final String id) {
        final int attempts = 80;
        final long intervalMs = 1500;
        for (int attempt = 0; attempt < attempts; attempt++) {
            String state = null;
            String link = null;
            java.net.HttpURLConnection connection = null;
            try {
                connection = (java.net.HttpURLConnection) new java.net.URL(
                        origin + "/m/api/pair-request/status?id="
                                + java.net.URLEncoder.encode(id, "UTF-8")).openConnection();
                connection.setConnectTimeout(6000);
                connection.setReadTimeout(8000);
                connection.setRequestProperty("Accept", "application/json");
                if (connection.getResponseCode() == 200) {
                    String body = readAll(connection.getInputStream());
                    java.util.regex.Matcher stateMatcher = java.util.regex.Pattern
                            .compile("\"status\"\\s*:\\s*\"([^\"]+)\"").matcher(body);
                    if (stateMatcher.find()) state = stateMatcher.group(1);
                    java.util.regex.Matcher linkMatcher = java.util.regex.Pattern
                            .compile("\"link\"\\s*:\\s*\"([^\"]+)\"").matcher(body);
                    if (linkMatcher.find()) link = linkMatcher.group(1).replace("\\/", "/");
                }
            } catch (Exception e) {
                Log.i(TAG, "pair-request status attempt " + attempt + ": "
                        + e.getClass().getSimpleName());
            } finally {
                if (connection != null) connection.disconnect();
            }

            if ("approved".equals(state)) {
                // The link is rewritten onto the origin the request was made from.
                //
                // The host composes the link from its own idea of its primary address, which is the LAN
                // one whenever it has one — so a pairing approved over Tailscale came back as
                // `http://192.168.31.56:19387/m/pair?t=…` and the phone, which is by definition not on
                // that network, could not redeem it. Measured: `pair-request: approved by Tailscale
                // identity, no click needed` followed by `loadPairingLink: redeeming
                // http://192.168.31.56:19387/m/pair?t=…` and nothing after it.
                //
                // Substituting the origin is safe because the token is the credential and it is
                // host-wide, not address-specific: the host validates it against its own store, not
                // against the address that was used to ask. The path and query are kept verbatim.
                final String approvedLink = retargetLink(link, origin);
                runOnUiThread(() -> {
                    if (approvedLink == null || approvedLink.isEmpty()) {
                        statusText.setText("桌面已允许，但宿主没有给出可用地址。\n请检查 webserver 是否监听 0.0.0.0。");
                        revealStatus();
                        return;
                    }
                    Log.i(TAG, "pair-request approved, redeeming on " + origin);
                    pairRequestId = null;
                    loadPairingLink(approvedLink);
                });
                return;
            }
            if ("rejected".equals(state)) {
                Log.i(TAG, "pair-request rejected on the desktop");
                pairRequestId = null;
                runOnUiThread(() -> {
                    statusText.setText("这台电脑拒绝了配对请求。\n"
                            + "如果要授权，请再试一次并在桌面上点「允许」。");
                    revealStatus();
                });
                return;
            }
            if ("unknown".equals(state)) {
                // Expired or already consumed; waiting longer cannot help.
                pairRequestId = null;
                runOnUiThread(() -> {
                    statusText.setText("配对请求已失效。\n请重新点「自动发现」，或扫码配对。");
                    revealStatus();
                });
                return;
            }
            try {
                Thread.sleep(intervalMs);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return;
            }
        }
        pairRequestId = null;
        runOnUiThread(() -> {
            statusText.setText("等待桌面确认超时。\n请在这台电脑的面板上点「允许」，或扫码配对。");
            revealStatus();
        });
    }

    /** Read a stream fully as UTF-8. */
    private static String readAll(java.io.InputStream stream) throws java.io.IOException {
        java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
        byte[] chunk = new byte[1024];
        int read;
        while ((read = stream.read(chunk)) != -1) buffer.write(chunk, 0, read);
        return buffer.toString("UTF-8");
    }

    /** A short human-readable name for this device, shown in the desktop prompt. */
    private String deviceLabel() {
        String manufacturer = android.os.Build.MANUFACTURER == null ? "" : android.os.Build.MANUFACTURER;
        String model = android.os.Build.MODEL == null ? "" : android.os.Build.MODEL;
        String label = (manufacturer + " " + model).trim();
        return label.isEmpty() ? "Android 设备" : label;
    }

    /**
     * Read the current auto-pair key from the host using the stored session cookie.
     *
     * This exists because the key lives only in this app's preferences, and losing them (an
     * upgrade, a `pm clear`) leaves the device unable to pair itself even though the session
     * cookie — which is stored by the WebView, not by the app — may still be valid. In that state
     * the host will answer `/m/api/session`, and the key is in the reply.
     */
    private void recoverSecretFromSession(final String origin, final SecretCallback callback) {
        final String cookie = CookieManager.getInstance().getCookie(origin);
        if (cookie == null || cookie.isEmpty()) {
            Log.i(TAG, "recoverSecret: no cookie for " + origin + ", nothing to recover");
            callback.onResult(null);
            return;
        }
        new Thread(new Runnable() {
            @Override
            public void run() {
                java.net.HttpURLConnection connection = null;
                String key = null;
                try {
                    connection = (java.net.HttpURLConnection)
                            new java.net.URL(origin + "/m/api/session").openConnection();
                    connection.setConnectTimeout(6000);
                    connection.setReadTimeout(8000);
                    connection.setRequestProperty("Cookie", cookie);
                    connection.setRequestProperty("Accept", "application/json");
                    if (connection.getResponseCode() == 200) {
                        java.io.InputStream stream = connection.getInputStream();
                        java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
                        byte[] chunk = new byte[1024];
                        int read;
                        while ((read = stream.read(chunk)) != -1) buffer.write(chunk, 0, read);
                        java.util.regex.Matcher matcher = java.util.regex.Pattern
                                .compile("\"autoPairSecret\"\\s*:\\s*\"([^\"]+)\"")
                                .matcher(buffer.toString("UTF-8"));
                        if (matcher.find()) key = matcher.group(1);
                    } else {
                        Log.i(TAG, "recoverSecret: HTTP " + connection.getResponseCode());
                    }
                } catch (Exception e) {
                    Log.i(TAG, "recoverSecret: " + e.getClass().getSimpleName() + " (ignored)");
                } finally {
                    if (connection != null) connection.disconnect();
                }
                final String found = key;
                if (found != null && saveSecret(found)) {
                    // runOnUiThread, not a Handler field: this class has no shared Handler and uses
                    // runOnUiThread everywhere else.
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            secretInput.setText(found);
                        }
                    });
                }
                callback.onResult(found);
            }
        }).start();
    }

    /** The phone's own IPv4 on the current network, or null when there is none. */
    private String localIpv4() {
        return LanScanner.currentIpv4();
    }

    /**
     * Load a URL, unless the page already on screen is that same page.
     *
     * Skipping the redundant load is what makes returning to the app instant: the WebView
     * keeps its DOM, its scroll position and its WebSocket, and no bytes are re-fetched.
     *
     * <p>A redemption is never skipped. `/m/pair?t=` is a request with a side effect — it
     * consumes the token, sets the device cookie and redirects — so "the same page is already
     * showing" says nothing about whether it has been redeemed. Skipping it here was a real
     * defect: scanning a code logged a correct redemption URL, then decided not to make the
     * request, so pairing could never complete.
     */
    private void loadInWebView(String url, String origin) {
        boolean redemption = url != null && url.contains("/m/pair?t=");
        String current = webView.getUrl();
        // `pageAlive` rather than a remembered flag: only a load that finished in this process
        // means the WebView actually holds the page. See the field's comment.
        if (!redemption && pageAlive && current != null && origin != null
                && origin.equals(originOf(current))) {
            Log.i(TAG, "load: already showing " + current + " — not reloading");
            showLoadHint(false, null);
            return;
        }
        if (redemption) {
            Log.i(TAG, "load: redeeming a pairing token (never skipped)");
        }
        lastLoadedOrigin = origin;
        showLoadHint(true, null);
        webView.loadUrl(url);
    }

    /** Show or hide the load hint, optionally with a specific line of text. */
    private void showLoadHint(boolean show, String message) {
        if (loadHint == null) return;
        if (show) {
            loadHint.setText(message == null ? getString(R.string.load_hint) : message);
        }
        loadHint.setVisibility(show ? View.VISIBLE : View.GONE);
        // The splash and the hint cover the same moment, so one leaving means both leave.
        if (!show && splash != null) splash.dismiss();
    }

    // --- motion ----------------------------------------------------------------------

    /**
     * Read the page's own error state and print it to logcat.
     *
     * The plugins that fail to load are client-side: the host has no log file, and the error
     * only exists as text in the page (or as a rejected promise inside the module loader).
     * This collects what the page will say about itself, so a failure that would otherwise
     * need a desktop DevTools session is readable from `adb logcat`.
     */
    private void runPageDiagnostics() {
        if (webView == null) {
            Log.i(TAG, "diag: no WebView");
            return;
        }
        Log.i(TAG, "diag: url=" + webView.getUrl());
        // Read from the packaged asset rather than a string literal here: as a literal,
        // one missing character made the whole script unparseable, evaluateJavascript
        // returned null, and the only symptom was that diagnostics produced nothing.
        final String script = loadAsset("diag.js");
        if (script == null) {
            Log.w(TAG, "diag: diag.js missing from the APK");
            return;
        }
        webView.evaluateJavascript(script, value -> {
            String text = value == null ? "null" : value;
            // The result arrives JSON-encoded with escaped newlines; split it back into lines
            // so a long report does not become one unreadable logcat entry.
            text = text.replace("\\n", "\n").replace("\\\"", "\"");
            if (text.startsWith("\"") && text.endsWith("\"")) {
                text = text.substring(1, text.length() - 1);
            }
            for (String part : text.split("\\s*\\|\\s*")) {
                Log.i(TAG, "diag: " + part);
            }
        });
    }

    /** Read a packaged asset as UTF-8 text, or null when it is not there. */
    private String loadAsset(String name) {
        try (java.io.InputStream in = getAssets().open(name)) {
            java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            int read;
            while ((read = in.read(chunk)) != -1) buffer.write(chunk, 0, read);
            return buffer.toString("UTF-8");
        } catch (Exception e) {
            Log.w(TAG, "asset " + name + " unavailable: " + e);
            return null;
        }
    }

    /**
     * Ask the page to report its scroll position.
     *
     * A WebView gives the shell no scroll callback of its own, so this listens inside the
     * page. It reports only when the position actually changes by a few pixels, because the
     * scroll event fires on every frame of a fling and crossing the bridge that often is
     * pointless work. Re-injected per page load, since each navigation replaces the document.
     */
    private void injectScrollMotion() {
        if (webView == null) return;
        webView.evaluateJavascript(
                "(function(){"
                + "if(window.__dshMotion)return 'already';"
                + "window.__dshMotion=true;var last=-1;"
                + "var report=function(){"
                + "var y=window.scrollY||document.documentElement.scrollTop||0;"
                + "if(Math.abs(y-last)<4)return;last=y;"
                + "try{DSHMotion.onScroll(y);}catch(e){}};"
                + "window.addEventListener('scroll',function(){window.requestAnimationFrame(report);},"
                + "{passive:true});"
                + "return 'installed';})()",
                value -> Log.i(TAG, "scroll motion: " + value));
    }

    /**
     * Receives the page's scroll position.
     *
     * Exposed to JavaScript under the name `DSHMotion`, and only that one method: the shell
     * needs the scroll offset and nothing else, and each additional method would be another
     * thing a page could call.
     */
    private final class MotionBridge {

        @android.webkit.JavascriptInterface
        public void onScroll(final int y) {
            runOnUiThread(() -> handleScrollForBar(y));
        }
    }

    /**
     * Ask the page where it is scrolled to, so the bar can follow it.
     *
     * The WebView's own `onScrollChanged` is not enough here: this page's scrolling happens inside an
     * element rather than the document, and the harness reports nothing about it to the native side.
     * Measured with the diagnostics probe — `diag: scrollY=0` alongside
     * `diag: scrollable=none: nothing overflows by more than 4px` on a page whose own text says it is
     * 93 KB. The native side is simply not told about any scroll, which is why the bar never retracted
     * no matter how far the page was scrolled.
     *
     * Polling the offset covers every case — a document scroll, an inner container, or a page that
     * changes which one it uses — without guessing at the harness's DOM. It is cheap enough to leave
     * running: one small evaluation every {@link SCROLL_POLL_MS} that returns a number.
     */
    private void startScrollWatch() {
        if (webView == null) return;
        if (scrollWatchStarted) return;
        scrollWatchStarted = true;
        webPageGone = false;
        webView.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (webView == null || webPageGone) return;
                // The largest scroll offset anywhere on the page, not just the document: the bar cares
                // about whether the content moved, and which element moved is the page's business.
                webView.evaluateJavascript(
                        "(function(){try{var m=window.scrollY||0;var all=document.querySelectorAll('*');"
                        + "for(var i=0;i<all.length;i++){var el=all[i];"
                        + "if(el.scrollTop>m)m=el.scrollTop;}return String(Math.round(m));"
                        + "}catch(e){return '0'}})()",
                        value -> {
                            try {
                                handleScrollForBar(Integer.parseInt(
                                        value == null ? "0" : value.replace("\"", "").trim()));
                            } catch (NumberFormatException ignored) {
                                // A page that will not answer simply does not move the bar.
                            }
                        });
                webView.postDelayed(this, SCROLL_POLL_MS);
            }
        }, SCROLL_POLL_MS);
    }

    /** How often the page's scroll offset is sampled while it is on screen. */
    private static final long SCROLL_POLL_MS = 250;

    /** Set while the page is being torn down, so the scroll watcher stops asking a dead WebView. */
    private boolean webPageGone;

    /**
     * Whether an automatic discovery sweep has already run this launch.
     *
     * One per launch: the sweep takes seconds and cannot succeed twice in a row, so retrying it on
     * every failure would turn a broken connection into a battery drain that also never reports.
     */
    private boolean discoveryAttempted;

    /** Guards against two watchers after a recreate, which would double every sample. */
    private boolean scrollWatchStarted;

    /**
     * Slide the top bar out of the way while the page is being read, and back when the user
     * looks up again.
     *
     * Hysteresis, not a threshold on position: a bar that hid at an absolute offset would
     * flicker near it. Movement accumulates in one direction and only the crossing of the
     * threshold acts, and any reversal cancels the accumulated travel so a quick up-flick
     * mid-scroll brings the bar straight back.
     */
    private void handleScrollForBar(int y) {
        if (barAutoHidden == null || topBar == null || topBar.getVisibility() != View.VISIBLE) {
            lastScrollY = y;
            return;
        }
        // Checked per event rather than cached: the setting can change while a page is open.
        if (!prefs.getBoolean(KEY_MOTION, true)) {
            lastScrollY = y;
            return;
        }
        if (lastScrollY < 0) {
            lastScrollY = y;
            return;
        }
        int delta = y - lastScrollY;
        lastScrollY = y;

        if (!barAutoHidden) {
            if (delta > 0) {
                travel += delta;
                if (travel > HIDE_TRAVEL_PX) setBarAutoHidden(true);
            } else {
                // Any upward movement is intent to look up, so it shows the bar at once
                // rather than waiting for the same distance it took to hide it.
                travel = 0;
                if (delta < 0) setBarAutoHidden(false);
            }
        } else {
            if (delta < 0) {
                travel -= delta;
                if (travel > SHOW_TRAVEL_PX) setBarAutoHidden(false);
            } else {
                travel = 0;
            }
        }
    }

    /**
     * Move the bar out of the way, or bring it back.
     *
     * A translation rather than a visibility change, so the motion is continuous and the bar keeps its
     * layout slot — no re-layout of the page while it is animating.
     *
     * Retracting hands the page a full row of height, which is the point on a phone, but it used to
     * take every control with it: the page gained height and lost its only visible exits. A short tab
     * is therefore shown in its place, carrying an arrow back and a settings button — the bar's
     * contents are hidden, its destinations are not.
     */
    private void setBarAutoHidden(boolean hidden) {
        if (barAutoHidden == null || barAutoHidden == hidden || topBar == null) return;
        barAutoHidden = hidden;
        travel = 0;
        float target = hidden ? -topBar.getHeight() : 0f;
        int duration = hidden ? 180 : 220;
        topBar.animate().cancel();
        topBar.animate()
                .translationY(target)
                .setDuration(duration)
                .setInterpolator(hidden
                        ? new android.view.animation.AccelerateInterpolator()
                        : new DecelerateInterpolator())
                .withEndAction(() -> {
                    // Gone while retracted, so the bar cannot swallow a tap meant for the page. The tab
                    // takes over from here, which is why this is INVISIBLE rather than the tab's own
                    // toggle: it must not reappear until the arrow is used.
                    if (barAutoHidden != null && barAutoHidden && topBar != null) {
                        topBar.setVisibility(View.INVISIBLE);
                    }
                })
                .start();
        if (!hidden) {
            topBar.setVisibility(View.VISIBLE);
        }
        if (barTab != null) {
            barTab.setVisibility(hidden ? View.VISIBLE : View.GONE);
            if (hidden) {
                // Fades in behind the bar's departure rather than switching on with it, so the two do
                // not look like one glitch.
                barTab.setAlpha(0f);
                barTab.animate().alpha(1f).setDuration(160).start();
            }
        }
        Log.i(TAG, "top bar " + (hidden ? "retracted (tab shown)" : "restored"));
    }

    /** Bring the bar back and forget the last scroll position, e.g. after a page switch. */
    private void resetBarAutoHide() {
        lastScrollY = -1;
        travel = 0;
        if (topBar == null) return;
        topBar.animate().cancel();
        topBar.setTranslationY(0f);
        topBar.setVisibility(immersiveActive ? View.GONE : View.VISIBLE);
        barAutoHidden = Boolean.FALSE;
        // The tab belongs to the retracted state only; a page switch brings the bar back, so the tab
        // must not be left behind on top of the new page.
        if (barTab != null) barTab.setVisibility(View.GONE);
    }

    /**
     * Settle which screen is showing, before the first frame.
     *
     * Uses the remembered value rather than a live one: at this point in a fresh process the
     * WebView is empty either way, and showing the page area while it loads is the right
     * first frame — it is where the content is about to appear.
     */
    private void refreshRestoreState() {
        // `pageAlive`, not `pageWasShowing`.
        //
        // The persisted flag records that a page was on screen *last time*, and it is still set after a
        // launch whose host cannot be reached — so using it here put an empty page on screen during the
        // probes, before anything had answered. That is the "正在下载界面" the user saw while the app was
        // still deciding, and it is the opposite of the intended behaviour: an unconnected app shows the
        // menu, and the page area appears only once a load is actually starting.
        //
        // `pageAlive` means the WebView in *this* process holds a page, which is only true after a
        // renderer restart — the one case where showing the page area first is right, because the page
        // is coming back rather than being fetched.
        if (pageAlive) {
            configPanel.setVisibility(View.GONE);
            webPanel.setVisibility(View.VISIBLE);
            String current = webView.getUrl();
            if (current != null) hostText.setText(Uri.parse(current).getHost());
        }
        applyImmersivePreference();
        resetBarAutoHide();
        updateNavButtons();
        // Whichever of the non-page screens is on show should arrive with the same staggered
        // entrance it has when reached through the flow.
        for (View screen : setupScreens()) {
            if (screen != null && screen.getVisibility() == View.VISIBLE) {
                staggerScreenEntrance(screen);
            }
        }
    }

    // --- transitions -----------------------------------------------------------------

    /**
     * Swap the settings screen for the page.
     *
     * The settings screen leaves to the left and the page arrives from the right, so the two
     * moves read as one gesture — the same direction the back button will later travel. The
     * page's own alpha rises as it arrives to hide the moment before it paints.
     *
     * Property animations (not view animations) because the travel can be interrupted: if
     * the user connects and immediately taps back, the running animation is cancelled from
     * its current value instead of snapping.
     */
    /**
     * Fade a screen in over everything else.
     *
     * Used for the pairing menu, which is a return to the top of the flow rather than a step
     * in a direction, so it does not travel sideways.
     */
    private void showOverlay(View screen) {
        if (screen == null) return;
        screen.animate().cancel();
        screen.setVisibility(View.VISIBLE);
        screen.setAlpha(0f);
        screen.animate()
                .alpha(1f)
                .setDuration(200)
                .setInterpolator(new DecelerateInterpolator())
                .start();
        showLoadHint(false, null);
    }

    /** Bring a screen in from the right, or send it back out to the right. */
    private void showPanel(View panel, boolean fromRight) {
        if (panel == null) return;
        panel.animate().cancel();
        panel.setTranslationX(fromRight ? dp(40) : -dp(40));
        panel.setAlpha(0f);
        panel.setVisibility(View.VISIBLE);
        panel.animate()
                .translationX(0f)
                .alpha(1f)
                .setDuration(240)
                .setInterpolator(new DecelerateInterpolator())
                .start();
    }

    private void hidePanel(View panel, boolean toRight) {
        if (panel == null) return;
        panel.animate().cancel();
        if (panel.getVisibility() != View.VISIBLE) {
            panel.setVisibility(View.GONE);
            panel.setTranslationX(0f);
            panel.setAlpha(1f);
            return;
        }
        panel.animate()
                .translationX(toRight ? dp(40) : -dp(40))
                .alpha(0f)
                .setDuration(200)
                .setInterpolator(new android.view.animation.AccelerateInterpolator())
                .withEndAction(() -> {
                    panel.setVisibility(View.GONE);
                    panel.setTranslationX(0f);
                    panel.setAlpha(1f);
                })
                .start();
    }

    /** Put every non-page screen away, without animation. Used once, before the first frame. */
    private void hideAllScreens() {
        for (View panel : setupScreens()) {
            if (panel == null) continue;
            panel.animate().cancel();
            panel.setVisibility(View.GONE);
            panel.setAlpha(1f);
            panel.setTranslationX(0f);
            panel.setTranslationY(0f);
        }
    }

    /**
     * Put the page away too, leaving nothing on screen.
     *
     * The guide screens are siblings of `webPanel`, not children of it: a WebView that is still
     * visible keeps drawing on top of whatever is shown next, so a guide opened while the page was
     * up appeared behind it and looked like it had never opened. Only the first-run path wants
     * this — hiding the page during a normal launch would defeat `connect()`.
     */
    private void hideEveryPanel() {
        hideAllScreens();
        if (webPanel != null) {
            webPanel.animate().cancel();
            webPanel.setVisibility(View.GONE);
        }
        if (loadHint != null) loadHint.setVisibility(View.GONE);
    }

    /**
     * The screens that are not the page, in one place.
     *
     * They are all shown and hidden by the same handful of helpers, and forgetting one in a
     * list is how a screen ends up still covering the UI — so the list exists once.
     */
    private View[] setupScreens() {
        return new View[]{pairingPanel, ipPanel, tailscalePanel, configPanel};
    }

    /** The pairing menu: the choice of two ways in. */
    private void showPairingScreen(boolean slide) {
        if (pairingPanel == null) return;
        // Any settings screen means no page is loading, so the opening frame has no reason
        // to be on top of it — and if it stays, it eats every touch meant for these buttons.
        //
        // Except during the branded opening, where the menu is deliberately behind a mark that is
        // already being shown: dismissing here would cancel the timed fade arranged a moment ago and
        // the mark would vanish the instant the menu appeared. The touch concern is not real in that
        // window either — the mark is up for a fixed two seconds and then removes itself, and a tap
        // on it skips the rest (it is clickable for exactly that reason).
        if (splash != null && !brandedOpening) splash.dismissImmediately();
        hidePanel(tailscalePanel, true);
        hidePanel(ipPanel, true);
        hidePanel(configPanel, true);
        // The page has to go too, and it is not a sibling that `hidePanel` reaches by accident: it is
        // the *last* child of the root before the splash, so it draws above this panel. Leaving it up
        // is why the menu appeared to do nothing when the gear was tapped — it opened, behind the page.
        // The first-run path always hid it (`hideEveryPanel`), which is why the bug only showed once the
        // gear became the way in from a connected session.
        if (webPanel != null) {
            Log.i(TAG, "pairing menu: hiding the page so the menu is not behind it");
            hidePanel(webPanel, true);
        }
        // The two status lines are cleared, because they describe attempts that are over.
        //
        // Both are written by the connecting paths and neither was reset when the menu came back, so the
        // menu could show a stale line from the previous attempt beside a fresh one — reported as
        // 「局域网扫码会显示正在扫描同WiFi设备，下面一行却显示正在连接」. The scan line and the connect
        // line belong to different attempts, and a screen that states two contradictory things is read as
        // broken even though both lines were individually true when written.
        if (statusText != null) statusText.setText("");
        if (discoverText != null) discoverText.setText("");
        if (slide) {
            showPanel(pairingPanel, true);
        } else {
            showOverlay(pairingPanel);
        }
        // The menu only ever appears because the shell could not go straight to the page, so
        // "forward" has nothing to mean here.
        updateNavButtons();
    }

    /**
     * The Tailscale guide.
     *
     * Shown when asked for rather than forced: a first-time user is usually on the same
     * network as the computer and can connect without it, so this is an offer with a way
     * back, not a step to clear.
     */
    private void showTailscaleGuide() {
        if (tailscalePanel == null) return;
        if (splash != null) splash.dismissImmediately();
        // Remember where to return when this was opened from the address screen, so the guide's
        // back button goes there rather than to the pairing menu.
        tailscaleReturnToIp = ipPanel != null && ipPanel.getVisibility() == View.VISIBLE;
        // In pairing mode the last button continues the job the user started, so it says so.
        Button done = findViewById(R.id.guideDoneBtn);
        if (done != null) {
            done.setText(guideLeadsToTailscalePairing
                    ? getString(R.string.guide_start_pairing)
                    : getString(R.string.guide_done));
        }
        hidePanel(pairingPanel, false);
        hidePanel(ipPanel, false);
        // The page goes too: the guide and the WebView are siblings and a visible WebView draws
        // over them, so on a launch that has already loaded a page the guide was invisible.
        if (webPanel != null) {
            webPanel.animate().cancel();
            webPanel.setVisibility(View.GONE);
        }
        showPanel(tailscalePanel, true);
        staggerScreenEntrance(tailscalePanel);
        Log.i(TAG, "showTailscaleGuide: panel=" + tailscalePanel.getVisibility()
                + " web=" + (webPanel == null ? -1 : webPanel.getVisibility()));
    }

    /**
     * Leave the guide: on to the next first-run step, or back to whichever screen offered it.
     */
    private void closeTailscaleGuide() {
        if (tailscalePanel == null) return;
        if (guideLeadsToTailscalePairing) {
            // Came here from the Tailscale pairing button, so continue into pairing rather than
            // returning to the menu the user already chose from.
            guideLeadsToTailscalePairing = false;
            performTailscalePairing();
            return;
        }
        if (tailscaleReturnToIp) {
            showIpScreen();
        } else {
            showPairingScreen(true);
        }
    }

    /**
     * Open a page in the phone's browser.
     *
     * Deliberately outside the shell: the download belongs to Tailscale, and letting the
     * WebView navigate to a third-party site would mix it into the harness page.
     */
    /**
     * Open a URL in whatever the device uses for browsing.
     *
     * @return false when no activity could take it, so a caller with a fallback can try that instead
     *         of leaving the user with only a toast.
     */
    private boolean openInBrowser(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            return true;
        } catch (Exception e) {
            Log.w(TAG, "no browser for " + url + ": " + e);
            Toast.makeText(this, "没有可用的浏览器，请在浏览器里打开 " + url, Toast.LENGTH_LONG).show();
            return false;
        }
    }

    /** The address path: one field, and the shortcuts that fill it. */
    private void showIpScreen() {
        if (ipPanel == null) return;
        if (splash != null) splash.dismissImmediately();
        hidePanel(pairingPanel, false);
        hidePanel(tailscalePanel, true);
        hidePanel(configPanel, true);
        // The field shows what is actually stored, and is locked when a value is already saved:
        // letting it be typed over while the saved value wins on launch produced a screen that
        // disagreed with what the app would really load.
        //
        // The lock is lifted while pairing over Tailscale, because that path exists for a phone that
        // has no usable address yet — often precisely because the stored one is a LAN address the
        // current network cannot reach. A screen that refuses the only value the user needs to type
        // is a dead end, and `saveSecret`-style "empty never overwrites" does not apply here: the
        // Tailscale button's whole purpose is to replace the address.
        String stored = prefs.getString(KEY_URL, "");
        boolean configured = !TextUtils.isEmpty(stored);
        boolean editable = !configured || preferTailscaleAfterDiscovery || manualAddressEntry;
        // Cleared immediately: it describes one arrival at this screen, not a mode.
        manualAddressEntry = false;
        urlInput.setText(stored);
        urlInput.setEnabled(editable);
        urlInput.setAlpha(editable ? 1f : 0.7f);
        showPanel(ipPanel, true);
        if (editable) urlInput.requestFocus();
        // The Tailscale line belongs to this screen: it says whether the tunnel a 100.x address
        // needs is actually up, and offers the way to its app when it is not.
        updateTailscaleState();
    }

    /** Connection settings: the whole page, reached from the flow or from the page's top bar. */
    private void showConfigScreen() {
        if (configPanel == null) return;
        if (splash != null) splash.dismissImmediately();
        hidePanel(pairingPanel, true);
        hidePanel(ipPanel, true);
        hidePanel(tailscalePanel, true);
        hidePanel(webPanel, true);
        showPanel(configPanel, true);
        staggerScreenEntrance(configPanel);
    }

    /**
     * Bring the status line into view.
     *
     * It sits below the buttons, and on this settings screen that is past the bottom edge on
     * a phone — which made the one line explaining what to do next the one line nobody saw.
     */
    private void revealStatus() {
        if (statusText == null || !(configPanel instanceof android.widget.ScrollView)) return;
        final android.widget.ScrollView scroll = (android.widget.ScrollView) configPanel;
        statusText.post(() -> scroll.smoothScrollTo(0, statusText.getTop()));
    }

    /**
     * Swap whatever is on screen for the page.
     *
     * The outgoing screen leaves to the left and the page arrives from the right, so the two
     * moves read as one gesture. Property animations (not view animations) because the travel
     * can be interrupted: if the user connects and immediately taps back, the running
     * animation continues from its current value instead of snapping.
     */
    private void showWebScreen() {
        // A page is about to be fetched, so this is the one transition where the opening
        // frame is worth showing. Dismissal is handled by the page's own callbacks, by a tap
        // on it, and by SplashView's watchdog.
        if (splash != null && splash.isShowing()) splash.playIntro();
        // The page's scrolling is not reported to the native side, so it is sampled instead.
        startScrollWatch();
        hidePanel(configPanel, false);
        hidePanel(ipPanel, false);
        hidePanel(pairingPanel, false);
        // The bar steps back in with the page, since a page switch is a deliberate arrival.
        resetBarAutoHide();
        showPanel(webPanel, false);
        // Never a bare white page: while a load is in flight the hint sits over it.
        //
        // A launch that cannot reach its host spends several seconds in timeouts before it can say so —
        // measured: three dead candidates at four seconds each, then the token request, then the page
        // load. With nothing on screen that reads as a crash, and it was reported as
        // 「正在下载界面白屏，什么情况」. The hint is dismissed by onPageFinished and by the load-failure
        // path, so it cannot outlive the wait it describes.
        if (webView == null || webView.getUrl() == null) {
            // Nothing loaded yet: this is the wait the hint exists for.
            showLoadHint(true, "正在连接…");
        }
        // The page's own history state is only known once it loads, but a stale enabled
        // "forward" would be a lie in the meantime.
        updateNavButtons();
    }

    /**
     * Bring a screen's rows in one after another.
     *
     * A small stagger is what makes a list feel assembled rather than pasted in; the delay is
     * capped so a long screen does not take a noticeable time to finish arriving. Works for
     * any screen whose single child is a column, which is every screen in this shell.
     */
    private void staggerScreenEntrance(View screen) {
        ViewGroup group = screen instanceof ViewGroup ? (ViewGroup) screen : null;
        if (group == null) return;
        View content = group.getChildCount() > 0 ? group.getChildAt(0) : null;
        if (!(content instanceof ViewGroup)) return;
        ViewGroup column = (ViewGroup) content;

        int count = column.getChildCount();
        for (int i = 0; i < count; i++) {
            View row = column.getChildAt(i);
            row.animate().cancel();
            row.setAlpha(0f);
            row.setTranslationY(dp(14));
            long delay = Math.min(i * 26L, 320L);
            row.animate()
                    .alpha(1f)
                    .translationY(0f)
                    .setStartDelay(delay)
                    .setDuration(260)
                    .setInterpolator(new DecelerateInterpolator())
                    .start();
        }
    }

    /**
     * Bring the bar back before an action, so the controls the user just used stay where they were.
     *
     * Called from the paths that navigate — the hardware back gesture and the swipe-in. It used to be
     * the body of `navigateBack`, which the bar's own arrow called; that arrow is gone, but the reason
     * to restore the bar did not go with it.
     */
    private void restoreBarForAction() {
        setBarAutoHidden(false);
    }

    /**
     * Reflect what the page's history actually allows.
     *
     * Kept after the history arrows were removed from the bar: this is still called on every page
     * event, and it is the single place that knows whether the WebView can go back — the swipe-in
     * gesture and the system back callback both consult it. The arrows themselves are gone because
     * the system back gesture already covers going back, and forward is rare on a phone; the space
     * they occupied now carries the settings button, which had no entry point from a page.
     */
    private void updateNavButtons() {
        if (webView == null) return;
        boolean back = webView.canGoBack();
        boolean forward = webView.canGoForward();
        // Kept for the log's sake: these two values are what a "back did nothing" report needs.
        Log.i(TAG, "updateNavButtons: canGoBack=" + back + " canGoForward=" + forward);
    }

    private void connect() {
        // Log the immediate caller. A repeated connect() was observed looping
        // load -> 403 -> auto-pair -> load, and knowing who re-enters is what makes that
        // fixable instead of guesswork.
        StackTraceElement[] trace = new Throwable().getStackTrace();
        Log.i(TAG, "connect() called from "
                + (trace.length > 1 ? trace[1].toString() : "unknown"));
        // Also applies when the address field holds pasted text rather than a value set by
        // handleIntent, so a pasted pairing link cannot reintroduce the bug.
        Target target = resolveTarget(
                withDefaultPort(normalizeUrl(urlInput.getText().toString())),
                tokenInput.getText().toString());
        if (target == null || target.url == null) {
            statusText.setText(R.string.err_url);
            return;
        }
        String url = target.url;
        String token = target.token;
        // Hold the link that arrived, if any, so redemption loads it verbatim instead of a
        // URL rebuilt from the origin. Cleared when the fields no longer carry a pairing
        // link, so a later plain connect cannot reuse a spent one.
        pairingLink = target.rawLink;
        // A link that carries a key or a fallback address is a complete hand-off, and a fresh
        // key must be able to undo an earlier refusal: it is the only way a rescan can work
        // without waiting out the pause.
        if (target.secret != null) {
            secretInput.setText(target.secret);
            autoPairPausedUntil = 0;
            Log.i(TAG, "connect: link supplied a key, cleared any auto-pair pause");
        }
        if (target.url2 != null) {
            String normalized2 = normalizeUrl(target.url2);
            if (normalized2 != null) urlInput2.setText(normalized2);
        }
        urlInput.setText(url);
        // The token is deliberately NOT persisted. It is single-use, so a stored copy is a
        // spent one, and a later launch that loads it can only get 403 — which is exactly the
        // failure this line used to cause. The in-memory field still carries it for the
        // redemption that follows right now.
        prefs.edit().putString(KEY_URL, url)
                .putString(KEY_SECRET, secretInput.getText().toString().trim())
                .putString(KEY_URL2, urlInput2.getText().toString().trim()).apply();

        autoPairTried = false;
        // A new connection attempt means any earlier retry is spent; without this a
        // reconnect after a failure would silently refuse to retry its own address.
        reloadRetriedFor.clear();
        redeemRecoveredFor.clear();
        origins = candidateOrigins(url);

        // Off Wi-Fi, put the Tailscale address first.
        //
        // Both addresses are stored and both are probed, so the order only decides which is tried
        // first — but on mobile data the LAN address cannot answer, and leading with it means every
        // connection pays a failed probe first. Ranking by the current network removes that cost
        // without removing either address: on Wi-Fi the LAN address stays primary and is faster,
        // and the Tailscale address remains the fallback it has always been.
        //
        // This is also what makes replacing the host computer survivable: the Tailscale name is
        // learned from the host (see rememberTailscaleAddress) and this ordering uses it wherever it
        // is the only thing that can work.
        // In Tailscale mode the LAN candidates are dropped, not merely ranked lower.
        //
        // This is what the user asked for by pressing 「Tailscale 配对」: they are outside the house, so
        // the LAN address cannot answer, and probing it costs a timeout and puts an address in the
        // failure message that was never going to work. Measured: `tailscale pairing: candidates
        // [http://100.82.206.124:19387]` followed immediately by `connect: … [http://100.82.206.124:19387,
        // http://192.168.31.56:19387, …]` — the choice was made and then undone by this method, reported
        // as 「配对设置在连接地址上时依旧走的局域网，即使我已经打开 tailscale 了」.
        if (tailscaleOnly) {
            java.util.List<String> onlyTailscale = new java.util.ArrayList<>(origins.size());
            for (String origin : origins) {
                if (isTailscaleAddress(origin)) onlyTailscale.add(origin);
            }
            if (!onlyTailscale.isEmpty()) {
                Log.i(TAG, "connect: Tailscale mode, dropping the LAN candidates: " + onlyTailscale);
                origins = onlyTailscale;
            } else {
                Log.i(TAG, "connect: Tailscale mode, but no Tailscale address is stored");
            }
        } else if (!isOnWifi()) {
            java.util.List<String> reordered = new java.util.ArrayList<>(origins.size());
            for (String origin : origins) {
                if (isTailscaleOrigin(origin)) reordered.add(origin);
            }
            for (String origin : origins) {
                if (!isTailscaleOrigin(origin)) reordered.add(origin);
            }
            if (!reordered.isEmpty()) {
                Log.i(TAG, "connect: off Wi-Fi, so Tailscale addresses lead: " + reordered);
                origins = reordered;
            }
        } else {
            Log.i(TAG, "connect: on Wi-Fi, LAN addresses lead: " + origins);
        }

        // With one address there is nothing to choose; with two, probe before loading so a
        // device that can only reach one of them does not have to be reconfigured.
        if (origins.size() <= 1) {
            openFirstOrigin(target);
            return;
        }
        statusText.setText("正在选择可用地址…");
        new Thread(new Runnable() {
            @Override
            public void run() {
                // Preference order, and the reason it is not simply "the first that answers":
                // the session cookie is scoped to the origin that issued it, so a reachable
                // address the host does not recognise is worth less than a reachable one it does.
                //   1. reachable and holds the session  — no pairing needed
                //   2. reachable                        — will need a fresh pairing
                //   3. nothing answered                 — try the primary and let the page say so
                String reachableWithSession = null;
                String reachableAny = null;
                unreachableOrigins.clear();
                // Timed because the gap between choosing and loading is otherwise unexplained: the
                // probes run in parallel with a four-second budget each, so a launch that takes twelve
                // seconds to reach a decision is spending it somewhere this line will name.
                final long probeStartedAt = System.currentTimeMillis();
                // Probed concurrently, because the addresses are not equally fast and the order they
                // are listed in says nothing about which one will answer first. A Tailscale address
                // that has fallen back to a relay took **10.9 seconds** to answer while the MagicDNS
                // name for the same host answered in 0.09s and the LAN address in 0.04s — measured on
                // device. Sequentially, the slow one was probed first, hit the timeout, and the whole
                // connection was reported as unreachable while a working address sat further down the
                // list. Probing in parallel means the fastest usable answer wins, whatever the order.
                //
                // Both the session and the first answer are collected, because they are different
                // questions and the better answer is not always the faster one: a reachable address
                // the host does not recognise still needs pairing, so a slightly slower one that
                // carries the session is preferred (see the preference order above).
                final java.util.concurrent.CountDownLatch done =
                        new java.util.concurrent.CountDownLatch(origins.size());
                final java.util.concurrent.atomic.AtomicReference<String> firstAny =
                        new java.util.concurrent.atomic.AtomicReference<>();
                final java.util.concurrent.atomic.AtomicReference<String> firstWithSession =
                        new java.util.concurrent.atomic.AtomicReference<>();
                for (final String origin : origins) {
                    new Thread(() -> {
                        try {
                            if (probe(origin)) {
                                firstAny.compareAndSet(null, origin);
                                String cookie = CookieManager.getInstance().getCookie(origin);
                                if (cookie != null && cookie.contains("dsh_")) {
                                    firstWithSession.compareAndSet(null, origin);
                                }
                            } else {
                                synchronized (unreachableOrigins) {
                                    unreachableOrigins.add(origin);
                                }
                            }
                        } finally {
                            done.countDown();
                        }
                    }).start();
                }
                // Bounded wait: the slowest path that still works has to fit, but a hung address must
                // not hold the launch. Whatever answered by then is used; the rest are simply not
                // considered, which is the same outcome as their probe failing.
                try {
                    done.await(12, java.util.concurrent.TimeUnit.SECONDS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
                reachableWithSession = firstWithSession.get();
                reachableAny = firstAny.get();
                String chosen = reachableWithSession != null ? reachableWithSession : reachableAny;
                final String picked = chosen != null ? chosen : origins.get(0);
                final boolean reachable = chosen != null;
                // Remember what answered, for the steps that come after a failed load.
                if (reachable) lastReachableOrigin = picked;
                final boolean hasSession = reachableWithSession != null;
                Log.i(TAG, "connect: chose " + picked + " (reachable=" + reachable
                        + ", session=" + hasSession + ", unreachable=" + unreachableOrigins
                        + ", probes took " + (System.currentTimeMillis() - probeStartedAt) + "ms)");
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (!reachable) {
                            // Nothing answered at all. Do not load a page: loading an address that has
                            // just failed its probe puts an empty page on screen and lets the splash's
                            // eight-second watchdog take the opening frame away, which is a plain blank
                            // window — reported as 「正在下载界面白屏」 and 「又黑屏了」.
                            //
                            // This is also the state the app is designed around: unreachable means "not
                            // connected", and the pairing menu is what an unconnected app shows. The
                            // earlier reasoning — let the WebView display its own error rather than
                            // refusing to try — assumed the WebView would say something; it does not, it
                            // shows nothing, and a blank page is strictly less informative than the menu.
                            Log.i(TAG, "connect: nothing answered, showing the pairing menu instead of a blank page");
                            splash.dismissImmediately();
                            showPairingScreen(true);
                            statusText.setText("这些地址都没有响应：\n" + unreachableOrigins
                                    + "\n请检查电脑是否在运行，或换一种方式连接。"
                                    + "\n（手机和电脑不在同一个 WiFi 时，请用 Tailscale）");
                            // The hint is the page area's waiting label; on the menu it would sit there
                            // saying "正在连接…" after the attempt has already ended.
                            showLoadHint(false, null);
                            revealStatus();
                            // A host that cannot be reached may still be reachable by another route, so
                            // the recovery runs rather than the user being left to work it out.
                            maybeAutoPair();
                            return;
                        }
                        // The origin is replaced by the one that answered, but a held link
                        // still wins inside openFirstOrigin, so only take this path when
                        // there is no link to load.
                        openFirstOrigin(new Target(picked, target.token, target.pairing,
                                pairingLink, target.secret, target.url2));
                    }
                });
            }
        }).start();
    }

    /**
     * The addresses to try, in order, de-duplicated.
     *
     * Both are configured so a device works on the local network (fast) and away from it
     * (Tailscale). The primary is tried first by convention, and probing decides which one
     * actually answers.
     */
    private java.util.List<String> candidateOrigins(String primary) {
        java.util.List<String> list = new java.util.ArrayList<>();
        if (primary != null && !primary.isEmpty()) list.add(primary);
        String second = normalizeUrl(urlInput2.getText().toString());
        if (second != null && !second.isEmpty() && !list.contains(second)) list.add(second);
        // The recorded MagicDNS name is a candidate even when it is not in either field. It reaches
        // the same host as the `100.x` address, but it is a different origin for cookie purposes, so
        // it is exactly the case a probe-and-pick is for: whichever one carries the session wins.
        String named = normalizeUrl(prefs.getString(KEY_TS_NAME, ""));
        if (named != null && !named.isEmpty() && !list.contains(named)) list.add(named);
        // Everything else the app knows about this host. Both Tailscale forms belong here, because a
        // session cookie is scoped to one host: the form the pairing used has to stay in the running
        // even when another form is listed first.
        for (String extra : extraOrigins()) {
            String url = normalizeUrl(extra);
            if (url != null && !url.isEmpty() && !list.contains(url)) list.add(url);
        }
        return list;
    }

    /** The additional origins, in the order they were learned. */
    private java.util.List<String> extraOrigins() {
        java.util.List<String> list = new java.util.ArrayList<>();
        String stored = prefs.getString(KEY_EXTRA_ORIGINS, "");
        if (stored == null) return list;
        for (String line : stored.split("\n")) {
            String trimmed = line.trim();
            // Only real addresses are kept. A stray line that is not one — a pasted sentence, a test
            // string — must not become a connection candidate: it would be probed on every launch and,
            // worse, it could be the origin that appears to hold a session. Rejecting here also heals a
            // store that already contains such a line.
            if (trimmed.isEmpty() || !looksLikeAddress(trimmed)) continue;
            if (!list.contains(trimmed)) list.add(trimmed);
        }
        return list;
    }

    /**
     * Whether a string is plausibly a host address, so junk cannot enter the candidate list.
     *
     * Shape, not reachability: a dotted hostname or a literal address. Deliberately permissive about
     * what the host may be — a LAN name, a MagicDNS name, an IPv4 or IPv6 literal — and strict about
     * what it may not be, which is a sentence.
     */
    private static boolean looksLikeAddress(String value) {
        if (value == null || value.isEmpty()) return false;
        String host = originOf(value).replaceFirst("^https?://", "");
        int colon = host.lastIndexOf(':');
        if (colon > 0) host = host.substring(0, colon);
        if (host.isEmpty() || host.length() > 253) return false;
        for (int i = 0; i < host.length(); i++) {
            char c = host.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                    || (c >= '0' && c <= '9') || c == '.' || c == '-' || c == ':' || c == '[' || c == ']';
            if (!ok) return false;
        }
        // A single label is acceptable as a bare hostname (`yunannian`), which is a real MagicDNS form.
        return host.indexOf('.') > 0 || host.matches("[A-Za-z][A-Za-z0-9-]*");
    }

    /**
     * Add an origin to the extra list, unless a field already covers it.
     *
     * Returns true when something changed, so callers can skip a pointless write.
     */
    private boolean rememberExtraOrigin(String origin) {
        if (origin == null || origin.isEmpty()) return false;
        // Same gate as when reading: what goes in has to look like an address, or it will be probed
        // forever and may shadow a working one.
        if (!looksLikeAddress(origin)) {
            Log.i(TAG, "rememberExtraOrigin: refusing a value that is not an address");
            return false;
        }
        if (origin.equals(normalizeUrl(urlInput.getText().toString()))) return false;
        if (origin.equals(normalizeUrl(urlInput2.getText().toString()))) return false;
        java.util.List<String> list = extraOrigins();
        if (list.contains(origin)) return false;
        list.add(origin);
        prefs.edit().putString(KEY_EXTRA_ORIGINS, String.join("\n", list)).apply();
        Log.i(TAG, "rememberExtraOrigin: " + origin + " (" + list.size() + " extra now)");
        return true;
    }

    /**
     * Whether an origin answers at all.
     *
     * Any HTTP status counts as reachable: the harness answers 401 when it wants
     * authentication, which still proves the host is there. Only a transport failure —
     * no route, refused, timed out — means the address is unusable.
     *
     * The timeout is generous enough for a Tailscale path that has fallen back to a relay — measured
     * at 10.9 seconds for a `100.x` address that was nonetheless working — because the probes now run
     * in parallel: a slow address costs its own thread and nothing else, and the fastest answer decides
     * which one is loaded. Under the old sequential probing this same timeout had to be short, since
     * every slow address delayed the ones behind it.
     */
    /**
     * How long a probe waits for the host to start answering.
     *
     * Shorter than it was, because probes are now raced across every candidate at once and a
     * non-answering address is the common case rather than the exception: measured on device, three
     * dead candidates at six seconds each held the launch for eighteen seconds before the app reached
     * the screen that could help. Four seconds still covers a healthy exchange over a relay — the
     * slowest working case measured was 10.9 seconds for a *full* status read, but the connection
     * itself was established well inside a second, and it is the connection that this waits for.
     */
    private static final int PROBE_TIMEOUT_MS = 4000;

    private boolean probe(String origin) {
        // Refuse to run on the main thread, loudly.
        //
        // Android throws NetworkOnMainThreadException for this, and the exception used to be caught
        // below and logged as a plain failure — indistinguishable from "the host did not answer". That
        // is how the Tailscale route came to report itself unusable every time it was called from a UI
        // callback. Failing here with a distinct message means the next occurrence names itself instead
        // of masquerading as an unreachable host.
        if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) {
            Log.w(TAG, "probe(" + origin + ") called on the main thread — this would always fail; "
                    + "call it from a background thread");
            return false;
        }
        java.net.HttpURLConnection connection = null;
        try {
            connection = (java.net.HttpURLConnection)
                    new java.net.URL(origin + "/m/api/status").openConnection();
            connection.setConnectTimeout(PROBE_TIMEOUT_MS);
            connection.setReadTimeout(PROBE_TIMEOUT_MS);
            connection.setRequestMethod("GET");
            int status = connection.getResponseCode();
            Log.i(TAG, "probe " + origin + " -> HTTP " + status);
            return status > 0;
        } catch (Exception e) {
            // The message is included, not just the class: "did not answer" for an address that another
            // probe answered seconds earlier is not diagnosable from a type name alone — a
            // ConnectException, a SocketTimeoutException and an UnknownHostException look identical in
            // the log while pointing at three different causes.
            Log.i(TAG, "probe " + origin + " -> " + e.getClass().getSimpleName()
                    + ": " + e.getMessage());
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /** Load the chosen origin, preferring the fallback in remindForPairing. */
    private void openFirstOrigin(Target target) {
        // The held link wins: it is the URL the host issued, and rebuilding it from the
        // origin produced a URL the host rejects with 403.
        String loadUrl = TextUtils.isEmpty(pairingLink) ? loadUrlFor(target) : pairingLink;
        // Redacted: a pairing link is a full control credential, and logcat outlives it.
        Log.i(TAG, "connect: loading " + redactSecret(loadUrl));
        statusText.setText(R.string.connecting);
        hostText.setText(Uri.parse(target.url).getHost());
        showWebScreen();
        // A pairing link already carries a launch token, so it is loaded as-is. A plain address does
        // not, and the harness refuses a bare page load even when the session cookie is valid
        // (measured: `GET /` answers 401 with a working session cookie). Asking the host for a fresh
        // launch URL is what makes the shell boot on every launch rather than only on the first.
        if (!TextUtils.isEmpty(pairingLink)) {
            loadInWebView(loadUrl, target.url);
            return;
        }
        loadWithFreshToken(target.url, loadUrl);
    }

    /**
     * Ask the host for a launch URL for this origin, then load it.
     *
     * The token is minted per origin, which is the point: on Tailscale the app talks to `100.x` or
     * the MagicDNS name, and a token issued for the LAN address is useless there because the cookie
     * it sets is scoped to the LAN host. The host's `/m/api/launch-url` does exactly this, gated on
     * this device's pairing cookie.
     *
     * Failure is not fatal: a device whose cookie has expired gets 403, and the honest next step is
     * the full pairing flow, which `maybeAutoPair` already drives. So the plain address is loaded as
     * a fallback and the existing recovery takes over.
     */
    private void loadWithFreshToken(final String origin, final String fallbackUrl) {
        new Thread(() -> {
            String url = null;
            java.net.HttpURLConnection connection = null;
            try {
                connection = (java.net.HttpURLConnection)
                        new java.net.URL(origin + "/m/api/launch-url").openConnection();
                // The same budget as a probe: this request is on the critical path of every launch, and
                // an unreachable host is the common failure. Six and eight seconds here, on top of the
                // probe that already decided the address was reachable, is what left the screen white
                // long enough to be reported as 「正在下载界面白屏」.
                connection.setConnectTimeout(PROBE_TIMEOUT_MS);
                connection.setReadTimeout(PROBE_TIMEOUT_MS);
                connection.setRequestProperty("Accept", "application/json");
                String cookie = CookieManager.getInstance().getCookie(origin);
                if (cookie != null && !cookie.isEmpty()) {
                    connection.setRequestProperty("Cookie", cookie);
                }
                int status = connection.getResponseCode();
                if (status == 200) {
                    String body = readAll(connection.getInputStream());
                    url = firstGroup(body, "\"url\"\\s*:\\s*\"([^\"]+)\"");
                    if (url != null) url = url.replace("\\/", "/");
                } else {
                    Log.i(TAG, "launch-url: HTTP " + status + " (falling back to the plain address)");
                }
            } catch (Exception e) {
                Log.i(TAG, "launch-url: " + e.getClass().getSimpleName()
                        + " (falling back to the plain address)");
            } finally {
                if (connection != null) connection.disconnect();
            }
            final String launch = url;
            runOnUiThread(() -> {
                if (launch != null && !launch.isEmpty()) {
                    Log.i(TAG, "launch-url: got a fresh token for " + origin);
                    loadInWebView(launch, origin);
                } else {
                    // Say so on the menu, not just in the log: the hint would otherwise still read
                    // "正在连接…" (or nothing) on a screen where the attempt has already finished.
                    statusText.setText("连上了 " + origin + "，但它不认这台设备。\n"
                            + "请在配对菜单里点「Tailscale 配对」或「扫码 / 配对链接」重新配对一次。");
                    showLoadHint(false, null);
                    revealStatus();
                    loadInWebView(fallbackUrl, origin);
                }
            });
        }).start();
    }

    /**
     * Pair this device automatically when the host says it is not authenticated.
     *
     * Requires a one-time key, and retries at most once per load so a wrong key cannot
     * loop. With no key configured the user is told what to do instead of being left on the
     * host's bare "authentication required" page.
     */
    private void maybeAutoPair() {
        // A screen the user is acting on stops recovery — but only when a page is missing too.
        //
        // The guard exists to stop a retry loop when a load's late callbacks keep arriving while the
        // user is in the middle of something. It also blocked the recovery that is supposed to run
        // *after* a failure put the menu up: the menu was visible, so every subsequent call returned
        // immediately, and the Tailscale route — the one that works from outside — was never tried.
        // Measured: `nothing answered, showing the pairing menu` followed by no further attempt.
        //
        // A live page is the real signal that the user is somewhere worth leaving alone; a menu is not,
        // because the menu is exactly what an unconnected app shows.
        boolean pagePresent = pageAlive && webView != null && webView.getUrl() != null;
        if (pagePresent) {
            return;
        }
        if (ipPanel != null && ipPanel.getVisibility() == View.VISIBLE) {
            // The address screen is a form the user is filling in; rewriting it would fight them.
            return;
        }
        // A recovery is already running: it has its own one-shot guards, and re-entering here is
        // what produced the loop. Two entry points reach this method — the HTTP error callback and
        // the "page is the auth challenge" check in onPageFinished — and without this flag both of
        // them minted a link and then both loaded it, so the single-use token was redeemed twice
        // and the second attempt was answered with 403.
        if (recovering) {
            Log.i(TAG, "maybeAutoPair: recovery already in flight");
            return;
        }
        // A sweep is running, or was already started for this launch. Both terminal branches below
        // would open a screen the user did not ask for — and did, in fact: the log showed
        // `discover: starting` followed 20ms later by `nothing stored and no key -> the pairing menu`,
        // because a second failure callback arrived while the sweep was still running and took the
        // "give up" path. The sweep then finished behind the menu, found the host and recovered a key,
        // so the app had already answered the question it was asking the user.
        if (discovering || discoveryAttempted) {
            Log.i(TAG, "maybeAutoPair: discovery is handling this (discovering=" + discovering
                    + ", attempted=" + discoveryAttempted + ")");
            return;
        }
        // Off Wi-Fi with a Tailscale address that answers: pair over it, rather than sweeping a carrier
        // network that cannot contain the host.
        //
        // This is the case that reported 「tailscale无法访问了」: away from home, the probe correctly
        // chose the Tailscale address (`100.82.206.124 -> HTTP 200`), the harness then answered 403
        // because the session cookie belongs to the LAN origin the pairing used, and there was no path
        // from there to a new session — the only recovery on offer was a LAN sweep, which on mobile
        // data spends 24 seconds finding nothing. A request sent over Tailscale is approved by the host
        // on tailnet identity alone, so this route needs no click and no QR code.
        if (!isOnWifi() && tryTailscalePairing()) {
            discoveryAttempted = true;
            return;
        }
        if (autoPairTried) {
            // The key was already spent on the initial load. That is the normal state on a launch
            // that could not authenticate, and it must not disable recovery — without this the
            // device sat on the host's auth page forever.
            Log.i(TAG, "maybeAutoPair: load failed after the initial attempt, starting recovery");
            startRecovery();
            return;
        }
        // A refused key stays refused; only the user can change that by entering a new one.
        if (System.currentTimeMillis() < autoPairPausedUntil) {
            Log.i(TAG, "maybeAutoPair: paused after an earlier refusal -> the pairing menu");
            // The pairing menu, not the settings screen. A device that cannot connect needs the ways in —
            // scan, Tailscale, discover — and the settings screen offers none of them. Landing there was
            // reported as 「连不上自动跳配对菜单页面，而不是跳配对设置」. Settings stays a deliberate
            // destination, reached from the gear.
            showPairingScreen(true);
            statusText.setText("配对密钥被拒绝过，请重新配对。");
            return;
        }

        // 1. A pairing link that was handed in but has not been redeemed yet. This is the only
        //    flow that establishes a session: the host answers the redemption with a redirect to
        //    `/?token=…`, and the session cookie comes from *that* page, not from the bare
        //    address. Loading the bare address while a fresh link is in hand is exactly the loop
        //    that left the phone on the host's 401 page.
        if (pairingLink != null && !pairingLink.isEmpty()) {
            Log.i(TAG, "maybeAutoPair: redeeming the pairing link that was handed in");
            String link = pairingLink;
            pairingLink = null;
            loadPairingLink(link);
            return;
        }

        // 2. Already paired: the host refused the *address*, not necessarily the session. The
        //    cookie is scoped to the origin that issued it — the Tailscale address and the LAN
        //    address are different origins — so the address that holds the session is the one to
        //    try, even when the probe preferred the other one.
        String sessionOrigin = deviceCookieOrigin();
        if (sessionOrigin != null && redeemRecoveredFor.add(sessionOrigin)) {
            Log.i(TAG, "maybeAutoPair: retrying on the address that holds the session");
            statusText.setText("正在用已保存的会话重新连接…");
            showLoadHint(true, "正在重新连接…");
            lastLoadedOrigin = sessionOrigin;
            // A fresh launch token, not the bare origin: the harness refuses a token-less page load
            // even when the session cookie is valid, so loading the address directly would bring
            // back a shell-less page instead of the GUI.
            loadWithFreshToken(sessionOrigin, sessionOrigin);
            return;
        }

        // 3. Nothing left to try by itself: find the host on this network and ask the desktop to approve.
        //
        //    This comes before the "no key" branch because discovery is the recovery that works without
        //    the user knowing anything: the sweep finds the host, `/m/api/pair-request` puts a prompt on
        //    the desktop panel, and one human click turns it into a session.
        //
        //    Attempted once per launch no matter what is stored. An earlier revision gated it on holding
        //    a device cookie, on the reasoning that a cookie is proof of a previous pairing — but the
        //    device cookie is exactly what expires, so the gate closed on the case it existed for: the
        //    log showed `hasAnyDeviceCookie` failing and the app falling through to the menu with the
        //    host sitting on the same network. A sweep costs a few seconds and reports honestly when it
        //    finds nothing, which is a far better answer than a menu that does not mention discovery.
        if (!discoveryAttempted) {
            discoveryAttempted = true;
            Log.i(TAG, "maybeAutoPair: not authenticated — discovering the host");
            statusText.setText("正在同一 WiFi 下寻找宿主…");
            showLoadHint(true, "正在寻找宿主…");
            showWebScreen();
            discoverHost();
            return;
        }

        // 4. Nothing left to try by itself: mint a fresh session from the stored key. This is
        //    what recovers a device whose cookie the host no longer accepts — the key is a
        //    long-lived secret, not a one-time token, so it is exactly the right thing to use.
        String secret = secretInput.getText().toString().trim();
        Log.i(TAG, "maybeAutoPair autoPairTried=" + autoPairTried
                + " hasSecret=" + !secret.isEmpty());
        if (secret.isEmpty()) {
            // The pairing menu, which is where the ways in live. This was the settings screen, and it
            // cannot help here: it offers an address and a key, while what the user needs is the scan
            // button, the Tailscale button, or discovery. Reported as 「连不上自动跳配对菜单页面，而不是跳
            // 配对设置」.
            Log.i(TAG, "maybeAutoPair: nothing stored and no key -> the pairing menu");
            showPairingScreen(true);
            // Actionable, and specific about why: without a key there is nothing the app can do by
            // itself, and the code that would have worked has already been used once.
            statusText.setText("此设备尚未配对，或之前的配对已失效。\n"
                    + "点上面的「扫码 / 配对链接」扫一次桌面面板左下角的二维码，"
                    + "或点「在同一 WIFI 下自动发现宿主」。");
            revealStatus();
            return;
        }
        autoPairTried = true;
        remindForPairing(secret);
    }

    /**
     * Load a pairing link, at most once.
     *
     * A pairing token is single-use: redeeming the same link twice always answers 403 and leaves the
     * user on "link expired". Two flows can reach a freshly minted link — the first load's HTTP
     * error, and the "page is the auth challenge" check — and when both did, the second redemption
     * destroyed the first one's result.
     *
     * The guard against that is a short time window and a retry cap, not a permanent memory. An
     * earlier revision remembered the last link forever, which was a trap: the host hands the same
     * live link to every caller until it is redeemed, and the flows that ask for one can legitimately
     * ask twice for the same answer — rejection clearing the key falls through to asking the desktop,
     * which mints from the same active token. The second call was then discarded *after* the status
     * text had been set to "正在完成配对…", so the app sat there with nothing in flight: the exact
     * "配对又坏了" symptom, with no error to look at. Re-loading is the safe direction — a token
     * already redeemed answers 403, which the normal error handling reports — whereas dropping a
     * needed load is silent and unrecoverable.
     */
    private static final long DUPLICATE_LINK_WINDOW_MS = 4000;
    private static final int DUPLICATE_LINK_MAX_SKIPS = 1;
    private String lastPairingLinkLoaded;
    private long lastPairingLinkLoadedAt;
    private int duplicateLinkSkips;

    private void loadPairingLink(String link) {
        if (link == null || link.isEmpty()) return;
        if (link.equals(lastPairingLinkLoaded)) {
            long age = System.currentTimeMillis() - lastPairingLinkLoadedAt;
            if (age < DUPLICATE_LINK_WINDOW_MS && duplicateLinkSkips < DUPLICATE_LINK_MAX_SKIPS) {
                duplicateLinkSkips++;
                Log.i(TAG, "loadPairingLink: duplicate within " + age + "ms, skipping once");
                return;
            }
            // Either the window has passed or this link has already been skipped once. Loading it
            // again can only help: if it was spent the host says 403 and the page reports it, which
            // is a state the user can act on, unlike a screen that never changes.
            Log.i(TAG, "loadPairingLink: retrying the same link after " + age + "ms");
            duplicateLinkSkips = 0;
        }
        lastPairingLinkLoaded = link;
        lastPairingLinkLoadedAt = System.currentTimeMillis();
        Log.i(TAG, "loadPairingLink: redeeming " + link);
        statusText.setText("正在完成配对…");
        showLoadHint(true, "正在完成配对…");
        // Show the page area *before* loading, because this is the moment the app stops being a menu.
        //
        // A pairing link only exists once a host has answered and issued one, so there is nothing left
        // to wait for but the page itself — and without this the redemption happened behind the menu,
        // which stayed on top of a page that had already loaded. Reported as 「连接上后自动跳到 Harness，
        // 不是吗」: the connection succeeded and the screen did not change.
        showWebScreen();
        webView.loadUrl(link);
    }

    /**
     * Rewrite a host-issued link onto a different origin, keeping its path and query.
     *
     * The token is the credential and the host validates it against its own store rather than against
     * the address it was asked on, so the address part is free to change. Used when a pairing is
     * approved over Tailscale but the link comes back pointing at the LAN address the host prefers.
     *
     * Returns the original link when either end cannot be parsed, so a malformed value is never invented.
     */
    private static String retargetLink(String link, String origin) {
        if (link == null || link.isEmpty() || origin == null || origin.isEmpty()) return link;
        try {
            Uri parsed = Uri.parse(link);
            String path = parsed.getEncodedPath();
            if (path == null || path.isEmpty()) return link;
            String query = parsed.getEncodedQuery();
            String rebuilt = origin.replaceAll("/+$", "") + path + (query == null ? "" : "?" + query);
            return rebuilt.equals(link) ? link : rebuilt;
        } catch (Exception e) {
            Log.i(TAG, "retargetLink: cannot parse, keeping the original (" + e.getClass().getSimpleName() + ")");
            return link;
        }
    }

    /**
     * Offer the address screen, with Tailscale opened, when nothing automatic worked.
     *
     * The last resort, and the only one that asks the user for something: the host's Tailscale address
     * is a value no probe can discover when the tunnel is not carrying traffic, and the app cannot read
     * it from the Tailscale app (no query API — verified; see features/TAILSCALE-APK.md). So the user is
     * given the screen that accepts it and, if the tunnel is down, the app that displays it.
     *
     * Guarded to run once per launch: it is reached from several failure paths, and re-opening the
     * address screen every time would make the app unusable precisely when it is already failing.
     */
    private void maybeOfferManualAddress() {
        if (manualOfferShown) return;
        manualOfferShown = true;
        if (pageAlive && webView != null && webView.getUrl() != null) return;
        Log.i(TAG, "maybeOfferManualAddress: opening the address screen as the last resort");
        promptForTailscaleAddress();
    }

    /**
     * Recover a launch that could not authenticate, without a pairing link in hand.
     *
     * This is the case that left the phone stuck on the host's auth page: the launch loads the
     * stored address, the session cookie is no longer accepted, and the load fails. The stored key
     * is a long-lived secret, so it can mint a brand new pairing link — the same thing the user
     * would do by scanning, minus the walk to the computer. Guarded to run once, and it never
     * retries the address that just failed.
     */
    private void startRecovery() {
        // Set before any work starts. Every other entry point checks this flag, so a second one
        // arriving while the first is in flight — which is exactly what happened — does nothing
        // instead of minting a second link and racing it against the first.
        recovering = true;
        String secret = secretInput.getText().toString().trim();
        if (secret.isEmpty()) {
            recovering = false;
            // Nothing to pair with. Leave the user on the settings screen with the way forward
            // written out, instead of an auth page that explains nothing.
            showConfig();
            statusText.setText("无法连接：这台设备需要重新配对。\n"
                    + "点「扫码」扫一次桌面面板左下角的二维码"
                    + "（先在面板上点「刷新二维码」换一张新的）。");
            revealStatus();
            return;
        }
        if (!redeemRecoveredFor.add("auto:" + secret.hashCode())) {
            Log.i(TAG, "startRecovery: already tried the stored key");
            recovering = false;
            showConfig();
            return;
        }
        Log.i(TAG, "startRecovery: minting a fresh pairing link from the stored key");
        statusText.setText("正在重新配对…");
        showLoadHint(true, "正在重新配对…");
        remindForPairing(secret);
    }

    /**
     * Persist the auto-pair key, and never with an empty value.
     *
     * The key is the only thing that lets this device recover on its own once the session cookie
     * stops being accepted, so losing it means the user must walk back to the computer and scan
     * again. Two things made that happen:
     *
     *  - Saving a pairing link wrote `secretInput`'s current contents into the key slot. When the
     *    input was empty (a link that carried no key, or a fresh launch) that overwrote a perfectly
     *    good stored key with "" — observed directly: a device that had `secretLen=32` came back
     *    with `secretLen=0` and then sat on the host's auth page because auto-pair had nothing to
     *    send.
     *  - Every preference write used `apply()`, which lands on disk asynchronously. A process killed
     *    by an app upgrade can lose it. For this one field the durability is worth a synchronous
     *    write, and the write happens rarely (only when the value actually changes).
     *
     * @return true when the stored value is known to have changed.
     */
    private boolean saveSecret(String secret) {
        String value = secret == null ? "" : secret.trim();
        if (value.isEmpty()) return false;
        if (value.equals(prefs.getString(KEY_SECRET, ""))) return false;
        prefs.edit().putString(KEY_SECRET, value).commit();
        Log.i(TAG, "saveSecret: stored a key of length " + value.length());
        return true;
    }

    /**
     * Ask the host for a pairing link using the one-time key, then load it.
     *
     * The key travels as a query parameter rather than a header because the WebView
     * performs the request and follows the redirect itself, which keeps cookie and
     * launch-token handling identical to the manual pairing path. The response is parsed by
     * hand: a tiny JSON body does not justify a JSON library in a dependency-free build.
     */
    private void remindForPairing(final String secret) {
        remindForPairing(secret, null);
    }

    /**
     * @param onRefused run when the host rejects the key, or null to just report it.
     *
     * A rejection is the one failure the user cannot act on by themselves: the key is a value they
     * have no way to inspect, and "wrong key" says nothing about how to get a right one. Callers that
     * know a better path (discovery can ask the desktop instead) pass one; the automatic retry path
     * passes nothing, because re-asking on every launch would spam the operator's screen.
     */
    private void remindForPairing(final String secret, final Runnable onRefused) {
        // Try each configured origin in order, so a device whose primary address is
        // unreachable still pairs through the fallback.
        //
        // Rebuilt from the fields rather than trusting the cached `origins`: discovery writes a
        // newly found address into those fields while `origins` still holds whatever the last
        // connect computed, so pairing would have asked the *old* address — which is the one that
        // is known to be unreachable, and the reason a freshly discovered host still failed to
        // pair. Observed in logcat: `auto-pair: origins to try = [http://26.244.162.123:19387]`
        // after a successful discovery of 192.168.31.56.
        final java.util.List<String> fresh = candidateOrigins(
                originOf(urlInput.getText().toString().trim()));
        final String alternate = originOf(urlInput2.getText().toString().trim());
        if (!alternate.isEmpty() && !fresh.contains(alternate)) fresh.add(alternate);
        final java.util.List<String> targets = fresh.isEmpty() ? origins : fresh;
        if (!targets.isEmpty()) origins = new java.util.ArrayList<>(targets);
        Log.i(TAG, "auto-pair: origins to try = " + targets);
        statusText.setText("正在自动配对…");
        new Thread(new Runnable() {
            @Override
            public void run() {
                String link = null;
                String failure = null;
                for (String attemptOrigin : targets) {
                    String endpoint = attemptOrigin + "/m/api/auto-pair?s=" + Uri.encode(secret);
                    Log.i(TAG, "auto-pair: requesting " + endpoint.replace(secret, "…"));
                    String[] result = requestAutoPair(endpoint);
                    link = result[0];
                    failure = result[1];
                    if (link != null) break;
                    // A wrong key fails on every address, so stop rather than repeat it.
                    if (failure != null && failure.contains("密钥不正确")) break;
                }
                final String finalLink = link;
                final String finalFailure = failure;
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (finalLink != null) {
                            loadPairingLink(finalLink);
                        } else {
                            Log.w(TAG, "auto-pair failed: " + finalFailure);
                            // Release the recovery guard: there is nothing more in flight, and the
                            // user needs to be able to try again (for instance after pasting a new
                            // key from the desktop panel).
                            recovering = false;
                            showConfig();
                            statusText.setText("自动配对失败：" + finalFailure
                                    + "\n可在桌面左下角面板复制密钥，或点「扫码」。");
                            // A refusal is permanent for this key. Without this the
                            // sequence load -> 403 -> auto-pair -> 403 repeated without
                            // end, hammering the host and never letting the user act.
                            pauseAutoPairAfterRefusal();
                            if (onRefused != null) {
                                Log.i(TAG, "auto-pair: key was refused, falling back");
                                onRefused.run();
                            }
                        }
                    }
                });
            }
        }).start();
    }

    /**
     * Stop automatic pairing for a while after the host refuses the key.
     *
     * A "wrong key" answer will not change on retry, so retrying only re-runs the whole
     * load/fail cycle and hides the settings screen the user needs in order to fix it.
     *
     * The key is cleared at the same time, because "invalid or missing auto-pair key" is the host
     * saying this key is not one of its own — it has been rotated, or the phone's copy is stale.
     * Keeping it is what turns a recoverable state into a stuck one: every future auto-pair attempt
     * sends the same rejected value. Clearing it lets the next discovery fall through to asking the
     * desktop for approval, which is a path that actually works without the user hunting for a
     * secret they have no way to know is wrong.
     */
    private void pauseAutoPairAfterRefusal() {
        autoPairPausedUntil = System.currentTimeMillis() + AUTO_PAIR_PAUSE_MS;
        String rejected = secretInput == null ? "" : secretInput.getText().toString().trim();
        if (!rejected.isEmpty()) {
            secretInput.setText("");
            // Empty never overwrites a stored value elsewhere; here the intent is the opposite, so
            // the cleared state is written explicitly.
            prefs.edit().putString(KEY_SECRET, "").commit();
            Log.i(TAG, "auto-pair: cleared the rejected key (len was " + rejected.length() + ")");
        }
        Log.i(TAG, "auto-pair paused for " + (AUTO_PAIR_PAUSE_MS / 1000) + "s after refusal");
    }

    /**
     * Request one auto-pair link.
     *
     * @return {link, failure}; link is non-null on success and failure explains a refusal.
     */
    private String[] requestAutoPair(String endpoint) {
        String link = null;
        String failure = null;
        java.net.HttpURLConnection connection = null;
                try {
                    connection = (java.net.HttpURLConnection) new java.net.URL(endpoint).openConnection();
                    connection.setConnectTimeout(10000);
                    connection.setReadTimeout(15000);
                    connection.setRequestProperty("Accept", "application/json");
                    int status = connection.getResponseCode();
                    java.io.InputStream stream = status >= 200 && status < 300
                            ? connection.getInputStream()
                            : connection.getErrorStream();
                    java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
                    if (stream != null) {
                        byte[] chunk = new byte[2048];
                        int read;
                        while ((read = stream.read(chunk)) != -1) buffer.write(chunk, 0, read);
                        stream.close();
                    }
                    String body = buffer.toString("UTF-8");
                    Log.i(TAG, "auto-pair: HTTP " + status + " body=" + body);
                    if (status == 200) {
                        java.util.regex.Matcher matcher =
                                java.util.regex.Pattern.compile("\"link\"\\s*:\\s*\"([^\"]+)\"").matcher(body);
                        if (matcher.find()) link = matcher.group(1).replace("\\/", "/");
                        else failure = "宿主返回的响应里没有链接";
                    } else if (status == 403) {
                        failure = "配对密钥不正确（在桌面左下角面板可查看/复制）";
                    } else {
                        failure = "宿主返回 HTTP " + status;
                    }
                } catch (Exception e) {
                    failure = e.getClass().getSimpleName() + ": " + e.getMessage();
                } finally {
                    if (connection != null) connection.disconnect();
                }
                return new String[]{link, failure};
    }

    /**
     * The origin whose device cookie this WebView holds, or null when it holds none.
     *
     * Returns *which* origin, not just whether one exists, because the cookie is scoped to the
     * origin that issued it. The two addresses for one host — a Tailscale one and a LAN one — are
     * different origins, so a device paired over Tailscale has no session on the LAN address. When
     * the probe picked the LAN address because Tailscale was unreachable, the recovery path sent it
     * back to that same cookieless address and the host answered 401 again: an endless auth page,
     * which is what the black screen was.
     */
    private String deviceCookieOrigin() {
        java.util.List<String> candidates = new java.util.ArrayList<>();
        candidates.addAll(origins);
        String typed = originOf(urlInput.getText().toString().trim());
        if (!typed.isEmpty()) candidates.add(typed);
        // The stored address is a candidate too: it is the one the pairing actually used, and it
        // may not be in `origins` if the probe has since reordered them.
        String stored = originOf(prefs.getString(KEY_URL, ""));
        if (!stored.isEmpty()) candidates.add(stored);
        for (String candidate : candidates) {
            // Skip an address the probe could not reach: sending recovery there stalls until a
            // socket timeout that the WebView may never report at all.
            if (unreachableOrigins.contains(candidate)) {
                Log.i(TAG, "deviceCookieOrigin: skipping unreachable " + candidate);
                continue;
            }
            String cookie = CookieManager.getInstance().getCookie(candidate);
            if (cookie != null && cookie.contains("dsh_")) {
                Log.i(TAG, "deviceCookieOrigin: session lives on " + candidate);
                return candidate;
            }
        }
        return null;
    }

    /**
     * Any address this app remembers that still carries a pairing session, or null.
     *
     * Used at launch when the stored address is empty, so a device the host still recognises does not
     * get asked to pair again. Deliberately broader than `deviceCookieOrigin()`: that one consults
     * `origins`, which is empty at this point because no probe has run yet, so it would answer null
     * for exactly the case this exists for.
     *
     * The cookie is the right evidence — the app's own `dsh_remote` cookie is set by the host when a
     * pairing is redeemed, and it survives a preference wipe because the WebView keeps it. An address
     * with no cookie proves nothing, so it is not offered: connecting there would produce the auth
     * page, which is the failure this is meant to prevent.
     */
    private String firstOriginWithSession() {
        java.util.List<String> candidates = new java.util.ArrayList<>();
        for (String field : new String[]{
                urlInput.getText().toString(),
                prefs.getString(KEY_URL, ""),
                prefs.getString(KEY_URL2, ""),
                prefs.getString(KEY_SESSION_ORIGIN, "")}) {
            String origin = originOf(field == null ? "" : field.trim());
            if (!origin.isEmpty() && !candidates.contains(origin)) candidates.add(origin);
        }
        for (String candidate : candidates) {
            String cookie = CookieManager.getInstance().getCookie(candidate);
            // Logged with the cookie's length rather than its value: "no session found" and "a session
            // exists but on a different origin" produce the same UI, and only this tells them apart.
            Log.i(TAG, "firstOriginWithSession: " + candidate + " -> "
                    + (cookie == null ? "no cookie" : cookie.length() + " chars, dsh_remote="
                    + cookie.contains("dsh_remote")));
            if (cookie != null && cookie.contains("dsh_remote")) return candidate;
        }
        Log.i(TAG, "firstOriginWithSession: checked " + candidates.size() + " candidate(s), none paired");
        return null;
    }

    /**
     * Remember the origin a session actually lives on.
     *
     * Written whenever a page load succeeds, so the address survives losing the address field: the
     * field is one preference and anything that clears preferences takes it with it, which left a
     * paired device looking unconfigured. This is the second copy, and unlike the field it is only
     * ever written from an origin that demonstrably worked.
     */
    private void rememberSessionOrigin(String origin) {
        if (origin == null || origin.isEmpty()) return;
        if (origin.equals(prefs.getString(KEY_SESSION_ORIGIN, ""))) return;
        Log.i(TAG, "rememberSessionOrigin: " + origin);
        prefs.edit().putString(KEY_SESSION_ORIGIN, origin).apply();
    }

    /**
     * Whether the WebView holds a pairing session for an origin.
     *
     * The plugin's own `dsh_remote` cookie is the evidence: the host sets it when a pairing is
     * redeemed, and it is scoped to the origin that issued it. Looking only at this cookie — rather
     * than at any cookie the origin happens to hold — keeps the answer tied to the app's own pairing
     * rather than to whatever the harness session state happens to be.
     */
    private boolean hasSessionFor(String origin) {
        if (origin == null || origin.isEmpty()) return false;
        try {
            String cookie = CookieManager.getInstance().getCookie(origin);
            boolean found = cookie != null && cookie.contains("dsh_remote");
            Log.i(TAG, "hasSessionFor(" + origin + ") = " + found);
            return found;
        } catch (Exception e) {
            Log.i(TAG, "hasSessionFor: " + e.getClass().getSimpleName() + " (assuming no)");
            return false;
        }
    }

    /**
     * Every Tailscale address being held, in the order they should be tried.
     *
     * Both forms are needed, and the reason is not redundancy — it is that a **session cookie is
     * scoped to one host**. A pairing done over the Tailscale IP leaves a cookie the MagicDNS name
     * will not send, and vice versa, so holding only one form strands the session whenever the host
     * is reached the other way. Observed on device: a paired phone whose primary address was the
     * name, whose session lived on the IP, sitting on the auth page (`bodyLen=133`) while both
     * addresses answered 200 to a plain request.
     *
     * The order follows what the user can actually copy: the Tailscale Android app shows the address
     * and offers no way to copy the machine name, so the IP leads. The name follows as a fallback,
     * because it survives the host's address changing.
     */
    private java.util.List<String> tailscaleAddresses() {
        java.util.List<String> list = new java.util.ArrayList<>();
        for (String field : new String[]{
                urlInput.getText().toString(), urlInput2.getText().toString()}) {
            String url = normalizeUrl(field);
            if (url != null && isTailscaleOrigin(url) && !list.contains(url)) list.add(url);
        }
        return list;
    }

    /** The plain address to load: the primary origin, without any pairing parameters. */
    private String baseAddress() {
        if (!origins.isEmpty()) return origins.get(0);
        String typed = urlInput.getText().toString().trim();
        return typed.isEmpty() ? "" : originOf(typed);
    }

    /**
     * Fetch the current auto-pair key from the host and store it.
     *
     * Only succeeds for a device the host still recognises: the request carries this
     * WebView's cookies, and the host answers 403 unless it finds a live `dsh_remote`
     * device cookie. That is what makes it safe to hand the key back — a device holding
     * that cookie already has full control of the host.
     *
     * Silent on failure: this is a background convenience, and a device with a working
     * session must not be interrupted by an error it cannot act on.
     */
    private void syncSecretFromHost() {
        final String origin = originOf(urlInput.getText().toString().trim());
        if (origin.isEmpty()) return;
        final String cookie = CookieManager.getInstance().getCookie(origin);
        if (cookie == null || cookie.isEmpty()) return;
        new Thread(new Runnable() {
            @Override
            public void run() {
                java.net.HttpURLConnection connection = null;
                try {
                    connection = (java.net.HttpURLConnection)
                            new java.net.URL(origin + "/m/api/session").openConnection();
                    connection.setConnectTimeout(6000);
                    connection.setReadTimeout(8000);
                    connection.setRequestProperty("Cookie", cookie);
                    connection.setRequestProperty("Accept", "application/json");
                    int status = connection.getResponseCode();
                    if (status != 200) {
                        // 403 simply means this device is not (or no longer) paired; the
                        // session in front of it is still whatever it was.
                        Log.i(TAG, "syncSecret: HTTP " + status + " (nothing to update)");
                        return;
                    }
                    java.io.InputStream stream = connection.getInputStream();
                    java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
                    byte[] chunk = new byte[1024];
                    int read;
                    while ((read = stream.read(chunk)) != -1) buffer.write(chunk, 0, read);
                    stream.close();
                    java.util.regex.Matcher matcher = java.util.regex.Pattern
                            .compile("\"autoPairSecret\"\\s*:\\s*\"([^\"]+)\"")
                            .matcher(buffer.toString("UTF-8"));
                    if (!matcher.find()) return;
                    final String fresh = matcher.group(1);
                    final String stored = secretInput.getText().toString().trim();
                    if (fresh.equals(stored)) return;
                    Log.i(TAG, "syncSecret: key updated from the host");
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            secretInput.setText(fresh);
                            prefs.edit().putString(KEY_SECRET, fresh).apply();
                        }
                    });
                } catch (Exception e) {
                    Log.i(TAG, "syncSecret: " + e.getClass().getSimpleName() + " (ignored)");
                } finally {
                    if (connection != null) connection.disconnect();
                }
            }
        }).start();
    }

    /**
     * Stop the page and open the connection settings.
     *
     * The page is stopped as well as hidden: leaving it loading let the 401 arrive again and
     * re-enter the auto-pair check, which produced a connect/401 loop when no key was set.
     */
    private void showConfig() {
        showConfigScreen();
        statusText.setText("");
        if (webView != null) {
            webView.stopLoading();
        }
    }

    /** Open the in-app scanner, used by both the pairing menu and the settings screen. */
    private void launchScanner() {
        // This used to fire the com.google.zxing.client.android.SCAN intent (the "Barcode
        // Scanner" app's private action), which is effectively extinct — no activity on the
        // test device handled it and the button only reported that no scanner was installed.
        try {
            startActivityForResult(new Intent(this, ScanActivity.class), REQUEST_SCAN);
        } catch (Exception e) {
            Toast.makeText(this, "无法启动扫码：" + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    /**
     * Register the Android 13+ back callback, so the back gesture reaches this activity.
     *
     * Why this is needed even though `onBackPressed()` is overridden: from API 33 the system routes
     * the back gesture through `OnBackInvokedDispatcher`, and an app that never registers a callback
     * depends on a compatibility bridge back to the legacy `onBackPressed()`. That bridge is not
     * implemented identically by every vendor — observed here as the back gesture doing nothing at
     * all on one phone (HyperOS, gesture navigation, targetSdk 36) while the same build behaved on
     * another. Registering explicitly removes the dependence on the bridge.
     *
     * `android:enableOnBackInvokedCallback="true"` in the manifest is the other half: without that
     * opt-in the platform may not deliver to the callback at all.
     */
    private void registerBackCallback() {
        if (android.os.Build.VERSION.SDK_INT < 33) return;
        try {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                    this::handleBack);
            Log.i(TAG, "back: OnBackInvokedCallback registered");
        } catch (Throwable unsupported) {
            // Not fatal: the legacy override below still handles the key event.
            Log.w(TAG, "back: could not register the callback: " + unsupported);
        }
    }

    /** Whether a panel is on screen, for logging. Null-safe: panels are found after super.onCreate. */
    private static String visible(View panel) {
        return panel != null && panel.getVisibility() == View.VISIBLE ? "1" : "0";
    }

    @Override
    public void onBackPressed() {
        handleBack();
    }

    /**
     * One place that decides what "back" means, shared by the legacy override and the Android 13+
     * callback. Both must agree, or the same gesture would do different things depending on which
     * path the system happened to choose.
     */
    private void handleBack() {
        // Logged because "the back gesture does nothing" is otherwise indistinguishable from "the
        // system never delivered it": this line is the only way to tell those apart on a device
        // whose key injection is blocked.
        Log.i(TAG, "handleBack: tailscale=" + visible(tailscalePanel)
                + " ip=" + visible(ipPanel) + " config=" + visible(configPanel)
                + " web=" + visible(webPanel) + " pairing=" + visible(pairingPanel));
        // Inside the setup screens, back means "the previous screen in the flow" before it
        // means "leave the app".
        if (tailscalePanel != null && tailscalePanel.getVisibility() == View.VISIBLE) {
            closeTailscaleGuide();
            return;
        }
        if (ipPanel != null && ipPanel.getVisibility() == View.VISIBLE) {
            showPairingScreen(true);
            return;
        }
        // The display and storage screen returns to the menu it was opened from. It used to fall back
        // to the address screen, which is a different branch of the flow and reads as being sent
        // somewhere unrelated.
        if (configPanel != null && configPanel.getVisibility() == View.VISIBLE) {
            showPairingScreen(true);
            return;
        }
        // The page's own history is deliberately not walked here.
        //
        // It used to be `if (canGoBack()) webView.goBack()`. The harness UI is a single-page app,
        // so a few taps accumulate history entries, and "back" then meant "undo a click inside the
        // page" for an unpredictable number of presses before it reached the app's own screens —
        // which reads as "back does not work", because the user cannot tell how many presses are
        // left. The in-page controls are the way to move around the page; the back gesture belongs
        // to the app's screens, and from there leaves the app.
        // From the page, back goes to the pairing menu — the app's own home.
        //
        // It used to open the settings screen, which was the right answer when that screen held the
        // address and the page's bar had a button for it. Now the menu is the settings screen and the
        // gear is its entry point, so that step sent the user to a screen they had not asked for:
        // reported as 「滑动返回怎么还是直接访问设置啊，不是应该回到主页吗」.
        if (webPanel != null && webPanel.getVisibility() == View.VISIBLE) {
            showPairingScreen(true);
            return;
        }
        if (pairingPanel != null && pairingPanel.getVisibility() == View.VISIBLE) {
            // Already at the top of the flow: let the system close the app.
            super.onBackPressed();
            return;
        }
        showPairingScreen(true);
    }
}
