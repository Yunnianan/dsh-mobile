package com.dshmobile.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.hardware.Camera;
import android.media.ExifInterface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.widget.Button;
import android.widget.TextView;
import android.widget.Toast;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.NotFoundException;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.RGBLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;

import java.io.InputStream;
import java.util.EnumMap;
import java.util.EnumSet;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * In-app QR scanner for pairing links.
 *
 * Written against {@code com.google.zxing:core} rather than delegating to another
 * application or to Play Services' on-demand code-scanner module. An earlier
 * revision fired the long-dead {@code com.google.zxing.client.android.SCAN}
 * intent, which no app on the test device (or most devices today) can handle, so
 * the button simply reported that no scanner was installed. Vendoring the decoder
 * keeps scanning working offline and independent of Play Services' module
 * download.
 *
 * The frame path is deliberately small: the camera delivers NV21 preview frames,
 * the luminance plane is handed to ZXing, and decoding runs on one background
 * thread. Frames are dropped, not queued, while a decode is in flight.
 */
public class ScanActivity extends Activity implements SurfaceHolder.Callback {

    private static final String TAG = "DSHMobileScan";
    /** Ignore repeat hits for this long after a successful decode. */
    private static final long RESULT_COOLDOWN_MS = 1500;
    /** Request code for the system photo picker. */
    private static final int REQ_PICK_IMAGE = 2;
    /**
     * Longest side an image is downscaled to before decoding.
     *
     * A modern phone screenshot is already 1200x2600, and a camera photo can be far larger. ZXing
     * is fast, but turning a 50-megapixel bitmap into one int array per rotation is not something
     * worth doing on a phone — and a QR that matters is still readable well below this size.
     */
    private static final int MAX_IMAGE_SIDE = 2000;

