import Queue from 'tiny-queue';

import { ExpoSQLiteTransactionBlock } from './SQLite.types';
import { ExpoSQLiteDatabase } from './SQLiteDatabase';

export enum TransactionState {
  NOT_STARTED,
  PENDING,
  COMITTED,
  ROLLED_BACK,
}

/**
 * Handles single SQL transaction
 */
export class ExpoSQLiteTransaction {
  private state = TransactionState.NOT_STARTED;
  constructor(private db: ExpoSQLiteDatabase) {}

  async run(transactionBlock: ExpoSQLiteTransactionBlock) {
    try {
      await this.db.executeSql({ sql: 'BEGIN EXCLUSIVE;', args: [] });
    } catch (e) {
      throw new Error('Could not begin transaction: ' + e);
    }

    try {
      this.state = TransactionState.PENDING;

      // TODO: Find a better way to pass it here
      await transactionBlock({
        commit: this.commitAsync.bind(this),
        rollback: this.rollbackAsync.bind(this),

        executeSql: this.db.executeSql.bind(this.db),
        select: this.db.select.bind(this.db),
        insert: this.db.insert.bind(this.db),
        updateDelete: this.db.updateDelete.bind(this.db),
      });

      await this.commitAsync();
    } catch (err) {
      await this.rollbackAsync();
      // TODO: Handle better
      throw err;
    }
  }

  private async commitAsync() {
    if (this.isFinished()) {
      return;
    }

    await this.db.executeSql({ sql: 'COMMIT;', args: [] });
    this.state = TransactionState.COMITTED;
  }

  private async rollbackAsync() {
    if (this.isFinished()) {
      return;
    }

    await this.db.executeSql({ sql: 'ROLLBACK;', args: [] });
    this.state = TransactionState.ROLLED_BACK;
  }

  private isFinished() {
    return this.state === TransactionState.COMITTED || this.state === TransactionState.ROLLED_BACK;
  }
}

/**
 * Represents a single transaction task. Used by transaction queue
 */
interface ExpoSQLiteTransactionTask {
  block: ExpoSQLiteTransactionBlock;
  resolver: () => void;
  rejecter: (err?: unknown) => void;
}

/**
 * Handles queueing SQL transactions
 */
export class ExpoSQLiteTransactionQueue {
  private isRunning = false;

  private queue = new Queue<ExpoSQLiteTransactionTask>();
  constructor(private db: ExpoSQLiteDatabase) {}

  startTransaction(block: ExpoSQLiteTransactionBlock): Promise<void> {
    return new Promise((resolver, rejecter) => {
      this.queue.push({ block, resolver, rejecter });
      this.runNextTransaction();
    });
  }

  private async runNextTransaction() {
    if (this.isRunning || this.queue.length < 1) {
      return;
    }

    const task = this.queue.shift();

    if (!task) {
      return;
    }

    const txn = new ExpoSQLiteTransaction(this.db);

    try {
      this.isRunning = true;
      await txn.run(task.block);
      task.resolver();
    } catch (err) {
      task.rejecter(err);
    } finally {
      this.isRunning = false;
      this.runNextTransaction();
    }
  }
}
