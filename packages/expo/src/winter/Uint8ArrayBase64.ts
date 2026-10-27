// Implementation of the TC39 "Uint8Array to/from base64" methods for engines that lack them
// (Hermes as of React Native 0.88).
// https://tc39.es/proposal-arraybuffer-base64/spec/
//
// Encoding to base64 goes through the engine's native `btoa`, which is several times faster
// than a JavaScript lookup-table loop. Decoding does not use `atob`: it accepts input that the
// spec rejects (missing padding, non-zero extra bits) and cannot report how much input it read,
// so decoding runs a table-driven loop over the bytes returned by the native `TextEncoder`.
//
// `fromBase64`, `fromHex` and `toHex` first try a native module that handles well-formed input
// with the default options several times faster. It returns null for anything else, and the
// JavaScript implementation then produces the spec's result or error.

import { requireOptionalNativeModule } from 'expo-modules-core';

type Alphabet = 'base64' | 'base64url';
type LastChunkHandling = 'loose' | 'strict' | 'stop-before-partial';

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const HEX_DIGITS = '0123456789abcdef';

// Lookup tables indexed by a character code (0-255). -1 marks a character outside the alphabet.
const base64Values = createDecodeTable(BASE64_ALPHABET);
const base64UrlValues = createDecodeTable(BASE64URL_ALPHABET);
const hexValues = createDecodeTable(HEX_DIGITS + 'ABCDEF', (index) =>
  index < 16 ? index : index - 6
);
// The two ASCII hex digits of every byte value, read as one 16-bit unit so `toHex` does a single
// table read and write per byte. The table is filled through a byte view and read through a
// 16-bit view of the same memory, so the digit order does not depend on the platform byte order.
const hexDigitCodes = new Uint8Array(512);
for (let i = 0; i < 256; i++) {
  hexDigitCodes[i * 2] = HEX_DIGITS.charCodeAt(i >> 4);
  hexDigitCodes[i * 2 + 1] = HEX_DIGITS.charCodeAt(i & 15);
}
const hexDigitPairs = new Uint16Array(hexDigitCodes.buffer);

const CHAR_EQUALS = 0x3d;
// `String.fromCharCode.apply` takes the bytes as call arguments, so keep the chunk well under
// engine argument limits.
const STRING_CHUNK_SIZE = 8192;

const typedArrayToStringTag = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  Symbol.toStringTag
)!.get!;

type NativeCodec = {
  decodeBase64(string: string, url: boolean): Uint8Array | null;
  decodeHex(string: string): Uint8Array | null;
  encodeHex(bytes: Uint8Array): string;
};

// Resolved on first use, because the winter runtime installs these methods at startup.
let nativeCodec: NativeCodec | null | undefined;

function getNativeCodec(): NativeCodec | null {
  if (nativeCodec === undefined) {
    nativeCodec = requireOptionalNativeModule<NativeCodec>('ExpoUint8ArrayBase64');
  }
  return nativeCodec;
}

// Runs the native fast path. Returns null when the module is missing, throws, or returns a value
// of the wrong type (it returns null for input it does not handle), so the caller runs the
// JavaScript implementation.
function tryNative<T>(
  call: (codec: NativeCodec) => unknown,
  isValid: (value: unknown) => value is T
): T | null {
  const codec = getNativeCodec();
  if (!codec) {
    return null;
  }
  try {
    const result = call(codec);
    return isValid(result) ? result : null;
  } catch {
    return null;
  }
}

const isUint8Array = (value: unknown): value is Uint8Array => value instanceof Uint8Array;
const isString = (value: unknown): value is string => typeof value === 'string';

let textEncoder: TextEncoder | undefined;
let textDecoder: TextDecoder | undefined;

function createDecodeTable(
  alphabet: string,
  valueForIndex: (index: number) => number = (index) => index
): Int8Array {
  const table = new Int8Array(256).fill(-1);
  for (let i = 0; i < alphabet.length; i++) {
    table[alphabet.charCodeAt(i)] = valueForIndex(i);
  }
  return table;
}

function isAsciiWhitespace(code: number): boolean {
  // TAB, LF, FF, CR and SPACE, as in the spec's SkipAsciiWhitespace.
  return code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d || code === 0x20;
}

function validateUint8Array(value: unknown): Uint8Array {
  // The `Symbol.toStringTag` getter of %TypedArray%.prototype reads the internal
  // [[TypedArrayName]] slot, so it cannot be spoofed by a plain object.
  if (typedArrayToStringTag.call(value) !== 'Uint8Array') {
    throw new TypeError('The receiver must be a Uint8Array');
  }
  return value as Uint8Array;
}

