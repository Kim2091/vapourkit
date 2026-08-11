// Non-blocking notification toast component
import { X, AlertCircle, CheckCircle, Info, AlertTriangle, Copy } from 'lucide-react';
import { useNotifications } from '../hooks/useNotifications';
import { Notification, NotificationType } from '../utils/notifications';
import { useState } from 'react';

const notificationStyles: Record<NotificationType, { bg: string; border: string; icon: JSX.Element }> = {
  error: {
    bg: 'bg-bad-900/90',
    border: 'border-bad-500',
    icon: <AlertCircle className="w-5 h-5 text-bad-400 flex-shrink-0" />,
  },
  warning: {
    bg: 'bg-warn-900/90',
    border: 'border-warn-500',
    icon: <AlertTriangle className="w-5 h-5 text-warn-400 flex-shrink-0" />,
  },
  success: {
    bg: 'bg-ok-900/90',
    border: 'border-ok-500',
    icon: <CheckCircle className="w-5 h-5 text-ok-400 flex-shrink-0" />,
  },
  info: {
    bg: 'bg-accent-900/90',
    border: 'border-accent-500',
    icon: <Info className="w-5 h-5 text-accent-400 flex-shrink-0" />,
  },
};

export function NotificationContainer() {
  const { notifications, dismissNotification } = useNotifications();

  if (notifications.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 max-w-md pointer-events-none">
      {notifications.map((notification) => (
        <NotificationToast
          key={notification.id}
          notification={notification}
          onDismiss={() => dismissNotification(notification.id)}
        />
      ))}
    </div>
  );
}

function NotificationToast({ notification, onDismiss }: { notification: Notification; onDismiss: () => void }) {
  const style = notificationStyles[notification.type];
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(`${notification.title}\n\n${notification.message}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <div
      className={`${style.bg} ${style.border} border rounded-lg shadow-lg p-4 flex gap-3 items-start animate-slide-in pointer-events-auto backdrop-blur-sm`}
      role="alert"
    >
      {style.icon}
      <div className="flex-1 min-w-0">
        <h4 className="font-semibold text-white text-sm mb-1">{notification.title}</h4>
        <p className="text-ink-200 text-sm whitespace-pre-wrap break-words">{notification.message}</p>
      </div>
      <div className="flex gap-1 flex-shrink-0">
        {(notification.type === 'error' || notification.type === 'warning') && (
          <button
            onClick={handleCopy}
            className="text-ink-400 hover:text-white transition-colors p-1"
            aria-label="Copy error message"
            title={copied ? 'Copied!' : 'Copy to clipboard'}
          >
            {copied ? (
              <CheckCircle className="w-4 h-4 text-ok-400" />
            ) : (
              <Copy className="w-4 h-4" />
            )}
          </button>
        )}
        <button
          onClick={onDismiss}
          className="text-ink-400 hover:text-white transition-colors p-1"
          aria-label="Dismiss notification"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
