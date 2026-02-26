import { IsString, IsOptional, IsArray, ValidateNested, IsNotEmpty } from 'class-validator';
import { Type } from 'class-transformer';

export class TableConfig {
  @IsString()
  @IsNotEmpty()
  table_name: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  def_list?: string[];
}

export class ValidationRequestDto {
  @IsOptional()
  @IsString()
  job_name?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TableConfig)
  tables: TableConfig[];
}
