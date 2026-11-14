// UI contract test with a mocked Electron transport. Real media tests are separate.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
(async () => {
const server = spawn(process.execPath, [path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js'), '--host', '127.0.0.1', '--port', '5184', '--strictPort'], {stdio:'pipe'});
let startup = ''; for (const stream of [server.stdout, server.stderr]) stream.on('data', data => { startup = (startup + data).slice(-4096); });
let browser;
try {
const deadline = Date.now() + 15000;
while (true) {
  if (server.exitCode !== null || Date.now() > deadline) throw Error(`Vite failed to start: ${startup}`);
  try { if ((await fetch('http://127.0.0.1:5184')).ok) break; } catch {}
  await new Promise(resolve => setTimeout(resolve, 100));
}
browser = await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,headless:true});
const page = await browser.newPage({viewport:{width:1600,height:1100}}); const errors=[];
page.on('pageerror', e=>errors.push(String(e)));
await page.addInitScript(() => {
  const initial={mode:'simple',simple:{codec:'h264',encoder:'nvidia',preset:'p4',quality:21},customArgs:''};
  const state={encoding:JSON.parse(localStorage.getItem('mockEncoding')||JSON.stringify(initial)), queue:JSON.parse(localStorage.getItem('mockQueue')||'[]'), selectedFiles:[], calls:[], events:{}, preview:true};
  window.test=state;
  const handlers={
    platform:'linux',
    getPipelineSettings:async()=>state.pipeline??{optimizeAiChains:false,requests:0,previewHeight:720,previewFps:1},
    setPipelineSettings:async(settings)=>{state.pipeline=settings;},
    exportPipelineBenchmark:async()=>({cancelled:false,directory:'/bench',message:'Benchmark bundle saved'}),
    listFilterRepository:async()=>[{id:'test.blur',name:'Repository Blur',description:'A test native blur',kind:'VSPlugin',version:'1',api:4,namespace:'blur',compatible:true,reason:'',installed:false},{id:'legacy',name:'Unsupported API5',description:'unsupported',kind:'VSPlugin',version:'',api:5,namespace:'old',compatible:false,reason:'API5 is unsupported',installed:false}],
    installRepositoryFilter:async(id)=>{state.calls.push({name:'installRepositoryFilter',args:[id]});return{message:'Filter verified and installed'};},
    checkComponents:async()=>({catalog:{schema:1,client:1,revision:1,components:[{id:'test-model',version:'1',name:'Catalog test model',channel:'experimental',notes:'CPU tested; GPU pending.',license:'MIT',files:[{bytes:1000}]}]},installed:state.componentInstalled?{'test-model':'1'}:{},pendingRestart:false}),
    installComponent:async(id,version,experimental)=>{if(!experimental)throw Error('Experimental opt-in required');state.componentInstalled=true;return{restart:false,message:'Model installed alongside existing versions.'};},
    getInferenceBackendInfo:async()=>({hasCudaSupport:false,backend:'ncnn'}),checkDependencies:async()=>true,getNvencDriverProblem:async()=>null,
    getAvailableModels:async()=>[],getUninitializedModels:async()=>[],getFilterTemplates:async()=>[{name:'Identity test',code:'clip = clip',category:'Test',description:'Known valid test filter'}],
    getGpuStats:async()=>null,getDiscordRichPresenceSettings:async()=>({enabled:false}),getDefaultOutputFolder:async()=>({folder:null}),getDescriptiveNamingEnabled:async()=>({enabled:false}),
    getShowQueue:async()=>({show:false}),setShowQueue:async()=>({success:true}),getQueue:async()=>state.queue,saveQueue:async q=>{state.queue=structuredClone(q);localStorage.setItem('mockQueue',JSON.stringify(q));return{success:true};},saveQueueSync:q=>{state.queue=q;localStorage.setItem('mockQueue',JSON.stringify(q));return{success:true};},
    getEncodingSettings:async()=>{await new Promise(r=>setTimeout(r,150));return structuredClone(state.encoding);},setEncodingSettings:async e=>{state.encoding=structuredClone(e);localStorage.setItem('mockEncoding',JSON.stringify(e));return{success:true};},
    getProcessingFormat:async()=>({format:'vs.YUV420P8'}),getOutputFormat:async()=>({format:'mkv'}),getVideoCompareArgs:async()=>({args:'-W'}),getColorimetrySettings:async()=>({overwriteMatrix:false,matrix709:false,defaultMatrix:'709',defaultPrimaries:'709',defaultTransfer:'709'}),
    getEncodingSettingsExpanded:async()=>({expanded:true}),setEncodingSettingsExpanded:async()=>({success:true}),
    getUpdateReport:async()=>({report:null,decisions:[]}),checkForUpdates:async()=>({success:true,updateAvailable:false}),checkVsMlrtVersion:async()=>({needsNotification:false,storedVersion:'16.1',currentVersion:'16.1',engineCount:0}),
    setPreviewEnabled:async enabled=>{state.preview=enabled;return{success:true};},previewClose:async()=>({success:true}),
    getVersion:async()=>({version:'2.1.0'}),checkPluginDependencies:async()=>({installed:true}),
    selectVideoFile:async()=>state.selectedFiles.shift()??null,
    getVideoInfo:async path=>({path,name:path.split('/').pop(),size:100,sizeFormatted:'100 B',resolution:'128x96',fps:24,duration:'00:00:01',frameCount:24,tracks:[{index:1,ordinal:0,type:'audio',codec:'aac',language:'eng',isDefault:true,forced:false},{index:2,ordinal:1,type:'audio',codec:'ac3',language:'fra',isDefault:false,forced:false},{index:3,ordinal:0,type:'subtitle',codec:'subrip',language:'eng',isDefault:false,forced:true}]}),
    getVideoThumbnail:async()=>null,getVideoFrameAt:async()=>null,
    checkEncodingSupport:async()=>({available:false,category:'driver',message:'Your NVIDIA driver is too old. Update the driver or use CPU encoding.'}),
    getOutputResolution:async()=>({resolution:'128x96',fps:24}),fileExists:async()=>false,
    selectTemplateFile:async()=>null,
  };
  window.electronAPI=new Proxy(handlers,{get(target,name){if(name in target)return target[name]; if(String(name).startsWith('on'))return callback=>{state.events[name]=callback;return()=>{delete state.events[name];};};return async(...args)=>{state.calls.push({name,args}); if(String(name).startsWith('set')||String(name).startsWith('clear'))return{success:true};throw Error(`Unmocked API ${String(name)}`);};}});
});
await page.goto('http://127.0.0.1:5184');
await page.getByRole('button',{name:'Add filter',exact:true}).waitFor();
await page.waitForFunction(()=>window.test.encoding.simple.encoder==='software');
await page.locator('select').filter({has:page.locator('option[value="nvidia"]')}).selectOption('nvidia');
await page.waitForFunction(()=>window.test.encoding.simple.encoder==='nvidia');
await page.getByText('Your NVIDIA driver is too old. Update the driver or use CPU encoding.',{exact:true}).waitFor();
await page.getByRole('button',{name:'Use CPU encoding',exact:true}).click();
await page.waitForFunction(()=>window.test.encoding.simple.encoder==='software');
assert.equal(await page.getByText('Your NVIDIA driver is too old. Update the driver or use CPU encoding.',{exact:true}).count(),0);
const filters=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('filters')||'[]'));
assert.equal((await filters()).length,0);
for(const choice of ['VS Filter','AI Model']) {
 await page.getByRole('button',{name:'Add filter',exact:true}).click();
 await page.getByRole('button',{name:choice,exact:true}).click();
 await page.keyboard.press('Escape');
 assert.equal((await filters()).length,0,`Cancelling ${choice} added an empty step`);
}
const openImport=async()=>{
 await page.getByRole('button',{name:'Add filter',exact:true}).click();
 await page.getByRole('button',{name:'AI Model',exact:true}).click();
 await page.getByRole('button',{name:'Import Model',exact:true}).click();
};
await openImport();
const importDialog=page.getByRole('dialog',{name:'Import Custom Model',exact:true});
await importDialog.waitFor();
await page.evaluate(()=>window.test.events.onModelInitProgress({type:'error',progress:0,message:'Previous model failed: old diagnostics'}));
await importDialog.getByText('Previous model failed: old diagnostics',{exact:true}).first().waitFor();
await importDialog.getByRole('button',{name:'Close',exact:true}).click();
await openImport();
assert.equal(await importDialog.getByText('Previous model failed: old diagnostics',{exact:true}).count(),0,'Opening another build/import must clear old model errors');
await importDialog.getByRole('button',{name:'Close',exact:true}).click();
await page.getByRole('button',{name:'Add filter',exact:true}).click();await page.getByRole('button',{name:'VS Filter',exact:true}).click();
await page.getByRole('button',{name:'Get more filters',exact:true}).click();
const repository=page.getByRole('dialog',{name:'Get more filters',exact:true});
await repository.getByText('Repository Blur 1',{exact:true}).waitFor();
assert.equal(await repository.getByRole('article').filter({hasText:'Unsupported API5'}).getByRole('button',{name:'Install',exact:true}).isDisabled(),true);
await repository.getByRole('article').filter({hasText:'Repository Blur'}).getByRole('button',{name:'Install',exact:true}).click();
await page.getByRole('alertdialog',{name:'Install VapourSynth filter'}).getByRole('button',{name:'Install',exact:true}).click();
await repository.getByText('Filter verified and installed',{exact:true}).waitFor();
await repository.getByRole('button',{name:'Close',exact:true}).click();

await page.getByText('Identity test',{exact:true}).click();
await page.waitForFunction(()=>JSON.parse(localStorage.getItem('filters')||'[]').length===1);
await page.getByTitle('Turn off preview panel',{exact:true}).click();
await page.waitForFunction(()=>localStorage.getItem('showPreview')==='false'&&!window.test.preview);
const previewPane=page.getByRole('region',{name:'Video preview panel',exact:true});
assert.equal(await previewPane.count(),1);
await previewPane.getByText('Preview is disabled',{exact:true}).waitFor();
await page.getByRole('button',{name:'Console',exact:true}).click();
const consolePane=page.getByRole('region',{name:'Console',exact:true});
const paneBounds=await previewPane.boundingBox(); const consoleBounds=await consolePane.boundingBox();
assert.ok(Math.abs(consoleBounds.width-paneBounds.width)<2&&Math.abs(consoleBounds.height-paneBounds.height)<2,'Disabled preview console must fill only the preview pane');
const divider=page.getByRole('separator',{name:'Resize the settings column',exact:true});
const grab=await divider.boundingBox();
await page.mouse.move(grab.x+2,grab.y+50);await page.mouse.down();await page.mouse.move(grab.x+82,grab.y+50);await page.mouse.up();
const resized=await previewPane.boundingBox(); const resizedConsole=await consolePane.boundingBox();
assert.ok(Math.abs(resized.width-paneBounds.width)>20,'Preview pane should resize');
assert.ok(Math.abs(resizedConsole.width-resized.width)<2,'Console must follow the resized pane');
await page.getByTitle('Turn on preview panel',{exact:true}).click();
assert.ok((await consolePane.boundingBox()).height<(await previewPane.boundingBox()).height,'Enabled preview restores the console drawer');
await page.getByRole('button',{name:'Close console',exact:true}).click();
assert.equal(await consolePane.count(),0);
await page.getByTitle('Turn off preview panel',{exact:true}).click();
await page.reload();await page.getByTitle('Turn on preview panel',{exact:true}).waitFor();
await page.waitForFunction(()=>window.test.preview===false);
assert.equal((await filters()).length,0,'Relaunch should start with an empty filter chain');
await page.getByRole('button',{name:'Add filter',exact:true}).click();
await page.getByRole('button',{name:'VS Filter',exact:true}).click();
await page.getByText('Identity test',{exact:true}).click();
await page.waitForFunction(()=>JSON.parse(localStorage.getItem('filters')||'[]').length===1);
await page.getByTitle('Turn on preview panel',{exact:true}).click();
await page.getByLabel('Rate control',{exact:true}).selectOption('bitrate');
await page.getByLabel('Target video bitrate (Mbps)',{exact:true}).fill('10');
await page.getByRole('button',{name:'Advanced',exact:true}).click();
assert.match(await page.getByLabel('Advanced FFmpeg arguments',{exact:true}).inputValue(),/-b:v 10M/);
assert.equal(await page.getByRole('button',{name:'Copy from simple settings',exact:true}).count(),0);
await page.getByLabel('Advanced FFmpeg arguments',{exact:true}).fill('-c:v libx264 -crf 30');
await page.getByRole('button',{name:'Advanced',exact:true}).click();
await page.getByLabel('Target video bitrate (Mbps)',{exact:true}).fill('12');
await page.getByRole('button',{name:'Advanced',exact:true}).click();
assert.match(await page.getByLabel('Advanced FFmpeg arguments',{exact:true}).inputValue(),/-b:v 12M/);
await page.getByRole('button',{name:'Advanced',exact:true}).click();
await page.getByLabel('Target video bitrate (Mbps)',{exact:true}).fill('10');
await page.getByLabel('Audio encoding',{exact:true}).selectOption('aac');
await page.evaluate(()=>window.test.selectedFiles.push(['/videos/one.mkv']));
await page.getByTitle('Click to browse, or drop files here',{exact:true}).click();
await page.getByText('Audio tracks (2)',{exact:true}).waitFor();
const french=page.getByRole('checkbox',{name:/Audio 2: ac3 fra/});await french.uncheck();
await page.getByRole('button',{name:'Remove all subtitle',exact:true}).click();
await page.waitForFunction(()=>window.test.encoding.subtitleTracks?.length===0&&window.test.encoding.audioTracks?.join(',')==='0');
await page.evaluate(()=>window.test.selectedFiles.push(['/videos/two.mkv','/videos/three.mkv']));
await page.getByTitle('Click to choose a different video',{exact:true}).click();
await page.waitForFunction(()=>window.test.queue.length===2);
let queue=await page.evaluate(()=>window.test.queue);
for(const job of queue){assert.equal(job.workflow.encoding.simple.bitrateMbps,10);assert.equal(job.workflow.encoding.simple.audioCodec,'aac');assert.deepEqual(job.workflow.encoding.audioTracks,[0]);assert.deepEqual(job.workflow.encoding.subtitleTracks,[]);assert.equal(job.workflow.filters.length,1);}
await page.getByLabel('Target video bitrate (Mbps)',{exact:true}).fill('15');
await page.getByRole('button',{name:/Apply current settings to all pending/}).click();
await page.getByRole('button',{name:'Apply to all pending',exact:true}).click();
await page.waitForFunction(()=>window.test.queue.every(j=>j.workflow.encoding.simple.bitrateMbps===15));
await page.getByTitle('Settings',{exact:true}).click();
await page.getByText('No approved updates are currently offered for this installation.',{exact:true}).waitFor();
await page.getByRole('checkbox',{name:'Show experimental models (GPU validation pending)',exact:true}).check();
await page.getByText('Catalog test model 1',{exact:true}).waitFor();
await page.getByRole('button',{name:'Install',exact:true}).click();
assert.equal(await page.evaluate(()=>!!window.test.componentInstalled),false);
await page.getByRole('alertdialog',{name:'Install component',exact:true}).getByRole('button',{name:'Cancel',exact:true}).last().click();
assert.equal(await page.evaluate(()=>!!window.test.componentInstalled),false);
await page.getByRole('button',{name:'Install',exact:true}).click();
await page.getByRole('alertdialog',{name:'Install component',exact:true}).getByRole('button',{name:'Install',exact:true}).click();
await page.getByRole('button',{name:'Installed',exact:true}).waitFor();
assert.equal(await page.evaluate(()=>window.test.componentInstalled),true);
await page.getByRole('button',{name:'Processing',exact:true}).click();
await page.getByRole('checkbox',{name:'Keep RGB between adjacent AI models (experimental)',exact:true}).check();
await page.getByLabel('Concurrent frame requests',{exact:true}).selectOption('4');
await page.getByLabel('Encoding preview height',{exact:true}).selectOption('360');
await page.getByRole('button',{name:'Save pipeline settings',exact:true}).click();
await page.waitForFunction(()=>window.test.pipeline?.requests===4&&window.test.pipeline?.optimizeAiChains===true);
assert.deepEqual(errors,[]);
if (process.env.VAPOURKIT_SMOKE_SCREENSHOT) await page.screenshot({path:process.env.VAPOURKIT_SMOKE_SCREENSHOT,fullPage:true});
console.log('PASS: GPU recovery, picker cancellation, fresh model diagnostics, bounded/resizing console and disabled preview layout, automatic advanced arguments, guided encoding, source tracks, batch settings, catalog installation; no browser exceptions.');
} finally { await browser?.close(); server.kill(); }
})().catch(e=>{console.error(e);process.exit(1);});
