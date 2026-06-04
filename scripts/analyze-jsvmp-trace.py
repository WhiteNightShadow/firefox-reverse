#!/usr/bin/env python3
"""
JSVMP trace post-processor.

Reads NDJSON trace produced by firefox-reverse Phase B (JsvmpTraceCore),
identifies JSVMP dispatcher candidates, dumps function-level analysis.

Usage:
  python3 analyze-jsvmp-trace.py <trace.ndjson>
  python3 analyze-jsvmp-trace.py <trace.ndjson> --dispatcher <sid>
  python3 analyze-jsvmp-trace.py <trace.ndjson> --pc-stream <sid>
"""

import argparse
import json
import sys
from collections import Counter, defaultdict


def parse_trace(path):
    """Parse NDJSON trace file.

    Returns:
      scripts: {sid -> {file, hits, pcs Counter, ops Counter, lines set,
                        pc_min, pc_max}}
      global_ops: Counter of all opcodes (or opnames if available)
      meta: dict from _meta line
    """
    scripts = {}
    global_ops = Counter()
    meta = None

    def get_or_create(sid):
        if sid not in scripts:
            scripts[sid] = {
                'file': '?',
                'hits': 0,
                'pcs': Counter(),
                'ops': Counter(),
                'lines': set(),
                'pc_min': float('inf'),
                'pc_max': -1,
            }
        return scripts[sid]

    with open(path) as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as e:
                print(f"WARN: line {line_no} not JSON: {e}", file=sys.stderr)
                continue

            if '_meta' in obj:
                meta = obj['_meta']
                continue
            if '_script' in obj:
                sid = obj['_script']['sid']
                s = get_or_create(sid)
                s['file'] = obj['_script']['file']
                continue
            if '_warn' in obj:
                continue

            sid = obj.get('sid')
            if not sid:
                continue
            s = get_or_create(sid)
            pc = obj.get('pc', 0)
            op = obj.get('op', 0)
            opname = obj.get('n') or f'op_{op}'  # 'n' from upgraded hook
            line_no_src = obj.get('ln')

            s['hits'] += 1
            s['pcs'][pc] += 1
            s['ops'][opname] += 1
            if line_no_src is not None:
                s['lines'].add(line_no_src)
            s['pc_min'] = min(s['pc_min'], pc)
            s['pc_max'] = max(s['pc_max'], pc)
            global_ops[opname] += 1

    return scripts, global_ops, meta


def score_dispatcher(s):
    """JSVMP dispatcher heuristic score.

    Higher = more likely a dispatcher.
    Signals:
      - high hit count
      - high PC concentration (small effective PC range or repeated PCs)
      - presence of switch/jump-like ops (JumpTarget, Jump, Goto, StrictEq,
        TableSwitch, Case)
      - lambda-per-opcode style (Pop + SetAliasedVar + GetAliasedVar + Lambda)
    """
    hits = s['hits']
    if hits < 100:
        return 0.0

    pc_range = max(1, s['pc_max'] - s['pc_min'])
    unique_pcs = len(s['pcs'])
    # PC reuse ratio = how many times each pc gets hit on average.
    # Dispatcher loop: low unique_pcs / high hits.
    reuse = hits / max(1, unique_pcs)

    ops = s['ops']
    classic_switch = sum(ops.get(o, 0) for o in
                        ('Jump', 'Goto', 'JumpTarget', 'StrictEq',
                         'TableSwitch', 'Case', 'StrictNe'))
    lambda_style = sum(ops.get(o, 0) for o in
                      ('Pop', 'SetAliasedVar', 'GetAliasedVar', 'Lambda',
                       'GetLocal', 'SetLocal'))

    switch_ratio = classic_switch / hits
    lambda_ratio = lambda_style / hits

    # Score: weighted sum
    score = (hits / 1000.0) * 2.0 \
          + reuse * 3.0 \
          + switch_ratio * 50.0 \
          + lambda_ratio * 20.0

    return score


