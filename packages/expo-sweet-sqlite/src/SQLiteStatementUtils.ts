export enum StatementType {
  DEFAULT = 0,
  SELECT,
  INSERT,
  UPDATE,
  DELETE,
}

export function getSqlStatementType(sqlString: string): StatementType {
  if (/^\s*SELECT\s/i.test(sqlString)) {
    return StatementType.SELECT;
  } else if (/^\s*INSERT\s+INTO\s/i.test(sqlString)) {
    return StatementType.INSERT;
  } else if (/^\s*UPDATE\s/i.test(sqlString)) {
    return StatementType.UPDATE;
  } else if (/^\s*DELETE\s+FROM\s/i.test(sqlString)) {
    return StatementType.DELETE;
  } else {
    return StatementType.DEFAULT;
  }
}

export function escapeBlob<T>(data: T): T {
  if (typeof data === 'string') {
    /* eslint-disable no-control-regex */
    return data
      .replace(/\u0002/g, '\u0002\u0002')
      .replace(/\u0001/g, '\u0001\u0002')
      .replace(/\u0000/g, '\u0001\u0001') as any;
    /* eslint-enable no-control-regex */
  } else {
    return data;
  }
}
