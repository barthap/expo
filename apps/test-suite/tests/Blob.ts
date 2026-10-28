/* eslint-disable getter-return */
/* eslint-disable no-new */
// Based on tests in https://github.com/web-platform-tests/wpt/tree/master/FileAPI/blob

import { Blob, type BlobPart } from 'expo-blob';
import { File as FileSystemFile, Paths } from 'expo-file-system';
import { Platform, requireOptionalNativeModule } from 'expo-modules-core';
import { releaseBlobFromReactNativeBlobStore, storeBlobInReactNativeBlobStore } from 'expo/blob';
import { fetch as expoFetch } from 'expo/fetch';
import React from 'react';
import { Image } from 'react-native';

import type { JasmineInterface, TestPortal } from '../types';

export const name = 'Blob';

const test_error = {
  name: 'test',
  message: 'test error',
};

type BlobExpectations = {
  expected: string;
  type: string;
  desc: string;
};

type BinaryBlobExpectations = {
  expected: number[];
  type: string;
  desc: string;
};

// A valid 1x1 grayscale PNG
const PNG_1X1 = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0, 0,
  0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 100, 96, 0, 0, 0, 6, 0, 2, 48, 129,
  208, 47, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

export async function test(
  { describe, it, expect, afterEach, pending }: JasmineInterface,
  { setPortalChild, cleanupPortal }: TestPortal
) {
  const test_blob = (fn: () => Blob, expectations: BlobExpectations) => {
    const expected = expectations.expected,
      type = expectations.type,
      desc = expectations.desc;

    it(desc, async () => {
      const blob = fn();
      expect(blob instanceof Blob).toBeTruthy();
      expect(blob instanceof File).toBeFalsy();
      expect(blob.type).toEqual(type);
      expect(blob.size).toBe(expected.length);

      const text = await blob.text();
      expect(text).toEqual(expected);
    });
  };
  const test_blob_binary = async (fn: () => Blob, expectations: BinaryBlobExpectations) => {
    const expected = expectations.expected,
      type = expectations.type,
      desc = expectations.desc;
    it(desc, async () => {
      const blob = fn();
      expect(blob instanceof Blob).toBeTruthy();
      expect(blob instanceof File).toBeFalsy();
      expect(blob.type).toBe(type);
      expect(blob.size).toBe(expected.length);

      const ab = await blob.arrayBuffer();
      expect(ab instanceof ArrayBuffer).toBeTruthy();
      expect(new Uint8Array(ab)).toEqual(new Uint8Array(expected));
    });
  };

  // Helper function that triggers garbage collection while reading a chunk
  // if perform_gc is true.
  const read_and_gc = async (
    reader: ReadableStreamDefaultReader<Uint8Array> | ReadableStreamBYOBReader,
    perform_gc: boolean
  ): Promise<ReadableStreamReadResult<Uint8Array>> => {
    // Passing Uint8Array for byte streams; non-byte streams will simply ignore it
    const read_promise = (reader as ReadableStreamBYOBReader).read(new Uint8Array(64));
    if (perform_gc) {
      // `gc` is a Hermes global; browsers do not define it, so a bare `gc` reference would throw
      globalThis.gc?.();
    }
    return read_promise;
  };

  // Takes in a ReadableStream and reads from it until it is done, returning
  // an array that contains the results of each read operation. If perform_gc
  // is true, garbage collection is triggered while reading every chunk.
  const read_all_chunks = async (
    stream: ReadableStream<Uint8Array>,
    { perform_gc = false, mode }: { perform_gc?: boolean; mode?: 'byob' } = {}
  ) => {
    expect(stream instanceof ReadableStream).toBeTruthy();
    expect('getReader' in stream).toBeTruthy();
    const reader = mode === 'byob' ? stream.getReader({ mode }) : stream.getReader();

    expect('read' in reader).toBeTruthy();
    let read_value = await read_and_gc(reader, perform_gc);

    const out: number[] = [];
    let i = 0;
    while (!read_value.done) {
      for (const val of read_value.value) {
        out[i++] = val;
      }
      read_value = await read_and_gc(reader, perform_gc);
    }
    return out;
  };

  describe('Blob', () => {
    describe('Blob creation', () => {
      it('Empty blob', () => {
        const blob = new Blob([]);
        expect(blob).toBeTruthy();
      });
      it('String blob', () => {
        const blob = new Blob(['ab', 'cd']);
        expect(blob).toBeTruthy();
      });
      it('TypedArray blob', () => {
        const blob = new Blob([Int32Array.from([-1, 2]), Uint8Array.from([1, 2, 0])]);
        expect(blob).toBeTruthy();
      });
      it('Blob blob', () => {
        const blob = new Blob([new Blob([]), new Blob(['a', 'b'])]);
        expect(blob).toBeTruthy();
      });
      it('Mixed blob', () => {
        const blob0 = new Blob([Int32Array.from([-1, 2]), Uint8Array.from([1, 2, 0])]);
        const blob1 = new Blob(['ab', 'cd']);
        const blob2 = new Blob(['a', new Blob([new Blob(['b'])])]);
        const blob = new Blob([blob0, blob1, blob2]);
        expect(blob).toBeTruthy();
      });
      it("Blob don't flatten", async () => {
        // @ts-expect-error a nested array is not a BlobPart; the spec stringifies it, which is what this checks
        const blob = new Blob(['aa', ['ab', 'cd'], 'ef']);
        expect(await blob.text()).toBe('aaab,cdef');
      });
      it('Unicode emotes', async () => {
        const blob = new Blob(['Hello 🌍 世界']);
        console.log('Hello 🌍 世界'.length);
        console.log(blob.size);
        expect(await blob.text()).toBe('Hello 🌍 世界');
        expect(await blob.bytes()).toEqual(
          Uint8Array.from([
            72, 101, 108, 108, 111, 32, 240, 159, 140, 141, 32, 228, 184, 150, 231, 149, 140,
          ])
        );
        expect(await blob.size).toBe(17);
      });
      it('accepts empty string parts', async () => {
        expect(new Blob(['']).size).toBe(0);
        expect(new Blob(['', 'a']).size).toBe(1);
        expect(await new Blob(['', 'a']).text()).toBe('a');
      });
      it('keeps NUL characters in both directions', async () => {
        const nul = String.fromCharCode(0);
        expect(new Blob([`a${nul}b`]).size).toBe(3);
        expect(await new Blob([nul]).text()).toBe(nul);
        expect(await new Blob([`a${nul}b`]).text()).toBe(`a${nul}b`);
        expect(await new Blob([nul.repeat(8)]).text()).toBe(nul.repeat(8));
        expect(await new Blob([new Uint8Array([0x61, 0, 0x62])]).text()).toBe(`a${nul}b`);
      });
      it('keeps NUL characters alongside non-ASCII ones', async () => {
        const mixed = `a${String.fromCharCode(0)}\u00e9 \u4e16\u754c \ud83c\udf0d`;
        expect(await new Blob([mixed]).text()).toBe(mixed);
      });
      it('Slicing emotes', async () => {
        const str = 'a🌍b'; // 'a' (1 byte) + '🌍' (4 bytes) + 'b' (1 byte) = 6 UTF-8 bytes
        const blob = new Blob([str]);

        // Slice at byte position 3 (middle of emoji)
        const slice = blob.slice(0, 3);
        const bytes = await slice.bytes();
        expect(slice.size).toBe(3);
        expect(bytes).toEqual(new TextEncoder().encode(str).slice(0, 3));
      });
      describe('large slice start and end', () => {
        it('large positive start', async () => {
          const blob = new Blob(['PASS']);
          const str = await blob.slice(10000).text();
          expect(str).toBe('');
        });
        it('large negative start', async () => {
          const blob = new Blob(['PASS']);
          const str = await blob.slice(-10000).text();
          expect(str).toBe('PASS');
        });
        it('large positive end', async () => {
          const blob = new Blob(['PASS']);
          const str = await blob.slice(0, 10000).text();
          expect(str).toBe('PASS');
        });
        it('large negative end', async () => {
          const blob = new Blob(['PASS']);
          const str = await blob.slice(0, -10000).text();
          expect(str).toBe('');
        });
      });
    });

    describe('Array buffer', () => {
      it('simple', async () => {
        const input_arr = new TextEncoder().encode('PASS');
        const blob = new Blob([input_arr]);
        const array_buffer = await blob.arrayBuffer();
        expect(array_buffer instanceof ArrayBuffer).toBeTruthy();
        expect(new Uint8Array(array_buffer)).toEqual(input_arr);
      });
      it('empty Blob data', async () => {
        const input_arr = new TextEncoder().encode('');
        const blob = new Blob([input_arr]);
        const array_buffer = await blob.arrayBuffer();
        expect(array_buffer instanceof ArrayBuffer).toBeTruthy();
        expect(new Uint8Array(array_buffer)).toEqual(input_arr);
      });
      it('non-ascii input', async () => {
        const input_arr = new TextEncoder().encode('\u08B8\u000a');
        const blob = new Blob([input_arr]);
        const array_buffer = await blob.arrayBuffer();
        expect(new Uint8Array(array_buffer)).toEqual(input_arr);
      });
      it('non-unicode input', async () => {
        const input_arr = [8, 241, 48, 123, 151];
        const typed_arr = new Uint8Array(input_arr);
        const blob = new Blob([typed_arr]);
        const array_buffer = await blob.arrayBuffer();
        expect(blob.size).toBe(5);
        expect(new Uint8Array(array_buffer)).toEqual(new Uint8Array(input_arr));
      });
      it('concurrent reads', async () => {
        const input_arr = new TextEncoder().encode('PASS');
        const blob = new Blob([input_arr]);
        const array_buffer_results = await Promise.all([
          blob.arrayBuffer(),
          blob.arrayBuffer(),
          blob.arrayBuffer(),
        ]);
        for (const array_buffer of array_buffer_results) {
          expect(array_buffer instanceof ArrayBuffer).toBeTruthy();
          expect(new Uint8Array(array_buffer)).toEqual(input_arr);
        }
      });
    });

    describe('Bytes', () => {
      it('Simple', async () => {
        const input_arr = new TextEncoder().encode('PASS');
        const blob = new Blob([input_arr]);
        const uint8array = await blob.bytes();
        expect(uint8array instanceof Uint8Array).toBeTruthy();
        expect(uint8array).toEqual(input_arr);
      });
      it('empty Blob data', async () => {
        const input_arr = new TextEncoder().encode('');
        const blob = new Blob([input_arr]);
        const uint8array = await blob.bytes();
        expect(uint8array instanceof Uint8Array).toBeTruthy();
        expect(uint8array).toEqual(input_arr);
      });
      it('non-ascii input', async () => {
        const input_arr = new TextEncoder().encode('\u08B8\u000a');
        const blob = new Blob([input_arr]);
        const uint8array = await blob.bytes();
        expect(uint8array).toEqual(input_arr);
      });
      it('non-unicode input', async () => {
        const input_arr = [8, 241, 48, 123, 151];
        const typed_arr = new Uint8Array(input_arr);
        const blob = new Blob([typed_arr]);
        const uint8array = await blob.bytes();
        expect(uint8array).toEqual(typed_arr);
      });
      it('concurrent reads', async () => {
        const input_arr = new TextEncoder().encode('PASS');
        const blob = new Blob([input_arr]);
        const uint8array_results = await Promise.all([blob.bytes(), blob.bytes(), blob.bytes()]);
        for (const uint8array of uint8array_results) {
          expect(uint8array instanceof Uint8Array).toBeTruthy();
          expect(uint8array).toEqual(input_arr);
        }
      });
    });

    // Windows platforms use CRLF as the native line ending. All others use LF.
    const crlf = Platform.OS === 'windows';
    const native_ending = crlf ? '\r\n' : '\n';
    describe('constructor-endings', () => {
      it('valid endings value', () => {
        const blob0 = new Blob([], { endings: 'native' });
        const blob1 = new Blob([], { endings: 'transparent' });
        expect(blob0).toBeTruthy();
        expect(blob1).toBeTruthy();
      });
      it('Invalid endings value', () => {
        [null, '', 'invalidEnumValue', 'Transparent', 'NATIVE', 0, {}].forEach((ending) => {
          // @ts-expect-error
          expect(() => new Blob([], { endings: ending })).toThrowError(TypeError);
        });
      });
      it('Exception propagation from options', () => {
        const test_error = { name: 'test string' };
        expect(
          () =>
            new Blob([], {
              // @ts-expect-error
              get endings() {
                throw test_error;
              },
            })
        ).toThrow(test_error);
      });

      it("The 'endings' options property is used", () => {
        let got = false;
        new Blob([], {
          // @ts-expect-error
          get endings() {
            got = true;
          },
        });
        expect(got).toBeTruthy();
      });
      const sampleEndings = [
        { name: 'LF', input: '\n', native: native_ending },
        { name: 'CR', input: '\r', native: native_ending },

        { name: 'CRLF', input: '\r\n', native: native_ending },
        { name: 'CRCR', input: '\r\r', native: native_ending.repeat(2) },
        { name: 'LFCR', input: '\n\r', native: native_ending.repeat(2) },
        { name: 'LFLF', input: '\n\n', native: native_ending.repeat(2) },

        { name: 'CRCRLF', input: '\r\r\n', native: native_ending.repeat(2) },
        { name: 'CRLFLF', input: '\r\n\n', native: native_ending.repeat(2) },
        { name: 'CRLFCR', input: '\r\n\r\n', native: native_ending.repeat(2) },

        { name: 'CRLFCRLF', input: '\r\n\r\n', native: native_ending.repeat(2) },
        { name: 'LFCRLFCR', input: '\n\r\n\r', native: native_ending.repeat(3) },
      ];
      it('Newlines should not change with endings unspecified', async () => {
        sampleEndings.forEach(async (testCase) => {
          const blob = new Blob([testCase.input]);
          expect(await blob.text()).toBe(testCase.input);
        });
      });
      it('Newlines should not change with endings "transparent"', async () => {
        sampleEndings.forEach(async (testCase) => {
          const blob = new Blob([testCase.input], { endings: 'transparent' });
          expect(await blob.text()).toBe(testCase.input);
        });
      });
      it('Newlines should match the platform with endings "native"', async () => {
        sampleEndings.forEach(async (testCase) => {
          const blob = new Blob([testCase.input], { endings: 'native' });
          expect(await blob.text()).toBe(testCase.native);
        });
      });
      it('CR/LF in adjacent input strings', async () => {
        const blob = new Blob(['\r', '\n'], { endings: 'native' });
        const expected = native_ending.repeat(2);
        expect(await blob.text()).toBe(expected);
      });
    });

    describe('constructor', () => {
      it('globalThis should have a Blob property.', () => {
        expect('Blob' in globalThis).toBeTruthy();
      });
      it('Blob.length should be 0', () => {
        expect(Blob.length).toBe(0);
      });
      it('Blob should be a function', () => {
        expect(Blob instanceof Function).toBeTruthy();
      });
      it('Blob constructor with no arguments', () => {
        const blob = new Blob();
        expect(blob instanceof Blob).toBeTruthy();
        expect(String(blob)).toBe('[object Blob]');
        expect(blob.size).toBe(0);
        expect(blob.type).toBe('');
      });
      it("Blob constructor with no arguments, without 'new'", () => {
        expect(() => {
          // @ts-ignore
          Blob();
        }).toThrowError(TypeError);
      });
      it('Blob constructor without brackets', () => {
        // prettier-ignore
        const blob = new Blob
        expect(blob instanceof Blob).toBeTruthy();
        expect(blob.size).toBe(0);
        expect(blob.type).toBe('');
      });
      it('Blob constructor with undefined as first argument', () => {
        const blob = new Blob(undefined);
        expect(blob instanceof Blob).toBeTruthy();
        expect(String(blob)).toBe('[object Blob]');
        expect(blob.size).toBe(0);
        expect(blob.type).toBe('');
      });

      it('Passing non-objects, Dates and RegExps for blobParts should throw a TypeError.', () => {
        [
          null,
          true,
          false,
          0,
          1,
          1.5,
          'FAIL',
          new Date(),
          // @ts-expect-error
          new RegExp(),
          {},
          { 0: 'FAIL', length: 1 },
        ].forEach((arg) => {
          // @ts-expect-error
          expect(() => new Blob(arg)).toThrowError(TypeError);
        });
      });
      test_blob(
        function () {
          return new Blob({
            [Symbol.iterator]: Array.prototype[Symbol.iterator],
          });
        },
        {
          expected: '',
          type: '',
          desc: 'A plain object with @@iterator should be treated as a sequence for the blobParts argument.',
        }
      );
      it('A plain object with custom @@iterator should be treated as a sequence for the blobParts argument.', () => {
        // @ts-expect-error a plain object is not an array of BlobParts; being iterable is enough at runtime
        const blob = new Blob({
          // @ts-ignore
          [Symbol.iterator]() {
            let i = 0;
            return {
              next: () =>
                [{ done: false, value: 'ab' }, { done: false, value: 'cde' }, { done: true }][i++],
            };
          },
        });
        expect(blob.size).toBe(5);
      });
      test_blob(
        function () {
          return new Blob({
            [Symbol.iterator]: Array.prototype[Symbol.iterator],
            0: 'PASS',
            length: 1,
          });
        },
        {
          expected: 'PASS',
          type: '',
          desc: 'A plain object with @@iterator and a length property should be treated as a sequence for the blobParts argument.',
        }
      );
      test_blob(
        function () {
          return new Blob(new String('xyz'));
        },
        {
          expected: 'xyz',
          type: '',
          desc: 'A String object should be treated as a sequence for the blobParts argument.',
        }
      );
      test_blob(
        function () {
          // @ts-expect-error a typed array is not a sequence of BlobParts; the spec iterates it anyway
          return new Blob(new Uint8Array([1, 2, 3]));
        },
        {
          expected: '123',
          type: '',
          desc: 'A Uint8Array object should be treated as a sequence for the blobParts argument.',
        }
      );

      it('The length getter should be invoked and any exceptions should be propagated.', () => {
        expect(() => {
          const obj = {
            [Symbol.iterator]: Array.prototype[Symbol.iterator],
            get length() {
              throw test_error;
            },
          };
          new Blob(obj);
        }).toThrow(test_error);
      });
      it('ToUint32 should be applied to the length and any exceptions should be propagated.', () => {
        expect(() => {
          const obj = {
            [Symbol.iterator]: Array.prototype[Symbol.iterator],
            length: {
              valueOf: null,
              toString() {
                throw test_error;
              },
            },
          };
          new Blob(obj);
        }).toThrow(test_error);
        expect(() => {
          const obj = {
            [Symbol.iterator]: Array.prototype[Symbol.iterator],
            length: {
              valueOf() {
                throw test_error;
              },
            },
          };
          new Blob(obj);
        }).toThrow(test_error);
      });
      it('Getters and value conversions should happen in order until an exception is thrown.', () => {
        const received: string[] = [];
        const obj = {
          get [Symbol.iterator]() {
            received.push('Symbol.iterator');
            return Array.prototype[Symbol.iterator];
          },
          get length() {
            received.push('length getter');
            return {
              valueOf() {
                received.push('length valueOf');
                return 3;
              },
            };
          },
          get 0() {
            received.push('0 getter');
            return {
              toString() {
                received.push('0 toString');
                return 'a';
              },
            };
          },
          get 1() {
            received.push('1 getter');
            throw test_error;
          },
          get 2() {
            received.push('2 getter');
            expect(true).toBe(false);
            return 'unreachable';
          },
        };
        expect(() => new Blob(obj)).toThrow(test_error);
        expect(received).toEqual([
          'Symbol.iterator',
          'length getter',
          'length valueOf',
          '0 getter',
          '0 toString',
          'length getter',
          'length valueOf',
          '1 getter',
        ]);
      });
      it('ToString should be called on elements of the blobParts array and any exceptions should be propagated.', () => {
        expect(
          () =>
            new Blob([
              {
                // @ts-expect-error an object with toString() is not a BlobPart; stringifying it is the point
                toString() {
                  throw test_error;
                },
              },
            ])
        ).toThrow(test_error);
        expect(
          () =>
            new Blob([
              {
                // @ts-expect-error an object with valueOf() is not a BlobPart; stringifying it is the point
                toString: undefined,
                valueOf() {
                  throw test_error;
                },
              },
            ])
        ).toThrow(test_error);
        expect(
          () =>
            new Blob([
              {
                toString() {
                  throw test_error;
                },
                // @ts-expect-error an object with toString()/valueOf() is not a BlobPart; stringifying it is the point
                valueOf() {
                  expect('Should not call valueOf if toString is present.').toBe('');
                },
              },
            ])
        ).toThrow(test_error);

        // @ts-expect-error null toString/valueOf make the object unstringifiable, which must throw TypeError
        expect(() => new Blob([{ toString: null, valueOf: null }])).toThrowError(TypeError);
      });
      test_blob(
        function () {
          const arr = [
            {
              toString() {
                arr.pop();
                return 'PASS';
              },
            },
            {
              toString() {
                expect(
                  'Should have removed the second element of the array rather than called toString() on it.'
                ).toBe('');
              },
            },
          ];
          // @ts-expect-error the array holds objects that are not BlobParts; they get stringified
          return new Blob(arr);
        },
        {
          expected: 'PASS',
          type: '',
          desc: 'Changes to the blobParts array should be reflected in the returned Blob (pop).',
        }
      );
      test_blob(
        function () {
          const arr = [
            {
              toString() {
                if (arr.length === 3) {
                  return 'A';
                }
                arr.unshift({
                  // @ts-ignore
                  toString() {
                    expect('Should only access index 0 once.').toBe('');
                  },
                });
                return 'P';
              },
            },
            {
              toString() {
                return 'SS';
              },
            },
          ];
          // @ts-expect-error the array holds objects that are not BlobParts; they get stringified
          return new Blob(arr);
        },
        {
          expected: 'PASS',
          type: '',
          desc: 'Changes to the blobParts array should be reflected in the returned Blob (unshift).',
        }
      );
      test_blob(
        function () {
          // https://www.w3.org/Bugs/Public/show_bug.cgi?id=17652
          // None of these are valid BlobParts. The spec requires each to be
          // stringified, which is exactly what this case checks, so the array is
          // cast rather than carrying a directive on every entry.
          return new Blob([
            null,
            undefined,
            true,
            false,
            0,
            1,
            new String('stringobject'),
            [],
            ['x', 'y'],
            {},
            { 0: 'FAIL', length: 1 },
            {
              toString() {
                return 'stringA';
              },
            },
            {
              toString: undefined,
              valueOf() {
                return 'stringB';
              },
            },
            {
              valueOf() {
                expect('Should not call valueOf if toString is present on the prototype.').toBe('');
              },
            },
          ] as unknown as BlobPart[]);
        },
        {
          expected:
            'nullundefinedtruefalse01stringobjectx,y[object Object][object Object]stringAstringB[object Object]',
          type: '',
          desc: 'ToString should be called on elements of the blobParts array.',
        }
      );
      test_blob(
        function () {
          return new Blob([new ArrayBuffer(8)]);
        },
        {
          expected: '\0\0\0\0\0\0\0\0',
          type: '',
          desc: 'ArrayBuffer elements of the blobParts array should be supported.',
        }
      );

      test_blob(
        function () {
          return new Blob([
            new Uint8Array([0x50, 0x41, 0x53, 0x53]),
            new Int8Array([0x50, 0x41, 0x53, 0x53]),
            new Uint16Array([0x4150, 0x5353]),
            new Int16Array([0x4150, 0x5353]),
            new Uint32Array([0x53534150]),
            new Int32Array([0x53534150]),
            new Float32Array([0xd341500000]),
          ]);
        },
        {
          expected: 'PASSPASSPASSPASSPASSPASSPASS',
          type: '',
          desc: 'Passing typed arrays as elements of the blobParts array should work.',
        }
      );
      // The Float16Array is not supported
      //  https://github.com/facebook/hermes/blob/5372b97d40d019de1e74f71c5237cdba3003b7d2/unsupported/juno/crates/juno/src/sema/known_globals.rs#L48
      //  https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Float16Array
      // test_blob(
      //   function () {
      //     return new Blob([new Float16Array([2.65625, 58.59375])]);
      //   },
      //   {
      //     expected: 'PASS',
      //     type: '',
      //     desc: 'Passing a Float16Array as element of the blobParts array should work.',
      //   }
      // );
      test_blob(
        function () {
          return new Blob([
            // 0x535 3415053534150
            // 0x535 = 0b010100110101 -> Sign = +, Exponent = 1333 - 1023 = 310
            // 0x13415053534150 * 2**(-52)
            // ==> 0x13415053534150 * 2**258 = 2510297372767036725005267563121821874921913208671273727396467555337665343087229079989707079680
            new Float64Array([
              2510297372767036725005267563121821874921913208671273727396467555337665343087229079989707079680,
            ]),
          ]);
        },
        {
          expected: 'PASSPASS',
          type: '',
          desc: 'Passing a Float64Array as element of the blobParts array should work.',
        }
      );
      test_blob(
        function () {
          return new Blob([
            new BigInt64Array([BigInt('0x5353415053534150')]),
            new BigUint64Array([BigInt('0x5353415053534150')]),
          ]);
        },
        {
          expected: 'PASSPASSPASSPASS',
          type: '',
          desc: 'Passing BigInt typed arrays as elements of the blobParts array should work.',
        }
      );

      // Message channel doesn't exist in React Native
      // it("Passing a FrozenArray as the blobParts array should work (FrozenArray<MessagePort>).", async () => {
      //     const channel = new MessageChannel();
      //     channel.port2.onmessage = this.step_func(function(e) {
      //         const b_ports = new Blob(e.ports);
      //         expect(b_ports.size).toEqual("[object MessagePort]".length)
      //         this.done();
      //     });
      //     const channel2 = new MessageChannel();
      //     channel.port1.postMessage('', [channel2.port1]);
      // })
      it('Passing a FrozenArray as the blobParts array should work', async () => {
        const arr = ['PA', 'SS'];
        Object.freeze(arr);
        expect(await new Blob(arr).text()).toBe('PASS');
      });

      test_blob(
        function () {
          const blob = new Blob(['foo']);
          return new Blob([blob, blob]);
        },
        {
          expected: 'foofoo',
          type: '',
          desc: 'Array with two blobs',
        }
      );
      test_blob_binary(
        function () {
          const view = new Uint8Array([0, 255, 0]);
          return new Blob([view.buffer, view.buffer]);
        },
        {
          expected: [0, 255, 0, 0, 255, 0],
          type: '',
          desc: 'Array with two buffers',
        }
      );

      test_blob_binary(
        function () {
          const view = new Uint8Array([0, 255, 0, 4]);
          const blob = new Blob([view, view]);
          expect(blob.size).toBe(8);
          const view1 = new Uint16Array(view.buffer, 2);
          return new Blob([view1, view.buffer, view1]);
        },
        {
          expected: [0, 4, 0, 255, 0, 4, 0, 4],
          type: '',
          desc: 'Array with two bufferviews',
        }
      );

      test_blob(
        function () {
          const view = new Uint8Array([0]);
          const blob = new Blob(['fo']);
          return new Blob([view.buffer, blob, 'foo']);
        },
        {
          expected: '\0fofoo',
          type: '',
          desc: 'Array with mixed types',
        }
      );

      it('options properties should be accessed in lexicographic order.', async () => {
        const accessed: string[] = [];
        const stringified: string[] = [];

        new Blob([], {
          // @ts-ignore
          get type() {
            accessed.push('type');
          },
          // @ts-ignore
          get endings() {
            accessed.push('endings');
          },
        });

        new Blob([], {
          // @ts-ignore
          type: {
            toString: () => {
              stringified.push('type');
              return '';
            },
          },
          // @ts-ignore
          endings: {
            toString: () => {
              stringified.push('endings');
              return 'transparent';
            },
          },
        });
        expect(accessed).toEqual(['endings', 'type']);
        expect(stringified).toEqual(['endings', 'type']);
      });

      it('Arguments should be evaluated from left to right.', async () => {
        expect(
          () =>
            new Blob(
              [
                {
                  // @ts-expect-error an object with toString() is not a BlobPart; stringifying it is the point
                  toString() {
                    throw test_error;
                  },
                },
              ],
              {
                //@ts-ignore
                get type() {
                  expect(0).toBe(1);
                },
              }
            )
        ).toThrow(test_error);
      });

      describe('Passing arguments for options', () => {
        [null, undefined, {}, { unrecognized: true }, /regex/, function () {}].forEach(
          (arg: any, idx) => {
            test_blob(
              function () {
                return new Blob([], arg);
              },
              {
                expected: '',
                type: '',
                desc:
                  'Passing ' +
                  JSON.stringify(arg) +
                  ' (index ' +
                  idx +
                  ') for options should use the defaults.',
              }
            );
            test_blob(
              function () {
                return new Blob(['\na\r\nb\n\rc\r'], arg);
              },
              {
                expected: '\na\r\nb\n\rc\r',
                type: '',
                desc:
                  'Passing ' +
                  JSON.stringify(arg) +
                  ' (index ' +
                  idx +
                  ') for options should use the defaults (with newlines).',
              }
            );
          }
        );
      });

      describe('Blob constructor should throw with invalid property bag', () => {
        [123, 123.4, true, 'abc'].forEach((arg: any) => {
          it('Passing ' + JSON.stringify(arg) + ' for options should throw', () => {
            expect(() => {
              new Blob([], arg);
            }).toThrowError(TypeError);
          });
        });
      });

      describe('Type test', () => {
        const type_tests = [
          // blobParts, type, expected type
          [[], '', ''],
          [[], 'a', 'a'],
          [[], 'A', 'a'],
          [[], 'text/html', 'text/html'],
          [[], 'TEXT/HTML', 'text/html'],
          [[], 'text/plain;charset=utf-8', 'text/plain;charset=utf-8'],
          [[], '\u00E5', ''],
          [[], '\uD801\uDC7E', ''], // U+1047E
          [[], ' image/gif ', ' image/gif '],
          [[], '\timage/gif\t', ''],
          [[], 'image/gif;\u007f', ''],
          [[], '\u0130mage/gif', ''], // uppercase i with dot
          [[], '\u0131mage/gif', ''], // lowercase dotless i
          [[], 'image/gif\u0000', ''],
          // check that type isn't changed based on sniffing
          [[0x3c, 0x48, 0x54, 0x4d, 0x4c, 0x3e], 'unknown/unknown', 'unknown/unknown'], // "<HTML>"
          [[0x00, 0xff], 'text/plain', 'text/plain'],
          [[0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 'image/png', 'image/png'], // "GIF89a"
        ];

        type_tests.forEach(function (t: any[]) {
          it('Blob with type ' + JSON.stringify(t[1]), () => {
            const arr = new Uint8Array([t[0]]).buffer;
            const b = new Blob([arr], { type: t[1] });
            expect(b.type).toEqual(t[2]);
          });
        });
      });
    });

    describe('Text', () => {
      it('simple', async () => {
        const blob = new Blob(['PASS']);
        const text = await blob.text();
        expect(text).toBe('PASS');
      });
      it('empty blob data', async () => {
        const blob = new Blob();
        const text = await blob.text();
        expect(text).toBe('');
      });
      it('multi-element array in constructor', async () => {
        const blob = new Blob(['P', 'A', 'SS']);
        const text = await blob.text();
        expect(text).toBe('PASS');
      });
      it('non-unicode', async () => {
        const non_unicode = '\u0061\u030A';
        const input_arr = new TextEncoder().encode(non_unicode);
        const blob = new Blob([input_arr]);
        const text = await blob.text();
        expect(text).toBe(non_unicode);
      });
      it('different charset param in type option', async () => {
        const blob = new Blob(['PASS'], { type: 'text/plain;charset=utf-16le' });
        const text = await blob.text();
        expect(text).toBe('PASS');
      });
      it('different charset param with non-ascii input', async () => {
        const non_unicode = '\u0061\u030A';
        const input_arr = new TextEncoder().encode(non_unicode);
        const blob = new Blob([input_arr], { type: 'text/plain;charset=utf-16le' });
        const text = await blob.text();
        expect(text).toBe(non_unicode);
      });
      it('invalid utf-8 input', async () => {
        const input_arr = new Uint8Array([
          192, 193, 245, 246, 247, 248, 249, 250, 251, 252, 253, 254, 255,
        ]);
        const blob = new Blob([input_arr]);
        const text = await blob.text();
        expect(text).toBe(
          '\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd'
        );
      });
      it('Blob.text() concurrent reads', async () => {
        const input_arr = new Uint8Array([
          192, 193, 245, 246, 247, 248, 249, 250, 251, 252, 253, 254, 255,
        ]);
        const blob = new Blob([input_arr]);
        const text_results = await Promise.all([blob.text(), blob.text(), blob.text()]);
        text_results.forEach((text) => {
          expect(text).toBe(
            '\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd'
          );
        });
      });
    });

    describe('Worker', () => {
      it('Create Blob in Worker', async () => {
        const data = 'TEST';
        const blob = new Blob([data], { type: 'text/plain' });
        expect(await blob.text()).toEqual(data);
      });
    });

    describe('Blob slice overflow', () => {
      let text = '';

      for (let i = 0; i < 2000; ++i) {
        text += 'A';
      }

      it('slice start is negative, relativeStart will be max((size + start), 0)', () => {
        const blob = new Blob([text]);
        const sliceBlob = blob.slice(-1, blob.size);
        expect(sliceBlob.size).toBe(1);
      });

      it('slice start is greater than blob size, relativeStart will be min(start, size)', () => {
        const blob = new Blob([text]);
        const sliceBlob = blob.slice(blob.size + 1, blob.size);
        expect(sliceBlob.size).toBe(0);
      });

      it('slice end is negative, relativeEnd will be max((size + end), 0)', () => {
        const blob = new Blob([text]);
        const sliceBlob = blob.slice(blob.size - 2, -1);
        expect(sliceBlob.size).toBe(1);
      });

      it('slice end is greater than blob size, relativeEnd will be min(end, size)', () => {
        const blob = new Blob([text]);
        const sliceBlob = blob.slice(blob.size - 2, blob.size + 999);
        expect(sliceBlob.size).toBe(2);
      });
    });

    describe('Blob Slice', () => {
      test_blob(
        () => {
          const blobTemp = new Blob(['PASS']);
          return blobTemp.slice();
        },
        {
          expected: 'PASS',
          type: '',
          desc: 'no-argument Blob slice',
        }
      );

      describe('Slices', () => {
        const blob1 = new Blob(['squiggle']);
        const blob2 = new Blob(['steak'], { type: 'content/type' });

        test_blob(() => blob1, {
          expected: 'squiggle',
          type: '',
          desc: 'blob1.',
        });

        test_blob(() => blob2, {
          expected: 'steak',
          type: 'content/type',
          desc: 'blob2.',
        });

        test_blob(
          () => {
            // @ts-expect-error null is not a valid contentType; the spec coerces it to a string
            return new Blob().slice(0, 0, null);
          },
          {
            expected: '',
            type: 'null',
            desc: 'null type Blob slice',
          }
        );

        test_blob(
          () => {
            return new Blob().slice(0, 0, undefined);
          },
          {
            expected: '',
            type: '',
            desc: 'undefined type Blob slice',
          }
        );

        test_blob(
          () => {
            return new Blob().slice(0, 0);
          },
          {
            expected: '',
            type: '',
            desc: 'no type Blob slice',
          }
        );

        const arrayBuffer = new ArrayBuffer(16);
        const int8View = new Int8Array(arrayBuffer);
        for (let i = 0; i < 16; i++) {
          int8View[i] = i + 65;
        }

        type SliceExpectation = { start?: number; end?: number; contents: string };
        const testData: [BlobPart[], SliceExpectation[]][] = [
          [
            ['PASSSTRING'],
            [
              { start: -6, contents: 'STRING' },
              { start: -12, contents: 'PASSSTRING' },
              { start: 4, contents: 'STRING' },
              { start: 12, contents: '' },
              { start: 0, end: -6, contents: 'PASS' },
              { start: 0, end: -12, contents: '' },
              { start: 0, end: 4, contents: 'PASS' },
              { start: 0, end: 12, contents: 'PASSSTRING' },
              { start: 7, end: 4, contents: '' },
            ],
          ],

          // Test 3 strings
          [
            ['foo', 'bar', 'baz'],
            [
              { start: 0, end: 9, contents: 'foobarbaz' },
              { start: 0, end: 3, contents: 'foo' },
              { start: 3, end: 9, contents: 'barbaz' },
              { start: 6, end: 9, contents: 'baz' },
              { start: 6, end: 12, contents: 'baz' },
              { start: 0, end: 9, contents: 'foobarbaz' },
              { start: 0, end: 11, contents: 'foobarbaz' },
              { start: 10, end: 15, contents: '' },
            ],
          ],

          // Test string, Blob, string
          [
            ['foo', blob1, 'baz'],
            [
              { start: 0, end: 3, contents: 'foo' },
              { start: 3, end: 11, contents: 'squiggle' },
              { start: 2, end: 4, contents: 'os' },
              { start: 10, end: 12, contents: 'eb' },
            ],
          ],

          // Test blob, string, blob
          [
            [blob1, 'foo', blob1],
            [
              { start: 0, end: 8, contents: 'squiggle' },
              { start: 7, end: 9, contents: 'ef' },
              { start: 10, end: 12, contents: 'os' },
              { start: 1, end: 4, contents: 'qui' },
              { start: 12, end: 15, contents: 'qui' },
              { start: 40, end: 60, contents: '' },
            ],
          ],

          // Test blobs all the way down
          [
            [blob2, blob1, blob2],
            [
              { start: 0, end: 5, contents: 'steak' },
              { start: 5, end: 13, contents: 'squiggle' },
              { start: 13, end: 18, contents: 'steak' },
              { start: 1, end: 3, contents: 'te' },
              { start: 6, end: 10, contents: 'quig' },
            ],
          ],

          // Test an ArrayBufferView
          [
            [int8View, blob1, 'foo'],
            [
              { start: 0, end: 8, contents: 'ABCDEFGH' },
              { start: 8, end: 18, contents: 'IJKLMNOPsq' },
              { start: 17, end: 20, contents: 'qui' },
              { start: 4, end: 12, contents: 'EFGHIJKL' },
            ],
          ],

          // Test a partial ArrayBufferView
          [
            [new Uint8Array(arrayBuffer, 3, 5), blob1, 'foo'],
            [
              { start: 0, end: 8, contents: 'DEFGHsqu' },
              { start: 8, end: 18, contents: 'igglefoo' },
              { start: 4, end: 12, contents: 'Hsquiggl' },
            ],
          ],

          // Test type coercion of a number
          [
            // @ts-expect-error a number is not a BlobPart; coercing it is the point of this row.
            [3, int8View, 'foo'],
            [
              { start: 0, end: 8, contents: '3ABCDEFG' },
              { start: 8, end: 18, contents: 'HIJKLMNOPf' },
              { start: 17, end: 21, contents: 'foo' },
              { start: 4, end: 12, contents: 'DEFGHIJK' },
            ],
          ],

          [
            [new Uint8Array([0, 255, 0]).buffer, new Blob(['abcd']), 'efgh', 'ijklmnopqrstuvwxyz'],
            [
              { start: 1, end: 4, contents: '\uFFFD\u0000a' },
              { start: 4, end: 8, contents: 'bcde' },
              { start: 8, end: 12, contents: 'fghi' },
              { start: 1, end: 12, contents: '\uFFFD\u0000abcdefghi' },
            ],
          ],
        ];

        testData.forEach(function (data, i) {
          const blobs = data[0];
          const tests = data[1];
          tests.forEach(function (expectations, j) {
            describe('Slicing test (' + i + ',' + j + ').', () => {
              const blob = new Blob(blobs);

              it('blob is an instance of Blob', () => {
                expect(blob instanceof Blob).toBeTruthy();
                expect(blob instanceof File).toBeFalsy();
              });

              test_blob(
                () => {
                  return expectations.end === undefined
                    ? blob.slice(expectations.start)
                    : blob.slice(expectations.start, expectations.end);
                },
                {
                  expected: expectations.contents,
                  type: '',
                  desc: 'Slicing test: slice (' + i + ',' + j + ').',
                }
              );
            });
          });
        });
      });

      describe('Invalid content types', () => {
        const invalidTypes = [
          '\xFF',
          'te\x09xt/plain',
          'te\x00xt/plain',
          'te\x1Fxt/plain',
          'te\x7Fxt/plain',
        ];
        invalidTypes.forEach(function (type) {
          test_blob(
            () => {
              const blob = new Blob(['PASS']);
              return blob.slice(0, 4, type);
            },
            {
              expected: 'PASS',
              type: '',
              desc: 'Invalid contentType (' + JSON.stringify(type) + ')',
            }
          );
        });
      });

      const validTypes = [
        'te(xt/plain',
        'te)xt/plain',
        'te<xt/plain',
        'te>xt/plain',
        'te@xt/plain',
        'te,xt/plain',
        'te;xt/plain',
        'te:xt/plain',
        'te\\xt/plain',
        'te"xt/plain',
        'te/xt/plain',
        'te[xt/plain',
        'te]xt/plain',
        'te?xt/plain',
        'te=xt/plain',
        'te{xt/plain',
        'te}xt/plain',
        'te\x20xt/plain',
        'TEXT/PLAIN',
        'text/plain;charset = UTF-8',
        'text/plain;charset=UTF-8',
      ];
      describe('valid content types', () => {
        validTypes.forEach((type) => {
          test_blob(
            () => {
              const blob = new Blob(['PASS']);
              return blob.slice(0, 4, type);
            },
            {
              expected: 'PASS',
              type: type.toLowerCase(),
              desc: 'Valid contentType (' + JSON.stringify(type) + ')',
            }
          );
        });
      });
    });

    describe('stream', () => {
      it('stream byob crash', async () => {
        // @ts-expect-error undefined is not a BlobPart; the spec stringifies it
        const a = new Blob(['', '', undefined], {});
        const b = a.stream();
        const c = new ReadableStreamBYOBReader(b);
        const d = new Int16Array(8);
        await c.read(d);
        c.releaseLock();
        await a.text();
        await b.cancel();
      });

      it('stream xhr crash', async () => {
        // @ts-expect-error numbers are not BlobParts; the spec stringifies them
        const blob = new Blob([1, 2]);
        const readable = blob.stream();
        const writable = new WritableStream(
          {},
          {
            // @ts-ignore
            size() {
              const xhr = new XMLHttpRequest();
              xhr.open('POST', '1', false);
              xhr.send();
            },
          }
        );
        readable.pipeThrough({ readable, writable });
      });

      it('Blob.stream()', async () => {
        const blob = new Blob(['PASS']);
        const stream = blob.stream();
        const chunks = await read_all_chunks(stream);
        for (const [index, value] of chunks.entries()) {
          expect(value).toEqual('PASS'.charCodeAt(index));
        }
      });

      it('Blob.stream() empty Blob', async () => {
        const blob = new Blob();
        const stream = blob.stream();
        const chunks = await read_all_chunks(stream);
        expect(chunks).toEqual([]);
      });

      it('Blob.stream() non-unicode input', async () => {
        const input_arr = [8, 241, 48, 123, 151];
        const typed_arr = new Uint8Array(input_arr);
        const blob = new Blob([typed_arr]);
        const stream = blob.stream();
        const chunks = await read_all_chunks(stream);
        expect(chunks).toEqual(input_arr);
      });

      it("Blob.stream() garbage collection of blob shouldn't break stream consumption", async () => {
        const input_arr = [8, 241, 48, 123, 151];
        const typed_arr = new Uint8Array(input_arr);
        let blob: Blob | null = new Blob([typed_arr]);
        const stream = blob.stream();
        blob = null;
        globalThis.gc?.();
        const chunks = await read_all_chunks(stream, { perform_gc: true });
        expect(chunks).toEqual(input_arr);
      });

      it("Blob.stream() garbage collection of stream shouldn't break stream consumption", async () => {
        const input_arr = [8, 241, 48, 123, 151];
        const typed_arr = new Uint8Array(input_arr);
        const blob = new Blob([typed_arr]);
        const chunksPromise = read_all_chunks(blob.stream());
        globalThis.gc?.();
        expect(await chunksPromise).toEqual(input_arr);
      });

      it('Reading Blob.stream() with BYOB reader', async () => {
        const input_arr = [8, 241, 48, 123, 151];
        const typed_arr = new Uint8Array(input_arr);
        const blob = new Blob([typed_arr]);
        const stream = blob.stream();
        const chunks = await read_all_chunks(stream, { mode: 'byob' });
        expect(chunks).toEqual(input_arr);
      });
    });

    // React Native's blob store, its URL.createObjectURL and its Image exist only on native.
    if (Platform.OS !== 'web') {
      describe('React Native blob store', () => {
        // React Native's own Blob only holds a `{ blobId, offset, size }` handle; consumers such as
        // FileReader resolve the bytes from the native blob store by id. These tests check that bytes
        // registered from an expo Blob are what React Native reads back, and that releasing removes them.
        const BlobManager = require('react-native/Libraries/Blob/BlobManager').default;

        const createReactNativeBlob = (blobId: string, blob: Blob) =>
          BlobManager.createFromOptions({
            blobId,
            offset: 0,
            size: blob.size,
            type: blob.type,
            lastModified: Date.now(),
          });

        const readWithFileReader = (
          reactNativeBlob: unknown,
          method: 'readAsArrayBuffer' | 'readAsText'
        ): Promise<any> =>
          new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.addEventListener('load', () => resolve(reader.result));
            reader.addEventListener('error', () => reject(reader.error));
            reader[method](reactNativeBlob as any);
          });

        it('React Native reads back the stored bytes', async () => {
          const blob = new Blob(['ab', new Uint8Array([0, 255, 128, 10, 13]), new Blob(['cd'])], {
            type: 'application/octet-stream',
          });
          const blobId = storeBlobInReactNativeBlobStore(blob);
          try {
            const buffer = await readWithFileReader(
              createReactNativeBlob(blobId, blob),
              'readAsArrayBuffer'
            );
            expect(Array.from(new Uint8Array(buffer))).toEqual(Array.from(await blob.bytes()));
          } finally {
            releaseBlobFromReactNativeBlobStore(blobId);
          }
        });

        it('React Native reads back the stored text', async () => {
          const blob = new Blob(['hello, ', 'świecie 🌍'], { type: 'text/plain' });
          const blobId = storeBlobInReactNativeBlobStore(blob);
          try {
            const text = await readWithFileReader(
              createReactNativeBlob(blobId, blob),
              'readAsText'
            );
            expect(text).toEqual('hello, świecie 🌍');
          } finally {
            releaseBlobFromReactNativeBlobStore(blobId);
          }
        });

        it('stored bytes outlive the source Blob', async () => {
          let blob: Blob | null = new Blob(['still here']);
          const size = blob.size;
          const blobId = storeBlobInReactNativeBlobStore(blob);
          blob = null;
          globalThis.gc?.();
          try {
            const text = await readWithFileReader(
              BlobManager.createFromOptions({ blobId, offset: 0, size }),
              'readAsText'
            );
            expect(text).toEqual('still here');
          } finally {
            releaseBlobFromReactNativeBlobStore(blobId);
          }
        });

        it('released bytes can no longer be read', async () => {
          const blob = new Blob(['gone']);
          const blobId = storeBlobInReactNativeBlobStore(blob);
          releaseBlobFromReactNativeBlobStore(blobId);

          let error: any = null;
          try {
            await readWithFileReader(createReactNativeBlob(blobId, blob), 'readAsText');
          } catch (e) {
            error = e;
          }
          // React Native's FileReader rejects natively when the id is missing from the store and
          // reports it as a NotReadableError.
          expect(error).not.toBeNull();
          expect(error.name).toEqual('NotReadableError');
        });

        it('releasing an unknown id does not throw', () => {
          expect(() => releaseBlobFromReactNativeBlobStore('unknown-blob-id')).not.toThrow();
        });
      });

      describe('URL.createObjectURL', () => {
        // An object URL is how Blob bytes reach native consumers that only take a URI, such as
        // `Image`. React Native serves the URL from its blob store, so these tests go through
        // React Native's own consumers instead of reading the store back from JS.
        const readWithXhr = (url: string): Promise<ArrayBuffer> =>
          new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            // Android serves non-HTTP URIs to XHR only for the 'blob' response type.
            xhr.responseType = 'blob';
            xhr.onload = () => {
              const reader = new FileReader();
              reader.addEventListener('load', () => resolve(reader.result as ArrayBuffer));
              reader.addEventListener('error', () => reject(reader.error));
              reader.readAsArrayBuffer(xhr.response);
            };
            xhr.onerror = () => reject(new Error(`XHR failed for ${url}`));
            xhr.open('GET', url);
            xhr.send();
          });

        // Settles with whichever of `onLoad` / `onError` the Image emits first.
        const loadImage = (uri: string): Promise<{ loaded: boolean; nativeEvent: any }> =>
          new Promise((resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error(`Image did not settle: ${uri}`)),
              5000
            );
            const settle = (loaded: boolean) => (event: any) => {
              clearTimeout(timeout);
              resolve({ loaded, nativeEvent: event.nativeEvent });
            };
            setPortalChild(
              React.createElement(Image, {
                source: { uri },
                style: { width: 10, height: 10 },
                onLoad: settle(true),
                onError: settle(false),
              })
            );
          });

        afterEach(async () => {
          await cleanupPortal();
        });

        it('loads an image from an Expo Blob', async () => {
          const url = URL.createObjectURL(new Blob([PNG_1X1], { type: 'image/png' }));
          try {
            const { loaded, nativeEvent } = await loadImage(url);
            expect(loaded).toBe(true);
            expect(nativeEvent.source.width).toBe(1);
            expect(nativeEvent.source.height).toBe(1);
          } finally {
            URL.revokeObjectURL(url);
          }
        });

        it('serves the Blob bytes to XMLHttpRequest', async () => {
          const blob = new Blob(['ab', new Uint8Array([0, 255, 128, 10, 13])]);
          const url = URL.createObjectURL(blob);
          try {
            const buffer = await readWithXhr(url);
            expect(Array.from(new Uint8Array(buffer))).toEqual(Array.from(await blob.bytes()));
          } finally {
            URL.revokeObjectURL(url);
          }
        });

        it('serves a File', async () => {
          const url = URL.createObjectURL(new File(['file contents'], 'a.txt'));
          try {
            const buffer = await readWithXhr(url);
            expect(new TextDecoder().decode(buffer)).toEqual('file contents');
          } finally {
            URL.revokeObjectURL(url);
          }
        });

        it('stops serving the bytes after revokeObjectURL', async () => {
          // The URL is revoked before its first load, so no image cache can hide the result.
          const url = URL.createObjectURL(new Blob([PNG_1X1], { type: 'image/png' }));
          // A malformed URL would also fail to load, so check that this one is a real blob URL.
          expect(url).toMatch(/^(blob:|content:)/);
          URL.revokeObjectURL(url);

          const { loaded } = await loadImage(url);
          expect(loaded).toBe(false);

          let xhrError: any = null;
          try {
            await readWithXhr(url);
          } catch (e) {
            xhrError = e;
          }
          expect(xhrError).not.toBeNull();
        });

        it('snapshots a file-backed Blob when the URL is created', async () => {
          // The bytes are copied into the store at creation, so a later file change does not show
          const file = new FileSystemFile(Paths.cache, `blob-url-snapshot-${Date.now()}.txt`);
          file.writeSync('before');
          const url = URL.createObjectURL(new Blob([file]));
          try {
            file.writeSync('after!');
            expect(new TextDecoder().decode(await readWithXhr(url))).toEqual('before');
          } finally {
            URL.revokeObjectURL(url);
          }
          // A file that is gone by then fails the creation itself
          const blob = new Blob([file]);
          file.delete();
          expect(() => URL.createObjectURL(blob)).toThrowError(/file-backed Blob part/);
        });

        it('returns the URL form that the platform serves', () => {
          // On Android, the expo package's own provider serves it, with no BlobProvider in the app manifest
          const url = URL.createObjectURL(new Blob(['hello']));
          try {
            if (Platform.OS === 'android') {
              expect(url).toMatch(/^content:\/\/[^/]+\.ExpoBlobProvider\/[^/?]+\?offset=0&size=5$/);
            } else {
              expect(url).toMatch(/^blob:[^/?]+\?offset=0&size=5$/);
            }
          } finally {
            URL.revokeObjectURL(url);
          }
        });

        // The global `fetch` (which is `expo/fetch` in Expo apps) loads `blob:` URLs through its
        // URLSession on iOS and `content://` URIs through the ContentResolver on Android. A URL that
        // cannot be served rejects, as on the web.

        // A URL with the given range in place of the one `URL.createObjectURL` returned
        const withRange = (url: string, offset: string, size: string) =>
          url.replace(/\?.*$/, `?offset=${offset}&size=${size}`);
        // Adding these two overflows a 64-bit integer, which must reject the load, not crash the app
        const OVERFLOW_OFFSET = '9223372036854775000';
        const OVERFLOW_SIZE = '1000';

        it('serves the Blob bytes to fetch', async () => {
          const blob = new Blob(['ab', new Uint8Array([0, 255, 128, 10, 13])]);
          const url = URL.createObjectURL(blob);
          try {
            const response = await expoFetch(url);
            expect(response.ok).toBe(true);
            expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(
              Array.from(await blob.bytes())
            );
          } finally {
            URL.revokeObjectURL(url);
          }
        });

        it('rejects fetch after revokeObjectURL', async () => {
          const url = URL.createObjectURL(new Blob(['gone']));
          URL.revokeObjectURL(url);

          let error: any = null;
          try {
            await expoFetch(url);
          } catch (e) {
            error = e;
          }
          expect(error).not.toBeNull();
        });

        it('rejects fetch of a range whose end overflows', async () => {
          const url = URL.createObjectURL(new Blob(['range']));
          try {
            let error: any = null;
            try {
              await expoFetch(withRange(url, OVERFLOW_OFFSET, OVERFLOW_SIZE));
            } catch (e) {
              error = e;
            }
            expect(error).not.toBeNull();
            // The app and the store survived: the URL itself still loads
            const response = await expoFetch(url);
            expect(await response.text()).toEqual('range');
          } finally {
            URL.revokeObjectURL(url);
          }
        });

        it('rejects fetch of a content:// URI that its provider refuses', async () => {
          if (Platform.OS !== 'android') {
            pending('content:// URIs exist only on Android');
          }
          // expo-file-system's FileProvider throws IllegalArgumentException for a path under no
          // configured root. It must reject the fetch, not kill the app on OkHttp's thread.
          const url = URL.createObjectURL(new Blob(['alive']));
          try {
            const applicationId = url.match(/^content:\/\/(.+)\.ExpoBlobProvider\//)![1];
            let error: any = null;
            try {
              await expoFetch(`content://${applicationId}.FileSystemFileProvider/nope`);
            } catch (e) {
              error = e;
            }
            expect(error).not.toBeNull();
            // The app survived: another content:// URI still loads
            const response = await expoFetch(url);
            expect(await response.text()).toEqual('alive');
          } finally {
            URL.revokeObjectURL(url);
          }
        });

        // Native code outside React Native's networking, such as another library or another app.
        // The tester module exists only in bare-expo.
        const BlobUrlTester = requireOptionalNativeModule<{
          readWithSharedURLSession?(url: string): Promise<Uint8Array>;
          readWithContentResolver?(uri: string): Promise<Uint8Array>;
        }>('BlobUrlTester');
        const noTester = 'the BlobUrlTester module exists only in bare-expo';
        const readNatively = (url: string): Promise<Uint8Array> =>
          Platform.OS === 'android'
            ? BlobUrlTester!.readWithContentResolver!(url)
            : BlobUrlTester!.readWithSharedURLSession!(url);
        const nativeReader = Platform.OS === 'android' ? 'ContentResolver' : 'URLSession.shared';

        it(`serves the Blob bytes to ${nativeReader}`, async () => {
          if (!BlobUrlTester) {
            pending(noTester);
          }
          const bytes = new Uint8Array(200_000).map((_, i) => (i * 13) % 256);
          const blob = new Blob(['x', bytes]);
          const url = URL.createObjectURL(blob);
          try {
            const read = await readNatively(url);
            expect(read.length).toBe(blob.size);
            expect(Array.from(read)).toEqual(Array.from(await blob.bytes()));
          } finally {
            URL.revokeObjectURL(url);
          }
        });

        it(`stops serving the bytes to ${nativeReader} after revokeObjectURL`, async () => {
          if (!BlobUrlTester) {
            pending(noTester);
          }
          const url = URL.createObjectURL(new Blob(['gone']));
          // Guard: the URL works before it is revoked, so the failure below comes from revoking
          expect(new TextDecoder().decode(await readNatively(url))).toEqual('gone');
          URL.revokeObjectURL(url);

          let error: any = null;
          try {
            await readNatively(url);
          } catch (e) {
            error = e;
          }
          expect(error).not.toBeNull();
        });

        it(`rejects a range whose end overflows in ${nativeReader}`, async () => {
          if (!BlobUrlTester) {
            pending(noTester);
          }
          const url = URL.createObjectURL(new Blob(['range']));
          try {
            let error: any = null;
            try {
              await readNatively(withRange(url, OVERFLOW_OFFSET, OVERFLOW_SIZE));
            } catch (e) {
              error = e;
            }
            expect(error).not.toBeNull();
            // The app and the store survived: the URL itself still loads
            expect(new TextDecoder().decode(await readNatively(url))).toEqual('range');
          } finally {
            URL.revokeObjectURL(url);
          }
        });
      });

      describe('React Native Blob as a constructor part', () => {
        // React Native's XHR returns its own Blob, whose bytes live in React Native's blob store.
        // The constructor copies them out, so the new Blob must not depend on that Blob afterwards.
        // The source bytes come from a `blob:` URL of an Expo Blob, which keeps the tests offline.
        const fetchReactNativeBlob = (url: string): Promise<any> =>
          new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.responseType = 'blob';
            xhr.onload = () => resolve(xhr.response);
            xhr.onerror = () => reject(new Error(`XHR failed for ${url}`));
            xhr.open('GET', url);
            xhr.send();
          });

        const SOURCE_BYTES = [104, 101, 108, 108, 111, 0, 255, 128];

        // Calls `test` with a React Native Blob holding SOURCE_BYTES and cleans up both stores after.
        const withReactNativeBlob = async (test: (rnBlob: any) => Promise<void>) => {
          const url = URL.createObjectURL(new Blob([new Uint8Array(SOURCE_BYTES)]));
          let rnBlob: any = null;
          try {
            rnBlob = await fetchReactNativeBlob(url);
            await test(rnBlob);
          } finally {
            URL.revokeObjectURL(url);
            // Releases the XHR's own store entry; a second close() would throw
            if (rnBlob?._data) {
              rnBlob.close();
            }
          }
        };

        it('copies the bytes of a React Native Blob', async () => {
          await withReactNativeBlob(async (rnBlob) => {
            // Guard: the part must really be React Native's Blob, not an Expo Blob
            expect(typeof rnBlob.data.blobId).toBe('string');
            expect(typeof rnBlob.arrayBuffer).not.toBe('function');

            const blob = new Blob([rnBlob]);

            expect(blob.size).toBe(SOURCE_BYTES.length);
            expect(Array.from(await blob.bytes())).toEqual(SOURCE_BYTES);
          });
        });

        it('mixes a React Native Blob slice with other parts', async () => {
          await withReactNativeBlob(async (rnBlob) => {
            // A slice shares the blobId and differs in offset and size
            const blob = new Blob(['x', rnBlob.slice(1, 3), new Uint8Array([1])]);

            expect(Array.from(await blob.bytes())).toEqual([120, 101, 108, 1]);
          });
        });

        it('keeps its bytes after the React Native Blob is closed', async () => {
          await withReactNativeBlob(async (rnBlob) => {
            const blob = new Blob([rnBlob]);

            rnBlob.close();

            expect(Array.from(await blob.bytes())).toEqual(SOURCE_BYTES);
            expect(Array.from(await blob.slice(5).bytes())).toEqual([0, 255, 128]);
          });
        });

        it('throws a TypeError for a closed React Native Blob', async () => {
          await withReactNativeBlob(async (rnBlob) => {
            rnBlob.close();

            let error: any = null;
            try {
              new Blob([rnBlob]);
            } catch (e) {
              error = e;
            }
            expect(error instanceof TypeError).toBe(true);
            expect(error.message).toMatch(/closed React Native Blob/);
          });
        });

        // Same shape as React Native's Blob (`react-native/Libraries/Blob/Blob.js`), but pointing at
        // any handle. The native side must report a bad handle as an error instead of crashing
        // (iOS `subdataWithRange:`) or padding with zeros (Android `copyOfRange`).
        const createReactNativeBlobHandle = (data: {
          blobId: string;
          offset: number;
          size: number;
        }) => ({
          _data: data as typeof data | null,
          get data() {
            if (!this._data) {
              throw new Error('Blob has been closed and is no longer available');
            }
            return this._data;
          },
          get size(): number {
            return this.data.size;
          },
          slice() {},
          close() {
            this._data = null;
          },
        });

        const constructionError = (part: any): any => {
          try {
            new Blob([part]);
          } catch (e) {
            return e;
          }
          return null;
        };

        it('throws for a React Native Blob missing from the store', () => {
          const handle = createReactNativeBlobHandle({
            blobId: 'no-such-blob',
            offset: 0,
            size: 1,
          });

          const error = constructionError(handle);

          expect(error instanceof Error).toBe(true);
          expect(error.message).toMatch(/no-such-blob.*React Native blob store/);
        });

        it('throws for a React Native Blob range past the end of its bytes', () => {
          const blobId = storeBlobInReactNativeBlobStore(new Blob([new Uint8Array([1, 2, 3, 4])]));
          try {
            const handle = createReactNativeBlobHandle({ blobId, offset: 2, size: 10 });

            const error = constructionError(handle);

            expect(error instanceof Error).toBe(true);
            expect(error.message).toMatch(/range of the React Native Blob.*outside of its bytes/);
          } finally {
            releaseBlobFromReactNativeBlobStore(blobId);
          }
        });
      });
    }
  });
}
