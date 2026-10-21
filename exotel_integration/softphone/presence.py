"""Who has a registered softphone right now, and which Employee a SIP leg belongs to.

Presence lives only in Redis (key per user, short TTL): the agent's leader tab pings every PING_EVERY_SEC while its
softphone is registered, and the key expires by itself if the tab is closed or the laptop sleeps. No DB write, so 30
agents cost about 40 tiny requests a minute. The routing endpoint (a live caller is waiting) answers with one Redis get."""

import frappe

PING_EVERY_SEC = 45
TTL_SEC = 90  # two missed pings; after that the agent is treated as offline and the call rings the mobile instead
_KEY = "exotel_softphone_online:{}"


def online_sip_user(user):
	"""The SIP user to dial for `user` if their softphone pinged within TTL_SEC, else None. One Redis get."""
	return frappe.cache().get_value(_KEY.format(user)) or None


def sip_user_of(raw):
	"""'sip:amans28299f85@host' / 'sip:amans28299f85' / 'amans28299f85' -> 'amans28299f85'; a phone number -> None."""
	raw = (raw or "").strip()
	if raw.lower().startswith("sip:"):
		return raw[4:].split("@")[0].split(";")[0] or None
	if "@" in raw:
		return raw.split("@")[0] or None
	return None


def employee_for_sip(raw):
	"""{name, user_id, employee_name} of the Active Employee whose VoIP SIP user is in `raw` (a SIP id), or None."""
	sip_user = sip_user_of(raw)
	if not sip_user:
		return None
	return frappe.db.get_value(
		"Employee",
		{"custom_voip_sip_user": sip_user, "status": "Active"},
		["name", "user_id", "employee_name"],
		as_dict=True,
	)


@frappe.whitelist()
def ping():
	"""The logged-in agent's softphone is registered: remember it for TTL_SEC. The SIP user comes from their own Employee
	record on the server, never from the browser."""
	user = frappe.session.user
	sip_user = frappe.db.get_value(
		"Employee", {"user_id": user, "status": "Active"}, "custom_voip_sip_user"
	)
	if sip_user:
		frappe.cache().set_value(_KEY.format(user), sip_user, expires_in_sec=TTL_SEC)
	return {"every": PING_EVERY_SEC}


@frappe.whitelist()
def offline():
	"""The softphone un-registered (tab closed, logout, mic blocked): stop routing calls to it at once."""
	frappe.cache().delete_value(_KEY.format(frappe.session.user))
