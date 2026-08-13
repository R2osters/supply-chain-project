# Tracking a truck in real time — what you actually have to do

This document answers one question: **a customer wants to see their trucks moving on a map. What
do they have to do, and what does it cost?**

It is written for the person who has to make the decision and then make it work, not for a
developer. Where something does not work, it says so.

---

## 1. The problem nobody mentions

"Real-time truck tracking" sounds like a software feature. It is not. Software cannot see a truck.
Something physically inside the vehicle has to know where it is and say so over a mobile network.
Every tracking product on the market is a wrapper around that one fact, and every price difference
comes from *what* that something is.

So the real decision is not "which platform" but **what goes in the cab**. There are three answers,
and SCIP accepts all three through the same validated pipeline — a position from a €15 tracker is
checked exactly as hard as one from the API.

| Path | Hardware cost | Running cost | Best for | Works when the driver isn't there |
| --- | --- | --- | --- | --- |
| **Driver's phone** | **€0** | ~30 MB/month of data | Everyone. Subcontractors, hired vans, day one. | No |
| **Wired GPS tracker** | €15–50 once | One SIM, ~30 MB/month | Owned fleet, trailers, unattended vehicles | Yes |
| **Existing telematics** | Already paid | Already paid | Fleets already running Traccar/Webfleet/Samsara | Yes |

The rest of this document is what each one requires, in order.

---

## 2. Path A — the driver's phone (€0)

**Every driver already carries a GPS receiver.** This path uses it. There is nothing to buy, nothing
to install in the vehicle, and it works on the first day.

### What the dispatcher does, once per driver

1. Open **Devices** in SCIP.
2. Choose **Driver's phone**, type any stable name (`kwame-phone-01`), pick the vehicle, press
   **Enrol**.
3. A **pairing link** appears. Copy it and send it to the driver — WhatsApp, SMS, anything.
   It is shown **once**. If it is lost, enrol the phone again to issue a new one.

### What the driver does, once

1. Tap the link. It opens the driver screen with the identifier and secret already filled in —
   nothing to type.
2. Tap **Add to home screen**. It then opens full-screen like an app.

### What the driver does, every trip

1. Open it, tap **Start**.
2. Plug the phone in and leave the screen on.

That is the whole procedure.

### What this path honestly cannot do

**It stops reporting when the screen is off or the driver switches apps.** This is not a bug or a
setting we forgot: a mobile browser suspends timers and the geolocation watch for a page that is not
visible — iOS Safari immediately, Android Chrome within a minute or two. No web page can work around
it. Only a native app with a foreground service can, and that is a different product.

What the screen does about it:

- It holds a **wake lock**, so the display does not sleep by itself while the page is open.
- It says so on screen, in plain language, rather than showing a green light that means nothing.
- **Every fix taken is kept**, so the positions are not lost — they are sent when the driver comes
  back to the screen.

Two other real constraints:

- **Battery.** Continuous GPS costs roughly 5–10% per hour. A 4-hour run on an unplugged phone is
  not realistic. A €3 car charger fixes it; budget for one per truck.
- **Data.** A position is ~150 bytes. At one every 10 seconds, a 10-hour day is about **5 MB**, so
  a 30 MB monthly bundle is generous.

### What this path does better than the hardware

**Coverage gaps.** The Accra–Kumasi road loses cellular signal for tens of kilometres at a stretch.
GPS does not care — it hears satellites, not towers — so the phone keeps recording throughout and
stores the fixes in the phone's own database. When signal returns, the backlog is sent as one batch
and the track has **no hole** in exactly the section a dispatcher would most want to see.

Most cheap hardware trackers simply drop those positions.

---

## 3. Path B — a wired GPS tracker (€15–50 per vehicle)

For a vehicle that must report whether or not a driver is aboard — a trailer, a tanker, a truck with
rotating drivers — buy hardware.

### What to buy

The commodity device is a **GT06 / Concox** tracker. It is sold under a hundred brand names
(GT06N, TR06, JM-VL01, and so on) for **€15–50**, and they all speak the same protocol. Any of them
works. Do not buy a "tracking subscription" bundled with the box: the box is the useful part.

You also need a **data SIM** per vehicle. Any prepaid bundle of 30 MB/month is enough.

### What the installer does

1. Insert the SIM.
2. Wire it: 12/24 V permanent, ground, and the ignition sense wire. It is three wires behind the
   dashboard — any auto-electrician does this in twenty minutes. A magnetic battery-powered model
   needs no wiring at all, but must be recharged.
3. Send the tracker **four SMS messages**, which is how these devices are configured:

   ```
   APN#<your operator's APN>#
   server#<your public host>#5023#
   timer#30#
   ```

   The exact server line is shown on the **Devices** screen, already filled in with your host.

4. In SCIP, choose **GT06 / Concox tracker**, type the **IMEI** (15 digits, printed on the device
   and on its box), pick the vehicle, press **Enrol**.

