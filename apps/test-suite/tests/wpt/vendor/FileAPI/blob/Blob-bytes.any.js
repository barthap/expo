// Vendored from web-platform-tests FileAPI/blob/Blob-bytes.any.js at b0912c91005c07733ba19a2d93c712e8547df31a
// by scripts/vendor-wpt.mjs. BSD-3-Clause, see LICENSE-wpt.md. Do not edit.
export default function run() {
// META: title=Blob bytes()
// META: script=../support/Blob.js
'use strict';

promise_test(async () => {
  const input_arr = new TextEncoder().encode("PASS");
  const blob = new Blob([input_arr]);
  const uint8array = await blob.bytes();
  assert_true(uint8array instanceof Uint8Array);
  assert_equals_typed_array(uint8array, input_arr);
}, "Blob.bytes()")

promise_test(async () => {
  const input_arr = new TextEncoder().encode("");
  const blob = new Blob([input_arr]);
  const uint8array = await blob.bytes();
  assert_true(uint8array instanceof Uint8Array);
  assert_equals_typed_array(uint8array, input_arr);
}, "Blob.bytes() empty Blob data")

promise_test(async () => {
  const input_arr = new TextEncoder().encode("\u08B8\u000a");
  const blob = new Blob([input_arr]);
  const uint8array = await blob.bytes();
  assert_equals_typed_array(uint8array, input_arr);
}, "Blob.bytes() non-ascii input")

promise_test(async () => {
  const input_arr = [8, 241, 48, 123, 151];
  const typed_arr = new Uint8Array(input_arr);
  const blob = new Blob([typed_arr]);
  const uint8array = await blob.bytes();
  assert_equals_typed_array(uint8array, typed_arr);
}, "Blob.bytes() non-unicode input")

promise_test(async () => {
  const input_arr = new TextEncoder().encode("PASS");
  const blob = new Blob([input_arr]);
  const uint8array_results = await Promise.all([blob.bytes(),
      blob.bytes(), blob.bytes()]);
  for (let uint8array of uint8array_results) {
    assert_true(uint8array instanceof Uint8Array);
    assert_equals_typed_array(uint8array, input_arr);
  }
}, "Blob.bytes() concurrent reads")

}
