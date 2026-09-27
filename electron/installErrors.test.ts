import { describe, expect, it } from 'vitest';
import { classifyInstallError, formatInstallError, type InstallErrorKind } from './installErrors';

// Output samples are shaped after what pip 24-25, Node's child_process, 7-Zip
// and Windows actually print, including the surrounding noise, so a rule that
// only works on a tidy one-liner fails here.

const PIP_PREAMBLE = [
  'Looking in indexes: https://pypi.org/simple, https://download.pytorch.org/whl/cu128',
  'Collecting torch==2.8.0+cu128',
  '  Downloading https://download.pytorch.org/whl/cu128/torch-2.8.0%2Bcu128-cp312-cp312-win_amd64.whl (3.2 GB)',
  '     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 3.2/3.2 GB 41.3 MB/s eta 0:00:00',
  'Collecting vsdlssnr',
  '  Using cached vsdlssnr-0.3.1-py3-none-win_amd64.whl (12 kB)',
].join('\n');

const SAMPLES: Record<Exclude<InstallErrorKind, 'unknown'>, string> = {
  'disk-full': [
    PIP_PREAMBLE,
    'Installing collected packages: torch, vsdlssnr',
    'ERROR: Could not install packages due to an OSError: [Errno 28] No space left on device',
    '',
  ].join('\r\n'),

  'access-denied': [
    PIP_PREAMBLE,
    'Installing collected packages: torch',
    '  Attempting uninstall: torch',
    '    Found existing installation: torch 2.7.1+cu128',
    '    Uninstalling torch-2.7.1+cu128:',
    "ERROR: Could not install packages due to an OSError: [WinError 5] Access is denied: 'C:\\\\Vapourkit\\\\data\\\\python\\\\Lib\\\\site-packages\\\\torch\\\\lib\\\\cudnn64_9.dll'",
    'Consider using the `--user` option or check the permissions.',
  ].join('\n'),

  'file-in-use': [
    PIP_PREAMBLE,
    'Installing collected packages: vsdlssnr',
    "ERROR: Could not install packages due to an OSError: [WinError 32] The process cannot access the file because it is being used by another process: 'C:\\\\Vapourkit\\\\data\\\\python\\\\Lib\\\\site-packages\\\\vsdlssnr\\\\nvngx_dlssd.dll'",
    'Check the permissions.',
  ].join('\n'),

  'path-too-long': [
    'Collecting onnxruntime-gpu',
    'Installing collected packages: onnxruntime-gpu',
    "ERROR: Could not install packages due to an OSError: [Errno 2] No such file or directory: 'C:\\\\Users\\\\someone\\\\Documents\\\\Very Long Folder Name\\\\Vapourkit\\\\data\\\\python\\\\Lib\\\\site-packages\\\\onnxruntime\\\\transformers\\\\models\\\\stable_diffusion\\\\pipeline_stable_diffusion.py'",
    'HINT: This error might have occurred since this system does not have Windows Long Path support enabled. You can find information on how to enable this at https://pip.pypa.io/warnings/enable-long-paths',
  ].join('\n'),

  network: [
    "WARNING: Retrying (Retry(total=4, connect=None, read=None, redirect=None, status=None)) after connection broken by 'NewConnectionError('<pip._vendor.urllib3.connection.HTTPSConnection object at 0x0000020F>: Failed to establish a new connection: [Errno 11001] getaddrinfo failed')': /simple/torch/",
    "WARNING: Retrying (Retry(total=3, connect=None, read=None, redirect=None, status=None)) after connection broken by 'NewConnectionError('<pip._vendor.urllib3.connection.HTTPSConnection object at 0x0000020F>: Failed to establish a new connection: [Errno 11001] getaddrinfo failed')': /simple/torch/",
    'ERROR: Could not find a version that satisfies the requirement torch==2.8.0+cu128 (from versions: none)',
    'ERROR: No matching distribution found for torch==2.8.0+cu128',
  ].join('\n'),

  timeout: [
    PIP_PREAMBLE,
    "ERROR: Could not install packages due to an OSError: HTTPSConnectionPool(host='download.pytorch.org', port=443): Max retries exceeded with url: /whl/cu128/torch-2.8.0.whl (Caused by ReadTimeoutError(\"HTTPSConnectionPool(host='download.pytorch.org', port=443): Read timed out. (read timeout=15)\"))",
  ].join('\n'),

  ssl: [
    "WARNING: Retrying (Retry(total=4, connect=None, read=None, redirect=None, status=None)) after connection broken by 'SSLError(SSLCertVerificationError(1, '[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: unable to get local issuer certificate (_ssl.c:1010)'))': /simple/torch/",
    "Could not fetch URL https://pypi.org/simple/torch/: There was a problem confirming the ssl certificate: HTTPSConnectionPool(host='pypi.org', port=443): Max retries exceeded with url: /simple/torch/ (Caused by SSLError(SSLCertVerificationError(1, '[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: unable to get local issuer certificate (_ssl.c:1010)'))) - skipping",
    'ERROR: Could not find a version that satisfies the requirement torch (from versions: none)',
    'ERROR: No matching distribution found for torch',
  ].join('\n'),

  proxy: [
    "WARNING: Retrying (Retry(total=4, connect=None, read=None, redirect=None, status=None)) after connection broken by 'ProxyError('Cannot connect to proxy.', OSError('Tunnel connection failed: 407 Proxy Authentication Required'))': /simple/torch/",
    'ERROR: Could not find a version that satisfies the requirement torch (from versions: none)',
    'ERROR: No matching distribution found for torch',
  ].join('\n'),

  'pip-missing': 'C:\\Vapourkit\\data\\python\\python.exe: No module named pip\n',

  'pip-metadata': [
    'Collecting torch==2.8.0+cu128',
    'Installing collected packages: torch',
    '  Attempting uninstall: torch',
    '    Found existing installation: torch None',
    'error: uninstall-no-record-file',
    '',
    '× Cannot uninstall torch None',
    "╰─> The package's contents are unknown: no RECORD file was found for torch.",
    '',
    'hint: You might be able to recover from this via: pip install --force-reinstall --no-deps torch==2.8.0',
  ].join('\n'),

  'no-matching-distribution': [
    'Looking in indexes: https://pypi.org/simple',
    'ERROR: Could not find a version that satisfies the requirement vsfoo==9.9 (from versions: 0.1.0, 0.2.0)',
    'ERROR: No matching distribution found for vsfoo==9.9',
  ].join('\n'),

  'dependency-conflict': [
    'Collecting numpy<2',
    'INFO: pip is looking at multiple versions of vsdlssnr to determine which version is compatible with other requirements. This could take a while.',
    'ERROR: Cannot install numpy<2 and vsdlssnr==0.3.1 because these package versions have conflicting dependencies.',
    '',
    'The conflict is caused by:',
    '    The user requested numpy<2',
    '    vsdlssnr 0.3.1 depends on numpy>=2.0',
    '',
    'ERROR: ResolutionImpossible: for help visit https://pip.pypa.io/en/latest/topics/dependency-resolution/#dealing-with-dependency-conflicts',
  ].join('\n'),

  'python-missing': "Error: spawn C:\\Vapourkit\\data\\python\\python.exe ENOENT\n    at ChildProcess._handle.onexit (node:internal/child_process:285:19)\n    at onErrorNT (node:internal/child_process:483:16)",
};

