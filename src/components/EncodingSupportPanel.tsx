import { useEffect, useRef, useState } from 'react';
import type { EncodingSupport, NvencEncoder } from '../../electron/encodingSupportTypes';
import { resolveEncodingArgs, simpleWithEncoder, splitArgs, type EncodingSettings } from '../../electron/encodingSettings';
import { simpleCodecOf } from '../../electron/ffmpegConfig';

export function EncodingSupportPanel({ encoding, processingFormat, disabled, onChange, onProcessingFormatChange }: {
  encoding: EncodingSettings; processingFormat: string; disabled: boolean;
  onChange: (encoding: EncodingSettings) => void; onProcessingFormatChange: (format: string) => void;
}) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ key: string; support: EncodingSupport } | null>(null);
  const request = useRef(0);
  const args = splitArgs(resolveEncodingArgs(encoding));
  let encoder: string | undefined;
  args.forEach((arg, i) => { if (['-c:v', '-codec:v', '-vcodec', '-c:v:0'].includes(arg)) encoder = args[i + 1]; });
  const isNvenc = !!encoder && ['h264_nvenc', 'hevc_nvenc', 'av1_nvenc'].includes(encoder);
  const selected = encoder as NvencEncoder;
  const key = `${selected}:${processingFormat}`;
  useEffect(() => {
    if (!isNvenc || disabled) return;
    const timer = setTimeout(() => { void test(); }, 250);
    return () => { clearTimeout(timer); request.current++; };
  }, [key, disabled]);
  if (!isNvenc) return null;
  const support = result?.key === key ? result.support : null;
  async function test() {
    const serial = ++request.current; setChecking(true); setResult(null);
    try {
      const support = await window.electronAPI.checkEncodingSupport({ encoder: selected, pixelFormat: processingFormat });
      if (serial === request.current) setResult({ key, support });
    } catch (error) {
      if (serial === request.current) setResult({ key, support: { available: false, category: 'unknown', message: String(error) } });
    } finally { if (serial === request.current) setChecking(false); }
  }
  const useCpu = () => {
    const codec = simpleCodecOf(selected)?.codec ?? 'h264';
    onChange({ ...encoding, mode: 'simple', simple: simpleWithEncoder({ ...encoding.simple, codec }, 'software') });
  };
  return <div className="border border-ink-700 rounded p-2 space-y-2 text-xs">
    <button type="button" disabled={disabled || checking} className="text-accent-400 disabled:opacity-50" onClick={() => void test()}>{checking ? 'Testing NVENC...' : 'Test selected NVENC encoder'}</button>
    {support && <>
      <p role="status" className={support.available ? 'text-ok-400' : 'text-warn-400'}>{support.message}</p>
      {!support.available && <div className="flex flex-wrap gap-3">
        <button type="button" disabled={disabled} className="text-accent-400" onClick={useCpu}>Use CPU encoding</button>
        {support.category === 'format' && <button type="button" disabled={disabled} className="text-accent-400" onClick={() => onProcessingFormatChange('vs.YUV420P8')}>Use YUV 4:2:0 8-Bit</button>}
        {['driver', 'libraries'].includes(support.category) && <button type="button" className="text-accent-400" onClick={() => void window.electronAPI.openExternal('https://www.nvidia.com/Download/index.aspx')}>NVIDIA driver downloads</button>}
      </div>}
      {support.details && <details><summary className="text-ink-400 cursor-pointer">Encoder error details</summary><pre className="whitespace-pre-wrap break-words text-[10px] max-h-40 overflow-auto">{support.details}</pre></details>}
    </>}
    {!support && <p className="text-ink-500">Test the actual encoder before rendering. GPU model, driver and pixel format determine support.</p>}
  </div>;
}
