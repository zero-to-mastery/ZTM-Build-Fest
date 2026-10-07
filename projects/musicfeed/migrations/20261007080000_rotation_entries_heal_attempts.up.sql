-- The healer's memory of failure: how many times a background pass has tried
-- and failed to fill this entry's missing metadata. Entries at/over the cap
-- drop out of the candidate query, so permanently-unfindable albums (e.g.
-- releases with no artwork anywhere) are left alone instead of retried forever.
ALTER TABLE rotation_entries ADD COLUMN heal_attempts INTEGER NOT NULL DEFAULT 0;
