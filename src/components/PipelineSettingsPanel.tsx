import { useEffect, useState } from 'react';
import { DEFAULT_PIPELINE_SETTINGS, type PipelineSettings } from '../../electron/pipelineSettings';

export function PipelineSettingsPanel({ onExportBenchmark }: { onExportBenchmark?: () => Promise<void> }) {
  const [settings, setSettings] = useState<PipelineSettings>(DEFAULT_PIPELINE_SETTINGS);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    window.electronAPI.getPipelineSettings().then(value => { if (active) { setSettings(value); setReady(true); } }).catch(error => { if (active) setMessage(String(error)); });
    return () => { active = false; };
  }, []);
  const save = async () => {
    setSaving(true);
    try { await window.electronAPI.setPipelineSettings(settings); setMessage('Saved for new validations and renders. Close and reopen an existing preview to apply.'); }
    catch (error) { setMessage(String(error)); }
    finally { setSaving(false); }
  };
  return <section className="p-4 border-b border-ink-800 text-xs space-y-3" aria-label="Pipeline performance">
    <strong>Pipeline performance</strong>
    <fieldset disabled={!ready || saving} className="space-y-3">
      <label className="flex gap-2"><input type="checkbox" checked={settings.optimizeAiChains} onChange={e => setSettings({ ...settings, optimizeAiChains: e.target.checked })} />Keep RGB between adjacent AI models (experimental)</label>
      <p className="text-ink-400">Avoids an intermediate YUV conversion. This can change rounding; custom filters and referenced steps retain their YUV boundaries. Off by default.</p>
      <label className="block">Concurrent frame requests <select aria-label="Concurrent frame requests" className="ml-2 bg-ink-900" value={settings.requests} onChange={e => setSettings({ ...settings, requests: Number(e.target.value) })}>{[0,1,2,4,8,16,32].map(n => <option key={n} value={n}>{n || 'Automatic'}</option>)}</select></label>
      <p className="text-ink-400">Benchmark requests together with the existing inference-stream setting. More concurrency can use more RAM/VRAM and is not always faster.</p>
      <label className="block">Encoding preview height <select aria-label="Encoding preview height" className="ml-2 bg-ink-900" value={settings.previewHeight} onChange={e => setSettings({ ...settings, previewHeight: Number(e.target.value) })}>{[180,360,480,720,1080].map(n => <option key={n} value={n}>{n} pixels</option>)}</select></label>
      <label className="block">Encoding preview frames per second <input aria-label="Encoding preview frames per second" className="ml-2 w-16 bg-ink-900" type="number" min="0.1" max="5" step="0.1" value={settings.previewFps} onChange={e => setSettings({ ...settings, previewFps: Number(e.target.value) })} /></label>
      <p className="text-ink-400">These change the small encoding preview only, not the encoded video. Turning the preview off before starting a render removes that output entirely.</p>
      <button type="button" className="text-accent-400" onClick={() => void save()}>{saving ? 'Saving…' : 'Save pipeline settings'}</button>
    </fieldset>
    <button type="button" className="text-accent-400 disabled:opacity-50" disabled={!onExportBenchmark || saving} onClick={() => { void onExportBenchmark?.(); }}>Export current pipeline benchmark bundle</button>
    <p className="text-ink-400">Load a video to export source and workflow scripts for the repeatable benchmark tool. Runs use a bounded frame sample and do not change your production settings.</p>
    {message && <p role="status">{message}</p>}
  </section>;
}
