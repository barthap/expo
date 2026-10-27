/**
 * @jest-environment jsdom
 */
// The picker needs a DOM, so this file runs in jsdom instead of the Node environment of
// `FileSystemWeb-test.web.ts`. jsdom has no `URL.createObjectURL`, no `navigator.userActivation`,
// and never opens a dialog, so the tests mock those and play the user's part by dispatching the
// events the browser would send.
import { File } from '../index';

let objectUrlCount = 0;
let openedInput: HTMLInputElement | null = null;
let inputWasInDocument = false;

beforeEach(() => {
  objectUrlCount = 0;
  openedInput = null;
  inputWasInDocument = false;
  URL.createObjectURL = jest.fn(() => `blob:http://localhost/picked-${++objectUrlCount}`);
  URL.revokeObjectURL = jest.fn();
  jest
    .spyOn(HTMLInputElement.prototype, 'click')
    .mockImplementation(function (this: HTMLInputElement) {
      onClick(this);
    });
});

function onClick(input: HTMLInputElement) {
  openedInput = input;
  inputWasInDocument = document.body.contains(input);
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
  delete (navigator as any).userActivation;
});

function makeWebFile(content: string, name: string, type = 'text/plain') {
  return new globalThis.File([content], name, { type, lastModified: 1234 });
}

// What the browser does when the user picks files in the dialog.
function pick(...webFiles: globalThis.File[]) {
  Object.defineProperty(openedInput!, 'files', { value: webFiles, configurable: true });
  openedInput!.dispatchEvent(new Event('change'));
}

// What the browser does when the user closes the dialog without picking.
function cancel() {
  openedInput!.dispatchEvent(new Event('cancel'));
}

function setUserActivation(isActive: boolean) {
  Object.defineProperty(navigator, 'userActivation', {
    value: { isActive, hasBeenActive: isActive },
    configurable: true,
  });
}

// Makes `'oncancel' in input` false, like in a browser without the `cancel` event on file inputs.
function withoutCancelEventSupport(): () => void {
  let owner: object | null = HTMLInputElement.prototype;
  while (owner && !Object.prototype.hasOwnProperty.call(owner, 'oncancel')) {
    owner = Object.getPrototypeOf(owner);
  }
  const descriptor = Object.getOwnPropertyDescriptor(owner!, 'oncancel')!;
  delete (owner as any).oncancel;
  return () => Object.defineProperty(owner!, 'oncancel', descriptor);
}

