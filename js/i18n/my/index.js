// Burmese dictionary (filled in by the translation phase). Missing keys fall
// back to English in js/i18n.js.
import core from './core.js';
import map from './map.js';
import ui from './ui.js';

export default Object.freeze({ ...core, ...map, ...ui });
