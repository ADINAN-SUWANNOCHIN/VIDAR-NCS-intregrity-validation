import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { TableType } from '../rules/rule.types';
import { BaseStrategy } from './base.strategy';
import { MasterStrategy } from './master.strategy';
import { TransactionStrategy } from './transaction.strategy';
import { WorkerPoolService } from './worker-pool.service';
import {
  SplitStrategy,
  HeaderStrategy,
  UnionStrategy,
  MultipleStrategy,
} from './other.strategies';

@Injectable()
export class StrategyFactory {
  constructor(
    private readonly db: DatabaseService,
    private readonly workerPool: WorkerPoolService,
  ) {}

  create(tableType: TableType): BaseStrategy {
    switch (tableType) {
      case 'MASTER':
        return new MasterStrategy(this.db, this.workerPool);
      case 'TRANSACTION':
        return new TransactionStrategy(this.db);
      case 'SPLIT':
        return new SplitStrategy(this.db);
      case 'HEADER':
        return new HeaderStrategy(this.db);
      case 'UNION':
        return new UnionStrategy(this.db);
      case 'MULTIPLE':
        return new MultipleStrategy(this.db);
      case 'ASSOCIATE':
        // Associate tables validate like 1:1 master tables (key column comparison only)
        return new MasterStrategy(this.db, this.workerPool);
      default:
        throw new Error(`Unknown table type: ${tableType}`);
    }
  }
}
