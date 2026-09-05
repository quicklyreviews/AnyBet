/**
 * Worked examples for the create form.
 *
 * Each one reads its source at the moment you click it and sets the threshold
 * from what it finds. A number typed into a template ages badly: "above 80,000
 * USD" is a coin flip one week and a foregone conclusion the next, and a market
 * whose answer is already known is not a market.
 *
 * They are grouped by reach, because that grouping is the argument the product
 * makes: the same machinery settles a question about the whole planet, one
 * about a single city, and one about a single repository, and nothing in the
 * contract changes between them.
 *
 * Two rules all of them follow, because they are what makes a market
 * resolvable: the criteria names the exact field to read, and it says what
 * counts as UNKNOWN.
 *
 * Every host here was checked against what a GenLayer validator node actually
 * receives, with tests/integration/probe_sources.py. Do not add one that has
 * not been - a source validators cannot reach resolves UNKNOWN however good the
 * question was, and Binance taught us that it can fail while looking healthy.
 */

const COINGECKO_BTC = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd';
const COINGECKO_GLOBAL = 'https://api.coingecko.com/api/v3/global';
const USGS_M5_24H =
  'https://earthquake.usgs.gov/fdsnws/event/1/count?format=geojson&minmagnitude=5&starttime=now-1days';
const ISS_NOW = 'http://api.open-notify.org/iss-now.json';
const ASTRONAUTS = 'http://api.open-notify.org/astros.json';
const BOILERPLATE_REPO = 'https://api.github.com/repos/genlayerlabs/genlayer-project-boilerplate';