describe('classifyInstallError: one sample per kind', () => {
  for (const [kind, output] of Object.entries(SAMPLES)) {
    it(`recognises ${kind}`, () => {
      const result = classifyInstallError(output, { step: 'Installing plugins', exitCode: 1 });
      expect(result.kind).toBe(kind);
      expect(result.summary.startsWith('Installing plugins failed because')).toBe(true);
      expect(result.evidence.length).toBeGreaterThan(0);
      expect(result.evidence.split('\n').length).toBeLessThanOrEqual(15);
    });
  }

  it('keeps the Errno 28 line itself as evidence', () => {
    const result = classifyInstallError(SAMPLES['disk-full']);
    expect(result.evidence).toContain('[Errno 28] No space left on device');
    expect(result.summary).toMatch(/full/);
    expect(result.summary).toMatch(/10 GB/);
  });

  it('recognises the other ways a full disk is reported', () => {
    for (const output of [
      'ERROR: There is not enough space on the disk.\nArchives with Errors: 1',
      "OSError: [WinError 112] There is not enough space on the disk: 'C:\\\\tmp\\\\x'",
      "Error: ENOSPC: no space left on device, write",
    ]) {
      expect(classifyInstallError(output).kind).toBe('disk-full');
    }
  });

  it('recognises Windows access and lock failures from Node and 7-Zip', () => {
    expect(classifyInstallError("Error: EPERM: operation not permitted, rename 'C:\\a' -> 'C:\\b'").kind).toBe('access-denied');
    expect(classifyInstallError("Error: EACCES: permission denied, open 'C:\\a'").kind).toBe('access-denied');
    expect(classifyInstallError('ERROR: Can not open output file : Access is denied. : C:\\Vapourkit\\data\\vs-plugins\\foo.dll').kind).toBe('access-denied');
    expect(classifyInstallError("OSError: [WinError 225] Operation did not complete successfully because the file contains a virus or potentially unwanted software: 'x.dll'").kind).toBe('access-denied');
    expect(classifyInstallError("Error: EBUSY: resource busy or locked, unlink 'C:\\a.dll'").kind).toBe('file-in-use');
    expect(classifyInstallError('The filename or extension is too long.').kind).toBe('path-too-long');
  });

  it('recognises the other ways a missing Python is reported', () => {
    expect(classifyInstallError("'python' is not recognized as an internal or external command,\noperable program or batch file.").kind).toBe('python-missing');
    expect(classifyInstallError('Python was not found; run without arguments to install from the Microsoft Store, or disable this shortcut from Settings > Manage App Execution Aliases.').kind).toBe('python-missing');
  });

  it('recognises a pure network failure raised as an error line', () => {
    const output = "ERROR: Could not install packages due to an OSError: HTTPSConnectionPool(host='files.pythonhosted.org', port=443): Max retries exceeded with url: /x.whl (Caused by NewConnectionError('Failed to establish a new connection: [Errno -3] Temporary failure in name resolution'))";
    expect(classifyInstallError(output).kind).toBe('network');
  });
});

