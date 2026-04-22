import { render } from 'solid-js/web';
import { App } from './App';

const container = document.getElementById('app');
if (!container) {
  throw new Error('#app container not found in index.html');
}
render(() => <App />, container);