// One field per URL, deliberately. The sources box is comma-separated, so a URL
// carrying a literal comma - which Open-Meteo's multi-field `daily=a,b` form
// produces - gets split in half and half of it registered as a broken source.
const meteo = (lat, lon, tz, field) =>
  `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
  + `&timezone=${tz}&forecast_days=2&daily=${field}`;

const HANOI_RAIN = meteo('21.0278', '105.8342', 'Asia%2FBangkok', 'precipitation_sum');
const HANOI_HEAT = meteo('21.0278', '105.8342', 'Asia%2FBangkok', 'temperature_2m_max');
const LONDON_RAIN = meteo('51.5072', '-0.1276', 'Europe%2FLondon', 'precipitation_sum');
const TOKYO_HEAT = meteo('35.6762', '139.6503', 'Asia%2FTokyo', 'temperature_2m_max');
const HANOI_AIR =
  'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=21.0278&longitude=105.8342'
  + '&hourly=pm2_5&forecast_days=1';

/** Fetches a source from the browser. This is not what the validators do - they
 *  each fetch it themselves at resolution - but it is the same URL, so it is a
 *  fair preview of what they will be looking at. */
export async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const usd = (n) => n.toLocaleString('en-US');

export const TEMPLATES = [
  {
    group: 'Planet',
    label: 'Earthquakes worldwide',
    minutes: 1440,
    sources: USGS_M5_24H,
    async build() {
      const data = await fetchJson(USGS_M5_24H);
      const count = Number(data?.count);
      if (!Number.isFinite(count)) return null;
      return {
        question: `Will more than ${count} magnitude-5+ earthquakes strike worldwide in the next 24 hours?`,
        criteria:
          'The source counts magnitude-5.0-and-above earthquakes anywhere on Earth over the '
          + `last 24 hours. Read the "count" field. Answer YES if it is greater than ${count}, `
          + `NO if it is ${count} or fewer. If the field is missing, answer UNKNOWN.`,
        note: `The last 24 hours saw ${count}. USGS counts the whole planet, so this is about as global as a question gets.`,
      };
    },
  },
  {
    group: 'Planet',
    label: 'ISS over the north',
    minutes: 6,
    sources: ISS_NOW,
    async build() {
      const data = await fetchJson(ISS_NOW);
      const lat = Number(data?.iss_position?.latitude);
      return {
        question: 'Will the ISS be north of the equator when this market closes?',
        criteria:
          'Read iss_position.latitude from the source, the current latitude of the station '
          + 'in degrees. Answer YES if it is greater than 0, NO if it is 0 or less. If the '
          + 'field is missing, answer UNKNOWN.',
        note: Number.isFinite(lat)
          ? `The station is at latitude ${lat.toFixed(1)} and circles the Earth every 90 minutes, so over six minutes this is near enough a coin flip.`
          : 'Position unavailable at the moment.',
      };
    },
  },
  {
    group: 'Planet',
    label: 'Crew in orbit',
    minutes: 10080,
    sources: ASTRONAUTS,
    async build() {
      const data = await fetchJson(ASTRONAUTS);
      const n = Number(data?.number);
      if (!Number.isFinite(n)) return null;
      return {
        question: `Will there still be exactly ${n} people in space a week from now?`,
        criteria:
          'Read the "number" field, which is how many people are currently off the planet. '
          + `Answer YES if it is exactly ${n}, NO if it is any other number. If the field is `
          + 'missing, answer UNKNOWN.',
        note: `${n} people are in orbit right now. A launch or a crew rotation is what moves this.`,
      };
    },
  },

  {
    group: 'Markets',
    label: 'Bitcoin price',
    minutes: 60,
    sources: [
      COINGECKO_BTC,
      'https://api.coinbase.com/v2/prices/BTC-USD/spot',
      'https://api.kraken.com/0/public/Ticker?pair=XBTUSD',
    ].join(','),
    async build() {
      const data = await fetchJson(COINGECKO_BTC);
      const price = Number(data?.bitcoin?.usd);
      if (!price) return null;
      const target = Math.ceil((price * 1.004) / 100) * 100;
      return {
        question: `Will Bitcoin be above ${usd(target)} USD when this market closes?`,
        criteria:
          'Read the BTC/USD price from any of the source JSON bodies. Answer YES if that '
          + `price is greater than ${target}, and NO if it is not. If none of the sources `
          + 'returned a usable price, answer UNKNOWN.',
        note: `BTC is ${usd(price)} USD right now, so this needs a move of about ${(((target / price) - 1) * 100).toFixed(2)}%.`,
      };
    },
  },
  {
    group: 'Markets',
    label: 'Total crypto market cap',
    minutes: 360,
    sources: COINGECKO_GLOBAL,
    async build() {
      const data = await fetchJson(COINGECKO_GLOBAL);
      const cap = Number(data?.data?.total_market_cap?.usd);
      if (!cap) return null;
      const trillions = cap / 1e12;
      const target = Math.round(trillions * 1.005 * 100) / 100;
      return {
        question: `Will the total crypto market cap be above ${target} trillion USD in six hours?`,
        criteria:
          'Read data.total_market_cap.usd from the source, in US dollars. Answer YES if it is '
          + `greater than ${Math.round(target * 1e12)}, NO if it is not. If the field is `
          + 'missing, answer UNKNOWN.',
        note: `Every crypto asset together is worth ${trillions.toFixed(2)} trillion USD right now.`,
      };
    },
  },

  {
    group: 'Cities',
    label: 'Rain in London',
    minutes: 1440,
    sources: LONDON_RAIN,
    async build() {
      const data = await fetchJson(LONDON_RAIN);
      const mm = Number(data?.daily?.precipitation_sum?.[1]);
      return {
        question: 'Will London get at least 1mm of rain tomorrow?',
        criteria:
          'The source is an Open-Meteo forecast for London. Read the second entry of '
          + 'daily.precipitation_sum, which is tomorrow, in millimetres. Answer YES if it is '
          + '1 or more, NO if it is less. If that entry is missing, answer UNKNOWN.',
        note: Number.isFinite(mm) ? `The forecast currently says ${mm}mm.` : 'Forecast unavailable.',
      };
    },
  },
  {
    group: 'Cities',
    label: 'Tokyo heat',
    minutes: 1440,
    sources: TOKYO_HEAT,
    async build() {
      const data = await fetchJson(TOKYO_HEAT);
      const t = Number(data?.daily?.temperature_2m_max?.[1]);
      if (!Number.isFinite(t)) return null;
      const target = Math.round(t);
      return {
        question: `Will Tokyo reach ${target}C tomorrow?`,
        criteria:
          'The source is an Open-Meteo forecast for Tokyo. Read the second entry of '
          + `daily.temperature_2m_max, the high for tomorrow in Celsius. Answer YES if it is `
          + `${target} or more, NO if it is below. If that entry is missing, answer UNKNOWN.`,
        note: `Tomorrow's high is forecast at ${t}C, so this sits on the line.`,
      };
    },
  },
  {
    group: 'Cities',
    label: 'Rain in Hanoi',
    minutes: 1440,
    sources: HANOI_RAIN,
    async build() {
      const data = await fetchJson(HANOI_RAIN);
      const mm = Number(data?.daily?.precipitation_sum?.[1]);
      return {
        question: 'Will Hanoi get at least 1mm of rain tomorrow?',
        criteria:
          'The source is an Open-Meteo forecast for Hanoi. Read the second entry of '
          + 'daily.precipitation_sum, which is tomorrow, in millimetres. Answer YES if it is '
          + '1 or more, NO if it is less. If that entry is missing, answer UNKNOWN.',
        note: Number.isFinite(mm)
          ? `The forecast currently says ${mm}mm - forecasts move, which is the point.`
          : 'Forecast unavailable at the moment.',
      };
    },
  },
  {
    group: 'Cities',
    label: 'Hanoi heat',
    minutes: 1440,
    sources: HANOI_HEAT,
    async build() {
      const data = await fetchJson(HANOI_HEAT);
      const t = Number(data?.daily?.temperature_2m_max?.[1]);
      if (!Number.isFinite(t)) return null;
      const target = Math.round(t);
      return {
        question: `Will Hanoi reach ${target}C tomorrow?`,
        criteria:
          'The source is an Open-Meteo forecast for Hanoi. Read the second entry of '
          + `daily.temperature_2m_max, the high for tomorrow in Celsius. Answer YES if it is `
          + `${target} or more, NO if it is below. If that entry is missing, answer UNKNOWN.`,
        note: `Tomorrow's high is forecast at ${t}C, so this sits right on the line.`,
      };
    },
  },
  {
    group: 'Cities',
    label: 'Hanoi air quality',
    minutes: 360,
    sources: HANOI_AIR,
    async build() {
      const data = await fetchJson(HANOI_AIR);
      const series = data?.hourly?.pm2_5 || [];
      const now = series.find((v) => Number.isFinite(v));
      if (!Number.isFinite(now)) return null;
      const target = Math.round(now);
      return {
        question: `Will Hanoi PM2.5 be above ${target} in six hours?`,
        criteria:
          'The source is an Open-Meteo air-quality forecast for Hanoi. Read the hourly.pm2_5 '
          + 'series and take the value closest to the time you are resolving, in micrograms '
          + `per cubic metre. Answer YES if it is greater than ${target}, NO if it is not. If `
          + 'no usable value is present, answer UNKNOWN.',
        note: `PM2.5 is around ${now} right now; anything past 35 is unhealthy for sensitive groups.`,
      };
    },
  },

  {
    group: 'Code',
    label: 'GitHub stars',
    minutes: 1440,
    sources: BOILERPLATE_REPO,
    async build() {
      const data = await fetchJson(BOILERPLATE_REPO);
      const stars = Number(data?.stargazers_count);
      if (!stars) return null;
      const target = stars + 25;
      return {
        question: `Will genlayer-project-boilerplate pass ${usd(target)} GitHub stars?`,
        criteria:
          'Read stargazers_count from the source JSON. Answer YES if it is greater than '
          + `${target}, NO if it is not. If the field is absent, answer UNKNOWN.`,
        note: `The repo is on ${usd(stars)} stars, so this needs 25 more inside a day.`,
      };
    },
  },
];
