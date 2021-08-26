import SweetSQLite from '../ExpoSQLite';
import { ExpoSQLiteDatabase } from '../SQLiteDatabase';
import { StatementType } from '../SQLiteStatementUtils';
import * as NativeMock from './MockNativeModule';

jest.mock('../ExpoSQLite', () => require('./MockNativeModule').mockNativeSQLite());

describe(ExpoSQLiteDatabase, () => {
  const db = ExpoSQLiteDatabase.open('asdf');

  beforeEach(() => {
    NativeMock.resetSqlHistory();
  });

  it('executes native SQL', async () => {
    await db.executeSql('SELECT * from users');

    expect(NativeMock.getSqlHistory()).executedExactlyFollowingSql([/SELECT \* FROM users/i]);
  });

  it('transforms query format', async () => {
    const sql = 'SELECT * FROM users WHERE id=?';
    await db.executeSql({ sql, args: [42] });

    expect(SweetSQLite.exec as jest.Mock).toHaveBeenCalledWith(
      expect.any(String),
      [[sql, [42], StatementType.SELECT]],
      expect.any(Boolean)
    );
  });

  it('executes SQL in order regardless of awaiting', async () => {
    await db.executeSql('SELECT 1');
    db.executeSql('SELECT 2');
    await db.executeSql('SELECT 3');
    db.executeSql('SELECT 4');
    db.executeSql('SELECT 5');
    await db.executeSql('SELECT 6');
    await db.executeSql('SELECT 7');

    expect.arrayContaining([]);
    expect(NativeMock.getSqlHistory()).executedExactlyFollowingSql([
      'SELECT 1',
      'SELECT 2',
      'SELECT 3',
      'SELECT 4',
      'SELECT 5',
      'SELECT 6',
      'SELECT 7',
    ]);
  });

  it.todo('handles failing statements');
  it.todo('throws when operating on closed db');
});
