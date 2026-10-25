#!/usr/bin/env python3
"""Build static/fixed_responses/vaultedRelicDrops.json for SpaceNinjaServer.

For every relic that is vaulted in warframe-public-export-plus, find the LAST official drop table it appeared in
(history of DE's drop tables as archived by https://github.com/WFCD/warframe-drop-data, file data/missionRewards.json)
and record where it dropped then: node -> the node's current reward manifest, rotation (A/B/C) and chance.

Usage (any OS, python 3.9+, git):
    git clone --filter=blob:none https://github.com/WFCD/warframe-drop-data
    python scripts/build-vaulted-relic-drops.py --drop-data warframe-drop-data \
        --export ../warframe-public-export-plus --out static/fixed_responses/vaultedRelicDrops.json

Output format:
    { "<reward manifest>": { "0": [ {"type": "/Lotus/StoreItems/Types/Game/Projections/...", "probability": <0..1>,
                                     "lastSeen": "YYYY-MM-DD", "nodes": ["SolNode94", ...]} ], "1": [...], "2": [...] },
      ..., "_meta": {...} }
    Entries with "fallback": true are relics with no mission drop on record (vaulted before July 2017 or never
    farmable from missions); they are placed in every table rotation that currently drops relics of the same era,
    at the median probability of those same-era relics.
"""
import argparse, collections, json, os, re, subprocess, sys

RELIC = re.compile(r'^(Lith|Meso|Neo|Axi|Requiem)\s+([A-Z]\d+)\s+Relic(?:\s*\((\w+)\))?$')
QUALITY = {None: 'VPQ_BRONZE', 'Intact': 'VPQ_BRONZE', 'Exceptional': 'VPQ_SILVER', 'Flawless': 'VPQ_GOLD', 'Radiant': 'VPQ_PLATINUM'}
ROT = {'A': '0', 'B': '1', 'C': '2', None: '0'}


def _it(it):
    if isinstance(it, str):
        return it, 0.0
    return it.get('itemName', '') or '', float(it.get('chance') or 0)


def rows(mr):
    """Yield (planet, node, rotation|None, itemName, chance) from any missionRewards.json version."""
    if isinstance(mr, list):  # 2017 flat format
        for r in mr:
            yield (r.get('planet'), r.get('location'), r.get('rotation')) + _it(r)
        return
    for planet, nodes in mr.items():
        for node, v in nodes.items():
            rw = v.get('rewards')
            if isinstance(rw, list):
                for it in rw:
                    yield (planet, node, None) + _it(it)
            elif isinstance(rw, dict):
                for rot, items in rw.items():
                    for it in items or []:
                        yield (planet, node, rot) + _it(it)


