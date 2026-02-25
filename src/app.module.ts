import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseService } from './database/database.service';
import { RuleLoaderService } from './rules/rule-loader.service';
import { JobService } from './job/job.service';
import { ReportService } from './reports/report.service';
import { StrategyFactory } from './strategies/strategy.factory';
import { WorkerPoolService } from './strategies/worker-pool.service';
import { ValidationService } from './validation/validation.service';
import { ValidationController } from './validation/validation.controller';
import { SchemaController } from './schema/schema.controller';
import { SchemaService } from './schema/schema.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
  ],
  controllers: [AppController, ValidationController, SchemaController],
  providers: [
    AppService,
    DatabaseService,
    RuleLoaderService,
    JobService,
    ReportService,
    WorkerPoolService,
    StrategyFactory,
    ValidationService,
    SchemaService,
  ],
})
export class AppModule {}
