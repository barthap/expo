// Conformance tests for the TC39 "Uint8Array to/from base64" methods.
// https://tc39.es/proposal-arraybuffer-base64/spec/
// Hermes does not ship these yet, so on Android and iOS they come from the `expo` winter runtime.
// Web runs the same tests against the browser's built-in implementation.

import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

import type { JasmineInterface } from '../types';

export const name = 'Uint8ArrayBase64';

type DecodeResult = { read: number; written: number };

// Loosely typed views of the API, so tests can pass the invalid arguments the spec rejects.
const fromBase64 = (string: unknown, options?: unknown): Uint8Array =>
  (Uint8Array as any).fromBase64(string, options);
const fromHex = (string: unknown): Uint8Array => (Uint8Array as any).fromHex(string);
const toBase64 = (array: unknown, options?: unknown): string =>
  (Uint8Array.prototype as any).toBase64.call(array, options);
const toHex = (array: unknown): string => (Uint8Array.prototype as any).toHex.call(array);
const setFromBase64 = (array: Uint8Array, string: unknown, options?: unknown): DecodeResult =>
  (array as any).setFromBase64(string, options);
const setFromHex = (array: Uint8Array, string: unknown): DecodeResult =>
  (array as any).setFromHex(string);

const text = (value: string) => Array.from(new TextEncoder().encode(value));

