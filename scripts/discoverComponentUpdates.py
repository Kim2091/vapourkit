"""Read upstream metadata into a review artifact; never install or publish it."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
from urllib.request import Request, urlopen


def candidates(source):
    headers = {'User-Agent': 'vapourkit-component-discovery', 'Accept': 'application/json'}
    if source['url'].startswith('https://api.github.com/') and os.environ.get('GITHUB_TOKEN'):
        headers['Authorization'] = 'Bearer ' + os.environ['GITHUB_TOKEN']
    try:
        with urlopen(Request(source['url'], headers=headers), timeout=30) as response:
            raw = response.read(24 * 1024 * 1024 + 1)
        if len(raw) > 24 * 1024 * 1024: raise ValueError('Metadata exceeded size limit')
        data = json.loads(raw)
        if source['kind'] == 'pypi':
            version = data['info']['version']
            result = [{'version': version, 'url': data['info']['package_url']}]
        elif source['kind'] == 'github-tags':
            result = [{'version': item['name'], 'commit': item['commit']['sha']} for item in data if re.fullmatch(source['pattern'], item['name'])]
        else:
            result = [{'version': item['tag_name'], 'prerelease': item['prerelease'], 'date': item['published_at'], 'url': item['html_url']} for item in data if not item['draft']][:12]
        return {'source': source['name'], 'candidates': result, 'status': 'review-required'}
    except Exception as error:
        return {'source': source['name'], 'status': 'unavailable', 'error': str(error)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    sources = json.loads((root / 'include/component-sources.json').read_text())
    with ThreadPoolExecutor(max_workers=4) as pool: results = list(pool.map(candidates, sources))
    result = {'checkedAt': datetime.now(timezone.utc).isoformat(), 'policy': 'Candidate discovery only. Validate compatibility, licenses, hashes and GPU fixtures before changing component-catalog.json.', 'sources': results}
    Path(args.output).write_text(json.dumps(result, indent=2) + '\n')
    print('Checked', len(results), 'sources;', sum(s['status'] == 'unavailable' for s in results), 'unavailable. Nothing was installed or approved.')

if __name__ == '__main__': main()
