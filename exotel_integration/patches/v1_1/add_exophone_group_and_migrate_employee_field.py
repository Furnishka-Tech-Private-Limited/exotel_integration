import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields


def execute():
	create_custom_fields(
		{
			"Employee": [
				{
					"fieldname": "exotel_exophone_group",
					"label": "Exotel ExoPhone Group",
					"fieldtype": "Link",
					"options": "Exotel Exophone Group",
					"insert_after": "cell_number",
					"description": "ExoPhone group whose enabled number is used as the caller ID "
					"when this employee makes outbound calls via Exotel",
				}
			]
		},
		ignore_validate=frappe.flags.in_patch,
		update=True,
	)

	migrate_direct_exophone_assignments()

	frappe.delete_doc("Custom Field", "Employee-exotel_exophone", ignore_missing=True)


def migrate_direct_exophone_assignments():
	employees = frappe.get_all(
		"Employee", filters={"exotel_exophone": ["is", "set"]}, fields=["name", "exotel_exophone"]
	)

	for employee in employees:
		phone_number = employee.exotel_exophone
		if not frappe.db.exists("Exotel Exophone", phone_number):
			continue

		exophone = frappe.get_doc("Exotel Exophone", phone_number)
		if not exophone.group:
			group_name = phone_number
			if not frappe.db.exists("Exotel Exophone Group", group_name):
				frappe.get_doc(
					{"doctype": "Exotel Exophone Group", "group_name": group_name}
				).insert(ignore_permissions=True)

			exophone.group = group_name
			exophone.enabled = 1
			exophone.save(ignore_permissions=True)

		frappe.db.set_value(
			"Employee", employee.name, "exotel_exophone_group", exophone.group
		)
