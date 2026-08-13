/**
 * GT06 / Concox protocol codec.
 *
 * This is the protocol spoken by the cheapest GPS trackers on the market — the €15–50 devices
 * sold under a hundred brand names (Concox GT06N, TK103, ST-901 and their clones). It matters
 * because it is what a small haulier in Accra or Abidjan can actually afford to buy, and it is
 * what they will actually buy. Supporting Teltonika alone would mean supporting a device that
 * costs more than the margin on a load.
 *
 * The awkward part: these devices speak **binary over a raw TCP socket**, not HTTP. They dial a
 * host and port, send a login packet, and then stream location packets, expecting the server to
 * acknowledge specific message types. A device whose login is not acknowledged will disconnect
 * and retry forever, which on a metered SIM is a real cost to the operator.
 *
 * Frame layout:
 *
 *   0x78 0x78  <len>  <protocol>  <payload…>  <serial:2>  <crc:2>  0x0D 0x0A     short frame
 *   0x79 0x79  <len:2> <protocol> <payload…>  <serial:2>  <crc:2>  0x0D 0x0A     long frame
 *
 * `len` counts from the protocol byte through the CRC. The CRC is CRC-ITU (X.25) computed over
 * the bytes from `len` up to but excluding the CRC itself.
 *
 * Reference behaviour follows Traccar's decoder, which is the de-facto specification — the
 * vendor documentation for these devices is inconsistent between clones, and Traccar's is the
 * implementation that demonstrably works against real hardware.
 */

export const GT06_START_SHORT = 0x7878;
export const GT06_START_LONG = 0x7979;
export const GT06_END = 0x0d0a;

/** Message types this gateway understands. */
export const GT06_PROTOCOL = {
  LOGIN: 0x01,
  GPS: 0x12,
  STATUS: 0x13,
  /** GT06N and later put GPS + LBS in one packet. */
  GPS_LBS: 0x22,
  ALARM: 0x16,
  GPS_LBS_STATUS: 0x26,
  /** Server → device time synchronisation, sent in reply to a login. */
  TIME: 0x8a,
} as const;

/** Alarm codes carried in the status byte of an alarm packet. */
export const GT06_ALARM: Record<number, string> = {
  0x01: 'SOS',
  0x02: 'POWER_CUT',
  0x03: 'VIBRATION',
  0x04: 'GEOFENCE_ENTER',
  0x05: 'GEOFENCE_EXIT',
  0x06: 'OVERSPEED',
  0x09: 'DISPLACEMENT',
  0x0e: 'LOW_BATTERY',
  0x13: 'POWER_OFF',
};

export interface Gt06Frame {
  protocol: number;
  payload: Buffer;
  serial: number;
  /** Bytes consumed from the input, so a stream reader can advance correctly. */
  length: number;
}

export interface Gt06Location {
  /** Device time, UTC. These devices report UTC regardless of where they are. */
  recordedAt: Date;
  satellites: number;
  latitude: number;
  longitude: number;
  speedKmh: number;
  courseDegrees: number;
  /** False when the device has no fix; the coordinates are then the last known, not current. */
  valid: boolean;
}

export interface Gt06Status {
  ignitionOn: boolean;
  charging: boolean;
  /** 0–6, the device's own coarse scale. */
  batteryLevel: number;
  gsmSignal: number;
  alarm: string | null;
}

/* ============================================================================
   CRC-ITU (X.25)
   ========================================================================== */

