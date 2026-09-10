import { rawToLiters, CalibrationPoint } from "./fuelCalibration";

describe("Fuel Calibration Interpolation", () => {
  const table: CalibrationPoint[] = [
    { rawValue: 450, liters: 0 },
    { rawValue: 620, liters: 10 },
    { rawValue: 780, liters: 20 },
    { rawValue: 930, liters: 30 },
    { rawValue: 3200, liters: 400 },
  ];

  it("should return null for empty table", () => {
    expect(rawToLiters(500, [])).toBeNull();
  });

  it("should return the only value for a single-item table", () => {
    expect(rawToLiters(500, [{ rawValue: 600, liters: 50 }])).toBe(50);
  });

  it("should clamp values below the lowest point", () => {
    expect(rawToLiters(400, table)).toBe(0);
    expect(rawToLiters(450, table)).toBe(0);
  });

  it("should clamp values above the highest point", () => {
    expect(rawToLiters(3500, table)).toBe(400);
    expect(rawToLiters(3200, table)).toBe(400);
  });

  it("should linearly interpolate exactly on points", () => {
    expect(rawToLiters(620, table)).toBe(10);
    expect(rawToLiters(780, table)).toBe(20);
  });

  it("should linearly interpolate between points", () => {
    // Halfway between 450(0) and 620(10) -> 535
    expect(rawToLiters(535, table)).toBe(5);

    // One quarter between 620(10) and 780(20)
    // Diff is 160. Quarter is 40. -> 660. Liters should be 12.5.
    expect(rawToLiters(660, table)).toBe(12.5);

    // Halfway between 930(30) and 3200(400) -> 2065
    // Liters: 30 + 370 / 2 = 215
    expect(rawToLiters(2065, table)).toBe(215);
  });

  it("should work even if the table is given unsorted", () => {
    const unsortedTable: CalibrationPoint[] = [
      { rawValue: 780, liters: 20 },
      { rawValue: 3200, liters: 400 },
      { rawValue: 450, liters: 0 },
      { rawValue: 930, liters: 30 },
      { rawValue: 620, liters: 10 },
    ];
    expect(rawToLiters(660, unsortedTable)).toBe(12.5);
  });
});
