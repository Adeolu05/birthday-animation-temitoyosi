// Personalise the celebration here.
//
// Every value can also be set from the link itself, so one page works for anyone:
//   celebration/index.html?name=Temitoyosi&age=25&from=David
//   celebration/index.html?name=Ada&msg=Have%20the%20best%20day%20ever!
//
// Supported URL params: name, age, from, msg, candles

export const DEFAULTS = {
  name: 'Temitoyosi',
  age: 21,              // shows the age in the sky and on the letter (null to hide)
  from: 'David',        // signature on the letter
  candles: 7,           // 1–12 candles on the cake
  message:
    'To the grace you carry, the warmth you bring into every room, and every ' +
    'beautiful thing this new year is holding for you. Wear your crown well.',
  // Photos shown in gilded frames in the finale (paths are relative to this folder).
  photos: [
    'img/photo-crown-2.jpg',
    'img/photo-crown.jpg',
    'img/photo-smile.jpg',
    '../Temitoyosi/img/image1.jfif',
    'img/photo-aug19.jpg',
    '../Temitoyosi/img/image2.jfif',
  ],
};

export function getConfig() {
  const q = new URLSearchParams(location.search);
  const clean = (s, max) => (s || '').replace(/\s+/g, ' ').trim().slice(0, max);

  const name = clean(q.get('name'), 24) || DEFAULTS.name;
  const ageRaw = parseInt(q.get('age'), 10);
  const age = Number.isFinite(ageRaw) && ageRaw > 0 && ageRaw < 150 ? ageRaw : DEFAULTS.age;
  const candlesRaw = parseInt(q.get('candles'), 10);
  const candles = Math.min(12, Math.max(1, Number.isFinite(candlesRaw) ? candlesRaw : DEFAULTS.candles));

  return {
    name,
    age,
    candles,
    from: clean(q.get('from'), 40) || DEFAULTS.from,
    message: clean(q.get('msg'), 400) || DEFAULTS.message,
    photos: DEFAULTS.photos,
  };
}
