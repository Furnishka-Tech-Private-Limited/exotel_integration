# Softphone module

A VoIP softphone inside the ERPNext desk, built on the Exotel Voice WebSDK (bundle in `public/js/softphone/exotelsdk/`,
client-sdk 3.0.16). Only agents with a VoIP SIP username in their Employee record get it.

| Part | File |
|---|---|
| Settings (switch, proxy, domain) | `Exotel Settings` > "Softphone (VoIP in ERPNext)" |
| Employee fields | `custom_voip_sip_user`, `custom_voip_sip_password` (patch `v1_3`) |
| Server | `softphone/api.py`: `get_softphone_config` (the logged-in user's own settings) and `agent_sip_id` |
| Browser | `public/js/softphone/softphone.js` (one leader tab registers; other tabs mirror it) |
| Outbound | `handler.make_a_call(use_softphone=1)` makes Exotel ring `sip:<user>` first, then the customer |

Audio and SIP signalling go browser <-> Exotel; this server only serves the JS and one settings call per page load.

Setup: fill the proxy and domain from my.exotel.com > VOIP, tick *Enable Softphone*, give each agent their SIP
username and password (the password the agent set at my.exotel.com/voipinfo), reload ERPNext, allow the microphone.
Inbound: `presence.py` keeps a Redis flag per agent (ping every 45 s from the registered tab, TTL 90 s, cleared on close). furnishka_crm's `exotel_routing.get_route` answers `sip:<user>` when the flag is set, else the mobile. `presence.employee_for_sip` maps a SIP leg back to the Employee (used by the Call Log override and the routing trail).
