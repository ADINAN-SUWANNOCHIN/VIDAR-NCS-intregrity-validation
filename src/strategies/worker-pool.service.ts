import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker } from 'worker_threads';
import * as os from 'os';
import * as path from 'path';
import type { CompareTask, CompareResult } from './compare.worker';

interface PendingTask {
  payload: CompareTask;
  resolve: (result: CompareResult) => void;
  reject: (err: Error) => void;
}

@Injectable()
export class WorkerPoolService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkerPoolService.name);
  private readonly poolSize = Math.max(1, os.cpus().length - 1);
  private workers: Worker[] = [];
  private idleWorkers: Worker[] = [];
  private queue: PendingTask[] = [];

  // Stored so the crash-restart handler can re-use the same script path + execArgv
  private workerScript!: string;
  private workerExecArgv!: string[];

  onModuleInit(): void {
    const isDev = __filename.endsWith('.ts');
    this.workerScript = path.join(
      __dirname,
      isDev ? 'compare.worker.ts' : 'compare.worker.js',
    );
    this.workerExecArgv = isDev
      ? ['--require', 'ts-node/register', '--require', 'tsconfig-paths/register']
      : [];

    for (let i = 0; i < this.poolSize; i++) {
      const worker = this.spawnWorker();
      this.workers.push(worker);
      this.idleWorkers.push(worker);
    }

    this.logger.log(`Worker pool started with ${this.poolSize} thread(s)`);
  }

  private spawnWorker(): Worker {
    const worker = new Worker(this.workerScript, { execArgv: this.workerExecArgv });
    this.setupWorker(worker);
    return worker;
  }

  private setupWorker(worker: Worker): void {
    worker.on('message', (result: CompareResult) => {
      const task = (worker as any)._task as PendingTask | undefined;
      (worker as any)._task = null;

      if (task) task.resolve(result);

      if (this.queue.length > 0) {
        this.dispatch(worker, this.queue.shift()!);
      } else {
        this.idleWorkers.push(worker);
      }
    });

    worker.on('error', (err) => {
      const task = (worker as any)._task as PendingTask | undefined;
      (worker as any)._task = null;

      this.logger.error(`Worker crashed: ${err.message}`);
      if (task) task.reject(err);

      // Replace the crashed worker with a fresh one
      const idx = this.workers.indexOf(worker);
      if (idx !== -1) {
        const fresh = this.spawnWorker();
        this.workers[idx] = fresh;
        this.idleWorkers.push(fresh);
      }
    });
  }

  run(task: CompareTask): Promise<CompareResult> {
    return new Promise<CompareResult>((resolve, reject) => {
      const pending: PendingTask = { payload: task, resolve, reject };
      if (this.idleWorkers.length > 0) {
        this.dispatch(this.idleWorkers.pop()!, pending);
      } else {
        this.queue.push(pending);
      }
    });
  }

  private dispatch(worker: Worker, task: PendingTask): void {
    (worker as any)._task = task;
    worker.postMessage(task.payload);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()));
    this.logger.log('Worker pool terminated');
  }
}
