-- Battle Zone Mymensingh — D1 database schema
CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  date TEXT NOT NULL,
  start INTEGER NOT NULL,
  dur INTEGER NOT NULL,
  type TEXT NOT NULL,
  station TEXT NOT NULL,
  players INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  price INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'online',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bookings_date ON bookings(date);
CREATE INDEX IF NOT EXISTS bookings_phone ON bookings(phone);

-- One row per 30-minute block a seat is taken. The primary key makes double booking impossible.
CREATE TABLE IF NOT EXISTS slots (
  date TEXT NOT NULL,
  station TEXT NOT NULL,
  block INTEGER NOT NULL,
  booking_id TEXT NOT NULL,
  PRIMARY KEY (date, station, block)
);
CREATE INDEX IF NOT EXISTS slots_booking ON slots(booking_id);

CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS hits (key TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS hits_key ON hits(key, ts);
