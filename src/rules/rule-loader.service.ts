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
      this.globalAffectCodes = { codes: [] }; // L4: cache so fs.existsSync is not repeated per table
      return this.globalAffectCodes;
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
  // Also merges global defs from rules/global/defs/ so a def defined once
  // is reusable across any table without copying the YAML.
  // ----------------------------------------------------------------
  loadDefRules(tableName: string, defIds?: string[]): DefRule[] {
    // M3: sort a copy of defIds so cache key is order-independent.
    // ['def02','def01'] and ['def01','def02'] refer to the same set — same result should be cached.
    const sortedIds = defIds ? [...defIds].sort() : ['*'];
    const cacheKey = `${tableName}::${sortedIds.join(',')}`;
    if (this.defRuleCache.has(cacheKey)) {
      return this.defRuleCache.get(cacheKey)!;
    }

    const rules: DefRule[] = [];

    // 1. Load table-specific defs
    const defDir = path.join(this.rulesDir, 'tables', tableName, 'def');
    if (fs.existsSync(defDir)) {
      rules.push(...this.readDefYamls(defDir, defIds, `table:${tableName}`));
    } else {
      this.logger.warn(`No def directory for table: ${tableName}`);
    }

    // 2. Merge global defs — only include those not already loaded (table-specific takes priority)
    const globalDefDir = path.join(this.rulesDir, 'global', 'defs');
    if (fs.existsSync(globalDefDir)) {
      const loadedIds = new Set(rules.map((r) => r.def_id));
      const globalRules = this.readDefYamls(globalDefDir, defIds, 'global');
      for (const rule of globalRules) {
        if (!loadedIds.has(rule.def_id)) {
          rules.push(rule);
        }
      }
    }

    this.defRuleCache.set(cacheKey, rules);
    return rules;
  }

  private readDefYamls(dir: string, defIds: string[] | undefined, context: string): DefRule[] {
    const rules: DefRule[] = [];
    const allFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));

    for (const file of allFiles) {
      const defId = path.basename(file, path.extname(file));
      if (defIds && !defIds.includes(defId)) continue;

      try {
        const raw = fs.readFileSync(path.join(dir, file), 'utf-8');
        const parsed = yaml.load(raw) as DefRule;
        parsed.def_id = defId;
        rules.push(parsed);
      } catch (err) {
        this.logger.error(`Failed to parse def ${file} (${context}): ${err.message}`);
      }
    }

    return rules;
  }

  // ----------------------------------------------------------------
  // ตรวจสอบว่า table มี rule directory หรือไม่
  // ----------------------------------------------------------------
  hasRuleDirectory(tableName: string): boolean {
    return fs.existsSync(path.join(this.rulesDir, 'tables', tableName));
  }

}