export function test({ describe, it, expect }: JasmineInterface) {
  const expectBytes = (actual: Uint8Array, expected: number[]) => {
    expect(actual instanceof Uint8Array).toBe(true);
    expect(Array.from(actual)).toEqual(expected);
  };

  describe('Uint8Array base64 and hex', () => {
    it('provides the static and prototype methods with the built-in names and attributes', () => {
      for (const [target, key] of [
        [Uint8Array, 'fromBase64'],
        [Uint8Array, 'fromHex'],
        [Uint8Array.prototype, 'toBase64'],
        [Uint8Array.prototype, 'toHex'],
        [Uint8Array.prototype, 'setFromBase64'],
        [Uint8Array.prototype, 'setFromHex'],
      ] as const) {
        const descriptor = Object.getOwnPropertyDescriptor(target, key);
        expect(typeof descriptor?.value).toBe('function');
        expect(descriptor?.value.name).toBe(key);
        expect(descriptor?.writable).toBe(true);
        expect(descriptor?.enumerable).toBe(false);
        expect(descriptor?.configurable).toBe(true);
      }
    });

    describe('toBase64', () => {
      it('encodes with padding by default (RFC 4648 section 4)', () => {
        expect(toBase64(new Uint8Array(0))).toBe('');
        expect(toBase64(new Uint8Array(text('f')))).toBe('Zg==');
        expect(toBase64(new Uint8Array(text('fo')))).toBe('Zm8=');
        expect(toBase64(new Uint8Array(text('foo')))).toBe('Zm9v');
        expect(toBase64(new Uint8Array(text('foobar')))).toBe('Zm9vYmFy');
      });

      it('uses "-" and "_" for the base64url alphabet (RFC 4648 section 5)', () => {
        const bytes = new Uint8Array([0xfb, 0xff, 0xbf]);
        expect(toBase64(bytes)).toBe('+/+/');
        expect(toBase64(bytes, { alphabet: 'base64url' })).toBe('-_-_');
      });

      it('drops padding only when omitPadding is truthy', () => {
        expect(toBase64(new Uint8Array(text('f')), { omitPadding: true })).toBe('Zg');
        expect(toBase64(new Uint8Array(text('fo')), { omitPadding: 1 })).toBe('Zm8');
        expect(toBase64(new Uint8Array(text('fo')), { omitPadding: false })).toBe('Zm8=');
        expect(
          toBase64(new Uint8Array([0xff, 0xfe]), { alphabet: 'base64url', omitPadding: true })
        ).toBe('__4');
      });

      it('encodes only the bytes in view of a subarray (GetUint8ArrayBytes)', () => {
        expect(toBase64(new Uint8Array(text('xfoox')).subarray(1, 4))).toBe('Zm9v');
      });

      it('throws TypeError when the receiver is not a Uint8Array (ValidateUint8Array)', () => {
        expect(() => toBase64(new Uint8ClampedArray(1))).toThrowError(TypeError);
        expect(() => toBase64([1, 2])).toThrowError(TypeError);
      });

      it('throws TypeError for a non-object options value or an unknown alphabet', () => {
        expect(() => toBase64(new Uint8Array(1), null)).toThrowError(TypeError);
        expect(() => toBase64(new Uint8Array(1), 'base64url')).toThrowError(TypeError);
        expect(() => toBase64(new Uint8Array(1), { alphabet: 'Base64' })).toThrowError(TypeError);
      });
    });

    describe('fromBase64', () => {
      it('decodes padded and unpadded input in the default loose mode', () => {
        expectBytes(fromBase64('Zm9vYmFy'), text('foobar'));
        expectBytes(fromBase64('Zm8='), text('fo'));
        expectBytes(fromBase64('Zm8'), text('fo'));
        expectBytes(fromBase64('Zg'), text('f'));
        expectBytes(fromBase64('aGk'), text('hi'));
        expectBytes(fromBase64(''), []);
        // The result owns an ArrayBuffer of exactly its size, not a view into a larger one.
        for (const input of ['Zm9vYmFy', 'Zm8=', 'Zm8', 'Zg', '']) {
          const result = fromBase64(input);
          expect(result.byteOffset).toBe(0);
          expect(result.buffer.byteLength).toBe(result.length);
        }
      });

      it('skips TAB, LF, FF, CR and SPACE anywhere (SkipAsciiWhitespace)', () => {
        expectBytes(fromBase64(' Zm\t9v\nYm\fFy\r '), text('foobar'));
        expectBytes(fromBase64('Zg= ='), text('f'));
      });

      it('throws SyntaxError for whitespace outside the ASCII set (VT, NBSP)', () => {
        expect(() => fromBase64('Zm9v\u000b')).toThrowError(SyntaxError);
        expect(() => fromBase64('Zm9v ')).toThrowError(SyntaxError);
      });

      it('accepts only the characters of the selected alphabet', () => {
        expectBytes(fromBase64('-_8', { alphabet: 'base64url' }), [0xfb, 0xff]);
        expectBytes(fromBase64('-_-_', { alphabet: 'base64url' }), [0xfb, 0xff, 0xbf]);
        expect(() => fromBase64('-_-_')).toThrowError(SyntaxError);
        expect(() => fromBase64('+/+/', { alphabet: 'base64url' })).toThrowError(SyntaxError);
      });

      it('throws SyntaxError for characters outside the alphabet, including non-ASCII', () => {
        expect(() => fromBase64('Zm9v*')).toThrowError(SyntaxError);
        expect(() => fromBase64('Zm9vé')).toThrowError(SyntaxError);
        expect(() => fromBase64('Zm9v\ud800')).toThrowError(SyntaxError);
      });

      it('throws SyntaxError for padding after fewer than two characters or in the middle', () => {
        expect(() => fromBase64('=')).toThrowError(SyntaxError);
        expect(() => fromBase64('Z=')).toThrowError(SyntaxError);
        expect(() => fromBase64('Zg=')).toThrowError(SyntaxError);
        expect(() => fromBase64('Zg=a')).toThrowError(SyntaxError);
        expect(() => fromBase64('Zg===')).toThrowError(SyntaxError);
        expect(() => fromBase64('Zm8=Zm8=')).toThrowError(SyntaxError);
      });

      it('throws SyntaxError for a final chunk of one character unless stop-before-partial', () => {
        expect(() => fromBase64('Zm9vY')).toThrowError(SyntaxError);
        expect(() => fromBase64('Zm9vY', { lastChunkHandling: 'strict' })).toThrowError(
          SyntaxError
        );
        expectBytes(fromBase64('Zm9vY', { lastChunkHandling: 'stop-before-partial' }), text('foo'));
      });

      it('ignores non-zero extra bits in loose mode (DecodeBase64Chunk)', () => {
        expectBytes(fromBase64('Zh=='), text('f'));
        expectBytes(fromBase64('Zm9='), text('fo'));
      });

      it('throws SyntaxError for non-zero extra bits in strict mode (throwOnExtraBits)', () => {
        expect(() => fromBase64('Zh==', { lastChunkHandling: 'strict' })).toThrowError(SyntaxError);
        expect(() => fromBase64('Zm9=', { lastChunkHandling: 'strict' })).toThrowError(SyntaxError);
        expectBytes(fromBase64('Zg==', { lastChunkHandling: 'strict' }), text('f'));
      });

      it('throws SyntaxError for a final chunk without padding in strict mode', () => {
        expect(() => fromBase64('aGk', { lastChunkHandling: 'strict' })).toThrowError(SyntaxError);
        expectBytes(fromBase64('aGk=', { lastChunkHandling: 'strict' }), text('hi'));
      });

      it('drops an unpadded final chunk in stop-before-partial mode, but decodes a padded one', () => {
        const options = { lastChunkHandling: 'stop-before-partial' };
        expectBytes(fromBase64('Zm9vZm8', options), text('foo'));
        expectBytes(fromBase64('Zm9vZg=', options), text('foo'));
        expectBytes(fromBase64('Zm9vZm8=', options), text('foofo'));
      });

      it('throws TypeError for a non-string input before reading options', () => {
        const options = {
          get alphabet(): string {
            throw new Error('options must not be read');
          },
        };
        expect(() => fromBase64(123, options)).toThrowError(TypeError);
        expect(() => fromBase64(undefined)).toThrowError(TypeError);
        expect(() => fromBase64(new String('Zg=='))).toThrowError(TypeError);
      });

      it('throws TypeError for invalid option values (GetOptionsObject)', () => {
        expect(() => fromBase64('Zg==', null)).toThrowError(TypeError);
        expect(() => fromBase64('Zg==', { alphabet: 'hex' })).toThrowError(TypeError);
        expect(() => fromBase64('Zg==', { lastChunkHandling: 'Strict' })).toThrowError(TypeError);
      });

      it('round-trips every length mod 3 in both alphabets, with and without padding', () => {
        for (const length of [0, 1, 2, 3, 1000, 1001, 1002]) {
          const input = new Uint8Array(length).map((_, i) => (i * 7919) & 0xff);
          for (const alphabet of ['base64', 'base64url']) {
            for (const omitPadding of [false, true]) {
              const encoded = toBase64(input, { alphabet, omitPadding });
              expectBytes(fromBase64(encoded, { alphabet }), Array.from(input));
            }
          }
        }
      });
    });

    describe('setFromBase64', () => {
      it('returns { read, written } and writes from index 0', () => {
        const target = new Uint8Array(8);
        expect(setFromBase64(target, 'Zm9vYmFy')).toEqual({ read: 8, written: 6 });
        expectBytes(target, [...text('foobar'), 0, 0]);
        expect(setFromBase64(new Uint8Array(4), 'aGk=')).toEqual({ read: 4, written: 2 });
      });

      it('counts trailing whitespace as read when it decodes the whole string', () => {
        expect(setFromBase64(new Uint8Array(8), 'Zm9v  ')).toEqual({ read: 6, written: 3 });
      });

      it('stops before a chunk whose bytes do not fit into a short target', () => {
        const target = new Uint8Array(4);
        expect(setFromBase64(target, 'Zm9vYmFy')).toEqual({ read: 4, written: 3 });
        expectBytes(target, [...text('foo'), 0]);
        expect(setFromBase64(new Uint8Array(1), 'Zm9v')).toEqual({ read: 0, written: 0 });
        expect(setFromBase64(new Uint8Array(2), 'Zm9v')).toEqual({ read: 0, written: 0 });
        expect(setFromBase64(new Uint8Array(3), 'Zm9v Zm9v')).toEqual({ read: 4, written: 3 });
      });

      it('decodes a final partial chunk whose bytes fit, including its padding', () => {
        expect(setFromBase64(new Uint8Array(1), 'Zg')).toEqual({ read: 2, written: 1 });
        expect(setFromBase64(new Uint8Array(1), 'Zg==')).toEqual({ read: 4, written: 1 });
      });

      it('returns { read: 0, written: 0 } for an empty target without validating input', () => {
        expect(setFromBase64(new Uint8Array(0), '***')).toEqual({ read: 0, written: 0 });
      });

      it('reports the end of the last whole chunk in stop-before-partial mode', () => {
        const options = { lastChunkHandling: 'stop-before-partial' };
        expect(setFromBase64(new Uint8Array(8), 'Zm9v Zm', options)).toEqual({
          read: 4,
          written: 3,
        });
      });

      it('keeps the bytes decoded before a SyntaxError', () => {
        const target = new Uint8Array(6);
        expect(() => setFromBase64(target, 'Zm9vYmF*')).toThrowError(SyntaxError);
        expectBytes(target, [...text('foo'), 0, 0, 0]);
      });

      it('writes from the start of a subarray, not of its buffer', () => {
        const backing = new Uint8Array(5);
        expect(setFromBase64(backing.subarray(1, 4), 'Zm9v')).toEqual({ read: 4, written: 3 });
        expectBytes(backing, [0, ...text('foo'), 0]);
      });

      it('throws TypeError for a non-string input', () => {
        expect(() => setFromBase64(new Uint8Array(4), 42)).toThrowError(TypeError);
      });
    });

    describe('toHex', () => {
      it('encodes every byte as two lowercase hex digits', () => {
        const all = new Uint8Array(256).map((_, i) => i);
        let expected = '';
        for (let i = 0; i < 256; i++) {
          expected += i.toString(16).padStart(2, '0');
        }
        expect(toHex(all)).toBe(expected);
        expect(toHex(new Uint8Array(0))).toBe('');
      });

      it('throws TypeError when the receiver is not a Uint8Array', () => {
        expect(() => toHex(new Int8Array(1))).toThrowError(TypeError);
      });
    });

    describe('fromHex', () => {
      it('decodes upper and lower case digits', () => {
        expectBytes(fromHex('00ffAbcD'), [0x00, 0xff, 0xab, 0xcd]);
        expectBytes(fromHex(''), []);
      });

      it('throws SyntaxError for an odd length', () => {
        expect(() => fromHex('abc')).toThrowError(SyntaxError);
      });

      it('throws SyntaxError for non-hex characters, a 0x prefix and whitespace', () => {
        expect(() => fromHex('0x12')).toThrowError(SyntaxError);
        expect(() => fromHex('zz')).toThrowError(SyntaxError);
        expect(() => fromHex('ab ')).toThrowError(SyntaxError);
        expect(() => fromHex('éé')).toThrowError(SyntaxError);
      });

      it('throws TypeError for a non-string input', () => {
        expect(() => fromHex(12)).toThrowError(TypeError);
      });
    });

    describe('setFromHex', () => {
      it('stops when the target is full, without validating the rest', () => {
        const target = new Uint8Array(1);
        expect(setFromHex(target, 'abzz')).toEqual({ read: 2, written: 1 });
        expectBytes(target, [0xab]);
      });

      it('throws SyntaxError for an odd length even when nothing would be written', () => {
        expect(() => setFromHex(new Uint8Array(0), 'abc')).toThrowError(SyntaxError);
      });

      it('keeps the bytes decoded before a SyntaxError', () => {
        const target = new Uint8Array(3);
        expect(() => setFromHex(target, 'abcdzz')).toThrowError(SyntaxError);
        expectBytes(target, [0xab, 0xcd, 0]);
      });
    });

    describe('large inputs', () => {
      const size = 1024 * 1024;
      const input = new Uint8Array(size).map((_, i) => (i * 2654435761) >>> 24);
      const sameBytes = (a: Uint8Array, b: Uint8Array) => {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
          if (a[i] !== b[i]) return false;
        }
        return true;
      };

      it('round-trips 1 MiB through base64 and base64url', () => {
        for (const alphabet of ['base64', 'base64url']) {
          const start = performance.now();
          const encoded = toBase64(input, { alphabet });
          const encodedAt = performance.now();
          const decoded = fromBase64(encoded, { alphabet });
          const end = performance.now();
          console.log(
            `Uint8ArrayBase64: 1 MiB ${alphabet} encode ${Math.round(encodedAt - start)} ms, decode ${Math.round(end - encodedAt)} ms`
          );
          expect(encoded.length).toBe(Math.ceil(size / 3) * 4);
          expect(sameBytes(decoded, input)).toBe(true);
        }
      });

      it('round-trips 1 MiB through hex', () => {
        const start = performance.now();
        const encoded = toHex(input);
        const encodedAt = performance.now();
        const decoded = fromHex(encoded);
        const end = performance.now();
        console.log(
          `Uint8ArrayBase64: 1 MiB hex encode ${Math.round(encodedAt - start)} ms, decode ${Math.round(end - encodedAt)} ms`
        );
        expect(encoded.length).toBe(size * 2);
        expect(sameBytes(decoded, input)).toBe(true);
      });
    });

    if (Platform.OS !== 'web') {
      // `fromBase64`, `fromHex` and `toHex` first try this module and fall back to the JavaScript
      // implementation when it returns nothing. These tests call it directly, so a module that
      // stops loading, or that decodes differently from the spec, does not hide behind the
      // fallback.
      describe('native fast path', () => {
        type NativeCodec = {
          decodeBase64(string: string, url: boolean): Uint8Array | null | undefined;
          decodeHex(string: string): Uint8Array | null | undefined;
          encodeHex(bytes: Uint8Array): string;
        };
        const codec = requireOptionalNativeModule<NativeCodec>('ExpoUint8ArrayBase64');

        it('is installed', () => {
          expect(codec).not.toBeNull();
        });

        it('decodes well-formed base64 and base64url like fromBase64', () => {
          for (const [input, alphabet] of [
            ['', 'base64'],
            ['Zm9vYmFy', 'base64'],
            ['Zm8=', 'base64'],
            ['Zg==', 'base64'],
            ['Zm8', 'base64'],
            ['Zg', 'base64'],
            ['+/+/', 'base64'],
            ['', 'base64url'],
            ['-_-_', 'base64url'],
            ['A-8=', 'base64url'],
            ['_w==', 'base64url'],
            ['A-8', 'base64url'],
            ['_w', 'base64url'],
          ] as const) {
            const result = codec!.decodeBase64(input, alphabet === 'base64url');
            expect(result instanceof Uint8Array).toBe(true);
            expect(Array.from(result!)).toEqual(Array.from(fromBase64(input, { alphabet })));
            expect(result!.buffer.byteLength).toBe(result!.length);
          }
        });

        it('decodes hex like fromHex and encodes it like toHex', () => {
          for (const input of ['', '00ff', 'ABcd', '0123456789abcdef']) {
            const result = codec!.decodeHex(input);
            expect(result instanceof Uint8Array).toBe(true);
            expect(Array.from(result!)).toEqual(Array.from(fromHex(input)));
          }
          // A view with a non-zero byteOffset encodes only its own bytes.
          const view = new Uint8Array([0x00, 0x01, 0x02, 0xab, 0xff, 0x09]).subarray(2, 5);
          for (const [bytes, expected] of [
            [new Uint8Array(0), ''],
            [new Uint8Array([0x00, 0x0f, 0xf0, 0xff]), '000ff0ff'],
            [view, '02abff'],
          ] as const) {
            expect(codec!.encodeHex(bytes)).toBe(expected);
            expect(codec!.encodeHex(bytes)).toBe(toHex(bytes));
          }
        });

        it('returns nothing for input it leaves to the JavaScript implementation', () => {
          // Whitespace, non-zero extra bits, a lone character, padding before the end, and
          // characters outside the alphabet (non-ASCII).
          for (const input of [' Zg==', 'aGl=', 'A', 'AQ==AQ==', 'éé']) {
            expect(codec!.decodeBase64(input, false) == null).toBe(true);
            expect(codec!.decodeBase64(input, true) == null).toBe(true);
          }
          expect(codec!.decodeHex('zz') == null).toBe(true);
        });
      });
    }
  });
}
