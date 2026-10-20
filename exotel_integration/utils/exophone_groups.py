import frappe


def get_exophone_for_employee(employee):
	"""The enabled ExoPhone of the caller's Employee Group, one query.

	An employee may sit in several Employee Groups; when more than one of them has an enabled ExoPhone,
	the group saved most recently (Employee Group.modified) wins, then the lower phone number, so the answer
	is always the same. Returns at most one (phone_number, employee_group) row."""
	return frappe.db.sql(
		"""
		SELECT ex.phone_number, ex.employee_group
		FROM `tabEmployee Group Table` egt
		JOIN `tabExotel Exophone` ex ON ex.employee_group = egt.parent AND ex.enabled = 1
		JOIN `tabEmployee Group` eg ON eg.name = egt.parent
		WHERE egt.employee = %s
		ORDER BY eg.modified DESC, ex.phone_number
		LIMIT 1
		""",
		employee,
		as_dict=True,
	)
