import { describe, expect, test } from "bun:test";
import { createQrReleaseGate } from "./qr-release-gate";

describe("penahan QR setelah jendela foto", () => {
  test("kartu yang terus dipegang tidak pernah memicu ulang", () => {
    const gate = createQrReleaseGate(1_500);
    gate.block("S001|tok", 0);
    for (let t = 500; t <= 10_000; t += 500) {
      expect(gate.allows("S001|tok", t)).toBe(false);
    }
  });

  test("kartu yang dijauhkan lalu ditempel lagi boleh memicu", () => {
    const gate = createQrReleaseGate(1_500);
    gate.block("S001|tok", 0);
    expect(gate.allows("S001|tok", 400)).toBe(false);
    expect(gate.allows("S001|tok", 2_000)).toBe(true);
    expect(gate.allows("S001|tok", 2_100)).toBe(true);
  });

  test("kartu lain langsung lolos", () => {
    const gate = createQrReleaseGate(1_500);
    gate.block("S001|tok", 0);
    expect(gate.allows("S002|tok", 10)).toBe(true);
  });
});
