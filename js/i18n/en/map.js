// English strings for the interactive map (js/map.js). Keys are map.* only.
// Params are pre-formatted strings from map.js ({dist}, {wind}, {when} come
// from the page's formatters; {dir}, {kind}, {strength}, {chance}, {sys} are
// already-translated labels). Param names deliberately avoid the reason.*
// convention (km, time, cls, ...) so i18n.js never re-formats them.

export default {
  // Map / Windy switch
  'map.tabs.label': 'Map view',
  'map.tab.map': 'Map',
  'map.tab.windy': 'Live wind (Windy)',
  'map.aria': 'Storm map around Yangon. Use the arrow keys to move the map and the plus and minus keys to zoom.',
  'map.zoomIn': 'Zoom in',
  'map.zoomOut': 'Zoom out',
  'map.fit': 'Show Yangon and all storms',
  'map.unavailable': 'The map could not be loaded. The storm information above is still up to date.',

  // Layer switches
  'map.layers.label': 'Map layers',
  'map.layer.satellite': 'Satellite',
  'map.layer.radar': 'Rain radar',
  'map.layer.tracks': 'Storm tracks',
  'map.layer.wind': 'Wind areas',
  'map.layer.rings': 'Distance rings',
  'map.layer.on': 'On',
  'map.layer.off': 'Off',

  // Satellite loop
  'map.sat.group': 'Satellite images',
  'map.sat.play': 'Play',
  'map.sat.playLabel': 'Play the satellite loop',
  'map.sat.pause': 'Pause',
  'map.sat.pauseLabel': 'Pause the satellite loop',
  'map.sat.step': 'Next image',
  'map.sat.stepLabel': 'Show the next satellite image',
  'map.sat.loading': 'Loading satellite images…',
  'map.sat.slider': 'Time of the satellite image',
  'map.sat.time': 'Satellite {when}',
  'map.sat.newest': 'newest',
  'map.sat.off': 'Satellite is off',
  'map.sat.unavailable': 'Satellite images could not be loaded right now.',
  'map.sat.latestOnly': 'Only the latest satellite image is available right now.',
  'map.ago.minutes': '{n} min ago',
  'map.ago.hours': '{n} h ago',

  // Rain radar
  'map.radar.time': 'Rain radar {when}',
  'map.radar.loading': 'Loading rain radar…',
  'map.radar.unavailable': 'Rain radar could not be loaded right now.',

  // Hints
  'map.hint.mouse': 'Click the map to zoom with the mouse wheel.',
  'map.hint.touch': 'Tap the map once, then drag to move it. Pinch to zoom.',

  // Legend
  'map.legend.title': 'Map key',
  'map.legend.tracks': 'Storm tracks',
  'map.legend.trackObserved': 'Past track',
  'map.legend.trackForecast': 'Forecast track',
  'map.legend.position': 'Storm centre now',
  'map.legend.points': 'Dots show the strength at each time:',
  'map.legend.from': 'from {wind}',
  'map.legend.cone': 'Forecast cone: where the centre may go',
  'map.legend.windTitle': 'Forecast wind areas',
  'map.legend.wind': 'Winds of {wind} or more',
  'map.legend.tcfa': 'Formation alert: a cyclone may form in this area',
  'map.legend.invest': 'Area being watched (invest)',
  'map.legend.placesTitle': 'Positions and distances',
  'map.legend.dmh': 'Official position from DMH',
  'map.legend.home': 'Yangon',
  'map.legend.rings': 'Distance from Yangon',
  'map.legend.satTitle': 'Infrared satellite',
  'map.legend.sat':
    'Brighter, colder colours mean taller storm clouds, which bring heavier rain and stronger wind. Grey means low cloud or clear sky. The newest image is usually about an hour old.',
  'map.legend.satImg': 'Colour scale of cloud-top temperature: grey is warm and low, bright colours are very cold and high.',
  'map.legend.radarTitle': 'Rain radar',
  'map.legend.radar': 'Coloured patches show rain falling in the last few minutes, where radar covers the area.',
  'map.legend.note': 'This map is a guide only. For official warnings, follow DMH.',

  // Labels and popups
  'map.home': 'Yangon',
  'map.homeLabel': 'Yangon (home)',
  'map.ring': '{dist} from Yangon',
  'map.popup.distance': '{dist} {dir} of Yangon',
  'map.popup.wind': 'Wind: {wind}',
  'map.popup.windUnknown': 'Wind: not known yet',
  'map.popup.time': 'Position at {when}',
  'map.popup.moving': 'Moving {dir} at {speed}',
  'map.popup.closest': 'Closest forecast approach: {dist} around {when}',
  'map.popup.potential': 'Chance of becoming a cyclone: {chance}',
  'map.popup.validUntil': 'Alert valid until {when}',
  'map.popup.sources': 'Source: {list}',
  'map.dmh.wind': 'Wind (as DMH states it): {wind}',
  'map.kind.warning': 'Tropical cyclone',
  'map.popup.forecast': 'Forecast',
  'map.popup.observed': 'Observed',
  'map.point': '{kind} {when}: {strength}, {wind}',
  'map.point.noWind': '{kind} {when}: {strength}',
  'map.cone': 'Forecast cone of {label}',
  'map.windArea': '{label}: winds of {wind} or more',
  'map.tcfa': '{label}: formation alert area',
  'map.invest': '{label}: chance {chance}',
  'map.system.label': '{label}, {kind}. {where}',

  // DMH marker
  'map.dmh.badge': 'DMH',
  'map.dmh.title': 'DMH official position',
  'map.dmh.issued': 'Issued {when}',
  'map.dmh.read': 'Read the DMH bulletin',
  'map.dmh.label': 'DMH official position: {sys}. {where}',

  // Windy tab
  'map.windy.title': 'Live wind map from Windy.com',
  'map.windy.note': 'Windy shows a computer wind forecast, not an official warning. For warnings, follow DMH.',

  // Attribution (proper names stay as they are)
  'map.attr.contributors': 'contributors',
  'map.attr.imagery': 'Imagery',
  'map.attr.radar': 'Radar',
  'map.attr.tracks': 'Tracks',
};
