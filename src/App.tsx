import { onMount } from 'solid-js';
import { Terminal } from './components/Terminal';
import { themeStore } from './hooks/useThemeStore';
import './App.css';

function App() {
  // Load saved theme on startup
  onMount(() => {
    themeStore.loadTheme();
  });

  return <Terminal />;
}

export default App;
