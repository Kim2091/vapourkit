// Handle CLI metadata before loading modules that initialize logs, data, or UI.
import { app } from 'electron';

if (process.argv.includes('--version')) {
  console.log(app.getVersion());
  app.exit(0);
} else {
  void import('./main');
}
