-- Two databases, because a ClickHouse target is backed up whole: a dump that
-- only ever saw one of them would pass this fixture and lose data in the field.
CREATE DATABASE IF NOT EXISTS analytics;
CREATE DATABASE IF NOT EXISTS metrics;

-- `order` is a reserved word and `label` is nullable: both have to survive the
-- SQLInsert round trip, which is what the backtick quoting is there for.
CREATE TABLE analytics.events
(
  `id`        UInt64,
  `order`     UInt32,
  `label`     Nullable(String),
  `payload`   String,
  `seen_at`   DateTime
)
ENGINE = MergeTree
ORDER BY id;

INSERT INTO analytics.events
SELECT
  number,
  toUInt32(number % 7),
  if(number % 5 = 0, NULL, concat('label-', toString(number))),
  concat('payload with a quote '' and a tab\t #', toString(number)),
  toDateTime('2026-01-01 00:00:00') + number
FROM numbers(5000);

-- A view holds no data of its own: it must come back as DDL only, and be created
-- after the table it reads.
CREATE VIEW analytics.recent_events AS
SELECT id, `order`, label FROM analytics.events WHERE id > 4900;

CREATE TABLE metrics.samples
(
  `name`  String,
  `value` Float64,
  `at`    DateTime
)
ENGINE = MergeTree
ORDER BY (name, at);

INSERT INTO metrics.samples
SELECT concat('metric-', toString(number % 10)), number / 3.0, toDateTime('2026-01-01 00:00:00') + number
FROM numbers(1000);
