package com.dshmobile.app;

import java.io.IOException;
import java.io.InputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.Socket;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Finds a DSH host on the phone's own network, so no address has to be typed.
 *
 * <p>Discovery is deliberately done from the phone rather than by asking the host to
 * advertise itself. The host's port is fixed at 19387 and its status route answers
 * without credentials, so sweeping the /24 the phone is on is enough. That keeps this
 * feature entirely inside the app: it needs no plugin change and no host restart.
 *
 * <p>A sweep is 253 concurrent blocking connects on a bounded pool, so its cost is one
 * connect timeout rather than 253 sequential ones.
 */
final class LanScanner {

    /** Log sink so the activity can route progress into logcat under its own tag. */
    interface Log {
        void log(String message);
    }

    /** Harness port. Matches the desktop profile's web server. */
    static final int DEFAULT_PORT = 19387;

    /**
     * Other ports worth one shortlist pass, in order.
     *
     * Only a handful, and deliberately so: each costs a pass, and these are the places a host is
     * plausibly put by hand. The host's own status response is the real answer to "where are you" —
     * this list only gets a probe close enough to receive it.
     */
    private static final int[] ALTERNATE_PORTS = { 8080, 3000, 8000 };

    /** The port the host declares for itself in its status response. */
    private static final Pattern DECLARED_PORT = Pattern.compile("\"port\"\\s*:\\s*(\\d{1,5})");

    /** How long an address may take to answer before it is written off. */
    private static final int CONNECT_TIMEOUT_MS = 600;
    private static final int READ_TIMEOUT_MS = 700;

    /**
     * Budget for a one-off liveness probe, as opposed to a sweep probe.
     *
     * A sweep shares the network between 24 probes and only needs to know "is anything here", so a
     * short deadline is right. A liveness probe makes a single connection to an address that is
     * already known to answer, and its answer decides whether the user is told the host is gone —
     * so it gets room to be slow. The host can legitimately be busy: a running SSH tunnel competes
     * for the same CPU on a machine that has just been asked to serve several requests.
     */
    private static final int PROBE_CONNECT_TIMEOUT_MS = 3000;
    private static final int PROBE_READ_TIMEOUT_MS = 4000;

    /**
     * How many addresses are probed at once.
     *
     * <p>Measured, not guessed: probing 24 copies of one address, or a /27 in one batch,
     * answers in milliseconds, while pushing a whole /24 through at once returned *zero*
     * answers — including the host's own. So the sweep is paced, and the curated shortlist
     * below carries the common case.
     */
    private static final int SWEEP_BATCH = 24;

    /**
     * Cap on a full sweep.
     *
     * <p>A /24 at this width needs about 19 seconds of wall clock, which is longer than a
     * user will wait without feedback, so the sweep stops at this point and reports what it
     * has. The shortlist pass almost always settles it before this matters.
     */
    private static final long FULL_SWEEP_DEADLINE_MS = 12_000;

    /**
     * The status body carries this key. Requiring it is what tells a DSH host apart from
     * any other web server that happens to listen on this port, which matters on a shared
     * network.
     */
    private static final String SIGNATURE = "\"loopbackUrl\"";

    /** Addresses the host reports for itself, used to configure the other field. */
    private static final Pattern TAILSCALE_URL = Pattern.compile("\"tailscaleUrl\"\\s*:\\s*\"([^\"]*)\"");

    /** One discovered host. */
    static final class Found {
        final String host;
        final String response;
        /** Tailscale origin the host reported, or null when it has none. */
        final String tailscaleOrigin;
        /**
         * The port the host says it is listening on.
         *
         * Taken from the status response's own `port` field when present, falling back to the port
         * that answered. This is what lets discovery survive the operator moving the port: the
         * first probe may well land on the wrong port, and the host then names the right one.
         */
        final int port;

        Found(String host, String response, int answeredPort) {
            this.host = host;
            this.response = response;
            this.tailscaleOrigin = match(TAILSCALE_URL, response);
            this.port = parsePort(response, answeredPort);
        }

