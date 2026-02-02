// Non-blocking notification toast component
import { X, AlertCircle, CheckCircle, Info, AlertTriangle } from 'lucide-react';
import { useNotifications } from '../hooks/useNotifications';
import { Notification, NotificationType } from '../utils/notifications';

const notificationStyles: Record<NotificationType, { bg: string; border: string; icon: JSX.Element }> = {
  error: {
    bg: 'bg-red-900/90',
    border: 'border-red-500',
    icon: <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0" />,
  },
  warning: {
    bg: 'bg-yellow-900/90',
    border: 'border-yellow-500',
    icon: <AlertTriangle className="w-5 h-5 text-yellow-400 flex-shrink-0" />,
  },
  success: {
    bg: 'bg-green-900/90',
    border: 'border-green-500',
    icon: <CheckCircle className="w-5 h-5 text-green-400 flex-shrink-0" />,
  },
  info: {
    bg: 'bg-blue-900/90',
    border: 'border-blue-500',
    icon: <Info className="w-5 h-5 text-blue-400 flex-shrink-0" />,
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

  return (
    <div
      className={`${style.bg} ${style.border} border rounded-lg shadow-lg p-4 flex gap-3 items-start animate-slide-in pointer-events-auto backdrop-blur-sm`}
      role="alert"
    >
      {style.icon}
      <div className="flex-1 min-w-0">
        <h4 className="font-semibold text-white text-sm mb-1">{notification.title}</h4>
        <p className="text-gray-200 text-sm whitespace-pre-wrap break-words">{notification.message}</p>
      </div>
      <button
        onClick={onDismiss}
        className="text-gray-400 hover:text-white transition-colors flex-shrink-0 p-1"
        aria-label="Dismiss notification"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
