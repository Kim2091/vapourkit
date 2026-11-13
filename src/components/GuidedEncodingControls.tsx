import type { SimpleEncoding } from '../../electron/encodingSettings';

const field = 'w-full mt-1 h-8 bg-ink-850 border border-ink-750 rounded px-2 text-xs';
export function GuidedEncodingControls({ value, onChange, onProcessingFormatChange, outputFormat, disabled }: {
  value: SimpleEncoding; onChange: (value: SimpleEncoding) => void;
  onProcessingFormatChange: (format: string) => void; outputFormat: string; disabled: boolean;
}) {
  const patch = (change: Partial<SimpleEncoding>) => onChange({ ...value, ...change });
  return <fieldset disabled={disabled} className="space-y-3 text-xs disabled:opacity-50">
    {value.codec !== 'prores' && <>
      <label className="block">Rate control
        <select className={field} aria-label="Rate control" value={value.rateControl ?? 'quality'} onChange={e => patch({ rateControl: e.target.value as 'quality' | 'bitrate' })}>
          <option value="quality">Constant quality (recommended)</option><option value="bitrate">Target bitrate</option>
        </select>
      </label>
      {value.rateControl === 'bitrate' && <label className="block">Target video bitrate (Mbps)
        <input className={field} type="number" min="0.1" max="1000" step="0.1" aria-label="Target video bitrate (Mbps)" value={value.bitrateMbps ?? 8} onChange={e => patch({ bitrateMbps: Number(e.target.value) })} />
        <span className="text-ink-500">Higher values keep more detail and produce larger files.</span>
      </label>}
      <label className="block">Maximum video bitrate (Mbps; 0 = no limit)
        <input className={field} type="number" min="0" max="1000" step="0.1" aria-label="Maximum video bitrate (Mbps; 0 = no limit)" value={value.maxBitrateMbps ?? 0} onChange={e => patch({ maxBitrateMbps: Number(e.target.value) || undefined })} />
      </label>
      <label className="block">Keyframe interval (frames; 0 = automatic)
        <input className={field} type="number" min="0" max="1000" step="1" aria-label="Keyframe interval (frames; 0 = automatic)" value={value.keyframeInterval ?? 0} onChange={e => patch({ keyframeInterval: Number(e.target.value) })} />
      </label>
    </>}
    {value.codec === 'h264' && value.encoder === 'software' && <label className="block">Optimize H.264 for
      <select className={field} aria-label="Optimize H.264 for" value={value.tune ?? 'none'} onChange={e => patch({ tune: e.target.value as SimpleEncoding['tune'] })}>
        <option value="none">General video</option><option value="film">Film</option><option value="animation">Animation</option><option value="grain">Preserve grain</option><option value="stillimage">Still images</option><option value="fastdecode">Fast playback decoding</option><option value="zerolatency">Low latency</option>
      </select>
    </label>}
    {value.codec === 'prores' && <label className="block">ProRes profile
      <select className={field} aria-label="ProRes profile" value={value.proresProfile ?? 2} onChange={e => {
        const proresProfile = Number(e.target.value); patch({ proresProfile });
        onProcessingFormatChange(proresProfile >= 4 ? 'vs.YUV444P10' : 'vs.YUV422P10');
      }}>
        {['Proxy', 'LT', 'Standard', 'HQ', '4444', '4444 XQ'].map((name, index) => <option key={index} value={index}>{name}</option>)}
      </select>
    </label>}
    {value.encoder === 'software' && value.codec !== 'av1' && <label className="block">CPU encoding threads (0 = automatic)
      <input className={field} type="number" min="0" max="256" step="1" aria-label="CPU encoding threads (0 = automatic)" value={value.threads ?? 0} onChange={e => patch({ threads: Number(e.target.value) })} />
    </label>}
    <label className="block">Audio encoding
      <select className={field} aria-label="Audio encoding" value={value.audioCodec ?? 'copy'} onChange={e => patch({ audioCodec: e.target.value as SimpleEncoding['audioCodec'] })}>
        <option value="copy">Copy original audio (no quality loss)</option><option value="aac">AAC (widely compatible)</option><option value="ac3">AC-3</option><option value="flac" disabled={outputFormat !== 'mkv'}>FLAC (lossless, MKV)</option><option value="none">Remove all audio</option>
      </select>
    </label>
    {value.audioCodec && !['copy', 'none'].includes(value.audioCodec) && <>
      {value.audioCodec !== 'flac' && <label className="block">Audio bitrate (kbps)
        <select className={field} aria-label="Audio bitrate (kbps)" value={value.audioBitrateKbps ?? 192} onChange={e => patch({ audioBitrateKbps: Number(e.target.value) })}>
          {[96, 128, 192, 256, 384, 448, 640].map(rate => <option key={rate} value={rate}>{rate}</option>)}
        </select>
      </label>}
      <label className="block">Audio channels
        <select className={field} aria-label="Audio channels" value={value.audioChannels ?? 0} onChange={e => patch({ audioChannels: Number(e.target.value) })}>
          <option value={0}>Keep source channels</option><option value={1}>Mono</option><option value={2}>Stereo</option><option value={6}>5.1 surround</option>
        </select>
      </label>
    </>}
    <label className="flex gap-2 items-center"><input type="checkbox" checked={value.copyMetadata !== false} onChange={e => patch({ copyMetadata: e.target.checked })} />Copy container title and metadata tags</label>
    {['mp4', 'mov'].includes(outputFormat) && <label className="flex gap-2 items-center"><input type="checkbox" checked={value.fastStart !== false} onChange={e => patch({ fastStart: e.target.checked })} />Optimize file for streaming (fast start)</label>}
  </fieldset>;
}
