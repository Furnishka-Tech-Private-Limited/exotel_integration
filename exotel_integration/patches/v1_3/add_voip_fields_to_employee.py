import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields


def execute():
	create_custom_fields(
		{
			"Employee": [
				{
					"fieldname": "custom_voip_sip_user",
					"label": "VoIP SIP Username",
					"fieldtype": "Data",
					"insert_after": "exotel_exophone_group",
					"search_index": 1,
					"description": "Exotel VOIP username (my.exotel.com > VOIP). With this the agent gets the softphone in ERPNext.",
				},
				{
					"fieldname": "custom_voip_sip_password",
					"label": "VoIP SIP Password",
					"fieldtype": "Password",
					"insert_after": "custom_voip_sip_user",
					"description": "The VOIP password the agent set on Exotel. Stored encrypted; only the agent's own browser receives it.",
				},
			]
		},
		ignore_validate=frappe.flags.in_patch,
		update=True,
	)
