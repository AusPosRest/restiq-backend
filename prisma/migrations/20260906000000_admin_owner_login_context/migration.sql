-- Owner password login (issue #118): the login lookup finds an OwnerUser by
-- email alone, before any tenant_id is known (same shape as the accept-invite
-- token lookup on owner_invites) - it must run as a SELECT across all
-- tenants. The existing "operator_read" policy is scoped to the ops console
-- (app.operator_context), so this adds a narrow, distinct read policy for
-- the login path, mirroring "invite_accept_read" on owner_invites.
CREATE POLICY "owner_login_read" ON "owner_users" FOR SELECT
  USING (current_setting('app.owner_login_context', true) = 'login');
