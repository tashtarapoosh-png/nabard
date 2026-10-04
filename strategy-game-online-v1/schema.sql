-- سرور در اولین اجرا جدول‌ها را خودش می‌سازد.
-- این فایل برای مشاهده ساختار دیتابیس است.

CREATE TABLE castles (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  army JSONB NOT NULL,
  defense_slots JSONB NOT NULL,
  under_attack BOOLEAN NOT NULL DEFAULT FALSE,
  battle_id INTEGER
);

CREATE TABLE attacks (
  id BIGSERIAL PRIMARY KEY,
  attacker_id INTEGER NOT NULL REFERENCES castles(id),
  target_id INTEGER NOT NULL REFERENCES castles(id),
  army_side TEXT NOT NULL,
  attacker_slots JSONB NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  arrives_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE battles (
  id BIGSERIAL PRIMARY KEY,
  target_id INTEGER NOT NULL UNIQUE REFERENCES castles(id),
  defender_slots JSONB NOT NULL,
  armies JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 minutes'),
  ended BOOLEAN NOT NULL DEFAULT FALSE,
  winner_side TEXT
);