describe('classifyInstallError: precedence', () => {
  it('prefers a full disk over the access error it causes', () => {
    const output = [
      "ERROR: Could not install packages due to an OSError: [WinError 5] Access is denied: 'C:\\\\x'",
      'OSError: [Errno 28] No space left on device',
    ].join('\n');
    expect(classifyInstallError(output).kind).toBe('disk-full');
  });

  it('prefers "in use" over "access denied" when both appear', () => {
    const output = "[WinError 5] Access is denied\n[WinError 32] The process cannot access the file because it is being used by another process";
    expect(classifyInstallError(output).kind).toBe('file-in-use');
  });

  it('prefers SSL, proxy and timeout over the generic retry wrapper', () => {
    expect(classifyInstallError(SAMPLES.ssl).kind).toBe('ssl');
    expect(classifyInstallError(SAMPLES.proxy).kind).toBe('proxy');
    expect(classifyInstallError(SAMPLES.timeout).kind).toBe('timeout');
  });

  it('blames the network, not the package, when pip could not reach the index', () => {
    expect(classifyInstallError(SAMPLES.network).kind).toBe('network');
  });

  it('prefers pip-missing over python-missing', () => {
    const output = "C:\\Vapourkit\\data\\python\\python.exe: No module named pip\nspawn C:\\Vapourkit\\data\\python\\python.exe ENOENT";
    expect(classifyInstallError(output).kind).toBe('pip-missing');
  });

  it('prefers a dependency conflict over the "no version satisfies" it can print', () => {
    const output = SAMPLES['dependency-conflict'] + '\nERROR: Could not find a version that satisfies the requirement numpy>=2.0';
    expect(classifyInstallError(output).kind).toBe('dependency-conflict');
  });

  it('ignores retry warnings that pip recovered from', () => {
    const output = [
      "WARNING: Retrying (Retry(total=4, connect=None, read=None, redirect=None, status=None)) after connection broken by 'ReadTimeoutError(\"HTTPSConnectionPool(host='pypi.org', port=443): Read timed out. (read timeout=15)\")': /simple/numpy/",
      'Collecting numpy<2',
      SAMPLES['dependency-conflict'],
    ].join('\n');
    expect(classifyInstallError(output).kind).toBe('dependency-conflict');

    const recoveredThenUnexplained = [
      "WARNING: Retrying (Retry(total=4, connect=None, read=None, redirect=None, status=None)) after connection broken by 'ReadTimeoutError(\"Read timed out.\")': /simple/numpy/",
      'Successfully downloaded numpy',
      'Something else entirely went wrong',
    ].join('\n');
    expect(classifyInstallError(recoveredThenUnexplained).kind).toBe('unknown');
  });

  it('does not call an ENOENT inside the python folder a missing Python', () => {
    const output = "Error: ENOENT: no such file or directory, open 'C:\\Vapourkit\\data\\python\\Lib\\site-packages\\foo\\bar.pyd'";
    expect(classifyInstallError(output).kind).toBe('unknown');
    expect(classifyInstallError('Error: spawn C:\\Vapourkit\\data\\python\\vspipe.exe ENOENT').kind).toBe('unknown');
  });

  it('does not treat a package named like an error as one', () => {
    const output = [
      'Collecting pyopenssl',
      'Collecting requests-toolbelt',
      'error: subprocess-exited-with-error',
      '  × Building wheel for vsfoo (pyproject.toml) did not run successfully.',
    ].join('\n');
    expect(classifyInstallError(output).kind).toBe('unknown');
  });
});

