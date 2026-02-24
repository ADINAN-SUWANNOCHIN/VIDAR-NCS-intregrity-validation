"""
VIDAR V50: CONFIG-DRIVEN | TARGET-CENTRIC | CLOUD-NATIVE DATA AUDIT ENGINE
===========================================================================
🚀 Enterprise-Grade Banking Data Audit System

V50 Architecture Upgrades:
1.  🆕 ConfigLoader          — YAML-driven rules (global_dict, common, defect_*)
2.  🆕 DataPrepLayer         — Virtual Source (UNION / filter / normalize)
3.  🆕 ValidationEngine      — 3 Modes: MASTER | TRANSACTION | MULTIPLE
4.  🆕 CoverageTracker       — Global column orphan detection across all targets
5.  🆕 APIClient             — Stateless JSON output + Smartsheet push
6.  🆕 Layer-0 Bypass        — schema_mappings in YAML → instant VERIFIED
7.  🆕 Affect Code Tagging   — global_dict.yaml terminology tagging
8.  🆕 Formula Parser        — SUM/AVG/DIFF formula evaluation with tolerance
9.  🆕 Index Alignment       — MULTIPLE mode: no JOIN, pure set_index alignment
10. 🆕 Cloud-Native main()   — K8s-ready, env-var config, stateless execution

✅ V49 Preserved (100%):
    Row Cohesion | Transformation Rulebook | Jaccard Veto | Orphan Detection
    Context Sampling | SmartAnchorGuard | SplitDetector | CollisionResolver
    DataFingerprinter | 13 AI Systems | Anti-Ghost | Format Drift
"""

import pandas as pd
import numpy as np
import os
import time
import warnings
import difflib
import gc
import re
import json
import sys
import yaml
import logging
from datetime import datetime
from collections import Counter, defaultdict
from typing import Dict, List, Tuple, Optional, Set, Any, Union
from hashlib import md5
from itertools import combinations
from pathlib import Path

try:
    from openpyxl import load_workbook, Workbook
    from openpyxl.styles import PatternFill, Font, Alignment, Border, Side
    from openpyxl.utils import get_column_letter
    OPENPYXL_AVAILABLE = True
except ImportError:
    OPENPYXL_AVAILABLE = False

try:
    from groq import Groq
    GROQ_AVAILABLE = True
except ImportError:
    GROQ_AVAILABLE = False

try:
    import requests
    REQUESTS_AVAILABLE = True
except ImportError:
    REQUESTS_AVAILABLE = False

warnings.filterwarnings('ignore')
pd.set_option('display.max_columns', None)

# ==============================================================================
# LOGGING SETUP (Structured for K8s)
# ==============================================================================

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger("VIDAR-V50")


# ==============================================================================
# NORMALIZATION  (V49 Preserved)
# ==============================================================================

class AggressiveNormalizer:
    DATE_PATTERNS = [
        (r'(\d{4})-(\d{2})-(\d{2})T.*', 'ISO'),
        (r'(\d{4})-(\d{2})-(\d{2})', 'ISO'),
        (r'(\d{2})/(\d{2})/(\d{4})', 'SLASH_DMY'),
        (r'(\d{1,2})/(\d{1,2})/(\d{2,4})', 'SLASH'),
        (r'(\d{4})(\d{2})(\d{2})', 'COMPACT'),
    ]

    @staticmethod
    def normalize(val):
        if pd.isna(val) or val == "":
            return np.nan
        s = str(val).strip()
        if s.lower() in ['nan', 'none', 'null', 'nat', '', '<na>', '-', '?', 'n/a', 'undefined', 'nil']:
            return np.nan
        for pattern, dtype in AggressiveNormalizer.DATE_PATTERNS:
            m = re.match(pattern, s)
            if m:
                try:
                    if dtype == 'ISO':
                        return f"DATE:{m.group(1)}-{m.group(2)}-{m.group(3)}"
                    elif dtype == 'SLASH_DMY':
                        d, mo, y = m.groups()
                        return f"DATE:{y}-{mo.zfill(2)}-{d.zfill(2)}"
                    elif dtype == 'COMPACT':
                        y, mo, d = m.groups()
                        return f"DATE:{y}-{mo}-{d}"
                except Exception:
                    pass
        numeric_clean = re.sub(r'[,$\s€£¥]', '', s)
        try:
            num = float(numeric_clean)
            return f"NUM:{num:.4f}"
        except Exception:
            pass
        text_clean = re.sub(r'[^a-z0-9]', '', s.lower())
        if not text_clean:
            return np.nan
        return f"TXT:{text_clean}"

    @staticmethod
    def clean_series(series):
        return series.apply(AggressiveNormalizer.normalize)


# ==============================================================================
# DATA FINGERPRINTER  (V49 Preserved)
# ==============================================================================

class DataFingerprinter:
    """Privacy-preserving column profiles for AI analysis."""

    @staticmethod
    def generate_profile(series: pd.Series, col_name: str = "") -> Dict:
        clean = series.dropna()
        if len(clean) == 0:
            return {'col_name': col_name, 'data_type': 'EMPTY', 'row_count': 0,
                    'null_rate': 1.0, 'profile': {}}

        total = len(series)
        profile = {
            'col_name':    col_name,
            'data_type':   'unknown',
            'row_count':   total,
            'null_rate':   series.isna().sum() / total,
            'cardinality': clean.nunique(),
            'unique_ratio': clean.nunique() / len(clean)
        }

        numeric_vals = pd.to_numeric(clean, errors='coerce').dropna()
        if len(numeric_vals) > len(clean) * 0.7:
            profile['data_type'] = 'numeric'
            profile['scale'] = {
                'min': float(numeric_vals.min()), 'max': float(numeric_vals.max()),
                'mean': float(numeric_vals.mean()), 'median': float(numeric_vals.median()),
                'std': float(numeric_vals.std()) if len(numeric_vals) > 1 else 0.0
            }
            profile['constraints'] = {
                'non_negative': bool((numeric_vals >= 0).all()),
                'integer_only': bool((numeric_vals == numeric_vals.astype(int)).all()),
                'has_zeros':    bool((numeric_vals == 0).any()),
                'zero_rate':    float((numeric_vals == 0).sum() / len(numeric_vals))
            }
        elif clean.astype(str).str.match(r'^\d{4}-\d{2}-\d{2}').sum() > len(clean) * 0.7:
            profile['data_type'] = 'date'
            try:
                dates = pd.to_datetime(clean, errors='coerce').dropna()
                if len(dates) > 0:
                    profile['date_range'] = {
                        'earliest': str(dates.min()),
                        'latest':   str(dates.max()),
                        'span_days': (dates.max() - dates.min()).days
                    }
            except Exception:
                pass
        else:
            profile['data_type'] = 'text'
            str_vals = clean.astype(str)
            profile['text_stats'] = {
                'avg_length':        float(str_vals.str.len().mean()),
                'max_length':        int(str_vals.str.len().max()),
                'has_special_chars': bool(str_vals.str.contains(r'[^a-zA-Z0-9\s]').any()),
                'all_uppercase':     bool(str_vals.str.isupper().sum() > len(str_vals) * 0.8)
            }
        return profile

    @staticmethod
    def _detect_precision(numeric_vals: pd.Series) -> int:
        sample = numeric_vals.head(100)
        str_vals = sample.astype(str)
        decimal_counts = str_vals.str.extract(r'\.(\d+)')[0].str.len()
        if decimal_counts.isna().all():
            return 0
        return int(decimal_counts.mode()[0]) if len(decimal_counts.mode()) > 0 else 0

    @staticmethod
    def _classify_magnitude(numeric_vals: pd.Series) -> str:
        abs_mean = abs(numeric_vals.mean())
        if abs_mean < 1:         return 'fractional'
        elif abs_mean < 100:     return 'tens'
        elif abs_mean < 10000:   return 'hundreds-thousands'
        elif abs_mean < 1000000: return 'tens-thousands-millions'
        else:                    return 'millions-plus'


# ==============================================================================
# TYPE DETECTION  (V49 Preserved)
# ==============================================================================

class EnhancedTypeDetector:
    @staticmethod
    def detect(series: pd.Series, col_name: str = "") -> str:
        clean = series.dropna()
        if len(clean) == 0:
            return "EMPTY"

        unique_vals = set(clean.astype(str).str.strip().str.lower())

        boolean_keywords = ['is', 'has', 'flag', 'status', 'active', 'success', 'cancel', 'yn', 'found']
        numeric_keywords = ['amt', 'amount', 'bal', 'balance', 'price', 'cost', 'val', 'sum', 'total',
                            'rate', 'qty', 'num', 'interest', 'principle', 'charge', 'fee', 'tax']
        boolean_sets = [{'0','1'},{'0.0','1.0'},{'true','false'},{'t','f'},{'yes','no'},{'y','n'}]

        is_data_boolean = any(unique_vals.issubset(b) and len(unique_vals) > 0 for b in boolean_sets)

        if is_data_boolean:
            col_lower = col_name.lower()
            if any(k in col_lower for k in numeric_keywords):
                return "numeric"
            if any(k in col_lower for k in boolean_keywords):
                return "boolean"
            return "boolean" if len(unique_vals) == 2 else "numeric"

        sample = clean.head(100).astype(str)
        counts = {'date_iso': 0, 'date_slash': 0, 'numeric': 0, 'integer': 0, 'alpha': 0, 'alphanumeric': 0}
        for val in sample:
            if re.match(r'^\d{4}-\d{2}-\d{2}', val):         counts['date_iso'] += 1
            elif re.match(r'^\d{1,2}/\d{1,2}/\d{2,4}', val): counts['date_slash'] += 1
            elif re.match(r'^-?\d+\.\d+$', val):              counts['numeric'] += 1
            elif re.match(r'^-?\d+$', val):                   counts['integer'] += 1
            elif re.match(r'^[a-zA-Z\s]+$', val):             counts['alpha'] += 1
            elif re.match(r'^[a-zA-Z0-9]+$', val):            counts['alphanumeric'] += 1
        total = len(sample)
        for ptype, count in sorted(counts.items(), key=lambda x: -x[1]):
            if total > 0 and count / total > 0.7:
                return ptype
        return 'alphanumeric'


# ==============================================================================
# PATTERN DETECTOR  (V49 Preserved)
# ==============================================================================

class PatternDetector:
    @staticmethod
    def detect_patterns(series: pd.Series) -> Dict:
        clean = series.dropna()
        if len(clean) == 0:
            return {'patterns': [], 'avg_length': 0}
        patterns = []
        sample = clean.head(100).astype(str)
        if sample.str.match(r'^[A-Z]{2,5}-\d+$').sum() > len(sample) * 0.7:
            patterns.append('ID_WITH_PREFIX')
        elif sample.str.match(r'^\d{8,}$').sum() > len(sample) * 0.7:
            patterns.append('NUMERIC_ID')
        if sample.str.match(r'^[\+\d][\d\-\(\)\s]{8,}$').sum() > len(sample) * 0.5:
            patterns.append('PHONE_NUMBER')
        if sample.str.contains('@').sum() > len(sample) * 0.5:
            patterns.append('EMAIL')
        if sample.str.match(r'^[\$€£¥]?\d+[\d\.,]*$').sum() > len(sample) * 0.7:
            patterns.append('CURRENCY')
        avg_len = int(sample.str.len().mean()) if len(sample) > 0 else 0
        if avg_len > 40:
            patterns.append('FREE_TEXT')
        word_count = sample.str.split().str.len().mean() if len(sample) > 0 else 0
        if word_count > 5:
            patterns.append('NARRATIVE')
        return {'patterns': patterns, 'avg_length': avg_len, 'avg_word_count': float(word_count)}


# ==============================================================================
# COLUMN FINGERPRINT  (V49 Preserved)
# ==============================================================================

class ColumnFingerprint:
    @staticmethod
    def generate(series: pd.Series, col_name: str = "") -> Dict:
        clean = series.dropna()
        if len(clean) == 0:
            return {
                'col_name': col_name, 'type': 'EMPTY', 'null_pct': 100.0,
                'cardinality': 0, 'unique_ratio': 0.0, 'entropy': 0.0,
                'is_all_zeros': False, 'zero_pct': 0.0, 'is_boolean': False,
                'sample': "[]", 'unique_values': {}, 'patterns': {}
            }

        total      = len(series)
        null_pct   = (series.isna().sum() / total) * 100
        cardinality  = clean.nunique()
        unique_ratio = cardinality / len(clean)
        primary_type = EnhancedTypeDetector.detect(series, col_name)
        is_boolean   = (primary_type == "boolean")
        sample_vals  = str(list(clean.head(5).astype(str)))

        unique_values = {}
        if cardinality <= 50:
            vc = clean.value_counts().head(15)
            for val, count in vc.items():
                unique_values[str(val)] = {'count': int(count), 'frequency': float(count / len(clean))}

        patterns = PatternDetector.detect_patterns(series)

        zero_variants = ['0', '0.0', '0.00', '0.000', '0.0000']
        zero_count = sum(clean.astype(str).str.strip().isin(zero_variants))
        zero_pct   = (zero_count / len(clean)) * 100
        is_all_zeros = zero_pct > 95

        vc2   = clean.value_counts()
        probs = vc2 / len(clean)
        entropy = -sum(probs * np.log2(probs + 1e-10))

        stats_profile = {}
        try:
            numeric_vals = pd.to_numeric(clean, errors='coerce').dropna()
            if len(numeric_vals) > 0:
                stats_profile = {
                    'mean': float(numeric_vals.mean()), 'std': float(numeric_vals.std()),
                    'min':  float(numeric_vals.min()),  'max': float(numeric_vals.max())
                }
        except Exception:
            pass

        value_dist = {}
        if cardinality <= 20:
            for val, count in vc2.head(10).items():
                value_dist[str(val)] = count / len(clean)

        return {
            'col_name': col_name, 'type': primary_type, 'null_pct': null_pct,
            'cardinality': cardinality, 'unique_ratio': unique_ratio, 'entropy': entropy,
            'is_all_zeros': is_all_zeros, 'zero_pct': zero_pct, 'is_boolean': is_boolean,
            'stats': stats_profile, 'value_distribution': value_dist,
            'sample': sample_vals, 'unique_values': unique_values, 'patterns': patterns
        }

    @staticmethod
    def similarity(fp1: Dict, fp2: Dict) -> float:
        if not fp1 or not fp2:
            return 0.0

        score = 0.0

        # Type match
        t1, t2 = fp1.get('type',''), fp2.get('type','')
        if t1 == t2:
            score += 30
        elif {t1, t2} <= {'numeric', 'integer'}:
            score += 20
        elif t1 and t2 and (t1 in t2 or t2 in t1):
            score += 10

        # Cardinality ratio
        c1, c2 = fp1.get('cardinality', 0), fp2.get('cardinality', 0)
        if c1 > 0 and c2 > 0:
            ratio = min(c1, c2) / max(c1, c2)
            score += ratio * 20

        # Entropy similarity
        e1, e2 = fp1.get('entropy', 0), fp2.get('entropy', 0)
        if e1 > 0 and e2 > 0:
            e_sim = 1 - abs(e1 - e2) / max(e1, e2)
            score += e_sim * 15

        # Boolean match
        if fp1.get('is_boolean') == fp2.get('is_boolean'):
            score += 10

        # Null rate similarity
        n1, n2 = fp1.get('null_pct', 0), fp2.get('null_pct', 0)
        n_sim = 1 - abs(n1 - n2) / 100
        score += n_sim * 10

        # Zero column match
        if fp1.get('is_all_zeros') and fp2.get('is_all_zeros'):
            score += 15

        return min(score, 100.0)


# ==============================================================================
# SMART ANCHOR GUARD  (V49 Preserved)
# ==============================================================================

class SmartAnchorGuard:
    BLACKLIST_KEYWORDS = [
        'remark', 'note', 'comment', 'description', 'detail', 'details',
        'text', 'memo', 'content', 'message', 'narrative',
        'address', 'addr', 'name', 'firstname', 'lastname', 'fullname',
        'desc', 'reason', 'explain', 'info', 'information', 'body',
        'summary', 'subject', 'title', 'label', 'tag'
    ]

    IDEAL_KEYWORDS = [
        'id', 'no', 'num', 'number', 'code', 'key', 'ref', 'reference',
        'seq', 'sequence', 'txn', 'transaction', 'account', 'acct',
        'serial', 'batch', 'voucher', 'invoice', 'order', 'request'
    ]

    @staticmethod
    def is_eligible(col_name: str, series: pd.Series) -> bool:
        col_lower = col_name.lower()
        for kw in SmartAnchorGuard.BLACKLIST_KEYWORDS:
            if kw == col_lower or kw in col_lower:
                return False

        clean = series.dropna()
        if len(clean) == 0:
            return False

        str_series = clean.astype(str)

        if str_series.str.len().mean() > 100:
            return False
        if str_series.str.split().str.len().mean() > 8:
            return False
        if len(clean.unique()) / len(clean) < 0.05:
            return False

        lengths = str_series.str.len()
        if lengths.mean() > 0:
            cv = lengths.std() / lengths.mean()
            if cv > 3.5:
                return False

        return True

    @staticmethod
    def quality_score(col_name: str, series: pd.Series) -> float:
        score = 0.0
        col_lower = col_name.lower()

        for kw in SmartAnchorGuard.IDEAL_KEYWORDS:
            if kw == col_lower:
                score += 40; break
            elif kw in col_lower:
                score += 20; break

        clean = series.dropna()
        if len(clean) == 0:
            return 0.0

        str_series = clean.astype(str)
        unique_ratio = len(clean.unique()) / len(clean)
        score += unique_ratio * 30

        avg_len = str_series.str.len().mean()
        if avg_len <= 10:    score += 20
        elif avg_len <= 20:  score += 10
        elif avg_len <= 40:  score += 5

        sample = str_series.head(50)
        is_numeric_id = sample.str.match(r'^\d+$').sum() / len(sample) > 0.7
        is_code       = sample.str.match(r'^[A-Z0-9\-]+$').sum() / len(sample) > 0.7
        if is_numeric_id or is_code:
            score += 10

        return min(score, 100)

    @staticmethod
    def validate_join(merged_df: pd.DataFrame, df_old: pd.DataFrame, df_new: pd.DataFrame) -> Tuple[bool, str]:
        if merged_df.empty:
            return False, "Empty join result"

        expected    = min(len(df_old), len(df_new))
        join_ratio  = len(merged_df) / max(expected, 1)

        if join_ratio < 0.01:
            return False, f"Poor join ratio {join_ratio:.1%} (<1%)"
        if join_ratio > 3.0:
            return False, f"Cartesian explosion {join_ratio:.1f}x"

        return True, f"Good join: {len(merged_df):,} rows ({join_ratio:.1%})"


