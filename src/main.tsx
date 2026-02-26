import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import { installTauriApi } from './tauriApi'

// Install Tauri → electronAPI bridge before any component renders
installTauriApi()

declare const __APP_VERSION__: string
document.title = `Vapourkit v${__APP_VERSION__}`

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)