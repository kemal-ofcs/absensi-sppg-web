import { describe, expect, test } from "bun:test";
import {
  operationalSyncBatchSchema,
  operationalSyncEventSchema,
} from "@/lib/server/operational/sync-schema";

function shiftEvent() {
  return {
    eventId: `evt-${"a".repeat(64)}`,
    clientId: `desktop-${"b".repeat(64)}`,
    domain: "shift",
    operation: "create",
    entityKey: "kode:90",
    payload: {
      local_id_shift: -90,
      kode_shift: 90,
      nama_shift: "Shift Sinkronisasi",
      jam_masuk: "08:00",
      jam_pulang: "16:00",
    },
    baseRevision: null,
    createdAt: 1_786_300_000,
  };
}

describe("operational sync schema", () => {
  test("menerima event dengan domain dan operasi yang didukung", () => {
    expect(operationalSyncEventSchema.safeParse(shiftEvent()).success).toBe(
      true,
    );
    expect(
      operationalSyncEventSchema.safeParse({
        eventId: `evt-${"a".repeat(64)}`,
        clientId: `desktop-${"b".repeat(64)}`,
        domain: "holiday",
        operation: "create",
        entityKey: "2026-08-17",
        payload: {
          id_libur: -1,
          tanggal: "2026-08-17",
          nama_libur: "Hari Kemerdekaan RI",
          jenis_libur: "Libur Nasional",
          status_aktif: 1,
        },
        baseRevision: null,
        createdAt: 1_786_300_000,
      }).success,
    ).toBe(true);
    expect(
      operationalSyncEventSchema.safeParse({
        eventId: `evt-${"a".repeat(64)}`,
        clientId: `desktop-${"b".repeat(64)}`,
        domain: "setting",
        operation: "upsert",
        entityKey: "auto_alfa_aktif",
        payload: {
          key: "auto_alfa_aktif",
          value: "true",
        },
        baseRevision: null,
        createdAt: 1_786_300_000,
      }).success,
    ).toBe(true);
  });

  test("menolak null, primitive, domain, dan operasi yang tidak didukung", () => {
    expect(operationalSyncEventSchema.safeParse(null).success).toBe(false);
    expect(operationalSyncEventSchema.safeParse("event").success).toBe(false);
    expect(
      operationalSyncEventSchema.safeParse({
        ...shiftEvent(),
        operation: "truncate",
      }).success,
    ).toBe(false);
  });

  test("menolak field liar pada event dan payload", () => {
    expect(
      operationalSyncEventSchema.safeParse({
        ...shiftEvent(),
        unexpected: true,
      }).success,
    ).toBe(false);
    expect(
      operationalSyncEventSchema.safeParse({
        ...shiftEvent(),
        payload: { ...shiftEvent().payload, sql: "DROP TABLE master_data" },
      }).success,
    ).toBe(false);
  });

  test("batch menolak client ID event yang berbeda", () => {
    expect(
      operationalSyncBatchSchema.safeParse({
        clientId: `desktop-${"c".repeat(64)}`,
        events: [shiftEvent()],
      }).success,
    ).toBe(false);
  });
});
