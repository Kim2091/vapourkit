import { useState } from 'react';
import { List, Trash2, ChevronUp, ChevronDown, PlayCircle, XCircle, RotateCcw, FolderOpen, SplitSquareHorizontal } from 'lucide-react';
import type { QueueItem } from '../electron.d';

interface QueuePanelProps {
  queue: QueueItem[];
  isQueueStarted: boolean;
  editingItemId: string | null;
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
}

export function QueuePanel({
  queue,
  isQueueStarted,
  editingItemId,
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
}: QueuePanelProps) {
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);

  const stats = {
    total: queue.length,
    pending: queue.filter(item => item.status === 'pending').length,
    processing: queue.filter(item => item.status === 'processing').length,
    completed: queue.filter(item => item.status === 'completed').length,
    error: queue.filter(item => item.status === 'error').length,
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

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

  return (
    <div 
      className={`flex flex-col h-full bg-dark-elevated rounded-2xl border overflow-hidden transition-colors ${
        isDraggingFiles ? 'border-primary-purple bg-primary-purple/5' : 'border-gray-800'
      }`}
      onDragOver={(e) => handleDragOver(e)}
      onDragLeave={handleDragLeave}
      onDrop={(e) => handleDrop(e)}
    >
      {/* Header */}
      <div className="flex-shrink-0 px-4 py-3 border-b border-gray-800 bg-dark-surface">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <PlayCircle className="w-5 h-5 text-primary-blue" />
            <h2 className="font-semibold">Processing Queue</h2>
          </div>
          <div className="text-sm text-gray-400">
            {stats.total} video{stats.total !== 1 ? 's' : ''}
          </div>
        </div>
        
        {/* Stats */}
        <div className="flex gap-4 text-xs flex-wrap">
          <div className="flex items-center gap-1">
            <span className="text-gray-400">Pending:</span>
            <span className="text-gray-300 font-medium">{stats.pending}</span>
          </div>
          {stats.processing > 0 && (
            <div className="flex items-center gap-1">
              <span className="text-blue-400">Processing:</span>
              <span className="text-blue-300 font-medium">{stats.processing}</span>
            </div>
          )}
          {stats.completed > 0 && (
            <div className="flex items-center gap-1">
              <span className="text-green-400">Done:</span>
              <span className="text-green-300 font-medium">{stats.completed}</span>
            </div>
          )}
          {stats.error > 0 && (
            <div className="flex items-center gap-1">
              <span className="text-red-400">Error:</span>
              <span className="text-red-300 font-medium">{stats.error}</span>
            </div>
          )}
        </div>
      </div>

      {/* Queue Items */}
      <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-gray-700 scrollbar-track-transparent">
        {queue.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-500 p-4">
            <List className="w-12 h-12 mb-2 opacity-50" />
            <p className="text-sm">No videos in queue</p>
            <p className="text-xs mt-1">Drag & drop multiple videos or use "Add to Queue"</p>
          </div>
        ) : (
          <div className="p-2 space-y-2">
            {queue.map((item, index) => {
              const isEditing = editingItemId === item.id;
              const isPending = item.status === 'pending';
              const isClickable = isPending || item.status === 'completed';
              const isDraggable = isPending && !isQueueStarted;
              const isDragging = draggedIndex === index;
              const isOver = dragOverIndex === index;
              
              return (
              <div
                key={item.id}
                draggable={isDraggable}
                onDragStart={(e) => isDraggable && handleDragStart(e, index)}
                onDragOver={(e) => isDraggable && handleDragOver(e, index)}
                onDrop={(e) => isDraggable && handleDrop(e, index)}
                onDragEnd={handleDragEnd}
                onClick={() => isClickable && onSelectItem(item.id)}
                className={`bg-dark-surface border rounded-xl p-3 transition-all ${
                  isDragging ? 'opacity-50' : ''
                } ${
                  isOver ? 'border-blue-400 scale-[1.02]' : ''
                } ${
                  isEditing
                    ? 'border-blue-500 shadow-lg shadow-blue-500/20 ring-2 ring-blue-500/30'
                    : item.status === 'processing'
                    ? 'border-blue-500 shadow-lg shadow-blue-500/20'
                    : item.status === 'completed'
                    ? 'border-green-800 hover:border-green-700'
                    : item.status === 'error'
                    ? 'border-red-800'
                    : 'border-gray-800 hover:border-gray-700'
                } ${
                  isClickable ? 'cursor-pointer' : ''
                } ${
                  isDraggable ? 'cursor-grab active:cursor-grabbing' : ''
                }`}
              >
                <div className="flex items-start gap-3">
                  {/* Step Counter */}
                  <div className={`flex-shrink-0 w-6 h-6 rounded border flex items-center justify-center ${
                    item.status === 'processing' ? 'bg-blue-500/20 border-blue-500/50' :
                    item.status === 'completed' ? 'bg-green-500/20 border-green-500/50' :
                    item.status === 'error' ? 'bg-red-500/20 border-red-500/50' :
                    'bg-gray-500/20 border-gray-500/50'
                  }`}>
                    <span className={`text-xs font-bold ${
                      item.status === 'processing' ? 'text-blue-400' :
                      item.status === 'completed' ? 'text-green-400' :
                      item.status === 'error' ? 'text-red-400' :
                      'text-gray-400'
                    }`}>
                      {index + 1}
                    </span>
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate" title={item.videoName}>
                          {item.videoName}
                        </p>
                        <p className="text-xs text-gray-500 truncate" title={item.outputPath}>
                          → {item.outputPath.split(/[\\/]/).pop()}
                        </p>
                      </div>
                      
                      {/* Status Badge */}
                      <span className={`text-xs px-2 py-0.5 rounded-full ${
                        item.status === 'pending' ? 'bg-gray-700 text-gray-300' :
                        item.status === 'processing' ? 'bg-blue-900 text-blue-300' :
                        item.status === 'completed' ? 'bg-green-900 text-green-300' :
                        'bg-red-900 text-red-300'
                      }`}>
                        {item.status}
                      </span>
                    </div>

                    {/* Progress Bar for processing items */}
                    {item.status === 'processing' && item.progress !== undefined && (
                      <div className="mt-2">
                        <div className="flex items-center justify-between text-xs text-gray-400 mb-1">
                          <span>Processing...</span>
                          <span>{item.progress}%</span>
                        </div>
                        <div className="w-full bg-dark-bg rounded-full h-1.5">
                          <div 
                            className="bg-gradient-to-r from-primary-blue to-primary-purple h-1.5 rounded-full transition-all duration-300"
                            style={{ width: `${item.progress}%` }}
                          />
                        </div>
                      </div>
                    )}

                    {/* Error message */}
                    {item.status === 'error' && item.errorMessage && (
                      <p className="text-xs text-red-400 mt-1 line-clamp-2">
                        {item.errorMessage}
                      </p>
                    )}

                    {/* Workflow info */}
                    <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
                      <span>Format: {item.workflow.outputFormat.toUpperCase()}</span>
                      {item.workflow.filters.filter(f => f.enabled).length > 0 && (
                        <>
                          <span>|</span>
                          <span>{item.workflow.filters.filter(f => f.enabled).length} filter(s)</span>
                        </>
                      )}
                    </div>

                    <div className="text-xs text-gray-600 mt-1">
                      Added {formatDate(item.addedAt)}
                    </div>

                    {/* Completed Item Actions */}
                    {item.status === 'completed' && (
                      <div className="flex gap-1 mt-2">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onCompareItem(item.id);
                          }}
                          className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1 text-xs bg-dark-bg hover:bg-dark-elevated border border-gray-700 rounded transition-colors"
                          title="Compare with original"
                        >
                          <SplitSquareHorizontal className="w-3 h-3" />
                          Compare
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenItemFolder(item.id);
                          }}
                          className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1 text-xs bg-dark-bg hover:bg-dark-elevated border border-gray-700 rounded transition-colors"
                          title="Open output folder"
                        >
                          <FolderOpen className="w-3 h-3" />
                          Folder
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex flex-col gap-1">
                    {item.status === 'processing' ? (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onCancelItem(item.id);
                        }}
                        className="p-1.5 hover:bg-orange-900/20 rounded transition-colors"
                        title="Cancel this item"
                      >
                        <XCircle className="w-4 h-4 text-orange-400 hover:text-orange-300" />
                      </button>
                    ) : item.status === 'pending' && !isQueueStarted ? (
                      <>
                        {index > 0 && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onReorder(index, index - 1);
                            }}
                            className="p-1.5 hover:bg-dark-bg rounded transition-colors"
                            title="Move up"
                          >
                            <ChevronUp className="w-4 h-4 text-gray-400 hover:text-gray-300" />
                          </button>
                        )}
                        {index < queue.length - 1 && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onReorder(index, index + 1);
                            }}
                            className="p-1.5 hover:bg-dark-bg rounded transition-colors"
                            title="Move down"
                          >
                            <ChevronDown className="w-4 h-4 text-gray-400 hover:text-gray-300" />
                          </button>
                        )}
                      </>
                    ) : (item.status === 'completed' || item.status === 'error') ? (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onRequeueItem(item.id);
                        }}
                        className="p-1.5 hover:bg-blue-900/20 rounded transition-colors"
                        title="Reprocess this item"
                      >
                        <RotateCcw className="w-4 h-4 text-blue-400 hover:text-blue-300" />
                      </button>
                    ) : null}
                    {item.status !== 'processing' && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemoveItem(item.id);
                        }}
                        className="p-1.5 hover:bg-red-900/20 rounded transition-colors"
                        title="Remove from queue"
                      >
                        <Trash2 className="w-4 h-4 text-red-400 hover:text-red-300" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer Actions */}
      {queue.length > 0 && (
        <div className="flex-shrink-0 p-3 border-t border-gray-800 bg-dark-surface">
          <div className="flex gap-2">
            <button
              onClick={onClearCompleted}
              disabled={stats.completed === 0 && stats.error === 0}
              className="flex-1 px-3 py-2 text-sm bg-dark-elevated hover:bg-dark-bg disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
            >
              Clear Completed
            </button>
            <button
              onClick={onClearAll}
              disabled={isQueueStarted}
              className="flex-1 px-3 py-2 text-sm bg-red-900/20 hover:bg-red-900/30 disabled:opacity-50 disabled:cursor-not-allowed text-red-400 rounded-lg transition-colors"
            >
              Clear All
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
