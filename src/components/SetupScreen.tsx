import { memo, useMemo } from 'react';
import { Loader2, Download, XCircle, CheckCircle2 } from 'lucide-react';
import type { SetupProgress } from '../electron.d';
import { Logo } from './Logo';

interface SetupScreenProps {
  isCheckingDeps: boolean;
  isSetupComplete: boolean;
  hasCudaSupport: boolean | null;
  setupProgress: SetupProgress | null;
  isSettingUp: boolean;
  onSetup: () => Promise<void>;
  pluginInstallError: string | null;
  onRetryPlugins: () => Promise<void>;
  onContinueWithoutPlugins: () => void;
}

export const SetupScreen = memo<SetupScreenProps>(({
  isCheckingDeps,
  isSetupComplete,
  hasCudaSupport,
  setupProgress,
  isSettingUp,
  onSetup,
  pluginInstallError,
  onRetryPlugins,
  onContinueWithoutPlugins,
}: SetupScreenProps) => {
  // Define the setup steps with their expected component names, in the order the
  // backend emits them. Component names use startsWith matching because the
  // backend may send versioned names.
  const setupSteps = useMemo(() => {
    const steps = [
      { id: 'video-compare', name: 'Video Compare Tool', description: 'Side-by-side comparison viewer', component: 'Video Compare Tool' },
      { id: 'python', name: 'Python & VapourSynth', description: 'Managed Python runtime with VapourSynth from PyPI', component: 'Python Embedded' },
      { id: 'models', name: 'ONNX Models', description: 'Bundled AI upscaling models', component: 'ONNX Models' },
      { id: 'ffmpeg', name: 'FFmpeg', description: 'Video encoding/decoding', component: 'FFmpeg' },
      {
        id: 'plugins',
        name: 'Plugins & Filters',
        description: hasCudaSupport
          ? 'PyTorch, vs-mlrt (TensorRT), vsjetpack, and plugin packages from PyPI'
          : 'PyTorch, vs-mlrt, vsjetpack, and plugin packages from PyPI',
        component: 'Plugins'
      }
    ];

    return steps;
  }, [hasCudaSupport]);

  // Track which steps are completed, in progress, or pending
  const stepStatuses = useMemo(() => {
    if (!setupProgress || !isSettingUp) {
      return setupSteps.reduce((acc, step) => {
        acc[step.id] = 'pending';
        return acc;
      }, {} as Record<string, 'pending' | 'in-progress' | 'completed'>);
    }

    const statuses: Record<string, 'pending' | 'in-progress' | 'completed'> = {};
    const currentComponent = setupProgress.component;
    
    // Check if all setup is complete (not just one component)
    const isFullyComplete = setupProgress.type === 'complete' && setupProgress.component === 'All Dependencies';

    if (isFullyComplete) {
      // Mark all steps as completed
      setupSteps.forEach(step => {
        statuses[step.id] = 'completed';
      });
      return statuses;
    }

    // Find the index of the current component
    // Use startsWith matching because the backend may send versioned names
    // but our step components are base names (e.g., 'vs-mlrt TensorRT')
    const currentIndex = setupSteps.findIndex(step => currentComponent.startsWith(step.component));

    for (let i = 0; i < setupSteps.length; i++) {
      const step = setupSteps[i];
      
      if (i < currentIndex) {
        // Steps before current are completed
        statuses[step.id] = 'completed';
      } else if (i === currentIndex) {
        // Current step is in progress (unless it just completed)
        statuses[step.id] = setupProgress.type === 'complete' ? 'completed' : 'in-progress';
      } else {
        // Steps after current are pending
        statuses[step.id] = 'pending';
      }
    }

    // If current component wasn't found, mark all as pending
    if (currentIndex === -1) {
      setupSteps.forEach(step => {
        statuses[step.id] = 'pending';
      });
    }

    return statuses;
  }, [setupProgress, setupSteps, isSettingUp]);

  // Checking dependencies screen
  if (isCheckingDeps) {
    return (
      <div className="min-h-screen bg-ink-950 flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-12 h-12 text-accent-500 animate-spin mx-auto mb-4" />
          <p className="text-lg text-ink-300">Checking dependencies...</p>
        </div>
      </div>
    );
  }

  // Setup required screen
  if (!isSetupComplete) {
    return (
      <div className="min-h-screen bg-ink-950 flex items-center justify-center p-6">
        <div className="max-w-lg w-full">
          {/* Header */}
          <div className="text-center mb-6">
            <div className="flex items-center justify-center gap-2 mb-1">
              <Logo className="w-6 h-6" />
              <h1 className="text-2xl font-bold bg-gradient-to-r from-accent-500 via-accent-500 to-accent-500 bg-clip-text text-transparent">
                Vapourkit
              </h1>
            </div>
            <p className="text-ink-400">First-time setup required</p>
          </div>

          {/* Main Card */}
          <div className="bg-ink-850 rounded-xl p-6 border border-ink-800">
            <h2 className="text-lg font-semibold mb-2">Download Required Components</h2>
            <p className="text-ink-400 text-sm mb-4">
              The following components will be downloaded and installed to the application's data folder:
            </p>

            {/* Component List */}
            <div className="space-y-2 mb-6">
              {setupSteps.map((step) => {
                const status = stepStatuses[step.id];
                const isCurrentStep = setupProgress?.component.startsWith(step.component) ?? false;
                
                return (
                  <div 
                    key={step.id}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-200 ${
                      status === 'completed' ? 'bg-ok-500/10 border border-ok-500/20' :
                      status === 'in-progress' ? 'bg-ink-900 border border-accent-500/50' :
                      'bg-ink-900 border border-transparent'
                    }`}
                  >
                    {/* Status Icon */}
                    {status === 'completed' ? (
                      <CheckCircle2 className="w-5 h-5 text-ok-400 flex-shrink-0" />
                    ) : status === 'in-progress' ? (
                      <Loader2 className="w-5 h-5 text-accent-500 animate-spin flex-shrink-0" />
                    ) : (
                      <Download className={`w-5 h-5 flex-shrink-0 ${
                        step.id === 'video-compare' ? 'text-warn-400' :
                        step.id === 'python' ? 'text-warn-400' :
                        step.id === 'models' ? 'text-pink-400' :
                        step.id === 'ffmpeg' ? 'text-accent-400' :
                        step.id === 'plugins' ? 'text-accent-500' :
                        'text-ink-400'
                      }`} />
                    )}
                    
                    {/* Name & Progress */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <div className="flex-1 min-w-0">
                          <p className={`font-medium ${
                            status === 'completed' ? 'text-ok-300' :
                            status === 'in-progress' ? 'text-white' :
                            'text-ink-300'
                          }`}>
                            {step.name}
                          </p>
                          <p className="text-sm text-ink-500">{step.description}</p>
                        </div>
                        {status === 'completed' && (
                          <span className="text-xs text-ok-400 ml-3 flex-shrink-0">Done</span>
                        )}
                        {status === 'in-progress' && isCurrentStep && setupProgress && (
                          <span className="text-xs text-accent-500 font-medium ml-3 flex-shrink-0">
                            {Math.round(setupProgress.progress)}%
                          </span>
                        )}
                      </div>
                      
                      {/* Progress bar for current step */}
                      {status === 'in-progress' && isCurrentStep && setupProgress && (
                        <div className="mt-1.5 h-1 bg-ink-950 rounded-full overflow-hidden">
                          <div 
                            className="h-full bg-gradient-to-r from-accent-500 to-accent-500 transition-all duration-300"
                            style={{ width: `${setupProgress.progress}%` }}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Error Message */}
            {setupProgress?.type === 'error' && !pluginInstallError && (
              <div className="mb-4 p-3 bg-bad-500/10 border border-bad-500/20 rounded-lg">
                <p className="text-bad-400 text-sm flex items-center gap-2">
                  <XCircle className="w-4 h-4 flex-shrink-0" />
                  {setupProgress.message}
                </p>
              </div>
            )}

            {/* Plugin install error with recovery options */}
            {pluginInstallError && (
              <div className="mb-4 p-3 bg-bad-500/10 border border-bad-500/20 rounded-lg space-y-3">
                <p className="text-bad-400 text-sm flex items-center gap-2">
                  <XCircle className="w-4 h-4 flex-shrink-0" />
                  Plugin install failed: {pluginInstallError}
                </p>
                <p className="text-ink-400 text-xs">
                  You can retry now, or continue without plugins and install them later from the Plugins menu.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={onRetryPlugins}
                    disabled={isSettingUp}
                    className="flex-1 bg-gradient-to-r from-accent-500 to-accent-500 hover:from-accent-600 hover:to-accent-600 disabled:from-ink-700 disabled:to-ink-700 disabled:cursor-not-allowed text-white text-sm font-medium py-2 px-4 rounded-lg transition-all duration-200"
                  >
                    Retry plugins
                  </button>
                  <button
                    onClick={onContinueWithoutPlugins}
                    disabled={isSettingUp}
                    className="flex-1 bg-ink-900 hover:bg-ink-700 disabled:bg-ink-900 disabled:cursor-not-allowed text-ink-200 text-sm font-medium py-2 px-4 rounded-lg transition-colors"
                  >
                    Continue without plugins
                  </button>
                </div>
              </div>
            )}

            {/* Action Button */}
            <button
              onClick={onSetup}
              disabled={isSettingUp}
              className="w-full bg-gradient-to-r from-accent-500 to-accent-500 hover:from-accent-600 hover:to-accent-600 disabled:from-ink-700 disabled:to-ink-700 disabled:cursor-not-allowed text-white font-semibold py-3 px-6 rounded-xl transition-all duration-200 flex items-center justify-center gap-2"
            >
              {isSettingUp ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Setting up...
                </>
              ) : (
                <>
                  <Download className="w-5 h-5" />
                  Start Setup
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
});
