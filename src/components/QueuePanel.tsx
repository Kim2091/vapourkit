import { memo, useState, useEffect, useMemo, useRef } from 'react';
import { List, Trash2, XCircle, RotateCcw, FolderOpen, SplitSquareHorizontal, Scissors, Film, Loader2, GripVertical, Copy, Lock } from 'lucide-react';
import type { QueueItem } from '../electron.d';
import { PrivacyText } from './PrivacyVeil';
import { Section } from './Section';

interface QueuePanelProps {
  queue: QueueItem[];
  isQueueStarted: boolean;
  editingItemId: string | null;
  privacyMode: boolean;
  onRemoveItem: (itemId: string) => void;
  onSelectItem: (itemId: string) => void;
  onClearCompleted: () => void;
  onClearAll: () => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onCancelItem: (itemId: string) => void;
  onRequeueItem: (itemId: string) => void;
  onCompareItem: (itemId: string) => void;
  onOpenItemFolder: (itemId: string) => void;
  onDropFiles?: (files: string[]) => void;
  onDuplicateItem: (itemId: string) => void;
}

export const QueuePanel = memo<QueuePanelProps>(({
  queue,
  isQueueStarted,
  editingItemId,
  privacyMode,
  onRemoveItem,
  onSelectItem,
  onClearCompleted,
  onClearAll,
  onReorder,
  onCancelItem,
  onRequeueItem,
  onCompareItem,
  onOpenItemFolder,
  onDropFiles,
  onDuplicateItem,
}: QueuePanelProps) => {
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [thumbnails, setThumbnails] = useState<Record<string, string | null>>({});
  const [loadingThumbnails, setLoadingThumbnails] = useState<Set<string>>(new Set());
  const [videoMetadata, setVideoMetadata] = useState<Record<string, { resolution?: string; duration?: string; fps?: number }>>({});
  
  // Track which thumbnails we've already fetched to prevent duplicate requests
  const fetchedThumbnailsRef = useRef<Set<string>>(new Set());
  const fetchedMetadataRef = useRef<Set<string>>(new Set());

  // Fetch thumbnails and metadata for queue items
  useEffect(() => {
    let isMounted = true;
    
    const fetchData = async () => {
      for (const item of queue) {
        // Fetch thumbnail if not already fetched
        if (!fetchedThumbnailsRef.current.has(item.videoPath)) {
          fetchedThumbnailsRef.current.add(item.videoPath);
          setLoadingThumbnails(prev => new Set(prev).add(item.videoPath));
          
          try {
            const thumbnail = await window.electronAPI.getVideoThumbnail(item.videoPath);
            if (isMounted) {
              setThumbnails(prev => ({ ...prev, [item.videoPath]: thumbnail }));
              setLoadingThumbnails(prev => {
                const next = new Set(prev);
                next.delete(item.videoPath);
                return next;
              });
            }
          } catch {
            if (isMounted) {
              setThumbnails(prev => ({ ...prev, [item.videoPath]: null }));
              setLoadingThumbnails(prev => {
                const next = new Set(prev);
                next.delete(item.videoPath);
                return next;
              });
            }
          }
        }
        
        // Fetch video metadata if not already fetched
        if (!fetchedMetadataRef.current.has(item.videoPath)) {
          fetchedMetadataRef.current.add(item.videoPath);
          
          try {
            const info = await window.electronAPI.getVideoInfo(item.videoPath);
            if (isMounted) {
              setVideoMetadata(prev => ({
                ...prev,
                [item.videoPath]: {
                  resolution: info.resolution,
                  duration: info.duration,
                  fps: info.fps
                }
              }));
            }
          } catch {
            // Silently fail
          }
        }
      }
    };

    fetchData();
    
    return () => {
      isMounted = false;
    };
  }, [queue]);

  const stats = useMemo(() => ({
    total: queue.length,
    pending: queue.filter(item => item.status === 'pending').length,
    processing: queue.filter(item => item.status === 'processing').length,
    completed: queue.filter(item => item.status === 'completed').length,
    error: queue.filter(item => item.status === 'error').length,
  }), [queue]);

  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDraggedIndex(index);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent, index?: number) => {
    e.preventDefault();
    e.stopPropagation();
    
    // Check if dragging files
    if (e.dataTransfer.types.includes('Files')) {
      e.dataTransfer.dropEffect = 'copy';
      setIsDraggingFiles(true);
      return;
    }

    e.dataTransfer.dropEffect = 'move';
    if (index !== undefined && draggedIndex !== null && draggedIndex !== index) {
      setDragOverIndex(index);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingFiles(false);
  };

  const handleDrop = (e: React.DragEvent, index?: number) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingFiles(false);

    // Check if files are dropped
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const files = Array.from(e.dataTransfer.files);
        const filePaths = files.map(file => window.electronAPI.getFilePathFromFile(file));
        onDropFiles?.(filePaths);
        setDraggedIndex(null);
        setDragOverIndex(null);
        return;
    }

    if (draggedIndex !== null && index !== undefined && draggedIndex !== index) {
      onReorder(draggedIndex, index);
    }
    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  const handleDragEnd = () => {
    setDraggedIndex(null);
    setDragOverIndex(null);
    setIsDraggingFiles(false);
  };

  // Status drives a dot and a left edge rather than a border per card — at
  // 240px wide there is no room to spend on chrome.
  const statusTone = (status: QueueItem['status']) => {
    switch (status) {
      case 'processing': return { dot: 'bg-accent-500', edge: 'border-l-accent-500' };
      case 'completed':  return { dot: 'bg-ok-500', edge: 'border-l-ok-700' };
      case 'error':      return { dot: 'bg-bad-500', edge: 'border-l-bad-600' };
      default:           return { dot: 'bg-ink-600', edge: 'border-l-transparent' };
    }
  };

  const ROW_BTN = 'w-5 h-5 rounded grid place-items-center transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-500';

  return (
    <div
      className={`flex flex-col h-full min-h-0 bg-ink-950 border-r transition-colors ${
        isDraggingFiles ? 'border-accent-500 bg-accent-500/5' : 'border-ink-800'
      }`}
      onDragOver={(e) => handleDragOver(e)}
      onDragLeave={handleDragLeave}
      onDrop={(e) => handleDrop(e)}
    >
      <Section
        title="Queue"
        meta={queue.length > 0 ? `${stats.pending} pending` : undefined}
        actions={<span className="text-[11px] text-ink-500 tabular-nums">{queue.length}</span>}
      />

      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden relative">
        {isDraggingFiles && (
          <div className="absolute inset-0 z-50 bg-accent-500/10 border-2 border-dashed border-accent-500 m-1.5 rounded flex items-center justify-center backdrop-blur-sm pointer-events-none">
            <div className="text-center px-2">
              <Film className="w-8 h-8 text-accent-500 mx-auto mb-1.5" />
              <p className="text-accent-400 font-medium text-[12px]">Drop to add</p>
            </div>
          </div>
        )}

        {queue.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-ink-600 px-4 text-center">
            <List className="w-8 h-8 mb-2 opacity-60" />
            <p className="text-[12.5px] text-ink-400">Queue is empty</p>
            <p className="text-[11px] mt-1">Drop videos here, or select several at once in Source.</p>
          </div>
        ) : (
          queue.map((item, index) => {
            const isEditing = editingItemId === item.id;
            const isPending = item.status === 'pending';
            const isClickable = isPending || item.status === 'completed';
            const isDraggable = isPending && !isQueueStarted;
            const isDragging = draggedIndex === index;
            const isOver = dragOverIndex === index;
            const tone = statusTone(item.status);
            const meta = videoMetadata[item.videoPath];
            const filterCount = item.workflow.filters.filter(f => f.enabled).length;

            return (
              <div
                key={item.id}
                draggable={isDraggable}
                onDragStart={(e) => isDraggable && handleDragStart(e, index)}
                onDragOver={(e) => isDraggable && handleDragOver(e, index)}
                onDrop={(e) => isDraggable && handleDrop(e, index)}
                onDragEnd={handleDragEnd}
                onClick={() => isClickable && onSelectItem(item.id)}
                title={privacyMode ? undefined : item.videoName}
                className={`group relative flex items-center gap-2 px-2 py-1.5 border-b border-ink-900 border-l-2 transition-colors ${tone.edge} ${
                  isDragging ? 'opacity-40' : ''
                } ${
                  isOver ? 'bg-accent-500/10' : isEditing ? 'bg-ink-850' : 'hover:bg-ink-900'
                } ${isClickable ? 'cursor-pointer' : ''} ${isDraggable ? 'active:cursor-grabbing' : ''}`}
              >
                {isOver && draggedIndex !== null && (
                  <span className="absolute -top-px left-0 right-0 h-0.5 bg-accent-500" />
                )}

                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${tone.dot} ${item.status === 'processing' ? 'animate-pulse' : ''}`} />

                <div className="w-[34px] h-[20px] rounded flex-shrink-0 bg-ink-900 border border-ink-800 overflow-hidden grid place-items-center">
                  {privacyMode ? (
                    <Lock className="w-3 h-3 text-ink-600" />
                  ) : loadingThumbnails.has(item.videoPath) ? (
                    <Loader2 className="w-3 h-3 text-ink-600 animate-spin" />
                  ) : thumbnails[item.videoPath] ? (
                    <img src={thumbnails[item.videoPath]!} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <Film className="w-3 h-3 text-ink-600" />
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <p className="text-[12px] text-ink-200 truncate leading-tight">
                    <PrivacyText enabled={privacyMode} value={item.videoName} maskLength={12} />
                  </p>
                  <p className="text-[10px] text-ink-500 font-mono tabular-nums truncate leading-tight">
                    {item.status === 'error'
                      ? (item.errorMessage || 'failed')
                      : [
                          meta?.resolution,
                          filterCount > 0 ? `${filterCount}f` : null,
                          item.workflow.outputFormat.toUpperCase(),
                          item.workflow.segment?.enabled ? 'seg' : null,
                        ].filter(Boolean).join(' · ')}
                  </p>
                </div>

                {/* Actions appear on hover so a row stays quiet at rest */}
                <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                  {item.status === 'processing' ? (
                    <button onClick={(e) => { e.stopPropagation(); onCancelItem(item.id); }}
                      className={`${ROW_BTN} text-warn-400 hover:bg-warn-500/15`} title="Cancel">
                      <XCircle className="w-3.5 h-3.5" />
                    </button>
                  ) : (
                    <>
                      {item.status === 'completed' && (
                        <>
                          <button onClick={(e) => { e.stopPropagation(); onCompareItem(item.id); }}
                            disabled={item.workflow.segment?.enabled}
                            className={`${ROW_BTN} text-ink-400 hover:text-ink-200 hover:bg-ink-800 disabled:opacity-30 disabled:cursor-not-allowed`}
                            title={item.workflow.segment?.enabled ? 'Compare is unavailable for segment runs' : 'Compare with original'}>
                            <SplitSquareHorizontal className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={(e) => { e.stopPropagation(); onOpenItemFolder(item.id); }}
                            className={`${ROW_BTN} text-ink-400 hover:text-ink-200 hover:bg-ink-800`} title="Open output folder">
                            <FolderOpen className="w-3.5 h-3.5" />
                          </button>
                        </>
                      )}
                      {(item.status === 'completed' || item.status === 'error') && (
                        <button onClick={(e) => { e.stopPropagation(); onRequeueItem(item.id); }}
                          className={`${ROW_BTN} text-ink-400 hover:text-ink-200 hover:bg-ink-800`} title="Process again">
                          <RotateCcw className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button onClick={(e) => { e.stopPropagation(); onDuplicateItem(item.id); }}
                        className={`${ROW_BTN} text-ink-400 hover:text-ink-200 hover:bg-ink-800`} title="Duplicate">
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); onRemoveItem(item.id); }}
                        className={`${ROW_BTN} text-bad-400 hover:bg-bad-500/15`} title="Remove">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </>
                  )}
                  {isDraggable && <GripVertical className="w-3.5 h-3.5 text-ink-600 cursor-grab" />}
                </div>

                {item.status === 'processing' && item.progress != null && (
                  <span className="absolute left-0 bottom-0 h-0.5 bg-accent-500 transition-all" style={{ width: `${item.progress}%` }} />
                )}

                {item.workflow.segment?.enabled && (
                  <Scissors className="w-2.5 h-2.5 text-ink-600 absolute right-1 top-1 group-hover:opacity-0 transition-opacity" />
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="flex-shrink-0 h-8 flex items-center gap-2 px-2 border-t border-ink-800 bg-ink-900">
        <button
          onClick={onClearCompleted}
          disabled={stats.completed === 0 && stats.error === 0}
          className="text-[11px] text-ink-400 hover:text-ink-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          title="Remove finished and failed items"
        >
          Clear done
        </button>
        <span className="w-px h-3 bg-ink-800" />
        <button
          onClick={onClearAll}
          disabled={queue.length === 0 || isQueueStarted}
          className="text-[11px] text-ink-400 hover:text-bad-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          title="Remove every item"
        >
          Clear all
        </button>
        <div className="flex-1" />
        {stats.error > 0 && <span className="text-[11px] text-bad-400 tabular-nums">{stats.error} failed</span>}
        {stats.completed > 0 && <span className="text-[11px] text-ok-500 tabular-nums">{stats.completed} done</span>}
      </div>
    </div>
  );
});
