import { useEffect, useState } from 'react';
import type { ComponentSnapshot } from '../../electron/componentCatalog';
import { ask } from '../utils/dialogs';

export function ComponentUpdatesPanel() {
  const [snapshot, setSnapshot] = useState<ComponentSnapshot | null>(null);
  const [experimental, setExperimental] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const check = async (online: boolean) => {
    setBusy(true);
    try { setSnapshot(await window.electronAPI.checkComponents(online)); setMessage(online ? 'Catalog checked.' : ''); }
    catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  };
  useEffect(() => { void check(false); }, []);
  const install = async (id: string, version: string, name: string) => {
    if (!(await ask({ title: 'Install component', message: `Install ${name} ${version}? Existing models and saved workflows are kept. Runtime, FFmpeg and filter changes take effect after restart.`, confirmLabel: 'Install' }))) return;
    setBusy(true);
    try {
      const result = await window.electronAPI.installComponent(id, version, experimental);
      setSnapshot(await window.electronAPI.checkComponents(false));
      setMessage(result.message);
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  };
  const rollback = async (kind: 'runtime' | 'ffmpeg' | 'filters') => {
    if (!(await ask({ title: 'Restore previous component', message: `Restore the previous ${kind} selection on the next restart? Installed files are kept.`, confirmLabel: 'Restore previous' }))) return;
    setBusy(true);
    try { await window.electronAPI.rollbackComponent(kind); setMessage('Previous selection restored. Restart after jobs finish.'); }
    catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  };
  const entries = snapshot?.catalog.components.filter(c => experimental || c.channel === 'stable') ?? [];
  return <section className="p-4 border-b border-ink-800 text-xs space-y-3" aria-label="Component updates">
    <div className="flex items-center justify-between"><strong>Models & component updates</strong><button type="button" disabled={busy} className="text-accent-400 disabled:opacity-50" onClick={() => void check(true)}>{busy ? 'Working…' : 'Check approved updates'}</button></div>
    <p className="text-ink-400">Only compatible entries from the Vapourkit catalog are offered. Driver and Linux system-package updates remain under your system’s control.</p>
    <label className="flex items-center gap-2"><input type="checkbox" disabled={busy} checked={experimental} onChange={e => setExperimental(e.target.checked)} />Show experimental models (GPU validation pending)</label>
    {entries.map(entry => <div key={entry.id + entry.version} className="border border-ink-750 rounded p-2 space-y-1">
      <div className="flex justify-between gap-2"><strong>{entry.name} {entry.version}</strong><button type="button" disabled={busy || snapshot?.installed[entry.id] === entry.version} className="text-accent-400 disabled:text-ink-500" onClick={() => void install(entry.id, entry.version, entry.name)}>{snapshot?.installed[entry.id] === entry.version ? 'Installed' : 'Install'}</button></div>
      <p className="text-ink-400">{entry.notes}</p><p className="text-ink-500">{entry.license} · {(entry.files.reduce((n, f) => n + f.bytes, 0) / 1048576).toFixed(1)} MB</p>
    </div>)}
    {snapshot && entries.length === 0 && <p className="text-ink-400">No approved updates are currently offered for this installation.</p>}
    {snapshot?.pendingRestart && <p className="text-warn-400">Restart after jobs finish to activate component changes.</p>}
    <div className="flex gap-3">{(['runtime', 'ffmpeg', 'filters'] as const).map(kind => <button type="button" key={kind} disabled={busy} className="text-ink-400 hover:text-accent-400" onClick={() => void rollback(kind)}>Restore previous {kind}</button>)}</div>
    {message && <p role="status" className="text-ink-300 whitespace-pre-wrap">{message}</p>}
  </section>;
}
