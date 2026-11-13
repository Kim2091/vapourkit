
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const assert = require('assert/strict');
const seven = require('7zip-min');
const { pkg, chooseArtifact } = require('../dist/electron/filterRepositoryPolicy');
(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vk-registry-check-'));
  try {
    const response = await fetch('https://www.vapoursynth.com/vsrepo/vspackages3.zip', { signal: AbortSignal.timeout(30000) });
    assert(response.ok, 'VSRepo registry returned HTTP ' + response.status);
    const archive = path.join(dir, 'registry.zip');
    const data = Buffer.from(await response.arrayBuffer());
    assert(data.length < 32 * 1024 * 1024, 'Registry archive is unexpectedly large');
    await fs.writeFile(archive, data);
    const list = await seven.list(archive);
    assert(list.some(item => item.name === 'vspackages3.json'));
    await seven.cmd(['x','-y','-o'+dir,archive,'vspackages3.json']);
    const registry = JSON.parse(await fs.readFile(path.join(dir,'vspackages3.json'),'utf8'));
    assert.equal(registry['file-format'],3);
    const entries = registry.packages.map(p => pkg.safeParse(p)).filter(p => p.success).map(p => p.data);
    assert(entries.length > 0, 'No recognizable package definitions');
    const native = entries.filter(p => p.type === 'VSPlugin' && chooseArtifact(p,'win32','x64'));
    assert(native.some(p=>chooseArtifact(p,'win32','x64').api===3), 'No API3 Windows binaries recognized');
    assert(native.some(p=>chooseArtifact(p,'win32','x64').api===4), 'No API4 Windows binaries recognized');
    console.log('PASS: official VSRepo archive, extraction, schema, and ' + native.length + ' compatible Windows native package definitions (' + entries.length + ' total)');
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
})().catch(error => { console.error(error); process.exitCode=1; });
