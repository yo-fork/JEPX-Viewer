import './styles.css';
import { App } from './app';

const root = document.getElementById('app');
if (root) {
  void new App(root).start();
}
