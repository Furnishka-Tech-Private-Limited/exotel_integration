# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document


class ExotelExophone(Document):
	def validate(self):
		self.validate_single_enabled_per_group()

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
