import { memo, useState } from 'react';
import { Download, X, ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';

interface UpdateInfo {
  available: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
  changelog: string;
  publishedAt: string;
}

interface UpdateNotificationModalProps {
  updateInfo: UpdateInfo | null;
  onClose: () => void;
}

export const UpdateNotificationModal = memo<UpdateNotificationModalProps>(({ 
  updateInfo, 
  onClose 
}) => {
  const [changelogExpanded, setChangelogExpanded] = useState(true);

  if (!updateInfo || !updateInfo.available) return null;

  const handleDownload = (): void => {
    window.electronAPI.openReleaseUrl(updateInfo.releaseUrl);
  };

  const formatDate = (dateString: string): string => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    });
  };

  // Parse markdown-style changelog to basic formatting
  const formatChangelog = (text: string): JSX.Element[] => {
    const lines = text.split('\n');
    const clippedLines: string[] = [];
    
    // Stop processing when encountering "------------"
    for (const line of lines) {
      if (line.trim().startsWith('---')) {
        break;
      }
      clippedLines.push(line);
    }
    
    return clippedLines.map((line, index) => {
      // Headers
      if (line.startsWith('### ')) {
        return (
          <h4 key={index} className="text-base font-semibold text-white mt-3 mb-1">
            {line.replace('### ', '')}
          </h4>
        );
      }
      if (line.startsWith('## ')) {
        return (
          <h3 key={index} className="text-lg font-semibold text-white mt-4 mb-2">
            {line.replace('## ', '')}
          </h3>
        );
      }
      if (line.startsWith('# ')) {
        return (
          <h2 key={index} className="text-xl font-bold text-white mt-4 mb-2">
            {line.replace('# ', '')}
          </h2>
        );
      }
      
      // List items
      if (line.match(/^[\*\-\+]\s/)) {
        return (
          <li key={index} className="text-sm text-gray-300 ml-4 mb-1">
            {line.replace(/^[\*\-\+]\s/, '')}
          </li>
        );
      }
      
      // Bold text
      if (line.includes('**')) {
        const parts = line.split('**');
        return (
          <p key={index} className="text-sm text-gray-300 mb-1">
            {parts.map((part, i) => 
              i % 2 === 1 ? <strong key={i}>{part}</strong> : part
            )}
          </p>
        );
      }
      
      // Empty lines
      if (line.trim() === '') {
        return <div key={index} className="h-2" />;
      }
      
      // Regular text
      return (
        <p key={index} className="text-sm text-gray-300 mb-1">
          {line}
        </p>
      );
    });
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-dark-elevated rounded-2xl border border-gray-800 shadow-2xl max-w-2xl w-full max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-800">
          <div className="flex items-center gap-3">
            <Download className="w-6 h-6 text-primary-purple" />
            <h2 className="text-2xl font-bold">Update Available</h2>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6 overflow-y-auto">
          {/* Version Info */}
          <div className="bg-dark-surface border border-gray-700 rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <div>
                <p className="text-sm text-gray-400">Current Version</p>
                <p className="text-lg font-semibold text-white">v{updateInfo.currentVersion}</p>
              </div>
              <div className="text-primary-purple text-2xl font-bold">→</div>
              <div>
                <p className="text-sm text-gray-400">Latest Version</p>
                <p className="text-lg font-semibold text-primary-purple">
                  {updateInfo.latestVersion}
                </p>
              </div>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              Released on {formatDate(updateInfo.publishedAt)}
            </p>
          </div>

          {/* Changelog Section */}
          <div className="border-t border-gray-800 pt-4">
            <button
              onClick={() => setChangelogExpanded(!changelogExpanded)}
              className="w-full flex items-center justify-between gap-2 mb-3 hover:opacity-80 transition-opacity"
            >
              <h3 className="text-lg font-semibold text-white">What's New</h3>
              {changelogExpanded ? (
                <ChevronUp className="w-5 h-5 text-gray-400" />
              ) : (
                <ChevronDown className="w-5 h-5 text-gray-400" />
              )}
            </button>
            
            {changelogExpanded && (
              <div className="bg-dark-surface border border-gray-700 rounded-lg p-4 max-h-64 overflow-y-auto">
                <div className="prose prose-sm prose-invert max-w-none">
                  {formatChangelog(updateInfo.changelog)}
                </div>
              </div>
            )}
          </div>

          {/* Download Button */}
          <button
            onClick={handleDownload}
            className="w-full bg-gradient-to-r from-primary-purple to-accent-cyan hover:opacity-90 text-white font-semibold rounded-lg px-6 py-3 transition-all duration-300 flex items-center justify-center gap-2 group"
          >
            <Download className="w-5 h-5" />
            Download Update
            <ExternalLink className="w-4 h-4 opacity-70 group-hover:opacity-100 transition-opacity" />
          </button>

          <p className="text-xs text-gray-500 text-center">
            You can also view all releases on the{' '}
            <button
              onClick={() => window.electronAPI.openReleasesPage()}
              className="text-primary-purple hover:underline"
            >
              GitHub releases page
            </button>
          </p>
        </div>
      </div>
    </div>
  );
});