function validateNotDetached(bytes: Uint8Array): void {
  // The spec checks this after reading the options, whose getters could detach the buffer.
  // Engines without the `detached` getter (Hermes) also cannot detach a buffer from JavaScript.
  if ((bytes.buffer as { detached?: boolean }).detached === true) {
    throw new TypeError('The Uint8Array buffer is detached');
  }
}

function getOptionsObject(options: unknown): Record<string, unknown> {
  if (options === undefined) {
    return Object.create(null);
  }
  if ((typeof options === 'object' && options !== null) || typeof options === 'function') {
    return options as Record<string, unknown>;
  }
  throw new TypeError('The options argument must be an object');
}

function getAlphabet(options: Record<string, unknown>): Alphabet {
  const alphabet = options.alphabet;
  if (alphabet === undefined) {
    return 'base64';
  }
  if (alphabet !== 'base64' && alphabet !== 'base64url') {
    throw new TypeError('The alphabet option must be "base64" or "base64url"');
  }
  return alphabet;
}

function getLastChunkHandling(options: Record<string, unknown>): LastChunkHandling {
  const lastChunkHandling = options.lastChunkHandling;
  if (lastChunkHandling === undefined) {
    return 'loose';
  }
  if (
    lastChunkHandling !== 'loose' &&
    lastChunkHandling !== 'strict' &&
    lastChunkHandling !== 'stop-before-partial'
  ) {
    throw new TypeError(
      'The lastChunkHandling option must be "loose", "strict" or "stop-before-partial"'
    );
  }
  return lastChunkHandling;
}

function validateHexLength(string: string): void {
  if (string.length % 2 !== 0) {
    throw new SyntaxError('Hex string must have an even length');
  }
}

function requireString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError('The input must be a string');
  }
  return value;
}

function bytesToBinaryString(bytes: Uint8Array): string {
  if (bytes.length <= STRING_CHUNK_SIZE) {
    return String.fromCharCode.apply(null, bytes as unknown as number[]);
  }
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += STRING_CHUNK_SIZE) {
    parts.push(
      String.fromCharCode.apply(
        null,
        bytes.subarray(i, i + STRING_CHUNK_SIZE) as unknown as number[]
      )
    );
  }
  return parts.join('');
}

function asciiBytesToString(bytes: Uint8Array): string {
  if (typeof TextDecoder === 'function') {
    textDecoder ??= new TextDecoder();
    return textDecoder.decode(bytes);
  }
  return bytesToBinaryString(bytes);
}

/**
 * Returns the UTF-8 bytes of the string. For ASCII input, byte `i` is the code unit at index `i`.
 * A non-ASCII character becomes bytes of 0x80 or more, which no decode table accepts, so decoding
 * fails at that character with all indices before it still matching the string.
 */
function stringToBytes(string: string): Uint8Array {
  textEncoder ??= new TextEncoder();
  return textEncoder.encode(string);
}

type DecodeResult = {
  read: number;
  written: number;
  error: SyntaxError | null;
};

/**
 * The spec's FromBase64 operation. Writes the decoded bytes into `into` (whose length is the
 * spec's `maxLength`) and returns how many characters it read and bytes it wrote.
 */
