"""Softphone module: the VoIP softphone inside ERPNext (JS in public/js/softphone/, SDK bundle next to it).

Server side it only does two things: hand the logged-in agent their own SIP settings, and tell make_a_call how to
name that agent's SIP user. Audio and SIP signalling never touch this server (browser <-> Exotel)."""

import frappe
from frappe.utils.password import get_decrypted_password


def agent_sip_id(sip_user, with_domain=False):
	"""The `From` value Exotel's connect API takes for a VoIP user: sip:<user>, the SIP User Name the Exotel dashboard
	shows. Exotel's API reference writes a SIP URI with a domain (sip:agent@exotel.com), which Exotel accepted but then
	failed to reach the softphone (Leg1Status failed after 1 s), so with_domain=True is only the second try."""
	sip_user = _bare_sip_user(sip_user)
	if not sip_user:
		return None
	domain = (frappe.get_cached_doc("Exotel Settings").voip_domain or "").strip() if with_domain else ""
	return f"sip:{sip_user}@{domain}" if domain else f"sip:{sip_user}"


def _bare_sip_user(value):
	"""'sip:amans28299f85' (as Exotel's screen shows it) and 'amans28299f85' both -> 'amans28299f85'."""
	value = (value or "").strip()
	return value[4:] if value.lower().startswith("sip:") else value


@frappe.whitelist()
def get_softphone_config():
	"""SIP settings for the LOGGED-IN user's own softphone, or {"enabled": 0}. Never anyone else's."""
	settings = frappe.get_cached_doc("Exotel Settings")
	if not (settings.enabled and settings.softphone_enabled and settings.voip_proxy and settings.voip_domain):
		return {"enabled": 0}

	employee = frappe.db.get_value(
		"Employee",
		{"user_id": frappe.session.user, "status": "Active"},
		["name", "employee_name", "custom_voip_sip_user"],
		as_dict=True,
	)
	if not (employee and employee.custom_voip_sip_user):
		return {"enabled": 0}

	password = get_decrypted_password(
		"Employee", employee.name, "custom_voip_sip_password", raise_exception=False
	)
	if not password:
		return {"enabled": 0}

	return {
		"enabled": 1,
		"user": _bare_sip_user(employee.custom_voip_sip_user),
		"password": password,
		"display_name": employee.employee_name or employee.custom_voip_sip_user,
		"proxy": settings.voip_proxy.strip().split(":")[0],  # host only: the port is added by the browser
		"domain": settings.voip_domain.strip(),
		"port": int(settings.voip_proxy.split(":")[1]) if ":" in settings.voip_proxy else 443,
	}
