import { Controller, Get, Module, Redirect } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseService } from './database/database.service';
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
  /** GET /health — Kubernetes liveness + readiness probe target. */
  @Get('health')
  health(): { status: string } {
    return { status: 'ok' };
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
