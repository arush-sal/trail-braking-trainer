# GT7 steering gate: evidence from local captures

Date: 2026-11-14. Scope: spec section 4.3 (GT7 steering input). Read-only investigation of the
owner's separate GT7 workspace (`~/go/src/github.com/arush-sal/gt7`). Follows on from
`docs/research/public-evidence.md` section 7.

## Verdict

**Driver steering input: INCONCLUSIVE (not verified).**

- `wheel_rotation` (offset 0x128, float32, rad) exists in every stored capture. It is a real
  steering-command signal, not vehicle dynamics. It moves at standstill, has zero lag to the
  front-wheel angles, and its derivative is exactly `steering_angular_velocity` (0x12C).
- It is **not** shown to be the raw controller or wheel position. It is the game's steering-wheel
  state, and the front-wheel angles are a fixed multiple of it within a recording. It is also
  stored in replays, and the game ramps it to zero on its own during loading. No capture has
  ground truth for the physical input, and no GT7 steering assist is ever seen splitting it from
  the wheel angles. So we cannot tell "driver input" from "game-applied steering command".
- Keep `steering.available=false` for GT7. `wheel_rotation` is now a **strong candidate** to
  expose as diagnostics (better than the front-wheel angles: same timing, but in the
  steering-wheel domain and independent of car geometry). Do not map it to trainer steering
  until the manual test below passes.

## Sources examined

All paths are relative to `~/go/src/github.com/arush-sal/gt7`. Nothing there was modified.

| Source | What | Used |
|---|---|---|
| `captures/*.pcapng` | 8 Red Bull Ring captures, 17-453 MB each, 2026-10-16..18 | Decrypted and analysed |
| `supporting-data/raw-packet-captures/*.pcapng` | 14 captures, 1.3-39 MB, 2026-07-20 (Suzuka, Le Mans, Interlagos, Grand Valley with pit, etc.) | Decrypted and analysed |
| `backend/rawdump/*.pcap` | 3 non-empty classic pcaps (8-49 MB); every frame is 410 B = Eth+IP+UDP+368 | Format C by length only, not decoded (redundant) |
| `gt7-telemetry-collector/protocol/{constants,decode,gt7ddata}.go` | Offsets, masks, confidence notes | Offsets reused |
| `decode-harness/`, `replay-client/` | pcapng -> collector decode tooling | Method reference only |
| `sample-json-output.json` | One live SSE frame (`throttle: 68.62745` = 175/2.55) | Units check |
| `victorydash.io-analysis.md` | Third-party dashboard reverse engineering: 0x128 = "Steering (radians)", plotted -240..240 deg | Community interpretation |
| `agent/SPEC.md` s.~2276 | All remaining captures are format C | Corroboration |
| Vault `~/.obsidian/vaults/gt7/Projects/GARAGE/` notes: `Specs/GT7 Packet Format C Field Map.md`, `Sessions/2026-10-17 *` | Field confidence; capture composition (live vs replay) | Context |
| `Gran Turismo(TM) 7_20260712211043.webm` (211 MB) | Daytona reference video (per vault, synced to `type-c-onelap-video-company-capture`) | Metadata only, not processed. GT7's HUD has no steering readout |
| Postgres/TimescaleDB | Not running (no container up). Data dir `~/.garage/timescaledb` (owned by uid 70, not readable). Schema (`backend/internal/db/migrations`): `sessions`, `laps`, `lap_trace` (throttle/brake 0-100, `steering` = mean front-wheel angle, no `wheel_rotation`) | Not queried. The DB is derived from the same packets and has no more steering information than the pcaps |

Totals: 22 pcapng files, **1,490,038 telemetry datagrams**, all 368 B, **100% decrypted** with
IV mask `0xDEADBEEF` and a valid magic. **Packet variants: only C** (heartbeat `C`, 368 B). No A (296),
B (316) or `~` (344) packets exist in any stored capture, so the B/`~` layouts are still
unverified locally. Format C contains the B/`~` prefix (0x128..0x158), so `wheelRotation` at 0x128
is present.

## Method

- A small Go tool in a scratch directory decrypts the captures (Salsa20, per-length IV mask,
  magic check, same scheme as `protocol/decrypt.go`). It writes per-frame CSVs to scratch with:
  pcap timestamp, package_id, car_id, flags, speed, throttle 0x91, brake 0x92, yaw rate 0x30,
  `wheel_rotation` 0x128, `steering_angular_velocity` 0x12C, throttle/brake "filtered"
  0x13C/0x13D, front-wheel angles 0x160/0x164, wheelbase and car category.
- Analysis was numpy only (`python3 -I`): rate, ranges, correlation, cross-correlation lag,
  ratio against speed, standstill and pause behaviour, saturation, sign convention, and
  segments where the signals decouple.
- No raw data was copied out of scratch, and nothing was uploaded.

## Findings

### 1. Fields, format and rate

- Every capture is format C, 368 B. `package_id` increments by exactly 1 in 99.9-100% of
  consecutive frames.
