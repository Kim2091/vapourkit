import { Loader2, Download, XCircle } from 'lucide-react';
import type { SetupProgress } from '../electron.d';
import { Logo } from './Logo';

interface SetupScreenProps {
  isCheckingDeps: boolean;
  isSetupComplete: boolean;
  hasCudaSupport: boolean | null;
  setupProgress: SetupProgress | null;
  isSettingUp: boolean;
  onSetup: () => Promise<void>;
}

export function SetupScreen({
  isCheckingDeps,
  isSetupComplete,
  hasCudaSupport,
  setupProgress,
  isSettingUp,
  onSetup,
}: SetupScreenProps) {
  // Checking dependencies screen
  if (isCheckingDeps) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-dark-bg via-dark-surface to-dark-bg flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-16 h-16 text-primary-purple animate-spin mx-auto mb-4" />
          <p className="text-xl text-gray-300">Checking dependencies...</p>
        </div>
      </div>
    );
  }

  // Setup required screen
  if (!isSetupComplete) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-dark-bg via-dark-surface to-dark-bg flex items-center justify-center p-8">
        <div className="max-w-2xl w-full">
          <div className="text-center mb-8">
            <div className="flex items-center justify-center gap-2 mb-2">
              <Logo className="w-6 h-6" />
              <h1 className="text-2xl font-bold bg-gradient-to-r from-primary-blue via-primary-purple to-accent-cyan bg-clip-text text-transparent">
                Vapourkit
              </h1>
            </div>
            <p className="text-gray-400">First-time setup required</p>
          </div>

          <div className="bg-dark-elevated rounded-2xl p-8 border border-gray-800 shadow-xl">
            <h2 className="text-2xl font-semibold mb-4">Download Required Components</h2>
            <p className="text-gray-400 mb-6">
              The following components will be downloaded and installed to the application's data folder:
            </p>

            <div className="space-y-3 mb-6">
              <div className="flex items-center gap-3 p-3 bg-dark-surface rounded-lg">
                <Download className="w-5 h-5 text-primary-blue" />
                <div className="flex-1">
                  <p className="font-medium">VapourSynth Portable R72</p>
                  <p className="text-sm text-gray-500">Video processing framework</p>
                </div>
              </div>
              {hasCudaSupport && (
                <div className="flex items-center gap-3 p-3 bg-dark-surface rounded-lg">
                  <Download className="w-5 h-5 text-primary-purple" />
                  <div className="flex-1">
                    <p className="font-medium">vs-mlrt TensorRT Plugin v15.13</p>
                    <p className="text-sm text-gray-500">AI inference engine (NVIDIA GPUs)</p>
                  </div>
                </div>
              )}
              {!hasCudaSupport && hasCudaSupport !== null && (
                <div className="flex items-center gap-3 p-3 bg-dark-surface rounded-lg opacity-50">
                  <XCircle className="w-5 h-5 text-gray-600" />
                  <div className="flex-1">
                    <p className="font-medium">vs-mlrt TensorRT Plugin v15.13</p>
                    <p className="text-sm text-gray-500">Skipped - No NVIDIA GPU detected</p>
                  </div>
                </div>
              )}
              <div className="flex items-center gap-3 p-3 bg-dark-surface rounded-lg">
                <Download className="w-5 h-5 text-accent-cyan" />
                <div className="flex-1">
                  <p className="font-medium">vs-mlrt ONNX Runtime Plugin v15.13</p>
                  <p className="text-sm text-gray-500">DirectML support (AMD/Intel/NVIDIA GPUs)</p>
                </div>
              </div>
              <div className="flex items-center gap-3 p-3 bg-dark-surface rounded-lg">
                <Download className="w-5 h-5 text-green-400" />
                <div className="flex-1">
                  <p className="font-medium">BestSource R13</p>
                  <p className="text-sm text-gray-500">Video source filter</p>
                </div>
              </div>
              <div className="flex items-center gap-3 p-3 bg-dark-surface rounded-lg">
                <Download className="w-5 h-5 text-yellow-400" />
                <div className="flex-1">
                  <p className="font-medium">Video Compare Tool</p>
                  <p className="text-sm text-gray-500">Side-by-side comparison viewer for input/output videos</p>
                </div>
              </div>
            </div>

            {setupProgress && (
              <div className="mb-6">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium">{setupProgress.message.replace(/\.\.\.\s*\d+\.?\d*%?$/, '...')}</span>
                  <span className="text-base font-medium text-white">{Math.round(setupProgress.progress)}%</span>
                </div>
                <div className="w-full bg-dark-surface rounded-full h-2">
                  <div 
                    className="bg-gradient-to-r from-primary-blue to-primary-purple h-2 rounded-full transition-all duration-300"
                    style={{ width: `${setupProgress.progress}%` }}
                  />
                </div>
                {setupProgress.type === 'error' && (
                  <p className="text-red-400 text-sm mt-2 flex items-center gap-2">
                    <XCircle className="w-4 h-4" />
                    {setupProgress.message}
                  </p>
                )}
              </div>
            )}
            
            <button
              onClick={onSetup}
              disabled={isSettingUp}
              className="w-full bg-gradient-to-r from-primary-blue to-primary-purple hover:from-blue-600 hover:to-purple-600 disabled:from-gray-700 disabled:to-gray-700 disabled:cursor-not-allowed text-white font-semibold py-4 px-6 rounded-xl transition-all duration-300 flex items-center justify-center gap-3"
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
}