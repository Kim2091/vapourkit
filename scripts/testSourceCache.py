"""Real BestSource indexes: completed-only cleanup, queue holds and OS reader locks."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'include'))
import vk_source_cache as cache


def main():
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        import imageio_ffmpeg
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    with tempfile.TemporaryDirectory(prefix='Vapourkit index lifecycle ') as temporary:
        root = Path(temporary); indexes = root/'managed'; video = root/'input.mkv'
        subprocess.run([ffmpeg,'-v','error','-f','lavfi','-i','testsrc2=size=64x64:rate=24','-frames:v','16','-c:v','libx264','-preset','ultrafast','-y',str(video)],check=True,timeout=30)
        legacy = Path(str(video)+'.0.bsindex'); legacy.write_bytes(b'pre-existing user index')
        script = f"import sys\nsys.path.insert(0,{str(ROOT/'include')!r})\nimport vk_source_cache as c\nclip=c.video_source({str(video)!r},root={str(indexes)!r},cachemode=4)\nclip.get_frame(0)\nprint('READY',flush=True)\nsys.stdin.readline()\n"
        children = []
        try:
            for _ in range(2):
                child = subprocess.Popen([sys.executable,'-I','-c',script],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
                children.append(child)
                assert child.stdout.readline().strip()=='READY', child.stderr.read() if child.poll() is not None else 'Reader did not start'
            directory = cache.folder(indexes,video)
            files = list(directory.glob('index*.bsindex'))
            assert files, 'Real BestSource must create its index in the managed folder'
            assert cache.sweep(indexes)=={'cleaned':0,'deferred':0}, 'An unfinished/failed job must retain its indexes'
            assert cache.sweep(indexes,[str(video)])=={'cleaned':0,'deferred':1}
            children[0].kill(); children[0].wait(timeout=10)
            assert cache.sweep(indexes)=={'cleaned':0,'deferred':1}, 'Second preview reader still owns the index'
            children[1].kill(); children[1].wait(timeout=10)
            assert cache.sweep(indexes,keep=[str(video)])=={'cleaned':0,'deferred':1}, 'Pending queue jobs keep the shared index'
            assert cache.sweep(indexes,retain=[str(video)])=={'cleaned':0,'deferred':0}, 'A new attempt supersedes an older completion'
            assert list(directory.glob('index*.bsindex')), 'Cancelled/failed new attempts retain indexes'
            assert cache.sweep(indexes,[str(video)])=={'cleaned':1,'deferred':0}
            assert not list(directory.glob('index*.bsindex'))
            assert legacy.read_bytes()==b'pre-existing user index'
            assert video.is_file()
        finally:
            for child in children:
                if child.poll() is None: child.kill(); child.wait(timeout=10)
                for stream in (child.stdin,child.stdout,child.stderr): stream.close()
        print('PASS: real BestSource indexes stay while readers/queue hold them; completed sources clean up after final reader exit; legacy indexes remain untouched')


if __name__=='__main__': main()
