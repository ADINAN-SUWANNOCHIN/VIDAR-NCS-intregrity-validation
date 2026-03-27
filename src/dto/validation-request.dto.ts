import { IsString, IsOptional, IsArray, ValidateNested, IsNotEmpty } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class TableConfig {
  @ApiProperty({
    description: 'Source table name (legacy DB) to validate',
    example: 'conv$vinpahistory',
  })
  @IsString()
  @IsNotEmpty()
  table_name: string;

  @ApiPropertyOptional({
    description: 'Override the rule path (module/case). Default: auto-resolved from presets.',
    example: 'rights_npa/lahistloantransactionhistory',
  })
  @IsOptional()
  @IsString()
  rule_path?: string;

  @ApiPropertyOptional({
    description:
      'Vali rules to run (from the vali/ folder). ' +
      'Omit = run all vali rules. ' +
      'Empty array [] = skip all vali rules.',
    example: ['vali001', 'vali002'],
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  vali_list?: string[];

  @ApiPropertyOptional({
    description:
      'Def rules to run (from the def/ folder). ' +
      'Omit = run all def rules. ' +
      'Empty array [] = skip all def rules.',
    example: ['def001', 'def002'],
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  def_list?: string[];
}

export class ValidationRequestDto {
  @ApiPropertyOptional({
    description: 'Label for this job (shown in job list and report header)',
    example: 'NPA_Rights_Full_Run',
  })
  @IsOptional()
  @IsString()
  job_name?: string;

  @ApiProperty({
    description: 'List of tables to validate',
    type: [TableConfig],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TableConfig)
  tables: TableConfig[];
}
