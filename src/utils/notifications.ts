// Non-blocking notification system to replace blocking alert() calls
// Prevents main thread blocking that causes dropped frames and input unresponsiveness

export type NotificationType = 'info' | 'success' | 'warning' | 'error';

export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  timestamp: number;
}

const PRIVACY_TITLES: Record<NotificationType, string> = {
  error: 'Error',
  warning: 'Warning',
  success: 'Notification',
  info: 'Notification',
};

const PRIVACY_MESSAGE = 'Details hidden by privacy mode';

class NotificationManager {
  private listeners: Set<(notification: Notification) => void> = new Set();
  private notificationCounter = 0;
  private privacyMode = false;

  setPrivacyMode(enabled: boolean): void {
    this.privacyMode = enabled;
  }

  /**
   * Show a non-blocking notification
   * This replaces alert() to prevent main thread blocking
   */
  show(type: NotificationType, title: string, message: string): void {
    const notification: Notification = {
      id: `notification-${++this.notificationCounter}`,
      type,
      title: this.privacyMode ? PRIVACY_TITLES[type] : title,
      message: this.privacyMode ? PRIVACY_MESSAGE : message,
      timestamp: Date.now(),
    };

    // Notify all listeners
    this.listeners.forEach(listener => listener(notification));
  }

  /**
   * Subscribe to notifications
   * Returns unsubscribe function
   */
  subscribe(listener: (notification: Notification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Convenience methods
   */
  error(title: string, message: string): void {
    this.show('error', title, message);
  }

  warning(title: string, message: string): void {
    this.show('warning', title, message);
  }

  success(title: string, message: string): void {
    this.show('success', title, message);
  }

  info(title: string, message: string): void {
    this.show('info', title, message);
  }
}

export const notify = new NotificationManager();
