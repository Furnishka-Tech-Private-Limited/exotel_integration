frappe.provide('frappe.phone_call');

class CallHandler {
	constructor(to_number, frm) {
		// to_number call be string or array
		// like '12345' or ['1234', '4567'] or '1234\n4567'
		if (Array.isArray(to_number)) {
			this.to_numbers = to_number;
		} else {
			this.to_numbers = to_number.split('\n');
		}
		if (frm) {
			this.document_to_link = {
				'link_doctype': frm.doctype,
				'link_name': frm.docname
			};
		}
		this.make();
	}
	make() {
		this.dialog = new frappe.ui.Dialog({
			'static': 1,
			'title': __('Make a Call'),
			'minimizable': true,
			'fields': [{
				'fieldname': 'to_number',
				'label': 'To Number',
				'fieldtype': 'Autocomplete',
				'default': this.to_numbers[0],
				'ignore_validation': true,
				'options': this.to_numbers,
				'read_only': 0,
				'reqd': 1
			}, {
				'label': 'Response',
				'fieldtype': 'Section Break',
				'collapsible': 1
			}, {
				'fieldname': 'response',
				'label': 'Response',
				'fieldtype': 'Code',
				'read_only': 1
			}],
			primary_action: () => {
				this.dialog.disable_primary_action();
				// A registered softphone (softphone/softphone.js) takes the agent's leg and shows the call's progress itself,
				// so the 1-second status polling (a web worker per second per call) is skipped for it.
				const phone = window.exotel_softphone;
				let use_softphone = false;
				// This tab becomes the softphone's tab (it was in another one): audio and the microphone prompt then
				// belong to the tab the agent is looking at. Never during a live call.
				if (phone && phone.is_ready()) this.dialog.set_title(__('Moving the softphone to this tab…'));
				(phone ? phone.ensure_leader() : Promise.resolve()).then(() => {
					use_softphone = !!(phone && phone.is_ready());
					return frappe.xcall('exotel_integration.handler.make_a_call', {
						'to_number': this.dialog.get_value('to_number'),
						'link_to_document': this.document_to_link,
						'use_softphone': use_softphone ? 1 : 0
					});
				}).then(res => {
					this.dialog.get_close_btn().hide();
					this.dialog.set_value('response', JSON.stringify(res, null, 2));
					this.call_id = res.Call.Sid;
					if (res.softphone_error) {
						// Exotel refused the softphone leg; the server rang the mobile instead
						frappe.show_alert({message: __('Softphone call refused by Exotel: {0}. Calling your mobile instead.', [res.softphone_error]), indicator: 'orange'}, 10);
					}
					// the server decides too (it knows the softphone is registered): a SIP first leg means "your softphone rings"
					if ((res.agent_leg_sent || '').startsWith('sip:')) {
						this.dialog.set_title(__('Your softphone is ringing: press Answer'));
						this.set_call_as_complete();
						this.watch_softphone_call();
					} else {
						this.setup_call_status_updater();
					}
				}).catch(e => {
					this.dialog.enable_primary_action();
					this.dialog.set_value('response', JSON.stringify(e, null, 2));
				});
			},
			primary_action_label: __('Call')
		});
		this.dialog.show();
		this.dialog.get_close_btn().show();
	}
	// With the softphone there is no status polling, so the dialog follows the softphone's own events instead:
	// ringing -> connected -> ended (closes itself), or "did not ring" if the call never reaches the browser.
	watch_softphone_call() {
		const NEVER_RANG_MS = 90 * 1000;
		let seen = false;
		const finish = (title) => {
			document.removeEventListener('exotel-softphone-state', on_state);
			clearTimeout(never_rang);
			this.dialog.set_title(title);
			this.set_call_as_complete();
			setTimeout(() => this.dialog && this.dialog.hide(), 3000);
		};
		const on_state = () => {
			const call = window.exotel_softphone && window.exotel_softphone.current();
			if (call) {
				seen = true;
				clearTimeout(never_rang);
				if (call.phase === 'live') this.dialog.set_title(__('Call connected'));
			} else if (seen) {
				finish(__('Call ended'));
			}
		};
		const never_rang = setTimeout(() => {
			if (!seen) finish(__('The softphone did not ring'));
		}, NEVER_RANG_MS);
		document.addEventListener('exotel-softphone-state', on_state);
	}

	setup_call_status_updater() {
		if (!this.updater) {
			this.updater = setInterval(this.set_call_status.bind(this), 1000);
		}
	}
	set_call_status() {
		frappe.xcall('exotel_integration.handler.get_call_status', {
			'call_id': this.call_id
		}).then(status => {
			this.set_header(status);
			if (['completed', 'failed', 'busy', 'no-answer'].includes(status)) {
				this.set_call_as_complete();
			}
		}).catch(e => {
			console.log(e);
			this.set_call_as_complete();
		});
	}

	set_call_as_complete() {
		this.dialog.get_close_btn().show();
		clearInterval(this.updater);
	}

	set_header(status) {
		this.dialog.set_title(frappe.model.unscrub(status));
		const indicator_class = this.get_status_indicator(status);
		this.dialog.header.find('.indicator').attr('class', `indicator ${indicator_class}`);
	}

	get_status_indicator(status) {
		const indicator_map = {
			'completed': 'blue',
			'failed': 'red',
			'busy': 'yellow',
			'no-answer': 'orange',
			'queued': 'orange',
			'ringing': 'green blink',
			'in-progress': 'green blink'
		};
		const indicator_class = `indicator ${indicator_map[status] || 'blue blink'}`;
		return indicator_class;
	}

}

frappe.xcall('exotel_integration.handler.is_integration_enabled').then(is_integration_enabled => {
	if (is_integration_enabled) {
		frappe.phone_call.handler = (to_number, frm) => new CallHandler(to_number, frm);
	}
});