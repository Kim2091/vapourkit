// src/components/EngineBuildBanner.tsx
//
// A filter is building a TensorRT engine inside vspipe. It takes minutes and
// would otherwise look like a freeze, so it gets a full-width notice directly
// above the action bar — the one place the eye is already going for progress.

import { memo } from 'react';
import { Loader2 } from 'lucide-react';
import type { EngineBuildStatus } from '../electron.d';

interface EngineBuildBannerProps {
  engineBuild: EngineBuildStatus | null;
}

export const EngineBuildBanner = memo(function EngineBuildBanner({ engineBuild }: EngineBuildBannerProps) {
  if (!engineBuild) return null;

  return (
    <div className="flex-shrink-0 relative flex items-center gap-3 px-4 py-2 bg-warn-500/10 border-t border-warn-500/30">
      {engineBuild.percent !== undefined && (
        <span
          className="absolute top-0 left-0 h-[2px] bg-warn-500 transition-all duration-300"
          style={{ width: `${engineBuild.percent}%` }}
          role="progressbar"
          aria-valuenow={engineBuild.percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Engine build progress"
        />
      )}
      <Loader2 className="w-4 h-4 text-warn-400 flex-shrink-0 animate-spin" />
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-ink-200 truncate">
          {engineBuild.label || 'Building TensorRT engine'}
          {engineBuild.percent !== undefined && ` — ${engineBuild.percent}%`}
        </p>
        <p className="text-[12px] text-ink-400">
          First run at this resolution; this can take several minutes. Don't close the app — an
          interrupted build has to start over.
        </p>
      </div>
    </div>
  );
});
