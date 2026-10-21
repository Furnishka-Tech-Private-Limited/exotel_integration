import json

import bleach
import frappe
import requests
from frappe import _
from frappe.integrations.utils import create_request_log

from exotel_integration.softphone.api import agent_sip_id
from exotel_integration.softphone.presence import online_sip_user
from exotel_integration.utils.exophone_groups import get_exophone_for_employee

# Endpoints for webhook
#
# Incoming Call:
# <site>/api/method/exotel_integration.handler.handle_request?key=<exotel-integration-key>

# Exotel Reference:
# https://developer.exotel.com/api/
# https://support.exotel.com/support/solutions/articles/48283-working-with-passthru-applet


@frappe.whitelist(allow_guest=True)
def handle_request(**kwargs):
	validate_request()
	if not is_integration_enabled():
		return

	request_log = create_request_log(
		kwargs,
		request_description="Exotel Call",
		service_name="Exotel",
		request_headers=frappe.request.headers,
		is_remote_request=1
	)
	try:
		request_log.status = "Completed"
		exotel_settings = get_exotel_settings()
		if not exotel_settings.enabled:
			return

		call_payload = kwargs
		status = call_payload.get("Status")
		if status == "free":
			return

		if call_log := get_call_log(call_payload):
			update_call_log(call_payload, call_log=call_log)
		else:
			create_call_log(
				call_id=call_payload.get("CallSid"),
				from_number=call_payload.get("CallFrom"),
				to_number=call_payload.get("DialWhomNumber"),
				medium=call_payload.get("To"),
				status=get_call_log_status(call_payload),
			)
	except Exception as e:
		request_log.status = "Failed"
		request_log.error = frappe.get_traceback()
		frappe.db.rollback()
		frappe.log_error(title="Error while creating call record")
		frappe.db.commit()
	finally:
		request_log.save(ignore_permissions=True)
		frappe.db.commit()


def update_call_log(call_payload, status="Ringing", call_log=None):
	call_log = call_log or get_call_log(call_payload)
	status = get_call_log_status(call_payload)
	try:
		if call_log:
			call_log.status = status
			# resetting this because call might be redirected to other number
			call_log.to = call_payload.get("DialWhomNumber")
			call_log.duration = call_payload.get("DialCallDuration") or call_payload.get('ConversationDuration') or 0
			call_log.recording_url = call_log.recording_url or call_payload.get("RecordingUrl")
			call_log.start_time = call_payload.get("StartTime")
			call_log.end_time = call_payload.get("EndTime")
			call_log.save(ignore_permissions=True)
			frappe.db.commit()
			return call_log
	except Exception as e:
		frappe.log_error(title="Error while updating call record")
		frappe.db.commit()


def get_call_log_status(call_payload):
	status = call_payload.get("DialCallStatus")
	call_type = call_payload.get("CallType")
	dial_call_status = call_payload.get("DialCallStatus")

	if dial_call_status == "no-answer":
		status = "No Answer"
	elif dial_call_status == "canceled":
		status = "Canceled"
	elif dial_call_status == "failed":
		status = "Failed"
	elif call_type == "completed":
		status = "Completed"
	elif dial_call_status == "busy":
		status = "Ringing"

	return status


def get_call_log(call_payload):
	call_log_id = call_payload.get("CallSid")
	if frappe.db.exists("Call Log", call_log_id):
		return frappe.get_doc("Call Log", call_log_id)


def create_call_log(
	call_id,
	from_number,
	to_number,
	medium,
	status="Ringing",
	call_type="Incoming",
	link_to_document=None,
):
	call_log = frappe.new_doc("Call Log")
	call_log.id = call_id
	call_log.to = to_number
	call_log.medium = medium
	call_log.type = call_type
	call_log.status = status
	setattr(call_log, "from", from_number)
	if link_to_document:
		call_log.append("links", link_to_document)
	call_log.save(ignore_permissions=True)
	frappe.db.commit()
	return call_log


@frappe.whitelist()
def get_call_status(call_id):
	endpoint = get_exotel_endpoint("Calls/{call_id}.json".format(call_id=call_id))
	response = requests.get(endpoint, timeout=5)  # a slow Exotel must not hold a web worker
	return response.json().get("Call", {}).get("Status")