- Rate: 59.9-60.0 Hz (one capture averages 54 Hz over its wall time because of send gaps).
  `wheel_rotation`, the front-wheel angles and the pedals are fresh every frame (60 Hz).

### 2. Is `wheel_rotation` a driver steering command?

**Evidence that it is a steering-command signal (not vehicle output):**

- **Fixed ratio to the front-wheel angles, zero lag.** The mean front-wheel angle is a constant
  multiple of `wheel_rotation`:
  - corr = 0.988-1.0000 across the 21 files with real steering (>= 0.9997 in 14, = 1.0000 in 6).
  - The ratio is stable within a recording (first half vs second half within 0.0005). It is
    nearly speed-independent: for car 3342 at Grand Valley it is 0.0661 from 0-1 km/h through
    150+ km/h.
  - Cross-correlation of first differences peaks at **lag 0 frames** in every file. Within 1/60 s
    neither signal leads the other, so they are one signal at two scales.
  - Residuals > 0.01 rad appear only at full lock (Ackermann non-linearity) and during
    loading/teleport frames.
- **`steering_angular_velocity` (0x12C) is exactly d(`wheel_rotation`)/dt.** The median ratio
  is 0.999 in every file, and corr = 1.000 in 15 of 22 (0.80-0.998 elsewhere, from single-frame jumps at loading transitions).
  It adds no information.
- **It moves at standstill.** Grand Valley pit stop: speed < 0.5 km/h, `in_race` set, not in
  gear, throttle blips up to 195/255. `wheel_rotation` sweeps -2.93..+3.14 rad. One 8.2 s
  segment has 74 direction reversals, and 813 frames step more than 0.01 rad. The front wheels
  follow (-0.19..+0.29 rad). Other standstill steering: RBR time trials (459 frames,
  -3.07..2.92) and Sardegna (106 frames). Vehicle dynamics cannot produce this. It is the
  steering command.
- **It is frozen while paused.** 0 changes across about 70k paused frames.
- **The ratio follows the recording, not the car.** On 2026-10-16, four different cars with
  wheelbases of 2.53-2.74 m all show a ratio of 0.0904-0.0910. The same car 396 shows 0.0909-0.0920
  in its 10-16 and 10-18 captures, but 0.068 in both 10-17 captures (which the vault notes are
  mostly replays: a looping GT7 best-lap replay and a GTWS race replay). A fixed steering rack
  would give a per-car ratio. A per-recording ratio suggests `wheel_rotation` sits on the
  controller/steering-wheel side and is mapped to the road wheels through a setting (likely the
  input device or wheel-rotation configuration of whoever drove). This is an **inference**: the
  input device and settings for each recording are not documented anywhere.

**Evidence that it is not proven to be the raw physical input:**

- **Car- or recording-dependent lock.**
  - Car 396 saturates at exactly +/-3.0724 rad (176 deg) across 4 recordings: 6,376 frames at
    the cap in the time-trial capture.
  - Six other cars stop at exactly pi (3.1416 rad, 180 deg): 1,481 frames at the cap at Grand
    Valley.
  - Car 396 reached 4.221 rad (242 deg) in the 10-17 capture, while its front wheels reached
    0.344 rad.
  - A raw device axis would saturate at the device's range, not at per-car values. This is the
    game's virtual steering wheel, clamped by the game.
- **Game-generated motion.** On loading/teleport transitions (flags0 bit 2) the front wheels go
  to 0 at once. `wheel_rotation` holds its last value for 11-24 frames (35 segments, 342
  frames, all constant, none varying). Then it returns to 0 in fixed steps of about 0.524
  rad/frame (pi/6). That is why |d/dt| maxes out at 31.45 rad/s in five files. A human would not
  produce this. The field is game state that the game can drive.
- **Present in replays** (lobby-replays, 1.30 best-lap loop, GTWS replay), with the same
  behaviour. It is recorded simulation state, not a live device read.
- **No assist split is ever observed.** The throttle comparison below shows GT7 does expose a
  separate pre-assist driver channel for throttle. For steering, no frame shows
  `wheel_rotation` and the front-wheel angles diverging while driving, including about 1,600
  countersteer-like frames (opposite sign to yaw rate, |yaw| > 0.2 rad/s) in the time-trial
  capture. Either no steering assist was active in these recordings, or both fields are
  post-assist. The data cannot tell which.
- **No ground truth.** No capture records the physical wheel or controller position. The
  reference video's HUD shows no steering.

**Units, sign and range (inferred, consistent across files):**

- Units are radians of the virtual steering wheel. The front-wheel angles are radians at the
  road wheel. The ratio of road-wheel angle to `wheel_rotation` is 0.058-0.092, which is a
  steering ratio of about 11:1 to 17:1.
