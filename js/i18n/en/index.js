// English dictionary: core (levels, reasons, storm terms), map and page UI,
// merged into one flat { 'dotted.key': 'text' } object.
import core from './core.js';
import map from './map.js';
import ui from './ui.js';

export default Object.freeze({ ...core, ...map, ...ui });