function decodeBase64Into(
  string: string,
  alphabet: Alphabet,
  lastChunkHandling: LastChunkHandling,
  into: Uint8Array
): DecodeResult {
  const maxLength = into.length;
  if (maxLength === 0) {
    return { read: 0, written: 0, error: null };
  }
  const input = stringToBytes(string);
  const length = string.length;
  const values = alphabet === 'base64' ? base64Values : base64UrlValues;

  let index = 0;
  let read = 0;
  let written = 0;
  // Sextets of the current (incomplete) chunk, packed into the high bits of a 24-bit value.
  let chunk = 0;
  let chunkLength = 0;

  const fail = (): DecodeResult => ({
    read,
    written,
    error: new SyntaxError('Invalid base64 string'),
  });

  // Writes the bytes of a chunk with 2 or 3 characters. Returns false for non-zero extra bits.
  const writePartialChunk = (throwOnExtraBits: boolean): boolean => {
    if (chunkLength === 2) {
      if (throwOnExtraBits && (chunk & 0xffff) !== 0) {
        return false;
      }
      into[written++] = chunk >> 16;
    } else {
      if (throwOnExtraBits && (chunk & 0xff) !== 0) {
        return false;
      }
      into[written++] = chunk >> 16;
      into[written++] = (chunk >> 8) & 0xff;
    }
    return true;
  };

  while (true) {
    // Fast path: whole chunks of four alphabet characters with no whitespace or padding.
    // Anything else falls through to the character-by-character steps of the spec below.
    if (chunkLength === 0) {
      while (index + 3 < length && maxLength - written >= 3) {
        const a = values[input[index]!]!;
        const b = values[input[index + 1]!]!;
        const c = values[input[index + 2]!]!;
        const d = values[input[index + 3]!]!;
        if ((a | b | c | d) < 0) {
          break;
        }
        const triple = (a << 18) | (b << 12) | (c << 6) | d;
        into[written++] = triple >> 16;
        into[written++] = (triple >> 8) & 0xff;
        into[written++] = triple & 0xff;
        index += 4;
        read = index;
      }
      if (written === maxLength) {
        return { read, written, error: null };
      }
    }

    while (index < length && isAsciiWhitespace(input[index]!)) {
      index++;
    }
    if (index === length) {
      if (chunkLength > 0) {
        if (lastChunkHandling === 'stop-before-partial') {
          return { read, written, error: null };
        }
        if (lastChunkHandling === 'strict' || chunkLength === 1) {
          return fail();
        }
        writePartialChunk(false);
      }
      return { read: length, written, error: null };
    }

    const code = input[index++]!;
    if (code === CHAR_EQUALS) {
      if (chunkLength < 2) {
        return fail();
      }
      while (index < length && isAsciiWhitespace(input[index]!)) {
        index++;
      }
      if (chunkLength === 2) {
        if (index === length) {
          if (lastChunkHandling === 'stop-before-partial') {
            return { read, written, error: null };
          }
          return fail();
        }
        if (input[index] === CHAR_EQUALS) {
          index++;
          while (index < length && isAsciiWhitespace(input[index]!)) {
            index++;
          }
        } else {
          // The spec re-reads the character after a single "=" as the next character,
          // which fails the check below for anything but a second "=".
          return fail();
        }
      }
      if (index < length) {
        return fail();
      }
      if (!writePartialChunk(lastChunkHandling === 'strict')) {
        return fail();
      }
      return { read: length, written, error: null };
    }

    const value = values[code]!;
    if (value < 0) {
      return fail();
    }
    const remaining = maxLength - written;
    if ((remaining === 1 && chunkLength === 2) || (remaining === 2 && chunkLength === 3)) {
      return { read, written, error: null };
    }
    chunk |= value << (18 - 6 * chunkLength);
    chunkLength++;
    if (chunkLength === 4) {
      into[written++] = chunk >> 16;
      into[written++] = (chunk >> 8) & 0xff;
      into[written++] = chunk & 0xff;
      chunk = 0;
      chunkLength = 0;
      read = index;
      if (written === maxLength) {
        return { read, written, error: null };
      }
    }
  }
}

/**
 * The spec's FromHex operation, for a string that passed `validateHexLength`. Writes the decoded
 * bytes into `into` (whose length is the spec's `maxLength`) and returns how many characters it
 * read and bytes it wrote.
 */
function decodeHexInto(string: string, into: Uint8Array): DecodeResult {
  const length = string.length;
  const input = stringToBytes(string);
  const maxLength = into.length;
  let read = 0;
  let written = 0;
  while (read < length && written < maxLength) {
    const high = hexValues[input[read]!]!;
    const low = hexValues[input[read + 1]!]!;
    if ((high | low) < 0) {
      return { read, written, error: new SyntaxError('Invalid hex string') };
    }
    into[written++] = (high << 4) | low;
    read += 2;
  }
  return { read, written, error: null };
}

/**
 * Returns the base64 encoding of the array's bytes.
 * Implements `Uint8Array.prototype.toBase64`.
 */
export function toBase64(this: unknown, ...args: unknown[]): string {
  const bytes = validateUint8Array(this);
  const options = getOptionsObject(args[0]);
  const alphabet = getAlphabet(options);
  const omitPadding = Boolean(options.omitPadding);
  validateNotDetached(bytes);

  let result = btoa(bytesToBinaryString(bytes));
  if (omitPadding) {
    let end = result.length;
    while (end > 0 && result.charCodeAt(end - 1) === CHAR_EQUALS) {
      end--;
    }
    result = result.slice(0, end);
  }
  if (alphabet === 'base64url') {
    // `split` and `join` measured several times faster than a global `replace` on Hermes.
    result = result.split('+').join('-').split('/').join('_');
  }
  return result;
}