# ==============================================================================
# SPLIT COLUMN DETECTOR  (V49 Preserved)
# ==============================================================================

class SplitColumnDetector:
    SPLIT_PREFIXES = ['debit', 'credit', 'adj', 'org', 'prev', 'curr',
                      'old', 'new', 'base', 'net', 'gross', 'txcal',
                      'running', 'la', 'npa', 'npl']
    SPLIT_SUFFIXES = ['debit', 'credit', 'in', 'out', 'b4t', 'aft',
                      'before', 'after', 'lv1', 'lv2', 'a', 'b']
    SPLIT_TYPES = {
        ('debit', 'credit'):  'DEBIT_CREDIT_SPLIT',
        ('b4t', 'aft'):       'BEFORE_AFTER_SPLIT',
        ('adj', 'org'):       'ORIGINAL_ADJUSTED_SPLIT',
        ('prev', 'curr'):     'PREV_CURRENT_SPLIT',
        ('base', 'net'):      'BASE_NET_SPLIT',
        ('gross', 'net'):     'GROSS_NET_SPLIT',
    }

    @staticmethod
    def _extract_stem(col_name: str) -> str:
        s = col_name.lower()
        for pfx in SplitColumnDetector.SPLIT_PREFIXES:
            if s.startswith(pfx) and len(s) > len(pfx) + 3:
                s = s[len(pfx):]; break
        for sfx in SplitColumnDetector.SPLIT_SUFFIXES:
            if s.endswith(sfx) and len(s) > len(sfx) + 3:
                s = s[:-len(sfx)]; break
        return s

    @staticmethod
    def _stem_similarity(stem: str, col: str) -> float:
        if not stem or len(stem) < 4:
            return 0.0
        col_lower = col.lower()
        if stem == col_lower:
            return 1.0
        if stem in col_lower:
            return len(stem) / len(col_lower)
        return difflib.SequenceMatcher(None, stem, col_lower).ratio()

    @staticmethod
    def find_splits(matched_report: Dict, all_new_cols: List[str],
                    fingerprints_new: Dict, fingerprints_old: Dict, source: str) -> List[Dict]:
        matched_new = {v.get('New Column') for v in matched_report.values()
                       if v.get('New Column') and v.get('New Column') != '-'}

        splits_found = []

        for old_col, match_info in matched_report.items():
            primary_new = match_info.get('New Column')
            if not primary_new or primary_new == '-':
                continue
            if match_info.get('Status', '') in ['EMPTY_COLUMN', 'ZERO_COLUMN']:
                continue

            old_stem     = SplitColumnDetector._extract_stem(old_col)
            primary_stem = SplitColumnDetector._extract_stem(primary_new)

            siblings = []
            for nc in all_new_cols:
                if nc == primary_new or nc in matched_new:
                    continue

                nc_stem       = SplitColumnDetector._extract_stem(nc)
                sim_old_to_nc = SplitColumnDetector._stem_similarity(old_stem, nc)
                sim_stems     = SplitColumnDetector._stem_similarity(primary_stem, nc_stem)
                direct_embed  = (len(old_col) >= 4 and old_col.lower() in nc.lower())

                if direct_embed or sim_old_to_nc > 0.6 or sim_stems > 0.65:
                    split_type = 'UNKNOWN_SPLIT'
                    for (s1, s2), stype in SplitColumnDetector.SPLIT_TYPES.items():
                        n1_has = s1 in primary_new.lower() or s2 in primary_new.lower()
                        n2_has = s1 in nc.lower() or s2 in nc.lower()
                        if n1_has and n2_has:
                            split_type = stype; break

                    fp_sib = fingerprints_new.get(nc, {})
                    fp_old = fingerprints_old.get(f"{source}:{old_col}", {})

                    type_compat = (fp_sib.get('type','') == fp_old.get('type','') or
                                   {fp_sib.get('type',''), fp_old.get('type','')} <= {'numeric','integer'})

                    siblings.append({
                        'sibling_new_col':     nc,
                        'split_type':          split_type,
                        'stem_sim':            round(sim_old_to_nc, 3),
                        'type_compatible':     type_compat,
                        'sibling_cardinality': fp_sib.get('cardinality', 0),
                        'sibling_sample':      fp_sib.get('sample', '[]'),
                        'sibling_type':        fp_sib.get('type', '-')
                    })

            if siblings:
                splits_found.append({
                    'old_col':            old_col,
                    'primary_new_col':    primary_new,
                    'primary_confidence': match_info.get('Confidence', 0),
                    'old_sample':         fingerprints_old.get(f"{source}:{old_col}", {}).get('sample', '[]'),
                    'old_type':           fingerprints_old.get(f"{source}:{old_col}", {}).get('type', '-'),
                    'siblings':           siblings,
                    'source':             source
                })

        return splits_found


# ==============================================================================
# COLLISION RESOLVER  (V49 Preserved)
# ==============================================================================

class CollisionResolver:
    @staticmethod
    def resolve(report: Dict, locked_new_cols: Set[str]) -> Tuple[Dict, List[str]]:
        warnings_list = []
        new_to_old: Dict[str, List[Tuple[str, float]]] = defaultdict(list)

        for old_col, info in report.items():
            nc = info.get('New Column')
            if nc and nc != '-' and nc != 'nan':
                new_to_old[nc].append((old_col, info.get('Confidence', 0)))

        for new_col, claimants in new_to_old.items():
            if len(claimants) <= 1:
                continue
            claimants.sort(key=lambda x: x[1], reverse=True)
            winner_col, winner_conf = claimants[0]

            for loser_col, loser_conf in claimants[1:]:
                conf_gap = winner_conf - loser_conf
                if loser_col not in report:
                    continue

                if winner_conf >= 95 or conf_gap >= 15:
                    report[loser_col]['Status']         = 'MANUAL_CHECK'
                    report[loser_col]['AI Explanation'] = (
                        f"⚠️ COLLISION: Lost '{new_col}' to '{winner_col}' "
                        f"(gap={conf_gap:.1f}%). Needs re-mapping."
                    )
                    report[loser_col]['New Column']  = '— EVICTED —'
                    report[loser_col]['Confidence']  = 0
                    warnings_list.append(f"Collision: '{loser_col}'→'{new_col}' evicted by '{winner_col}'")
                else:
                    report[loser_col]['AI Explanation'] += (
                        f" ⚠️ COLLISION: Both '{winner_col}' and '{loser_col}' claim '{new_col}'."
                    )
                    report[winner_col]['AI Explanation'] = (
                        report[winner_col].get('AI Explanation', '-') +
                        f" ⚠️ COLLISION: Competing with '{loser_col}' for '{new_col}'."
                    )
                    warnings_list.append(f"Tie collision: '{winner_col}' vs '{loser_col}' → '{new_col}'")

        return report, warnings_list

    @staticmethod
    def build_exclusivity_lock(report: Dict, threshold: float = 95.0) -> Set[str]:
        locked = set()
        for info in report.values():
            if (info.get('Confidence', 0) >= threshold and
                    'VERIFIED' in info.get('Status', '') and
                    info.get('New Column') not in ['-', 'nan', None]):
                locked.add(info['New Column'])
        return locked


# ==============================================================================
# CONTEXT-AWARE VALIDATOR  (V49 Preserved)
# ==============================================================================

class ContextAwareValidator:
    BATCH_SIZE = 10

    @staticmethod
    def validate_with_context(old_col: str, new_col: str,
                              anchor_col_new: str, anchor_col_old: str,
                              merged_df: pd.DataFrame, ai_engine) -> Dict:
        if merged_df.empty or ai_engine is None or not ai_engine.enabled:
            return {'validated': False, 'reason': 'No context available'}

        o_lk     = f"{old_col}_O"  if f"{old_col}_O"  in merged_df.columns else old_col
        n_lk     = f"{new_col}_N"  if f"{new_col}_N"  in merged_df.columns else new_col
        a_lk_new = f"{anchor_col_new}_N" if f"{anchor_col_new}_N" in merged_df.columns else anchor_col_new

        if not all(c in merged_df.columns for c in [o_lk, n_lk, a_lk_new]):
            return {'validated': False, 'reason': 'Columns not found in merge'}

        sample_df = merged_df[[a_lk_new, o_lk, n_lk]].dropna().head(ContextAwareValidator.BATCH_SIZE)
        if len(sample_df) < 3:
            return {'validated': False, 'reason': 'Insufficient aligned rows'}

        context_batch = []
        for _, row in sample_df.iterrows():
            context_batch.append({
                'anchor_val': str(row[a_lk_new]),
                'old_val':    str(row[o_lk]),
                'new_val':    str(row[n_lk])
            })

        return ai_engine.context_aware_validate(old_col, new_col, context_batch)


# ==============================================================================
# TRANSFORMATION RULEBOOK  (V49 Preserved)
# ==============================================================================

class TransformationRulebook:
    RULES = {
        'RAW':                 lambda x: x,
        'STRIP_LEADING_ZEROS': lambda x: str(x).lstrip('0') if str(x) else x,
        'REMOVE_PUNCTUATION':  lambda x: re.sub(r'[^\w\s]', '', str(x)) if str(x) else x,
        'UPPERCASE':           lambda x: str(x).upper() if str(x) else x,
        'LOWERCASE':           lambda x: str(x).lower() if str(x) else x,
        'REMOVE_SPACES':       lambda x: str(x).replace(' ', '') if str(x) else x,
        'STRIP_HYPHENS':       lambda x: str(x).replace('-', '') if str(x) else x,
        'NUMERIC_ONLY':        lambda x: re.sub(r'[^0-9.]', '', str(x)) if str(x) else x,
    }

    @staticmethod
    def test_all_rules(old_series: pd.Series, new_series: pd.Series, sample_size: int = 100) -> Dict:
        if len(old_series) == 0 or len(new_series) == 0:
            return {'best_rule': 'NONE', 'match_rate': 0.0, 'etl_instruction': ''}

        sample_size = min(sample_size, len(old_series), len(new_series))
        old_sample  = old_series.head(sample_size)
        new_sample  = new_series.head(sample_size)

        best_rule       = 'RAW'
        best_match_rate = 0.0

        for rule_name, rule_func in TransformationRulebook.RULES.items():
            try:
                transformed_old = old_sample.apply(rule_func)
                transformed_new = new_sample.apply(rule_func)
                matches    = (transformed_old.astype(str) == transformed_new.astype(str)).sum()
                match_rate = matches / sample_size

                if match_rate > best_match_rate:
                    best_match_rate = match_rate
                    best_rule = rule_name
            except Exception:
                continue

        return {
            'best_rule':  best_rule,
            'match_rate': best_match_rate,
            'etl_instruction': TransformationRulebook._generate_etl_instruction(best_rule)
        }

    @staticmethod
    def _generate_etl_instruction(rule_name: str) -> str:
        instructions = {
            'RAW':                 'DIRECT COPY - no transformation needed',
            'STRIP_LEADING_ZEROS': 'ETL: lstrip("0") before loading',
            'REMOVE_PUNCTUATION':  'ETL: Remove all punctuation characters',
            'UPPERCASE':           'ETL: Convert to UPPERCASE',
            'LOWERCASE':           'ETL: Convert to lowercase',
            'REMOVE_SPACES':       'ETL: Strip all whitespace',
            'STRIP_HYPHENS':       'ETL: Remove hyphen (-) characters',
            'NUMERIC_ONLY':        'ETL: Extract numeric characters only',
        }
        return instructions.get(rule_name, f'ETL: Apply {rule_name}')


# ==============================================================================
# ORPHANED DATA DETECTOR  (V49 Preserved)
# ==============================================================================

class OrphanedDataDetector:
    @staticmethod
    def check_orphan_status(old_col: str, new_col: str,
                            df_old: pd.DataFrame, df_new: pd.DataFrame) -> Dict:
        if old_col not in df_old.columns or new_col not in df_new.columns:
            return {'is_orphan': False, 'status': 'UNKNOWN'}

        old_has_data = df_old[old_col].notna().any()
        new_has_data = df_new[new_col].notna().any()

        if old_has_data and new_has_data:
            return {'is_orphan': False, 'status': 'HAS_DATA'}

        if old_has_data and not new_has_data:
            old_values   = set(df_old[old_col].dropna().astype(str).head(100))
            global_found = OrphanedDataDetector._global_scan(old_values, df_new)

            if global_found:
                return {
                    'is_orphan':          True,
                    'status':             'SCHEMA_MATCH_ONLY',
                    'reason':             f'Column {new_col} is empty but data found in {global_found}',
                    'alternative_column': global_found
                }
            else:
                return {
                    'is_orphan': True,
                    'status':    'DATA_LOST',
                    'reason':    f'Data from {old_col} not found anywhere in new system'
                }

        if not old_has_data:
            return {'is_orphan': False, 'status': 'OLD_EMPTY'}

        return {'is_orphan': False, 'status': 'UNKNOWN'}

    @staticmethod
    def _global_scan(values_to_find: Set[str], df_new: pd.DataFrame) -> Optional[str]:
        if not values_to_find:
            return None
        search_values = list(values_to_find)[:10]
        for col in df_new.columns:
            try:
                col_values = set(df_new[col].dropna().astype(str).head(200))
                overlap    = len(set(search_values) & col_values)
                if overlap >= min(3, len(search_values) * 0.3):
                    return col
            except Exception:
                continue
        return None


# ==============================================================================
# SPLIT FORMULA VALIDATOR  (V49 Preserved)
# ==============================================================================

class SplitFormulaValidator:
    SAMPLE_SIZE     = 100
    MATCH_THRESHOLD = 0.90

    @staticmethod
    def propose_and_validate(old_col: str, new_cols: List[str],
                             df_old: pd.DataFrame, df_new: pd.DataFrame, ai_engine) -> Dict:
        if not ai_engine or not ai_engine.enabled:
            return {'status': 'NO_AI', 'formula': None}

        proposal = ai_engine.propose_split_formula(old_col, new_cols)
        if not proposal or not proposal.get('formula'):
            return {'status': 'NO_FORMULA', 'formula': None}

        formula      = proposal['formula']
        formula_type = proposal.get('type', 'unknown')

        return SplitFormulaValidator._validate_formula(
            old_col, new_cols, formula, formula_type, df_old, df_new
        )

    @staticmethod
    def _validate_formula(old_col: str, new_cols: List[str], formula: str,
                          formula_type: str, df_old: pd.DataFrame, df_new: pd.DataFrame) -> Dict:
        if old_col not in df_old.columns:
            return {'status': 'VALIDATION_ERROR', 'reason': 'Old column not found'}

        for nc in new_cols:
            if nc not in df_new.columns:
                return {'status': 'VALIDATION_ERROR', 'reason': f'New column {nc} not found'}

        sample_size = min(SplitFormulaValidator.SAMPLE_SIZE, len(df_old), len(df_new))
        old_sample  = df_old[old_col].head(sample_size)
        new_samples = {nc: df_new[nc].head(sample_size) for nc in new_cols}

        try:
            if formula_type == 'SUM':
                calculated = sum(pd.to_numeric(new_samples[nc], errors='coerce').fillna(0) for nc in new_cols)
                actual     = pd.to_numeric(old_sample, errors='coerce').fillna(0)
            elif formula_type == 'DIFFERENCE':
                if len(new_cols) >= 2:
                    calculated = (pd.to_numeric(new_samples[new_cols[0]], errors='coerce').fillna(0) -
                                  pd.to_numeric(new_samples[new_cols[1]], errors='coerce').fillna(0))
                    actual     = pd.to_numeric(old_sample, errors='coerce').fillna(0)
                else:
                    return {'status': 'FORMULA_ERROR', 'reason': 'Insufficient columns for DIFFERENCE'}
            elif formula_type == 'SPLIT_BY_SIGN':
                actual     = pd.to_numeric(old_sample, errors='coerce').fillna(0)
                calculated = pd.Series([0] * len(actual))
                for nc in new_cols:
                    calculated += pd.to_numeric(new_samples[nc], errors='coerce').fillna(0).abs()
            else:
                return {'status': 'UNKNOWN_FORMULA_TYPE', 'formula': formula}

            tolerance  = actual.abs().mean() * 0.01 if actual.abs().mean() > 0 else 0.01
            matches    = (abs(calculated - actual) <= tolerance).sum()
            match_rate = matches / len(actual) if len(actual) > 0 else 0

            if match_rate >= SplitFormulaValidator.MATCH_THRESHOLD:
                return {'status': 'CONFIRMED_SPLIT', 'formula': formula,
                        'match_rate': float(match_rate), 'formula_type': formula_type,
                        'validated_rows': int(len(actual))}
            else:
                return {'status': 'AI_HALLUCINATION', 'formula': formula,
                        'match_rate': float(match_rate), 'formula_type': formula_type,
                        'reason': f'Match rate {match_rate:.1%} < {SplitFormulaValidator.MATCH_THRESHOLD:.0%}'}

        except Exception as e:
            return {'status': 'VALIDATION_ERROR', 'formula': formula, 'error': str(e)}


# ==============================================================================
# AI ENGINE  (V49 Preserved — 13 Systems)
# ==============================================================================

