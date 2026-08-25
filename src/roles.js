/**
 * Who may do what in the admin area.
 *
 * Two roles, and they belong to admin accounts — the Google logins that reach
 * /admin. They have nothing to do with team keys. A key holder is not an account
 * here, has no role, and never signs in anywhere; keys are a thing this console
 * manages, in the way it might manage any other record.
 *
 *   owner    manages admin accounts, and everything a manager can do
 *   manager  manages users and their keys
 *
 * Owners may act on other owners, and on themselves, so a team can hand over and
 * step down without anybody touching a terminal. The one thing that cannot
 * happen is the last active owner losing their own access — there would be
 * nobody left able to give it back. `wouldStrandService` is that check, and it
 * counts rather than compares: an owner removing the last other owner and an
 * owner removing themselves are the same mistake seen from two sides.
 *
 * Managers cannot reach admin accounts at all — not to add one, not to remove
 * one, and not to look at an owner and demote them.
 */

export const ROLES = ['manager', 'owner'];

export const isValidRole = (role) => ROLES.includes(role);

export const roleOf = (account) => (account && isValidRole(account.role) ? account.role : null);

export const isOwner = (account) => roleOf(account) === 'owner';

/** Managing admin accounts at all — adding, removing, or changing a role. */
export const canManageAdmins = (actor) => isOwner(actor);

/**
 * Acting on one admin account.
 *
 * Only owners get here, and an owner may act on anyone including themselves, so
 * this is `canManageAdmins` by another name. It exists as its own function
 * because that is only true while there are two roles — a third would land here
 * first, and a call site that already asks the right question is one that does
 * not have to be found again later.
 */
export const canActOnAdmin = (actor, _target) => canManageAdmins(actor);

/** Handing out a role. Owners hand out either; managers never get this far. */
export const canGrant = (actor, role) => isValidRole(role) && isOwner(actor);

export const grantableBy = (actor) => ROLES.filter((role) => canGrant(actor, role));

/** Both roles manage users and their keys. That is the whole point of a manager. */
export const canManageKeys = (actor) => roleOf(actor) !== null;

/**
 * Would this change leave nobody able to administer the service?
 *
 * "Owner" here means an active one: a suspended owner cannot sign in, so
 * counting them would allow the last usable account to be removed on the
 * strength of an account that is already switched off.
 *
 * @param {Array}  accounts every admin account, each { email, role, active }
 * @param {string} email    who is being changed
 * @param {object} after    what they become — { role, active, removed }
 * @returns {boolean}
 */
export function wouldStrandService(accounts, email, after = {}) {
	const target = String(email).toLowerCase();

	const owners = accounts.filter((account) => {
		const isTarget = String(account.email).toLowerCase() === target;

		if (isTarget && after.removed) {
			return false;
		}

		const role = isTarget ? (after.role ?? roleOf(account)) : roleOf(account);
		const active = isTarget ? (after.active ?? account.active !== false) : account.active !== false;

		return role === 'owner' && active;
	});

	return owners.length === 0;
}

export const aOrAn = (role) => (role === 'owner' ? 'an owner' : `a ${role}`);