describe('classifyInstallError: unknown fallback', () => {
  it('names the step and exit code and points to the log', () => {
    const result = classifyInstallError('Something unexpected\nTraceback (most recent call last):\nValueError: bad', {
      step: 'installing VapourSynth',
      exitCode: 3,
    });
    expect(result.kind).toBe('unknown');
    expect(result.summary).toBe('Installing VapourSynth failed (exit code 3). The details below and the full log show why.');
    expect(result.evidence).toBe('Something unexpected\nTraceback (most recent call last):\nValueError: bad');
  });

  it('works without any context or output', () => {
    const result = classifyInstallError('');
    expect(result.kind).toBe('unknown');
    expect(result.summary).toBe('The install failed. The details below and the full log show why.');
    expect(result.evidence).toBe('');
  });

  it('omits a null exit code (the process was killed or never started)', () => {
    expect(classifyInstallError('x', { exitCode: null }).summary).toBe('The install failed. The details below and the full log show why.');
  });

  it('uses the last 15 readable lines, without progress bars or colour codes', () => {
    const body = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const noisy = [
      ...body.slice(0, 25),
      '     ━━━━━━━━━━━━━━━━━━━━╸━━━━━━━━━━━━━━━━━━━ 1.6/3.2 GB 41.3 MB/s eta 0:00:40',
      '   ---------------------------------------- 1.2/5.0 MB 3.4 MB/s eta 0:00:02',
      ' 42% 13 - vs-plugins\\foo.dll',
      '',
      '\x1b[31mline 26\x1b[0m',
      ...body.slice(26),
    ].join('\n');
    const lines = classifyInstallError(noisy).evidence.split('\n');
    expect(lines).toHaveLength(15);
    expect(lines[0]).toBe('line 16');
    expect(lines).not.toContain('');
    expect(lines.join('\n')).not.toMatch(/━|eta|42%|\x1b/);
    expect(lines[lines.length - 1]).toBe('line 30');
  });

  it('keeps only the final redraw of a carriage-return-updated line', () => {
    const result = classifyInstallError('Downloading  10%\rDownloading  50%\rfinal state\n');
    expect(result.evidence).toBe('final state');
  });
});