def history(repo):
    log = subprocess.run(['git', '-C', repo, 'log', '--format=%H %ad', '--date=short', '--', 'data/missionRewards.json'],
                         capture_output=True, text=True, check=True).stdout.split('\n')
    for line in reversed([l for l in log if l.strip()]):  # oldest first
        h, date = line.split()
        blob = subprocess.run(['git', '-C', repo, 'show', f'{h}:data/missionRewards.json'], capture_output=True, check=True).stdout
        yield date, json.loads(blob)['missionRewards']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--drop-data', required=True, help='clone of WFCD/warframe-drop-data')
    ap.add_argument('--export', required=True, help='warframe-public-export-plus folder')
    ap.add_argument('--out', required=True)
    a = ap.parse_args()

    ld = lambda n: json.load(open(os.path.join(a.export, n), encoding='utf-8'))
    relics, rewards, regions, en = ld('ExportRelics.json'), ld('ExportRewards.json'), ld('ExportRegions.json'), ld('dict.en.json')

    by_name = {}  # (era, category, quality) -> uniqueName
    for k, v in relics.items():
        by_name[(v['era'], v['category'], v['quality'])] = k

    # relics already in today's tables don't need restoring
    current = set()
    for tbl in rewards.values():
        for rot in tbl:
            for it in rot:
                current.add(it['type'].replace('/Lotus/StoreItems/', '/Lotus/', 1))

    node_of = {}  # (planet, node) -> SolNode
    for sol, r in regions.items():
        node_of[(en.get(r.get('systemName', ''), '').lower(), en.get(r['name'], '').lower())] = sol

    last = {}  # relic uniqueName -> (date, [(planet, node, rot, chance)])
    for date, mr in history(a.drop_data):
        seen = collections.defaultdict(list)
        for planet, node, rot, name, chance in rows(mr):
            m = RELIC.match(name)
            if not m:
                continue
            key = (m.group(1), m.group(2), QUALITY.get(m.group(3), 'VPQ_BRONZE'))
            if key in by_name:
                seen[by_name[key]].append((planet, node, rot, chance))
        for relic, locs in seen.items():
            last[relic] = (date, locs)  # later snapshots overwrite earlier ones

    out = collections.defaultdict(lambda: collections.defaultdict(dict))
    stats = collections.Counter(); unmapped = collections.Counter()
    for relic, (date, locs) in sorted(last.items()):
        if relic in current or not relics[relic].get('vaultedAt'):
            stats['skipped_not_vaulted'] += 1
            continue
        placed = False
        for planet, node, rot, chance in locs:
            sol = node_of.get(((planet or '').lower(), (node or '').lower()))
            if not sol:
                unmapped[f'{planet}/{node}'] += 1
                continue
            for manifest in regions[sol].get('rewardManifests', []):
                if manifest not in rewards:
                    continue
                ri = ROT.get(rot, '0')
                if int(ri) >= len(rewards[manifest]):
                    ri = str(len(rewards[manifest]) - 1)
                e = out[manifest][ri].setdefault(relic, {'type': relic, 'probability': 0.0, 'lastSeen': date, 'nodes': []})
                e['probability'] = max(e['probability'], round(chance / 100, 6))
                if sol not in e['nodes']:
                    e['nodes'].append(sol)
                placed = True
        stats['restored' if placed else 'no_current_node'] += 1

    # Fallback for vaulted intact relics with no mission history at all.
    placed = {r for rots in out.values() for lst in rots.values() for r in lst}
    era_slots = collections.defaultdict(list)  # era -> [(manifest, rot, median probability)]
    for manifest, tbl in rewards.items():
        for ri, rot in enumerate(tbl):
            by_era = collections.defaultdict(list)
            for it in rot:
                t = it['type'].replace('/Lotus/StoreItems/', '/Lotus/', 1)
                if t in relics and it.get('probability'):
                    by_era[relics[t]['era']].append(it['probability'])
            for era, ps in by_era.items():
                ps.sort(); era_slots[era].append((manifest, str(ri), ps[len(ps) // 2]))
    nohist = collections.defaultdict(list)  # era -> relics without any mission history
    for relic, v in sorted(relics.items()):
        if v['quality'] != 'VPQ_BRONZE' or not v.get('vaultedAt') or relic in current or relic in placed:
            continue
        nohist[v['era']].append(relic)
    for era, lst in nohist.items():
        slots = era_slots.get(era, [])
        # all fallback relics of an era together weigh as ONE median same-era relic in each slot
        for manifest, ri, p in slots:
            for relic in lst:
                out[manifest][ri][relic] = {'type': relic, 'probability': round(p / len(lst), 8), 'fallback': True, 'nodes': []}
        stats['fallback_by_era' if slots else 'unplaceable'] += len(lst)

    vaulted_total = sum(1 for k, v in relics.items() if v['quality'] == 'VPQ_BRONZE' and v.get('vaultedAt') and k not in current)
    def store(t):
        return t.replace('/Lotus/', '/Lotus/StoreItems/', 1)
    result = {m: {r: [dict(e, type=store(e['type'])) for e in sorted(v.values(), key=lambda x: x['type'])]
                  for r, v in sorted(rots.items())} for m, rots in sorted(out.items())}
    result['_meta'] = {
        'source': 'WFCD/warframe-drop-data data/missionRewards.json history (official DE drop tables)',
        'vaultedIntactRelicsInExport': vaulted_total, 'stats': dict(stats),
        'unmappedNodes': dict(unmapped.most_common()),
    }
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    json.dump(result, open(a.out, 'w', encoding='utf-8'), separators=(',', ':'))
    print(json.dumps(result['_meta']['stats']), 'vaulted in export:', vaulted_total, '| manifests:', len(result) - 1,
          '| unmapped node names:', len(unmapped), file=sys.stderr)


if __name__ == '__main__':
    main()
