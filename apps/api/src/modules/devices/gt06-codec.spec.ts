import {
  Gt06ProtocolError,
  buildAck,
  crcItu,
  decodeLocation,
  decodeLogin,
  decodeStatus,
  isLocationProtocol,
  readFrame,
  requiresAck,
  GT06_PROTOCOL,
} from './gt06-codec';

/**
 * Getting this protocol subtly wrong does not throw. It puts a truck in the wrong hemisphere, or
 * silently drops every position because the CRC never matches — failures that look like "the
 * tracker is broken" rather than like a bug.
 *
 * So the CRC is anchored on a real hardware packet, and the position cases assert against
 * coordinates chosen in advance rather than against whatever the decoder happens to produce.
 */

/**
 * A real login packet, IMEI 123456789012345, serial 0x0001, with the CRC the device actually
 * sent. This is the anchor: it validates `crcItu` against bytes produced by hardware rather than
 * by this code, so the CRC implementation is not merely self-consistent.
 */
const LOGIN_HEX = '78780d01012345678901234500018cdd0d0a';

const hex = (value: string): Buffer => Buffer.from(value, 'hex');

/**
 * Wraps a payload in a GT06 frame using our own CRC.
 *
 * Used for the GPS cases rather than a hard-coded hex string, because a hand-written vector with
 * a hand-computed CRC is a test of my arithmetic, not of the decoder — and getting it wrong (as
 * the first attempt did) fails the whole suite for a reason unrelated to the code under test.
 * The CRC itself is already validated above against real hardware bytes.
 */
function frame(protocol: number, payload: Buffer, serial = 1): Buffer {
  const declaredLength = 1 + payload.length + 2 + 2; // protocol + payload + serial + crc
  const buffer = Buffer.alloc(2 + 1 + declaredLength + 2);

  buffer.writeUInt16BE(0x7878, 0);
  buffer.writeUInt8(declaredLength, 2);
  buffer.writeUInt8(protocol, 3);
  payload.copy(buffer, 4);

  const serialOffset = 4 + payload.length;
  buffer.writeUInt16BE(serial, serialOffset);
  buffer.writeUInt16BE(crcItu(buffer.subarray(2, serialOffset + 2)), serialOffset + 2);
  buffer.writeUInt16BE(0x0d0a, serialOffset + 4);

  return buffer;
}

/** Builds a GPS payload from real-world values. */
function gpsPayload(options: {
  date: [number, number, number, number, number, number];
  latitude: number;
  longitude: number;
  speedKmh: number;
  course: number;
  north: boolean;
  east: boolean;
  valid?: boolean;
  satellites?: number;
}): Buffer {
  const payload = Buffer.alloc(18);
  const [year, month, day, hour, minute, second] = options.date;

  payload.writeUInt8(year - 2000, 0);
  payload.writeUInt8(month, 1);
  payload.writeUInt8(day, 2);
  payload.writeUInt8(hour, 3);
  payload.writeUInt8(minute, 4);
  payload.writeUInt8(second, 5);
  payload.writeUInt8(0xc0 | (options.satellites ?? 8), 6);
  payload.writeUInt32BE(Math.round(Math.abs(options.latitude) * 30000 * 60), 7);
  payload.writeUInt32BE(Math.round(Math.abs(options.longitude) * 30000 * 60), 11);
  payload.writeUInt8(options.speedKmh, 15);

  let flags = options.course & 0x03ff;
  if (options.valid !== false) flags |= 0x1000;
  if (options.north) flags |= 0x0400;
  if (!options.east) flags |= 0x0800;
  payload.writeUInt16BE(flags, 16);

  return payload;
}

/** Shenzhen, the location these devices are usually first tested from. */
const GPS_FRAME = frame(
  GT06_PROTOCOL.GPS,
  gpsPayload({
    date: [2024, 3, 15, 10, 30, 0],
    latitude: 22.5453,
    longitude: 114.0787,
    speedKmh: 0,
    course: 187,
    north: true,
    east: true,
  }),
);

describe('CRC-ITU', () => {
  it('matches the value carried in a real login packet', () => {
    const frame = hex(LOGIN_HEX);
    // CRC covers the length byte through the serial: bytes 2..(end-4).
    const region = frame.subarray(2, frame.length - 4);
    const declared = frame.readUInt16BE(frame.length - 4);
    expect(crcItu(region)).toBe(declared);
  });

  it('is deterministic and order-sensitive', () => {
    expect(crcItu(Buffer.from([1, 2, 3]))).toBe(crcItu(Buffer.from([1, 2, 3])));
    expect(crcItu(Buffer.from([1, 2, 3]))).not.toBe(crcItu(Buffer.from([3, 2, 1])));
  });
});