def cmd_summary(args, scripts, global_ops, meta):
    total_events = sum(s['hits'] for s in scripts.values())
    print("=== Trace Summary ===")
    if meta:
        print(f"  PID:    {meta.get('pid')}")
        print(f"  Filter: {meta.get('filter', '(none)')}")
        print(f"  Limit:  {meta.get('limit')}")
    print(f"  Total events:  {total_events}")
    print(f"  Total scripts: {len(scripts)}")
    print()

    print("=== Top opcodes (global) ===")
    for op, n in global_ops.most_common(15):
        pct = 100.0 * n / max(1, total_events)
        print(f"  {op:25s} {n:>8}  ({pct:>5.1f}%)")
    print()

    print("=== Dispatcher candidates (top 5 by score) ===")
    ranked = sorted(scripts.items(), key=lambda kv: -score_dispatcher(kv[1]))
    for sid, s in ranked[:5]:
        score = score_dispatcher(s)
        if score == 0:
            continue
        unique_pcs = len(s['pcs'])
        pc_range = s['pc_max'] - s['pc_min']
        reuse = s['hits'] / max(1, unique_pcs)
        line_range = (min(s['lines']), max(s['lines'])) if s['lines'] else (None, None)
        print(f"  sid={sid}  score={score:.1f}")
        print(f"    file: {s['file']}")
        print(f"    hits={s['hits']}  unique_pcs={unique_pcs}  pc_range=[{s['pc_min']}-{s['pc_max']}]  reuse={reuse:.1f}x")
        if line_range[0]:
            print(f"    source lines: {line_range[0]}-{line_range[1]} (unique={len(s['lines'])})")
        top_ops = ', '.join(f'{o}={n}' for o, n in s['ops'].most_common(5))
        print(f"    top ops: {top_ops}")
        print()

    print("=== All scripts (by hits) ===")
    for sid, s in sorted(scripts.items(), key=lambda kv: -kv[1]['hits']):
        if s['hits'] == 0:
            continue
        print(f"  sid={sid}  hits={s['hits']:>6}  unique_pcs={len(s['pcs']):>4}  file={s['file']}")


def cmd_dispatcher(args, scripts, global_ops, meta):
    """Drill down on a specific sid: show hot PCs + their opnames + source lines."""
    sid = args.dispatcher
    if sid not in scripts:
        print(f"sid {sid} not found", file=sys.stderr)
        sys.exit(1)
    s = scripts[sid]
    print(f"=== Dispatcher analysis: sid={sid} ===")
    print(f"  file: {s['file']}")
    print(f"  hits: {s['hits']}  unique_pcs: {len(s['pcs'])}  range: [{s['pc_min']}-{s['pc_max']}]")
    print()
    print("=== Hot PCs (top 30 by hit count) ===")
    print(f"  {'pc':>6}  {'hits':>6}")
    for pc, n in s['pcs'].most_common(30):
        print(f"  {pc:>6}  {n:>6}")
    print()
    print(f"=== Opcode distribution ===")
    for op, n in s['ops'].most_common(20):
        pct = 100.0 * n / s['hits']
        print(f"  {op:25s} {n:>6}  ({pct:>5.1f}%)")


def cmd_pc_stream(args, scripts, global_ops, meta):
    """Print full pc sequence for a given sid (use for spotting loop pattern)."""
    sid = args.pc_stream
    if sid not in scripts:
        print(f"sid {sid} not found", file=sys.stderr)
        sys.exit(1)
    # Need to re-parse since pc order matters
    with open(args.trace_file) as f:
        for line in f:
            try:
                obj = json.loads(line)
            except Exception:
                continue
            if obj.get('sid') == sid:
                pc = obj.get('pc')
                op = obj.get('op')
                opname = obj.get('n', f'op_{op}')
                ln = obj.get('ln', '?')
                col = obj.get('col', '?')
                print(f"pc={pc:>6} op={op:>3} {opname:20s} L{ln}:{col}")


def main():
    parser = argparse.ArgumentParser(description="JSVMP trace analyzer")
    parser.add_argument('trace_file', help='Path to NDJSON trace')
    parser.add_argument('--dispatcher', metavar='SID',
                       help='Show drill-down for specific sid')
    parser.add_argument('--pc-stream', metavar='SID',
                       help='Print full PC sequence for sid (loop pattern)')
    args = parser.parse_args()

    scripts, global_ops, meta = parse_trace(args.trace_file)

    if args.dispatcher:
        cmd_dispatcher(args, scripts, global_ops, meta)
    elif args.pc_stream:
        cmd_pc_stream(args, scripts, global_ops, meta)
    else:
        cmd_summary(args, scripts, global_ops, meta)


if __name__ == '__main__':
    main()
