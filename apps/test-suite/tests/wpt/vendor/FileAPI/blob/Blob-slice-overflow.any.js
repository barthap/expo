// Vendored from web-platform-tests FileAPI/blob/Blob-slice-overflow.any.js at b0912c91005c07733ba19a2d93c712e8547df31a
// by scripts/vendor-wpt.mjs. BSD-3-Clause, see LICENSE-wpt.md. Do not edit.
export default function run() {
// META: title=Blob slice overflow
'use strict';

var text = '';

for (var i = 0; i < 2000; ++i) {
  text += 'A';
}

test(function() {
  var blob = new Blob([text]);
  var sliceBlob = blob.slice(-1, blob.size);
  assert_equals(sliceBlob.size, 1, "Blob slice size");
}, "slice start is negative, relativeStart will be max((size + start), 0)");

test(function() {
  var blob = new Blob([text]);
  var sliceBlob = blob.slice(blob.size + 1, blob.size);
  assert_equals(sliceBlob.size, 0, "Blob slice size");
}, "slice start is greater than blob size, relativeStart will be min(start, size)");

test(function() {
  var blob = new Blob([text]);
  var sliceBlob = blob.slice(blob.size - 2, -1);
  assert_equals(sliceBlob.size, 1, "Blob slice size");
}, "slice end is negative, relativeEnd will be max((size + end), 0)");

test(function() {
  var blob = new Blob([text]);
  var sliceBlob = blob.slice(blob.size - 2, blob.size + 999);
  assert_equals(sliceBlob.size, 2, "Blob slice size");
}, "slice end is greater than blob size, relativeEnd will be min(end, size)");

}
