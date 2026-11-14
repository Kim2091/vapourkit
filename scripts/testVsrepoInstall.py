
"""Real Windows VSRepo installation smoke test in a disposable CPU-only runtime."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import venv

ROOT = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='Vapourkit filter install ') as temp:
    root = Path(temp)
    venv.EnvBuilder(with_pip=True).create(root / 'python')
    python = root / 'python' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    subprocess.run([str(python), '-m', 'pip', 'install', 'vapoursynth==79'], check=True)
    site = subprocess.check_output([str(python), '-c', "import sysconfig;print(sysconfig.get_path('purelib'))"], text=True).strip()
    plugins = str(Path(site) / 'vapoursynth' / 'plugins')
    environment = {**os.environ, 'VK_VSREPO_PYTHON': str(python), 'VK_VSREPO_ROOT': str(root / 'data'), 'VK_VSREPO_PLUGINS': plugins}
    subprocess.run(['npm.cmd' if os.name == 'nt' else 'npm', 'run', 'test:electron', '--', 'electron/filterRepository.integration.test.ts'], cwd=ROOT, env=environment, check=True)
