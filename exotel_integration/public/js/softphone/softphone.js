/*
 * Exotel softphone inside ERPNext (WebRTC, Exotel Voice WebSDK).
 *
 * Only agents who have a VoIP SIP username in their Employee record get it; for everyone else
 * get_softphone_config answers {enabled: 0} and nothing else loads (the 1 MB SDK is fetched only for them).
 *
 * One ERPNext tab owns the phone. navigator.locks hands the lock to exactly one tab; that "leader" tab loads the
 * SDK, registers the SIP user and runs the calls. Every other tab only shows the same widget (state arrives over
 * a BroadcastChannel) and sends button presses to the leader. When the leader tab closes, the lock passes to
 * another tab, which registers in its place.
 *
 * Calls: an outbound click-to-call makes Exotel ring this softphone first (handler.make_a_call with
 * use_softphone=1), the agent presses Answer, and Exotel then dials the customer.
 */
(function () {
	if (window.exotel_softphone) return;

	const SDK_URL = "/assets/exotel_integration/js/softphone/exotelsdk/exotelsdk.js";
	const LOCK_NAME = "exotel-softphone-leader";
	const CHANNEL_NAME = "exotel-softphone";
	const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

	// Everything the widget draws is in `state`, so it can be copied to the other tabs as it is.
	const state = { enabled: false, ready: false, status: "", call: null };
	let is_leader = false;
	let client = null;
	let channel = null;
	let timer = null;
	let $root = null;
	// Microphone permission of this site (same in every tab). A tab in the background cannot show Chrome's permission
	// prompt, so Answer would hang there: the agent grants it once, from a visible tab, with the "Allow microphone" button.
	let mic = "unknown";
	let pagehide_bound = false;
	let taking_over = false; // this tab asked for the phone and must wait until the previous phone tab has un-registered

	window.exotel_softphone = {
		// true when this agent's softphone is registered in some tab: make_a_call then rings it instead of the mobile
		is_ready: () => !!(state.enabled && state.ready),
		// the call being rung/talked on if its Exotel CallSid is `sid`, so the lead popup can offer Answer / Reject itself
		ensure_leader: () => ensure_leader(),
		// the call in progress (or null): {phase: "ring" | "live", who, sid, ...}
		current: () => state.call,
		call_for: (sid) => (state.call && sid && state.call.sid === sid ? state.call : null),
		command: (cmd, arg) => command(cmd, arg),
		// Console helper for "I cannot hear the caller": every <audio> element on the page (the SDK makes its own) and
		// what the browser is doing with it. Run  exotel_softphone.audio_report()  in the tab that holds the call.
		audio_report: () => {
			const rows = [...document.querySelectorAll("audio")].map((a, i) => {
				const tracks = a.srcObject ? a.srcObject.getAudioTracks().map((t) => `${t.readyState}${t.muted ? "/muted" : ""}${t.enabled ? "" : "/disabled"}`) : [];
				return { i, paused: a.paused, muted: a.muted, volume: a.volume, sink: a.sinkId || "default", has_stream: !!a.srcObject, tracks: tracks.join(","), ready: a.readyState };
			});
			console.table(rows);
			let call_volume = null;
			try { call_volume = client && client.getCallAudioOutputVolume(); } catch (e) { /* tab without the phone */ }
			console.info("[softphone] is_leader:", is_leader, "call volume:", call_volume, "mic permission:", mic, "visible:", !document.hidden);
			return rows;
		},
	};

	const esc = (v) => frappe.utils.escape_html(v == null ? "" : String(v));

	// ---------------------------------------------------------------- state sharing
	function publish() {
		render();
		document.dispatchEvent(new CustomEvent("exotel-softphone-state"));
		if (is_leader && channel) {
			try {
				channel.postMessage({ type: "state", state });
			} catch (e) { /* closed channel: this tab still renders itself */ }
		}
	}

	function set_state(patch) {
		Object.assign(state, patch);
		publish();
	}

	function command(cmd, arg) {
		console.info("[softphone] button", cmd, is_leader ? "(this tab is the phone)" : "(sent to the phone tab)");
		if (is_leader) return run_command(cmd, arg);
		if (channel) channel.postMessage({ type: "cmd", cmd, arg });
	}

	// ---------------------------------------------------------------- the phone (leader tab only)
	function run_command(cmd, arg) {
		try {
			const call = client && client.getCall();
			if (!call) {
				console.warn("[softphone] no active call object for", cmd, "client:", !!client);
				return;
			}
			if (cmd === "answer") {
				// Answer asks the browser for the microphone; surface a refusal instead of leaving a dead card
				Promise.resolve(call.Answer()).catch((e) => {
					console.error("[softphone] Answer failed", e);
					set_state({ status: __("Could not answer: {0}", [(e && e.message) || e]) });
				});
			}
			else if (cmd === "hangup") call.Hangup();
			else if (cmd === "mute") {
				call.MuteToggle();
				set_state({ call: Object.assign({}, state.call, { muted: !state.call.muted }) });
			} else if (cmd === "hold") {
				call.HoldToggle();
				set_state({ call: Object.assign({}, state.call, { held: !state.call.held }) });
			} else if (cmd === "dtmf") call.sendDTMF(arg);
		} catch (e) {
			console.error("softphone command failed", cmd, e);
		}
	}

	function load_sdk() {
		if (window.exotelSDK) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const s = document.createElement("script");
			s.src = SDK_URL;
			s.onload = resolve;
			s.onerror = () => reject(new Error("could not load " + SDK_URL));
			document.head.appendChild(s);
		});
	}

	// ---- presence: tell the server this softphone can take a call (the Exotel flow then dials sip:<user>, not the mobile)
	const PING_MS = 45 * 1000; // server keeps the flag for 90 s, so one missed ping is forgiven
	let ping_timer = null;

	function ping() {
		frappe.xcall("exotel_integration.softphone.presence.ping").catch(() => {});
	}

	function presence_on() {
		if (ping_timer) return;
		ping();
		ping_timer = setInterval(ping, PING_MS);
	}

	function presence_off(beacon) {
		if (ping_timer) clearInterval(ping_timer);
		ping_timer = null;
		if (beacon) {
			// the page is closing: a normal request may be cancelled, keepalive lets this one finish
			try {
				fetch("/api/method/exotel_integration.softphone.presence.offline", {
					method: "POST", keepalive: true, credentials: "same-origin",
					headers: { "X-Frappe-CSRF-Token": frappe.csrf_token },
				});
			} catch (e) { /* nothing more to do: the flag expires in 90 s */ }
		} else {
			frappe.xcall("exotel_integration.softphone.presence.offline").catch(() => {});
		}
	}

	function on_register(reg_state) {
		if (reg_state === "registered") presence_on();
		else presence_off(false);
		if (reg_state === "registered") set_state({ ready: true, status: __("Softphone ready") });
		else if (reg_state === "sent_request") set_state({ ready: false, status: __("Connecting…") });
		else if (reg_state === "unregistered") set_state({ ready: false, status: __("Softphone offline") });
		else if (reg_state === "terminated")
			set_state({ ready: false, status: __("Softphone could not register. Check the SIP user and password in your Employee record.") });
	}

	function on_call(call_obj, event_type) {
		console.info("[softphone] call event", event_type, call_obj && { sid: call_obj.callSid, from: call_obj.remoteDisplayName });
		if (event_type === "incoming") {
			set_state({
				call: { phase: "ring", who: (call_obj && call_obj.remoteDisplayName) || __("Unknown caller"),
					sid: call_obj && call_obj.callSid, muted: false, held: false },
			});
		} else if (event_type === "connected") {
			set_state({ call: Object.assign({}, state.call, { phase: "live", since: Date.now() }) });
		} else if (event_type === "callEnded" || event_type === "terminated") {
			set_state({ call: null });
		}
	}

	function on_session(call_state, phone, error) {
		console.info("[softphone] session event", call_state, error || "");
		if (call_state === "media_permission_denied" || call_state === "websocket_disconnected") presence_off(false);
		if (call_state === "media_permission_denied")
			set_state({ ready: false, status: __("Microphone is blocked. Allow it for this site in the browser.") });
		else if (call_state === "websocket_disconnected")
			set_state({ ready: false, status: __("Reconnecting…") });
	}

	function start_phone(cfg) {
		return load_sdk().then(() => {
			client = new exotelSDK.ExotelWebClient();
			client.initWebrtc(
				{
					userName: cfg.user, authUser: cfg.user, sipdomain: cfg.domain,
					domain: cfg.proxy + ":" + cfg.port, displayname: cfg.display_name, displayName: cfg.display_name,
					secret: cfg.password, port: String(cfg.port), security: "wss",
				},
				on_register, on_call, on_session,
				true // follow the system's default audio device when a headset is plugged in or out
			);
			client.DoRegister();
			if (!pagehide_bound) {
				pagehide_bound = true;
				// tell Exotel this phone is gone, so it is not offered calls it cannot take
				window.addEventListener("pagehide", () => {
					if (!is_leader) return;
					presence_off(true);
					try { client.UnRegister(); } catch (e) { /* page is closing */ }
				});
			}
		});
	}

	function become_leader() {
		is_leader = true;
		set_state({ enabled: false, status: "" });
		// After a take-over, wait until the previous phone tab has un-registered (it says so on the channel), or two
		// registrations of one SIP user would overlap and the old tab's un-register could remove the new one.
		const old_phone_gone = taking_over
			? new Promise((resolve) => { released_resolve = resolve; setTimeout(resolve, 3000); })
			: Promise.resolve();
		old_phone_gone
			.then(() => { taking_over = false; return frappe.xcall("exotel_integration.softphone.api.get_softphone_config"); })
			.then((cfg) => {
				if (!cfg || !cfg.enabled) return; // no softphone for this user: stay invisible
				set_state({ enabled: true, ready: false, status: __("Connecting…") });
				return start_phone(cfg);
			})
			.catch((e) => {
				console.error("softphone start failed", e);
				if (state.enabled) set_state({ ready: false, status: __("Softphone could not start.") });
			});
		return new Promise(() => {}); // hold the lock until this tab closes (or another tab takes it over)
	}

	let released_resolve = null;

	// Another tab took the lock (the agent started a call there): hand the phone over and queue up as a standby.
	function lose_leadership() {
		console.info("[softphone] the phone moved to another tab");
		is_leader = false;
		if (ping_timer) clearInterval(ping_timer); // no offline() call: the new phone tab pings for the same agent
		ping_timer = null;
		try { client && client.UnRegister(); } catch (e) { /* already gone */ }
		client = null;
		set_state({ ready: false, status: __("Softphone is in another tab") });
		if (channel) channel.postMessage({ type: "released" });
		queue_for_lock(); // the next tab to close the phone, or to lose it, passes it back here
	}

	function queue_for_lock() {
		navigator.locks.request(LOCK_NAME, become_leader).catch((e) => {
			if (e && e.name === "AbortError") lose_leadership();
		});
	}

	// The tab where the agent presses Call becomes the phone: audio plays where they are looking, the microphone
	// prompt shows in the visible tab, and the click counts as the user gesture Chrome wants for audio.
	// Never while a call is live. Resolves once this tab's softphone is registered (or after 10 s: the call is placed anyway).
	function ensure_leader() {
		if (!state.enabled || is_leader || !navigator.locks || state.call) return Promise.resolve();
		taking_over = true;
		navigator.locks.request(LOCK_NAME, { steal: true }, become_leader).catch((e) => {
			if (e && e.name === "AbortError") lose_leadership();
		});
		return new Promise((resolve) => {
			const t0 = Date.now();
			const tick = setInterval(() => {
				if ((is_leader && state.ready) || Date.now() - t0 > 10000) {
					clearInterval(tick);
					resolve();
				}
			}, 200);
		});
	}

	// ---------------------------------------------------------------- the widget (every tab)
	function ensure_root() {
		if ($root) return $root;
		if (!document.getElementById("exotel-softphone-css")) {
			const css = document.createElement("style");
			css.id = "exotel-softphone-css";
			css.textContent = `
			#exotel-softphone { position: fixed; right: 16px; bottom: 16px; z-index: 1052; width: 280px;
				max-width: calc(100vw - 32px); font-size: 13px; color: var(--text-color, #1f272e); }
			#exotel-softphone .xs-pill { display: flex; align-items: center; gap: 8px; margin-left: auto; width: fit-content;
				max-width: 100%; padding: 6px 12px; border-radius: 999px; background: var(--card-bg, #fff);
				border: 1px solid var(--border-color, #d1d8dd); box-shadow: 0 2px 8px rgba(0,0,0,.12); }
			#exotel-softphone .xs-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; background: var(--gray-500, #8d99a6); }
			#exotel-softphone .xs-dot.ok { background: var(--green-500, #38a169); }
			#exotel-softphone .xs-card { margin-bottom: 8px; padding: 12px 14px; border-radius: 8px; background: var(--card-bg, #fff);
				border: 1px solid var(--border-color, #d1d8dd); border-left: 4px solid var(--blue-500, #318ad8);
				box-shadow: 0 6px 20px rgba(0,0,0,.18); }
			#exotel-softphone .xs-card.live { border-left-color: var(--green-500, #38a169); }
			#exotel-softphone .xs-who { font-weight: 600; font-size: 14px; overflow-wrap: anywhere; }
			#exotel-softphone .xs-sub { color: var(--text-muted, #6c7680); margin-bottom: 8px; }
			#exotel-softphone .xs-row { display: flex; flex-wrap: wrap; gap: 6px; }
			#exotel-softphone .xs-pad { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; margin-top: 8px; }
			#exotel-softphone .xs-pad[hidden] { display: none; }`;
			document.head.appendChild(css);
		}
		$root = $('<div id="exotel-softphone"></div>').appendTo(document.body);
		$root.on("click", "[data-cmd]", function () {
			command($(this).data("cmd"), $(this).data("arg"));
		});
		$root.on("click", "[data-allow-mic]", allow_mic);
		$root.on("click", "[data-toggle-pad]", function () {
			$root.find(".xs-pad").toggle();
		});
		return $root;
	}

	function mmss(ms) {
		const s = Math.max(0, Math.floor(ms / 1000));
		return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
	}

	function render() {
		if (!state.enabled) {
			if ($root) $root.empty();
			return;
		}
		const $r = ensure_root();
		const c = state.call;
		let html = "";
		// the lead popup (furnishka_crm call_popup.js) carries Answer / Reject for the same call: one card, not two
		const popup_has_it = c && c.sid && window.furnishka_call_popup && window.furnishka_call_popup.has(c.sid);
		if (c && c.phase === "ring" && !popup_has_it) {
			html += `<div class="xs-card"><div class="xs-who">${esc(c.who)}</div>
				<div class="xs-sub">${esc(__("Incoming call"))}</div>
				<div class="xs-row"><button class="btn btn-sm btn-primary" data-cmd="answer">${esc(__("Answer"))}</button>
				<button class="btn btn-sm btn-default" data-cmd="hangup">${esc(__("Reject"))}</button></div></div>`;
		} else if (c && c.phase === "live") {
			html += `<div class="xs-card live"><div class="xs-who">${esc(c.who)}</div>
				<div class="xs-sub"><span class="xs-time">${mmss(Date.now() - c.since)}</span>${c.held ? " · " + esc(__("On hold")) : ""}${c.muted ? " · " + esc(__("Muted")) : ""}</div>
				<div class="xs-row">
				<button class="btn btn-sm btn-default" data-cmd="mute">${esc(c.muted ? __("Unmute") : __("Mute"))}</button>
				<button class="btn btn-sm btn-default" data-cmd="hold">${esc(c.held ? __("Resume") : __("Hold"))}</button>
				<button class="btn btn-sm btn-default" data-toggle-pad="1">${esc(__("Keypad"))}</button>
				<button class="btn btn-sm btn-danger" data-cmd="hangup">${esc(__("Hang up"))}</button></div>
				<div class="xs-pad" hidden>${DIGITS.map((d) => `<button class="btn btn-xs btn-default" data-cmd="dtmf" data-arg="${d}">${d}</button>`).join("")}</div></div>`;
		}
		if (mic === "prompt") {
			html += `<div class="xs-card"><div class="xs-sub">${esc(__("Allow the microphone once, so calls can be answered from any tab."))}</div>
				<div class="xs-row"><button class="btn btn-sm btn-primary" data-allow-mic="1">${esc(__("Allow microphone"))}</button></div></div>`;
		} else if (mic === "denied") {
			html += `<div class="xs-card"><div class="xs-sub">${esc(__("Microphone is blocked for this site. Click the lock icon in the address bar and allow it, then reload."))}</div></div>`;
		}
		html += `<div class="xs-pill"><span class="xs-dot ${state.ready ? "ok" : ""}"></span><span>${esc(state.status)}</span></div>`;
		$r.html(html);

		clearInterval(timer);
		if (c && c.phase === "live") {
			timer = setInterval(() => $r.find(".xs-time").text(mmss(Date.now() - c.since)), 1000);
		}
	}

	function watch_mic() {
		try {
			navigator.permissions.query({ name: "microphone" }).then((p) => {
				mic = p.state;
				p.onchange = () => { mic = p.state; render(); };
				render();
			}).catch(() => {});
		} catch (e) { /* browser without the Permissions API: the button stays out of the way */ }
	}

	function allow_mic() {
		navigator.mediaDevices.getUserMedia({ audio: true })
			.then((stream) => { stream.getTracks().forEach((t) => t.stop()); mic = "granted"; render(); })
			.catch(() => { mic = "denied"; render(); });
	}

	// ---------------------------------------------------------------- start
	function start() {
		if (!frappe.session || frappe.session.user === "Guest") return;
		watch_mic();

		if (window.BroadcastChannel) {
			channel = new BroadcastChannel(CHANNEL_NAME);
			channel.onmessage = (e) => {
				const m = e.data || {};
				if (m.type === "state" && !is_leader) {
					Object.assign(state, m.state);
					render();
				} else if (m.type === "cmd" && is_leader) {
					run_command(m.cmd, m.arg);
				} else if (m.type === "hello" && is_leader) {
					publish();
				} else if (m.type === "released" && released_resolve) {
					released_resolve();
					released_resolve = null;
				}
			};
			channel.postMessage({ type: "hello" });
		}

		if (navigator.locks) queue_for_lock();
		else become_leader(); // very old browser: every tab is its own phone
	}

	// the lead popup appeared or went away: show the plain ring card only when it is not covered
	document.addEventListener("furnishka-call-popup-change", render);

	$(start);
})();
