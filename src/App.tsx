import { onMount } from 'solid-js';
import { Terminal } from './components/Terminal';
import { themeStore } from './hooks/useThemeStore';
import { terminalManager } from './lib/terminalManager';
import './App.css';

function App() {
  // Load saved theme and terminal config on startup
  onMount(async () => {
    await terminalManager.loadConfig();
    themeStore.loadTheme();
  });

  return <Terminal />;
}

export default App;
