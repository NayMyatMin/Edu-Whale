// Page renderers (DOM). Split by section under js/ui/; re-exported here so
// callers have one import. The data pipeline (js/ui/pipeline.js) is loaded
// separately by main.js so a broken data module cannot stop the page.
export { renderStatus, buildShareText, levelName, levelKey } from './ui/status.js';
export { renderOfficial, stageChip } from './ui/official.js';
export { renderSystems } from './ui/systems.js';
export { renderNow, renderOutlook, wmoText, wmoIcon, dayFlag } from './ui/weather.js';
export { renderChecklist, renderContacts, renderSources } from './ui/prepare.js';
export { renderAbout, levelRules } from './ui/about.js';
export { renderFreshness } from './ui/freshness.js';
