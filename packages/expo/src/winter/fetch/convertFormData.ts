import { blobToArrayBufferAsync } from '../../utils/blobUtils';
import type { ExpoFormDataEntry } from '../FormData';

function encodeFilename(filename: string): string {
  return encodeURIComponent(filename.replace(/\//g, '_'));
}

type ExpoFormHeaders = {
  'content-disposition': string | undefined;
  'content-type': string | undefined;
};

function getFormDataPartHeaders(entry: ExpoFormDataEntry) {
  const [name, part, entryFilename] = entry;
  const contentDisposition = 'form-data; name="' + name + '"';

  const headers: ExpoFormHeaders = {
    'content-disposition': contentDisposition,
    'content-type': undefined,
  };

  if (typeof part === 'object') {
    // The filename resolved when the entry was appended wins. Other FormData implementations
    // don't carry one, so fall back to the value's own `name`, as React Native does.
    const filename =
      entryFilename ?? ('name' in part && typeof part.name === 'string' ? part.name : undefined);
    if (filename !== undefined) {
      headers['content-disposition'] += `; filename="${encodeFilename(filename)}"`;
    }
    if ('type' in part && typeof part.type === 'string') {
      headers['content-type'] = part.type;
    }
  }
  return headers;
}

/**
 * Convert FormData to Uint8Array with a boundary
 *
 * `uri` is not supported for React Native's FormData.
 * `blob` is not supported for standard FormData.
 */
export async function convertFormDataAsync(
  formData: FormData,
  boundary: string = createBoundary()
): Promise<{ body: Uint8Array; boundary: string }> {
  if (typeof formData.entries !== 'function') {
    // @ts-expect-error: React Native's FormData is not 100% compatible with ours
    if (typeof formData.getParts == 'function') {
      formData.entries = function () {
        // @ts-expect-error
        return formData.getParts().map((part) => {
          if (part.string) return part.string;
          if (part.file) return part.file;
          if (part.blob) return part.blob;
        });
      };
    } else {
      throw new Error('Unsupported FormData implementation');
    }
  }
  // Our patched FormData keeps the filename of each entry as a third element of React Native's
  // internal `_parts` tuples. `entries()` deliberately hides it, so read the tuples directly.
  const internalParts = (formData as { _parts?: ExpoFormDataEntry[] })._parts;
  const entries: Iterable<ExpoFormDataEntry> = Array.isArray(internalParts)
    ? internalParts
    : // React Native's FormData is not 100% compatible with ours.
      (formData.entries() as unknown as Iterable<ExpoFormDataEntry>);

  const results: (Uint8Array | string)[] = [];
  for (const entry of entries) {
    const value = entry[1];
    results.push(`--${boundary}\r\n`);
    for (const [headerKey, headerValue] of Object.entries(getFormDataPartHeaders(entry))) {
      if (headerValue) {
        results.push(`${headerKey}: ${headerValue}\r\n`);
      }
    }
    results.push(`\r\n`);
    if (typeof value === 'string') {
      results.push(value);
    } else if (value instanceof Blob) {
      results.push(new Uint8Array(await blobToArrayBufferAsync(value)));
    } else if (typeof value === 'object' && 'bytes' in value) {
      // @ts-expect-error: File or ExpoBlob don't extend Blob but implement the interface.
      results.push(await value.bytes());
    } else {
      throw new Error('Unsupported FormDataPart implementation');
    }
    results.push(`\r\n`);
  }

  results.push(`--${boundary}--\r\n`);
  const arrays = results.map((result) => {
    if (typeof result === 'string') {
      // @ts-ignore: TextEncoder is not available in all environments
      return new TextEncoder().encode(result);
    } else {
      return result;
    }
  }) as Uint8Array[];

  return { body: joinUint8Arrays(arrays), boundary };
}

/**
 * Create multipart boundary
 */
export function createBoundary(): string {
  const boundaryChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let boundary = '----ExpoFetchFormBoundary';
  for (let i = 0; i < 16; i++) {
    boundary += boundaryChars.charAt(Math.floor(Math.random() * boundaryChars.length));
  }
  return boundary;
}

/**
 * Merge Uint8Arrays into a single Uint8Array
 */
export function joinUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const totalLength: number = arrays.reduce((acc: number, arr: Uint8Array) => acc + arr.length, 0);
  const result: Uint8Array = new Uint8Array(totalLength);

  let offset: number = 0;
  arrays.forEach((array: Uint8Array) => {
    result.set(array, offset);
    offset += array.length;
  });

  return result;
}
