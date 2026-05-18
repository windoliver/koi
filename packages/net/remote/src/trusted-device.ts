export interface TrustedDeviceRecord {
  readonly subject: string;
  readonly deviceId: string;
  readonly registeredAt: number;
  readonly revokedAt?: number | undefined;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface TrustedDeviceRegistry {
  readonly register: (record: TrustedDeviceRecord) => void;
  readonly revoke: (subject: string, deviceId: string, revokedAt: number) => void;
  readonly lookup: (subject: string, deviceId: string) => TrustedDeviceRecord | undefined;
  readonly isTrusted: (subject: string, deviceId: string) => boolean;
}

export function createInMemoryTrustedDeviceRegistry(): TrustedDeviceRegistry {
  const records = new Map<string, Map<string, TrustedDeviceRecord>>();

  function register(record: TrustedDeviceRecord): void {
    const devices = getOrCreateSubjectDevices(records, record.subject);
    const existing = devices.get(record.deviceId);
    if (existing?.revokedAt !== undefined) return;
    devices.set(record.deviceId, copyRecord(record));
  }

  function revoke(subject: string, deviceId: string, revokedAt: number): void {
    const devices = getOrCreateSubjectDevices(records, subject);
    const existing = devices.get(deviceId);
    if (existing === undefined) {
      devices.set(deviceId, {
        subject,
        deviceId,
        registeredAt: revokedAt,
        revokedAt,
        metadata: {},
      });
      return;
    }
    devices.set(deviceId, {
      ...copyRecord(existing),
      revokedAt: Math.max(existing.revokedAt ?? revokedAt, revokedAt),
    });
  }

  function lookup(subject: string, deviceId: string): TrustedDeviceRecord | undefined {
    const record = records.get(subject)?.get(deviceId);
    return record === undefined ? undefined : copyRecord(record);
  }

  function isTrusted(subject: string, deviceId: string): boolean {
    const record = records.get(subject)?.get(deviceId);
    return record !== undefined && record.revokedAt === undefined;
  }

  return { register, revoke, lookup, isTrusted };
}

function getOrCreateSubjectDevices(
  records: Map<string, Map<string, TrustedDeviceRecord>>,
  subject: string,
): Map<string, TrustedDeviceRecord> {
  const existing = records.get(subject);
  if (existing !== undefined) return existing;
  const devices = new Map<string, TrustedDeviceRecord>();
  records.set(subject, devices);
  return devices;
}

function copyRecord(record: TrustedDeviceRecord): TrustedDeviceRecord {
  return {
    subject: record.subject,
    deviceId: record.deviceId,
    registeredAt: record.registeredAt,
    ...(record.revokedAt !== undefined ? { revokedAt: record.revokedAt } : {}),
    metadata: structuredClone(record.metadata),
  };
}
