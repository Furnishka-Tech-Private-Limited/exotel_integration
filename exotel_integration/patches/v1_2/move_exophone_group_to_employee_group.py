import frappe


def execute(dry_run=0):
	"""Each old Exotel Exophone Group becomes an Employee Group of the same name (members = the employees
	that carried it in Employee.exotel_exophone_group), and its numbers point at it through
	Exotel Exophone.employee_group. The old doctype and the Employee field are left in place.

	Idempotent: numbers that already have an employee_group are skipped."""
	if not frappe.db.has_column("Exotel Exophone", "group"):
		return

	rows = frappe.db.sql(
		"SELECT name, `group` AS old_group FROM `tabExotel Exophone` "
		"WHERE IFNULL(`group`, '') != '' AND IFNULL(employee_group, '') = ''",
		as_dict=True,
	)
	print(f"{len(rows)} ExoPhone number(s) to move")
	if dry_run:
		return

	has_employee_field = frappe.db.has_column("Employee", "exotel_exophone_group")
	for row in rows:
		group = row.old_group
		if not frappe.db.exists("Employee Group", group):
			frappe.get_doc({"doctype": "Employee Group", "employee_group_name": group}).insert(
				ignore_permissions=True
			)

		members = []
		if has_employee_field:
			members = frappe.get_all("Employee", filters={"exotel_exophone_group": group}, pluck="name")
		have = set(frappe.get_all("Employee Group Table", filters={"parent": group}, pluck="employee"))
		new_members = [m for m in members if m not in have]
		if new_members:
			doc = frappe.get_doc("Employee Group", group)
			for employee in new_members:
				doc.append("employee_list", {"employee": employee})
			doc.flags.ignore_validate = True  # the ExoPhone is not tagged yet, nothing to clash with
			doc.save(ignore_permissions=True)

		frappe.db.set_value("Exotel Exophone", row.name, "employee_group", group, update_modified=False)
		print(f"{row.name}: Employee Group {group} ({len(new_members)} member(s) added)")
