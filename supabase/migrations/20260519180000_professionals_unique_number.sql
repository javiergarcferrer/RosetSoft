-- Professionals: same race guard as quotes / orders / containers got
-- in migration 20260519160000. Without this, two browsers creating a
-- professional in the same second can land on the same `number`,
-- defeating the dealer's internal numbering convention.
--
-- The application's assignSequenceNumber() helper retries on the
-- resulting 23505 (unique_violation), so the constraint here is what
-- gives the retry something to react to.

ALTER TABLE public.professionals
  ADD CONSTRAINT professionals_profile_number_unique
  UNIQUE (profile_id, number);

NOTIFY pgrst, 'reload schema';
