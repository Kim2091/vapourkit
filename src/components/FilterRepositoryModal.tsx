
import { useEffect, useState } from 'react';
import type { RepositoryEntry } from '../../electron/filterRepositoryTypes';
import { ModalShell } from './ModalShell';
import { ask } from '../utils/dialogs';

export function FilterRepositoryModal({ onClose, onInstalled }: { onClose: () => void; onInstalled?: () => Promise<void> }) {
  const [entries, setEntries] = useState<RepositoryEntry[]>([]);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const load = async (refresh: boolean) => {
    setBusy(true);
    try { setEntries(await window.electronAPI.listFilterRepository(refresh)); setMessage(''); }
    catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  };
  useEffect(() => { void load(false); }, []);
  const install = async (entry: RepositoryEntry) => {
    if (!await ask({ title: 'Install VapourSynth filter', message: 'Download and verify ' + entry.name + ' and its compatible dependencies from VSRepo? Existing plugins and custom files will be kept.', confirmLabel: 'Install' })) return;
    setBusy(true); setMessage('Downloading, checking hashes and testing plugin loading…');
    try {
      const result = await window.electronAPI.installRepositoryFilter(entry.id);
      await onInstalled?.();
      setMessage(result.message);
      setEntries(current => current.map(p => p.id === entry.id ? { ...p, installed: true } : p));
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  };
  const visible = entries.filter(p => (p.name + ' ' + p.description + ' ' + p.namespace).toLowerCase().includes(query.toLowerCase()));
  return <ModalShell title="Get more filters" onClose={onClose} closeDisabled={busy} layer={60} className="w-[800px] max-w-full max-h-[85vh] flex flex-col" panelProps={{ role: 'dialog', 'aria-label': 'Get more filters', 'aria-modal': true }}>
    <div className="p-4 space-y-3 border-b border-ink-800 text-xs">
      <p>Browse the official VSRepo registry. This R79 runtime supports API3 and API4. Missing native API metadata follows VSRepo’s API3 default; installation tests actual plugin loading.</p>
      <p className="text-ink-400">Installation adds templates for single-clip functions whose other arguments are optional. Other functions and Python scripts remain available through Custom/New Filter. New templates appear in this picker after installation.</p>
      <div className="flex gap-3"><input aria-label="Search repository filters" className="flex-1 bg-ink-900 border border-ink-700 rounded px-2 py-1" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search names, descriptions or namespaces…" /><button disabled={busy} onClick={() => void load(true)} className="text-accent-400 disabled:opacity-50">Refresh catalog</button></div>
      {message && <p role="status" className="whitespace-pre-wrap">{message}</p>}
      {busy && <p role="status">Working…</p>}
    </div>
    <div className="overflow-y-auto p-4 space-y-3 text-xs">
      {visible.map(p => <article key={p.id} className="border border-ink-750 rounded p-3 space-y-1">
        <div className="flex justify-between gap-3"><strong>{p.name} {p.version}</strong><button className="text-accent-400 disabled:text-ink-500" disabled={busy || !p.compatible || p.installed} onClick={() => void install(p)}>{p.installed ? 'Installed' : 'Install'}</button></div>
        <p>{p.description}</p><p className="text-ink-400">{p.kind} · {p.api === null ? 'API not declared / script' : 'API ' + p.api} · {p.namespace}</p>
        {!p.compatible && <p className="text-warn-400">{p.reason}</p>}
      </article>)}
      {!busy && !visible.length && <p>No matching packages. Refresh the catalog or check the reported connection error.</p>}
    </div>
  </ModalShell>;
}
