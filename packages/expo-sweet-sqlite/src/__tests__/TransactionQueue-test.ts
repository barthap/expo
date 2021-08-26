import { ExpoSQLiteTransactionQueue } from '../SQLiteTransactions';
import { MockExpoSQLiteDatabase } from './MockDatabase';

describe(ExpoSQLiteTransactionQueue, () => {
  it('runs a transaction', async () => {
    const queue = new ExpoSQLiteTransactionQueue(MockExpoSQLiteDatabase());
    const block = jest.fn().mockResolvedValue(undefined);

    await queue.startTransaction(block);

    expect(block).toHaveBeenCalled();
  });

  it('rejects when transaction block fails', async () => {
    const queue = new ExpoSQLiteTransactionQueue(MockExpoSQLiteDatabase());
    const block = jest.fn().mockRejectedValue(new Error('test failure'));

    await expect(queue.startTransaction(block)).rejects.toThrowError('test failure');
  });

  it('runs transactions in order even without awaiting', async () => {
    const queue = new ExpoSQLiteTransactionQueue(MockExpoSQLiteDatabase());

    const executionOrder: string[] = [];

    // We enqueue two tasks in parallel, but the second should not be run until first is done
    // we use then() to indicate when the task is finished
    // messing up `ExpoSQLiteTransactionQueue.isRunning` makes this test failing
    await Promise.all([
      queue
        .startTransaction(
          jest.fn().mockImplementation(async () => {
            executionOrder.push('exec-1');
          })
        )
        .then(async () => {
          executionOrder.push('finish-1');
        }),
      queue
        .startTransaction(
          jest.fn().mockImplementation(async () => {
            executionOrder.push('exec-2');
          })
        )
        .then(async () => {
          executionOrder.push('finish-2');
        }),
    ]);

    expect(executionOrder).toEqual(['exec-1', 'finish-1', 'exec-2', 'finish-2']);
  });

  it('rejects only failed transactions', async () => {
    const queue = new ExpoSQLiteTransactionQueue(MockExpoSQLiteDatabase());
    const transactionBlocks = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('2nd task fails'))
      .mockResolvedValueOnce(undefined);

    const task1 = queue.startTransaction(transactionBlocks);
    const task2 = queue.startTransaction(transactionBlocks);
    const task3 = queue.startTransaction(transactionBlocks);

    await Promise.all([
      expect(task1).resolves.toBeUndefined(),
      expect(task2).rejects.toThrowError(),
      expect(task3).resolves.toBeUndefined(),
    ]);
  });
});
