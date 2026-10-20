# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document

from exotel_integration.utils.exophone_groups import check_members_not_in_other_exophone_group


class ExotelExophone(Document):
	def validate(self):
		self.validate_single_enabled_per_group()
		self.validate_members_not_in_other_group()

	def validate_single_enabled_per_group(self):
		if not (self.enabled and self.employee_group):
			return

		other_enabled = frappe.db.exists(
			"Exotel Exophone",
			{"employee_group": self.employee_group, "enabled": 1, "name": ["!=", self.name]},
		)
		if other_enabled:
			frappe.throw(
				_(
					"{0} is already enabled for Employee Group {1}. Disable it first before enabling another number for this group."
				).format(frappe.bold(other_enabled), frappe.bold(self.employee_group))
			)

	def validate_members_not_in_other_group(self):
		if not (self.enabled and self.employee_group):
			return

		members = frappe.get_all(
			"Employee Group Table", filters={"parent": self.employee_group}, pluck="employee"
		)
		check_members_not_in_other_exophone_group(self.employee_group, members)