        /** Read `"port":19387` out of a status body, tolerating its absence. */
        private static int parsePort(String text, int fallback) {
            if (text != null) {
                Matcher matcher = DECLARED_PORT.matcher(text);
                if (matcher.find()) {
                    try {
                        int declared = Integer.parseInt(matcher.group(1));
                        if (declared > 0 && declared <= 65535) return declared;
                    } catch (NumberFormatException ignored) {
                        // Fall through to the port that answered.
                    }
                }
            }
            return fallback;
        }

        private static String match(Pattern pattern, String text) {
            if (text == null) return null;
            Matcher matcher = pattern.matcher(text);
            if (!matcher.find()) return null;
            String value = matcher.group(1);
            return value == null || value.isEmpty() ? null : value;
        }

        @Override
        public String toString() {
            return host + ":" + port;
        }
    }

    private final int port;
    private final Log log;
    /**
     * The port the pass currently running is probing.
     *
     * Separate from {@link #port} because the sweep walks a ladder: `port` is the operator's (or
     * discovery's) preference, this is where that walk currently is.
     */
    private volatile int activePort;

    /** The pool behind the sweep in progress, so {@link #cancel()} can reach it. */
    private volatile ExecutorService pool;

    LanScanner(int port, Log log) {
        this.port = port > 0 ? port : DEFAULT_PORT;
        this.activePort = this.port;
        this.log = log;
    }

    /** Report one line of progress, tolerating a scanner constructed without a sink. */
    private void log(String message) {
        Log sink = this.log;
        if (sink != null) sink.log(message);
    }

    /**
     * One address probed from first principles, with every stage reported separately.
     *
     * <p>Exposed so a sweep that finds nothing can be told apart from a broken sweep: the
     * fact that the subnet yields no host is only meaningful once this says the socket
     * itself works.
     */
    static final class Debug {

        static String probe(String ip, int port) {
            int actualPort = port > 0 ? port : DEFAULT_PORT;
            StringBuilder report = new StringBuilder();
            report.append("debug: localIpv4=").append(firstLocalIpv4());
            long started = System.currentTimeMillis();
            try {
                Socket socket = new Socket();
                socket.setSoTimeout(READ_TIMEOUT_MS);
                socket.connect(new InetSocketAddress(ip, actualPort), 2000);
                report.append(" connected=yes");
                socket.getOutputStream().write(("GET /m/api/status HTTP/1.1\r\n"
                        + "Host: " + ip + ":" + actualPort + "\r\n"
                        + "Accept: application/json\r\nConnection: close\r\n\r\n").getBytes("UTF-8"));
                socket.getOutputStream().flush();
                InputStream in = socket.getInputStream();
                byte[] buffer = new byte[2048];
                int read = in.read(buffer);
                String head = read > 0 ? new String(buffer, 0, read, "UTF-8") : "";
                report.append(" firstLine=").append(head.split("\r\n", 2)[0]);
                socket.close();
            } catch (Exception e) {
                report.append(" failed=").append(e.getClass().getSimpleName())
                        .append(":").append(e.getMessage());
            }
            report.append(" in ").append(System.currentTimeMillis() - started).append("ms");
            return report.toString();
        }

        /** How many addresses of the phone's subnet accept a TCP connection at all. */
        static String sweepStats(String phoneIp) {
            String self = phoneIp != null && isIpv4(phoneIp) ? phoneIp : firstLocalIpv4();
            if (self == null) return "debug: no local ip";
            String prefix = subnetPrefix(self);
            List<String> candidates = candidates(prefix, self);
            java.util.concurrent.atomic.AtomicInteger open = new java.util.concurrent.atomic.AtomicInteger();
            long started = System.currentTimeMillis();
            for (String ip : candidates) {
                try {
                    Socket socket = new Socket();
                    socket.connect(new InetSocketAddress(ip, DEFAULT_PORT), 250);
                    open.incrementAndGet();
                    socket.close();
                } catch (Exception ignored) {
                    // Closed port, which is the normal case.
                }
            }
            return "debug: subnet=" + prefix + ".0/24 open=" + open
                    + " in " + (System.currentTimeMillis() - started) + "ms";
        }

