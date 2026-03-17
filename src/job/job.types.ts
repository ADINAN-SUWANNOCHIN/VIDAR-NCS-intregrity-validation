export enum JobStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  DONE = 'DONE',
  FAILED = 'FAILED',
}

export interface TableSummary {
  tableName: string;
  rowsChecked: number;
  totalErrors: number;
  status: 'PASS' | 'FAIL';
  timeSpentSec: number;
}

export interface JobRecord {
  jobId: string;
  label?: string;
  status: JobStatus;
  createdAt: Date;
  totalTables: number;
  doneTables: number;
  startedAt?: Date;
  finishedAt?: Date;
  reportPaths?: string[];
  errorMessage?: string;
  summary?: TableSummary[];   // inline results — populated when DONE
}
