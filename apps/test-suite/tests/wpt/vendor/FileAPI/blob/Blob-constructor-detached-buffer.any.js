// Vendored from web-platform-tests FileAPI/blob/Blob-constructor-detached-buffer.any.js at b0912c91005c07733ba19a2d93c712e8547df31a
// by scripts/vendor-wpt.mjs. BSD-3-Clause, see LICENSE-wpt.md. Do not edit.
export default function run() {
// META: title=Blob constructor with detached ArrayBuffer/ArrayBufferView
// META: script=../support/Blob.js
'use strict';

function detachBuffer(buffer) {
  // Transfer the buffer to detach it. Works in both window and worker contexts.
  new MessageChannel().port1.postMessage(buffer, [buffer]);
}

test_blob(function() {
  const buffer = new ArrayBuffer(4);
  const view = new Uint8Array(buffer);
  view[0] = 0x41;
  view[1] = 0x42;
  view[2] = 0x43;
  view[3] = 0x44;
  detachBuffer(buffer);
  return new Blob([view]);
}, {
  expected: '',
  type: '',
  desc: 'Blob from a detached ArrayBufferView should be empty'
});

test_blob(function() {
  const buffer = new ArrayBuffer(4);
  const view = new Uint8Array(buffer, 1, 2); // offset=1, length=2
  view[0] = 0x41;
  view[1] = 0x42;
  detachBuffer(buffer);
  return new Blob([view]);
}, {
  expected: '',
  type: '',
  desc: 'Blob from a detached ArrayBufferView with offset should be empty'
});

test_blob(function() {
  const buffer = new ArrayBuffer(4);
  detachBuffer(buffer);
  return new Blob([buffer]);
}, {
  expected: '',
  type: '',
  desc: 'Blob from a detached ArrayBuffer should be empty'
});

test_blob(function() {
  const buffer = new ArrayBuffer(4);
  const view = new Uint8Array(buffer);
  view[0] = 0x41;
  detachBuffer(buffer);
  // Mix detached view with a string
  return new Blob([view, 'hello']);
}, {
  expected: 'hello',
  type: '',
  desc: 'Blob from a detached ArrayBufferView mixed with string, detached part ignored'
});

}
