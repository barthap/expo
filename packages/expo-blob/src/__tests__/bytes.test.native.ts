import { Blob } from '..';

describe('Blob.bytes', () => {
  // The native implementation hands out a fresh array on every call. The jest mock has to do
  // the same, otherwise a test that mutates the returned array silently corrupts the blob and
  // passes (or fails) for reasons that could never happen on a device.
  it('returns an array that does not alias the blob contents', async () => {
    const blob = new Blob(['hello']);

    const bytes = await blob.bytes();
    bytes[0] = 0;

    expect(await blob.text()).toBe('hello');
    expect(Array.from(await blob.bytes())).toEqual(Array.from(new TextEncoder().encode('hello')));
  });

  it('returns a new array on each call', async () => {
    const blob = new Blob(['hello']);
    expect(await blob.bytes()).not.toBe(await blob.bytes());
  });
});
