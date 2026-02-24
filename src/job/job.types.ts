export enum JobStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  DONE = 'DONE',
  FAILED = 'FAILED',
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
}
