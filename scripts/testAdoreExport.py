"""Regression against the exact public Adore FP16 export (downloaded, not bundled).

SHA-256 pins the fixture so a replacement release asset cannot silently change
this regression. The model remains under its author's CC BY-NC-SA 4.0 license.
"""
import argparse
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
URL = 'https://github.com/renarchi/Re-SISR/releases/download/Adore/2x_Adore_renarchi_fp16.onnx'
SHA256 = '79e007eda5721cfa596945d5849320e2fad67f8596f9ac31ed06cc8e3ddaf57d'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', type=Path, help='Use an already downloaded copy with the pinned hash')
    parser.add_argument('--electron', action='store_true', help='Also test actual Electron import/package paths')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='Vapourkit Adore ') as temporary:
        model = args.model or Path(temporary) / 'Adore.onnx'
        if not args.model: urllib.request.urlretrieve(URL, model)
        assert hashlib.sha256(model.read_bytes()).hexdigest() == SHA256, 'Adore fixture hash changed'
        sys.path.insert(0, str(ROOT / 'include'))
        import vk_model_runtime as runtime
        contract = runtime.graph_contract(model)
        assert contract['inputs'][0]['shape'][1] == 3
        assert contract['outputs'][0]['shape'][1] == 3
        # Exercise the isolated command used by Electron during import as well.
        import json
        result = subprocess.run([sys.executable, '-I', str(ROOT / 'include' / 'vk_model_runtime.py'), '--inspect-bindings', str(model)], check=True, capture_output=True, text=True)
        assert json.loads(result.stdout)['outputs'][0]['shape'][1] == 3
        import numpy as np
        import onnxruntime as ort
        session = ort.InferenceSession(str(model), providers=['CPUExecutionProvider'])
        data = np.linspace(0, 1, 3 * 64 * 64, dtype=np.float16).reshape(1, 3, 64, 64)
        output = session.run(None, {'input': data})[0]
        assert output.shape == (1, 3, 128, 128), output.shape
        assert np.isfinite(output).all()
        assert hashlib.sha256(model.read_bytes()).hexdigest() == SHA256, 'Source model was modified'
        if args.electron:
            environment = {**os.environ, 'VK_MODEL_TEST_PYTHON': sys.executable, 'VK_ADORE_TEST_MODEL': str(model.resolve())}
            subprocess.run(['npm.cmd' if os.name == 'nt' else 'npm', 'run', 'test:electron', '--', 'electron/modelGraphResolver.integration.test.ts'], cwd=ROOT, env=environment, check=True)
        print('PASS: official Adore FP16 import inspection, runtime contract, and CPU inference')


if __name__ == '__main__': main()
