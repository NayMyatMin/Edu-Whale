// English core strings: attention levels, reasons, storm classes, DMH terms,
// directions, units and season notes. Written for older readers: short,
// plain, calm sentences that always point back to DMH.
//
// Reason templates use the raw params emitted by js/risk.js; i18n.js formats
// them by name ({km} -> "89 km", {kmh} -> "62 km/h (39 mph)", {time} -> Yangon
// time, {compass} -> dir.*, {stage} -> dmh.stage.*, {system} -> dmh.system.*,
// {cls} -> imd.*, {potential} -> jtwc.potential.*, {title}/{message} -> by language).

export default {
  // ---------------------------------------------------------------------------
  // Attention levels (this site's own reading, not DMH's colour stages)
  // ---------------------------------------------------------------------------
  'level.calm.name': 'Calm',
  'level.calm.headline': 'No storm is threatening Yangon at the moment.',
  'level.calm.advice': 'Nothing to do today. During storm season, look at this page or DMH once a day.',

  'level.monitor.name': 'Monitor',
  'level.monitor.headline': 'Something to keep an eye on. No danger to Yangon yet.',
  'level.monitor.advice': 'Check DMH news once or twice a day. Keep phones charged and your emergency bag ready.',

  'level.prepare.name': 'Prepare',
  'level.prepare.headline': 'Yangon could be affected in the next few days. Get ready now.',
  'level.prepare.advice':
    'Check DMH warnings every few hours. Store drinking water, charge phones and power banks, and tie down loose things. If you live by the river or in a light house, decide now where you will go.',

  'level.danger.name': 'Danger',
  'level.danger.headline': 'Storm weather is likely in Yangon now or very soon. Stay safe.',
  'level.danger.advice':
    'Stay inside a strong building, away from windows. Follow DMH and local authorities. Do not walk or drive through floodwater. Help older neighbours.',

  'level.unknown.name': 'Unknown',
  'level.unknown.headline': 'We could not check all storm sources. Please check DMH directly.',
  'level.unknown.advice':
    'This page could not load the latest official or storm data, so it cannot say that all is calm. Check moezala.gov.mm, or DMH bulletins on radio and TV.',

  // ---------------------------------------------------------------------------
  // Reasons (key = reason.<code>)
  // ---------------------------------------------------------------------------
  'reason.dmh.stage': 'DMH: {system}, {stage}. The centre is about {km} {compass} of Yangon (issued {time}).',
  'reason.dmh.stageNoPos': 'DMH: {system}, {stage} (issued {time}).',
  'reason.dmh.warning': 'DMH has a warning in force: {system} (issued {time}). Read it on the DMH website.',
  'reason.dmh.news': 'DMH is reporting on a weather system: {system} (issued {time}). Keep following DMH.',
  'reason.dmh.passed': 'DMH Green stage ({system}): the storm has weakened and the danger has passed (issued {time}). Watch out for fallen trees, power lines and floodwater.',
  'reason.dmh.otherWarning': 'DMH bulletin that mentions Yangon: {title} (issued {time}).',
  'reason.dmh.newsFinal': 'DMH has issued its last news bulletin about the {system} (issued {time}) and is no longer following it.',

  'reason.storm.insideWind': 'Yangon is inside the area where {name} is forecast to bring winds of {kmh} or more.',
  'reason.storm.insideWindLater': 'Yangon is inside the area where {name} is forecast to bring winds of {kmh} or more in about {hours} hours.',
  'reason.storm.insideCone': 'Yangon is inside the forecast cone of {name}. Its path could still move towards the city.',
  'reason.storm.trackNear': '{name} ({cls}) is forecast to pass within {km} of Yangon in about {hours} hours.',
  'reason.storm.currentNear': '{name} is {km} {compass} of Yangon.',
  'reason.storm.tcfaNear': 'A storm may form near Yangon: JTWC has a formation alert for {name}, about {km} away.',
  'reason.storm.hurricaneNear': '{name} is forecast to be a very strong cyclone within {km} of Yangon in about {hours} hours.',
  'reason.storm.inRegion': '{name} is active in our region, {km} {compass} of Yangon.',
  'reason.storm.forecastWithin': 'The forecast path of {name} comes within {km} of Yangon.',
  'reason.storm.invest': 'JTWC is watching {name}, an area of disturbed weather {km} from Yangon. Chance of it becoming a cyclone: {potential}.',

  'reason.weather.gust': 'Wind gusts of up to {kmh} are forecast in Yangon, around {time}.',
  'reason.weather.wind': 'Steady winds of up to {kmh} are forecast in Yangon, around {time}.',
  'reason.weather.rain24h': 'Up to {mm} of rain is forecast in 24 hours (until {time}).',
  'reason.weather.rain48h': 'Up to {mm} of rain is forecast in 48 hours.',
  'reason.weather.rain72h': 'Up to {mm} of rain is forecast over the next 3 days.',
  'reason.weather.rainHour': 'Very heavy bursts of rain: up to {mm} in one hour, around {time}.',

  'reason.override': '{message}',
  'reason.calm': 'No storm is near Yangon, and the forecast shows no strong wind or very heavy rain.',
  'reason.calm.partial': 'DMH has no current cyclone bulletin, and no storm is near Yangon in the sources this page could check. Some sources could not be checked (listed below).',
  'reason.calm.noForecast': 'No storm is near Yangon. The weather forecast could not be loaded, so strong wind or heavy rain cannot be ruled out.',
  'reason.unknown': 'Some sources could not be loaded, so this page cannot say it is calm. DMH has the official picture.',

  // ---------------------------------------------------------------------------
  // Storm classes
  // ---------------------------------------------------------------------------
  'imd.low': 'Low pressure area',
  'imd.d': 'Depression',
  'imd.dd': 'Deep depression',
  'imd.cs': 'Cyclonic storm',
  'imd.scs': 'Severe cyclonic storm',
  'imd.vscs': 'Very severe cyclonic storm',
  'imd.escs': 'Extremely severe cyclonic storm',
  'imd.sucs': 'Super cyclonic storm',

  'jtwc.TD': 'Tropical depression',
  'jtwc.TS': 'Tropical storm',
  'jtwc.HU': 'Typhoon strength',
  'jtwc.kind.warning': 'JTWC warning',
  'jtwc.kind.tcfa': 'Formation alert',
  'jtwc.kind.invest': 'Being watched (invest)',
  'jtwc.potential.LOW': 'low',
  'jtwc.potential.MEDIUM': 'medium',
  'jtwc.potential.HIGH': 'high',
  'jtwc.potential.UNKNOWN': 'not yet rated',

  // ---------------------------------------------------------------------------
  // DMH terms (shown as DMH words them; never reused for this site's levels)
  // ---------------------------------------------------------------------------
  'dmh.stage.yellow': 'Yellow stage',
  'dmh.stage.yellow.meaning': 'A storm is starting to form in the Bay of Bengal or the Andaman Sea.',
  'dmh.stage.orange': 'Orange stage',
  'dmh.stage.orange.meaning': 'A storm has formed and is moving towards the Myanmar coast.',
  'dmh.stage.red': 'Red stage',
  'dmh.stage.red.meaning': 'About 12 hours before the storm crosses the Myanmar coast.',
  'dmh.stage.brown': 'Brown stage',
  'dmh.stage.brown.meaning': 'The storm is crossing the Myanmar coast now.',
  'dmh.stage.green': 'Green stage',
  'dmh.stage.green.meaning': 'The storm has weakened and the danger has passed.',

  'dmh.system.low': 'Low pressure area',
  'dmh.system.well-marked-low': 'Well-marked low pressure area',
  'dmh.system.depression': 'Depression',
  'dmh.system.deep-depression': 'Deep depression',
  'dmh.system.cs': 'Cyclonic storm',
  'dmh.system.scs': 'Severe cyclonic storm',
  'dmh.system.vscs': 'Very severe cyclonic storm',
  'dmh.system.escs': 'Extremely severe cyclonic storm',
  'dmh.system.sucs': 'Super cyclonic storm',
  'dmh.system.unknown': 'Weather system',

  'dmh.kind.warning': 'Warning',
  'dmh.kind.warning.meaning': 'DMH issues a Warning when Myanmar may be affected.',
  'dmh.kind.news': 'News',
  'dmh.kind.news.meaning': 'DMH issues News about a weather system that is not expected to hit Myanmar yet.',

  'dmh.otherType.flood': 'Flood',
  'dmh.otherType.flash-flood': 'Flash flood',
  'dmh.otherType.heavy-rain': 'Heavy rain',
  'dmh.otherType.strong-wind': 'Strong wind',
  'dmh.otherType.water-level': 'River water level',
  'dmh.otherType.other': 'Other warning',

  // ---------------------------------------------------------------------------
  // Directions ("90 km east-northeast of Yangon")
  // ---------------------------------------------------------------------------
  'dir.N': 'north',
  'dir.NNE': 'north-northeast',
  'dir.NE': 'northeast',
  'dir.ENE': 'east-northeast',
  'dir.E': 'east',
  'dir.ESE': 'east-southeast',
  'dir.SE': 'southeast',
  'dir.SSE': 'south-southeast',
  'dir.S': 'south',
  'dir.SSW': 'south-southwest',
  'dir.SW': 'southwest',
  'dir.WSW': 'west-southwest',
  'dir.W': 'west',
  'dir.WNW': 'west-northwest',
  'dir.NW': 'northwest',
  'dir.NNW': 'north-northwest',

  // ---------------------------------------------------------------------------
  // Units
  // ---------------------------------------------------------------------------
  'unit.kmh': 'km/h',
  'unit.mph': 'mph',
  'unit.km': 'km',
  'unit.mi': 'mi',
  'unit.mm': 'mm',
  'unit.in': 'in',
  'unit.hpa': 'hPa',
  'unit.kt': 'kt',
  'unit.c': '°C',
  'unit.percent': '%',
  'unit.nmi': 'nautical miles',

  // ---------------------------------------------------------------------------
  // Season context for the "no storms" state (SEASON_BY_MONTH)
  // ---------------------------------------------------------------------------
  'season.quiet': 'January to March is usually quiet. Cyclones rarely come near Yangon at this time of year.',
  'season.peak': 'April and May are the main cyclone season for Yangon and the Ayeyarwady delta. Keep an eye on DMH.',
  'season.monsoon': 'June to September is the monsoon. Flooding rain and depressions are the main risks, not strong cyclones.',
  'season.second': 'October to December is the second cyclone season. Most storms go to India, Bangladesh or Rakhine, but some reach the delta.',
};
