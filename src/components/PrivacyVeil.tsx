import { memo, useState, useEffect, useCallback, type ReactNode, type MouseEvent } from 'react';
import { Lock, EyeOff } from 'lucide-react';

interface PrivacyVeilProps {
  enabled: boolean;
  children: ReactNode;
  className?: string;
  label?: string;
}

export const PrivacyVeil = memo<PrivacyVeilProps>(({
  enabled,
  children,
  className,
  label,
}: PrivacyVeilProps) => {
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    if (!enabled) setRevealed(false);
  }, [enabled]);

  const reveal = useCallback((e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setRevealed(true);
  }, []);

  const hide = useCallback((e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setRevealed(false);
  }, []);

  if (!enabled) return <>{children}</>;

  if (revealed) {
    return (
      <div className={`relative ${className ?? ''}`}>
        {children}
        <button
          onClick={hide}
          className="absolute top-3 right-3 z-20 px-3.5 py-2 text-sm font-medium bg-black/75 text-white rounded-lg border border-gray-600 hover:bg-black/90 hover:border-gray-500 backdrop-blur-sm flex items-center gap-1.5 shadow-lg"
          title="Hide (privacy mode)"
        >
          <EyeOff className="w-4 h-4" />
          <span>Hide</span>
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={reveal}
      className={`relative bg-dark-surface border border-dashed border-gray-700 rounded-lg flex items-center justify-center text-gray-500 hover:border-gray-600 hover:text-gray-400 transition-colors cursor-pointer ${className ?? ''}`}
      title="Click to reveal (privacy mode is on)"
    >
      <div className="flex flex-col items-center gap-2 py-6 px-4">
        <Lock className="w-6 h-6" />
        <span className="text-xs">{label ?? 'Hidden — click to reveal'}</span>
      </div>
    </button>
  );
});

interface PrivacyTextProps {
  enabled: boolean;
  value: string;
  className?: string;
  maskChar?: string;
  maskLength?: number;
  title?: string;
}

export const PrivacyText = memo<PrivacyTextProps>(({
  enabled,
  value,
  className,
  maskChar = '•',
  maskLength = 8,
  title,
}: PrivacyTextProps) => {
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    if (!enabled) setRevealed(false);
  }, [enabled]);

  const toggle = useCallback((e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setRevealed(prev => !prev);
  }, []);

  if (!enabled) {
    return <span className={className} title={title}>{value}</span>;
  }

  const displayValue = revealed ? value : maskChar.repeat(maskLength);
  const tooltip = revealed
    ? 'Click to hide (privacy mode)'
    : 'Click to reveal (privacy mode is on)';

  return (
    <span
      onClick={toggle}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setRevealed(prev => !prev);
        }
      }}
      className={`cursor-pointer hover:opacity-80 transition-opacity ${className ?? ''}`}
      title={tooltip}
    >
      {displayValue}
    </span>
  );
});