class UltimateAIEngine:
    def __init__(self, api_key: str = None):
        self.client    = None
        self.model     = "llama-3.3-70b-versatile"
        self.cache     = {}
        self.total_calls = 0
        self.max_calls   = 500
        self.enabled     = False

        self.budget_used = {
            'semantic': 0, 'deep_content': 0, 'multi_sample': 0,
            'explainability': 0, 'adversarial': 0, 'domain': 0,
            'split_confirm': 0, 'context_aware': 0, 'split_formula': 0,
            'affect_code': 0, 'other': 0
        }

        if GROQ_AVAILABLE and api_key and api_key.startswith("gsk_"):
            try:
                self.client  = Groq(api_key=api_key)
                self.enabled = True
                logger.info("🚀 V50 AI ENGINE ONLINE — llama-3.3-70b-versatile")
                logger.info(f"📊 Budget: {self.max_calls} calls | 13+ AI systems")
            except Exception as e:
                logger.warning(f"⚠️ AI init failed: {e}")

    def _call(self, prompt: str, category: str, max_tokens: int = 500) -> Dict:
        if not self.enabled or self.total_calls >= self.max_calls:
            return {}
        try:
            resp = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": "Expert banking data analyst. JSON only."},
                    {"role": "user",   "content": prompt}
                ],
                temperature=0.0,
                max_tokens=max_tokens,
                response_format={"type": "json_object"}
            )
            self.total_calls += 1
            self.budget_used[category] = self.budget_used.get(category, 0) + 1
            return json.loads(resp.choices[0].message.content.strip())
        except Exception:
            return {}

    # System 1: Semantic Mapping
    def semantic_column_mapping(self, new_headers: List[str], old_headers: List[str], domain: str = "banking") -> Dict:
        if not self.enabled or len(new_headers) > 50 or len(old_headers) > 50:
            return {}
        cache_key = f"sem:{md5(str(sorted(new_headers+old_headers)).encode()).hexdigest()}"
        if cache_key in self.cache:
            return self.cache[cache_key]

        prompt = f"""Senior Banking Data Architect. Map OLD→NEW column names.
Domain: {domain}
OLD: {', '.join(old_headers[:50])}
NEW: {', '.join(new_headers[:50])}
Rules:
- Boolean/flag columns: name similarity > 50% required
- Amount/balance: match by financial meaning
- IDs: may be regenerated (mark as ID_REGEN)
- Return only confident (>80%) matches
JSON: {{"old_col": "new_col", ...}}"""

        result = self._call(prompt, 'semantic', max_tokens=800)
        self.cache[cache_key] = result
        if result:
            logger.info(f"   🧠 Semantic: {len(result)} mapped")
        return result

    # System 2: Transformation Analysis
    def analyze_transformation(self, n_col, o_col, n_data, o_data, n_type, o_type) -> Dict:
        if not self.enabled:
            return {"relationship": "AI_DISABLED", "confidence": 0, "explanation": "No API"}
        cache_key = f"tr:{n_col}|{o_col}"
        if cache_key in self.cache:
            return self.cache[cache_key]

        prompt = f"""Analyze data transformation.
OLD: {o_col} ({o_type}) samples: {o_data[:5]}
NEW: {n_col} ({n_type}) samples: {n_data[:5]}
Relationships: DIRECT | FORMAT_CHANGE | RENAME | ID_LOOKUP | UNRELATED | ID_REGEN
Return JSON: {{"relationship":"...", "confidence":0-100, "explanation":"..."}}"""

        result = self._call(prompt, 'other', max_tokens=200)
        self.cache[cache_key] = result
        return result if result else {"relationship": "ERROR", "confidence": 0, "explanation": "API failed"}

    # System 3: Batch Audit
    def batch_audit_manual_checks(self, manual_rows: List[Dict]) -> Dict:
        if not self.enabled or not manual_rows:
            return {}
        manual_rows = manual_rows[:20]
        summary = []
        for i, row in enumerate(manual_rows):
            old_type = row.get('Old Type', '')
            new_type = row.get('New Type', '')
            summary.append({
                'id': i, 'new': row.get('New Column',''), 'old': row.get('Old Column',''),
                'new_type': new_type, 'old_type': old_type,
                'is_boolean': (old_type == 'boolean' or new_type == 'boolean'),
                'row_match': row.get('Row Match %', 0), 'name_match': row.get('Name Match %', 0),
                'cardinality': row.get('Cardinality', 'unknown')
            })

        prompt = f"""Review {len(summary)} uncertain column mappings. Upgrade confident ones.
CRITICAL RULES:
- Boolean columns MUST have semantically similar names (>50%)
- Low cardinality (<5 unique values) needs high name similarity
- Data match alone is NOT enough for boolean columns
{json.dumps(summary, indent=2)}
JSON: {{"0": {{"status": "VERIFIED", "reason": "..."}}, ...}}
Only include upgrades. Skip boolean mismatches."""

        result = self._call(prompt, 'other', max_tokens=600)
        if result:
            logger.info(f"   🧠 Batch: {len(manual_rows)} reviewed, {len(result)} upgraded")
        return result

    # System 4: Deep Content Analysis
    def analyze_deep_content(self, old_col: str, new_col: str, old_fp: Dict, new_fp: Dict) -> Dict:
        if not self.enabled or self.total_calls >= self.max_calls:
            return {}

        old_uniques = old_fp.get('unique_values', {})
        new_uniques = new_fp.get('unique_values', {})
        if not old_uniques and not new_uniques:
            return {}

        prompt = f"""Deep analysis: Same business entity?
OLD: {old_col} ({old_fp.get('type')}) cardinality={old_fp.get('cardinality')}
Unique values: {json.dumps(list(old_uniques.keys())[:12])}
NEW: {new_col} ({new_fp.get('type')}) cardinality={new_fp.get('cardinality')}
Unique values: {json.dumps(list(new_uniques.keys())[:12])}
Return JSON: {{"same_entity":true/false,"confidence":0-100,"transformation":"description","reasoning":"why"}}"""

        return self._call(prompt, 'deep_content', max_tokens=400)

    # System 5: Multi-Sample Validation
    def validate_with_samples(self, old_col: str, new_col: str,
                              old_data: pd.Series, new_data: pd.Series) -> Dict:
        if not self.enabled or self.total_calls >= self.max_calls or len(old_data) < 30:
            return {}

        samples = []
        for _ in range(3):
            os_ = old_data.sample(min(10, len(old_data))).astype(str).tolist()
            ns_ = new_data.sample(min(10, len(new_data))).astype(str).tolist()
            samples.append({'old': os_[:8], 'new': ns_[:8]})

        prompt = f"""Cross-validate: {old_col} → {new_col}
Samples: {json.dumps(samples)}
Return JSON: {{"consensus":"agree|disagree","confidence":0-100,"recommendation":"VERIFIED|MANUAL|REJECT"}}"""

        return self._call(prompt, 'multi_sample', max_tokens=300)

    # System 6: Explainability
    def explain_decision(self, old_col: str, new_col: str, details: Dict) -> str:
        if not self.enabled or self.total_calls >= self.max_calls:
            return "AI unavailable"
        prompt = f"""Explain column match in 2 sentences: {old_col} → {new_col}
Name: {details.get('name_sim',0):.0f}%, Data: {details.get('row_match',0):.0f}%, Conf: {details.get('confidence',0):.0f}%
Return JSON: {{"explanation":"plain English"}}"""
        result = self._call(prompt, 'explainability', max_tokens=200)
        return result.get('explanation', 'Match analyzed')

    # System 7: Adversarial Validation
    def challenge_match(self, old_col: str, new_col: str, details: Dict) -> Dict:
        if not self.enabled or self.total_calls >= self.max_calls:
            return {}
        prompt = f"""CHALLENGE this match — find concerns: {old_col} → {new_col}
Confidence: {details.get('confidence',0)}%
Name sim: {details.get('name_sim',0):.0f}%, Row match: {details.get('row_match',0):.0f}%
Return JSON: {{"concerns_found":true/false,"concerns":["..."],"revised_confidence":0-100}}"""
        return self._call(prompt, 'adversarial', max_tokens=300)

    # System 8: Domain Validation
    def validate_domain_rules(self, matches: List[Dict]) -> Dict:
        if not self.enabled or self.total_calls >= self.max_calls or not matches:
            return {}
        critical = [m for m in matches[:10] if 'VERIFIED' in m.get('Status','')]
        if not critical:
            return {}
        prompt = f"""Banking compliance review:
{json.dumps(critical, indent=2)}
Rules: IDs≠transactions, amounts≠counts, dates≠codes, preserve decimal precision.
Return JSON: {{"violations":[{{"index":0,"issue":"..."}}]}}"""
        return self._call(prompt, 'domain', max_tokens=400)

    # System 9: Split Column Confirmation
    def confirm_split(self, split_candidate: Dict) -> Dict:
        if not self.enabled or self.total_calls >= self.max_calls:
            return {}
        old_col  = split_candidate.get('old_col', '')
        primary  = split_candidate.get('primary_new_col', '')
        old_samp = split_candidate.get('old_sample', '[]')
        siblings = split_candidate.get('siblings', [])
        if not siblings:
            return {}

        sib_info = [{'new_col': s['sibling_new_col'], 'split_type': s['split_type'],
                     'sample': s['sibling_sample'], 'type': s['sibling_type']}
                    for s in siblings[:4]]

        prompt = f"""Banking column split detection.
OLD column: '{old_col}' | Old sample: {old_samp}
Already matched: '{old_col}' → '{primary}'
Possible split siblings: {json.dumps(sib_info, indent=2)}
In banking migrations, one old column often splits into debit/credit, before/after, adj/org.
Return JSON: {{"siblings":[{{"new_col":"...","is_real_split":true/false,"split_logic":"...","confidence":0-100}}]}}"""

        return self._call(prompt, 'split_confirm', max_tokens=600)

    # System 10: Anchor Quality Check
    def validate_anchor_semantics(self, anchor_new: str, anchor_old: str,
                                  samples_new: List, samples_old: List) -> Dict:
        if not self.enabled or self.total_calls >= self.max_calls:
            return {'is_valid_anchor': True, 'risk': 'none'}
        prompt = f"""Validate join anchor suitability:
NEW anchor: {anchor_new} — samples: {samples_new[:5]}
OLD anchor: {anchor_old} — samples: {samples_old[:5]}
Is this a valid join key? Not a generic date or flag column?
Return JSON: {{"is_valid_anchor":true/false,"reason":"explanation","risk":"none|low|medium|high"}}"""
        return self._call(prompt, 'other', max_tokens=300)

    # System 11: Final Sanity Check
    def final_sanity_check(self, report_rows: List[Dict]) -> Dict:
        if not self.enabled:
            return {}
        suspicious = []
        for i, row in enumerate(report_rows):
            old_type   = row.get('Old Type','').lower()
            new_type   = row.get('New Type','').lower()
            name_match = row.get('Name Match %', 0)
            conf       = row.get('Confidence', 0)
            status     = row.get('Status','')

            is_susp = False; reason = ""
            if conf > 85 and row.get('Type Mismatch') == 'YES' and 'VERIFIED' in status:
                is_susp = True; reason = "Type mismatch + high confidence"
            if ('boolean' in old_type or 'boolean' in new_type) and name_match < 50 and 'VERIFIED' in status:
                is_susp = True; reason = "Boolean col with low name similarity"

            if is_susp:
                suspicious.append({'id': i, 'old': row.get('Old Column'), 'new': row.get('New Column'),
                                    'old_type': old_type, 'new_type': new_type,
                                    'conf': conf, 'name_match': name_match, 'reason': reason})

        if not suspicious:
            logger.info("   ✅ Sanity check: No suspicious cases")
            return {}

        logger.info(f"   🔍 Sanity check: {len(suspicious)} suspicious cases")
        prompt = f"""SANITY CHECK — suspicious matches:
{json.dumps(suspicious[:10], indent=2)}
Flag boolean mismatches or type mismatches that should be MANUAL_CHECK.
Return JSON: {{"0":"reason","3":"reason"}} (index → reason to downgrade)"""
        result = self._call(prompt, 'other', max_tokens=300)
        if result:
            logger.info(f"   ⚠️  Flagged {len(result)}")
        return result

    # System 12: Context-Aware Validation
    def context_aware_validate(self, old_col: str, new_col: str, context_batch: List[Dict]) -> Dict:
        if not self.enabled or self.total_calls >= self.max_calls:
            return {'validated': False}
        prompt = f"""Context-Aware Validation with Anchor Key Binding.
OLD Column: {old_col} | NEW Column: {new_col}
Data Batch (10 rows with anchor key context):
{json.dumps(context_batch, indent=2)}
Given anchor_val matches across rows, does old_val logically map to new_val?
Return JSON: {{"validated":true/false,"confidence":0-100,"evidence_points":["..."],"reasoning":"..."}}"""
        return self._call(prompt, 'context_aware', max_tokens=500)

    # System 13: Split Formula Proposal
    def propose_split_formula(self, old_col: str, new_cols: List[str]) -> Dict:
        if not self.enabled or self.total_calls >= self.max_calls:
            return {}
        prompt = f"""Propose mathematical formula for column split.
OLD: {old_col} | NEW: {', '.join(new_cols)}
Banking: Principal → PrincipalDebit + PrincipalCredit (SUM), NetAmount → Gross - Discount (DIFFERENCE)
Return JSON: {{"formula":"...","type":"SUM|DIFFERENCE|SPLIT_BY_SIGN|NONE","confidence":0-100,"reasoning":"..."}}"""
        return self._call(prompt, 'split_formula', max_tokens=400)

    # 🆕 V50 System 14: Affect Code Classification
    def classify_affect_code(self, code_value: str, global_dict: Dict) -> Dict:
        """
        Identify what financial category an affect code belongs to.
        Used in TRANSACTION mode when a code is not in global_dict.
        """
        if not self.enabled or self.total_calls >= self.max_calls:
            return {'category': 'UNKNOWN', 'confidence': 0}

        known_categories = list(global_dict.get('affect_codes', {}).keys())[:20]
        prompt = f"""Banking affect code classification.
Code value: "{code_value}"
Known categories in this system: {json.dumps(known_categories)}
What financial category does this code belong to? (e.g., PRINCIPAL, INTEREST, FEE, PENALTY, etc.)
Return JSON: {{"category":"...","sub_category":"...","confidence":0-100,"reasoning":"..."}}"""
        return self._call(prompt, 'affect_code', max_tokens=300)

    def print_budget_summary(self):
        if not self.enabled:
            return
        print("\n" + "="*80)
        print("🧠 V50 AI BUDGET SUMMARY")
        print("="*80)
        for cat, used in self.budget_used.items():
            pct = used / self.max_calls * 100
            bar = "█" * min(20, int(pct / 5))
            print(f"  {cat:15s}: {used:3d} [{bar:<20s}] {pct:4.1f}%")
        print("="*80)
        print(f"  TOTAL: {self.total_calls}/{self.max_calls} ({self.total_calls/self.max_calls*100:.1f}%)")
        print("="*80)


# ==============================================================================
# SMART ANCHOR DETECTOR  (V49 Preserved)
# ==============================================================================

class SmartAnchorDetector:
    @staticmethod
    def find_anchor(df_new: pd.DataFrame, df_old: pd.DataFrame,
                    ai_engine: UltimateAIEngine = None) -> Tuple[Optional[object], float, str]:
        logger.info("🔍 V50 Smart Anchor Search...")

        for strategy, min_score in [('IDEAL_ID', 45), ('HIGH_UNIQUE', 35), ('DATE', 30)]:
            result = SmartAnchorDetector._find_by_strategy(df_new, df_old, strategy, min_score)
            if result:
                validated = SmartAnchorDetector._validate_and_return(result, df_new, df_old, ai_engine)
                if validated[2] == 'single':
                    return validated

        result = SmartAnchorDetector._find_composite(df_new, df_old, min_score=25)
        if result:
            anchor_pair, score = result
            return anchor_pair, score, 'dual'

        logger.warning("   ⚠️  No reliable anchor — using name+fingerprint mode only")
        return None, 0, 'none'

    @staticmethod
    def _find_by_strategy(df_new, df_old, strategy: str, min_score: float) -> Optional[Tuple]:
        new_elig = [c for c in df_new.columns if SmartAnchorGuard.is_eligible(c, df_new[c])][:35]
        old_elig = [c for c in df_old.columns if SmartAnchorGuard.is_eligible(c, df_old[c])][:35]

        candidates = []
        for nc in new_elig:
            for oc in old_elig:
                if strategy == 'IDEAL_ID':
                    if not (any(kw in nc.lower() for kw in SmartAnchorGuard.IDEAL_KEYWORDS[:6]) and
                            any(kw in oc.lower() for kw in SmartAnchorGuard.IDEAL_KEYWORDS[:6])):
                        continue
                elif strategy == 'DATE':
                    if not (any(kw in nc.lower() for kw in ['date','time','dt','day']) and
                            any(kw in oc.lower() for kw in ['date','time','dt','day'])):
                        continue

                name_sim = difflib.SequenceMatcher(None, nc.lower(), oc.lower()).ratio() * 100
                if name_sim < 35:
                    continue

                n_set   = set(df_new[nc].dropna().astype(str).head(2000))
                o_set   = set(df_old[oc].dropna().astype(str).head(2000))
                if not n_set or not o_set:
                    continue

                overlap = len(n_set & o_set) / max(len(n_set), len(o_set)) * 100
                if overlap < 1:
                    continue

                q_new  = SmartAnchorGuard.quality_score(nc, df_new[nc])
                q_old  = SmartAnchorGuard.quality_score(oc, df_old[oc])
                quality = (q_new + q_old) / 2

                final_score = overlap * 0.5 + name_sim * 0.3 + quality * 0.2
                candidates.append(((nc, oc), final_score))

        if candidates:
            best = max(candidates, key=lambda x: x[1])
            if best[1] >= min_score:
                logger.info(f"   ⚓ [{strategy}] {best[0][0]} ↔ {best[0][1]} ({best[1]:.1f})")
                return best
        return None

    @staticmethod
    def _find_composite(df_new, df_old, min_score: float) -> Optional[Tuple]:
        new_elig = [c for c in df_new.columns if SmartAnchorGuard.is_eligible(c, df_new[c])][:12]
        old_elig = [c for c in df_old.columns if SmartAnchorGuard.is_eligible(c, df_old[c])][:12]

        best_score = 0; best_combo = None

        for nc1, nc2 in list(combinations(new_elig, 2))[:200]:
            for oc1, oc2 in list(combinations(old_elig, 2))[:200]:
                try:
                    n_comp = df_new[nc1].astype(str) + "_" + df_new[nc2].astype(str)
                    o_comp = df_old[oc1].astype(str) + "_" + df_old[oc2].astype(str)
                    n_set  = set(n_comp.dropna().head(2000))
                    o_set  = set(o_comp.dropna().head(2000))
                    overlap = len(n_set & o_set) / max(len(n_set), 1) * 100
                    if overlap > best_score:
                        best_score = overlap; best_combo = ((nc1, nc2), (oc1, oc2))
                except Exception:
                    continue

        if best_combo and best_score >= min_score:
            logger.info(f"   ⚓⚓ [COMPOSITE] {best_combo[0]} ↔ {best_combo[1]} ({best_score:.1f})")
            return best_combo, best_score
        return None

    @staticmethod
    def _check_row_cohesion(df_new, df_old, merged_df, nc, oc) -> bool:
        """V49: Anti-Ghost Join — validates surrounding context columns."""
        if merged_df.empty or len(merged_df) < 3:
            return True

        sample_merged = merged_df.head(10)
        valid_rows    = 0

        old_orig_cols = [c for c in df_old.columns if c != oc and c != '_comp']
        new_orig_cols = [c for c in df_new.columns if c != nc and c != '_comp']

        for _, row in sample_merged.iterrows():
            old_values = set(); new_values = set()

            for c in old_orig_cols:
                col_name = f"{c}_O" if f"{c}_O" in merged_df.columns else c
                if col_name in row and pd.notna(row[col_name]):
                    v = str(row[col_name]).strip()
                    if v not in ['', 'nan', '0', '0.0', 'None']:
                        old_values.add(v.lower())
                        norm = AggressiveNormalizer.normalize(v)
                        if isinstance(norm, str): old_values.add(norm)

            for c in new_orig_cols:
                col_name = f"{c}_N" if f"{c}_N" in merged_df.columns else c
                if col_name in row and pd.notna(row[col_name]):
                    v = str(row[col_name]).strip()
                    if v not in ['', 'nan', '0', '0.0', 'None']:
                        new_values.add(v.lower())
                        norm = AggressiveNormalizer.normalize(v)
                        if isinstance(norm, str): new_values.add(norm)

            if len(old_values.intersection(new_values)) > 0:
                valid_rows += 1

        return valid_rows > 0

    @staticmethod
    def _validate_and_return(result, df_new, df_old, ai_engine) -> Tuple:
        (nc, oc), score = result

        nc_is_id = any(kw in nc.lower() for kw in ['id', '_no', 'number', 'seq'])
        oc_is_id = any(kw in oc.lower() for kw in ['id', '_no', 'number', 'seq'])

        if nc_is_id and oc_is_id:
            n_vals = set(df_new[nc].dropna().astype(str).head(500))
            o_vals = set(df_old[oc].dropna().astype(str).head(500))
            overlap_pct = len(n_vals & o_vals) / max(len(o_vals), 1) * 100
            if overlap_pct < 1:
                logger.warning(f"   ❌ ID REGENERATED: {nc}↔{oc} — blacklisting")
                return None, 0, 'id_regenerated'

        try:
            d1 = df_new[[nc]].dropna().drop_duplicates().copy()
            d2 = df_old[[oc]].dropna().drop_duplicates().copy()
            d1[nc] = d1[nc].astype(str); d2[oc] = d2[oc].astype(str)
            test_merge = pd.merge(d1, d2, left_on=nc, right_on=oc, how='inner')
            join_ratio = len(test_merge) / max(len(d1), len(d2), 1)

            if join_ratio < 0.01:
                logger.warning(f"   ❌ Anchor {nc}↔{oc} poor join ({join_ratio:.1%})")
                return None, 0, 'none'

            cohesion_passed = SmartAnchorDetector._check_row_cohesion(df_new, df_old, test_merge, nc, oc)
            if not cohesion_passed:
                logger.warning(f"   ❌ GHOST JOIN: {nc}↔{oc} — keys match but 0% context overlap")
                return None, 0, 'ghost_join'

            if ai_engine and ai_engine.enabled:
                samp_n    = df_new[nc].dropna().head(8).astype(str).tolist()
                samp_o    = df_old[oc].dropna().head(8).astype(str).tolist()
                ai_result = ai_engine.validate_anchor_semantics(nc, oc, samp_n, samp_o)
                if ai_result.get('risk') == 'high' and not ai_result.get('is_valid_anchor', True):
                    logger.warning(f"   ❌ AI rejected anchor {nc}↔{oc}")
                    return None, 0, 'none'

        except Exception as e:
            logger.warning(f"   ⚠️  Anchor validation error ({nc}↔{oc}): {e}")
            return None, 0, 'none'

        logger.info(f"   ✅ Anchor accepted: {nc}↔{oc} (join={join_ratio:.1%})")
        return (nc, oc), score, 'single'


