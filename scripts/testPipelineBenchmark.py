"""Smoke test all measured stages against real R79 frames and FFmpeg."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT=Path(__file__).resolve().parents[1]

def main():
    import vapoursynth
    vspipe=str(Path(vapoursynth.__file__).parent/('vspipe.exe' if os.name=='nt' else 'vspipe'))
    ffmpeg=shutil.which('ffmpeg')
    if not ffmpeg:
        import imageio_ffmpeg
        ffmpeg=imageio_ffmpeg.get_ffmpeg_exe()
    with tempfile.TemporaryDirectory(prefix='Vapourkit benchmark test ') as directory:
        root=Path(directory); video=root/'input.mkv'
        subprocess.run([ffmpeg,'-v','error','-f','lavfi','-i','testsrc2=size=160x120:rate=24','-frames:v','12','-c:v','libx264','-preset','ultrafast','-y',str(video)],check=True,timeout=30)
        base=f'import vapoursynth as vs\nclip=vs.core.bs.VideoSource(source={str(video)!r},cachemode=3)\n'
        source=root/'source.vpy'; workflow=root/'workflow.vpy'; report=root/'report.json'
        source.write_text(base+'clip.set_output()\n')
        workflow.write_text(base+'clip=vs.core.std.BoxBlur(clip)\nclip.set_output()\n')
        before=workflow.read_bytes()
        bundle=root/'benchmark.json'
        bundle.write_text(json.dumps({'sourceScript':'source.vpy','scripts':{'legacy':'workflow.vpy'},'vspipe':vspipe,'ffmpeg':ffmpeg,'encoderArgs':['-c:v','libx264','-preset','veryfast','-crf','18','-threads','4','-map_metadata','1','-map','1:a?','-c:a','copy']}))
        subprocess.run([sys.executable,str(ROOT/'scripts'/'benchmarkPipeline.py'),'--bundle',str(bundle),'--node',shutil.which('node'),'--frames','8','--runs','1','--requests','1','--threads','2','--compare-preview','--preview-height','180','--preview-fps','5','--output',str(report)],check=True,timeout=120)
        data=json.loads(report.read_text())
        assert data['cases'][0]['frames']==8
        assert set(data['cases'][0]['stages'])=={'decode','filter','encode','combined'}
        assert all(s['medianMs']>0 for s in data['cases'][0]['stages'].values())
        assert data['cases'][0]['stages']['combined']['samples'][0]['producerCode']==0
        assert data['cases'][0]['stages']['combined']['samples'][0]['consumerCode']==0
        assert workflow.read_bytes()==before
        assert data['omittedNonVideoArgs']==['-map_metadata','1','-map','1:a?','-c:a','copy']
        assert [case['preview'] for case in data['cases']]==[False,True]
        assert data['previewHeight']==180 and data['previewFps']==5
        assert 'Filtername' in data['cases'][0]['stages']['filter']['samples'][0]['filterTimes']
        print('PASS: four real benchmark stages, bounded frame count, Node relay, unchanged source script')

if __name__=='__main__': main()