    private SurfaceView preview;
    private TextView hint;
    private Button pickImageBtn;
    private Camera camera;
    private final MultiFormatReader reader = new MultiFormatReader();
    private final ExecutorService decoder = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile boolean decoding;
    private volatile long acceptedAt;
    /** Set once a result has been handed back, so no second one is posted. */
    private volatile boolean handedOff;
    /** True while a picked image is being decoded, so camera frames are ignored meanwhile. */
    private volatile boolean decodingImage;
    /** Reused destination buffer for rotated luminance planes. */
    private byte[] scratch;
    private int previewWidth;
    private int previewHeight;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_scan);
        preview = findViewById(R.id.preview);
        hint = findViewById(R.id.scanHint);
        pickImageBtn = findViewById(R.id.pickImageBtn);
        pickImageBtn.setOnClickListener(v -> pickImage());

        Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
        hints.put(DecodeHintType.POSSIBLE_FORMATS, EnumSet.of(BarcodeFormat.QR_CODE));
        // The pairing link is a URL; letting ZXing try every format only wastes
        // per-frame time.
        hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        reader.setHints(hints);

        preview.getHolder().addCallback(this);

        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, 1);
        }
    }

    // ---- decoding a picked image ----------------------------------------------

    /**
     * Open the system photo picker.
     *
     * The media picker on Android 13+ and {@code ACTION_GET_CONTENT} below it: neither needs a
     * storage permission, and both hand back a URI this activity may read. The camera permission is
     * deliberately not required for this path — a picked image works even if the user refused the
     * camera, which is the case where this button is the only way to scan.
     */
    private void pickImage() {
        Intent intent;
        if (Build.VERSION.SDK_INT >= 33) {
            intent = new Intent("android.provider.action.PICK_IMAGES");
            intent.setType("image/*");
        } else {
            intent = new Intent(Intent.ACTION_GET_CONTENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("image/*");
        }
        try {
            startActivityForResult(intent, REQ_PICK_IMAGE);
        } catch (Exception e) {
            // A device with no picker at all still has the camera path, so this is a message rather
            // than a dead end.
            Log.w(TAG, "no image picker available", e);
            Toast.makeText(this, R.string.scan_image_failed, Toast.LENGTH_LONG).show();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_PICK_IMAGE) return;
        if (resultCode != RESULT_OK || data == null || data.getData() == null) return;
        final Uri uri = data.getData();
        // Stop accepting camera frames for the duration: a frame that happened to decode while the
        // user was choosing would finish the activity underneath the decode in flight.
        decodingImage = true;
        hint.setText(R.string.scan_image_reading);
        decoder.execute(() -> {
            Result found = null;
            String failure = null;
            try {
                Bitmap bitmap = loadBitmap(uri);
                if (bitmap == null) failure = "decode-bitmap";
                else found = decodeBitmap(bitmap);
            } catch (Exception | OutOfMemoryError e) {
                failure = String.valueOf(e);
                Log.w(TAG, "image decode failed", e instanceof Exception ? (Exception) e : null);
            } finally {
                decodingImage = false;
            }
            final Result result = found;
            final String why = failure;
            main.post(() -> {
                if (handedOff) return;
                if (result != null) {
                    onDecoded(result);
                    return;
                }
                Log.i(TAG, "image produced no code (" + why + ")");
                hint.setText(R.string.scan_hint);
                Toast.makeText(this, R.string.scan_image_none, Toast.LENGTH_LONG).show();
            });
        });
    }

    /**
     * Read a picked image into a bitmap, downscaled and upright.
     *
     * The orientation is applied here rather than ignored: a photo taken in portrait carries its
     * rotation in EXIF rather than in its pixels, so a QR photographed sideways would otherwise be
     * handed to the decoder on its side — which the camera path compensates for by trying every
     * rotation, but which is much cheaper to fix once, up front.
     */
    private Bitmap loadBitmap(Uri uri) throws Exception {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        try (InputStream in = getContentResolver().openInputStream(uri)) {
            BitmapFactory.decodeStream(in, null, bounds);
        }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null;

        BitmapFactory.Options options = new BitmapFactory.Options();
        int longest = Math.max(bounds.outWidth, bounds.outHeight);
        int sample = 1;
        while (longest / sample > MAX_IMAGE_SIDE) sample *= 2;
        options.inSampleSize = sample;
        options.inPreferredConfig = Bitmap.Config.ARGB_8888;

        Bitmap decoded;
        try (InputStream in = getContentResolver().openInputStream(uri)) {
            decoded = BitmapFactory.decodeStream(in, null, options);
        }
        if (decoded == null) return null;

        int rotation = 0;
        try (InputStream in = getContentResolver().openInputStream(uri)) {
            // android.media.ExifInterface, not the support library one: it exists from API 24, which
            // is this app's minimum, so it costs no dependency.
            ExifInterface exif = new ExifInterface(in);
            int orientation = exif.getAttributeInt(ExifInterface.TAG_ORIENTATION,
                    ExifInterface.ORIENTATION_NORMAL);
            if (orientation == ExifInterface.ORIENTATION_ROTATE_90) rotation = 90;
            else if (orientation == ExifInterface.ORIENTATION_ROTATE_180) rotation = 180;
            else if (orientation == ExifInterface.ORIENTATION_ROTATE_270) rotation = 270;
        } catch (Exception ignored) {
            // No EXIF (a PNG screenshot, for instance) means no rotation to apply.
        }
        if (rotation == 0) return decoded;
        Matrix matrix = new Matrix();
        matrix.postRotate(rotation);
        Bitmap rotated = Bitmap.createBitmap(decoded, 0, 0, decoded.getWidth(), decoded.getHeight(),
                matrix, true);
        if (rotated != decoded) decoded.recycle();
        return rotated;
    }

    /**
     * Decode a QR out of a bitmap, trying the four rotations and both binarizers.
     *
     * Why the four rotations: a screenshot of the desktop panel can be taken in any orientation, and
     * a QR is decodable from all of them. Why both binarizers: {@code HybridBinarizer} is the better
     * choice for a photo, while a synthetic screenshot with hard edges is sometimes cleaner under
     * {@code GlobalHistogramBinarizer}. Between them the image path is markedly more forgiving than
     * the camera path needs to be, and the cost is bounded: one image, eight attempts at most.
     */
    private Result decodeBitmap(Bitmap bitmap) {
        int[] pixels = new int[bitmap.getWidth() * bitmap.getHeight()];
        bitmap.getPixels(pixels, 0, bitmap.getWidth(), 0, 0, bitmap.getWidth(), bitmap.getHeight());
        for (int rotation : new int[]{0, 90, 180, 270}) {
            Bitmap candidate = bitmap;
            if (rotation != 0) {
                Matrix matrix = new Matrix();
                matrix.postRotate(rotation);
                candidate = Bitmap.createBitmap(bitmap, 0, 0, bitmap.getWidth(), bitmap.getHeight(),
                        matrix, true);
            }
            try {
                int w = candidate.getWidth();
                int h = candidate.getHeight();
                int[] data = candidate == bitmap ? pixels : new int[w * h];
                if (candidate != bitmap) {
                    candidate.getPixels(data, 0, w, 0, 0, w, h);
                }
                RGBLuminanceSource source = new RGBLuminanceSource(w, h, data);
                BinaryBitmap binary = new BinaryBitmap(new HybridBinarizer(source));
                BinaryBitmap plain = new BinaryBitmap(
                        new com.google.zxing.common.GlobalHistogramBinarizer(source));
                // reset() may only be called once per decodeWithState failure — calling it again
                // throws IllegalStateException — so both binarizers are tried inside one try/finally.
                try {
                    try {
                        return reader.decodeWithState(binary);
                    } catch (NotFoundException photoMiss) {
                        return reader.decodeWithState(plain);
                    }
                } catch (NotFoundException bothMissed) {
                    // Try the next rotation.
                } finally {
                    reader.reset();
                }
            } finally {
                if (candidate != bitmap) candidate.recycle();
            }
        }
        return null;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == 1 && (results.length == 0 || results[0] != PackageManager.PERMISSION_GRANTED)) {
            Toast.makeText(this, "需要相机权限才能扫码", Toast.LENGTH_LONG).show();
            setResult(RESULT_CANCELED);
            finish();
        }
    }

    // ---- surface lifecycle ----------------------------------------------------

    @Override
    public void surfaceCreated(SurfaceHolder holder) {
        openCamera(holder);
    }

    @Override
    public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {
        if (camera == null) return;
        Camera.Parameters params = camera.getParameters();
        Camera.Size size = chooseSize(params);
        if (size != null) {
            params.setPreviewSize(size.width, size.height);
        }
        params.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
        camera.setParameters(params);

        // Match the display so the preview is not stretched.
        Camera.CameraInfo info = new Camera.CameraInfo();
        Camera.getCameraInfo(0, info);
        int rotation = getWindowManager().getDefaultDisplay().getRotation();
        int degrees = rotation == Surface.ROTATION_0 ? 0
                : rotation == Surface.ROTATION_90 ? 90
                : rotation == Surface.ROTATION_180 ? 180 : 270;
        int result;
        if (info.facing == Camera.CameraInfo.CAMERA_FACING_FRONT) {
            result = (info.orientation + degrees) % 360;
            result = (360 - result) % 360;
        } else {
            result = (info.orientation - degrees + 360) % 360;
        }
        camera.setDisplayOrientation(result);

        previewWidth = params.getPreviewSize().width;
        previewHeight = params.getPreviewSize().height;

        try {
            camera.setPreviewDisplay(holder);
        } catch (Exception e) {
            Log.w(TAG, "setPreviewDisplay failed", e);
        }
        camera.startPreview();

        // One reusable buffer to avoid allocating per frame.
        camera.addCallbackBuffer(new byte[previewWidth * previewHeight * 3 / 2]);
        camera.setPreviewCallbackWithBuffer((data, cam) -> onFrame(data, cam));
    }

    @Override
    public void surfaceDestroyed(SurfaceHolder holder) {
        releaseCamera();
    }

    private void openCamera(SurfaceHolder holder) {
        if (camera != null) return;
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) return;
        try {
            camera = Camera.open(0);
        } catch (Exception e) {
            Toast.makeText(this, "无法打开相机：" + e.getMessage(), Toast.LENGTH_LONG).show();
            finish();
        }
    }

    private void releaseCamera() {
        Camera cam = camera;
        camera = null;
        if (cam == null) return;
        try {
            cam.setPreviewCallbackWithBuffer(null);
            cam.stopPreview();
        } catch (Exception ignored) {
            // Camera already gone.
        }
        cam.release();
    }

    /** Pick a preview size that is at least 640 px wide and as close to 4:3 as possible. */
    private Camera.Size chooseSize(Camera.Parameters params) {
        Camera.Size best = null;
        for (Camera.Size size : params.getSupportedPreviewSizes()) {
            if (size.width < 640) continue;
            if (best == null) {
                best = size;
                continue;
            }
            boolean betterAspect = Math.abs(size.width * 3 - size.height * 4)
                    < Math.abs(best.width * 3 - best.height * 4);
            boolean smallerButEnough = size.width < best.width && size.width >= 640;
            if (betterAspect || smallerButEnough) best = size;
        }
        return best;
    }

    // ---- decoding -------------------------------------------------------------

    private void onFrame(byte[] data, Camera cam) {
        if (data == null) return;
        // A picked image is being decoded: drop frames rather than compete with it for the single
        // decoder thread, which would also risk a camera hit finishing the activity first.
        if (decoding || decodingImage) {
            cam.addCallbackBuffer(data);
            return;
        }
        decoding = true;
        final byte[] frame = data;
        final int width = previewWidth;
        final int height = previewHeight;
        final Camera cameraRef = cam;
        decoder.execute(() -> {
            try {
                Result found = decode(frame, width, height);
                if (found != null) onDecoded(found);
            } finally {
                decoding = false;
                if (cameraRef != null) cameraRef.addCallbackBuffer(frame);
            }
        });
    }

    /**
     * Try the frame at four rotations. The preview buffer is in sensor
     * orientation while the phone is usually portrait, so a QR that looks upright
     * on screen arrives sideways here.
     *
     * The rotation is done by copying the luminance plane into a scratch buffer
     * rather than with {@link com.google.zxing.LuminanceSource#rotateCounterClockwise()}:
     * that method is unimplemented on {@code LuminanceSource} and throws
     * {@code UnsupportedOperationException} (only subclasses that opt in may call
     * it). An earlier revision called it unconditionally and crashed the app the
     * moment a frame arrived.
     */
    private Result decode(byte[] nv21, int width, int height) {
        ensureScratch(width * height * 4);
        // 0 and 180 keep the original dimensions; 90 and 270 swap them.
        int[][] orientations = {
                {0, width, height},
                {90, height, width},
                {270, height, width},
                {180, width, height},
        };
        for (int[] o : orientations) {
            int rotation = o[0];
            int w = o[1];
            int h = o[2];
            byte[] pixels = rotation == 0 ? nv21 : rotateLuma(nv21, width, height, rotation);
            try {
                PlanarYUVLuminanceSource source = new PlanarYUVLuminanceSource(
                        pixels, w, h, 0, 0, w, h, false);
                BinaryBitmap bitmap = new BinaryBitmap(new HybridBinarizer(source));
                return reader.decodeWithState(bitmap);
            } catch (NotFoundException e) {
                // Not this orientation (or no code in view); try the next.
            } finally {
                reader.reset();
            }
        }
        return null;
    }

    private void ensureScratch(int size) {
        if (scratch == null || scratch.length < size) scratch = new byte[size];
    }

    /**
     * Copy the luma plane of an NV21 frame into {@link #scratch}, rotated.
     *
     * @param nv21 - full NV21 frame; only its first width*height bytes (Y) are read.
     * @param rotation - 90, 180 or 270 degrees counter-clockwise.
     * @return the rotated luma plane, as a scratch slice of exactly w*h bytes.
     */
    private byte[] rotateLuma(byte[] nv21, int width, int height, int rotation) {
        if (rotation == 180) {
            int n = width * height;
            for (int i = 0; i < n; i++) scratch[i] = nv21[n - 1 - i];
            return scratch;
        }
        // rotateCounterClockwise: destination is height x width.
        int dw = height;
        int dh = width;
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                int dx = y;
                int dy = width - 1 - x;
                scratch[dy * dw + dx] = nv21[y * width + x];
            }
        }
        return scratch;
    }

    private void onDecoded(Result result) {
        // Once a result has been accepted the activity is on its way out; accepting a
        // second one posted another setResult/finish pair, which reached the caller as a
        // duplicate scan and made it start connecting twice.
        if (handedOff) return;
        long now = System.currentTimeMillis();
        if (now - acceptedAt < RESULT_COOLDOWN_MS) return;
        acceptedAt = now;
        String text = result.getText();
        if (text == null || text.trim().isEmpty()) return;
        handedOff = true;
        Log.i(TAG, "decoded " + result.getBarcodeFormat() + " len=" + text.length());
        main.post(() -> {
            Intent out = new Intent();
            out.putExtra("SCAN_RESULT", text);
            setResult(RESULT_OK, out);
            finish();
        });
    }

    @Override
    protected void onPause() {
        super.onPause();
        releaseCamera();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        decoder.shutdownNow();
    }
}
