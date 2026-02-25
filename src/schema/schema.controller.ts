import { Controller, Post, Body, Res, HttpStatus } from '@nestjs/common';
import { IsString, IsNotEmpty, IsIn, IsOptional, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import type { Response } from 'express';
import { SchemaService } from './schema.service';
import type { TableType } from '../rules/rule.types';

export class AnalyzeSchemaDto {
  @IsString()
  @IsNotEmpty()
  oldTable: string;

  @IsString()
  @IsNotEmpty()
  newTable: string;

  @IsString()
  @IsIn(['MASTER', 'SPLIT', 'TRANSACTION', 'MULTIPLE', 'UNION', 'ASSOCIATE', 'HEADER'])
  tableType: TableType;

  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(10000)
  @Type(() => Number)
  sampleSize?: number;
}

@Controller('schema')
export class SchemaController {
  constructor(private readonly schemaService: SchemaService) {}

  /**
   * POST /schema/analyze
   *
   * Returns an Excel file as a binary download.
   * The workbook contains 5 sheets:
   *   1. Mapping Result   — all old columns with match details, color-coded
   *   2. Unmatched Old    — NO_MATCH columns
   *   3. Split Candidates — old numeric cols that may have split into 2+ new cols
   *   4. Summary          — counts, anchor key detection
   *   5. Draft YAML       — ready-to-copy common.yaml content
   *
   * Example body:
   * {
   *   "oldTable": "[ncs-conv-aging].dbo.conv$vinplhistory",
   *   "newTable": "[ncs-npl-aging].dbo.ln$lnhistloantransactionhistory",
   *   "tableType": "TRANSACTION",
   *   "sampleSize": 2000
   * }
   */
  @Post('analyze')
  async analyze(@Body() dto: AnalyzeSchemaDto, @Res() res: Response): Promise<void> {
    const result = await this.schemaService.analyze(dto);

    res.status(HttpStatus.OK);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"; filename*=UTF-8''${encodeURIComponent(result.filename)}`);
    res.setHeader('X-Summary-Total',       String(result.summary.totalOldCols));
    res.setHeader('X-Summary-Matched',     String(result.summary.matched));
    res.setHeader('X-Summary-Unmatched',   String(result.summary.unmatched));
    res.setHeader('X-Summary-ManualCheck', String(result.summary.manualCheck));
    res.send(result.excelBuffer);
  }
}
