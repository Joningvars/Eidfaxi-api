import { queryDb } from './client.js';

const migrations = [
  {
    name: '001_create_roster_tables',
    sql: `
      CREATE TABLE IF NOT EXISTS contestants (
        id BIGSERIAL PRIMARY KEY,
        kennitala TEXT,
        display_name TEXT NOT NULL,
        image_url TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS contestants_kennitala_unique
        ON contestants (kennitala)
        WHERE kennitala IS NOT NULL;

      CREATE INDEX IF NOT EXISTS contestants_display_name_lower_idx
        ON contestants (LOWER(display_name));
    `,
  },
  {
    name: '002_simplify_contestants_schema',
    sql: `
      DROP INDEX IF EXISTS contestants_person_id_unique;

      ALTER TABLE contestants
        DROP COLUMN IF EXISTS sportfengur_person_id,
        DROP COLUMN IF EXISTS team_id,
        DROP COLUMN IF EXISTS image_cutout_url,
        DROP COLUMN IF EXISTS is_active;

      DROP TABLE IF EXISTS contestant_aliases;
      DROP TABLE IF EXISTS teams;
    `,
  },
  {
    name: '003_add_teams_and_contestant_team_link',
    sql: `
      CREATE TABLE IF NOT EXISTS teams (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE contestants
        ADD COLUMN IF NOT EXISTS team_id BIGINT REFERENCES teams(id) ON DELETE SET NULL;

      CREATE INDEX IF NOT EXISTS contestants_team_id_idx
        ON contestants (team_id);
    `,
  },
  {
    name: '004_add_event_scoped_team_memberships',
    sql: `
      CREATE TABLE IF NOT EXISTS event_teams (
        id BIGSERIAL PRIMARY KEY,
        event_id BIGINT NOT NULL,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(event_id, slug)
      );

      CREATE INDEX IF NOT EXISTS event_teams_event_id_idx
        ON event_teams (event_id);

      CREATE TABLE IF NOT EXISTS contestant_team_memberships (
        id BIGSERIAL PRIMARY KEY,
        contestant_id BIGINT NOT NULL REFERENCES contestants(id) ON DELETE CASCADE,
        event_id BIGINT NOT NULL,
        event_team_id BIGINT NOT NULL REFERENCES event_teams(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(contestant_id, event_id)
      );

      CREATE INDEX IF NOT EXISTS contestant_team_memberships_event_id_idx
        ON contestant_team_memberships (event_id);
    `,
  },
  {
    name: '005_add_league_scoped_team_memberships',
    sql: `
      CREATE TABLE IF NOT EXISTS league_events (
        event_id BIGINT PRIMARY KEY,
        league_key TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS league_events_league_key_idx
        ON league_events (league_key);

      CREATE TABLE IF NOT EXISTS league_teams (
        id BIGSERIAL PRIMARY KEY,
        league_key TEXT NOT NULL,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(league_key, slug)
      );

      CREATE INDEX IF NOT EXISTS league_teams_league_key_idx
        ON league_teams (league_key);

      CREATE TABLE IF NOT EXISTS contestant_league_memberships (
        id BIGSERIAL PRIMARY KEY,
        contestant_id BIGINT NOT NULL REFERENCES contestants(id) ON DELETE CASCADE,
        league_key TEXT NOT NULL,
        league_team_id BIGINT NOT NULL REFERENCES league_teams(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(contestant_id, league_key)
      );

      CREATE INDEX IF NOT EXISTS contestant_league_memberships_league_key_idx
        ON contestant_league_memberships (league_key);

      INSERT INTO league_events (event_id, league_key)
      SELECT DISTINCT et.event_id, 'event-' || et.event_id::text
      FROM event_teams et
      ON CONFLICT (event_id) DO NOTHING;

      INSERT INTO league_teams (league_key, name, slug)
      SELECT DISTINCT
        'event-' || et.event_id::text AS league_key,
        et.name,
        et.slug
      FROM event_teams et
      ON CONFLICT (league_key, slug)
      DO UPDATE SET
        name = EXCLUDED.name,
        updated_at = NOW();

      INSERT INTO contestant_league_memberships (
        contestant_id,
        league_key,
        league_team_id
      )
      SELECT
        ctm.contestant_id,
        'event-' || ctm.event_id::text AS league_key,
        lt.id AS league_team_id
      FROM contestant_team_memberships ctm
      JOIN event_teams et
        ON et.id = ctm.event_team_id
      JOIN league_teams lt
        ON lt.league_key = 'event-' || ctm.event_id::text
       AND lt.slug = et.slug
      ON CONFLICT (contestant_id, league_key)
      DO UPDATE SET
        league_team_id = EXCLUDED.league_team_id,
        updated_at = NOW();
    `,
  },
  {
    name: '006_add_vmix_event_slots',
    sql: `
      CREATE TABLE IF NOT EXISTS vmix_event_slots (
        event_id BIGINT PRIMARY KEY,
        slot_order INTEGER NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL DEFAULT '',
        allowed_class_id BIGINT,
        class_ids JSONB NOT NULL DEFAULT '{}'::jsonb,
        added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS vmix_event_slots_order_idx
        ON vmix_event_slots (slot_order);
    `,
  },
  {
    name: '007_add_slot_login_credentials',
    sql: `
      ALTER TABLE vmix_event_slots
        ADD COLUMN IF NOT EXISTS login_username TEXT,
        ADD COLUMN IF NOT EXISTS login_password TEXT;

      CREATE UNIQUE INDEX IF NOT EXISTS vmix_event_slots_login_username_unique
        ON vmix_event_slots (login_username)
        WHERE login_username IS NOT NULL;
    `,
  },
  {
    name: '008_add_slot_source_event_id',
    sql: `
      ALTER TABLE vmix_event_slots
        ADD COLUMN IF NOT EXISTS source_event_id BIGINT;

      -- Backfill: existing slots source from their own event_id
      UPDATE vmix_event_slots
        SET source_event_id = event_id
        WHERE source_event_id IS NULL;
    `,
  },
  {
    name: '009_add_slot_class_types',
    sql: `
      ALTER TABLE vmix_event_slots
        ADD COLUMN IF NOT EXISTS class_types JSONB NOT NULL DEFAULT '{}'::jsonb;
    `,
  },
];

export async function runMigrations() {
  await queryDb(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  for (const migration of migrations) {
    const exists = await queryDb(
      'SELECT 1 FROM schema_migrations WHERE name = $1',
      [migration.name],
    );

    if (exists.rowCount > 0) {
      continue;
    }

    await queryDb('BEGIN');
    try {
      await queryDb(migration.sql);
      await queryDb(
        'INSERT INTO schema_migrations (name, applied_at) VALUES ($1, NOW())',
        [migration.name],
      );
      await queryDb('COMMIT');
    } catch (error) {
      await queryDb('ROLLBACK');
      throw error;
    }
  }
}
