import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

export interface PresetCase {
  name: string;        // e.g. "lahistloantransactionhistory"
  rule_path: string;   // e.g. "rights_npa/lahistloantransactionhistory"
  tables: string[];    // source table names
}

export interface Preset {
  name: string;
  module: string;
  cases: PresetCase[];
}

export interface PresetTableEntry {
  table_name: string;
  rule_path: string;
}

@Injectable()
export class PresetService {
  private readonly logger = new Logger(PresetService.name);
  private readonly presetsDir: string;
  private readonly cache = new Map<string, Preset>();

  constructor(private readonly config: ConfigService) {
    this.presetsDir = this.config.get<string>('PRESETS_DIR') ?? './presets';
  }

  /**
   * Returns all available presets grouped by module → category → cases.
   * Used by GET /validation/presets to show users what case_name / sources values are valid.
   *
   * Example:
   * {
   *   "npa": {
   *     "rights": {
   *       "cases": [
   *         { "name": "lahistloantransactionhistory", "tables": ["conv$vinpahistory"] },
   *         { "name": "lahisthloantransactionhistoryh", "tables": ["conv$vinpahistory", ...] }
   *       ]
   *     }
   *   }
   * }
   */
  listPresets(): Record<string, Record<string, { cases: Array<{ name: string; tables: string[] }> }>> {
    const result: Record<string, Record<string, { cases: Array<{ name: string; tables: string[] }> }>> = {};

    if (!fs.existsSync(this.presetsDir)) {
      this.logger.warn(`Presets directory not found: ${this.presetsDir}`);
      return result;
    }

    const modules = fs
      .readdirSync(this.presetsDir)
      .filter((f) => fs.statSync(path.join(this.presetsDir, f)).isDirectory());

    for (const module of modules) {
      const moduleDir = path.join(this.presetsDir, module);
      const files = fs
        .readdirSync(moduleDir)
        .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));

      result[module] = {};

      for (const file of files) {
        const category = path.basename(file, path.extname(file));
        const preset = this.loadPreset(module, category);
        if (!preset) continue;

        result[module][category] = {
          cases: preset.cases.map((c) => ({ name: c.name, tables: c.tables })),
        };
      }
    }

    return result;
  }

  /**
   * Loads a preset by module and category.
   * Returns null if not found or parse error.
   * Results are cached after first load.
   */
  loadPreset(module: string, category: string): Preset | null {
    const cacheKey = `${module.toLowerCase()}::${category.toLowerCase()}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey)!;

    const filePath = path.join(
      this.presetsDir,
      module.toLowerCase(),
      `${category.toLowerCase()}.yaml`,
    );

    if (!fs.existsSync(filePath)) {
      this.logger.warn(`Preset not found: ${filePath}`);
      return null;
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const preset = yaml.load(raw) as Preset;
      if (!preset.cases || !Array.isArray(preset.cases)) {
        this.logger.warn(`Preset [${module}/${category}] has no cases array — skipping`);
        return null;
      }
      const totalTables = preset.cases.reduce((sum, c) => sum + c.tables.length, 0);
      this.cache.set(cacheKey, preset);
      this.logger.log(`Loaded preset [${module}/${category}] — ${preset.cases.length} case(s), ${totalTables} table(s) total`);
      return preset;
    } catch (err: any) {
      this.logger.error(`Failed to parse preset ${filePath}: ${err.message}`);
      return null;
    }
  }

  /**
   * Resolves all tables across every category for an entire module.
   * Used by POST /validation/run/preset/:module to run everything in one shot.
   *
   * @param module  e.g. "npa" — runs rights + eir + any future categories
   */
  resolveTablesForModule(module: string): PresetTableEntry[] {
    const moduleDir = path.join(this.presetsDir, module.toLowerCase());
    if (!fs.existsSync(moduleDir)) {
      this.logger.warn(`Module preset directory not found: ${moduleDir}`);
      return [];
    }

    const files = fs
      .readdirSync(moduleDir)
      .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));

    const result: PresetTableEntry[] = [];
    for (const file of files) {
      const category = path.basename(file, path.extname(file));
      const entries = this.resolveTablesForRun(module, category);
      result.push(...entries);
    }
    return result;
  }

  /**
   * Resolves which tables to run based on optional filters.
   *
   * @param module     e.g. "npa"
   * @param category   e.g. "rights"
   * @param caseName   optional — if provided, only run this case
   * @param sources    optional — if provided, only run these source tables (within matched cases)
   *
   * Returns array of { table_name, rule_path } ready to build a ValidationRequestDto.
   */
  resolveTablesForRun(
    module: string,
    category: string,
    caseName?: string,
    sources?: string[],
  ): PresetTableEntry[] {
    const preset = this.loadPreset(module, category);
    if (!preset) return [];

    const matchingCases = caseName
      ? preset.cases.filter((c) => c.name === caseName)
      : preset.cases;

    if (caseName && matchingCases.length === 0) {
      this.logger.warn(`Case "${caseName}" not found in preset [${module}/${category}]`);
    }

    const result: PresetTableEntry[] = [];
    for (const c of matchingCases) {
      const matchingTables = sources ? c.tables.filter((t) => sources.includes(t)) : c.tables;
      for (const tableName of matchingTables) {
        result.push({ table_name: tableName, rule_path: c.rule_path });
      }
    }

    return result;
  }
}