describe('classifyInstallError: evidence', () => {
  it('shows the matching line with a line of context, not the whole log', () => {
    const lines = SAMPLES['disk-full'].split('\r\n').filter(Boolean);
    const evidence = classifyInstallError(SAMPLES['disk-full']).evidence.split('\n');
    expect(evidence).toEqual([
      'Installing collected packages: torch, vsdlssnr',
      'ERROR: Could not install packages due to an OSError: [Errno 28] No space left on device',
    ]);
    expect(evidence.length).toBeLessThan(lines.length);
  });

  it('marks gaps between separate matches', () => {
    const output = ['a', '[WinError 5] Access is denied', 'b', 'c', 'd', 'e', 'PermissionError: again', 'f'].join('\n');
    expect(classifyInstallError(output).evidence).toBe(
      'a\n[WinError 5] Access is denied\nb\n...\ne\nPermissionError: again\nf',
    );
  });

  it('caps many matches at 15 lines, keeping the latest', () => {
    const output = Array.from({ length: 40 }, (_, i) => `noise ${i}\nPermissionError: attempt ${i}`).join('\n');
    const evidence = classifyInstallError(output).evidence;
    const real = evidence.split('\n').filter(line => line !== '...');
    expect(real.length).toBeLessThanOrEqual(15);
    expect(evidence).toContain('PermissionError: attempt 39');
    expect(evidence).not.toContain('attempt 0\n');
  });

  it('shortens a single enormous line', () => {
    const output = `ERROR: [Errno 28] No space left on device: '${'x'.repeat(2000)}'`;
    const evidence = classifyInstallError(output).evidence;
    expect(evidence.length).toBeLessThanOrEqual(400);
    expect(evidence.endsWith('…')).toBe(true);
  });
});

describe('summaries', () => {
  it('mention antivirus and running Vapourkit/vspipe for locking failures', () => {
    for (const kind of ['access-denied', 'file-in-use'] as const) {
      const summary = classifyInstallError(SAMPLES[kind]).summary;
      expect(summary).toMatch(/antivirus/);
      expect(summary).toMatch(/vspipe/);
      expect(summary).toMatch(/Vapourkit window/);
    }
  });

  it('point network failures at the connection and proxy, and SSL at interception', () => {
    expect(classifyInstallError(SAMPLES.network).summary).toMatch(/internet connection.*proxy/);
    expect(classifyInstallError(SAMPLES.ssl).summary).toMatch(/corporate proxy or antivirus HTTPS scanning/);
  });

  it('capitalise a lower-case step name', () => {
    expect(classifyInstallError(SAMPLES['disk-full'], { step: 'extracting FFmpeg' }).summary)
      .toMatch(/^Extracting FFmpeg failed because/);
  });
});

describe('formatInstallError', () => {
  const error = classifyInstallError(SAMPLES['disk-full'], { step: 'Installing plugins' });

  it('appends the log path when known', () => {
    expect(formatInstallError(error, 'C:\\Vapourkit\\data\\logs\\main.log')).toBe(
      `${error.summary} Full log: C:\\Vapourkit\\data\\logs\\main.log`,
    );
  });

  it('says where logs live when the path is not known', () => {
    expect(formatInstallError(error)).toBe(`${error.summary} The full log is in the logs folder inside Vapourkit's data folder.`);
    expect(formatInstallError(error, '  ')).toBe(formatInstallError(error));
  });
});
