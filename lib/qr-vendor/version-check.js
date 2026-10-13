/* Vendored from the MIT-licensed `qrcode` package (c) 2012 Ryan Day.
   See LICENSE-qrcode in this directory. Converted from CommonJS to ESM. */
/**
 * Check if QR Code version is valid
 *
 * @param  {Number}  version QR Code version
 * @return {Boolean}         true if valid version, false otherwise
 */
export function isValid(version) {
  return !isNaN(version) && version >= 1 && version <= 40
}
