-- Add payment tracking columns to monitoring_sessions
ALTER TABLE monitoring_sessions ADD COLUMN stripe_session_id TEXT;
ALTER TABLE monitoring_sessions ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE monitoring_sessions ADD COLUMN payment_status TEXT DEFAULT 'pending';
ALTER TABLE monitoring_sessions ADD COLUMN payment_type TEXT;
