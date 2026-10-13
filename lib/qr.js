/**
 * QR rendering for pairing links.
 *
 * The encoding core is vendored from the MIT-licensed `qrcode` package (see
 * `qr-vendor/LICENSE-qrcode`). That is a deliberate choice: the format-information
 * bit order and the mask-penalty scoring are easy to get subtly wrong, and a
 * subtly wrong pairing code fails silently on a phone. The vendored core is
 * byte-for-byte the upstream algorithm with only a CommonJS -> ESM mechanical
 * conversion; everything this module adds is the SVG rendering and the small,
 * stable API the plugin actually uses.
 *
 * @module dsh-mobile-public/qr
 */

import { create } from './qr-vendor/qrcode.js';

/** Error-correction level a pairing link should use. */
const DEFAULT_LEVEL = 'M';

/**
 * Encode text as a QR module matrix.
 * @param text - the payload to encode.
 * @param options - `level` is 'L' | 'M' | 'Q' | 'H'; `mask` forces a data mask.
 * @returns a square array of 0/1 rows.
 */
export function encodeMatrix(text, options = {}) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new TypeError('dsh-mobile-public/qr: text must be a non-empty string');
  }
  const symbol = create(text, {
    errorCorrectionLevel: options.level ?? DEFAULT_LEVEL,
    ...(options.mask === undefined ? {} : { maskPattern: options.mask })
  });
  const size = symbol.modules.size;
  const data = symbol.modules.data;
  const rows = [];
  for (let r = 0; r < size; r++) {
    const row = new Array(size);
    for (let c = 0; c < size; c++) row[c] = data[r * size + c] ? 1 : 0;
    rows.push(row);
  }
  return rows;
}

/**
 * Render text as a standalone SVG QR image.
 * @param text - the payload to encode.
 * @param options - `size` (pixels), `margin` (quiet-zone modules), `level`, `dark`, `light`.
 * @returns an SVG document string.
 */
export function toSvg(text, options = {}) {
  const margin = options.margin ?? 4;
  const pixelSize = options.size ?? 240;
  const dark = options.dark ?? '#000000';
  const light = options.light ?? '#ffffff';
  const modules = encodeMatrix(text, options);
  const count = modules.length;
  const total = count + margin * 2;
  const scale = pixelSize / total;

  const parts = [];
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (!modules[r][c]) continue;
      const x = ((c + margin) * scale).toFixed(3);
      const y = ((r + margin) * scale).toFixed(3);
      const w = scale.toFixed(3);
      parts.push(`M${x} ${y}h${w}v${w}h-${w}z`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${pixelSize}" height="${pixelSize}" `
    + `viewBox="0 0 ${pixelSize} ${pixelSize}" shape-rendering="crispEdges" role="img" `
    + `aria-label="QR code">`
    + `<rect width="${pixelSize}" height="${pixelSize}" fill="${light}"/>`
    + `<path d="${parts.join('')}" fill="${dark}"/>`
    + '</svg>';
}

/** Version of the encoded symbol, for diagnostics. */
export function versionOf(text, options = {}) {
  const symbol = create(text, { errorCorrectionLevel: options.level ?? DEFAULT_LEVEL });
  return symbol.version;
}
