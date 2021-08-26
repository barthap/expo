import { getSqlStatementType, StatementType } from '../SQLiteStatementUtils';

describe(getSqlStatementType, () => {
  it('recognizes SELECT statement', () => {
    expect(getSqlStatementType('select * from users')).toBe(StatementType.SELECT);
    expect(getSqlStatementType(' sElect id from users')).toBe(StatementType.SELECT);
    expect(getSqlStatementType('SELECT * from users')).toBe(StatementType.SELECT);

    expect(getSqlStatementType('invalid select * from users')).not.toBe(StatementType.SELECT);
    expect(getSqlStatementType('select* from users')).not.toBe(StatementType.SELECT);
    expect(getSqlStatementType('insert into selections')).not.toBe(StatementType.SELECT);
    expect(getSqlStatementType('delete from todos where name="selected"')).not.toBe(
      StatementType.SELECT
    );
  });

  it('recognizes INSERT statement', () => {
    expect(getSqlStatementType('insert into users values (1, "John")')).toBe(StatementType.INSERT);
    expect(getSqlStatementType('   Insert\tintO test')).toBe(StatementType.INSERT);
    expect(getSqlStatementType('INSERT   INTO ')).toBe(StatementType.INSERT);

    expect(getSqlStatementType('INSERT INTO')).not.toBe(StatementType.INSERT);
    expect(getSqlStatementType('select * from insertions')).not.toBe(StatementType.INSERT);
    expect(getSqlStatementType('delete from todos where name="inserted"')).not.toBe(
      StatementType.INSERT
    );
  });

  it('recognizes UPDATE statement', () => {
    expect(getSqlStatementType('update users set name="john" where id=1')).toBe(
      StatementType.UPDATE
    );
    expect(getSqlStatementType('   uPDate posts')).toBe(StatementType.UPDATE);
    expect(getSqlStatementType('   UPDATE ')).toBe(StatementType.UPDATE);

    expect(getSqlStatementType('UPDATE')).not.toBe(StatementType.UPDATE);
    expect(getSqlStatementType('invalid update ')).not.toBe(StatementType.UPDATE);
    expect(getSqlStatementType('delete from todos where name="updated"')).not.toBe(
      StatementType.UPDATE
    );
  });

  it('recognizes DELETE statement', () => {
    expect(getSqlStatementType('delete from users where id=1')).toBe(StatementType.DELETE);
    expect(getSqlStatementType('  DeLeTe fROm posts')).toBe(StatementType.DELETE);
    expect(getSqlStatementType('   DELETE   FROM ')).toBe(StatementType.DELETE);

    expect(getSqlStatementType('DELETEFROM')).not.toBe(StatementType.DELETE);
    expect(getSqlStatementType('DELETE ')).not.toBe(StatementType.DELETE);
    expect(getSqlStatementType('update todos set name="delete from"')).not.toBe(
      StatementType.DELETE
    );
  });

  it('returns DEFAULT type for other statements', () => {
    expect(getSqlStatementType('CREATE TABLE users')).toBe(StatementType.DEFAULT);
    expect(getSqlStatementType('DROP TABLE users')).toBe(StatementType.DEFAULT);
    expect(getSqlStatementType('BEGIN EXCLUSIVE')).toBe(StatementType.DEFAULT);
    expect(getSqlStatementType('ALTER TABLE')).toBe(StatementType.DEFAULT);
    expect(getSqlStatementType('PRAGMA')).toBe(StatementType.DEFAULT);
  });
});
