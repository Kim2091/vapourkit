"""Bounded, repeatable R79 pipeline benchmarks. No production settings are modified.

Use an exported benchmark.json bundle, or supply source/workflow .vpy scripts.
Warmup, cache preparation and measured runs are reported separately. Decode and
filter stages evaluate frames without serialization; encoder-only reads a fixed
uncompressed snapshot; combined runs include the binary Matroska handoff.
"""
import argparse
import ast
import itertools
import json
import os
from pathlib import Path
import platform
import shutil
import statistics
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]


def video_only_args(arguments):
    """The app may map metadata/audio from input 1; benchmarks have only input 0."""
    result, removed = [], []
    paired = {'-map', '-map_metadata', '-map_chapters', '-c:a', '-codec:a',
              '-c:s', '-codec:s', '-b:a', '-ac', '-ar', '-af', '-filter:a',
              '-disposition:a', '-disposition:s'}
    index = 0
    while index < len(arguments):
        argument = arguments[index]
        if argument in paired or argument.startswith(('-map_metadata:', '-disposition:a:', '-disposition:s:')):
            if index + 1 == len(arguments): raise ValueError(f'Missing value for {argument}')
            removed.extend(arguments[index:index+2]); index += 2
        elif argument in ('-an', '-sn', '-dn'):
            removed.append(argument); index += 1
        elif argument in ('-i', '-filter_complex', '-filter_complex_script'):
            raise ValueError('Benchmark needs video-only encoder arguments; use --encoder-args to omit extra inputs/complex graphs')
        else:
            result.append(argument); index += 1
    return result, removed


def grid(text, minimum=0, maximum=32):
    result = [int(n) for n in text.split(',')]
    if not result or any(n < minimum or n > maximum for n in result):
        raise argparse.ArgumentTypeError(f'Values must be between {minimum} and {maximum}')
    return result


def run(command, timeout, filter_times=False):
    start = time.perf_counter()
    with tempfile.TemporaryFile() as errors:
        child = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=errors)
        try:
            code = child.wait(timeout=timeout)
        except BaseException:
            child.kill(); child.wait(); raise
        if code:
            errors.seek(max(0, errors.tell()-10000))
            raise RuntimeError(f'{command[0]} failed ({code}): ' + errors.read().decode(errors='replace'))
        result = {'elapsedMs': (time.perf_counter()-start)*1000}
        if filter_times:
            errors.seek(0, 2); size = errors.tell(); errors.seek(max(0, size-65536))
            result['filterTimes'] = errors.read().decode(errors='replace')
    return result


def pair(producer, consumer, timeout, root, node):
    if node:
        spec=root/'pipe.json'
        spec.write_text(json.dumps({'producer':producer,'consumer':consumer,'timeoutMs':timeout*1000}))
        result=subprocess.run([node,str(ROOT/'scripts'/'runBenchmarkPipe.cjs'),str(spec)],capture_output=True,text=True,timeout=timeout+10)
        if result.returncode: raise RuntimeError(result.stderr[-10000:])
        return json.loads(result.stdout)
    start=time.perf_counter()
    with tempfile.TemporaryFile() as p_errors, tempfile.TemporaryFile() as c_errors:
        p=subprocess.Popen(producer,stdout=subprocess.PIPE,stderr=p_errors)
        c=None
        try:
            c=subprocess.Popen(consumer,stdin=p.stdout,stdout=subprocess.DEVNULL,stderr=c_errors)
            p.stdout.close()
            c_code=c.wait(timeout=timeout)
            if c_code: raise RuntimeError('FFmpeg failed in the combined pipeline')
            p_code=p.wait(timeout=timeout)
            if p_code: raise RuntimeError('VapourSynth failed in the combined pipeline')
        except BaseException as error:
            p.kill(); p.wait()
            if c and c.poll() is None: c.kill(); c.wait()
            detail=[]
            for file in (p_errors,c_errors):
                file.seek(0,2); length=file.tell(); file.seek(max(0,length-5000)); detail.append(file.read().decode(errors='replace'))
            raise RuntimeError(str(error)+'\n'+'\n'.join(detail)) from error
    return {'elapsedMs':(time.perf_counter()-start)*1000}


