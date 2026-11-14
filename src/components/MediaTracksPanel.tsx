import type { EncodingSettings, VideoInfo } from '../electron.d';
import { Section } from './Section';

export function MediaTracksPanel({ video, encoding, onChange, disabled, outputFormat }: {
  video: VideoInfo | null; encoding: EncodingSettings; onChange: (encoding: EncodingSettings) => void;
  disabled: boolean; outputFormat: string;
}) {
  if (!video) return null;
  return <Section title="Audio & subtitles">
    <fieldset disabled={disabled} className="p-3 space-y-3 text-xs disabled:opacity-50">
      <p className="text-ink-400">Checked tracks are kept. Uncheck a track to remove it. Batch selections use each track's order within its type.</p>
      {video.tracks === undefined ? <p className="text-ink-400">Track information is unavailable. Reload the video after repairing FFmpeg in setup.</p> : (['audio', 'subtitle'] as const).map(type => {
        const tracks = video.tracks!.filter(track => track.type === type);
        const key = type === 'audio' ? 'audioTracks' : 'subtitleTracks';
        const selected = encoding[key];
        return <div key={type} className="space-y-1">
          <div className="flex items-center gap-3"><strong>{type === 'audio' ? 'Audio tracks' : 'Subtitle tracks'} ({tracks.length})</strong>
            <button type="button" className="text-accent-400" onClick={() => onChange({ ...encoding, [key]: undefined })}>Keep all {type}</button>
            <button type="button" className="text-accent-400" onClick={() => onChange({ ...encoding, [key]: [] })}>Remove all {type}</button>
          </div>
          {type === 'audio' && encoding.mode === 'simple' && encoding.simple.audioCodec === 'none' && <p className="text-warn-400">Audio encoding is set to Remove all audio. Choose Copy or an audio codec in Encoding to keep selected audio tracks.</p>}
          {tracks.length === 0 && <p className="text-ink-500">No {type} tracks found.</p>}
          {tracks.map(track => <label key={track.index} className="flex gap-2 items-start">
            <input type="checkbox" checked={selected === undefined || selected.includes(track.ordinal)} onChange={e => {
              const current = selected ?? tracks.map(t => t.ordinal);
              const next = e.target.checked ? [...new Set([...current, track.ordinal])] : current.filter(n => n !== track.ordinal);
              onChange({ ...encoding, [key]: next });
            }} />
            <span>{type === 'audio' ? 'Audio' : 'Subtitle'} {track.ordinal + 1}: {track.codec} {track.language ?? ''} {track.title ?? ''} {track.isDefault ? '(default)' : ''} {track.forced ? '(forced)' : ''}</span>
          </label>)}
        </div>;
      })}
      {outputFormat !== 'mkv' && (encoding.subtitleTracks === undefined || encoding.subtitleTracks.length > 0) && video.tracks?.some(t => t.type === 'subtitle') && <p className="text-warn-400">Some subtitle formats require MKV. Choose MKV to keep them, or remove subtitles for this output.</p>}
    </fieldset>
  </Section>;
}
