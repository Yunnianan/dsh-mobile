/* Vendored from the MIT-licensed `qrcode` package (c) 2012 Ryan Day.
   See LICENSE-qrcode in this directory. Converted from CommonJS to ESM. */
import * as _ns___mode from './mode.js';
/** Unwrap a module namespace that upstream exported with module.exports. */
function esmMod(ns) {
  return ('default' in ns) ? ns.default : ns;
}
const Mode = esmMod(_ns___mode)

function ByteData (data) {
  this.mode = Mode.BYTE
  if (typeof (data) === 'string') {
    this.data = new TextEncoder().encode(data)
  } else {
    this.data = new Uint8Array(data)
  }
}

ByteData.getBitsLength = function getBitsLength (length) {
  return length * 8
}

ByteData.prototype.getLength = function getLength () {
  return this.data.length
}

ByteData.prototype.getBitsLength = function getBitsLength () {
  return ByteData.getBitsLength(this.data.length)
}

ByteData.prototype.write = function (bitBuffer) {
  for (let i = 0, l = this.data.length; i < l; i++) {
    bitBuffer.put(this.data[i], 8)
  }
}

export default ByteData
