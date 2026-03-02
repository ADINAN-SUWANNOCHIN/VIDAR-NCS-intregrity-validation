import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

interface PresetTable {
  table_name: string;
}

export interface Preset {
  name: string;
  module: string;
  description?: string;
  tables: PresetTable[];
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
   * Returns all available presets grouped by module.
   * Example: { npl: ['eir', 'tax', 'sbt', 'cit'], npa: ['eir', 'tax', 'sbt', 'cit'] }
   */
  listPresets(): Record<string, string[]> {
    const result: Record<string, string[]> = {};

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
      result[module] = files.map((f) => path.basename(f, path.extname(f)));
    }

    return result;
  }

  /**
   * Loads a preset by module and category name.
   * Returns null if the preset file does not exist.
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
      this.cache.set(cacheKey, preset);
      this.logger.log(`Loaded preset [${module}/${category}] — ${preset.tables.length} table(s)`);
      return preset;
    } catch (err: any) {
      this.logger.error(`Failed to parse preset ${filePath}: ${err.message}`);
      return null;
    }
  }
}
