package com.dshmobile.app;

import android.content.Context;
import android.graphics.drawable.Drawable;
import android.util.AttributeSet;
import android.view.Gravity;
import android.view.View;
import android.view.animation.DecelerateInterpolator;
import android.view.animation.OvershootInterpolator;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

/**
 * The shell's opening frame: the whale mark, a title, and a progress ring.
 *
 * <p>Shown over the WebView while the page loads and dismissed when it is worth looking at.
 * It exists because the alternative is a blank rectangle for the seconds the client spends
 * downloading the app shell, and a blank rectangle reads as a hang.
 *
 * <p>Built in code rather than as a layout because every part of it is animation setup:
 * the mark scales in, the title follows, and the ring fades in slightly later. Keeping that
 * next to the views it drives is easier to follow than the same thing split across a layout
 * file and this class.
 */
public class SplashView extends FrameLayout {

    private final ImageView mark;
    private final TextView title;
    private final ProgressBar ring;
    private boolean dismissed;

    /**
     * How long the opening frame may stay before it removes itself.
     *
     * Comfortably longer than a first load over Tailscale, which is the slowest path that
     * still works, and short enough that a broken launch is not a dead app.
     */
    private static final long WATCHDOG_MS = 8000;

    /**
     * How long the opening frame stays, at minimum, even when the page was ready sooner.
     *
     * Asked for directly: "给个 app icon 后再过渡进 harness，可以适当等个两秒". The page often arrives
     * in well under a second on a warm start, and dismissing on the first opportunity made the mark
     * flash by — which looks like a glitch rather than a launch. Two seconds is long enough to read
     * as intentional and short enough not to be a wait.
     *
     * It is a floor, not a delay: a slow load is not extended, because `dismiss()` is a no-op here
     * until the minimum has elapsed and then runs immediately on the next dismiss request.
     */
    private static final long MIN_VISIBLE_MS = 2800;

    /**
     * How long the mark takes to fade out.
     *
     * Long enough that the menu underneath is revealed as a transition rather than a cut: the two
     * frames overlap for most of a second, which is what makes the opening read as one move.
     */
    private static final long FADE_OUT_MS = 700;

    /** When the mark started animating in; 0 until `playIntro()` runs. */
    private long shownAt;
    /** A dismiss asked for before the minimum had elapsed, to run when it has. */
    private boolean dismissPending;

    public SplashView(Context context) {
        this(context, null);
    }

    public SplashView(Context context, AttributeSet attrs) {
        super(context, attrs);
        // A splash that outlives its purpose is not a cosmetic problem: it sits above the
        // settings screens and, being visible, keeps receiving touches, so the whole app
        // becomes unusable. Three independent escapes are therefore built in and described
        // where they are set up: the owner dismissing it, a tap on it, and the watchdog.
        setBackgroundColor(themeColor(context, R.color.splash_background, 0xFFFFFFFF));
        // Tapping the opening frame skips it. Cheap insurance on a screen that otherwise
        // has nothing to press.
        setClickable(true);
        setOnClickListener(v -> dismiss());

        LinearLayout column = new LinearLayout(context);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER_HORIZONTAL);
        LayoutParams columnParams = new LayoutParams(
                LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT);
        columnParams.gravity = Gravity.CENTER;
        addView(column, columnParams);

        int markSize = dp(104);
        mark = new ImageView(context);
        mark.setImageDrawable(whaleDrawable());
        mark.setScaleType(ImageView.ScaleType.FIT_CENTER);
        column.addView(mark, new LinearLayout.LayoutParams(markSize, markSize));

        title = new TextView(context);
        title.setText(R.string.app_name);
        title.setTextSize(16f);
        title.setAlpha(0.72f);
        LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        titleParams.topMargin = dp(18);
        column.addView(title, titleParams);

        ring = new ProgressBar(context);
        ring.setIndeterminate(true);
        LinearLayout.LayoutParams ringParams = new LinearLayout.LayoutParams(dp(28), dp(28));
        ringParams.topMargin = dp(26);
        column.addView(ring, ringParams);

