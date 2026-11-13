"""Exercise real builder imports under isolated Python, without CUDA dependencies.

Windows CI uses the same CPython embeddable distribution as Vapourkit. GPU work
is stubbed only after executing the actual builder bootstrap.
"""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
DRIVER = r'''
import json, pathlib, runpy, sys, types
builder, source, target = sys.argv[1:]
assert str(pathlib.Path(builder).parent) not in sys.path, sys.path
scope = runpy.run_path(builder)
import vk_model_runtime as runtime
# Windows may expand RUNNER~1 to its long path during bootstrap. Compare files.
assert pathlib.Path(runtime.__file__).samefile(pathlib.Path(builder).with_name('vk_model_runtime.py'))
runtime.runtime_identity = lambda: {'gpu': 'test', 'tensorrt': 'test'}
assert 'fp16' in str(scope['blacklist_path_for']({'save_engine': target}, 'graph', 'fp16'))
sys.modules['tensorrt'] = types.ModuleType('tensorrt')
def build(opts):
    pathlib.Path(opts['save_engine']).write_bytes(b'test-engine')
    return 0
scope['main'].__globals__['build'] = build
runtime.validate_engine = lambda *args: {'schema': 1, 'validation': {'execution': 'stubbed-gpu'}}
assert scope['main'](['--onnx=' + source, '--saveEngine=' + target]) == 0
assert pathlib.Path(target).read_bytes() == b'test-engine'
assert json.loads(pathlib.Path(target + '.json').read_text())['schema'] == 1
print('PASS: isolated builder, precision cache helper import, and candidate publication')
'''


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--download', action='store_true', help='Use Windows CPython 3.13.0 embeddable runtime')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='Vapourkit runtime test ') as temporary:
        root = Path(temporary)
        python = sys.executable
        if args.download:
            archive = root / 'python.zip'
            urllib.request.urlretrieve('https://www.python.org/ftp/python/3.13.0/python-3.13.0-embed-amd64.zip', archive)
            home = root / 'vapoursynth-portable'
            with zipfile.ZipFile(archive) as package: package.extractall(home)
            (home / 'python313._pth').write_text('python313.zip\n.\nLib\\site-packages\nvs-scripts\n')
            python = str(home / 'python.exe')
        data = root / 'data'; data.mkdir()
        for name in ('build_trt_engine.py', 'vk_model_runtime.py'):
            shutil.copyfile(ROOT / 'include' / name, data / name)
        source = data / 'model.onnx'; source.write_bytes(b'stub source; GPU work is replaced after bootstrap')
        # Exercise both caller working directories. -I also disables script-dir
        # discovery on ordinary Python, preventing a false pass on Linux.
        for name in ('manual models', 'workflow temporary'):
            cwd = root / name; cwd.mkdir()
            target = cwd / 'model.engine'
            subprocess.run([python, '-I', '-c', DRIVER, str(data / 'build_trt_engine.py'), str(source), str(target)], cwd=cwd, check=True)
        print('PASS: manual and workflow build environments')


if __name__ == '__main__': main()