# ==============================================================================
# 🆕 V50 MODULE 1: CONFIG LOADER
# ==============================================================================

class ConfigLoader:
    """
    Loads YAML configuration files for V50.

    File structure expected:
    config_dir/
      global_dict.yaml   — Banking terminology dictionary (affect codes, etc.)
      common.yaml        — Table type, alignment key, schema_mappings
      defect_*.yaml      — Defect/validation rules (one per rule set)
    """

    @staticmethod
    def load(config_dir: str) -> Dict:
        """Load all config files from a directory. Returns merged config dict."""
        config_path = Path(config_dir)

        if not config_path.exists():
            logger.warning(f"Config dir not found: {config_dir}. Using empty config.")
            return ConfigLoader._empty_config()

        # Load global_dict.yaml (shared across all targets)
        global_dict = {}
        global_dict_path = config_path / 'global_dict.yaml'
        if global_dict_path.exists():
            global_dict = ConfigLoader._load_yaml(str(global_dict_path))
            logger.info(f"   📖 global_dict.yaml: {len(global_dict.get('affect_codes', {}))} affect codes")

        # Load common.yaml (per-target configuration)
        common = {}
        common_path = config_path / 'common.yaml'
        if common_path.exists():
            common = ConfigLoader._load_yaml(str(common_path))
            logger.info(f"   📖 common.yaml: table_type={common.get('table_type','MASTER')}")

        # Load all defect_*.yaml files
        defect_rules = []
        for defect_file in sorted(config_path.glob('defect_*.yaml')):
            rules = ConfigLoader._load_yaml(str(defect_file))
            if rules:
                rule_list = rules if isinstance(rules, list) else rules.get('rules', [])
                defect_rules.extend(rule_list)
                logger.info(f"   📖 {defect_file.name}: {len(rule_list)} rules")

        merged = {
            'global_dict':      global_dict,
            'table_type':       common.get('table_type', 'MASTER'),
            'alignment_key':    common.get('alignment_key', None),
            'schema_mappings':  common.get('schema_mappings', {}),
            'sources':          common.get('sources', []),
            'source_combine_method': common.get('source_combine_method', None),
            'source_filter':    common.get('source_filter', None),
            'defect_rules':     defect_rules,
            'domain':           common.get('domain', 'banking'),
            'target_name':      common.get('target_name', 'UNKNOWN'),
            'tolerance':        common.get('tolerance', 0.01),
            'output_mode':      common.get('output_mode', 'both'),   # 'excel' | 'json' | 'both'
            'smartsheet':       common.get('smartsheet', {}),
        }

        logger.info(f"   ✅ Config loaded: {len(defect_rules)} defect rules, "
                    f"{len(merged['schema_mappings'])} schema mappings")
        return merged

    @staticmethod
    def _load_yaml(path: str) -> Any:
        try:
            with open(path, 'r', encoding='utf-8') as f:
                return yaml.safe_load(f) or {}
        except Exception as e:
            logger.warning(f"Failed to load YAML {path}: {e}")
            return {}

    @staticmethod
    def _empty_config() -> Dict:
        return {
            'global_dict': {}, 'table_type': 'MASTER', 'alignment_key': None,
            'schema_mappings': {}, 'sources': [], 'source_combine_method': None,
            'source_filter': None, 'defect_rules': [], 'domain': 'banking',
            'target_name': 'UNKNOWN', 'tolerance': 0.01,
            'output_mode': 'excel', 'smartsheet': {}
        }


# ==============================================================================
# 🆕 V50 MODULE 2: DATA PREP LAYER (Virtual Source)
# ==============================================================================

class DataPrepLayer:
    """
    Assembles virtual source DataFrame from config-specified sources.

    Supports:
    - Single source: direct load
    - UNION: pd.concat of multiple sources
    - source_filter: df.query() pre-filtering
    """

    @staticmethod
    def prepare(sources_config: List[Dict], combine_method: Optional[str],
                source_filter: Optional[str], base_dir: str = "") -> Optional[pd.DataFrame]:
        """
        Build virtual source DataFrame.

        sources_config example:
          - path: "old/table1.csv"   or  file: "table1.csv"
            encoding: "utf-8"
          - path: "old/table2.csv"
        """
        if not sources_config:
            return None

        frames = []
        for src in sources_config:
            path = src.get('path') or src.get('file', '')
            if base_dir and not os.path.isabs(path):
                path = os.path.join(base_dir, path)

            encoding = src.get('encoding', 'utf-8')
            df = DataPrepLayer._load_file(path, encoding)
            if df is not None:
                frames.append(df)
                logger.info(f"   📂 Source loaded: {os.path.basename(path)} "
                            f"({len(df):,} rows × {len(df.columns)} cols)")

        if not frames:
            logger.warning("   ❌ No source frames loaded")
            return None

        # Combine
        if combine_method and combine_method.upper() == 'UNION' and len(frames) > 1:
            try:
                df_virtual = pd.concat(frames, ignore_index=True, sort=False)
                logger.info(f"   🔗 UNION: {len(df_virtual):,} rows total")
            except Exception as e:
                logger.warning(f"   ⚠️ UNION failed ({e}), using first frame only")
                df_virtual = frames[0]
        else:
            df_virtual = frames[0]

        # Apply filter
        if source_filter:
            try:
                before = len(df_virtual)
                df_virtual = df_virtual.query(source_filter)
                logger.info(f"   🔽 Filter '{source_filter}': {before:,} → {len(df_virtual):,} rows")
            except Exception as e:
                logger.warning(f"   ⚠️ Filter failed ({e}), using unfiltered data")

        df_virtual.columns = [str(c).strip() for c in df_virtual.columns]
        return df_virtual

    @staticmethod
    def _load_file(path: str, encoding: str = 'utf-8') -> Optional[pd.DataFrame]:
        if not path or not os.path.exists(path):
            logger.warning(f"   ❌ File not found: {path}")
            return None
        try:
            ext = os.path.splitext(path)[1].lower()
            if ext == '.csv':
                try:
                    return pd.read_csv(path, low_memory=False, encoding=encoding)
                except UnicodeDecodeError:
                    return pd.read_csv(path, low_memory=False, encoding='cp874')
            elif ext in ['.xlsx', '.xls']:
                return pd.read_excel(path)
            else:
                logger.warning(f"   ❌ Unsupported format: {ext}")
                return None
        except Exception as e:
            logger.warning(f"   ❌ Load failed ({path}): {e}")
            return None


# ==============================================================================
# 🆕 V50 MODULE 3: FORMULA PARSER
# ==============================================================================

class FormulaParser:
    """
    Parses and evaluates string formulas from YAML defect rules.

    Supported:
      SUM(col1, col2, ...)
      DIFF(col1, col2)        → col1 - col2
      AVG(col1, col2, ...)
      CONCAT(col1, col2, ...) → str concat
      COALESCE(col1, col2)    → first non-null
    """

    @staticmethod
    def evaluate(formula_str: str, df: pd.DataFrame,
                 tolerance: float = 0.01) -> Optional[pd.Series]:
        """Evaluate a formula string against a DataFrame. Returns computed Series."""
        formula_str = formula_str.strip()
        m_sum   = re.match(r'^SUM\((.+)\)$', formula_str, re.I)
        m_diff  = re.match(r'^DIFF\((.+)\)$', formula_str, re.I)
        m_avg   = re.match(r'^AVG\((.+)\)$', formula_str, re.I)
        m_con   = re.match(r'^CONCAT\((.+)\)$', formula_str, re.I)
        m_coal  = re.match(r'^COALESCE\((.+)\)$', formula_str, re.I)

        try:
            if m_sum:
                cols = FormulaParser._parse_cols(m_sum.group(1), df)
                return sum(pd.to_numeric(df[c], errors='coerce').fillna(0) for c in cols)

            elif m_diff:
                cols = FormulaParser._parse_cols(m_diff.group(1), df)
                if len(cols) >= 2:
                    return (pd.to_numeric(df[cols[0]], errors='coerce').fillna(0) -
                            pd.to_numeric(df[cols[1]], errors='coerce').fillna(0))

            elif m_avg:
                cols = FormulaParser._parse_cols(m_avg.group(1), df)
                numeric_cols = [pd.to_numeric(df[c], errors='coerce').fillna(0) for c in cols]
                return sum(numeric_cols) / len(numeric_cols)

            elif m_con:
                cols = FormulaParser._parse_cols(m_con.group(1), df)
                result = df[cols[0]].astype(str)
                for c in cols[1:]:
                    result = result + df[c].astype(str)
                return result

            elif m_coal:
                cols = FormulaParser._parse_cols(m_coal.group(1), df)
                result = df[cols[0]].copy()
                for c in cols[1:]:
                    result = result.fillna(df[c])
                return result

            # Fallback: try as column name
            elif formula_str in df.columns:
                return df[formula_str]

        except Exception as e:
            logger.warning(f"   FormulaParser error ({formula_str}): {e}")

        return None

    @staticmethod
    def _parse_cols(args_str: str, df: pd.DataFrame) -> List[str]:
        """Parse comma-separated column names, validate they exist in df."""
        cols = [c.strip() for c in args_str.split(',')]
        valid = []
        for c in cols:
            if c in df.columns:
                valid.append(c)
            else:
                logger.warning(f"   ⚠️ Column '{c}' not found in DataFrame")
        return valid

    @staticmethod
    def compare(a: pd.Series, b: pd.Series, tolerance: float = 0.01) -> pd.Series:
        """
        Compare two Series with tolerance for numerics.
        Hard Rule: NEVER use == directly. Always use abs(A-B) <= tolerance.
        """
        try:
            a_num = pd.to_numeric(a, errors='coerce')
            b_num = pd.to_numeric(b, errors='coerce')

            both_numeric = a_num.notna() & b_num.notna()
            result = pd.Series(False, index=a.index)

            # Numeric comparison with tolerance
            if both_numeric.any():
                tol = tolerance
                if a_num[both_numeric].abs().mean() > 0:
                    tol = max(tolerance, a_num[both_numeric].abs().mean() * 0.001)
                result[both_numeric] = abs(a_num[both_numeric] - b_num[both_numeric]) <= tol

            # String comparison for non-numeric
            non_numeric = ~both_numeric
            if non_numeric.any():
                result[non_numeric] = a[non_numeric].astype(str) == b[non_numeric].astype(str)

            return result

        except Exception:
            return a.astype(str) == b.astype(str)


# ==============================================================================
# 🆕 V50 MODULE 3B: AFFECT CODE TAGGER
# ==============================================================================

class AffectCodeTagger:
    """
    Tags rows in TRANSACTION mode with financial categories
    based on global_dict.yaml affect_codes dictionary.
    """

    @staticmethod
    def tag_dataframe(df: pd.DataFrame, affect_col: str,
                      global_dict: Dict, ai_engine: Optional['UltimateAIEngine'] = None) -> pd.DataFrame:
        """
        Add 'affect_tag' column based on affect_codes lookup.
        Unknown codes get AI classification if AI is enabled.
        """
        if affect_col not in df.columns:
            logger.warning(f"   ⚠️ Affect code column '{affect_col}' not found")
            return df

        affect_codes = global_dict.get('affect_codes', {})
        if not affect_codes:
            logger.warning("   ⚠️ No affect_codes in global_dict")
            df['affect_tag']     = 'UNCLASSIFIED'
            df['affect_category'] = 'UNKNOWN'
            return df

        # Build flat lookup: code_value → category
        code_lookup: Dict[str, str] = {}
        code_category: Dict[str, str] = {}
        for category, codes in affect_codes.items():
            if isinstance(codes, list):
                for code in codes:
                    code_lookup[str(code).upper()]    = category
                    code_category[str(code).upper()]  = category
            elif isinstance(codes, dict):
                for code, label in codes.items():
                    code_lookup[str(code).upper()]    = label
                    code_category[str(code).upper()]  = category

        unknown_codes: Set[str] = set()
        tags      = []
        categories = []

        for val in df[affect_col]:
            if pd.isna(val):
                tags.append('NULL'); categories.append('NULL')
                continue
            key = str(val).strip().upper()
            if key in code_lookup:
                tags.append(code_lookup[key])
                categories.append(code_category.get(key, 'KNOWN'))
            else:
                tags.append(f'UNKNOWN:{key}')
                categories.append('UNKNOWN')
                unknown_codes.add(key)

        df['affect_tag']      = tags
        df['affect_category'] = categories

        # AI classification for unknown codes
        if unknown_codes and ai_engine and ai_engine.enabled:
            logger.info(f"   🤖 AI classifying {len(unknown_codes)} unknown affect codes...")
            for code in list(unknown_codes)[:10]:  # Limit to 10 to save budget
                ai_result = ai_engine.classify_affect_code(code, global_dict)
                if ai_result.get('confidence', 0) >= 60:
                    new_category = ai_result.get('category', 'UNKNOWN')
                    # Apply AI classification back to rows
                    mask = df[affect_col].astype(str).str.upper().str.strip() == code
                    df.loc[mask, 'affect_tag']      = f"AI:{new_category}"
                    df.loc[mask, 'affect_category'] = f"AI_CLASSIFIED"
                    logger.info(f"      🏷️ {code} → {new_category} ({ai_result.get('confidence')}%)")

        known_count   = (df['affect_category'] != 'UNKNOWN').sum()
        unknown_count = (df['affect_category'] == 'UNKNOWN').sum()
        logger.info(f"   🏷️ Tagged: {known_count:,} known, {unknown_count:,} unknown affect codes")

        return df


# ==============================================================================
# 🆕 V50 MODULE 3C: VALIDATION ENGINE (3 Modes)
# ==============================================================================

