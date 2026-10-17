import { describe, expect, it } from "vitest";
import { machineLabels, parseHostNames, serviceHosts } from "./machines.js";

describe("machine labels from the configured hosts", () => {
  it("plan A: everything on the engine's computer", () => {
    const h = serviceHosts("", {}, "localhost");
    expect(machineLabels(h)).toEqual({
      engine: "This computer",
      worker: "This computer",
      verifier: "This computer",
    });
  });
  it("plan B: the verifier on another host shows its address, or a friendly name", () => {
    const h = serviceHosts("?verifier=192.168.1.20:7404", {}, "localhost");
    expect(machineLabels(h).verifier).toBe("192.168.1.20");
    expect(machineLabels(h, parseHostNames("192.168.1.20=Mac")).verifier).toBe("Mac");
    expect(machineLabels(h).engine).toBe("This computer");
  });
});
