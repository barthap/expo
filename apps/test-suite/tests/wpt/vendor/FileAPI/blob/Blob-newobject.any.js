// Vendored from web-platform-tests FileAPI/blob/Blob-newobject.any.js at b0912c91005c07733ba19a2d93c712e8547df31a
// by scripts/vendor-wpt.mjs. BSD-3-Clause, see LICENSE-wpt.md. Do not edit.
export default function run() {
// META: title=Blob methods return new objects ([NewObject])
// META: global=window,worker
'use strict';

['stream', 'text', 'arrayBuffer', 'bytes'].forEach(method => {
  test(() => {
    const blob = new Blob(['PASS']);
    const a = blob[method]();
    const b = blob[method]();
    assert_not_equals(a, b, `Blob.${method}() must return a new object`);
  }, `Blob.${method}() returns [NewObject]`);
});

}