The tracker connects on its own and appears as **ONLINE** within a minute.

### Why this needs a separate port and not just "an API"

These devices do not speak HTTP. They open a raw TCP socket and send **binary frames** —
`0x7878`, a length byte, a protocol byte, a payload, a two-byte serial, a CRC-ITU checksum,
`0x0D0A` — and they wait for the server to acknowledge each one before sending the next. A device
that is not acknowledged assumes the server is dead, hangs up and redials, burning SIM data.

SCIP therefore runs a **TCP gateway on port 5023** alongside the web API. Port 5023 is deliberate:
it is the port Traccar uses for GT06, so a device already configured for a Traccar installation
points here with no re-flashing.

**What you must open on the firewall: inbound TCP 5023.** That is the one infrastructure change this
path requires.

### What is decoded today

Login (`0x01`), GPS (`0x12`), status (`0x13`), GPS+LBS (`0x22`), alarm (`0x16`), GPS+LBS+status
(`0x26`), and time sync (`0x8A`). Ignition, battery level, charging state, and SOS / power-cut
alarms all come through — an SOS raises a **critical incident and an email**, not a log line.

**Teltonika Codec 8 is not decoded.** The device type exists in the system, and enrolling one
records it, but it will not store positions. That is stated on the enrolment screen rather than
discovered later.

---

## 4. Path C — a fleet already running telematics

If the vehicles already carry Webfleet, Samsara, Geotab or a Traccar server, the positions exist —
they just live somewhere else. Post them to:

```
POST /api/v1/devices/phone/positions
```

with a `MANUAL` device's identifier and secret, and up to 500 fixes per request. The same
validation applies. This is a documented endpoint, not an integration with any particular vendor:
**no vendor connector is written**, and none is claimed.

---

## 5. What happens to a position after it arrives

Every fix, from every path, goes through the same checks. None of them are cosmetic — each one
exists because the failure it catches puts a truck in the wrong place on a dispatcher's map.

| Check | Why |
| --- | --- |
| Latitude/longitude in range | A corrupt frame decodes to nonsense |
| **Not (0, 0)** | A tracker with no satellite fix reports null island. It is a few hundred km off Ghana — on the map it looks *almost* plausible, which is what makes it dangerous |
| Timestamp not in the future | A tracker with a wrong clock, rejected rather than trusted |
| Implied speed below 250 km/h | Two fixes that would need a jet between them |
| Moved at least 8 m | A parked truck's GPS jitter is noise, not movement |

Rejections are **counted per device** and shown on the Devices screen. A tracker with a rising
rejection count is a tracker with a problem, and that is visible before anyone notices the map is
wrong.

Accepted fixes are written to `gps_positions` with a PostGIS geography column, pushed to the live
map over a WebSocket scoped to your company, and used to recompute the shipment's ETA and its
route-deviation check.

**Positions from a device are marked `isSimulated = false`.** Demo data generated by the built-in
simulator is marked `true` and badged in the interface. The two are never mixed or presented as the
same thing.

### Devices go OFFLINE on their own

A tracker that loses power never says goodbye — the socket dies without a proper close. A sweep runs
every minute and marks any device that has missed **five** of its own reporting intervals as
OFFLINE. Without it, the screen would show a truck as ONLINE forever, which is worse than showing
nothing: a green dot is read as "I would know if it stopped".

---

## 6. Recommendation

- **Start with the phones.** Zero cost, working the same afternoon, and it tells you whether
  tracking actually changes how you dispatch before you spend anything.
- **Buy hardware for the vehicles where the phone path fails**: trailers, unattended vehicles,
  rotating drivers, or any run long enough that the screen-on requirement is unrealistic.
- **Budget €3 for a car charger per phone.** It is the single cheapest thing on this page and the
  most common reason phone tracking disappoints.

---

## 7. Verification — how we know this works

Both paths were tested against the running system, not read.

**Hardware path.** A script opens a real TCP socket to port 5023 and speaks the GT06 protocol at the
wire level: login, acknowledgement, status, then GPS frames along the Accra–Kumasi road.
Result: **6 fixes sent, 6 accepted, 0 rejected**, coordinates exact to four decimal places, stored
with `isSimulated = false`.

An earlier run of that same script had **5 of 6 rejected**. The cause was in the test, not the
server: it stamped six positions 700 ms apart across 250 km, implying 70 000 km/h, and the
plausibility check refused them. That is the check doing its job.

**Phone path.** A script posts batches to the live endpoint, deliberately withholding a middle
stretch to imitate a coverage gap and flushing it late. Result: **7 fixes, all accepted, no hole in
the stored track**. A request with the wrong pairing secret was refused.

**The codec** has 26 unit tests, including both hemisphere cases. The CRC is anchored on a
**real hardware login packet**, not on a vector invented to make the test pass.

---

*French version: [TRACKING.fr.md](TRACKING.fr.md)*
