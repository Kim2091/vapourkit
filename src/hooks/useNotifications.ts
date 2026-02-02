// Hook for displaying non-blocking notifications in the UI
import { useEffect, useState } from 'react';
import { notify, Notification } from '../utils/notifications';

export function useNotifications() {
  const [notifications, setNotifications] = useState<Notification[]>([]);

  useEffect(() => {
    const unsubscribe = notify.subscribe((notification) => {
      setNotifications(prev => [...prev, notification]);

      // Auto-dismiss after 5 seconds
      setTimeout(() => {
        setNotifications(prev => prev.filter(n => n.id !== notification.id));
      }, 5000);
    });

    return unsubscribe;
  }, []);

  const dismissNotification = (id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  };

  return { notifications, dismissNotification };
}
