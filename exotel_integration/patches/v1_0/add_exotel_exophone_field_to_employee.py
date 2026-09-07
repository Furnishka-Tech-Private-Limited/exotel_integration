import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields


def execute():
	create_custom_fields(
		{
			"Employee": [
				{
					"fieldname": "exotel_exophone",
					"label": "Exotel ExoPhone",
					"fieldtype": "Link",
					"options": "Exotel Exophone",
					"insert_after": "cell_number",
					"description": "ExoPhone number used as the caller ID when this employee makes outbound calls via Exotel",
				}
			]
		},
		ignore_validate=frappe.flags.in_patch,
		update=True,
	)
