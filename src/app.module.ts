import { Controller, Get, Module, Redirect } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
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
  constructor(
    private readonly pg: PgCacheService,
    private readonly config: ConfigService,
  ) {}

  /** GET /health — Kubernetes liveness + readiness probe target. */
  @Get('health')
  health(): { status: string } {
    return { status: 'ok' };
  }

  /** GET /health/pg — diagnostic: tests PostgreSQL cache DB connectivity and write ability. */
  @Get('health/pg')
  async healthPg(): Promise<object> {
    const env = {
      CACHE_DB_HOST: this.config.get('CACHE_DB_HOST') ?? '(not set)',
      CACHE_DB_PORT: this.config.get('CACHE_DB_PORT') ?? '(not set)',
      CACHE_DB_USER: this.config.get('CACHE_DB_USER') ?? '(not set)',
      CACHE_DB_PASSWORD: this.config.get('CACHE_DB_PASSWORD') ? '(set)' : '(not set)',
      CACHE_DB_NAME: this.config.get('CACHE_DB_NAME') ?? '(not set)',
    };
    if (!this.pg.isAvailable) {
      return { connected: false, writable: false, env, error: 'Pool is null — connection failed at startup (wrong creds, network unreachable, or env vars missing)' };
    }
    try {
      await this.pg.createCacheTable('_hc_test', ['v']);
      await this.pg.batchInsert('_hc_test', [{ v: 'ok' }], ['v']);
      await this.pg.dropCacheTable('_hc_test');
      return { connected: true, writable: true, env };
    } catch (e: any) {
      return { connected: true, writable: false, env, error: e.message };
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
