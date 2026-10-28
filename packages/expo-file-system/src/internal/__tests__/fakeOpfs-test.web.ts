/**
 * @jest-environment node
 */
// The store tests trust the fake to fail the way OPFS fails. These tests pin the behaviour the
// store depends on, so a broken fake cannot hide a store bug.
import { counterClock, createFakeOpfs, putFile } from './fakeOpfs';

async function nameOfRejection(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return (error as Error).name;
  }
  return undefined;
}

describe('fake OPFS', () => {
  it('rejects with the DOMException names that OPFS uses', async () => {
    const { root } = createFakeOpfs();
    await putFile(root, ['file.txt'], 'x');
    await root.getDirectoryHandle('dir', { create: true });

    const missing = root.getFileHandle('missing');
    await expect(missing).rejects.toBeInstanceOf(DOMException);
    expect(await nameOfRejection(missing)).toBe('NotFoundError');
    expect(await nameOfRejection(root.getDirectoryHandle('missing'))).toBe('NotFoundError');
    expect(await nameOfRejection(root.getDirectoryHandle('file.txt'))).toBe('TypeMismatchError');
    expect(await nameOfRejection(root.getFileHandle('dir'))).toBe('TypeMismatchError');
    expect(await nameOfRejection(root.removeEntry('missing'))).toBe('NotFoundError');
  });

  it('rejects invalid names with a TypeError, like the "valid file name" rule', async () => {
    const { root } = createFakeOpfs();
    for (const name of ['', '.', '..', 'a/b', 'a\\b']) {
      await expect(root.getFileHandle(name, { create: true })).rejects.toBeInstanceOf(TypeError);
    }
  });

  it('refuses to remove a directory with children unless `recursive` is set', async () => {
    const { root } = createFakeOpfs();
    await putFile(root, ['dir', 'a.txt'], 'x');
    expect(await nameOfRejection(root.removeEntry('dir'))).toBe('InvalidModificationError');
    await root.removeEntry('dir', { recursive: true });
    expect(await nameOfRejection(root.getDirectoryHandle('dir'))).toBe('NotFoundError');
  });

  it('removes an empty directory without `recursive`', async () => {
    const { root } = createFakeOpfs();
    await root.getDirectoryHandle('dir', { create: true });
    await root.removeEntry('dir');
    expect([...(await collect(root.keys()))]).toEqual([]);
  });

  // Real OPFS does this too, which is why the store opens handles again for every call.
  it('makes old handles of a removed entry throw NotFoundError', async () => {
    const { root } = createFakeOpfs();
    await putFile(root, ['dir', 'a.txt'], 'x');
    const dir = await root.getDirectoryHandle('dir');
    const file = await dir.getFileHandle('a.txt');
    await root.removeEntry('dir', { recursive: true });
    expect(await nameOfRejection(file.getFile())).toBe('NotFoundError');
    expect(await nameOfRejection(dir.getFileHandle('a.txt'))).toBe('NotFoundError');
    expect(await nameOfRejection(collect(dir.entries()))).toBe('NotFoundError');
  });

  it('changes the file only when the writable closes', async () => {
    const { root } = createFakeOpfs(counterClock());
    await putFile(root, ['a.txt'], 'old');
    const handle = await root.getFileHandle('a.txt');
    const before = await handle.getFile();

    const writable = await handle.createWritable();
    await writable.write('new content');
    expect(await (await handle.getFile()).text()).toBe('old');
    await writable.close();

    const after = await handle.getFile();
    expect(await after.text()).toBe('new content');
    expect(after.lastModified).toBeGreaterThan(before.lastModified);
  });

  it('drops the written data when the writable aborts', async () => {
    const { root } = createFakeOpfs();
    await putFile(root, ['a.txt'], 'old');
    const handle = await root.getFileHandle('a.txt');
    const writable = await handle.createWritable();
    await writable.write('new');
    await writable.abort();
    expect(await (await handle.getFile()).text()).toBe('old');
  });

  it('keeps the data and writes at a position with `keepExistingData` and `seek`', async () => {
    const { root } = createFakeOpfs();
    await putFile(root, ['a.txt'], 'hello');
    const handle = await root.getFileHandle('a.txt');
    const writable = await handle.createWritable({ keepExistingData: true });
    await writable.seek(5);
    await writable.write(new Uint8Array([33]));
    await writable.close();
    expect(await (await handle.getFile()).text()).toBe('hello!');
  });

  // A `Blob` has a `type` property, but it is data, not a `{ type: 'seek' }` command.
  it('writes a Blob chunk as data', async () => {
    const { root } = createFakeOpfs();
    const handle = await root.getFileHandle('a.txt', { create: true });
    const writable = await handle.createWritable();
    await writable.write(new Blob(['blob'], { type: 'text/plain' }));
    await writable.close();
    expect(await (await handle.getFile()).text()).toBe('blob');
  });

  it('accepts a piped stream and closes on its end', async () => {
    const { root } = createFakeOpfs();
    const handle = await root.getFileHandle('a.txt', { create: true });
    await new Blob(['piped ', 'data']).stream().pipeTo(await handle.createWritable());
    expect(await (await handle.getFile()).text()).toBe('piped data');
  });

  // MDN `createWritable()`: with `mode: 'exclusive'`, opening a second writer before the first
  // closes throws `NoModificationAllowedError`. The store relies on that to fail loud on
  // concurrent writes.
  it('locks a file for an exclusive writable until it closes or aborts', async () => {
    const { root } = createFakeOpfs();
    const handle = await root.getFileHandle('a.txt', { create: true });

    const first = await handle.createWritable({ mode: 'exclusive' });
    expect(await nameOfRejection(handle.createWritable({ mode: 'exclusive' }))).toBe(
      'NoModificationAllowedError'
    );
    expect(await nameOfRejection(handle.createWritable())).toBe('NoModificationAllowedError');
    await first.close();

    const second = await handle.createWritable({ mode: 'exclusive' });
    await second.abort();
    await (await handle.createWritable({ mode: 'exclusive' })).close();
  });

  it('allows many siloed writables, but no exclusive one next to them', async () => {
    const { root } = createFakeOpfs();
    const handle = await root.getFileHandle('a.txt', { create: true });
    const first = await handle.createWritable();
    const second = await handle.createWritable({ mode: 'siloed' });
    expect(await nameOfRejection(handle.createWritable({ mode: 'exclusive' }))).toBe(
      'NoModificationAllowedError'
    );
    await first.close();
    await second.close();
    await (await handle.createWritable({ mode: 'exclusive' })).close();
  });

  it('lists children through entries(), keys(), and async iteration', async () => {
    const { root } = createFakeOpfs();
    await putFile(root, ['a.txt'], 'x');
    await root.getDirectoryHandle('dir', { create: true });
    const entries = await collect(root.entries());
    expect(entries.map(([name, handle]) => [name, handle.kind])).toEqual([
      ['a.txt', 'file'],
      ['dir', 'directory'],
    ]);
    expect(await collect(root.keys())).toEqual(['a.txt', 'dir']);
    expect((await collect(root[Symbol.asyncIterator]())).length).toBe(2);
  });
});

async function collect<T>(iterator: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterator) {
    items.push(item);
  }
  return items;
}