def wrapper(script, output, info, threads, streams):
    text=script.read_text(encoding='utf8')
    if streams:
        tree=ast.parse(text); found=False
        for node in ast.walk(tree):
            if isinstance(node,ast.Call) and isinstance(node.func,ast.Attribute) and isinstance(node.func.value,ast.Name) and node.func.value.id=='_vk_models' and node.func.attr=='load_model':
                for keyword in node.keywords:
                    if keyword.arg=='streams': keyword.value=ast.Constant(streams); found=True
        if not found: raise RuntimeError('Stream sweep requires a generated managed TensorRT model call; omit --streams for this script')
        text=ast.unparse(ast.fix_missing_locations(tree))
    # Keep original __file__ and imports so user script-relative resources work.
    output.write_text(f"import sys,json,vapoursynth as vs\nsys.stdout=sys.stderr\nsys.path.insert(0,{str(script.parent)!r})\n__file__={str(script)!r}\n" +
                      (f'vs.core.num_threads={threads}\n' if threads else '') +
                      f"exec(compile({text!r},{str(script)!r},'exec'),globals())\n" +
                      (f'vs.core.num_threads={threads}\n' if threads else '') +
                      "_c=vs.get_output(0)\n_c=getattr(_c,'clip',_c)\n" +
                      f"open({str(info)!r},'w').write(json.dumps({{'frames':_c.num_frames,'width':_c.width,'height':_c.height,'threads':vs.core.num_threads,'format':_c.format.name if _c.format else None,'bytesPerFrame':_c.width*_c.height*_c.format.bytes_per_sample*(3 if _c.format.color_family==vs.RGB else (1+2/(2**(_c.format.subsampling_w+_c.format.subsampling_h)) if _c.format.num_planes==3 else 1)) if _c.format else 0,'core':str(vs.core.core_version)}}))\n",encoding='utf8')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle',type=Path)
    parser.add_argument('--variant',choices=['legacy','rgb'],default='legacy')
    parser.add_argument('--source-script',type=Path)
    parser.add_argument('--script',type=Path)
    parser.add_argument('--vspipe')
    parser.add_argument('--ffmpeg')
    parser.add_argument('--node',help='Use the actual Node/MatroskaPipe relay (requires npm run build); otherwise direct OS pipe')
    parser.add_argument('--frames',type=int,default=120)
    parser.add_argument('--runs',type=int,default=3)
    parser.add_argument('--requests',type=grid,default=[0])
    parser.add_argument('--threads',type=lambda s:grid(s,0,128),default=[0])
    parser.add_argument('--streams',type=lambda s:grid(s,1,16))
    parser.add_argument('--encoder-args',help='JSON array of video encoder arguments; default libx264/veryfast/CRF18/4 threads')
    parser.add_argument('--preview',action='store_true')
    parser.add_argument('--compare-preview',action='store_true',help='Measure identical off/on preview cases without changing the saved workflow')
    parser.add_argument('--preview-height',type=int,default=720)
    parser.add_argument('--preview-fps',type=float,default=1)
    parser.add_argument('--timeout',type=int,default=600)
    parser.add_argument('--max-cache-mib',type=int,default=1024)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    bundle={}
    if args.bundle:
        bundle=json.loads(args.bundle.read_text(encoding='utf8'))
        args.source_script=args.bundle.parent/bundle['sourceScript']
        args.script=args.bundle.parent/bundle['scripts'][args.variant]
        args.vspipe=args.vspipe or bundle.get('vspipe')
        args.ffmpeg=args.ffmpeg or bundle.get('ffmpeg')
    args.vspipe=args.vspipe or shutil.which('vspipe')
    args.ffmpeg=args.ffmpeg or shutil.which('ffmpeg')
    if not args.script or not args.source_script or not args.vspipe or not args.ffmpeg: parser.error('Provide a bundle or both scripts, and valid vspipe/ffmpeg executables')
    if args.output.resolve() in {file.resolve() for file in (args.script, args.source_script, args.bundle) if file}:
        parser.error('Output report must not overwrite an input script or bundle')
    if not 1<=args.frames<=10000 or not 1<=args.runs<=10 or not 1<=args.max_cache_mib<=65536: parser.error('Invalid frame/run/cache limit')
    if not 180<=args.preview_height<=1080 or not 0.1<=args.preview_fps<=5: parser.error('Invalid preview settings')
    cases=list(itertools.product(args.requests,args.threads,args.streams or [None],[False,True] if args.compare_preview else [args.preview]))
    if len(cases)>32: parser.error('At most 32 scheduling combinations per invocation')
    encoder=json.loads(args.encoder_args) if args.encoder_args else bundle.get('encoderArgs',['-c:v','libx264','-preset','veryfast','-crf','18','-threads','4'])
    if not isinstance(encoder,list) or not all(isinstance(a,str) for a in encoder): parser.error('Encoder arguments must be a JSON string array')
    encoder, removed = video_only_args(encoder)
    report={'schema':1,'platform':platform.platform(),'python':sys.version,'transport':'Node MatroskaPipe relay' if args.node else 'direct OS pipe (excludes Node/UI overhead)',
            'script':str(args.script.resolve()),'variant':args.variant,'runs':args.runs,'encoderArgs':encoder,'omittedNonVideoArgs':removed,
            'preview':args.preview,'previewHeight':args.preview_height,'previewFps':args.preview_fps,'cases':[],
            'notes':['Decode-only includes source loading. Filter stage includes decoding. Do not subtract parallel stage timings as isolated costs.',
                     'Encoder-only includes reading/demuxing a warm uncompressed snapshot. Combined stage includes fresh process/graph startup.',
                     'Warmup and snapshot preparation are excluded from measured medians; startup still included in each measured run.']}
    report['notes'].append('Video only: audio/subtitle mapping and source metadata mapping are omitted. Reports/scripts contain local paths; review before sharing.')
    with tempfile.TemporaryDirectory(prefix='Vapourkit pipeline bench ') as directory:
        root=Path(directory)
        for requests,threads,streams,preview in cases:
            source=root/'source.vpy'; workflow=root/'workflow.vpy'; metadata=root/'workflow.json'; source_info=root/'source.json'
            wrapper(args.source_script.resolve(),source,source_info,threads,None)
            wrapper(args.script.resolve(),workflow,metadata,threads,streams)
            warm=time.perf_counter()
            for file in (source,workflow): run([args.vspipe,'--info',str(file),'-'],args.timeout)
            data=json.loads(metadata.read_text()); source_data=json.loads(source_info.read_text())
            count=min(args.frames,data['frames'],source_data['frames'])
            if not count: raise RuntimeError('Empty source/output')
            if not data['bytesPerFrame']: raise RuntimeError('Benchmark requires fixed format/dimensions')
            estimated=count*data['bytesPerFrame']*1.05+1024**2
            if estimated>args.max_cache_mib*1024**2 or estimated>shutil.disk_usage(root).free-64*1024**2:
                raise RuntimeError('Snapshot exceeds conservative disk budget; lower --frames or increase --max-cache-mib')
            base=[args.vspipe,'--outputindex','0','--end',str(count-1)]
            if requests: base+=['--requests',str(requests)]
            snapshot=root/'filtered.mkv'
            run(base+['-c','mkv',str(workflow),str(snapshot)],args.timeout)
            def consumer(input):
                command=[args.ffmpeg,'-hide_banner','-loglevel','error','-nostdin','-f','matroska','-i',input,'-map','0:v:0','-an','-sn','-frames:v',str(count),*encoder,'-fps_mode','passthrough','-f','null','-']
                if preview: command+=['-map','0:v:0','-vf',f'fps={args.preview_fps},scale=-2:{args.preview_height//2*2}','-c:v','mjpeg','-pix_fmt','yuvj422p','-q:v','1','-f','image2pipe','pipe:1']
                return command
            case={'requests':requests,'threads':threads,'streams':streams,'preview':preview,'frames':count,'output':data,'warmupMs':(time.perf_counter()-warm)*1000,'stages':{}}
            for name in ('decode','filter','encode','combined'):
                samples=[]
                for repeat in range(args.runs):
                    print(f'{name} run {repeat+1}/{args.runs}; requests={requests}, threads={threads}, streams={streams}',file=sys.stderr)
                    if name=='decode': sample=run(base+[str(source),'--'],args.timeout)
                    elif name=='filter': sample=run(base+['--filter-time',str(workflow),'--'],args.timeout,filter_times=True)
                    elif name=='encode': sample=run(consumer(str(snapshot)),args.timeout)
                    else: sample=pair(base+['-c','mkv',str(workflow),'-'],consumer('pipe:0'),args.timeout,root,args.node)
                    samples.append(sample)
                median=statistics.median(x['elapsedMs'] for x in samples)
                case['stages'][name]={'medianMs':median,'fps':count*1000/median,'samples':samples}
            report['cases'].append(case)
            args.output.parent.mkdir(parents=True,exist_ok=True)
            args.output.write_text(json.dumps(report,indent=2),encoding='utf8')
    print('Report: '+str(args.output))


if __name__=='__main__': main()