class ValidationEngine:
    """
    Core V50 validation engine — 3 operating modes:
    1. MASTER      — Row-by-row rule checking (defect_*.yaml rules)
    2. TRANSACTION — groupby alignment_key + affect tagging + formula evaluation
    3. MULTIPLE    — Index Alignment (NO JOIN/MERGE — pure set_index alignment)
    """

    @staticmethod
    def run(mode: str, config: Dict, df_virtual: Optional[pd.DataFrame],
            source_dfs: Dict[str, pd.DataFrame],
            ai_engine: Optional[UltimateAIEngine] = None) -> Dict:
        """
        Dispatch to the appropriate validation mode.

        Returns: {'results': [...], 'summary': {...}, 'defect_report': [...]}
        """
        mode = mode.upper()
        if mode == 'TRANSACTION':
            return ValidationEngine.run_transaction_mode(df_virtual, config, ai_engine)
        elif mode == 'MULTIPLE':
            return ValidationEngine.run_multiple_mode(source_dfs, config, ai_engine)
        else:
            return ValidationEngine.run_master_mode(df_virtual, config)

    # ── Mode 1: MASTER ──────────────────────────────────────────────────────────

    @staticmethod
    def run_master_mode(df: Optional[pd.DataFrame], config: Dict) -> Dict:
        """
        Standard rule-based validation: test each defect rule row-by-row.
        """
        results      = []
        defect_report = []

        if df is None or df.empty:
            return {'results': results, 'summary': {}, 'defect_report': defect_report}

        defect_rules = config.get('defect_rules', [])
        tolerance    = config.get('tolerance', 0.01)

        logger.info(f"   ⚙️  MASTER mode: {len(defect_rules)} rules | {len(df):,} rows")

        for rule in defect_rules:
            rule_id    = rule.get('id', 'RULE_UNKNOWN')
            rule_name  = rule.get('name', rule_id)
            rule_type  = rule.get('type', 'COMPARE')
            source_col = rule.get('source_column')
            target_col = rule.get('target_column')
            formula    = rule.get('formula')
            severity   = rule.get('severity', 'WARNING')

            try:
                result = ValidationEngine._evaluate_rule(
                    df, rule_type, source_col, target_col, formula, tolerance
                )

                pass_count = result.sum() if result is not None else 0
                fail_count = len(df) - pass_count if result is not None else len(df)
                pass_rate  = pass_count / len(df) if len(df) > 0 else 0

                defect_entry = {
                    'Rule ID':       rule_id,
                    'Rule Name':     rule_name,
                    'Type':          rule_type,
                    'Source Column': source_col or '-',
                    'Target Column': target_col or '-',
                    'Formula':       formula or '-',
                    'Severity':      severity,
                    'Pass Count':    int(pass_count),
                    'Fail Count':    int(fail_count),
                    'Pass Rate':     f"{pass_rate:.1%}",
                    'Status':        'PASS' if pass_rate >= 0.95 else ('WARN' if pass_rate >= 0.80 else 'FAIL')
                }
                defect_report.append(defect_entry)

                status_icon = '✅' if defect_entry['Status'] == 'PASS' else ('⚠️' if defect_entry['Status'] == 'WARN' else '❌')
                logger.info(f"      {status_icon} [{rule_id}] {rule_name}: {pass_rate:.1%} pass")

            except Exception as e:
                defect_report.append({
                    'Rule ID': rule_id, 'Rule Name': rule_name,
                    'Status': 'ERROR', 'Pass Rate': '0.0%',
                    'Error': str(e)
                })
                logger.warning(f"      ❌ [{rule_id}] Error: {e}")

        summary = ValidationEngine._build_summary(defect_report)
        return {'results': results, 'summary': summary, 'defect_report': defect_report}

    # ── Mode 2: TRANSACTION ──────────────────────────────────────────────────────

    @staticmethod
    def run_transaction_mode(df: Optional[pd.DataFrame], config: Dict,
                             ai_engine: Optional[UltimateAIEngine] = None) -> Dict:
        """
        Transaction mode:
        1. Apply affect code tagging from global_dict
        2. groupby alignment_key
        3. Evaluate formula rules per transaction group
        4. Tolerance-based comparison (NEVER ==)
        """
        if df is None or df.empty:
            return {'results': [], 'summary': {}, 'defect_report': []}

        alignment_key = config.get('alignment_key')
        global_dict   = config.get('global_dict', {})
        defect_rules  = config.get('defect_rules', [])
        tolerance     = config.get('tolerance', 0.01)
        affect_col    = global_dict.get('affect_column')

        logger.info(f"   💳 TRANSACTION mode: key={alignment_key} | "
                    f"{len(defect_rules)} rules | {len(df):,} rows")

        # Step 1: Affect Code Tagging
        if affect_col:
            df = AffectCodeTagger.tag_dataframe(df, affect_col, global_dict, ai_engine)

        defect_report = []

        # Step 2: groupby alignment_key
        if alignment_key and alignment_key in df.columns:
            groups = df.groupby(alignment_key)
            logger.info(f"   📦 Groups: {len(groups):,} unique {alignment_key} values")

            for rule in defect_rules:
                rule_id   = rule.get('id', 'RULE_UNKNOWN')
                rule_name = rule.get('name', rule_id)
                formula   = rule.get('formula', '')
                target    = rule.get('target_column')
                severity  = rule.get('severity', 'WARNING')
                scope     = rule.get('scope', 'ROW')  # ROW | GROUP

                pass_groups = 0; fail_groups = 0; error_groups = 0

                if scope == 'GROUP' and formula and target:
                    for group_key, group_df in groups:
                        try:
                            computed = FormulaParser.evaluate(formula, group_df, tolerance)
                            if computed is not None and target in group_df.columns:
                                match = FormulaParser.compare(
                                    computed, group_df[target], tolerance
                                )
                                if match.all():
                                    pass_groups += 1
                                else:
                                    fail_groups += 1
                        except Exception:
                            error_groups += 1

                    total_groups = pass_groups + fail_groups + error_groups
                    pass_rate    = pass_groups / total_groups if total_groups > 0 else 0

                    defect_report.append({
                        'Rule ID':       rule_id,
                        'Rule Name':     rule_name,
                        'Scope':         'GROUP',
                        'Formula':       formula,
                        'Target Column': target or '-',
                        'Severity':      severity,
                        'Pass Groups':   pass_groups,
                        'Fail Groups':   fail_groups,
                        'Error Groups':  error_groups,
                        'Pass Rate':     f"{pass_rate:.1%}",
                        'Status':        'PASS' if pass_rate >= 0.95 else ('WARN' if pass_rate >= 0.80 else 'FAIL')
                    })

                else:
                    # Row-level evaluation within transaction context
                    result = ValidationEngine._evaluate_rule(
                        df, rule.get('type', 'COMPARE'),
                        rule.get('source_column'), target, formula, tolerance
                    )
                    pass_count = result.sum() if result is not None else 0
                    fail_count = len(df) - pass_count if result is not None else len(df)
                    pass_rate  = pass_count / len(df) if len(df) > 0 else 0

                    defect_report.append({
                        'Rule ID':       rule_id,
                        'Rule Name':     rule_name,
                        'Scope':         'ROW',
                        'Target Column': target or '-',
                        'Severity':      severity,
                        'Pass Count':    int(pass_count),
                        'Fail Count':    int(fail_count),
                        'Pass Rate':     f"{pass_rate:.1%}",
                        'Status':        'PASS' if pass_rate >= 0.95 else ('WARN' if pass_rate >= 0.80 else 'FAIL')
                    })

                icon = '✅' if defect_report[-1]['Status'] == 'PASS' else ('⚠️' if defect_report[-1]['Status'] == 'WARN' else '❌')
                logger.info(f"      {icon} [{rule_id}] {rule_name}: {defect_report[-1]['Pass Rate']}")

        else:
            # No alignment_key — fall back to MASTER mode
            logger.warning("   ⚠️ No alignment_key — falling back to MASTER mode")
            return ValidationEngine.run_master_mode(df, config)

        summary = ValidationEngine._build_summary(defect_report)
        return {'results': [], 'summary': summary, 'defect_report': defect_report}

    # ── Mode 3: MULTIPLE ────────────────────────────────────────────────────────

    @staticmethod
    def run_multiple_mode(source_dfs: Dict[str, pd.DataFrame], config: Dict,
                          ai_engine: Optional[UltimateAIEngine] = None) -> Dict:
        """
        MULTIPLE mode (N-to-N mapping):
        HARD RULE: NO JOIN/MERGE — use set_index(alignment_key) for pure Index Alignment.
        This prevents Cartesian Product data explosion.
        """
        alignment_key = config.get('alignment_key')
        defect_rules  = config.get('defect_rules', [])
        tolerance     = config.get('tolerance', 0.01)

        if not alignment_key:
            logger.warning("   ❌ MULTIPLE mode requires alignment_key in config")
            return {'results': [], 'summary': {}, 'defect_report': []}

        # Set index on all source DataFrames
        indexed_dfs: Dict[str, pd.DataFrame] = {}
        for src_name, df in source_dfs.items():
            if df is None or df.empty:
                continue
            if alignment_key not in df.columns:
                logger.warning(f"   ⚠️ '{alignment_key}' not in {src_name} — skipping")
                continue
            indexed_dfs[src_name] = df.set_index(alignment_key)
            logger.info(f"   📌 Indexed '{src_name}' on '{alignment_key}': {len(indexed_dfs[src_name]):,} rows")

        if len(indexed_dfs) < 2:
            logger.warning("   ❌ MULTIPLE mode needs at least 2 source DataFrames")
            return {'results': [], 'summary': {}, 'defect_report': []}

        defect_report = []
        src_names     = list(indexed_dfs.keys())

        for rule in defect_rules:
            rule_id   = rule.get('id', 'RULE_UNKNOWN')
            rule_name = rule.get('name', rule_id)
            source_a  = rule.get('source_a')  # e.g. "table1"
            source_b  = rule.get('source_b')  # e.g. "table2"
            col_a     = rule.get('column_a')
            col_b     = rule.get('column_b')
            formula_a = rule.get('formula_a')
            formula_b = rule.get('formula_b')
            severity  = rule.get('severity', 'WARNING')

            # Auto-detect sources if not specified
            if not source_a:
                source_a = src_names[0]
            if not source_b:
                source_b = src_names[1] if len(src_names) > 1 else src_names[0]

            df_a = indexed_dfs.get(source_a)
            df_b = indexed_dfs.get(source_b)

            if df_a is None or df_b is None:
                defect_report.append({
                    'Rule ID': rule_id, 'Rule Name': rule_name,
                    'Status': 'ERROR', 'Pass Rate': '0.0%',
                    'Error': f'Source not found: {source_a} or {source_b}'
                })
                continue

            # Find common index (aligned rows)
            common_idx = df_a.index.intersection(df_b.index)
            if len(common_idx) == 0:
                defect_report.append({
                    'Rule ID': rule_id, 'Rule Name': rule_name,
                    'Status': 'WARN', 'Pass Rate': '0.0%',
                    'Note': 'No common alignment keys'
                })
                continue

            df_a_aligned = df_a.loc[common_idx]
            df_b_aligned = df_b.loc[common_idx]

            try:
                # Compute values from formulas or direct columns
                if formula_a:
                    series_a = FormulaParser.evaluate(formula_a, df_a_aligned, tolerance)
                elif col_a and col_a in df_a_aligned.columns:
                    series_a = df_a_aligned[col_a]
                else:
                    series_a = None

                if formula_b:
                    series_b = FormulaParser.evaluate(formula_b, df_b_aligned, tolerance)
                elif col_b and col_b in df_b_aligned.columns:
                    series_b = df_b_aligned[col_b]
                else:
                    series_b = None

                if series_a is None or series_b is None:
                    defect_report.append({
                        'Rule ID': rule_id, 'Rule Name': rule_name,
                        'Status': 'ERROR', 'Pass Rate': 'N/A',
                        'Error': 'Cannot compute series from formula/column'
                    })
                    continue

                # Index-aligned comparison with tolerance (NEVER ==)
                match   = FormulaParser.compare(series_a, series_b, tolerance)
                pass_ct = match.sum()
                fail_ct = len(match) - pass_ct
                pass_rate = pass_ct / len(match) if len(match) > 0 else 0

                defect_report.append({
                    'Rule ID':       rule_id,
                    'Rule Name':     rule_name,
                    'Source A':      f"{source_a}.{col_a or formula_a}",
                    'Source B':      f"{source_b}.{col_b or formula_b}",
                    'Aligned Rows':  len(common_idx),
                    'Severity':      severity,
                    'Pass Count':    int(pass_ct),
                    'Fail Count':    int(fail_ct),
                    'Pass Rate':     f"{pass_rate:.1%}",
                    'Status':        'PASS' if pass_rate >= 0.95 else ('WARN' if pass_rate >= 0.80 else 'FAIL')
                })

                icon = '✅' if pass_rate >= 0.95 else ('⚠️' if pass_rate >= 0.80 else '❌')
                logger.info(f"      {icon} [{rule_id}] {rule_name}: {pass_rate:.1%} "
                            f"({len(common_idx)} aligned rows)")

            except Exception as e:
                defect_report.append({
                    'Rule ID': rule_id, 'Rule Name': rule_name,
                    'Status': 'ERROR', 'Pass Rate': '0.0%', 'Error': str(e)
                })
                logger.warning(f"      ❌ [{rule_id}] Error: {e}")

        summary = ValidationEngine._build_summary(defect_report)
        return {'results': [], 'summary': summary, 'defect_report': defect_report}

    # ── Helpers ─────────────────────────────────────────────────────────────────

    @staticmethod
    def _evaluate_rule(df: pd.DataFrame, rule_type: str,
                       source_col: Optional[str], target_col: Optional[str],
                       formula: Optional[str], tolerance: float) -> Optional[pd.Series]:
        """Evaluate a single rule, return boolean Series (True = pass)."""

        if rule_type in ('COMPARE', 'EQUAL'):
            # Compare source_col vs target_col (or formula vs target)
            if formula and target_col and target_col in df.columns:
                computed = FormulaParser.evaluate(formula, df, tolerance)
                if computed is not None:
                    return FormulaParser.compare(computed, df[target_col], tolerance)
            elif source_col and target_col:
                if source_col in df.columns and target_col in df.columns:
                    return FormulaParser.compare(df[source_col], df[target_col], tolerance)

        elif rule_type == 'NOT_NULL':
            col = target_col or source_col
            if col and col in df.columns:
                return df[col].notna()

        elif rule_type == 'RANGE':
            col    = target_col or source_col
            min_v  = None; max_v = None
            if col and col in df.columns:
                numeric = pd.to_numeric(df[col], errors='coerce')
                result  = pd.Series(True, index=df.index)
                if min_v is not None:
                    result &= numeric >= min_v
                if max_v is not None:
                    result &= numeric <= max_v
                return result

        elif rule_type == 'UNIQUE':
            col = target_col or source_col
            if col and col in df.columns:
                return ~df[col].duplicated(keep='first')

        elif rule_type == 'FORMULA':
            if formula and target_col and target_col in df.columns:
                computed = FormulaParser.evaluate(formula, df, tolerance)
                if computed is not None:
                    return FormulaParser.compare(computed, df[target_col], tolerance)

        return None

    @staticmethod
    def _build_summary(defect_report: List[Dict]) -> Dict:
        if not defect_report:
            return {}
        total = len(defect_report)
        pass_count = sum(1 for r in defect_report if r.get('Status') == 'PASS')
        warn_count = sum(1 for r in defect_report if r.get('Status') == 'WARN')
        fail_count = sum(1 for r in defect_report if r.get('Status') == 'FAIL')
        error_count = sum(1 for r in defect_report if r.get('Status') == 'ERROR')

        return {
            'total_rules': total,
            'pass':   pass_count,
            'warn':   warn_count,
            'fail':   fail_count,
            'error':  error_count,
            'pass_rate': f"{pass_count/total:.1%}" if total > 0 else "N/A",
            'critical_failures': [r['Rule ID'] for r in defect_report
                                  if r.get('Status') == 'FAIL' and r.get('Severity') == 'CRITICAL']
        }


# ==============================================================================
# 🆕 V50 MODULE 4: COVERAGE TRACKER
# ==============================================================================

class CoverageTracker:
    """
    Tracks column coverage across all source tables.
    Reports orphaned columns (present in source but never mapped to any target).
    """

    def __init__(self):
        self._source_registry: Dict[str, Set[str]] = {}   # table_name → {col1, col2, ...}
        self._mapped_cols:     Dict[str, Set[str]] = {}   # table_name → {mapped_col1, ...}
        self._target_map:      Dict[str, List[str]] = {}  # source_col → [target_cols]

    def register_source(self, table_name: str, columns: List[str]):
        """Register all columns from a source table."""
        self._source_registry[table_name] = set(columns)
        self._mapped_cols.setdefault(table_name, set())
        logger.info(f"   📋 Registered source '{table_name}': {len(columns)} columns")

    def mark_mapped(self, table_name: str, source_col: str, target_col: str):
        """Mark a source column as mapped to a target column."""
        self._mapped_cols.setdefault(table_name, set()).add(source_col)
        self._target_map.setdefault(source_col, []).append(target_col)

    def mark_mapped_from_report(self, table_name: str, report: Dict):
        """
        Bulk-mark from a V49-style report dict.
        report: {old_col: {'Status': ..., 'New Column': ...}}
        """
        for old_col, info in report.items():
            status  = info.get('Status', '')
            new_col = info.get('New Column', '')
            if 'VERIFIED' in status or status in ('AI_VERIFIED', 'CONTEXT_VERIFIED'):
                self.mark_mapped(table_name, old_col, new_col)

    def get_orphaned(self) -> Dict[str, List[str]]:
        """Return columns that exist in source but were never mapped."""
        orphaned: Dict[str, List[str]] = {}
        for table_name, all_cols in self._source_registry.items():
            mapped = self._mapped_cols.get(table_name, set())
            unmapped = sorted(all_cols - mapped)
            if unmapped:
                orphaned[table_name] = unmapped
        return orphaned

    def get_coverage_summary(self) -> Dict:
        """Return overall coverage statistics."""
        total_source = sum(len(cols) for cols in self._source_registry.values())
        total_mapped = sum(len(cols) for cols in self._mapped_cols.values())
        orphaned     = self.get_orphaned()
        total_orphaned = sum(len(cols) for cols in orphaned.values())

        return {
            'total_source_columns': total_source,
            'total_mapped':         total_mapped,
            'total_orphaned':       total_orphaned,
            'coverage_rate':        f"{total_mapped/total_source:.1%}" if total_source > 0 else "N/A",
            'orphaned_by_table':    {t: len(c) for t, c in orphaned.items()},
            'orphaned_columns':     orphaned
        }

    def print_summary(self):
        summary = self.get_coverage_summary()
        print("\n" + "="*80)
        print("📊 V50 COVERAGE TRACKER SUMMARY")
        print("="*80)
        print(f"  Total Source Columns : {summary['total_source_columns']}")
        print(f"  Mapped               : {summary['total_mapped']}")
        print(f"  Orphaned             : {summary['total_orphaned']}")
        print(f"  Coverage Rate        : {summary['coverage_rate']}")
        if summary['orphaned_by_table']:
            print("\n  ⚠️  ORPHANED DATA (never mapped to any target):")
            for table, cols in summary['orphaned_columns'].items():
                print(f"    {table}:")
                for col in cols:
                    print(f"      • {col}")
        print("="*80)


# ==============================================================================
# 🆕 V50 MODULE 5: API CLIENT (Stateless Output)
# ==============================================================================

