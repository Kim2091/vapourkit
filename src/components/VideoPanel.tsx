// VideoInfoPanel.tsx — the input → output ledger.
//
// This was two stacked columns of five values each, so every comparison meant
// reading down one side and back up the other while holding five numbers in
// your head. One pair per row does the comparison for you, and colouring only
// the rows that actually differ answers "what is this pipeline changing?"
// without reading anything. See docs/design/README.md.

import { memo } from 'react';
import { ArrowRight } from 'lucide-react';
import type { VideoInfo } from '../electron.d';
import { Section } from './Section';

interface VideoInfoPanelProps {
  videoInfo: VideoInfo | null;
  showVideoInfo: boolean;
  onToggle: (value: boolean) => void;
}

interface LedgerRow {
  key: string;
  input?: string;
  output?: string;
  /** Interlaced input is worth flagging whether or not the pipeline changes it. */
  warn?: boolean;
}

const PENDING = 'pending';

const Row = memo(function Row({ row }: { row: LedgerRow }) {
  const input = row.input || PENDING;
  const output = row.output || PENDING;
  const known = Boolean(row.input && row.output);
  const changed = known && input !== output;

  return (
    <div className="grid grid-cols-[74px_1fr_16px_1fr] items-center gap-x-2 h-[19px]">
      <span className="text-[10px] text-ink-600 uppercase tracking-wide truncate">{row.key}</span>
      <span
        className={`text-[11px] font-mono tabular-nums truncate ${
          row.warn ? 'text-warn-400' : row.input ? 'text-ink-400' : 'text-ink-600 italic'
        }`}
        title={row.input}
      >
        {input}
      </span>
      <ArrowRight className={`w-3 h-3 ${changed ? 'text-accent-500' : 'text-ink-700'}`} />
      <span
        className={`text-[11px] font-mono tabular-nums truncate ${
          changed ? 'text-accent-400' : row.output ? 'text-ink-500' : 'text-ink-600 italic'
        }`}
        title={row.output}
      >
        {output}
      </span>
    </div>
  );
});

export const VideoInfoPanel = memo<VideoInfoPanelProps>(({
  videoInfo,
  showVideoInfo,
  onToggle,
}: VideoInfoPanelProps) => {
  const rows: LedgerRow[] = [
    {
      key: 'Resolution',
      input: videoInfo?.resolution,
      output: videoInfo?.outputResolution,
    },
    {
      key: 'Frame rate',
      input: videoInfo?.fps ? String(videoInfo.fps) : undefined,
      output: videoInfo?.outputFps ? String(videoInfo.outputFps) : undefined,
    },
    {
      key: 'Codec',
      input: videoInfo?.codec?.toLowerCase(),
      output: videoInfo?.outputCodec?.toLowerCase(),
    },
    {
      key: 'Scan',
      input: videoInfo?.scanType,
      output: videoInfo?.outputScanType,
      warn: videoInfo?.scanType?.includes('Interlaced'),
    },
    {
      key: 'Format',
      input: videoInfo?.pixelFormat,
      output: videoInfo?.outputPixelFormat,
    },
  ];

  const changes = rows.filter(r => r.input && r.output && r.input !== r.output).length;

  return (
    <Section
      title="Input → Output"
      meta={videoInfo ? (changes === 1 ? '1 change' : `${changes} changes`) : undefined}
      collapsible
      open={showVideoInfo}
      onToggle={() => onToggle(!showVideoInfo)}
    >
      <div className="px-3 py-2 border-b border-ink-900">
        <div className="grid grid-cols-[74px_1fr_16px_1fr] gap-x-2 pb-1 mb-1 border-b border-ink-800">
          <span />
          <span className="text-[9px] font-display font-semibold uppercase tracking-[0.14em] text-ink-600">Input</span>
          <span />
          <span className="text-[9px] font-display font-semibold uppercase tracking-[0.14em] text-accent-500">Output</span>
        </div>
        {rows.map(row => <Row key={row.key} row={row} />)}
      </div>
    </Section>
  );
});