describe('File.pickFileAsync on web', () => {
  it('returns the picked file as a snapshot-backed File with a blob: uri', async () => {
    const promise = File.pickFileAsync();
    expect(inputWasInDocument).toBe(true);
    expect(openedInput!.type).toBe('file');
    expect(openedInput!.multiple).toBe(false);
    pick(makeWebFile('picked data', 'photo.png', 'image/png'));

    const { result, canceled } = await promise;
    expect(canceled).toBe(false);
    expect(result).toBeInstanceOf(File);
    expect(result!.uri).toBe('blob:http://localhost/picked-1');
    expect(result!.name).toBe('photo.png');
    expect(result!.type).toBe('image/png');
    expect(result!.size).toBe(11);
    expect(result!.lastModified).toBe(1234);
    expect(result!.exists).toBe(true);
    // The uri resolves to the same data again, like a picked file on native.
    expect(new File(result!.uri).size).toBe(11);
    result!.delete();
  });

  it('returns every picked file when multipleFiles is true', async () => {
    const promise = File.pickFileAsync({ multipleFiles: true });
    expect(openedInput!.multiple).toBe(true);
    pick(makeWebFile('one', 'a.txt'), makeWebFile('three', 'b.txt'));

    const { result, canceled } = await promise;
    expect(canceled).toBe(false);
    expect(result!.map((file) => [file.name, file.size])).toEqual([
      ['a.txt', 3],
      ['b.txt', 5],
    ]);
    expect(new Set(result!.map((file) => file.uri)).size).toBe(2);
    result!.forEach((file) => file.delete());
  });

  it('returns the File itself for the deprecated (initialUri, mimeType) form', async () => {
    const promise = File.pickFileAsync('file:///ignored/', 'text/plain');
    expect(openedInput!.accept).toBe('text/plain');
    pick(makeWebFile('old api', 'old.txt'));
    const file = (await promise) as File;
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe('old.txt');
    file.delete();
  });

  it.each([
    ['a single MIME type', 'image/*', 'image/*'],
    ['a list of MIME types', ['image/*', 'application/pdf'], 'image/*,application/pdf'],
    ['*/*', '*/*', null],
    ['a list that contains */*', ['image/*', '*/*'], null],
    ['no MIME type', undefined, null],
  ])('limits the dialog to %s', async (_, mimeTypes, accept) => {
    const promise = File.pickFileAsync({ mimeTypes });
    // `null` means the dialog offers every file.
    expect(openedInput!.getAttribute('accept')).toBe(accept);
    cancel();
    await promise;
  });

  it('resolves as canceled when the user closes the dialog', async () => {
    const promise = File.pickFileAsync();
    const input = openedInput!;
    cancel();
    await expect(promise).resolves.toEqual({ result: null, canceled: true });
    expect(input.isConnected).toBe(false);
  });

  it('resolves as canceled when change reports no files', async () => {
    const promise = File.pickFileAsync({ multipleFiles: true });
    pick();
    await expect(promise).resolves.toEqual({ result: null, canceled: true });
  });

  it('throws a cancel for the deprecated form, which never returned { canceled }', async () => {
    const promise = File.pickFileAsync('file:///ignored/');
    cancel();
    await expect(promise).rejects.toThrow('canceled');
  });

  it('rejects instead of hanging when wrapping a picked file throws', async () => {
    jest.mocked(URL.createObjectURL).mockImplementationOnce(() => {
      throw new Error('createObjectURL failed');
    });
    // The deprecated form re-throws, so the error itself reaches the caller.
    const promise = File.pickFileAsync('file:///ignored/');
    const input = openedInput!;
    pick(makeWebFile('x', 'x.txt'));
    await expect(promise).rejects.toThrow('createObjectURL failed');
    expect(input.isConnected).toBe(false);
  });

  it('removes the input from the document after a pick', async () => {
    const promise = File.pickFileAsync();
    const input = openedInput!;
    pick(makeWebFile('x', 'x.txt'));
    (await promise).result!.delete();
    expect(input.isConnected).toBe(false);
    expect(document.querySelectorAll('input').length).toBe(0);
  });

  it('waits for a slow change after the focus when the browser has the cancel event', async () => {
    jest.useFakeTimers();
    const promise = File.pickFileAsync();
    window.dispatchEvent(new Event('focus'));
    // A large file can take seconds to reach `change`; it must not count as a cancel.
    jest.advanceTimersByTime(5000);
    pick(makeWebFile('large', 'large.bin'));
    const { result, canceled } = await promise;
    expect(canceled).toBe(false);
    result!.delete();
  });

  describe('while another picker is open', () => {
    it('rejects with ERR_PICKER_IN_PROGRESS without opening a second dialog', async () => {
      const first = File.pickFileAsync();
      const firstInput = openedInput!;
      const clickSpy = jest.mocked(HTMLInputElement.prototype.click);
      // The deprecated form re-throws, so the code reaches the caller.
      await expect(File.pickFileAsync('file:///ignored/')).rejects.toMatchObject({
        code: 'ERR_PICKER_IN_PROGRESS',
      });
      // The current form reports it as a cancel, like iOS.
      await expect(File.pickFileAsync()).resolves.toEqual({ result: null, canceled: true });
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(openedInput).toBe(firstInput);

      pick(makeWebFile('first', 'first.txt'));
      (await first).result!.delete();
    });

    it('opens a new dialog after the previous one settled', async () => {
      const first = File.pickFileAsync();
      cancel();
      await first;
      const second = File.pickFileAsync();
      pick(makeWebFile('second', 'second.txt'));
      const { result, canceled } = await second;
      expect(canceled).toBe(false);
      expect(result!.name).toBe('second.txt');
      result!.delete();
    });
  });

  describe('in a browser without the cancel event', () => {
    let restore: () => void;
    beforeEach(() => {
      restore = withoutCancelEventSupport();
      jest.useFakeTimers();
    });
    afterEach(() => restore());

    it('resolves as canceled shortly after the window gets focus back without a change', async () => {
      const promise = File.pickFileAsync();
      const input = openedInput!;
      expect('oncancel' in input).toBe(false);
      window.dispatchEvent(new Event('focus'));
      jest.advanceTimersByTime(999);
      // A `change` arriving within the grace period still counts as a pick.
      let settled = false;
      promise.then(() => (settled = true));
      await Promise.resolve();
      expect(settled).toBe(false);
      jest.advanceTimersByTime(1);
      await expect(promise).resolves.toEqual({ result: null, canceled: true });
      expect(input.isConnected).toBe(false);
    });

    it('returns the files when change arrives after the focus', async () => {
      const promise = File.pickFileAsync();
      window.dispatchEvent(new Event('focus'));
      jest.advanceTimersByTime(500);
      pick(makeWebFile('late', 'late.txt'));
      const { result } = await promise;
      expect(result!.name).toBe('late.txt');
      // The focus timer was cleared and does not settle the promise a second time.
      jest.advanceTimersByTime(1000);
      expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
      result!.delete();
    });
  });

  describe('user activation', () => {
    it('throws ERR_USER_ACTIVATION without opening the dialog when there is no user gesture', async () => {
      setUserActivation(false);
      const clickSpy = jest.mocked(HTMLInputElement.prototype.click);
      // A cancel result would hide a dialog that can never open, so the error reaches the caller.
      await expect(File.pickFileAsync()).rejects.toMatchObject({
        code: 'ERR_USER_ACTIVATION',
        message: expect.stringContaining('user gesture'),
      });
      expect(clickSpy).not.toHaveBeenCalled();
      expect(document.querySelectorAll('input').length).toBe(0);
    });

    it('opens the dialog inside a user gesture', async () => {
      setUserActivation(true);
      const promise = File.pickFileAsync();
      expect(openedInput).not.toBeNull();
      cancel();
      await expect(promise).resolves.toEqual({ result: null, canceled: true });
    });
  });
});