/**
 * Returns the lowercase hex encoding of the array's bytes.
 * Implements `Uint8Array.prototype.toHex`.
 */
export function toHex(this: unknown): string {
  const bytes = validateUint8Array(this);
  validateNotDetached(bytes);
  const native = tryNative((codec) => codec.encodeHex(bytes), isString);
  if (native !== null) {
    return native;
  }
  const out = new Uint8Array(bytes.length * 2);
  const outPairs = new Uint16Array(out.buffer);
  for (let i = 0; i < bytes.length; i++) {
    outPairs[i] = hexDigitPairs[bytes[i]!]!;
  }
  return asciiBytesToString(out);
}

/**
 * Decodes a base64 string into a new `Uint8Array`.
 * Implements `Uint8Array.fromBase64`.
 */
export function fromBase64(string: unknown, ...args: unknown[]): Uint8Array {
  const input = requireString(string);
  const options = getOptionsObject(args[0]);
  const alphabet = getAlphabet(options);
  const lastChunkHandling = getLastChunkHandling(options);

  if (lastChunkHandling === 'loose') {
    const url = alphabet === 'base64url';
    const native = tryNative((codec) => codec.decodeBase64(input, url), isUint8Array);
    if (native !== null) {
      return native;
    }
  }

  // Every 4 characters decode to at most 3 bytes, and a final chunk of 2 or 3 to at most 2.
  const into = new Uint8Array(Math.ceil(input.length / 4) * 3);
  const result = decodeBase64Into(input, alphabet, lastChunkHandling, into);
  if (result.error) {
    throw result.error;
  }
  return result.written === into.length ? into : into.slice(0, result.written);
}

/**
 * Decodes a base64 string into this array, starting at index 0. Stops at a chunk boundary when
 * the array is full. Bytes decoded before an error stay written.
 * Implements `Uint8Array.prototype.setFromBase64`.
 */
export function setFromBase64(
  this: unknown,
  string: unknown,
  ...args: unknown[]
): { read: number; written: number } {
  const into = validateUint8Array(this);
  const input = requireString(string);
  const options = getOptionsObject(args[0]);
  const alphabet = getAlphabet(options);
  const lastChunkHandling = getLastChunkHandling(options);
  validateNotDetached(into);

  const { read, written, error } = decodeBase64Into(input, alphabet, lastChunkHandling, into);
  if (error) {
    throw error;
  }
  return { read, written };
}

/**
 * Decodes a hex string into a new `Uint8Array`.
 * Implements `Uint8Array.fromHex`.
 */
export function fromHex(string: unknown): Uint8Array {
  const input = requireString(string);
  validateHexLength(input);
  const native = tryNative((codec) => codec.decodeHex(input), isUint8Array);
  if (native !== null) {
    return native;
  }
  const into = new Uint8Array(input.length >> 1);
  const result = decodeHexInto(input, into);
  if (result.error) {
    throw result.error;
  }
  return into;
}

/**
 * Decodes a hex string into this array, starting at index 0. Bytes decoded before an error stay
 * written.
 * Implements `Uint8Array.prototype.setFromHex`.
 */
export function setFromHex(this: unknown, string: unknown): { read: number; written: number } {
  const into = validateUint8Array(this);
  const input = requireString(string);
  validateNotDetached(into);
  validateHexLength(input);
  const { read, written, error } = decodeHexInto(input, into);
  if (error) {
    throw error;
  }
  return { read, written };
}

// The name is passed as a string because minification renames functions. A method the engine
// already has is kept, so an engine that ships only some of them keeps its own.
function defineMethod(target: object, name: string, method: Function): void {
  if (typeof (target as Record<string, unknown>)[name] === 'function') {
    return;
  }
  Object.defineProperty(method, 'name', { value: name, configurable: true });
  Object.defineProperty(target, name, {
    value: method,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

/**
 * Installs `Uint8Array.fromBase64`, `Uint8Array.fromHex` and the `toBase64`, `toHex`,
 * `setFromBase64` and `setFromHex` prototype methods with the same property attributes as
 * built-in methods. Methods the engine already has are left in place.
 */
export function installUint8ArrayBase64(): void {
  defineMethod(Uint8Array, 'fromBase64', fromBase64);
  defineMethod(Uint8Array, 'fromHex', fromHex);
  defineMethod(Uint8Array.prototype, 'toBase64', toBase64);
  defineMethod(Uint8Array.prototype, 'toHex', toHex);
  defineMethod(Uint8Array.prototype, 'setFromBase64', setFromBase64);
  defineMethod(Uint8Array.prototype, 'setFromHex', setFromHex);
}