        // Start invisible; playIntro() is what brings them in. Without this the first frame
        // flashes the final state and the animation reads as a flicker instead of an arrival.
        mark.setAlpha(0f);
        mark.setScaleX(0.82f);
        mark.setScaleY(0.82f);
        title.setAlpha(0f);
        title.setTranslationY(dp(10));
        ring.setAlpha(0f);
    }

    /**
     * The whale from the launcher icon's own density bucket.
     *
     * Read by name at runtime instead of through `R.mipmap` so the splash cannot pin the
     * icon to one density and render blurry on others.
     */
    private Drawable whaleDrawable() {
        int id = getResources().getIdentifier("ic_launcher", "mipmap", getContext().getPackageName());
        if (id == 0) return null;
        try {
            return getResources().getDrawable(id, getContext().getTheme());
        } catch (Exception e) {
            return null;
        }
    }

    /** Re-read the theme colours, e.g. after the system switched between light and dark. */
    public void applyThemeColors() {
        setBackgroundColor(themeColor(getContext(), R.color.splash_background, 0xFFFFFFFF));
    }

    private int dp(int value) {
        return Math.round(getResources().getDisplayMetrics().density * value);
    }

    /** A colour that is already resolved against the current night mode. */
    @SuppressWarnings("deprecation")
    private static int themeColor(Context context, int resId, int fallback) {
        try {
            return context.getResources().getColor(resId, context.getTheme());
        } catch (Exception e) {
            return fallback;
        }
    }

    /**
     * Play the entrance: mark, then title, then the ring, slightly staggered.
     *
     * <p>Also arms the watchdog. Whatever else happens — a load that never starts, a page
     * that never finishes, an exception somewhere in the shell — this layer removes itself.
     * An earlier revision only faded out from the page's own callbacks, so a launch that
     * never reached a page left it on top of the settings screen for good.
     */
    public void playIntro() {
        if (dismissed) return;
        if (shownAt == 0) shownAt = System.currentTimeMillis();
        // Logged because "the splash did not appear" has two very different causes that look
        // identical on screen: the mark never played, or it played and something covered it. Only
        // the log can tell them apart on a device where the frames are already gone.
        android.util.Log.i("DSHMobile", "splash: playIntro vis=" + getVisibility()
                + " alpha=" + getAlpha() + " w=" + getWidth() + " h=" + getHeight());
        mark.animate().cancel();
        mark.animate()
                .alpha(1f)
                .scaleX(1f).scaleY(1f)
                .setStartDelay(120)
                .setDuration(560)
                .setInterpolator(new OvershootInterpolator(1.1f))
                .start();
        title.animate().cancel();
        title.animate()
                .alpha(0.72f)
                .translationY(0f)
                .setStartDelay(340)
                .setDuration(440)
                .setInterpolator(new DecelerateInterpolator())
                .start();
        ring.animate().cancel();
        ring.animate()
                .alpha(1f)
                .setStartDelay(560)
                .setDuration(400)
                .start();

        removeCallbacks(watchdog);
        postDelayed(watchdog, WATCHDOG_MS);
    }

    /** The last line of defence: take the opening frame away on a timer. */
    private final Runnable watchdog = new Runnable() {
        @Override
        public void run() {
            if (dismissed) return;
            android.util.Log.i("DSHMobile", "splash: watchdog fired, dismissing");
            dismiss();
        }
    };

    /**
     * Fade the whole layer away and stop it taking touches.
     *
     * Idempotent: the page's progress callback, its finished callback, a tap and the
     * watchdog all call this, and whichever arrives first wins.
     */
    public void dismiss() {
        if (dismissed) return;
        android.util.Log.i("DSHMobile", "splash: dismiss requested, shownAt=" + shownAt
                + " now=" + System.currentTimeMillis());
        // Hold the mark for its minimum. The request is remembered rather than dropped, so the
        // caller does not have to try again — this is what makes the floor work without any change
        // at the call sites.
        long remaining = MIN_VISIBLE_MS - (System.currentTimeMillis() - shownAt);
        if (shownAt != 0 && remaining > 0) {
            if (!dismissPending) {
                dismissPending = true;
                postDelayed(() -> {
                    dismissPending = false;
                    if (!dismissed) dismissNow();
                }, remaining);
            }
            return;
        }
        dismissNow();
    }

    private void dismissNow() {
        if (dismissed) return;
        dismissed = true;
        removeCallbacks(watchdog);
        setClickable(false);
        // Touches stop here from now on, and the fade below takes it out of sight. The
        // layer is not switched to GONE first, because that would skip the fade.
        //
        // 280 ms was the original and read as a cut rather than a hand-off: the mark disappeared
        // before the eye had settled on it, so the menu arriving looked like a jump. 700 ms gives
        // the two frames time to overlap, which is what makes the transition read as one move.
        animate().cancel();
        animate()
                .alpha(0f)
                .setDuration(FADE_OUT_MS)
                .setInterpolator(new DecelerateInterpolator())
                .withEndAction(() -> setVisibility(View.GONE))
                .start();
    }

    /**
     * Hide the layer at once, with no fade.
     *
     * For the case where it should never have been shown — a launch with nothing configured
     * goes straight to a settings screen, and a fade there would only look like a glitch.
     */
    public void dismissImmediately() {
        dismissed = true;
        dismissPending = false;
        removeCallbacks(watchdog);
        animate().cancel();
        setClickable(false);
        setVisibility(View.GONE);
    }

    /**
     * Hide it on a timer, without the minimum.
     *
     * For the branded opening in front of the pairing menu: the mark is deliberately the only thing
     * on screen for `millis`, and then the menu is what the user wants. Sharing `MIN_VISIBLE_MS`
     * would make the fade depend on how long the mark had already been up, which is exactly the
     * coupling this avoids.
     */
    public void dismissAfter(long millis) {
        if (dismissed) return;
        postDelayed(this::dismissNow, Math.max(0, millis));
    }

    /** Whether the layer is on screen, so callers do not re-show a dismissed splash. */
    public boolean isShowing() {
        return !dismissed && getVisibility() == View.VISIBLE;
    }

    /**
     * Re-arm the layer for a launch that has something to wait for.
     *
     * Needed because `dismissImmediately()` sets a permanent flag: the owner decides at bind time
     * whether this launch will load a page, and only then can it know whether the opening frame is
     * wanted. Clearing the flag here keeps that decision in one place instead of making the owner
     * track two pieces of state.
     */
    public void setDismissed(boolean value) {
        dismissed = value;
        if (value) {
            removeCallbacks(watchdog);
        } else {
            setVisibility(View.VISIBLE);
            setAlpha(1f);
            setClickable(true);
        }
    }
}