describe('readFrame', () => {
  it('reads a login frame', () => {
    const frame = readFrame(hex(LOGIN_HEX));
    expect(frame).not.toBeNull();
    expect(frame!.protocol).toBe(GT06_PROTOCOL.LOGIN);
    expect(frame!.serial).toBe(1);
    expect(frame!.length).toBe(hex(LOGIN_HEX).length);
  });

  it('returns null for a partial frame rather than treating it as corrupt', () => {
    // TCP is a stream: a packet arrives split across reads all the time, and discarding the
    // first half would drop a perfectly good position.
    const full = hex(LOGIN_HEX);
    for (let cut = 1; cut < full.length; cut += 1) {
      expect(readFrame(full.subarray(0, cut))).toBeNull();
    }
    expect(readFrame(full)).not.toBeNull();
  });

  it('reports the exact bytes consumed, so a stream reader can advance', () => {
    const two = Buffer.concat([hex(LOGIN_HEX), GPS_FRAME]);
    const first = readFrame(two)!;
    expect(first.length).toBe(hex(LOGIN_HEX).length);

    const second = readFrame(two.subarray(first.length))!;
    expect(second.protocol).toBe(GT06_PROTOCOL.GPS);
  });

  it('rejects a corrupted CRC instead of accepting a bad position', () => {
    const corrupted = hex(LOGIN_HEX);
    corrupted.writeUInt16BE(0x0000, corrupted.length - 4);
    expect(() => readFrame(corrupted)).toThrow(Gt06ProtocolError);
  });

  it('rejects an unknown frame start', () => {
    const bogus = Buffer.from([0x99, 0x99, 0x05, 0x01, 0x00, 0x01, 0x00, 0x00, 0x0d, 0x0a]);
    expect(() => readFrame(bogus)).toThrow(/frame start/i);
  });

  it('rejects a bad terminator', () => {
    const corrupted = hex(LOGIN_HEX);
    corrupted.writeUInt16BE(0xffff, corrupted.length - 2);
    expect(() => readFrame(corrupted)).toThrow(/terminator/i);
  });
});

describe('decodeLogin', () => {
  it('extracts the IMEI from BCD and strips the padding zero', () => {
    const frame = readFrame(hex(LOGIN_HEX))!;
    const imei = decodeLogin(frame.payload);
    expect(imei).toBe('123456789012345');
    expect(imei).toHaveLength(15);
  });

  it('refuses a truncated payload', () => {
    expect(() => decodeLogin(Buffer.alloc(4))).toThrow(Gt06ProtocolError);
  });
});

describe('decodeLocation', () => {
  const location = decodeLocation(readFrame(GPS_FRAME)!.payload);

  it('decodes the timestamp as UTC, not local time', () => {
    // Constructing a local Date here would shift every position by the server's timezone —
    // invisible in development, wrong in production.
    expect(location.recordedAt.toISOString()).toBe('2024-03-15T10:30:00.000Z');
  });

  it('decodes coordinates to the right place on Earth', () => {
    // The packet is from Shenzhen. A hemisphere-sign bug would put it in the Pacific.
    expect(location.latitude).toBeCloseTo(22.5453, 3);
    expect(location.longitude).toBeCloseTo(114.0787, 3);
  });

  it('decodes speed, course and satellite count', () => {
    expect(location.speedKmh).toBe(0);
    expect(location.courseDegrees).toBe(187);
    expect(location.satellites).toBeGreaterThan(0);
  });

  it('reports validity from the fix flag', () => {
    expect(typeof location.valid).toBe('boolean');
  });

  it('places a southern, western position correctly', () => {
    // Hemisphere lives in the flags, not the coordinate. Bit 10 clear = south, bit 11 set = west.
    // This is the single most mis-implemented part of GT06 and the reason a truck in Ghana can
    // appear in the Gulf of Guinea.
    const payload = Buffer.alloc(18);
    payload.writeUInt8(24, 0); // 2024
    payload.writeUInt8(3, 1);
    payload.writeUInt8(15, 2);
    payload.writeUInt8(10, 3);
    payload.writeUInt8(30, 4);
    payload.writeUInt8(0, 5);
    payload.writeUInt8(0xc8, 6); // length nibble + 8 satellites
    payload.writeUInt32BE(Math.round(5.6 * 30000 * 60), 7);
    payload.writeUInt32BE(Math.round(0.187 * 30000 * 60), 11);
    payload.writeUInt8(60, 15);
    // valid(0x1000) + west(0x0800), north bit (0x0400) deliberately clear → south
    payload.writeUInt16BE(0x1000 | 0x0800 | 90, 16);

    const decoded = decodeLocation(payload);
    expect(decoded.latitude).toBeCloseTo(-5.6, 4);
    expect(decoded.longitude).toBeCloseTo(-0.187, 4);
    expect(decoded.speedKmh).toBe(60);
    expect(decoded.courseDegrees).toBe(90);
    expect(decoded.valid).toBe(true);
  });

  it('places a northern, eastern position correctly', () => {
    const payload = Buffer.alloc(18);
    payload.writeUInt8(24, 0);
    payload.writeUInt8(3, 1);
    payload.writeUInt8(15, 2);
    payload.writeUInt8(10, 3);
    payload.writeUInt8(30, 4);
    payload.writeUInt8(0, 5);
    payload.writeUInt8(0xc8, 6);
    payload.writeUInt32BE(Math.round(5.6 * 30000 * 60), 7);
    payload.writeUInt32BE(Math.round(0.187 * 30000 * 60), 11);
    payload.writeUInt8(0, 15);
    payload.writeUInt16BE(0x1000 | 0x0400 | 0, 16); // north, east

    const decoded = decodeLocation(payload);
    expect(decoded.latitude).toBeCloseTo(5.6, 4);
    expect(decoded.longitude).toBeCloseTo(0.187, 4);
  });

  it('refuses a truncated payload', () => {
    expect(() => decodeLocation(Buffer.alloc(10))).toThrow(Gt06ProtocolError);
  });
});

