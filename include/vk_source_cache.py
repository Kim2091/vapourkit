"""App-owned BestSource indexes with cross-process reader leases.

No GPU/model imports in the cleanup process. OS locks survive graph references
and release even when a preview/encode process is forcibly terminated.
"""
from contextlib import contextmanager
import errno
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import uuid

_leases = {}


def folder(root, source):
    canonical = os.path.normcase(os.path.realpath(source))
    return Path(root) / hashlib.sha256(canonical.encode('utf8')).hexdigest()


def lock(stream, unlock=False):
    stream.seek(0)
    if os.name == 'nt':
        import msvcrt
        msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK if unlock else msvcrt.LK_NBLCK, 1)
    else:
        import fcntl
        fcntl.flock(stream, fcntl.LOCK_UN if unlock else fcntl.LOCK_EX | fcntl.LOCK_NB)


def lock_file(file):
    stream = open(file, 'a+b')
    stream.seek(0, 2)
    if not stream.tell(): stream.write(b'\0'); stream.flush()
    return stream


@contextmanager
def gate(directory):
    directory.mkdir(parents=True, exist_ok=True)
    with lock_file(directory / 'gate.lock') as stream:
        deadline = time.monotonic() + 10
        while True:
            try: lock(stream); break
            except OSError as error:
                if error.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK): raise
                if time.monotonic() > deadline: raise RuntimeError('Source index cache is busy') from error
                time.sleep(0.05)
        try: yield
        finally: lock(stream, unlock=True)


def video_source(source, root=None, cachemode=3, **kwargs):
    import vapoursynth as vs
    root = root or os.environ.get('VK_SOURCE_CACHE_ROOT')
    if cachemode not in (3, 4): raise ValueError('Managed source indexes require cachemode 3 or 4')
    if not root: return vs.core.bs.VideoSource(source=source, cachemode=cachemode, **kwargs)
    os.environ['VK_SOURCE_CACHE_ROOT'] = str(root)
    directory = folder(root, source)
    key = str(directory)
    if key not in _leases:
        with gate(directory):
            lease = lock_file(directory / ('reader-' + str(os.getpid()) + '-' + uuid.uuid4().hex + '.lock'))
            lock(lease)
            _leases[key] = lease
        print('[vk-source-cache] source=' + json.dumps(os.path.realpath(source)), file=sys.stderr, flush=True)
    return vs.core.bs.VideoSource(source=source, cachemode=cachemode, cachepath=str(directory / 'index'), **kwargs)


def sweep(root, complete=(), keep=(), retain=()):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    for source in retain:
        directory = folder(root, source)
        if directory.exists():
            with gate(directory): (directory / 'cleanup.pending').unlink(missing_ok=True)
    for source in complete:
        directory = folder(root, source)
        with gate(directory):
            (directory / 'cleanup.pending').touch()
    held = {folder(root, source) for source in keep}
    cleaned, deferred = 0, 0
    for pending in root.glob('*/cleanup.pending'):
        directory = pending.parent
        if directory in held: deferred += 1; continue
        with gate(directory):
            active = False
            for file in directory.glob('reader-*.lock'):
                try:
                    with lock_file(file) as lease: lock(lease)
                    file.unlink(missing_ok=True)
                except OSError as error:
                    if error.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK): raise
                    active = True
            if active: deferred += 1; continue
            # Never remove source-adjacent/user indexes, engine caches, or
            # recursively follow arbitrary paths. This directory is app-owned.
            for file in directory.glob('index*.bsindex'):
                if file.is_file() and not file.is_symlink(): file.unlink()
            pending.unlink(missing_ok=True)
            cleaned += 1
    return {'cleaned': cleaned, 'deferred': deferred}


if __name__ == '__main__':
    request = json.load(sys.stdin)
    print(json.dumps(sweep(sys.argv[1], request.get('complete', []), request.get('keep', []), request.get('retain', []))))