const CRC_TABLE: number[] = (() => {
  const table = new Array<number>(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? (value >>> 1) ^ 0x8408 : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

export function crcItu(buffer: Buffer): number {
  let fcs = 0xffff;
  for (const byte of buffer) {
    fcs = (fcs >>> 8) ^ CRC_TABLE[(fcs ^ byte) & 0xff];
  }
  return (~fcs) & 0xffff;
}

/* ============================================================================
   Framing
   ========================================================================== */

/**
 * Reads one complete frame from the head of a buffer.
 *
 * Returns `null` when the buffer does not yet hold a whole frame — TCP is a stream, so a packet
 * can and does arrive split across two reads, and treating a partial frame as corrupt would drop
 * perfectly good positions.
 */
export function readFrame(buffer: Buffer): Gt06Frame | null {
  if (buffer.length < 5) return null;

  const start = buffer.readUInt16BE(0);
  if (start !== GT06_START_SHORT && start !== GT06_START_LONG) {
    throw new Gt06ProtocolError(`Unknown frame start 0x${start.toString(16)}`);
  }

  const isLong = start === GT06_START_LONG;
  const lengthSize = isLong ? 2 : 1;
  const declaredLength = isLong ? buffer.readUInt16BE(2) : buffer.readUInt8(2);

  // start(2) + lengthField + declaredLength(protocol…crc) + end(2)
  const totalLength = 2 + lengthSize + declaredLength + 2;
  if (buffer.length < totalLength) return null;

  const end = buffer.readUInt16BE(totalLength - 2);
  if (end !== GT06_END) {
    throw new Gt06ProtocolError(`Bad frame terminator 0x${end.toString(16)}`);
  }

  const protocol = buffer.readUInt8(2 + lengthSize);
  const payloadStart = 2 + lengthSize + 1;
  const payloadEnd = totalLength - 2 - 2 - 2; // before serial(2) and crc(2)
  const payload = buffer.subarray(payloadStart, payloadEnd);
  const serial = buffer.readUInt16BE(payloadEnd);
  const declaredCrc = buffer.readUInt16BE(payloadEnd + 2);

  // The CRC covers everything from the length field up to (not including) the CRC.
  const crcRegion = buffer.subarray(2, payloadEnd + 2);
  const computed = crcItu(crcRegion);

  if (computed !== declaredCrc) {
    throw new Gt06ProtocolError(
      `CRC mismatch: declared 0x${declaredCrc.toString(16)}, computed 0x${computed.toString(16)}`,
    );
  }

  return { protocol, payload, serial, length: totalLength };
}

/**
 * Builds the acknowledgement the device is waiting for.
 *
 * Not optional. A device whose login goes unacknowledged assumes the server is unreachable,
 * closes the socket and redials — every few seconds, forever, on a metered SIM. Getting this
 * wrong does not look like a bug; it looks like a mysterious data bill.
 */
export function buildAck(protocol: number, serial: number): Buffer {
  // 78 78 | 05 | protocol | serial(2) | crc(2) | 0D 0A
  // The length byte is 5: protocol(1) + serial(2) + crc(2).
  const frame = Buffer.alloc(10);
  frame.writeUInt16BE(GT06_START_SHORT, 0);
  frame.writeUInt8(0x05, 2);
  frame.writeUInt8(protocol, 3);
  frame.writeUInt16BE(serial, 4);
  // CRC covers the length byte through the serial — bytes 2..5 inclusive.
  frame.writeUInt16BE(crcItu(frame.subarray(2, 6)), 6);
  frame.writeUInt16BE(GT06_END, 8);
  return frame;
}

/* ============================================================================
   Payload decoding
   ========================================================================== */

/**
 * Extracts the IMEI from a login packet.
 *
 * The IMEI arrives as 8 bytes of BCD — two decimal digits per byte — which decodes to 16 digits
 * for a 15-digit IMEI, so the leading zero is stripped.
 */
export function decodeLogin(payload: Buffer): string {
  if (payload.length < 8) throw new Gt06ProtocolError('Login packet too short');

  let digits = '';
  for (let index = 0; index < 8; index += 1) {
    digits += payload[index].toString(16).padStart(2, '0');
  }
  return digits.replace(/^0+/, '');
}

/**
 * Decodes a GPS payload.
 *
 * Coordinates arrive as a 32-bit integer in units of 1/30000 of a minute, so the conversion is
 * `value / 30000 / 60` degrees. Hemisphere is not in the coordinate — it is in the course/status
 * bitfield, which is the single most commonly mis-implemented part of this protocol and the
 * reason a wrongly-decoded truck appears in the Gulf of Guinea instead of Ghana.
 */
export function decodeLocation(payload: Buffer): Gt06Location {
  if (payload.length < 18) throw new Gt06ProtocolError('GPS packet too short');

  const year = 2000 + payload.readUInt8(0);
  const month = payload.readUInt8(1);
  const day = payload.readUInt8(2);
  const hour = payload.readUInt8(3);
  const minute = payload.readUInt8(4);
  const second = payload.readUInt8(5);

  // These devices report UTC. Constructing a local Date here would shift every position by the
  // server's timezone, which is invisible in development and wrong in production.
  const recordedAt = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  const lengthAndSatellites = payload.readUInt8(6);
  const satellites = lengthAndSatellites & 0x0f;

  let latitude = payload.readUInt32BE(7) / 30000 / 60;
  let longitude = payload.readUInt32BE(11) / 30000 / 60;
  const speedKmh = payload.readUInt8(15);
  const flags = payload.readUInt16BE(16);

  const courseDegrees = flags & 0x03ff;
  const valid = (flags & 0x1000) !== 0;

  // Bit 10 clear means southern hemisphere; bit 11 set means western.
  if ((flags & 0x0400) === 0) latitude = -latitude;
  if ((flags & 0x0800) !== 0) longitude = -longitude;

  return {
    recordedAt,
    satellites,
    latitude: round(latitude, 6),
    longitude: round(longitude, 6),
    speedKmh,
    courseDegrees,
    valid,
  };
}

/** Decodes the status/heartbeat payload: ignition, power, battery, signal, alarm. */
export function decodeStatus(payload: Buffer): Gt06Status {
  if (payload.length < 4) throw new Gt06ProtocolError('Status packet too short');

  const terminalInfo = payload.readUInt8(0);
  const batteryLevel = payload.readUInt8(1);
  const gsmSignal = payload.readUInt8(2);
  const alarmCode = (terminalInfo >> 3) & 0x07;

  return {
    // Bit 1 is ACC (ignition); bit 2 is charging.
    ignitionOn: (terminalInfo & 0x02) !== 0,
    charging: (terminalInfo & 0x04) !== 0,
    batteryLevel,
    gsmSignal,
    alarm: alarmCode ? (GT06_ALARM[alarmCode] ?? `UNKNOWN_${alarmCode}`) : null,
  };
}

/** True when this protocol byte carries a position we should store. */
export function isLocationProtocol(protocol: number): boolean {
  return (
    protocol === GT06_PROTOCOL.GPS ||
    protocol === GT06_PROTOCOL.GPS_LBS ||
    protocol === GT06_PROTOCOL.GPS_LBS_STATUS ||
    protocol === GT06_PROTOCOL.ALARM
  );
}

/** True when the device expects an acknowledgement for this protocol byte. */
export function requiresAck(protocol: number): boolean {
  return (
    protocol === GT06_PROTOCOL.LOGIN ||
    protocol === GT06_PROTOCOL.STATUS ||
    protocol === GT06_PROTOCOL.ALARM
  );
}

export class Gt06ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Gt06ProtocolError';
  }
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
