/** True with ?mock=1: recorded events, visible MOCK DATA banner. UI development only. */
export const isMock = (): boolean =>
  typeof location !== "undefined" && new URLSearchParams(location.search).get("mock") === "1";