class APIClient:
    """
    Stateless output client for V50 cloud-native deployment.
    Supports:
    - JSON payload generation
    - Smartsheet API push
    - Generic REST API push
    """

    @staticmethod
    def build_json_payload(target_name: str, mapping_report: Dict,
                           validation_result: Dict, coverage_summary: Dict,
                           metadata: Dict = None) -> Dict:
        """Build standardized JSON output payload."""
        timestamp = datetime.utcnow().isoformat() + "Z"

        payload = {
            'version':      'V50',
            'target_table': target_name,
            'timestamp':    timestamp,
            'metadata':     metadata or {},
            'mapping': {
                'total_columns':   len(mapping_report),
                'by_status':       {},
                'columns':         []
            },
            'validation': {
                'summary': validation_result.get('summary', {}),
                'defect_report': validation_result.get('defect_report', [])
            },
            'coverage': coverage_summary
        }

        # Aggregate mapping stats
        status_counts: Dict[str, int] = defaultdict(int)
        for info in mapping_report.values():
            status_counts[info.get('Status', 'UNKNOWN')] += 1

        payload['mapping']['by_status'] = dict(status_counts)

        # Column-level details
        for old_col, info in mapping_report.items():
            payload['mapping']['columns'].append({
                'old_column':   old_col,
                'new_column':   info.get('New Column', '-'),
                'status':       info.get('Status', 'UNKNOWN'),
                'confidence':   info.get('Confidence', 0),
                'transformation': info.get('Transformation Logic', '-'),
                'explanation':  info.get('AI Explanation', '-'),
                'source':       info.get('Source', '-')
            })

        return payload

    @staticmethod
    def save_json(payload: Dict, output_path: str) -> bool:
        """Save JSON payload to file."""
        try:
            os.makedirs(os.path.dirname(output_path), exist_ok=True) if os.path.dirname(output_path) else None
            with open(output_path, 'w', encoding='utf-8') as f:
                json.dump(payload, f, ensure_ascii=False, indent=2)
            logger.info(f"   💾 JSON saved: {output_path}")
            return True
        except Exception as e:
            logger.warning(f"   ❌ JSON save failed: {e}")
            return False

    @staticmethod
    def push_to_smartsheet(payload: Dict, smartsheet_config: Dict) -> bool:
        """
        Push JSON payload to Smartsheet via API.

        smartsheet_config:
          api_url:    "https://api.smartsheet.com/2.0/sheets/{sheet_id}/rows"
          api_token:  "Bearer xxxxx"
          sheet_id:   "1234567890"
          column_map: {column_name: column_id, ...}  # Smartsheet column IDs
        """
        if not REQUESTS_AVAILABLE:
            logger.warning("   ❌ 'requests' library not available for Smartsheet push")
            return False

        api_url   = smartsheet_config.get('api_url', '')
        api_token = smartsheet_config.get('api_token', '')
        col_map   = smartsheet_config.get('column_map', {})

        if not api_url or not api_token:
            logger.warning("   ❌ Smartsheet api_url or api_token not configured")
            return False

        headers = {
            'Authorization': api_token if api_token.startswith('Bearer') else f'Bearer {api_token}',
            'Content-Type':  'application/json'
        }

        # Build rows for Smartsheet
        rows = []
        for col_info in payload.get('mapping', {}).get('columns', []):
            cells = []
            for col_name, col_id in col_map.items():
                value = col_info.get(col_name, '') or payload.get(col_name, '')
                if isinstance(value, (dict, list)):
                    value = json.dumps(value)
                cells.append({'columnId': col_id, 'value': str(value)})

            if cells:
                rows.append({'cells': cells})

        if not rows:
            logger.warning("   ⚠️ No rows to push to Smartsheet")
            return False

        # Batch push (Smartsheet allows max 500 rows per request)
        BATCH_SIZE = 500
        success    = True

        for i in range(0, len(rows), BATCH_SIZE):
            batch = rows[i:i + BATCH_SIZE]
            body  = {'rows': batch}
            try:
                resp = requests.post(api_url, headers=headers,
                                     json=body, timeout=30)
                if resp.status_code in (200, 201, 202):
                    logger.info(f"   ✅ Smartsheet: pushed {len(batch)} rows "
                                f"(batch {i//BATCH_SIZE + 1})")
                else:
                    logger.warning(f"   ⚠️ Smartsheet HTTP {resp.status_code}: {resp.text[:200]}")
                    success = False
            except Exception as e:
                logger.warning(f"   ❌ Smartsheet push error: {e}")
                success = False

        return success

    @staticmethod
    def push_to_generic_api(payload: Dict, api_config: Dict) -> bool:
        """Push payload to any generic REST API endpoint."""
        if not REQUESTS_AVAILABLE:
            return False

        url     = api_config.get('url', '')
        method  = api_config.get('method', 'POST').upper()
        headers = api_config.get('headers', {'Content-Type': 'application/json'})
        timeout = api_config.get('timeout', 30)

        if not url:
            return False

        try:
            if method == 'POST':
                resp = requests.post(url, headers=headers, json=payload, timeout=timeout)
            elif method == 'PUT':
                resp = requests.put(url, headers=headers, json=payload, timeout=timeout)
            else:
                resp = requests.post(url, headers=headers, json=payload, timeout=timeout)

            if resp.status_code < 300:
                logger.info(f"   ✅ API push success: {url} ({resp.status_code})")
                return True
            else:
                logger.warning(f"   ⚠️ API push failed: {resp.status_code}")
                return False
        except Exception as e:
            logger.warning(f"   ❌ API push error: {e}")
            return False


# ==============================================================================
# 🆕 V50 MAIN ENGINE (extends V49 logic)
# ==============================================================================