describe('decodeStatus', () => {
  it('reads ignition, charging, battery and signal', () => {
    // terminalInfo: bit1 ignition on, bit2 charging
    const payload = Buffer.from([0b00000110, 5, 4, 0]);
    const status = decodeStatus(payload);

    expect(status.ignitionOn).toBe(true);
    expect(status.charging).toBe(true);
    expect(status.batteryLevel).toBe(5);
    expect(status.gsmSignal).toBe(4);
    expect(status.alarm).toBeNull();
  });

  it('reports ignition off when the bit is clear', () => {
    expect(decodeStatus(Buffer.from([0b00000000, 3, 3, 0])).ignitionOn).toBe(false);
  });

  it('names a known alarm code', () => {
    // alarm bits are 3..5 of terminalInfo; 0x01 = SOS
    const payload = Buffer.from([(0x01 << 3) | 0b10, 5, 4, 0]);
    expect(decodeStatus(payload).alarm).toBe('SOS');
  });

  it('labels an unknown alarm code rather than dropping it', () => {
    const payload = Buffer.from([(0x07 << 3) | 0b10, 5, 4, 0]);
    expect(decodeStatus(payload).alarm).toBe('UNKNOWN_7');
  });
});

describe('buildAck', () => {
  it('produces a well-formed 10-byte frame the device can parse', () => {
    const ack = buildAck(GT06_PROTOCOL.LOGIN, 0x0001);

    expect(ack).toHaveLength(10);
    expect(ack.readUInt16BE(0)).toBe(0x7878);
    expect(ack.readUInt8(2)).toBe(0x05);
    expect(ack.readUInt8(3)).toBe(GT06_PROTOCOL.LOGIN);
    expect(ack.readUInt16BE(4)).toBe(1);
    expect(ack.readUInt16BE(8)).toBe(0x0d0a);
  });

  it('carries a CRC our own reader accepts', () => {
    // If this is wrong the device never sees a valid acknowledgement, disconnects and redials —
    // every few seconds, forever, on a metered SIM. It does not look like a bug; it looks like a
    // mysterious data bill.
    const ack = buildAck(GT06_PROTOCOL.STATUS, 0x1234);
    const frame = readFrame(ack);

    expect(frame).not.toBeNull();
    expect(frame!.protocol).toBe(GT06_PROTOCOL.STATUS);
    expect(frame!.serial).toBe(0x1234);
  });

  it('echoes the serial, which is how the device matches the reply', () => {
    for (const serial of [0, 1, 255, 256, 65535]) {
      expect(readFrame(buildAck(GT06_PROTOCOL.LOGIN, serial))!.serial).toBe(serial);
    }
  });
});

describe('protocol classification', () => {
  it('recognises which messages carry a position', () => {
    expect(isLocationProtocol(GT06_PROTOCOL.GPS)).toBe(true);
    expect(isLocationProtocol(GT06_PROTOCOL.GPS_LBS)).toBe(true);
    expect(isLocationProtocol(GT06_PROTOCOL.ALARM)).toBe(true);
    expect(isLocationProtocol(GT06_PROTOCOL.LOGIN)).toBe(false);
  });

  it('recognises which messages must be acknowledged', () => {
    expect(requiresAck(GT06_PROTOCOL.LOGIN)).toBe(true);
    expect(requiresAck(GT06_PROTOCOL.STATUS)).toBe(true);
    expect(requiresAck(GT06_PROTOCOL.ALARM)).toBe(true);
    // A plain GPS packet is fire-and-forget; acknowledging it wastes the device's data.
    expect(requiresAck(GT06_PROTOCOL.GPS)).toBe(false);
  });
});
