import frappe
from frappe import _


def get_exophone_for_employee(employee):
	"""The enabled ExoPhone whose Employee Group contains `employee` (one query).

	Returns (phone_number, employee_group) rows; the callers' rules keep this to at most one."""
	return frappe.db.sql(
		"""
		SELECT ex.phone_number, ex.employee_group
		FROM `tabEmployee Group Table` egt
		JOIN `tabExotel Exophone` ex ON ex.employee_group = egt.parent AND ex.enabled = 1
		WHERE egt.employee = %s
		""",
		employee,
		as_dict=True,
	)


def check_members_not_in_other_exophone_group(group, employees):
	"""An employee may sit in many Employee Groups, but only one of them may have an enabled ExoPhone,
	otherwise the caller ID of that employee would be ambiguous."""
	employees = [e for e in set(employees) if e]
	if not employees:
		return

	clash = frappe.db.sql(
		"""
		SELECT egt.employee, egt.parent AS employee_group, ex.phone_number
		FROM `tabEmployee Group Table` egt
		JOIN `tabExotel Exophone` ex ON ex.employee_group = egt.parent AND ex.enabled = 1
		WHERE egt.employee IN %(employees)s AND egt.parent != %(group)s
		LIMIT 1
		""",
		{"employees": employees, "group": group},
		as_dict=True,
	)
	if clash:
		row = clash[0]
		frappe.throw(
			_("Employee {0} is also in Employee Group {1}, which already has the enabled ExoPhone {2}. "
			  "An employee can belong to only one Employee Group that has an enabled ExoPhone.").format(
				frappe.bold(row.employee), frappe.bold(row.employee_group), frappe.bold(row.phone_number)
			),
			title=_("Ambiguous ExoPhone"),
		)


def validate_employee_group(doc, method=None):
	"""Employee Group validate: members added here must not clash with another group that has an enabled ExoPhone."""
	if not frappe.db.exists("Exotel Exophone", {"employee_group": doc.name, "enabled": 1}):
		return
	check_members_not_in_other_exophone_group(doc.name, [row.employee for row in doc.employee_list])
