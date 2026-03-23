import { Controller, Get, Module, Redirect } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseService } from './database/database.service';
import { PgCacheService } from './database/pg-cache.service';
import { RuleLoaderService } from './rules/rule-loader.service';
import { JobService } from './job/job.service';
import { ReportService } from './reports/report.service';
import { StrategyFactory } from './strategies/strategy.factory';
import { WorkerPoolService } from './strategies/worker-pool.service';
import { ValidationService } from './validation/validation.service';
import { ValidationController } from './validation/validation.controller';
import { PresetService } from './validation/preset.service';
import { SchemaController } from './schema/schema.controller';
import { SchemaService } from './schema/schema.service';

/** Handles root-level routes that must NOT be prefixed by any controller path. */
@Controller()
class HealthController {
  constructor(private readonly pg: PgCacheService) {}

  /** GET /health — Kubernetes liveness + readiness probe target. */
  @Get('health')
  health(): { status: string } {
    return { status: 'ok' };
  }

  /** GET /health/pg — diagnostic: tests PostgreSQL cache DB connectivity and write ability. */
  @Get('health/pg')
  async healthPg(): Promise<{ connected: boolean; writable: boolean; error?: string }> {
    if (!this.pg.isAvailable) {
      return { connected: false, writable: false, error: 'PgCacheService pool is null — check CACHE_DB_* env vars or startup logs' };
    }
    try {
      await this.pg.createCacheTable('_hc_test', ['v']);
      await this.pg.batchInsert('_hc_test', [{ v: 'ok' }], ['v']);
      await this.pg.dropCacheTable('_hc_test');
      return { connected: true, writable: true };
    } catch (e: any) {
      return { connected: true, writable: false, error: e.message };
    }
  }

  /** GET / — redirect to Swagger UI. */
  @Get()
  @Redirect('/api', 302)
  root() {}
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
  ],
  controllers: [HealthController, ValidationController, SchemaController],
  providers: [
    PgCacheService,
    DatabaseService,
    RuleLoaderService,
    JobService,
    ReportService,
    WorkerPoolService,
    StrategyFactory,
    ValidationService,
    PresetService,
    SchemaService,
  ],
})
export class AppModule {}
