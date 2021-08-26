import { ExpoSQLTransaction } from '../SQLite.types';
import { ExpoSQLiteTransaction, TransactionState } from '../SQLiteTransactions';
import { MockExpoSQLiteDatabase } from './MockDatabase';

describe(ExpoSQLiteTransaction, () => {
  it('initializes with NOT_STARTED state', async () => {
    const txn = new ExpoSQLiteTransaction(MockExpoSQLiteDatabase());
    expect(txn['state']).toBe(TransactionState.NOT_STARTED);
  });

  it('runs the transaction block and binds the database object', async () => {
    const db = MockExpoSQLiteDatabase();
    const txn = new ExpoSQLiteTransaction(db);

    const block = jest.fn().mockImplementation(async (tx: ExpoSQLTransaction) => {
      await tx.executeSql({ sql: 'SELECT * FROM USERS', args: [] });
    });

    await txn.run(block);

    expect(db).nthExecutedSqlMatching(1, /BEGIN/);
    expect(db).didExecuteSqlMatching(/SELECT/);
  });

  it('auto-commits the transaction if user did not do it', async () => {
    const db = MockExpoSQLiteDatabase();
    const txn = new ExpoSQLiteTransaction(db);

    await txn.run(jest.fn().mockReturnValue(Promise.resolve()));

    expect(db).didExecuteSqlMatching(/COMMIT/, { times: 1 });
  });

  it('does not run transaction block when BEGIN fails', async () => {
    const db = MockExpoSQLiteDatabase();
    const txn = new ExpoSQLiteTransaction(db);
    const block = jest.fn().mockReturnValue(Promise.resolve());

    db.failWhenSqlMatches(/BEGIN/);

    await expect(txn.run(block)).rejects.toThrow();
    expect(block).not.toHaveBeenCalled();
  });

  it('rolls back when statement in transaction fails', async () => {
    const db = MockExpoSQLiteDatabase();
    const txn = new ExpoSQLiteTransaction(db);

    const block = jest.fn().mockImplementation(async (tx: ExpoSQLTransaction) => {
      await tx.executeSql({ sql: 'SELECT * FROM USERS', args: [] });
    });

    db.failWhenSqlMatches(/SELECT/);

    await expect(txn.run(block)).rejects.toThrowError();

    expect(db).not.didExecuteSqlMatching(/COMMIT/);
    expect(db).didExecuteSqlMatching(/ROLLBACK/, { times: 1 });
  });

  it('rolls back when exception happens inside block', async () => {
    const db = MockExpoSQLiteDatabase();
    const txn = new ExpoSQLiteTransaction(db);

    const block = jest.fn().mockImplementation(async (tx: ExpoSQLTransaction) => {
      throw new Error('test fail');
    });

    await expect(txn.run(block)).rejects.toThrowError();

    expect(db).not.didExecuteSqlMatching(/COMMIT/);
    expect(db).didExecuteSqlMatching(/ROLLBACK/, { times: 1 });
  });

  it('does not commit twice if user did it manually', async () => {
    const db = MockExpoSQLiteDatabase();
    const txn = new ExpoSQLiteTransaction(db);

    const block = jest.fn().mockImplementation(async (tx: ExpoSQLTransaction) => {
      await tx.executeSql({ sql: 'SELECT * FROM USERS', args: [] });
      await tx.commit();
    });
    await txn.run(block);

    expect(db).didExecuteSqlMatching(/COMMIT/, { times: 1 });
  });
});
