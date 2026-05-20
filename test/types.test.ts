import { describe, expect, it } from "vitest";
import {
  detectSensitivityPreset,
  resolveSensitivityConfig,
  SENSITIVITY_PRESETS,
} from "../src/types.js";

describe("SENSITIVITY_PRESETS", () => {
  it("has ultralight, low, medium, high entries with correct fields", () => {
    expect(SENSITIVITY_PRESETS.ultralight).toEqual({
      checkInterval: 0,
      confidenceThreshold: 1.0,
      messageLimit: 4,
    });
    expect(SENSITIVITY_PRESETS.low).toEqual({
      checkInterval: 0,
      confidenceThreshold: 1.0,
      messageLimit: 6,
    });
    expect(SENSITIVITY_PRESETS.medium).toEqual({
      checkInterval: 3,
      confidenceThreshold: 0.9,
      messageLimit: 12,
    });
    expect(SENSITIVITY_PRESETS.high).toEqual({
      checkInterval: 1,
      confidenceThreshold: 0.85,
      messageLimit: 20,
    });
  });
});

describe("resolveSensitivityConfig", () => {
  it("returns the preset config for ultralight", () => {
    const config = resolveSensitivityConfig("ultralight");
    expect(config).toEqual(SENSITIVITY_PRESETS.ultralight);
  });

  it("returns the preset config for low", () => {
    const config = resolveSensitivityConfig("low");
    expect(config).toEqual(SENSITIVITY_PRESETS.low);
  });

  it("returns the preset config for medium", () => {
    const config = resolveSensitivityConfig("medium");
    expect(config).toEqual(SENSITIVITY_PRESETS.medium);
  });

  it("returns the preset config for high", () => {
    const config = resolveSensitivityConfig("high");
    expect(config).toEqual(SENSITIVITY_PRESETS.high);
  });

  it("returns the provided config for custom", () => {
    const custom = { checkInterval: 2, confidenceThreshold: 0.75, messageLimit: 8 };
    const config = resolveSensitivityConfig("custom", custom);
    expect(config).toEqual(custom);
  });

  it("falls back to medium when custom has no config", () => {
    const config = resolveSensitivityConfig("custom");
    expect(config).toEqual(SENSITIVITY_PRESETS.medium);
  });
});

describe("detectSensitivityPreset", () => {
  it("detects ultralight preset", () => {
    expect(detectSensitivityPreset(SENSITIVITY_PRESETS.ultralight)).toBe("ultralight");
  });

  it("detects low preset", () => {
    expect(detectSensitivityPreset(SENSITIVITY_PRESETS.low)).toBe("low");
  });

  it("detects medium preset", () => {
    expect(detectSensitivityPreset(SENSITIVITY_PRESETS.medium)).toBe("medium");
  });

  it("detects high preset", () => {
    expect(detectSensitivityPreset(SENSITIVITY_PRESETS.high)).toBe("high");
  });

  it("returns custom for non-preset configs", () => {
    expect(detectSensitivityPreset({ checkInterval: 2, confidenceThreshold: 0.8, messageLimit: 10 })).toBe("custom");
    expect(detectSensitivityPreset({ checkInterval: 3, confidenceThreshold: 0.85, messageLimit: 12 })).toBe("custom");
  });

  it("returns custom for partial matches", () => {
    // Same as medium but different threshold
    expect(detectSensitivityPreset({ checkInterval: 3, confidenceThreshold: 0.8, messageLimit: 12 })).toBe("custom");
    // Same as high but different message limit
    expect(detectSensitivityPreset({ checkInterval: 1, confidenceThreshold: 0.85, messageLimit: 16 })).toBe("custom");
  });
});