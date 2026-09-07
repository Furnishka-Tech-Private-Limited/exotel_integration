frappe.listview_settings["Exotel Exophone"] = {
	onload(listview) {
		listview.page.add_inner_button(__("Fetch from Exotel"), () => {
			frappe.xcall("exotel_integration.handler.sync_exophones_from_exotel").then((added) => {
				frappe.show_alert({
					message: __("Fetched {0} new ExoPhone number(s) from Exotel", [added.length]),
					indicator: "green",
				});
				listview.refresh();
			});
		});
	},
};
