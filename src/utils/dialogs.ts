// Confirmation prompts in the app's own dialog, in place of window.confirm:
// the native box looks foreign, blocks the renderer, and ignores privacy mode.
//
//   if (!(await ask({ title: 'Delete template', message: `Delete "${name}"?`, confirmLabel: 'Delete', tone: 'danger' }))) return;
//
// One dialog shows at a time; further asks wait their turn. ConfirmDialogHost
// renders them.

export interface AskOptions {
  title: string;
  /** Plain text; line breaks are kept. */
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 'danger' for a choice that deletes or replaces something. */
  tone?: 'default' | 'danger';
}

export interface AskRequest extends AskOptions {
  id: number;
  resolve: (confirmed: boolean) => void;
}

class DialogManager {
  private listeners = new Set<(requests: AskRequest[]) => void>();
  private requests: AskRequest[] = [];
  private counter = 0;

  ask(options: AskOptions): Promise<boolean> {
    return new Promise(resolve => {
      this.requests = [...this.requests, { ...options, id: ++this.counter, resolve }];
      this.emit();
    });
  }

  /** Answer the dialog showing now. */
  answer(id: number, confirmed: boolean): void {
    const request = this.requests.find(r => r.id === id);
    if (!request) return;
    this.requests = this.requests.filter(r => r.id !== id);
    this.emit();
    request.resolve(confirmed);
  }

  subscribe(listener: (requests: AskRequest[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.requests);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    this.listeners.forEach(listener => listener(this.requests));
  }
}

export const dialogs = new DialogManager();
export const ask = (options: AskOptions) => dialogs.ask(options);
