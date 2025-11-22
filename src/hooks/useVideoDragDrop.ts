import { useState, useCallback } from 'react';

export const useVideoDragDrop = (
  isProcessing: boolean,
  onVideoLoad: (filePaths: string[]) => Promise<void>
) => {
  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    if (!isProcessing) {
      setIsDragging(true);
    }
  }, [isProcessing]);

  const handleDragLeave = useCallback((e: React.DragEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent): Promise<void> => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    if (isProcessing) return;

    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      const filePaths = files.map(file => window.electronAPI.getFilePathFromFile(file));
      await onVideoLoad(filePaths);
    }
  }, [isProcessing, onVideoLoad]);

  return {
    isDragging,
    handleDragOver,
    handleDragLeave,
    handleDrop
  };
};