- **Positive = left / counter-clockwise.** Three independent checks:
  - (a) Ackermann: for w > 0.3 the left wheel angle (0x160) is larger in 100% of frames, and for
    w < -0.3 the right wheel's is (in 18 of 19 files with turns both ways; Grand Valley is about 50/50).
  - (b) Sign agrees with yaw rate in 93-99.9% of frames at > 40 km/h (the Daytona/banked-oval
    captures are the exception, at 29-65%).
  - (c) Track handedness: on clockwise Red Bull Ring 18-32% of steered frames are positive. On
    anticlockwise Interlagos it is 69%.

### 3. Brake and throttle (units, rate)

- Throttle 0x91 and brake 0x92 are **uint8 0-255**. All 256 values appear in most files. The
  collector divides by 2.55 to give 0-100. They update at 60 Hz with no lag between the two
  throttle channels.
- **Throttle 0x91 is the applied value, after traction control. 0x13C ("throttle filtered")
  behaves like the driver's pedal before TCS.**
  - While the TCS-active flag (flags1 bit 3) is set, 0x91 < 0x13C in **100%** of frames in all
    19 files tested. Without TCS it is 1-17%.
  - 0x91 > 0x13C only 0-2.5% of the time (likely blips or auto-throttle).
  - During loading frames, 0x13C reads 255 while 0x91 reads 34-38.
  - For trainer pedal input, **0x13C is the better driver-throttle candidate**. This is
    inferred, not proven.
- **Brake:** 0x92 >= 0x13D in every frame. They differ in 7-20% of live frames, corr = 0.95-0.995,
  and 0x92 lags 0x13D by 0-1 frame. The meaning of the difference is unknown.
  - 0x13D is constantly 0 in the 10-17 captures (mostly replays) even though 0x92 reaches 255.
    This is consistent with the vault note that the filtered channels are unavailable in
    replays.
  - Treat 0x92 as the brake value and 0x13D as unconfirmed.

### 4. Notes found on steering semantics

- `gt7-telemetry-collector/protocol/constants.go` and the vault field map rate `WheelRotation`
  MED: it "read exactly pi during peak steering". This is explained above: pi is a per-car game
  clamp, not coincidence. `SteeringAngularVelocity` is rated MED, and its meaning is now
  confirmed as d/dt of `wheel_rotation`.
- The front-wheel angles are rated HIGH (they peak about 13.5 deg on Daytona's banking in the
  video-synced capture).
- The vault `Sessions/2026-10-17 Steering Graph and Dock Resize.md` says "GT7 only sends
  road-wheel angles; `wheel_rotation` is unconfirmed". The backend stores only the mean
  front-wheel angle.
- `agent/SPEC.md` tells developers to use the front-wheel angles rather than `wheel_rotation`.
- `victorydash.io-analysis.md`: a third-party dashboard plots 0x128 as steering, -240..240 deg.
  This matches the 242 deg maximum seen here.
- `handoff-prompt.md`, `code-explore.md` and `kb/` have nothing on steering semantics.

## Confidence

| Claim | Confidence |
|---|---|
| Stored data is format C only, 60 Hz, offsets 0x128/0x12C/0x160/0x164 decode correctly | High |
| `wheel_rotation` is a steering-command signal (moves at standstill, zero lag, fixed ratio to the wheels) | High |
| 0x12C = d/dt of 0x128 | High |
| Sign: positive = left | Medium-high |
| `wheel_rotation` is clamped by the game per car/recording, held and ramped by the game during loading, and present in replays | High |
| `wheel_rotation` equals the physical wheel/controller position (pre-assist, 1:1 with device) | **Unverified (low)** |
| Throttle 0x91 = post-TCS, 0x13C = driver pedal | Medium-high |
| Brake 0x92 vs 0x13D semantics | Low |

## Manual test that would settle it

One live session, heartbeat `C` (and `B`/`~` if the collector can request them, to verify those
layouts as well). Record each step on video together with the pcap.

1. Use a wheel base with a known rotation (for example, Fanatec set to a fixed degree of
   rotation). Record the device's own angle at the same time: Chrome Gamepad axis, or the
   wheel's on-screen display, with a protractor mark on the rim.
2. **Standstill sweep** (pit box or grid, in neutral). Hold center, then 45, 90, 180 deg left and
   right, then full lock, about 2 s each. Pass if `wheel_rotation` matches the physical angle
   1:1 (or by a constant documented factor) and saturates where the device does, not at a
   per-car value.
3. **Repeat with a second car** that has a different in-game lock (for example car 396, whose
   clamp was 3.0724 rad, against a pi-clamp car). If the in-game value clamps before the
   physical wheel stops, the field is game-side.
4. **Assists:** with Countersteer Assist and steering assist ON, induce oversteer while holding
   the wheel fixed. If `wheel_rotation` moves while the hands hold still, the field is
   post-assist (vehicle side). Repeat with the assists OFF.
5. **DualSense:** same sweep with the stick. Check whether speed-sensitive steering reduces
   `wheel_rotation` at speed for the same stick deflection.

A pass on steps 2-4 (1:1, device-bound saturation, no motion under assists) would justify
VERIFIED and a mapping such as `wheel_rotation / (device_range/2)`.
