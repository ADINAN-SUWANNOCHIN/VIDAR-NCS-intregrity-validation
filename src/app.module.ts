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

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
  ],
  controllers: [AppController, ValidationController],
  providers: [
    AppService,
    DatabaseService,
    RuleLoaderService,
    JobService,
    ReportService,
    WorkerPoolService,
    StrategyFactory,
    ValidationService,
  ],
})
export class AppModule {}