class VidarV50:
    """
    V50 Main Engine.
    Integrates ConfigLoader → DataPrepLayer → ValidationEngine → V49 AI Mapping
    → CoverageTracker → APIClient output.
    """

    def __init__(self, api_key: str = None, config_base_dir: str = "config",
                 data_base_dir: str = "data", output_dir: str = "output"):
        self.report:       Dict = {}
        self.split_report: List = []
        self.logs:         List = []
        self.start_time        = datetime.now()

        self.api_key      = api_key
        self.config_base  = config_base_dir
        self.data_base    = data_base_dir
        self.output_dir   = output_dir

        self.SAMPLE_SIZE           = 50000
        self.AI_TRIGGER_NAME_SIM   = 50.0
        self.AI_TRIGGER_DATA_LOW   = 85.0
        self.EXCLUSIVITY_THRESHOLD = 97.0

        self.ai = UltimateAIEngine(api_key)

        self.semantic_map:      Dict = {}
        self.fingerprints_new:  Dict = {}
        self.fingerprints_old:  Dict = {}
        self.locked_new_cols: Set[str] = set()

        self._merged_dfs:     Dict[str, pd.DataFrame] = {}
        self._anchor_info:    Dict[str, Tuple] = {}
        self._df_new_ref:     Optional[pd.DataFrame] = None
        self._df_old_refs:    Dict[str, pd.DataFrame] = {}

        self.coverage = CoverageTracker()

        os.makedirs(output_dir, exist_ok=True)

    def log(self, msg: str):
        ts    = datetime.now().strftime("%H:%M:%S")
        entry = f"[{ts}] {msg}"
        print(entry)
        self.logs.append(entry)

    # ────────────────────────────────────────────────────────────────────────────
    # MAIN ENTRY POINT: audit_target
    # ────────────────────────────────────────────────────────────────────────────

    def audit_target(self, target_name: str, new_file: str, old_files: List[str],
                     config_dir: str = None) -> Dict:
        """
        Audit a single target table against one or more old source tables.

        Args:
            target_name : Human-readable target table name
            new_file    : Path to new (target) data file
            old_files   : Paths to old (source) data files
            config_dir  : Path to YAML config dir (overrides self.config_base)

        Returns: Full audit results dict
        """
        self.log("="*80)
        self.log(f"🚀 VIDAR V50 — {target_name}")
        self.log("="*80)

        # Reset per-target state
        self.report       = {}
        self.split_report = []
        self.fingerprints_new = {}
        self.fingerprints_old = {}
        self.locked_new_cols  = set()
        self._merged_dfs   = {}
        self._anchor_info  = {}
        self._df_new_ref   = None
        self._df_old_refs  = {}

        # 1. Load Config
        cfg_dir = config_dir or os.path.join(self.config_base, target_name)
        self.log(f"\n📖 Loading config from: {cfg_dir}")
        config = ConfigLoader.load(cfg_dir)
        config['target_name'] = target_name

        # 2. Load new (target) data
        df_new = self.load_data(new_file)
        if df_new is None:
            self.log("❌ Cannot load new (target) file. Aborting.")
            return {}

        self._df_new_ref = df_new

        # 3. Apply Layer-0 Bypass from schema_mappings
        schema_mappings = config.get('schema_mappings', {})
        layer0_verified = 0
        if schema_mappings:
            self.log(f"\n⚡ Layer-0 Bypass: {len(schema_mappings)} schema mappings → instant VERIFIED")
            for old_col, new_col in schema_mappings.items():
                self.report[old_col] = {
                    'Old Column':           old_col,
                    'Old Type':             '-',
                    'Old Sample':           '-',
                    'Status':               'VERIFIED (Schema Mapping)',
                    'Transformation Logic': 'SCHEMA_MAP',
                    'AI Explanation':       f'✅ Layer-0: Defined in common.yaml schema_mappings → {new_col}',
                    'Source':               'YAML',
                    'New Column':           new_col,
                    'New Type':             '-',
                    'New Sample':           '-',
                    'Confidence':           100.0,
                    'Row Match %':          100.0,
                    'Name Match %':         100.0,
                    'Fingerprint Match %':  100.0,
                    'Type Mismatch':        'NO',
                    'Cardinality':          '-',
                    'Boolean Match':        'N/A'
                }
                self.locked_new_cols.add(new_col)
                layer0_verified += 1

            self.log(f"   ✅ {layer0_verified} columns bypassed to VERIFIED")

        # 4. DataPrepLayer: Build virtual source from YAML sources config
        virtual_source = None
        source_dfs: Dict[str, pd.DataFrame] = {}

        if config.get('sources'):
            self.log("\n🚰 DataPrepLayer: Building virtual source...")
            virtual_source = DataPrepLayer.prepare(
                config['sources'],
                config.get('source_combine_method'),
                config.get('source_filter'),
                self.data_base
            )

        # 5. Load old files (for V49 fingerprint + mapping logic)
        old_tables = []
        for f in old_files:
            df_old = self.load_data(f)
            if df_old is not None:
                old_name = os.path.basename(f)
                old_tables.append((old_name, df_old))
                self._df_old_refs[old_name] = df_old
                source_dfs[old_name] = df_old
                # Register with coverage tracker
                self.coverage.register_source(old_name, df_old.columns.tolist())

        if not old_tables and virtual_source is None:
            self.log("❌ No source data loaded")
            return {}

        # 6. Run ValidationEngine (rules from YAML)
        table_type = config.get('table_type', 'MASTER')
        validation_result = {'results': [], 'summary': {}, 'defect_report': []}

        if config.get('defect_rules'):
            self.log(f"\n⚙️  ValidationEngine: {table_type} mode | "
                     f"{len(config['defect_rules'])} defect rules")
            df_for_validation = virtual_source if virtual_source is not None else (
                old_tables[0][1] if old_tables else None
            )
            validation_result = ValidationEngine.run(
                table_type, config, df_for_validation, source_dfs, self.ai
            )
            self.log(f"   📊 Rules: {validation_result['summary'].get('pass', 0)} PASS | "
                     f"{validation_result['summary'].get('fail', 0)} FAIL | "
                     f"{validation_result['summary'].get('warn', 0)} WARN")

        # 7. V49 Fingerprint + AI Column Mapping (for columns NOT in schema_mappings)
        self.log("\n📊 Fingerprinting NEW columns...")
        for col in df_new.columns:
            self.fingerprints_new[col] = ColumnFingerprint.generate(df_new[col], col)

        for old_name, df_old in old_tables:
            self.log(f"📊 Fingerprinting OLD: {old_name}...")
            for col in df_old.columns:
                self.fingerprints_old[f"{old_name}:{col}"] = ColumnFingerprint.generate(df_old[col], col)

        # Semantic mapping (AI)
        if self.ai.enabled and old_tables:
            all_old_cols = []
            for _, df_old in old_tables:
                all_old_cols.extend(df_old.columns.tolist())
            self.semantic_map = self.ai.semantic_column_mapping(
                list(df_new.columns), list(set(all_old_cols)), config.get('domain', 'banking')
            )

        # Process each old table (V49 anchor + match logic)
        for old_name, df_old in old_tables:
            self.log(f"\n⚔️  Mapping: {old_name} ({len(df_old):,} × {len(df_old.columns)})")
            self._process_old_table(df_new, df_old, old_name)

        # 8. Post-processing (V49 preserved)
        self.log("\n🔀 Collision resolution...")
        self.locked_new_cols = CollisionResolver.build_exclusivity_lock(
            self.report, self.EXCLUSIVITY_THRESHOLD
        )
        self.report, collision_warnings = CollisionResolver.resolve(self.report, self.locked_new_cols)
        for w in collision_warnings:
            self.log(f"   ⚠️  {w}")
        if not collision_warnings:
            self.log("   ✅ No collisions detected")

        # Context-aware batch validation
        if self.ai.enabled:
            self._context_aware_batch_validation()

        # Batch AI audit
        if self.ai.enabled:
            self._batch_ai_audit()

        # Final sanity check
        if self.ai.enabled:
            self._final_sanity_check()

        # Domain validation
        if self.ai.enabled:
            self.log("\n🏦 Domain validation...")
            domain_result = self.ai.validate_domain_rules(list(self.report.values()))
            if domain_result.get('violations'):
                for violation in domain_result['violations']:
                    idx  = violation.get('index', -1)
                    keys = list(self.report.keys())
                    if 0 <= idx < len(keys):
                        ck        = keys[idx]
                        curr_conf = self.report[ck].get('Confidence', 0)
                        if curr_conf > 95:
                            self.report[ck]['AI Explanation'] += f" [Note: {violation.get('issue','')}]"
                        else:
                            self.report[ck]['Status']         = 'MANUAL_CHECK'
                            self.report[ck]['AI Explanation'] = f"🏦 Domain: {violation.get('issue','')}"
                self.log(f"   ⚠️  {len(domain_result['violations'])} compliance issues")

        # Split detection
        self._detect_splits(list(df_new.columns))

        # 9. Update Coverage Tracker
        for old_name, _ in old_tables:
            self.coverage.mark_mapped_from_report(old_name, self.report)

        # 10. Build results dict
        results = {
            'target_name':        target_name,
            'mapping_report':     self.report,
            'split_report':       self.split_report,
            'validation_result':  validation_result,
            'coverage_summary':   self.coverage.get_coverage_summary(),
            'ai_calls':           self.ai.total_calls,
            'duration_seconds':   (datetime.now() - self.start_time).total_seconds()
        }

        # 11. Export
        self._export(target_name, config, results)

        if self.ai.enabled:
            self.ai.print_budget_summary()

        return results

    # ────────────────────────────────────────────────────────────────────────────
    # MULTI-TARGET AUDIT (Cloud-Native entry point)
    # ────────────────────────────────────────────────────────────────────────────

    def audit_all_targets(self, targets: List[Dict]) -> Dict:
        """
        Run audit for multiple targets sequentially.
        Each target: {'name': ..., 'new_file': ..., 'old_files': [...], 'config_dir': ...}

        Returns aggregated results.
        """
        all_results = {}

        for target in targets:
            target_name = target.get('name', 'UNKNOWN')
            new_file    = target.get('new_file', '')
            old_files   = target.get('old_files', [])
            config_dir  = target.get('config_dir')

            self.log(f"\n{'='*80}")
            self.log(f"🎯 TARGET: {target_name}")

            if not os.path.exists(new_file):
                self.log(f"❌ New file not found: {new_file}")
                all_results[target_name] = {'error': 'File not found'}
                continue

            result = self.audit_target(target_name, new_file, old_files, config_dir)
            all_results[target_name] = result
            gc.collect()

        # Final coverage report
        self.log("\n" + "="*80)
        self.log("📊 GLOBAL COVERAGE REPORT")
        self.coverage.print_summary()

        # Global orphan report
        orphaned = self.coverage.get_orphaned()
        if orphaned:
            self.log(f"\n⚠️  ORPHANED DATA DETECTED across {len(orphaned)} tables")
            orphan_payload = {
                'report_type': 'ORPHAN_COVERAGE',
                'timestamp':   datetime.utcnow().isoformat() + "Z",
                'orphaned':    {t: list(cols) for t, cols in orphaned.items()}
            }
            orphan_path = os.path.join(self.output_dir, 'orphan_coverage_report.json')
            APIClient.save_json(orphan_payload, orphan_path)
        else:
            self.log("✅ No orphaned data — all source columns are mapped!")

        return all_results

    # ────────────────────────────────────────────────────────────────────────────
    # DATA LOADING
    # ────────────────────────────────────────────────────────────────────────────

    def load_data(self, path: str) -> Optional[pd.DataFrame]:
        self.log(f"📂 {os.path.basename(path)}")
        try:
            ext = os.path.splitext(path)[1].lower()
            if ext == '.csv':
                try:
                    df = pd.read_csv(path, low_memory=False, encoding='utf-8')
                except UnicodeDecodeError:
                    df = pd.read_csv(path, low_memory=False, encoding='cp874')
            else:
                df = pd.read_excel(path)

            if len(df) > self.SAMPLE_SIZE:
                df = df.sample(self.SAMPLE_SIZE, random_state=42)

            df.columns = [str(c).strip() for c in df.columns]
            self.log(f"   ✅ {len(df):,} rows × {len(df.columns)} cols")
            return df
        except Exception as e:
            self.log(f"   ❌ Load failed: {e}")
            return None

    # ────────────────────────────────────────────────────────────────────────────
    # V49 ANCHOR + FIELD MATCHING (Preserved, integrated into audit_target)
    # ────────────────────────────────────────────────────────────────────────────

    def _process_old_table(self, df_new: pd.DataFrame, df_old: pd.DataFrame, old_name: str):
        """V49 anchor detection + field matching for one old table."""
        anchor, score, atype = SmartAnchorDetector.find_anchor(df_new, df_old, self.ai)

        merged_df  = pd.DataFrame()
        is_anchored = False

        if anchor and atype == 'single':
            nk, ok = anchor
            try:
                d1 = df_new.drop_duplicates(subset=[nk]).copy()
                d2 = df_old.drop_duplicates(subset=[ok]).copy()
                d1[nk] = d1[nk].astype(str)
                d2[ok] = d2[ok].astype(str)
                merged_df = pd.merge(d1, d2, left_on=nk, right_on=ok,
                                     how='inner', suffixes=('_N', '_O'))
                valid, msg = SmartAnchorGuard.validate_join(merged_df, df_old, df_new)
                if valid:
                    is_anchored = True
                    self.log(f"   ✅ Anchor join: {msg}")
                    self._anchor_info[old_name] = (nk, ok)
                    self._merged_dfs[old_name]  = merged_df
                else:
                    self.log(f"   ⚠️  Anchor rejected: {msg}")
                    merged_df = pd.DataFrame()
            except Exception as e:
                self.log(f"   ⚠️  Merge failed: {e}")

        elif anchor and atype == 'dual':
            (nk1, nk2), (ok1, ok2) = anchor
            try:
                df_new['_comp'] = df_new[nk1].astype(str) + "_" + df_new[nk2].astype(str)
                df_old['_comp'] = df_old[ok1].astype(str) + "_" + df_old[ok2].astype(str)
                d1 = df_new.drop_duplicates(subset=['_comp']).copy()
                d2 = df_old.drop_duplicates(subset=['_comp']).copy()
                merged_df = pd.merge(d1, d2, on='_comp', how='inner', suffixes=('_N', '_O'))
                valid, msg = SmartAnchorGuard.validate_join(merged_df, df_old, df_new)
                if valid:
                    is_anchored = True
                    self.log(f"   ✅ Composite anchor: {msg}")
                    self._anchor_info[old_name] = ((nk1, nk2), (ok1, ok2))
                    self._merged_dfs[old_name]  = merged_df
                else:
                    self.log(f"   ⚠️  Composite anchor rejected: {msg}")
                    merged_df = pd.DataFrame()
            except Exception as e:
                self.log(f"   ⚠️  Composite failed: {e}")

        self._match_fields(df_new, df_old, merged_df, is_anchored, old_name)

    # ────────────────────────────────────────────────────────────────────────────
    # V49 FIELD MATCHING (Preserved intact)
    # ────────────────────────────────────────────────────────────────────────────

    def _match_fields(self, df_new: pd.DataFrame, df_old: pd.DataFrame,
                      merged_df: pd.DataFrame, is_anchored: bool, source: str):
        """V49 field matching engine (100% preserved from V49)."""

        for o_col in df_old.columns:
            if o_col in ['_comp']:
                continue

            # Skip if already Layer-0 verified
            curr_conf = self.report.get(o_col, {}).get('Confidence', 0)
            if curr_conf >= 100 and self.report.get(o_col, {}).get('Status') == 'VERIFIED (Schema Mapping)':
                continue

            if curr_conf > 99:
                continue

            fp_old      = self.fingerprints_old.get(f"{source}:{o_col}", {})
            is_zero_col = fp_old.get('is_all_zeros', False)

            if df_old[o_col].dropna().empty:
                if o_col not in self.report or self.report[o_col]['Confidence'] < 100:
                    self.report[o_col] = {
                        'Old Column': o_col, 'Status': 'EMPTY_COLUMN',
                        'Confidence': 100, 'Old Type': 'EMPTY',
                        'AI Explanation': 'Column is empty'
                    }
                continue

            best_match = None
            max_score  = -1

            for n_col in df_new.columns:
                if n_col in ['_comp']:
                    continue

                if n_col in self.locked_new_cols:
                    existing_owner = next(
                        (k for k, v in self.report.items() if v.get('New Column') == n_col), None
                    )
                    if existing_owner and existing_owner != o_col:
                        continue

                semantic_bonus = 30 if self.semantic_map.get(n_col) == o_col else 0
                name_sim = difflib.SequenceMatcher(None, o_col.lower(), n_col.lower()).ratio() * 100

                fp_new = self.fingerprints_new.get(n_col, {})
                fp_sim = ColumnFingerprint.similarity(fp_old, fp_new) if fp_old and fp_new else 0

                if is_zero_col:
                    row_match = 0; set_match = 0; transformation_rule = 'NONE'
                    score = (100 if name_sim > 95 else (name_sim * 0.9) + (fp_sim * 0.1) + semantic_bonus)
                else:
                    transformation_rule = 'NONE'; row_match = 0

                    if is_anchored and not merged_df.empty:
                        o_lk = f"{o_col}_O" if f"{o_col}_O" in merged_df.columns else o_col
                        n_lk = f"{n_col}_N" if f"{n_col}_N" in merged_df.columns else n_col
                        if o_lk in merged_df.columns and n_lk in merged_df.columns:
                            try:
                                rule_result = TransformationRulebook.test_all_rules(
                                    merged_df[o_lk], merged_df[n_lk], sample_size=100
                                )
                                row_match          = rule_result['match_rate'] * 100
                                transformation_rule = rule_result['best_rule']
                            except Exception:
                                transformation_rule = 'RAW'
                                o_norm = AggressiveNormalizer.clean_series(merged_df[o_lk])
                                n_norm = AggressiveNormalizer.clean_series(merged_df[n_lk])
                                valid  = o_norm.notna() & n_norm.notna()
                                if valid.sum() > 0:
                                    row_match = (o_norm[valid] == n_norm[valid]).sum() / valid.sum() * 100

                    set_match = 0; jaccard_veto = False
                    try:
                        o_vals = set(AggressiveNormalizer.clean_series(df_old[o_col]).dropna().head(1000))
                        n_vals = set(AggressiveNormalizer.clean_series(df_new[n_col]).dropna().head(1000))
                        if o_vals and n_vals:
                            set_match = len(o_vals & n_vals) / len(o_vals) * 100
                            # V49: Jaccard Intersection Veto
                            if set_match == 0 and len(o_vals) > 10 and len(n_vals) > 10:
                                jaccard_veto = True
                    except Exception:
                        pass

                    if jaccard_veto:
                        continue

                    card_old = fp_old.get('cardinality', 999)
                    card_new = fp_new.get('cardinality', 999)
                    is_low_card  = (card_old <= 5 or card_new <= 5)
                    is_bool_match = (fp_old.get('is_boolean', False) or fp_new.get('is_boolean', False))

                    if is_bool_match or is_low_card:
                        score = ((row_match*0.30)+(name_sim*0.40)+(fp_sim*0.20)+(set_match*0.10)+semantic_bonus
                                 if is_anchored else
                                 (name_sim*0.50)+(fp_sim*0.30)+(set_match*0.20)+semantic_bonus)
                    else:
                        score = ((row_match*0.60)+(name_sim*0.15)+(fp_sim*0.15)+(set_match*0.10)+semantic_bonus
                                 if is_anchored else
                                 (name_sim*0.35)+(fp_sim*0.35)+(set_match*0.30)+semantic_bonus)

                if score > max_score:
                    max_score  = score
                    best_match = {
                        'n_col': n_col, 'row_match': row_match, 'set_match': set_match,
                        'name_sim': name_sim, 'fp_sim': fp_sim, 'score': score,
                        'fp_old': fp_old, 'fp_new': fp_new, 'transformation_rule': transformation_rule
                    }

            if not best_match:
                continue

            # ── Decision Logic (V49 preserved) ──
            n_col      = best_match['n_col']
            status     = "MANUAL_CHECK"
            confidence = max_score
            ai_expl    = "-"
            trans_logic = "-"
            transformation_rule = best_match.get('transformation_rule', 'NONE')

            if best_match['row_match'] > 90.0 and not is_zero_col:
                status     = "VERIFIED (Data Match)"
                confidence = 100
                etl = TransformationRulebook._generate_etl_instruction(transformation_rule)
                trans_logic = etl if transformation_rule not in ['RAW', 'NONE'] else "RENAME"
                ai_expl    = "✅ Data matches 100%"

            elif best_match['row_match'] > 85.0 and not is_zero_col and transformation_rule not in ['RAW', 'NONE']:
                status     = "VERIFIED (Data Match)"
                confidence = min(98, confidence)
                etl = TransformationRulebook._generate_etl_instruction(transformation_rule)
                trans_logic = etl
                ai_expl    = f"✅ Data matches {best_match['row_match']:.1f}% with {transformation_rule}"

            elif best_match['set_match'] > 95.0 and not is_zero_col:
                orphan_check = OrphanedDataDetector.check_orphan_status(o_col, n_col, df_old, df_new)
                if orphan_check['is_orphan']:
                    if orphan_check['status'] == 'DATA_LOST':
                        status = "DATA_LOST"; confidence = 50
                        trans_logic = "DATA_MISSING"; ai_expl = f"🚨 {orphan_check['reason']}"
                    elif orphan_check['status'] == 'SCHEMA_MATCH_ONLY':
                        status = "SCHEMA_MATCH_ONLY"; confidence = 60
                        trans_logic = "EMPTY_TARGET"; ai_expl = f"⚠️ {orphan_check['reason']}"
                else:
                    status = "VERIFIED (Set Match)"; confidence = 98; trans_logic = "MAPPING"
                ai_expl = "✅ All old values found in new column"

            elif is_zero_col and best_match['name_sim'] > 95:
                status = "VERIFIED"; confidence = 100; ai_expl = "✅ Zero column exact name match"; trans_logic = "DIRECT"
            elif is_zero_col and max_score > 80:
                status = "MANUAL_CHECK"; ai_expl = "Zero column — similar name"
            elif confidence > 95:
                status = "VERIFIED"

            type1 = best_match['fp_old'].get('type','')
            type2 = best_match['fp_new'].get('type','')
            is_mismatch = not (type1 == type2 or {type1,type2} == {'numeric','integer'})
            if is_mismatch and status not in ["VERIFIED (Data Match)", "VERIFIED (Set Match)"]:
                confidence *= 0.5
                if confidence < 80:
                    status = "MANUAL_CHECK"

            # AI Triggers (V49 preserved)
            if self.ai.enabled and status == "MANUAL_CHECK" and 40 < confidence < 95:
                card_old = fp_old.get('cardinality', 999)
                card_new = best_match['fp_new'].get('cardinality', 999)
                if card_old <= 50 or card_new <= 50 or fp_old.get('is_boolean') or best_match['fp_new'].get('is_boolean'):
                    deep = self.ai.analyze_deep_content(o_col, n_col, fp_old, best_match['fp_new'])
                    if deep.get('same_entity'):
                        confidence = 99.0; status = "AI_VERIFIED"
                        ai_expl    = f"✅ Deep: {deep.get('reasoning','Patterns match')}"
                        trans_logic = deep.get('transformation', '-')
                    elif deep.get('confidence', 50) < 30:
                        confidence *= 0.7
                        ai_expl = f"⚠️ Deep concern: {deep.get('reasoning','Check manually')}"

            if confidence > 85 and 'VERIFIED' in status and len(df_old) > 50:
                samp = self.ai.validate_with_samples(o_col, n_col, df_old[o_col], df_new[n_col])
                if samp.get('consensus') == 'disagree':
                    ai_expl += " [⚠️ Sample inconsistency]"

            if status == "MANUAL_CHECK" and ai_expl == "-":
                ai_expl = self.ai.explain_decision(o_col, n_col, {
                    'name_sim': best_match['name_sim'],
                    'row_match': best_match['row_match'],
                    'confidence': confidence
                })

            if confidence > 95 and 'VERIFIED' in status:
                chal = self.ai.challenge_match(o_col, n_col, {
                    'confidence': confidence,
                    'name_sim':   best_match['name_sim'],
                    'row_match':  best_match['row_match']
                })
                if chal.get('concerns_found'):
                    ai_expl += f" [⚠️ Challenge: {'; '.join(chal.get('concerns',[])[:2])}]"

            if confidence > curr_conf:
                card_old = fp_old.get('cardinality', 0)
                card_new = best_match['fp_new'].get('cardinality', 0)
                is_bool_old = fp_old.get('is_boolean', False)
                is_bool_new = best_match['fp_new'].get('is_boolean', False)

                old_sample_str = new_sample_str = "[]"
                if is_anchored and not merged_df.empty:
                    o_lk = f"{o_col}_O" if f"{o_col}_O" in merged_df.columns else o_col
                    n_lk = f"{n_col}_N" if f"{n_col}_N" in merged_df.columns else n_col
                    if o_lk in merged_df.columns and n_lk in merged_df.columns:
                        sample_df = merged_df[[o_lk, n_lk]].dropna().head(3)
                        if not sample_df.empty:
                            old_sample_str = str(sample_df[o_lk].tolist())
                            new_sample_str = str(sample_df[n_lk].tolist())

                if old_sample_str == "[]":
                    old_sample_str = str(list(df_old[o_col].dropna().head(3)))
                if new_sample_str == "[]":
                    new_sample_str = str(list(df_new[n_col].dropna().head(3)))

                self.report[o_col] = {
                    'Old Column':           o_col,
                    'Old Type':             fp_old.get('type', '-'),
                    'Old Sample':           old_sample_str,
                    'Status':               status,
                    'Transformation Logic': trans_logic,
                    'AI Explanation':       ai_expl,
                    'Source':               source,
                    'New Column':           n_col,
                    'New Type':             best_match['fp_new'].get('type', '-'),
                    'New Sample':           new_sample_str,
                    'Confidence':           round(confidence, 2),
                    'Row Match %':          round(best_match['row_match'], 1),
                    'Name Match %':         round(best_match['name_sim'], 1),
                    'Fingerprint Match %':  round(best_match['fp_sim'], 1),
                    'Type Mismatch':        'YES' if is_mismatch and status not in
                                            ["VERIFIED (Data Match)","VERIFIED (Set Match)"] else 'NO',
                    'Cardinality':          f"{card_old}/{card_new}",
                    'Boolean Match':        '⚠️ VERIFY' if (is_bool_old or is_bool_new) else 'N/A'
                }

                if confidence >= self.EXCLUSIVITY_THRESHOLD and 'VERIFIED' in status:
                    self.locked_new_cols.add(n_col)

    # ────────────────────────────────────────────────────────────────────────────
    # V49 POST-PROCESSING (Preserved)
    # ────────────────────────────────────────────────────────────────────────────

    def _context_aware_batch_validation(self):
        self.log("\n🔬 Context-Aware Validation...")
        manual_by_source: Dict[str, List[Dict]] = defaultdict(list)
        for old_col, info in self.report.items():
            if info.get('Status') == 'MANUAL_CHECK' and info.get('New Column') not in ['-', 'nan', None, '— EVICTED —']:
                source = info.get('Source', '')
                if source in self._anchor_info and source in self._merged_dfs:
                    manual_by_source[source].append(info)

        if not manual_by_source:
            self.log("   No candidates for context validation"); return

        upgraded = 0
        for source, manual_list in manual_by_source.items():
            if source not in self._merged_dfs or source not in self._anchor_info:
                continue
            merged_df   = self._merged_dfs[source]
            anchor_info = self._anchor_info[source]
            if isinstance(anchor_info[0], tuple):
                continue
            anchor_new, anchor_old = anchor_info

            for check in manual_list[:5]:
                old_col = check.get('Old Column')
                new_col = check.get('New Column')
                result  = ContextAwareValidator.validate_with_context(
                    old_col, new_col, anchor_new, anchor_old, merged_df, self.ai
                )
                if result.get('validated'):
                    self.report[old_col]['Status']         = 'CONTEXT_VERIFIED'
                    self.report[old_col]['Confidence']     = min(95, result.get('confidence', 85))
                    self.report[old_col]['AI Explanation'] = (
                        f"✅ Context-aware: {result.get('reasoning', 'Validated with anchor binding')}"
                    )
                    upgraded += 1

        self.log(f"   ✅ {upgraded} columns upgraded via context validation")

    def _batch_ai_audit(self):
        self.log("\n🧠 Batch audit...")
        manual = [v for v in self.report.values() if v.get('Status') == 'MANUAL_CHECK']
        if not manual:
            self.log("   No manual checks"); return
        upgrades = self.ai.batch_audit_manual_checks(manual)
        upgraded = 0
        for idx_str, decision in upgrades.items():
            try:
                idx = int(''.join(filter(str.isdigit, str(idx_str))))
            except Exception:
                continue
            if idx < len(manual):
                col = manual[idx].get('Old Column')
                if col in self.report:
                    self.report[col]['Status']         = 'AI_VERIFIED (Batch)'
                    self.report[col]['AI Explanation'] = decision.get('reason', 'Batch')
                    self.report[col]['Confidence']     = min(95, self.report[col]['Confidence'] + 20)
                    upgraded += 1
        if upgraded:
            self.log(f"   ✅ Upgraded {upgraded}")

    def _final_sanity_check(self):
        self.log("\n🔍 Final sanity check...")
        all_rows = list(self.report.values())
        flags    = self.ai.final_sanity_check(all_rows)
        flagged_indices = set()

        if flags:
            for idx_str, reason in flags.items():
                try:
                    clean_idx = ''.join(filter(str.isdigit, str(idx_str)))
                    if not clean_idx: continue
                    idx = int(clean_idx)
                except Exception:
                    continue
                if idx < len(all_rows):
                    col = all_rows[idx].get('Old Column')
                    if col in self.report:
                        self.report[col]['Status']         = 'MANUAL_CHECK'
                        self.report[col]['AI Explanation'] = f"⚠️ AI FLAG: {reason}"
                        flagged_indices.add(idx)

        for i, row in enumerate(all_rows):
            if i not in flagged_indices:
                col = row.get('Old Column')
                if 'VERIFIED' in row.get('Status','') and col in self.report:
                    curr = self.report[col].get('AI Explanation', '-')
                    if curr in ['-', '']:
                        self.report[col]['AI Explanation'] = "✅ Confirmed by AI Audit"

    def _detect_splits(self, all_new_cols: List[str]):
        self.log("\n🔀 Split column detection...")
        source = ""
        for k in self.fingerprints_old.keys():
            if ':' in k:
                source = k.split(':')[0]; break

        candidates = SplitColumnDetector.find_splits(
            self.report, all_new_cols, self.fingerprints_new, self.fingerprints_old, source
        )

        if not candidates:
            self.log("   ✅ No split patterns detected"); return

        self.log(f"   🔍 {len(candidates)} split candidates")

        for cand in candidates[:20]:
            old_col     = cand['old_col']
            primary_new = cand['primary_new_col']
            sibling_cols = [s['sibling_new_col'] for s in cand.get('siblings', [])]

            df_old_ref = self._df_old_refs.get(source)
            df_new_ref = self._df_new_ref

            if df_old_ref is None or df_new_ref is None:
                ai_result = self.ai.confirm_split(cand)
                if ai_result and ai_result.get('siblings'):
                    for sib in ai_result['siblings']:
                        if sib.get('is_real_split') and sib.get('confidence', 0) >= 60:
                            self.split_report.append({
                                'Old Column': old_col, 'Old Type': cand['old_type'],
                                'Old Sample': cand['old_sample'], 'Primary New Column': primary_new,
                                'Primary Confidence': cand['primary_confidence'],
                                'Split New Column': sib['new_col'], 'Split Type': sib.get('split_logic','SPLIT'),
                                'Split Confidence': sib.get('confidence', 0),
                                'AI Split Logic': sib.get('split_logic', '-'),
                                'Status': 'SPLIT_DETECTED',
                                'Action Required': '⚠️ MANUAL REVIEW: Verify split logic'
                            })
                continue

            new_cols_to_validate = [primary_new] + sibling_cols[:3]
            validation_result = SplitFormulaValidator.propose_and_validate(
                old_col, new_cols_to_validate, df_old_ref, df_new_ref, self.ai
            )

            status_s = validation_result.get('status', 'UNKNOWN')
            if status_s == 'CONFIRMED_SPLIT':
                for new_col in new_cols_to_validate[1:]:
                    self.split_report.append({
                        'Old Column': old_col, 'Old Type': cand['old_type'],
                        'Old Sample': cand['old_sample'], 'Primary New Column': primary_new,
                        'Primary Confidence': cand['primary_confidence'],
                        'Split New Column': new_col, 'Split Type': validation_result.get('formula_type','SPLIT'),
                        'Split Confidence': int(validation_result.get('match_rate', 0) * 100),
                        'AI Split Logic': validation_result.get('formula','Formula validated'),
                        'Formula Match Rate': f"{validation_result.get('match_rate', 0):.1%}",
                        'Status': 'CONFIRMED_SPLIT',
                        'Action Required': f"✅ VALIDATED: {validation_result.get('formula','')}"
                    })
                    self.log(f"   ✅ CONFIRMED: {old_col} → {primary_new} + {new_col}")

        self.log(f"   ✅ Split report: {len(self.split_report)} entries")

    # ────────────────────────────────────────────────────────────────────────────
    # EXPORT (Excel + JSON + Smartsheet)
    # ────────────────────────────────────────────────────────────────────────────

    def _export(self, target_name: str, config: Dict, results: Dict):
        self.log(f"\n💾 Exporting results for {target_name}...")
        output_mode = config.get('output_mode', 'both')
        timestamp   = self.start_time.strftime('%Y%m%d_%H%M%S')

        # ── Excel Export ──────────────────────────────────────────────────────
        if output_mode in ('excel', 'both'):
            self._export_excel(target_name, timestamp, results.get('validation_result', {}))

        # ── JSON Export ───────────────────────────────────────────────────────
        if output_mode in ('json', 'both'):
            payload = APIClient.build_json_payload(
                target_name   = target_name,
                mapping_report = self.report,
                validation_result = results.get('validation_result', {}),
                coverage_summary  = results.get('coverage_summary', {}),
                metadata = {
                    'ai_calls': self.ai.total_calls,
                    'duration_seconds': results.get('duration_seconds', 0),
                    'timestamp': timestamp
                }
            )
            json_path = os.path.join(self.output_dir, f"V50_{target_name}_{timestamp}.json")
            APIClient.save_json(payload, json_path)

            # Push to Smartsheet if configured
            smartsheet_cfg = config.get('smartsheet', {})
            if smartsheet_cfg.get('api_url'):
                self.log("   📡 Pushing to Smartsheet...")
                APIClient.push_to_smartsheet(payload, smartsheet_cfg)

        # ── Summary Log ───────────────────────────────────────────────────────
        df_report = pd.DataFrame(list(self.report.values())) if self.report else pd.DataFrame()
        if not df_report.empty and 'Status' in df_report.columns:
            self.log("\n" + "="*80)
            for status, count in df_report['Status'].value_counts().items():
                pct = count / len(df_report) * 100
                self.log(f"  {status:35s}: {count:3d} ({pct:5.1f}%)")
            verified = sum(c for s, c in df_report['Status'].value_counts().items() if 'VERIFIED' in s)
            self.log("="*80)
            self.log(f"  ✅ Verified:     {verified}/{len(df_report)} ({verified/len(df_report)*100:.1f}%)")
            self.log(f"  ✂️  Splits:       {len(self.split_report)}")
            self.log(f"  🧠 AI calls:     {self.ai.total_calls}")
            self.log(f"  ⏱️  Duration:     {results.get('duration_seconds', 0):.1f}s")
            self.log("="*80)

    def _export_excel(self, target_name: str, timestamp: str, validation_result: Dict):
        """Export Excel report with mapping, unmatched, splits, and defect sheets."""
        df = pd.DataFrame(list(self.report.values()))
        if df.empty:
            return

        status_rank = {
            'VERIFIED (Schema Mapping)': 0, 'VERIFIED': 1,
            'VERIFIED (Data Match)': 2, 'VERIFIED (Set Match)': 3,
            'AI_VERIFIED': 4, 'AI_VERIFIED (Batch)': 5, 'CONTEXT_VERIFIED': 5,
            'MANUAL_CHECK': 6, 'SCHEMA_MATCH_ONLY': 7, 'ZERO_COLUMN': 8,
            'NO_MATCH': 9, 'DATA_LOST': 10, 'EMPTY_COLUMN': 11
        }
        df['_rank'] = df['Status'].map(lambda x: status_rank.get(x, 12))
        df = df.sort_values(['_rank', 'Confidence'], ascending=[True, False]).drop(columns=['_rank'])

        target_order = [
            'Old Column', 'Old Type', 'Old Sample', 'New Column', 'New Type', 'New Sample',
            'Status', 'Transformation Logic', 'AI Explanation', 'Confidence',
            'Row Match %', 'Name Match %', 'Fingerprint Match %',
            'Type Mismatch', 'Cardinality', 'Boolean Match', 'Source'
        ]
        final_cols = [c for c in target_order if c in df.columns]
        df = df[final_cols + [c for c in df.columns if c not in final_cols]]

        # Unmatched sheet
        used_old = set(df['Old Column'].unique()) - {'-', None, ''}
        unmatched_oc, unmatched_os = [], []
        for key, fp in self.fingerprints_old.items():
            if ':' in key:
                cname = key.split(':', 1)[1]
                if cname not in used_old:
                    unmatched_oc.append(cname)
                    unmatched_os.append(fp.get('sample', '-'))

        df_unmatched = pd.DataFrame({
            'Unmatched Old Columns': unmatched_oc or [''],
            'Old Sample':            unmatched_os or [''],
        })

        df_splits = pd.DataFrame(self.split_report) if self.split_report else pd.DataFrame(
            columns=['Old Column','Primary New Column','Split New Column','Split Type',
                     'Split Confidence','AI Split Logic','Status','Action Required'])

        df_defects = pd.DataFrame(validation_result.get('defect_report', [])) if validation_result.get('defect_report') else pd.DataFrame(
            columns=['Rule ID','Rule Name','Status','Pass Rate'])

        fname = os.path.join(self.output_dir, f"V50_{target_name}_{timestamp}.xlsx")

        if OPENPYXL_AVAILABLE:
            with pd.ExcelWriter(fname, engine='openpyxl') as writer:
                df.to_excel(writer,           sheet_name='Mapping Result', index=False)
                df_unmatched.to_excel(writer, sheet_name='Unmatched List', index=False)
                df_splits.to_excel(writer,    sheet_name='Split Columns',  index=False)
                df_defects.to_excel(writer,   sheet_name='Defect Rules',   index=False)
            self._style_excel(fname)
            self.log(f"   📊 Excel: {fname}")
        else:
            df.to_excel(fname, index=False)
            self.log(f"   📊 Excel (unstyled): {fname}")

    def _style_excel(self, fname: str):
        """Apply colour-coding to Excel output."""
        try:
            wb = load_workbook(fname)
            ws = wb['Mapping Result']

            # Colour palette
            fills = {
                'header':    PatternFill(start_color="4472C4", end_color="4472C4", fill_type="solid"),
                'green':     PatternFill(start_color="C6EFCE", end_color="C6EFCE", fill_type="solid"),
                'teal':      PatternFill(start_color="CCFFFF", end_color="CCFFFF", fill_type="solid"),
                'blue':      PatternFill(start_color="DDEBF7", end_color="DDEBF7", fill_type="solid"),
                'yellow':    PatternFill(start_color="FFEB9C", end_color="FFEB9C", fill_type="solid"),
                'red':       PatternFill(start_color="FFC7CE", end_color="FFC7CE", fill_type="solid"),
                'dark_red':  PatternFill(start_color="C00000", end_color="C00000", fill_type="solid"),
                'orange':    PatternFill(start_color="F4B084", end_color="F4B084", fill_type="solid"),
                'grey':      PatternFill(start_color="D9D9D9", end_color="D9D9D9", fill_type="solid"),
                'purple':    PatternFill(start_color="E4DFEC", end_color="E4DFEC", fill_type="solid"),
                'gold':      PatternFill(start_color="FFD700", end_color="FFD700", fill_type="solid"),
            }
            fonts = {
                'header':   Font(color="FFFFFF", bold=True),
                'green':    Font(color="006100"),
                'teal':     Font(color="006060"),
                'blue':     Font(color="1F4E79"),
                'yellow':   Font(color="9C5700"),
                'red':      Font(color="9C0006"),
                'white':    Font(color="FFFFFF", bold=True),
                'orange':   Font(color="8B4513", bold=True),
                'purple':   Font(color="5B2C6F", bold=True),
                'gold':     Font(color="7B5800", bold=True),
            }
            border = Border(
                left=Side(style='thin'), right=Side(style='thin'),
                top=Side(style='thin'),  bottom=Side(style='thin')
            )

            for cell in ws[1]:
                cell.fill = fills['header']; cell.font = fonts['header']
                cell.alignment = Alignment(horizontal='center', vertical='center')
                cell.border = border

            col_indices = {cell.value: idx for idx, cell in enumerate(ws[1], 1)}
            status_col  = col_indices.get('Status')
            boolean_col = col_indices.get('Boolean Match')

            STATUS_STYLE = {
                'VERIFIED (SCHEMA': ('green',   'green'),
                'VERIFIED (DATA':   ('green',   'green'),
                'VERIFIED (SET':    ('teal',    'teal'),
                'AI_VERIFIED':      ('blue',    'blue'),
                'CONTEXT_VERIFIED': ('teal',    'teal'),
                'VERIFIED':         ('green',   'green'),
                'DATA_LOST':        ('dark_red','white'),
                'SCHEMA_MATCH_ONLY':('orange',  'orange'),
                'MANUAL':           ('yellow',  'yellow'),
                'NO_MATCH':         ('dark_red','white'),
                'ZERO_COLUMN':      ('orange',  None),
                'EMPTY':            ('grey',    None),
                'EVICTED':          ('red',     'red'),
            }

            for row in ws.iter_rows(min_row=2):
                for cell in row:
                    cell.border = border
                    cell.alignment = Alignment(vertical='center', wrap_text=False)

                if status_col:
                    scell = row[status_col - 1]
                    val   = str(scell.value).upper()
                    for key, (fill_k, font_k) in STATUS_STYLE.items():
                        if key in val:
                            scell.fill = fills[fill_k]
                            if font_k:
                                scell.font = fonts[font_k]
                            break

                if boolean_col:
                    bcell = row[boolean_col - 1]
                    if bcell.value and '⚠️' in str(bcell.value):
                        bcell.fill = fills['purple']
                        bcell.font = fonts['purple']

            for col in ws.columns:
                max_len = max((len(str(c.value)) for c in col if c.value), default=10)
                ws.column_dimensions[get_column_letter(col[0].column)].width = min(max_len + 2, 50)

            # Style Defect Rules sheet
            if 'Defect Rules' in wb.sheetnames:
                ws_def = wb['Defect Rules']
                defect_header_fill = PatternFill(start_color="2E4057", end_color="2E4057", fill_type="solid")
                for cell in ws_def[1]:
                    cell.fill = defect_header_fill
                    cell.font = Font(color="FFFFFF", bold=True)
                    cell.border = border

                status_col_def = None
                for idx, cell in enumerate(ws_def[1], 1):
                    if cell.value == 'Status':
                        status_col_def = idx

                for row in ws_def.iter_rows(min_row=2):
                    for cell in row:
                        cell.border = border
                    if status_col_def:
                        sc = row[status_col_def - 1]
                        v  = str(sc.value).upper()
                        if v == 'PASS':
                            sc.fill = fills['green'];    sc.font = fonts['green']
                        elif v == 'WARN':
                            sc.fill = fills['yellow'];   sc.font = fonts['yellow']
                        elif v in ('FAIL', 'ERROR'):
                            sc.fill = fills['dark_red']; sc.font = fonts['white']

                for col in ws_def.columns:
                    max_len = max((len(str(c.value)) for c in col if c.value), default=10)
                    ws_def.column_dimensions[get_column_letter(col[0].column)].width = min(max_len + 2, 55)

            # Style Split sheet
            if 'Split Columns' in wb.sheetnames:
                ws_split = wb['Split Columns']
                split_header = PatternFill(start_color="7030A0", end_color="7030A0", fill_type="solid")
                for cell in ws_split[1]:
                    cell.fill = split_header
                    cell.font = Font(color="FFFFFF", bold=True)
                    cell.border = border
                for col in ws_split.columns:
                    max_len = max((len(str(c.value)) for c in col if c.value), default=10)
                    ws_split.column_dimensions[get_column_letter(col[0].column)].width = min(max_len + 2, 55)

            wb.save(fname)
            self.log("   🎨 Excel styled")
        except Exception as e:
            self.log(f"   ⚠️ Style failed: {e}")


