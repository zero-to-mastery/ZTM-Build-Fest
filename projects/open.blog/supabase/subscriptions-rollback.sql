-- Roll back update subscriptions' storage (ADR 0225). Run in the Supabase SQL
-- editor.
--
-- First remove OPENBLOG_SUBSCRIPTIONS_ENABLED from the Netlify environment
-- and redeploy, so the function stops taking subscriptions; pages then offer
-- links only, which is what they do without a service anyway. Nothing is
-- worth exporting: a subscriber's address exists for one purpose, and the
-- right end for it is to be erased. Readers who were subscribed simply stop
-- receiving updates.
--
-- This drops only what subscriptions.sql added: its functions and its one
-- table, with every address in it. Feedback, comments, moderation and every
-- other table are untouched, and nothing becomes public.

begin;

drop function if exists public.openblog_purge_subscriptions();
drop function if exists public.openblog_mark_subscription_sent(uuid, text, integer);
drop function if exists public.openblog_subscription_recipients(text);
drop function if exists public.openblog_queue_subscription_update(text, text, text, text, text);
drop function if exists public.openblog_cancel_subscription_request(text);
drop function if exists public.openblog_unsubscribe(text);
drop function if exists public.openblog_confirm_subscription(text);
drop function if exists public.openblog_subscribe(text, text, text, text);
drop function if exists public.openblog_subscription_digest(text);
drop table if exists public.openblog_subscriptions;

commit;