@frappe.whitelist()
def make_a_call(to_number, caller_id=None, link_to_document=None, use_softphone=0):
	if not is_integration_enabled():
		frappe.throw(
			_("Please setup Exotel intergration"), title=_("Integration Not Enabled")
		)

	endpoint = get_exotel_endpoint("Calls/connect.json?details=true")
	employee = frappe.get_value(
		"Employee",
		{"user_id": frappe.session.user},
		["name", "cell_number", "custom_voip_sip_user"],
		as_dict=True,
	)

	# The agent's first leg is the SIP user only while a softphone is registered: the browser says so
	# (exotel_softphone.is_ready()) or the server's own presence flag (pinged every 45 s) is set. A closed or
	# unregistered tab therefore never swallows a call, and a stale or cached page cannot send it to the mobile.
	softphone_up = int(use_softphone or 0) or online_sip_user(frappe.session.user)
	agent_leg = agent_sip_id(employee.custom_voip_sip_user) if employee and softphone_up else None
	agent_leg = agent_leg or (employee and employee.cell_number)
	if not agent_leg:
		frappe.throw(_("You do not have mobile number set in your Employee master"))

	if not caller_id:
		# Newest Employee Group with an enabled ExoPhone wins. None enabled: CallerId stays empty (requests drops
		# None fields), so the call is placed as it was before ExoPhones were introduced instead of being stopped.
		exophones = get_exophone_for_employee(employee.name)
		caller_id = exophones[0].phone_number if exophones else None

	def place_call(first_leg):
		response = requests.post(
			endpoint,
			data={
				"From": first_leg,
				"To": to_number,
				"CallerId": caller_id,
				"Record": "true"
				if frappe.db.get_single_value("Exotel Settings", "record_call")
				else "false",
				"StatusCallback": get_status_updater_url(),
				"StatusCallbackEvents[0]": "terminal",
				"StatusCallbackEvents[1]": "answered",
			},
		)
		response.raise_for_status()
		return response

	softphone_error = None
	try:
		try:
			response = place_call(agent_leg)
		except requests.exceptions.HTTPError as e:
			# Exotel refused the SIP first leg: ring the mobile instead of losing the agent's call, and say why in the
			# Response box. The other spelling (with the VoIP domain) is tried before giving up on the softphone.
			mobile = employee and employee.cell_number
			if not str(agent_leg).startswith("sip:"):
				raise
			softphone_error = (e.response.json().get("RestException") or {}).get("Message") or str(e)
			short = agent_sip_id(employee.custom_voip_sip_user, with_domain=True)  # the other spelling
			try:
				if short == agent_leg:
					raise
				response = place_call(short)
				agent_leg, softphone_error = short, None
			except requests.exceptions.HTTPError:
				if not mobile:
					raise
				agent_leg = mobile
				response = place_call(agent_leg)
	except requests.exceptions.HTTPError as e:
		if exc := e.response.json().get("RestException"):
			frappe.throw(bleach.linkify(exc.get("Message")), title=_("Exotel Exception"))
	else:
		res = response.json()
		call_payload = res.get("Call", {})
		if link_to_document:
			link_to_document = json.loads(link_to_document)
		create_call_log(
			call_id=call_payload.get("Sid"),
			from_number=call_payload.get("From"),
			to_number=call_payload.get("To"),
			medium=call_payload.get("PhoneNumberSid"),
			call_type="Outgoing",
			link_to_document=link_to_document,
		)

	# shown in the Call dialog's Response box: what the agent's first leg was (a SIP id or a mobile) and why
	return {**response.json(), "agent_leg_sent": agent_leg, "use_softphone_flag": int(use_softphone or 0), "softphone_error": softphone_error}

def get_status_updater_url():
	from frappe.utils.data import get_url

	webhook_key = frappe.db.get_single_value("Exotel Settings", "webhook_key")
	return get_url(
		f"api/method/exotel_integration.handler.handle_request?key={webhook_key}"
	)


def get_exotel_settings():
	return frappe.get_single("Exotel Settings")


def whitelist_numbers(numbers, caller_id):
	endpoint = get_exotel_endpoint("CustomerWhitelist")
	return requests.post(
		endpoint,
		data={
			"VirtualNumber": caller_id,
			"Number": numbers,
		},
	)


@frappe.whitelist()
def get_all_exophones():
	endpoint = get_exotel_endpoint("IncomingPhoneNumbers.json")
	response = requests.get(endpoint, timeout=15)
	body = response.json()
	# Exotel answers a plural list for several numbers but a single "IncomingPhoneNumber" object for exactly one
	phones = body.get("IncomingPhoneNumbers") or body.get("IncomingPhoneNumber") or []
	if isinstance(phones, dict):
		phones = [phones]
	return [
		(phone.get("IncomingPhoneNumber") or phone).get("PhoneNumber")
		for phone in phones
	]


@frappe.whitelist()
def sync_exophones_from_exotel():
	added = []
	for phone_number in get_all_exophones():
		if phone_number and not frappe.db.exists("Exotel Exophone", phone_number):
			frappe.get_doc(
				{"doctype": "Exotel Exophone", "phone_number": phone_number}
			).insert(ignore_permissions=True)
			added.append(phone_number)
	frappe.db.commit()
	return added


def get_exotel_endpoint(action):
	settings = get_exotel_settings()
	return (
		"https://{api_key}:{api_token}@{host}/v1/Accounts/{sid}/{action}".format(
			host=settings.api_host or "api.exotel.com",
			api_key=settings.api_key,
			api_token=settings.get_password("api_token"),
			sid=settings.account_sid,
			action=action,
		)
	)


def validate_request():
	# workaround security since exotel does not support request signature
	# /api/method/<exotel-integration-method>?key=<exotel-integration-key>
	webhook_key = frappe.db.get_single_value("Exotel Settings", "webhook_key")
	key = frappe.request.args.get('key')
	is_valid = key and key == webhook_key

	if not is_valid:
		frappe.throw(_("Unauthorized request"), exc=frappe.PermissionError)


@frappe.whitelist()
def is_integration_enabled():
	return frappe.db.get_single_value("Exotel Settings", "enabled", True)