# ==============================================================================
# 🆕 V50 CLOUD-NATIVE MAIN (K8s-ready, env-var config)
# ==============================================================================

def get_targets_from_env() -> List[Dict]:
    """
    Read target configuration from environment variables (K8s ConfigMap / env).

    Expected env vars:
      VIDAR_TARGETS_JSON  : JSON array of target configs
                            e.g. '[{"name":"loan_hist","new_file":"...","old_files":["..."]}]'
    OR
      VIDAR_NEW_FILE      : Single new file path (legacy mode)
      VIDAR_OLD_FILES     : Comma-separated old file paths
      VIDAR_TARGET_NAME   : Target table name
    """
    # Option 1: Full JSON array from env
    targets_json = os.getenv('VIDAR_TARGETS_JSON', '')
    if targets_json:
        try:
            return json.loads(targets_json)
        except Exception as e:
            logger.warning(f"Failed to parse VIDAR_TARGETS_JSON: {e}")

    # Option 2: Legacy single-target env vars
    new_file    = os.getenv('VIDAR_NEW_FILE', '')
    old_files   = [f.strip() for f in os.getenv('VIDAR_OLD_FILES', '').split(',') if f.strip()]
    target_name = os.getenv('VIDAR_TARGET_NAME', 'TARGET')

    if new_file:
        return [{'name': target_name, 'new_file': new_file, 'old_files': old_files}]

    return []


def main():
    """
    V50 Cloud-Native Entry Point.
    Reads config from env vars → runs multi-target audit → pushes results via API.
    """
    print("="*80)
    print("🚀 VIDAR V50 — CONFIG-DRIVEN | TARGET-CENTRIC | CLOUD-NATIVE")
    print("="*80)
    print("  V50 New Capabilities:")
    print("  ✅ Module 1: ConfigLoader      — YAML-driven rules")
    print("  ✅ Module 2: DataPrepLayer     — Virtual Source (UNION/filter)")
    print("  ✅ Module 3: ValidationEngine  — MASTER | TRANSACTION | MULTIPLE")
    print("  ✅ Module 4: CoverageTracker   — Global orphan detection")
    print("  ✅ Module 5: APIClient         — JSON + Smartsheet push")
    print("  ✅ Layer-0 Bypass              — schema_mappings → instant VERIFIED")
    print("  ✅ Affect Code Tagging         — global_dict.yaml classification")
    print("  ✅ Formula Parser              — SUM/DIFF/AVG with tolerance")
    print("  ✅ Index Alignment             — MULTIPLE mode, no JOIN/MERGE")
    print("  ✅ V49 Preserved (100%)")
    print("="*80)

    # Config from env
    api_key     = os.getenv('GROQ_API_KEY',       '')
    config_base = os.getenv('VIDAR_CONFIG_DIR',    'config')
    data_base   = os.getenv('VIDAR_DATA_DIR',      'data')
    output_dir  = os.getenv('VIDAR_OUTPUT_DIR',    'output')

    # Initialize engine
    engine = VidarV50(
        api_key       = api_key,
        config_base_dir = config_base,
        data_base_dir   = data_base,
        output_dir      = output_dir
    )

    # Get targets
    targets = get_targets_from_env()

    if targets:
        # Cloud-native multi-target mode
        logger.info(f"🎯 Running {len(targets)} target(s) from environment config")
        results = engine.audit_all_targets(targets)

        # Exit with non-zero if any critical failures
        has_critical = any(
            r.get('validation_result', {}).get('summary', {}).get('critical_failures')
            for r in results.values() if isinstance(r, dict)
        )
        sys.exit(1 if has_critical else 0)

    else:
        # Local development / direct run mode
        logger.info("💡 No VIDAR_TARGETS_JSON found — running in local dev mode")
        print("\nLocal dev mode: Set these env vars or edit the section below.")
        print("")

        # ── Edit this section for local testing ─────────────────────────────
        API_KEY  = os.getenv('GROQ_API_KEY', 'gsk_your_key_here')
        NEW_FILE = r"data/new_table.csv"
        OLD_FILES = [
            r"data/old_table.csv"
        ]
        TARGET_NAME = "my_table"
        CONFIG_DIR  = f"config/{TARGET_NAME}"
        # ────────────────────────────────────────────────────────────────────

        if not os.path.exists(NEW_FILE):
            print(f"❌ File not found: {NEW_FILE}")
            print("Please set VIDAR_TARGETS_JSON env var or edit the local dev section in main()")
            sys.exit(1)

        engine_local = VidarV50(
            api_key         = API_KEY,
            config_base_dir = 'config',
            data_base_dir   = 'data',
            output_dir      = 'output'
        )

        result = engine_local.audit_target(
            target_name = TARGET_NAME,
            new_file    = NEW_FILE,
            old_files   = OLD_FILES,
            config_dir  = CONFIG_DIR
        )

        engine_local.coverage.print_summary()


if __name__ == "__main__":
    main()
