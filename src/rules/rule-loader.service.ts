import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { CommonRule, DefRule, GlobalAffectCodes } from './rule.types';

@Injectable()
export class RuleLoaderService {
  private readonly logger = new Logger(RuleLoaderService.name);
  private readonly rulesDir: string;

  // Cache
  private commonRuleCache = new Map<string, CommonRule>();
  private defRuleCache = new Map<string, DefRule[]>();
  private globalAffectCodes: GlobalAffectCodes | null = null;

  constructor(private readonly config: ConfigService) {
    this.rulesDir = this.config.get<string>('RULES_DIR') ?? './rules';
  }

  // ----------------------------------------------------------------
  // Global Affect Codes
  // ----------------------------------------------------------------
  loadGlobalAffectCodes(): GlobalAffectCodes {
    if (this.globalAffectCodes) return this.globalAffectCodes;

    const filePath = path.join(this.rulesDir, 'global', 'affect_codes.json');
    if (!fs.existsSync(filePath)) {
      this.logger.warn(`affect_codes.json not found at ${filePath}, using empty set`);
      return { codes: [] };
    }

    const raw = fs.readFileSync(filePath, 'utf-8');
    this.globalAffectCodes = JSON.parse(raw) as GlobalAffectCodes;
    return this.globalAffectCodes;
  }

  // ----------------------------------------------------------------
  // Common Rule (.ini)
  // ----------------------------------------------------------------
  loadCommonRule(tableName: string): CommonRule | null {
    if (this.commonRuleCache.has(tableName)) {
      return this.commonRuleCache.get(tableName) ?? null;
    }

    const filePath = path.join(this.rulesDir, 'tables', tableName, 'common.yaml');
    if (!fs.existsSync(filePath)) {
      this.logger.warn(`No common.yaml found for table: ${tableName} at ${filePath}`);
      return null;
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = yaml.load(raw) as CommonRule;
      this.commonRuleCache.set(tableName, parsed);
      return parsed;
    } catch (err) {
      this.logger.error(`Failed to parse common.yaml for ${tableName}: ${err.message}`);
      return null;
    }
  }

  // ----------------------------------------------------------------
  // Def Rules (.yaml) – โหลดทุก def ของ table หรือเฉพาะ defIds
  // ----------------------------------------------------------------
  loadDefRules(tableName: string, defIds?: string[]): DefRule[] {
    const cacheKey = `${tableName}::${(defIds ?? ['*']).join(',')}`;
    if (this.defRuleCache.has(cacheKey)) {
      return this.defRuleCache.get(cacheKey)!;
    }

    const defDir = path.join(this.rulesDir, 'tables', tableName, 'def');
    if (!fs.existsSync(defDir)) {
      this.logger.warn(`No def directory for table: ${tableName}`);
      return [];
    }

    const allFiles = fs.readdirSync(defDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));

    const rules: DefRule[] = [];
    for (const file of allFiles) {
      const defId = path.basename(file, path.extname(file)); // เช่น "def01"
      if (defIds && !defIds.includes(defId)) continue;

      try {
        const raw = fs.readFileSync(path.join(defDir, file), 'utf-8');
        const parsed = yaml.load(raw) as DefRule;
        parsed.def_id = defId;
        rules.push(parsed);
      } catch (err) {
        this.logger.error(`Failed to parse def ${file} for ${tableName}: ${err.message}`);
      }
    }

    this.defRuleCache.set(cacheKey, rules);
    return rules;
  }

  // ----------------------------------------------------------------
  // ตรวจสอบว่า table มี rule directory หรือไม่
  // ----------------------------------------------------------------
  hasRuleDirectory(tableName: string): boolean {
    return fs.existsSync(path.join(this.rulesDir, 'tables', tableName));
  }

}
