"""Real R79 -> FFmpeg regression for a noisy cold engine builder, without a GPU.

Only TensorRT execution is stubbed. ONNX inspection, builder process launch,
VapourSynth frame production, Matroska transport and FFmpeg decoding are real.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ffmpeg', default=shutil.which('ffmpeg'))
    args = parser.parse_args()
    if not args.ffmpeg:
        import imageio_ffmpeg
        args.ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    import vapoursynth
    import onnx
    from onnx import helper, TensorProto
    vspipe = Path(vapoursynth.__file__).parent / ('vspipe.exe' if os.name == 'nt' else 'vspipe')
    with tempfile.TemporaryDirectory(prefix='Vapourkit noisy render ') as directory:
        root = Path(directory)
        source = root / 'identity.onnx'
        bindings = [helper.make_tensor_value_info(name, TensorProto.FLOAT, [1, 3, 'h', 'w']) for name in ('pixels', 'output')]
        model = helper.make_model(helper.make_graph([helper.make_node('Identity', ['pixels'], ['output'])], 'identity', [bindings[0]], [bindings[1]]), opset_imports=[helper.make_opsetid('', 13)], ir_version=10)
        onnx.save(model, source)
        builder = root / 'noisy_builder.py'
        builder.write_text("import os,sys,pathlib,json,time\n" + f"sys.path.insert(0,{str(ROOT/'include')!r})\n" +
                           "import vk_model_runtime as vk\nos.write(1,b'[vk-build] status NOISY COLD BUILD\\n')\ntime.sleep(1)\np=pathlib.Path(next(a.split('=',1)[1] for a in sys.argv if a.startswith('--saveEngine=')))\ns=next(a.split('=',1)[1] for a in sys.argv if a.startswith('--onnx='))\np.write_bytes(b'test-engine')\npathlib.Path(str(p)+'.json').write_text(json.dumps({'schema':1,'runtime':{'gpu':'test'},'precision':'fp16','contract':vk.graph_contract(s),'engineSha256':vk.digest(p),'bindings':{'inputs':[{'shape':[1,3,64,64]}],'outputs':[]}}))\n")
        script = root / 'source.vpy'
        script.write_text(f"import sys,vapoursynth as vs\nsys.path.insert(0,{str(ROOT / 'include')!r})\nimport vk_model_runtime as vk\nvk.runtime_identity=lambda:{{'gpu':'test'}}\nvk.raw_model=lambda clips,*args,**kw:clips[0]\nc=vs.core.std.BlankClip(width=64,height=64,length=8,format=vs.YUV420P8)\nc=vk.load_model(c,{str(source)!r},1,{str(builder)!r},{sys.executable!r})\nc.set_output()\n")
        command = [str(vspipe), '-c', 'mkv', '--outputindex', '0', str(script), '-']
        children = [subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE) for _ in range(2)]
        concurrent = []
        try:
            for child in children:
                stdout, stderr = child.communicate(timeout=60)
                concurrent.append(subprocess.CompletedProcess(command, child.returncode, stdout, stderr))
        finally:
            for child in children:
                if child.poll() is None: child.kill(); child.wait()
        assert all(item.returncode == 0 for item in concurrent), b'\n'.join(item.stderr for item in concurrent)
        assert sum(item.stderr.count(b'NOISY COLD BUILD') for item in concurrent) == 1, 'Concurrent graph processes must build only once'
        result = next(item for item in concurrent if b'NOISY COLD BUILD' in item.stderr)
        assert result.returncode == 0, result.stderr.decode(errors='replace')
        assert result.stdout[:4] == bytes.fromhex('1a45dfa3'), result.stdout[:200]
        assert b'NOISY COLD BUILD' in result.stderr
        assert b'NOISY COLD BUILD' not in result.stdout
        warm = subprocess.run([str(vspipe), '-c', 'mkv', '--outputindex', '0', str(script), '-'], capture_output=True, timeout=60)
        assert warm.returncode == 0, warm.stderr.decode(errors='replace')
        assert b'NOISY COLD BUILD' not in warm.stderr, 'Unchanged second process must reuse the validated engine'
        assert b'[vk-cache] Using validated engine:' in warm.stderr
        decoded = subprocess.run([args.ffmpeg, '-v', 'error', '-nostats', '-progress', 'pipe:2', '-f', 'matroska', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1'], input=result.stdout, capture_output=True, timeout=30)
        assert decoded.returncode == 0, decoded.stderr.decode(errors='replace')
        assert len(decoded.stdout) == 8 * 64 * 64 * 3 // 2, len(decoded.stdout)
        if shutil.which('node'):
            parser = "const fs=require('fs');const {FFmpegProgress}=require(process.argv[1]);const records=[];const p=new FFmpegProgress(r=>records.push(r));p.push(fs.readFileSync(0,'utf8'));p.flush();console.log(JSON.stringify(records));"
            for preview in (False, True):
                progress_run = decoded
                if preview:
                    progress_run = subprocess.run([args.ffmpeg,'-v','error','-nostats','-progress','pipe:2','-f','matroska','-i','pipe:0','-map','0:v:0','-f','null','-','-map','0:v:0','-vf','fps=24,scale=-2:64','-c:v','mjpeg','-f','image2pipe','pipe:1'],input=result.stdout,capture_output=True,timeout=30)
                    assert progress_run.returncode==0,progress_run.stderr
                parsed=subprocess.run([shutil.which('node'),'-e',parser,str(ROOT/'dist'/'electron'/'ffmpegProgress.js')],input=progress_run.stderr,capture_output=True,timeout=10)
                assert parsed.returncode==0,parsed.stderr
                assert json.loads(parsed.stdout)[-1]['frame']==8
                assert json.loads(parsed.stdout)[-1]['ended']
            spec=root/'pipe.json'; encoded=root/'encoded.mkv'
            spec.write_text(json.dumps({'producer':[str(vspipe),'-c','mkv','--outputindex','0',str(script),'-'], 'consumer':[args.ffmpeg,'-v','error','-f','matroska','-i','pipe:0','-c:v','ffv1','-y',str(encoded)], 'timeoutMs':60000}))
            relay=subprocess.run([shutil.which('node'),str(ROOT/'scripts'/'runBenchmarkPipe.cjs'),str(spec)],capture_output=True,text=True,timeout=70)
            assert relay.returncode==0,relay.stderr
            assert json.loads(relay.stdout)['producerCode']==0
            pixels=subprocess.run([args.ffmpeg,'-v','error','-i',str(encoded),'-f','rawvideo','-pix_fmt','yuv420p','pipe:1'],capture_output=True,timeout=30)
            assert pixels.returncode==0,pixels.stderr
            assert len(pixels.stdout)==len(decoded.stdout)
        print('PASS: concurrent cold processes build once; fresh process reuses engine; diagnostics stay on stderr; R79/FFmpeg decode all frames')


if __name__ == '__main__': main()
