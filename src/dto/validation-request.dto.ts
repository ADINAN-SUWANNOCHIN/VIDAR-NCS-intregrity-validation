import { IsString, IsOptional, IsArray, ValidateNested, IsNotEmpty } from 'class-validator';
import { Type } from 'class-transformer';

export class TableConfig {
  @IsString()
  @IsNotEmpty()
  tableName: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  defIds?: string[];
}

export class ValidationRequestDto {
  @IsOptional()
  @IsString()
  jobLabel?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TableConfig)
  tables: TableConfig[];
}
