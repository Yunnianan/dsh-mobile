/**
 * Encode a QR and print it, so a real decoder can check the result.
 *
 * This is a smoke test for the encoder, not a self-checking one: it prints the matrix, and
 * `verify_qr.py` (in the project root) is what decodes it with OpenCV. A pairing code that
 * fails to scan is otherwise invisible until someone tries it.
 *
 * Usage:
 *   node qr-selftest.mjs                       # built-in sample
 *   node qr-selftest.mjs "some text" L         # explicit payload and EC level
 *
 * The import is relative on purpose: an earlier revision hard-coded the author's absolute
 * path, which made this file fail for anyone else — and it required an argument, so running
 * it with none crashed instead of printing anything.
 */
import { encodeMatrix, toSvg, versionOf } from "../lib/qr.js";

const text = process.argv[2] || "http://192.168.31.56:19387/m/pair?t=0123456789abcdef";
const level = process.argv[3] || "M";

const m = encodeMatrix(text, { level });
console.log("VERSION " + versionOf(text));
console.log("SIZE " + m.length);
for (const row of m) console.log(row.join(""));
console.log("SVG_LEN " + toSvg(text, { size: 256 }).length);