        /**
         * Read one address through the same code path a sweep uses, on a worker thread.
         *
         * <p>A single-address probe that works on the calling thread while the sweep finds
         * nothing points here: the difference is pool execution and the read of a full
         * response, not the network.
         */
        static String readVia(String ip, int port) {
            final int actualPort = port > 0 ? port : DEFAULT_PORT;
            ExecutorService pool = Executors.newFixedThreadPool(4);
            try {
                Future<String> task = pool.submit(() -> readStatus(ip, actualPort));
                try {
                    String status = task.get(5000, TimeUnit.MILLISECONDS);
                    if (status == null) return "readStatus(" + ip + ") = null";
                    return "readStatus(" + ip + ") len=" + status.length()
                            + " dsh=" + status.contains(SIGNATURE) + " head=" + status.substring(0, Math.min(60, status.length()));
                } catch (Exception e) {
                    return "readStatus(" + ip + ") threw " + e;
                }
            } finally {
                pool.shutdownNow();
            }
        }

        /**
         * Probe an explicit address list at a given width and report what came back.
         *
         * <p>The controlled form of {@link #classify}: same code path, but the address set
         * and the concurrency are both supplied, so a sweep that finds nothing can be
         * attributed to one of them instead of guessed at.
         */
        static String sweepList(List<String> addresses, int width) {
            java.util.concurrent.atomic.AtomicInteger answered = new java.util.concurrent.atomic.AtomicInteger();
            List<String> hosts = java.util.Collections.synchronizedList(new ArrayList<>());
            long started = System.currentTimeMillis();
            ExecutorService pool = Executors.newFixedThreadPool(Math.max(1, width));
            try {
                for (String ip : addresses) {
                    pool.submit(() -> {
                        String status = readStatus(ip, DEFAULT_PORT);
                        if (status != null) {
                            answered.incrementAndGet();
                            if (status.contains(SIGNATURE)) hosts.add(ip);
                        }
                    });
                }
            } finally {
                pool.shutdown();
                long batches = (addresses.size() + (long) Math.max(1, width) - 1) / Math.max(1, width);
                try {
                    pool.awaitTermination(batches * (CONNECT_TIMEOUT_MS + 120) + 900, TimeUnit.MILLISECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
            return "width=" + width + " n=" + addresses.size() + " answered=" + answered
                    + " hosts=" + hosts + " in " + (System.currentTimeMillis() - started) + "ms";
        }

        /**
         * Run a sweep and report what every probe produced, without stopping at the first
         * host.
         *
         * <p>This is what separates the two ways a sweep can find nothing: no address
         * answering (a network fact) from probes failing outright (a code fact).
         */
        static String classify(String phoneIp) {
            String self = phoneIp != null && isIpv4(phoneIp) ? phoneIp : firstLocalIpv4();
            if (self == null) return "debug: no local ip";
            List<String> candidates = candidates(subnetPrefix(self), self);
            java.util.concurrent.atomic.AtomicInteger answered = new java.util.concurrent.atomic.AtomicInteger();
            java.util.concurrent.atomic.AtomicInteger errors = new java.util.concurrent.atomic.AtomicInteger();
            List<String> hosts = java.util.Collections.synchronizedList(new ArrayList<>());
            List<String> samples = java.util.Collections.synchronizedList(new ArrayList<>());
            long started = System.currentTimeMillis();

            ExecutorService pool = Executors.newFixedThreadPool(SWEEP_BATCH);
            try {
                for (String ip : candidates) {
                    pool.submit(() -> {
                        try {
                            String status = readStatus(ip, DEFAULT_PORT);
                            if (status != null) {
                                answered.incrementAndGet();
                                if (status.contains(SIGNATURE)) hosts.add(ip + " [DSH]");
                                else if (samples.size() < 5) samples.add(ip + " [http, no signature]");
                            }
                        } catch (Throwable t) {
                            errors.incrementAndGet();
                            if (samples.size() < 5) samples.add(ip + " [" + t.getClass().getSimpleName() + "]");
                        }
                    });
                }
            } finally {
                pool.shutdown();
                long batches = (candidates.size() + (long) SWEEP_BATCH - 1) / SWEEP_BATCH;
                try {
                    pool.awaitTermination(batches * (CONNECT_TIMEOUT_MS + 120) + 800, TimeUnit.MILLISECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
            return "debug: swept=" + candidates.size() + " answered=" + answered
                    + " errors=" + errors + " hosts=" + hosts + " samples=" + samples
                    + " in " + (System.currentTimeMillis() - started) + "ms";
        }
    }

    /**
     * Sweep the phone's own subnet and return a DSH host, or null when none answers.
     *
     * @param phoneIp dotted-quad IPv4 of the phone on its current network, or null to
     *                enumerate interfaces and take the first private one
     */
    Found scan(String phoneIp) {
        String self = phoneIp != null && isIpv4(phoneIp) ? phoneIp : firstLocalIpv4();
        if (self == null) {
            log("discover: no local IPv4 address (WiFi off?)");
            return null;
        }
        String prefix = subnetPrefix(self);
        if (prefix == null) {
            log("discover: cannot derive a subnet from " + self);
            return null;
        }
        List<String> candidates = candidates(prefix, self);
        log("discover: local subnet " + prefix + ".0/24, " + self + ", port " + port
                + " (" + candidates.size() + " other addresses)");
        long started = System.currentTimeMillis();

        // A shortlist pass first. This is the reliable path, and it is why the sweep is not
        // the whole strategy: measured on a real /24 where the host answers a single probe
        // in 5 ms, a full-subnet pass returned nothing at all, three runs in a row, while a
        // shortlist of the same addresses succeeds. Addresses that a machine like this
        // actually uses cluster at the bottom, the top, and the hundred marks.
        //
        // Each pass is repeated over a short ladder of ports, for a reason that is about the
        // operator rather than the network: the host's port is configurable, and a phone that
        // only ever probes 19387 finds nothing at all when the host was moved — with the failure
        // indistinguishable from "no computer on this network". Every port in the ladder is
        // probed per address before moving on, so the host's own preferred port still wins.
        List<String> shortlist = shortlist(prefix, self);
        List<Integer> ladder = portLadder();
        log("discover: shortlist pass over " + shortlist.size() + " likely addresses, ports " + ladder);
        for (int candidatePort : ladder) {
            this.activePort = candidatePort;
            Found quick = sweep(shortlist, 3_000);
            if (quick != null) {
                log("discover: found " + quick.host + ":" + quick.port + " in the shortlist pass ("
                        + (System.currentTimeMillis() - started) + "ms)");
                return quick;
            }
        }

        // Full sweep as a fallback, time-boxed: it is slower and, on some networks, less
        // likely to answer than the shortlist above. Only the preferred port is swept in full,
        // because a full sweep per port would take minutes.
        this.activePort = port;
        log("discover: shortlist found nothing, sweeping the whole subnet on port " + port);
        Found found = sweep(candidates, FULL_SWEEP_DEADLINE_MS);
        log("discover: " + (found == null ? "nothing found" : "found " + found.host + ":" + found.port)
                + " in " + (System.currentTimeMillis() - started) + "ms");
        return found;
    }

    /**
     * The ports to probe, most likely first.
     *
     * Narrow on purpose: a ladder costs one shortlist pass each, and the point is only to cover the
     * plausible places an operator may have moved the host to. The value stored on the phone leads,
     * because that is what the host last said it was using; `DEFAULT_PORT` follows so a fresh
     * install and an unchanged host still meet on the first pass; the alternates exist so a hand-set
     * port has somewhere to fall back to if it is stale.
     */
    private List<Integer> portLadder() {
        List<Integer> ladder = new ArrayList<>();
        ladder.add(port);
        if (!ladder.contains(DEFAULT_PORT)) ladder.add(DEFAULT_PORT);
        for (int alternate : ALTERNATE_PORTS) {
            if (!ladder.contains(alternate)) ladder.add(alternate);
        }
        return ladder;
    }

    /**
     * The addresses worth trying before sweeping everything.
     *
     * <p>Low addresses (routers and the first few hosts), the low hundreds, and the top of
     * the range: between them that covers the practical placements for a desktop machine
     * like the one running the host.
     */
    private static List<String> shortlist(String prefix, String self) {
        List<String> list = new ArrayList<>();
        addRange(list, prefix, self, 1, 12);
        addRange(list, prefix, self, 50, 62);
        addRange(list, prefix, self, 100, 110);
        addRange(list, prefix, self, 150, 156);
        addRange(list, prefix, self, 200, 210);
        addRange(list, prefix, self, 240, 254);
        return list;
    }

    private static void addRange(List<String> list, String prefix, String self, int from, int to) {
        for (int i = from; i <= to; i++) {
            String ip = prefix + "." + i;
            if (!ip.equals(self)) list.add(ip);
        }
    }

    /**
     * Probe every candidate concurrently and return the first that answers like a DSH host.
     *
     * <p>The probes are plain blocking connects run on a fixed pool: a /24 is 253 connects
     * and the pool absorbs them, so the sweep costs one timeout window rather than 253
     * sequential ones. An earlier revision used a non-blocking selector here, and it
     * reported "nothing found" on a network where the host was demonstrably answering — the
     * channel bookkeeping was impossible to keep straight, and these are exactly the
     * addresses a silent failure must not be able to hide in.
     */
    private Found sweep(List<String> candidates, long budgetMs) {
        int threads = Math.max(8, Math.min(SWEEP_BATCH, candidates.size()));
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        this.pool = pool;
        List<Future<Found>> probes = new ArrayList<>(candidates.size());
        try {
            for (String ip : candidates) {
                probes.add(pool.submit(() -> {
                    int probePort = activePort;
                    String status = readStatus(ip, probePort);
                    return status != null && status.contains(SIGNATURE)
                            ? new Found(ip, status, probePort) : null;
                }));
            }
            long deadline = System.currentTimeMillis() + budgetMs;
            while (System.currentTimeMillis() < deadline) {
                for (Future<Found> probe : probes) {
                    if (!probe.isDone()) continue;
                    try {
                        Found found = probe.get();
                        if (found != null) return found;
                    } catch (Exception e) {
                        // A failed probe is ordinary: most addresses are not hosts.
                    }
                }
                if (pool.isTerminated()) break;
                Thread.sleep(25);
            }
            return null;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return null;
        } finally {
            for (Future<Found> probe : probes) {
                if (!probe.isDone()) probe.cancel(true);
            }
            pool.shutdownNow();
            if (this.pool == pool) this.pool = null;
        }
    }

    /**
     * Abandon a scan in progress.
     *
     * <p>Called when the user leaves the settings screen or starts another scan, so a
     * ten-second sweep does not keep opening sockets after its result is unwanted.
     */
    void cancel() {
        ExecutorService running = this.pool;
        if (running != null) {
            log("discover: cancelled");
            running.shutdownNow();
        }
    }

    /**
     * Whether one address currently answers like a DSH host.
     *
     * <p>Used to re-validate a remembered address before loading it, so a stale one is
     * replaced instead of producing a WebView error page.
     */
    static boolean looksLikeHost(String ip, int port) {
        String status = readStatus(ip, port > 0 ? port : DEFAULT_PORT,
                PROBE_CONNECT_TIMEOUT_MS, PROBE_READ_TIMEOUT_MS);
        return status != null && status.contains(SIGNATURE);
    }

    /**
     * Fetch `/m/api/status` from one address.
     *
     * @return the response body, or null when nothing usable arrived
     */
    private static String readStatus(String ip, int port) {
        return readStatus(ip, port, CONNECT_TIMEOUT_MS, READ_TIMEOUT_MS);
    }

    /** Fetch `/m/api/status`, with the caller choosing how patient to be. */
    private static String readStatus(String ip, int port, int connectTimeoutMs, int readTimeoutMs) {
        Socket socket = null;
        try {
            // A plain Socket, not a channel: setSoTimeout gives the read a deadline, which
            // is what keeps a silent port on the network from stalling the sweep.
            socket = new Socket();
            socket.setSoTimeout(readTimeoutMs);
            socket.connect(new InetSocketAddress(ip, port), connectTimeoutMs);

            String request = "GET /m/api/status HTTP/1.1\r\n"
                    + "Host: " + ip + ":" + port + "\r\n"
                    + "Accept: application/json\r\n"
                    + "Connection: close\r\n\r\n";
            socket.getOutputStream().write(request.getBytes("UTF-8"));
            socket.getOutputStream().flush();

            InputStream in = socket.getInputStream();
            byte[] buffer = new byte[4096];
            StringBuilder text = new StringBuilder();
            int total = 0;
            int read;
            while (total < 16384 && (read = in.read(buffer)) != -1) {
                text.append(new String(buffer, 0, read, "UTF-8"));
                total += read;
                if (!text.toString().contains(SIGNATURE) && total >= 8192) {
                    // Not our host: stop reading rather than wait out the timeout.
                    return null;
                }
            }
            String raw = text.toString();
            int body = raw.indexOf("\r\n\r\n");
            return body >= 0 ? raw.substring(body + 4) : raw;
        } catch (Exception e) {
            // Unreachable or not speaking HTTP: just not a host.
            return null;
        } finally {
            if (socket != null) {
                try {
                    socket.close();
                } catch (IOException ignored) {
                    // Closing best-effort.
                }
            }
        }
    }

    /** All addresses of the /24 to sweep, the phone's own address excluded. */
    private static List<String> candidates(String prefix, String self) {
        List<String> list = new ArrayList<>(254);
        for (int i = 1; i <= 254; i++) {
            String ip = prefix + "." + i;
            if (!ip.equals(self)) list.add(ip);
        }
        return list;
    }

    /** `a.b.c` for a dotted-quad address, or null when it is not one. */
    private static String subnetPrefix(String ip) {
        int last = ip.lastIndexOf('.');
        return last > 0 ? ip.substring(0, last) : null;
    }

    private static boolean isIpv4(String value) {
        String[] parts = value.split("\\.");
        if (parts.length != 4) return false;
        for (String part : parts) {
            try {
                int n = Integer.parseInt(part);
                if (n < 0 || n > 255) return false;
            } catch (NumberFormatException e) {
                return false;
            }
        }
        return true;
    }

    /** The phone's own IPv4 on a private network, or null when it has none. */
    static String currentIpv4() {
        return firstLocalIpv4();
    }

    /**
     * The phone's own IPv4 on a private network.
     *
     * <p>Prefers RFC1918 addresses, so a Tailscale address (100.64/10, also non-internal)
     * cannot be mistaken for the local network to sweep.
     */
    private static String firstLocalIpv4() {
        List<String> privateAddresses = new ArrayList<>();
        List<String> others = new ArrayList<>();
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            while (interfaces != null && interfaces.hasMoreElements()) {
                NetworkInterface nic = interfaces.nextElement();
                if (!nic.isUp() || nic.isLoopback()) continue;
                Enumeration<InetAddress> addresses = nic.getInetAddresses();
                while (addresses.hasMoreElements()) {
                    InetAddress address = addresses.nextElement();
                    if (!(address instanceof Inet4Address) || address.isLoopbackAddress()) continue;
                    String ip = address.getHostAddress();
                    if (!isIpv4(ip)) continue;
                    if (ip.startsWith("192.168.") || ip.startsWith("10.") || is172Private(ip)) {
                        privateAddresses.add(ip);
                    } else {
                        others.add(ip);
                    }
                }
            }
        } catch (Exception e) {
            return null;
        }
        if (!privateAddresses.isEmpty()) return privateAddresses.get(0);
        return others.isEmpty() ? null : others.get(0);
    }

    private static boolean is172Private(String ip) {
        if (!ip.startsWith("172.")) return false;
        int second = ip.indexOf('.');
        if (second < 0) return false;
        int end = ip.indexOf('.', second + 1);
        if (end < 0) return false;
        try {
            int n = Integer.parseInt(ip.substring(second + 1, end));
            return n >= 16 && n <= 31;
        } catch (NumberFormatException e) {
            return false;
        }
    }
}
