// Same bounded header guard and Node stream topology as the application.
const fs=require('fs');
const {spawn}=require('child_process');
const {MatroskaPipe}=require('../dist/electron/matroskaPipe');
const spec=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const start=performance.now(); let firstByteMs=null,bytes=0,producerCode=null,consumerCode=null,failed=false,closed=0;
const producer=spawn(spec.producer[0],spec.producer.slice(1),{stdio:['ignore','pipe','pipe']});
const consumer=spawn(spec.consumer[0],spec.consumer.slice(1),{stdio:['pipe','ignore','pipe']});
let detail=''; const remember=d=>{detail=(detail+d.toString()).slice(-10000);};
producer.stderr.on('data',remember); consumer.stderr.on('data',remember);
const guard=new MatroskaPipe();
function fail(error){if(failed)return;failed=true;clearTimeout(timer);producer.kill();consumer.kill();console.error(String(error)+'\n'+detail);process.exitCode=1;}
const timer=setTimeout(()=>fail(Error('Benchmark pipeline timed out')),spec.timeoutMs);
for(const child of [producer,consumer])child.on('error',fail);
guard.on('error',fail); consumer.stdin.on('error',()=>{});
guard.on('data',chunk=>{if(firstByteMs===null)firstByteMs=performance.now()-start;bytes+=chunk.length;});
producer.stdout.pipe(guard).pipe(consumer.stdin);
producer.on('close',code=>{producerCode=code;if(code!==0)fail(Error('VapourSynth failed: '+code));finish();});
consumer.on('close',code=>{consumerCode=code;if(code!==0)fail(Error('FFmpeg failed: '+code));finish();});
function finish(){if(++closed<2)return;clearTimeout(timer);if(!failed)console.log(JSON.stringify({elapsedMs:performance.now()-start,firstByteMs,bytes,producerCode,consumerCode}));}
