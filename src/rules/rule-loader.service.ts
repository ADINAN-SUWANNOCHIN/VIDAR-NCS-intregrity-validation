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
  // Resolve the directory for a table's rules.
  // If rulePath is provided:  {rulesDir}/{rulePath}/
  // Fallback (legacy):        {rulesDir}/tables/{tableName}/
  // ----------------------------------------------------------------
  private resolveTableDir(tableName: string, rulePath?: string): string {
    if (rulePath) {
      // rule_path already uniquely identifies the case — no tableName subfolder needed
      return path.join(this.rulesDir, rulePath);
    }
    return path.join(this.rulesDir, 'tables', tableName);
  }

  // ----------------------------------------------------------------
  // Global Affect Codes
  // ----------------------------------------------------------------
  loadGlobalAffectCodes(): GlobalAffectCodes {
    if (this.globalAffectCodes) return this.globalAffectCodes;

    const filePath = path.join(this.rulesDir, 'global', 'affect_codes.json');
    if (!fs.existsSync(filePath)) {
      this.logger.warn(`affect_codes.json not found at ${filePath}, using empty set`);
      this.globalAffectCodes = { codes: [] };
      return this.globalAffectCodes;
    }

    const raw = fs.readFileSync(filePath, 'utf-8');
    this.globalAffectCodes = JSON.parse(raw) as GlobalAffectCodes;
    return this.globalAffectCodes;
  }

  // ----------------------------------------------------------------
  // Common Rule
  // rulePath: e.g. "rights_npa/lahistloantransactionhistory"
  // ----------------------------------------------------------------
  loadCommonRule(tableName: string, rulePath?: string): CommonRule | null {
    const cacheKey = `${rulePath ?? '__legacy__'}::${tableName}`;
    if (this.commonRuleCache.has(cacheKey)) {
      return this.commonRuleCache.get(cacheKey) ?? null;
    }

    const tableDir = this.resolveTableDir(tableName, rulePath);
    const filePath = path.join(tableDir, 'common.yaml');
    if (!fs.existsSync(filePath)) {
      this.logger.warn(`No common.yaml found for table: ${tableName} at ${filePath}`);
      return null;
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = yaml.load(raw) as CommonRule;
      this.commonRuleCache.set(cacheKey, parsed);
      return parsed;
    } catch (err) {
      this.logger.error(`Failed to parse common.yaml for ${tableName}: ${err.message}`);
      return null;
    }
  }

  // ----------------------------------------------------------------
  // Vali Rules (technical checks — layer between common and def)
  // Loads from {tableDir}/vali/ (table-specific) and rules/vali/ (global fallback).
  // Table-specific vali_id takes priority over global, same as def rules.
  // ----------------------------------------------------------------
  loadValiRules(tableName: string, valiIds?: string[], rulePath?: string): DefRule[] {
    const sortedIds = valiIds ? [...valiIds].sort() : ['*'];
    const cacheKey = `vali::${rulePath ?? '__legacy__'}::${tableName}::${sortedIds.join(',')}`;
    if (this.defRuleCache.has(cacheKey)) {
      return this.defRuleCache.get(cacheKey)!;
    }

    const rules: DefRule[] = [];

    // 1. Table-specific vali files
    const valiDir = path.join(this.resolveTableDir(tableName, rulePath), 'vali');
    if (fs.existsSync(valiDir)) {
      rules.push(...this.readDefYamls(valiDir, valiIds, `table:${tableName}`));
    }

    // 2. Global vali files — table-specific takes priority
    const globalValiDir = path.join(this.rulesDir, 'vali');
    if (fs.existsSync(globalValiDir)) {
      const loadedIds = new Set(rules.map((r) => r.def_id));
      const globalRules = this.readDefYamls(globalValiDir, valiIds, 'global-vali');
      for (const rule of globalRules) {
        if (!loadedIds.has(rule.def_id)) {
          rules.push(rule);
        }
      }
    }

    this.defRuleCache.set(cacheKey, rules);
    return rules;
  }

  // ----------------------------------------------------------------
  // Def Rules
  // ----------------------------------------------------------------
  loadDefRules(tableName: string, defIds?: string[], rulePath?: string): DefRule[] {
    const sortedIds = defIds ? [...defIds].sort() : ['*'];
    const cacheKey = `${rulePath ?? '__legacy__'}::${tableName}::${sortedIds.join(',')}`;
    if (this.defRuleCache.has(cacheKey)) {
      return this.defRuleCache.get(cacheKey)!;
    }

    const rules: DefRule[] = [];

    // 1. Table-specific defs
    const defDir = path.join(this.resolveTableDir(tableName, rulePath), 'def');
    if (fs.existsSync(defDir)) {
      rules.push(...this.readDefYamls(defDir, defIds, `table:${tableName}`));
    } else {
      this.logger.warn(`No def directory for table: ${tableName}`);
    }

    // 2. Global defs — table-specific takes priority
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
  // Check whether a rule directory exists for a table
  // ----------------------------------------------------------------
  hasRuleDirectory(tableName: string, rulePath?: string): boolean {
    return fs.existsSync(this.resolveTableDir(tableName, rulePath));
  }
}
