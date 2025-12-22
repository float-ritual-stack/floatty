/* @refresh reload */
import { render } from 'solid-js/web';
import './shelf.css';
import { ShelfPanel } from './components/ShelfPanel';

render(() => <ShelfPanel />, document.getElementById('root')!);
